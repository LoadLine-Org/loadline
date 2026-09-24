// One snapshot run: every market read at the same pinned block, reconciled,
// passed through the state machine, and published only as far as its state
// allows.
//
// Output (all under `outDir`, which is what the site serves and `verify` reads):
//   snapshots/<height>/<market>.json   full snapshot per market
//   latest.json                        index: current state + summary per market
//   state.json                         state machine per market
//   transitions.jsonl                  every state change
//   runs.jsonl                         one line per run (block, duration, requests)
// Withheld snapshots (reconciliation FAIL) go to `quarantineDir`, never to outDir.

import fs from "node:fs";
import path from "node:path";
import { getBlock, pinBlock, Reader, type Block } from "../lib/chain.ts";
import { ledgerSummary } from "../lib/http.ts";
import { referencePrices, type ReferencePrices } from "../lib/prices.ts";
import { ADAPTERS, loadConfig, positionKey, ROOT } from "../markets/index.ts";
import type { Derived, MarketConfig, MarketId, Position, PriceVector, ReconCheck } from "../markets/types.ts";
import { B, derive } from "./math.ts";
import { governanceWatch, probeCandidates, type PendingItem } from "./migration.ts";
import { decide, publishesRisk, type MarketState } from "./state.ts";
import { codeFingerprint } from "./fingerprint.ts";
import { liquidationSummary, scanLiquidations } from "./liquidations.ts";
import { writeIndex, writeSnapshotCsvs } from "./dataset.ts";

export const SCHEMA = 1;

export const jsonReplacer = (_k: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v);
export const writeJson = (f: string, x: unknown) => {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(x, jsonReplacer, 1) + "\n");
};

export function priceVector(p: ReferencePrices): PriceVector | null {
  const { BTC, STX, USDC } = p.assets;
  if (!BTC?.usd1e8 || !STX?.usd1e8 || !USDC?.usd1e8) return null;
  return { BTC: BTC.usd1e8.toString(), STX: STX.usd1e8.toString(), USDC: USDC.usd1e8.toString() };
}

export type PublishedPosition = Position & { d: Derived | null };

export type Summary = {
  positions: number;
  borrowers: number;
  dustBorrowers: number;
  risk: null | {
    debtUsd: string;
    dustDebtUsd: string;
    collUsd: string;
    liquidatable: { yes: number; band: number; no: number };
    badDebt: { count: number; debtUsd: string };
    excluded: { account: string; debtUsd: string; reason: string }[];
    within: { "5%": number; "10%": number; "25%": number };
    nearest: { key: string; h: number | null; hLow: number | null; hHigh: number | null; debtUsd: string; liquidatable: string }[];
  };
};

/** Pure summary of published positions; recomputed by `verify`. */
export function summarize(positions: PublishedPosition[], cfg: MarketConfig): Summary {
  const excl = new Map<string, string>((cfg.reconciliationExclusions ?? []).map((e: any) => [e.account, e.reason]));
  const borrowers = positions.filter((p) => Object.values(p.debtStored).some((v) => B(v) > 0n));
  const withD = borrowers.filter((p) => p.d);
  const out: Summary = { positions: positions.length, borrowers: borrowers.length, dustBorrowers: withD.filter((p) => p.d!.dust).length, risk: null };
  if (withD.length !== borrowers.length) return out; // risk withheld
  let debt = 0n, dust = 0n, coll = 0n, badDebt = 0n;
  const liq = { yes: 0, band: 0, no: 0 };
  const within = { "5%": 0, "10%": 0, "25%": 0 };
  let badCount = 0;
  const excluded: { account: string; debtUsd: string; reason: string }[] = [];
  const live: PublishedPosition[] = [];
  for (const p of positions) if (p.d) coll += B(p.d.collUsd);
  for (const p of borrowers) {
    const d = p.d!;
    if (excl.has(p.account)) {
      excluded.push({ account: p.account, debtUsd: d.debtUsd, reason: excl.get(p.account)! });
      continue;
    }
    debt += B(d.debtUsd);
    if (d.dust) {
      dust += B(d.debtUsd);
      continue;
    }
    if (B(d.collUsd) === 0n) {
      badCount++;
      badDebt += B(d.debtUsd);
      continue;
    }
    if (d.liquidatable === "yes" || d.liquidatable === "band" || d.liquidatable === "no") liq[d.liquidatable]++;
    const lo = d.hLow ?? d.h;
    if (lo !== null) {
      if (lo <= 1.05) within["5%"]++;
      if (lo <= 1.1) within["10%"]++;
      if (lo <= 1.25) within["25%"]++;
    }
    live.push(p);
  }
  live.sort((a, b) => (a.d!.hLow ?? a.d!.h ?? 9e9) - (b.d!.hLow ?? b.d!.h ?? 9e9));
  out.risk = {
    debtUsd: debt.toString(),
    dustDebtUsd: dust.toString(),
    collUsd: coll.toString(),
    liquidatable: liq,
    badDebt: { count: badCount, debtUsd: badDebt.toString() },
    excluded,
    within,
    nearest: live.slice(0, 10).map((p) => ({ key: positionKey(p), h: p.d!.h, hLow: p.d!.hLow, hHigh: p.d!.hHigh, debtUsd: p.d!.debtUsd, liquidatable: p.d!.liquidatable })),
  };
  return out;
}

