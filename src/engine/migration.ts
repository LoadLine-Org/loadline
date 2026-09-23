// Contract-migration watch, run on every snapshot.
//
//  1. Pointer reads (per adapter): the authoritative "what is live" reads.
//     Any mismatch with the configured generation => UNVERIFIED.
//  2. Candidate probes: next-version contracts named in config. One batched
//     read at the pinned block tells deployed / not deployed. Each candidate
//     carries its effect: pending (Zest v2: switch follows deploy by minutes),
//     unverified (Zest v1 v0-transfer-v1-1: pre-approved, deploy = activation),
//     or info.
//  3. Governance watch: the current governance contract is re-derived every
//     run (Granite aeUSDC moved governance twice), its transactions are
//     scanned, and any migration-relevant proposal inside the protocol's
//     window that has not been executed => PENDING.

import fs from "node:fs";
import path from "node:path";
import { HIRO, type Reader } from "../lib/chain.ts";
import { Cl, ok as unwrapOk } from "../lib/clarity.ts";
import { requestJson } from "../lib/http.ts";
import type { CandidateResult, MarketConfig } from "../markets/types.ts";
import { scanTxs, type Tx } from "./txscan.ts";

export async function probeCandidates(r: Reader, cfg: MarketConfig): Promise<CandidateResult[]> {
  const cands: { contract: string; meaning: string; effect: CandidateResult["effect"] }[] = cfg.candidates ?? [];
  if (!cands.length) return [];
  const res = await r.ro(cands.map((c) => [c.contract, "loadline-existence-probe"]));
  return cands.map((c, i) => {
    const x = res[i];
    // A missing contract errors with NoSuchContract; an existing one with UndefinedFunction.
    const missing = !x.ok && /NoSuchContract/.test(x.error);
    const exists = !x.ok ? /UndefinedFunction/.test(x.error) : true;
    if (!missing && !exists) throw new Error(`candidate probe for ${c.contract} was inconclusive: ${x.ok ? "ok" : x.error}`);
    return { contract: c.contract, meaning: c.meaning, effect: c.effect, deployed: exists };
  });
}

export type PendingItem = {
  kind: "candidate-deployed" | "governance-proposal";
  summary: string;
  txid?: string;
  height?: number;
  time?: number;
  expiresAt?: number;
  evidence?: Record<string, unknown>;
};

async function source(cacheDir: string, contract: string): Promise<string | null> {
  const dir = path.join(cacheDir, "sources");
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, contract + ".clar");
  if (fs.existsSync(f)) return fs.readFileSync(f, "utf8");
  const [a, n] = contract.split(".");
  const j = await requestJson(`${HIRO}/v2/contracts/source/${a}/${n}?proof=0`, { allow404: true });
  if (!j) return null;
  fs.writeFileSync(f, j.source);
  return j.source as string;
}

const argPrincipal = (repr: string) => repr.replace(/^'/, "");

export async function governanceWatch(r: Reader, cfg: MarketConfig, cacheDir: string, log: (m: string) => void): Promise<{ governance: string; pending: PendingItem[]; scanned: number; relevantInWindow: number }> {
  const g = cfg.governance;
  if (!g) return { governance: "", pending: [], scanned: 0, relevantInWindow: 0 };
  let gov: string;
  if (g.resolve.kind === "fixed") gov = g.resolve.contract;
  else if (g.resolve.kind === "var") gov = String(unwrapOk(await r.var(g.resolve.contract, g.resolve.var)));
  else gov = String(unwrapOk(await r.one(g.resolve.contract, g.resolve.fn, ...(g.resolve.argAscii ? [Cl.stringAscii(g.resolve.argAscii)] : []))));

  const { txs } = await scanTxs(cacheDir, gov, r.block.height, { log });
  const since = r.block.blockTime - g.windowSeconds;
  const direct = txs.filter((t) => t.cid === gov && t.status === "success");
  const proposals = direct.filter((t) => g.proposeFns.includes(t.fn) && t.t >= since);
  const executions = direct.filter((t) => g.executeFns.includes(t.fn));

  const relevant: Tx[] = [];
  for (const p of proposals) {
    const c = g.classify ?? {};
    let hit = false;
    if (c.always) hit = true;
    if (!hit && c.argKeywords) hit = p.args.some((a) => c.argKeywords.some((k: string) => a.includes(k)));
    if (!hit && c.sourceKeywords) {
      const script = p.args.map(argPrincipal).find((a) => /^S[PM][0-9A-Z]+\.[\w-]+$/.test(a));
      const src = script ? await source(cacheDir, script) : null;
      hit = !!src && c.sourceKeywords.some((k: string) => src.includes(k));
    }
    if (hit) relevant.push(p);
  }

  const pending: PendingItem[] = [];
  for (const p of relevant) {
    // Link a proposal to its execution: by the proposal id printed in its result, or by the
    // proposal/script principal passed to both. Arkadiko (matchBy "anyLater") prints no id we
    // can match, so any later end-proposal closes it; a passed vote then shows up in the pointers.
    const id = /\(ok (0x[0-9a-f]+|u\d+)\)/.exec(p.result)?.[1];
    const principal = p.args.map(argPrincipal).find((a) => /^S[PM][0-9A-Z]+\.[\w-]+$/.test(a));
    const done = executions.some((e) => {
      if (e.h < p.h) return false;
      if (g.matchBy === "anyLater") return true;
      if (id && e.args.includes(id)) return true;
      return !!principal && e.args.map(argPrincipal).includes(principal);
    });
    if (done) continue;
    pending.push({
      kind: "governance-proposal",
      summary: `${p.fn} on ${gov.split(".")[1]}${principal ? ` naming ${principal}` : ""}, not executed yet`,
      txid: p.txid,
      height: p.h,
      time: p.t,
      expiresAt: p.t + g.windowSeconds,
      evidence: { args: p.args, result: p.result },
    });
  }
  return { governance: gov, pending, scanned: txs.length, relevantInWindow: relevant.length };
}
