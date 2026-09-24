// Incremental, cached scans of a contract's transaction list and print events.
//
// The first run back-fills the full history once (throttled); later runs fetch
// only the newest pages until they reach a transaction already in the cache.
// Results are always cut at the snapshot's pinned block height.

import fs from "node:fs";
import path from "node:path";
import { HIRO } from "../lib/chain.ts";
import { requestJson } from "../lib/http.ts";

export type Tx = {
  txid: string;
  h: number;
  t: number; // block time, unix s
  status: string; // success | abort_by_response | abort_by_post_condition
  sender: string;
  cid: string | null; // top-level contract called
  fn: string | null;
  args: string[]; // Clarity repr of each argument
  result: string;
};

type TxCache = { contract: string; complete: boolean; txs: Record<string, Tx> };

const PAGE = 50;

function load(file: string, contract: string): TxCache {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as TxCache;
  } catch {
    return { contract, complete: false, txs: {} };
  }
}

function toTx(t: any): Tx {
  return {
    txid: t.tx_id,
    h: t.block_height,
    t: t.block_time ?? t.burn_block_time,
    status: t.tx_status,
    sender: t.sender_address,
    cid: t.contract_call?.contract_id ?? null,
    fn: t.contract_call?.function_name ?? null,
    args: (t.contract_call?.function_args ?? []).map((a: any) => a.repr),
    result: t.tx_result?.repr ?? "",
  };
}

/**
 * All transactions that list `contract` as a participant, up to `maxHeight`.
 * Without `sinceTime` the full history is back-filled once. With `sinceTime`,
 * back-fill stops once the cache reaches back past it (for contracts with very
 * long histories, e.g. oracles pushing every few minutes).
 */
export async function scanTxs(
  cacheDir: string,
  contract: string,
  maxHeight: number,
  opts: { maxPages?: number | null; sinceTime?: number; log?: (m: string) => void } = {},
): Promise<{ txs: Tx[]; complete: boolean; coveredFrom: number | null }> {
  const dir = path.join(cacheDir, "txscan");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, contract.replace(/[^A-Za-z0-9.-]/g, "_") + ".json");
  const c = load(file, contract);
  const maxPages = opts.maxPages === undefined ? null : opts.maxPages;
  const oldest = () => Object.values(c.txs).reduce((m, t) => Math.min(m, t.t), Infinity);
  let pages = 0;

  // Page from `offset` until `stop` says so; returns false if the end of history was reached.
  const pageFrom = async (offset: number, stop: (rows: Tx[], hitKnown: boolean) => boolean) => {
    for (;;) {
      const known = new Set(Object.keys(c.txs));
      const j = await requestJson(`${HIRO}/extended/v1/address/${contract}/transactions?limit=${PAGE}&offset=${offset}`);
      pages++;
      const rows: Tx[] = (j?.results ?? []).map(toTx);
      let hitKnown = false;
      for (const tx of rows) {
        if (known.has(tx.txid)) hitKnown = true;
        c.txs[tx.txid] = tx;
      }
      offset += rows.length;
      if (rows.length < PAGE || offset >= (j?.total ?? 0)) {
        c.complete = true;
        return;
      }
      if (stop(rows, hitKnown)) return;
      if (maxPages !== null && pages >= maxPages) return;
      if (pages % 20 === 0) opts.log?.(`  txscan ${contract}: ${offset}/${j?.total ?? "?"}`);
    }
  };

  const hadAny = Object.keys(c.txs).length > 0;
  // 1. Newest pages until we join the cache (or reach sinceTime on a cold cache).
  await pageFrom(0, (rows, hitKnown) => (hadAny ? hitKnown : opts.sinceTime !== undefined && rows[rows.length - 1].t < opts.sinceTime));
  // 2. Extend backwards if the cache does not yet reach far enough.
  if (!c.complete && (opts.sinceTime === undefined || oldest() > opts.sinceTime)) {
    const start = Math.max(0, Object.keys(c.txs).length - PAGE); // cache is contiguous from the newest tx; overlap one page
    await pageFrom(start, (rows) => opts.sinceTime !== undefined && rows[rows.length - 1].t < opts.sinceTime);
  }
  fs.writeFileSync(file, JSON.stringify(c));
  const txs = Object.values(c.txs)
    .filter((t) => t.h <= maxHeight)
    .sort((a, b) => b.h - a.h || b.t - a.t);
  return { txs, complete: c.complete, coveredFrom: c.complete ? null : oldest() };
}