export type RunOpts = {
  outDir: string;
  quarantineDir: string;
  cacheDir: string;
  markets?: MarketId[];
  confirmations?: number;
  /** Pin to this exact height instead of tip - confirmations (replaying history). */
  height?: number;
  log?: (m: string) => void;
};

export async function runSnapshot(opts: RunOpts) {
  const log = opts.log ?? console.log;
  const t0 = Date.now();
  const ids = opts.markets ?? (Object.keys(ADAPTERS) as MarketId[]);
  const block: Block = opts.height ? await getBlock(opts.height) : await pinBlock(opts.confirmations ?? 6);
  log(`pinned block ${block.height} (${new Date(block.blockTime * 1000).toISOString()}) ${block.indexBlockHash}`);
  const r = new Reader(block);
  const code = { version: JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version, fingerprint: codeFingerprint() };
  const prices = await referencePrices(block.blockTime);
  const px = priceVector(prices);
  log(`reference prices: ${Object.values(prices.assets).map((a) => `${a.asset} ${a.median?.toFixed(a.asset === "BTC" ? 2 : 5) ?? "n/a"} (${a.venues.length} venues)`).join(", ")}`);

  const statePath = path.join(opts.outDir, "state.json");
  const states: Record<string, MarketState> = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, "utf8")) : {};
  const latestPath = path.join(opts.outDir, "latest.json");
  const latestPrev = fs.existsSync(latestPath) ? JSON.parse(fs.readFileSync(latestPath, "utf8")) : { markets: {} };
  const latest: any = { schema: SCHEMA, generatedAt: new Date().toISOString(), block, code, markets: {} };
  const transitions: any[] = [];

  for (const id of ids) {
    const ad = ADAPTERS[id];
    const cfg = loadConfig(id);
    const ctx = { cacheDir: opts.cacheDir, log };
    const m0 = Date.now();
    log(`— ${cfg.name}`);
    let snap: any = { schema: SCHEMA, market: id, name: cfg.name, protocol: cfg.protocol, block, generatedAt: new Date().toISOString(), code };
    const critical: string[] = [];
    let pending: PendingItem[] = [];
    let checks: ReconCheck[] = [];
    try {
      const pointers = await ad.pointers(r, cfg);
      for (const p of pointers.filter((p) => !p.match)) critical.push(`live-contract pointer changed: ${p.read} = ${p.actual} (config expects ${p.expected})`);
      const candidates = await probeCandidates(r, cfg);
      for (const c of candidates.filter((c) => c.deployed)) {
        if (c.effect === "unverified") critical.push(`${c.contract} is deployed: ${c.meaning}`);
        else if (c.effect === "pending") pending.push({ kind: "candidate-deployed", summary: `${c.contract.split(".")[1]} deployed: ${c.meaning}` });
      }
      const gov = await governanceWatch(r, cfg, opts.cacheDir, log);
      pending = pending.concat(gov.pending);

      const out = await ad.read(r, cfg, ctx);
      checks = ad.checks(out.positions, out.onchain, out.params, cfg);
      for (const c of checks.filter((c) => c.status === "FAIL")) critical.push(`reconciliation FAIL: ${c.label} (indexed ${c.indexed}, on-chain ${c.onchain})`);

      const liquidationPath = await ad.liquidationPath(r, cfg, out, ctx);
      const liquidations = await scanLiquidations(opts.cacheDir, ad.liquidationSpec(cfg), block, log);
      const redemptions = ad.redemptionSpec ? await scanLiquidations(opts.cacheDir, ad.redemptionSpec(cfg), block, log) : undefined;
      Object.assign(snap, {
        generation: cfg.generation,
        priceBasis: cfg.priceBasis,
        band: ad.bandPct(cfg),
        bandSource: cfg.bandSource ?? null,
        dustUsd: cfg.dustUsd,
        tolerances: cfg.tolerances,
        pointers,
        candidates,
        governance: { contract: gov.governance, txsScanned: gov.scanned, relevantProposalsInWindow: gov.relevantInWindow, pending: gov.pending },
        prices,
        priceVector: px,
        discovery: out.discovery,
        params: out.params,
        onchain: out.onchain,
        checks,
        liquidationPath,
        liquidations,
        ...(redemptions ? { redemptions } : {}),
        positions: out.positions,
      });
    } catch (e) {
      critical.push(`snapshot error: ${(e as Error).message}`);
      log(`  ERROR ${(e as Error).stack}`);
    }

    const prev = states[id];
    const next = decide(prev, { height: block.height, time: block.blockTime, critical, pending });
    const balancesOk = !critical.some((c) => c.startsWith("reconciliation FAIL") || c.startsWith("snapshot error")) && Array.isArray(snap.positions);
    const riskOk = publishesRisk(next.state);
    const needsPx = !cfg.priceBasis.exact;
    const pxOk = !needsPx || px !== null;
    let withheld: { positions: string | null; risk: string | null } = { positions: null, risk: null };

    if (balancesOk) {
      const riskReason = !riskOk ? `market is ${next.state}: ${next.reasons.join("; ")}` : !pxOk ? "reference price unavailable (too few exchange venues answered)" : null;
      snap.positions = (snap.positions as Position[]).map((p) => ({
        ...p,
        d: riskReason ? null : derive((x) => ad.value(p, snap.params, x), (px ?? { BTC: "0", STX: "0", USDC: "0" }) as PriceVector, snap.band, cfg.dustUsd),
      }));
      if (riskReason) {
        withheld.risk = riskReason;
        delete snap.liquidationPath;
        delete snap.liquidations;
        delete snap.redemptions;
      }
    } else {
      withheld = { positions: next.reasons.join("; "), risk: next.reasons.join("; ") };
    }
    snap.state = next;
    snap.withheld = withheld;
    snap.summary = balancesOk ? summarize(snap.positions, cfg) : null;
    snap.extras = balancesOk && !withheld.risk && ad.extras ? ad.extras(snap.positions.map(({ d: _d, ...p }: any) => p), snap.params, px) : null;
    snap.liquidationSummary =
      balancesOk && snap.liquidations && px
        ? liquidationSummary(snap.positions, snap.liquidations, (a, amt) => ad.assetUsd(a, amt, snap.params, px, cfg), new Set((cfg.reconciliationExclusions ?? []).map((e: any) => e.account)))
        : null;
    snap.elapsedMs = Date.now() - m0;

    const rel = `snapshots/${block.height}/${id}.json`;
    if (balancesOk) {
      writeJson(path.join(opts.outDir, rel), snap);
      writeSnapshotCsvs(opts.outDir, snap);
      if (riskOk && pxOk) next.lastVerified = { height: block.height, indexBlockHash: block.indexBlockHash, time: block.blockTime, snapshot: rel };
    } else {
      writeJson(path.join(opts.quarantineDir, rel), snap);
    }
    if (!prev || prev.state !== next.state) transitions.push({ market: id, from: prev?.state ?? null, to: next.state, height: block.height, time: block.blockTime, reasons: next.reasons });
    states[id] = next;

    latest.markets[id] = {
      name: cfg.name,
      protocol: cfg.protocol,
      state: next.state,
      reasons: next.reasons,
      verifiedAt: next.lastVerified,
      snapshot: balancesOk ? rel : (latestPrev.markets?.[id]?.snapshot ?? null),
      current: balancesOk,
      withheld,
      summary: balancesOk ? snap.summary : (latestPrev.markets?.[id]?.summary ?? null),
      checks: checks.map((c) => ({ id: c.id, status: c.status, deltaPct: c.deltaPct, delta: c.delta })),
      liquidationPath: snap.liquidationPath ? { status: snap.liquidationPath.status, summary: snap.liquidationPath.summary } : null,
      liquidationSummary: snap.liquidationSummary ?? null,
      pointer: snap.pointers?.[0] ?? null,
    };
    const worst = checks.some((c) => c.status === "FAIL") ? "FAIL" : checks.some((c) => c.status === "WARN") ? "WARN" : "OK";
    log(`  ${next.state}  reconciliation ${worst} (${checks.length} checks)  positions ${snap.positions?.length ?? "withheld"}  ${(snap.elapsedMs / 1000).toFixed(1)} s`);
  }

  writeJson(statePath, states);
  writeJson(latestPath, latest);
  writeIndex(opts.outDir);
  if (transitions.length) fs.appendFileSync(path.join(opts.outDir, "transitions.jsonl"), transitions.map((t) => JSON.stringify(t)).join("\n") + "\n");
  const run = { height: block.height, indexBlockHash: block.indexBlockHash, blockTime: block.blockTime, startedAt: new Date(t0).toISOString(), seconds: Math.round((Date.now() - t0) / 1000), reader: r.stats, requests: ledgerSummary(), markets: Object.fromEntries(ids.map((id) => [id, states[id].state])) };
  fs.appendFileSync(path.join(opts.outDir, "runs.jsonl"), JSON.stringify(run) + "\n");
  return { block, latest, run };
}
