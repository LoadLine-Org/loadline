// Chain access pinned to one Stacks block.
//
// Every read in a snapshot is pinned to a single index_block_hash so that all
// totals and positions describe the same instant, and so `verify` can re-read
// exactly the same state later.
//
// Transport: stxer batch reads (many reads per request, keyless) as primary,
// with a per-read fallback to the Stacks node RPC exposed by Hiro. Both are
// public and keyless.
//
// Two guards against silently reading the wrong block:
//  - stxer echoes the index_block_hash it evaluated at; we assert it matches.
//  - Hiro ignores a `0x`-prefixed `tip` and serves *current* state with HTTP
//    200, so tips are always sent bare (no prefix).

import type { ClarityValue } from "@stacks/transactions";
import { decodeHex, hex, type Decoded } from "./clarity.ts";
import { requestJson, HttpError } from "./http.ts";

export const HIRO = process.env.LOADLINE_HIRO_URL ?? "https://api.hiro.so";
export const STXER = process.env.LOADLINE_STXER_URL ?? "https://api.stxer.xyz";

export type Block = {
  height: number;
  indexBlockHash: string; // bare hex, no 0x
  hash: string;
  blockTime: number; // unix seconds (Stacks block time)
  burnHeight: number;
  burnTime: number;
};

const bare = (h: string) => h.replace(/^0x/, "").toLowerCase();

function toBlock(j: any): Block {
  return {
    height: j.height,
    indexBlockHash: bare(j.index_block_hash),
    hash: bare(j.hash),
    blockTime: j.block_time,
    burnHeight: j.burn_block_height,
    burnTime: j.burn_block_time,
  };
}

export async function getBlock(height: number): Promise<Block & { canonical: boolean }> {
  const j = await requestJson(`${HIRO}/extended/v2/blocks/${height}`);
  if (!j) throw new Error(`block ${height} not found`);
  return { ...toBlock(j), canonical: j.canonical !== false };
}

export async function latestHeight(): Promise<number> {
  const j = await requestJson(`${HIRO}/extended/v2/blocks/latest`);
  return j.height as number;
}

/** Pin to a block `confirmations` behind the tip, to stay clear of short forks. */
export async function pinBlock(confirmations = 6): Promise<Block> {
  const h = (await latestHeight()) - confirmations;
  const b = await getBlock(h);
  if (!b.canonical) throw new Error(`block ${h} is not canonical`);
  return b;
}

export type ReadResult = { ok: true; value: Decoded } | { ok: false; error: string };
export type RO = [contract: string, fn: string, ...args: ClarityValue[]];
export type MapQ = [contract: string, map: string, key: ClarityValue];
export type VarQ = [contract: string, name: string];

type BatchBody = {
  tip: string;
  readonly?: string[][];
  maps?: string[][];
  vars?: string[][];
};

export type ReaderStats = { stxerCalls: number; hiroFallbackReads: number; reads: number };

export class Reader {
  readonly block: Block;
  readonly stats: ReaderStats = { stxerCalls: 0, hiroFallbackReads: 0, reads: 0 };
  private stxerDown = false;
  private chunk: number;

  constructor(block: Block, opts: { chunk?: number } = {}) {
    this.block = block;
    this.chunk = opts.chunk ?? 400;
  }

  get tip(): string {
    return this.block.indexBlockHash;
  }

  /** `chunk` overrides reads per stxer request (cheap reads can go larger). */
  async ro(calls: RO[], chunk?: number): Promise<ReadResult[]> {
    return this.batched("readonly", calls.map(([c, f, ...a]) => [c, f, ...a.map(hex)]), (q) => this.hiroReadOnly(q), chunk);
  }

  async maps(qs: MapQ[], chunk?: number): Promise<ReadResult[]> {
    return this.batched("maps", qs.map(([c, m, k]) => [c, m, hex(k)]), (q) => this.hiroMap(q), chunk);
  }

  async vars(qs: VarQ[]): Promise<ReadResult[]> {
    return this.batched("vars", qs.map(([c, v]) => [c, v]), (q) => this.hiroVar(q));
  }

  /** Single read-only call; throws on a transport or runtime error. */
  async one(contract: string, fn: string, ...args: ClarityValue[]): Promise<Decoded> {
    const [r] = await this.ro([[contract, fn, ...args]]);
    if (!r.ok) throw new Error(`${contract}.${fn}: ${r.error}`);
    return r.value;
  }

  async var(contract: string, name: string): Promise<Decoded> {
    const [r] = await this.vars([[contract, name]]);
    if (!r.ok) throw new Error(`${contract}::${name}: ${r.error}`);
    return r.value;
  }