export type PrintEvent = { txid: string; index: number; repr: string };

/** Print events of a contract (newest first). Events carry no height; resolve via the tx if needed. */
export async function scanEvents(cacheDir: string, contract: string, opts: { maxPages?: number } = {}): Promise<{ events: PrintEvent[]; complete: boolean }> {
  const dir = path.join(cacheDir, "evscan");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, contract.replace(/[^A-Za-z0-9.-]/g, "_") + ".json");
  let c: { complete: boolean; events: Record<string, PrintEvent> };
  try {
    c = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    c = { complete: false, events: {} };
  }
  const known = new Set(Object.keys(c.events));
  let offset = 0;
  let pages = 0;
  for (;;) {
    const j = await requestJson(`${HIRO}/extended/v1/contract/${contract}/events?limit=${PAGE}&offset=${offset}`);
    pages++;
    const rows: any[] = j?.results ?? [];
    let hitKnown = false;
    for (const r of rows) {
      if (r.event_type !== "smart_contract_log") continue;
      const key = `${r.tx_id}:${r.event_index}`;
      if (known.has(key)) hitKnown = true;
      c.events[key] = { txid: r.tx_id, index: r.event_index, repr: r.contract_log?.value?.repr ?? "" };
    }
    offset += rows.length;
    if (rows.length < PAGE) {
      c.complete = true;
      break;
    }
    if (hitKnown && c.complete) break;
    if (opts.maxPages && pages >= opts.maxPages) break;
  }
  fs.writeFileSync(file, JSON.stringify(c));
  return { events: Object.values(c.events), complete: c.complete };
}

export async function getTx(cacheDir: string, txid: string): Promise<Tx> {
  const dir = path.join(cacheDir, "tx");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, txid + ".json");
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8"));
  const j = await requestJson(`${HIRO}/extended/v1/tx/${txid}`);
  const tx = toTx(j);
  fs.writeFileSync(file, JSON.stringify(tx));
  return tx;
}

/** A token movement in a transaction: FT transfer/mint/burn, or an STX transfer. */
export type Move = { kind: "transfer" | "mint" | "burn"; asset: string; sender: string | null; recipient: string | null; amount: string };
export type TxMoves = { txid: string; h: number; t: number; status: string; sender: string; fn: string | null; args: string[]; moves: Move[] };

/** A transaction with its token movements (cached; confirmed transactions never change). */
export async function getTxMoves(cacheDir: string, txid: string): Promise<TxMoves> {
  const dir = path.join(cacheDir, "txmoves");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, txid + ".json");
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8"));
  const moves: Move[] = [];
  let base: any = null;
  for (let offset = 0; ; offset += 100) {
    const j = await requestJson(`${HIRO}/extended/v1/tx/${txid}?event_offset=${offset}&event_limit=100`);
    base ??= j;
    for (const e of j.events ?? []) {
      if (e.event_type === "fungible_token_asset") {
        const a = e.asset;
        moves.push({ kind: a.asset_event_type, asset: a.asset_id, sender: a.sender || null, recipient: a.recipient || null, amount: String(a.amount) });
      } else if (e.event_type === "stx_asset" && e.asset.asset_event_type === "transfer") {
        moves.push({ kind: "transfer", asset: "STX", sender: e.asset.sender, recipient: e.asset.recipient, amount: String(e.asset.amount) });
      }
    }
    if ((j.events ?? []).length < 100 || offset + 100 >= (j.event_count ?? 0)) break;
  }
  const tx = toTx(base);
  const out: TxMoves = { txid, h: tx.h, t: tx.t, status: tx.status, sender: tx.sender, fn: tx.fn, args: tx.args, moves };
  fs.writeFileSync(file, JSON.stringify(out));
  return out;
}