  /** Map entry; null when absent. */
  async map(contract: string, map: string, key: ClarityValue): Promise<Decoded> {
    const [r] = await this.maps([[contract, map, key]]);
    if (!r.ok) throw new Error(`${contract}::${map}: ${r.error}`);
    return r.value;
  }

  /** Native STX balance (unlocked + locked) of a principal at the pinned block, via node RPC. */
  async stxBalance(principal: string): Promise<bigint> {
    const j = await requestJson(`${HIRO}/v2/accounts/${principal}?proof=0&tip=${this.tip}`);
    this.stats.hiroFallbackReads++;
    return BigInt(j.balance) + BigInt(j.locked ?? "0x0");
  }

  private async batched(kind: "readonly" | "maps" | "vars", items: string[][], fallback: (q: string[]) => Promise<ReadResult>, chunkOverride?: number): Promise<ReadResult[]> {
    const out: ReadResult[] = [];
    const chunk = chunkOverride ?? this.chunk;
    this.stats.reads += items.length;
    for (let i = 0; i < items.length; i += chunk) {
      const part = items.slice(i, i + chunk);
      let res: ReadResult[] | null = null;
      if (!this.stxerDown) {
        try {
          res = await this.stxerBatch(kind, part);
        } catch (e) {
          // Fall back for this run; stxer is free with no SLA.
          console.warn(`[chain] stxer batch failed (${(e as Error).message.slice(0, 120)}); falling back to node RPC`);
          this.stxerDown = true;
        }
      }
      if (!res) {
        res = [];
        for (const q of part) res.push(await fallback(q));
      }
      out.push(...res);
    }
    return out;
  }

  private async stxerBatch(kind: "readonly" | "maps" | "vars", part: string[][]): Promise<ReadResult[]> {
    const body: BatchBody = { tip: this.tip, [kind]: part };
    const j = await requestJson(`${STXER}/sidecar/v2/batch`, { body, maxAttempts: 5 });
    this.stats.stxerCalls++;
    if (!j || bare(j.index_block_hash ?? "") !== this.tip) {
      throw new Error(`stxer evaluated at ${j?.index_block_hash} instead of pinned ${this.tip}`);
    }
    const arr: any[] = j[kind];
    if (!Array.isArray(arr) || arr.length !== part.length) throw new Error(`stxer returned ${arr?.length} results for ${part.length} ${kind}`);
    return arr.map((x) => ("Ok" in x ? { ok: true as const, value: decodeHex(x.Ok) } : { ok: false as const, error: String(x.Err) }));
  }

  private async hiroReadOnly([contract, fn, ...args]: string[]): Promise<ReadResult> {
    const [addr, name] = contract.split(".");
    this.stats.hiroFallbackReads++;
    const j = await requestJson(`${HIRO}/v2/contracts/call-read/${addr}/${name}/${encodeURIComponent(fn)}?tip=${this.tip}`, {
      body: { sender: "SP000000000000000000002Q6VF78", arguments: args.map((a) => "0x" + a) },
    });
    if (!j.okay) return { ok: false, error: String(j.cause) };
    return { ok: true, value: decodeHex(j.result) };
  }

  private async hiroMap([contract, map, key]: string[]): Promise<ReadResult> {
    const [addr, name] = contract.split(".");
    this.stats.hiroFallbackReads++;
    try {
      const j = await requestJson(`${HIRO}/v2/map_entry/${addr}/${name}/${encodeURIComponent(map)}?proof=0&tip=${this.tip}`, {
        body: JSON.stringify("0x" + key),
      });
      return { ok: true, value: decodeHex(j.data) };
    } catch (e) {
      if (e instanceof HttpError) return { ok: false, error: e.message };
      throw e;
    }
  }

  private async hiroVar([contract, v]: string[]): Promise<ReadResult> {
    const [addr, name] = contract.split(".");
    this.stats.hiroFallbackReads++;
    const j = await requestJson(`${HIRO}/v2/data_var/${addr}/${name}/${encodeURIComponent(v)}?proof=0&tip=${this.tip}`, { allow404: true });
    if (!j) return { ok: false, error: "no such data var" };
    return { ok: true, value: decodeHex(j.data) };
  }
}

/** Deploy height of a contract, or null if it does not exist (as of now). */
export async function contractDeployHeight(contractId: string): Promise<number | null> {
  const j = await requestJson(`${HIRO}/extended/v1/contract/${contractId}`, { allow404: true });
  if (!j) return null;
  return typeof j.block_height === "number" ? j.block_height : null;
}
