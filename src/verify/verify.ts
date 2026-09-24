// verify: recompute every published number from public sources and diff it.
//
// Needs no API key and no state from the publisher: it runs from a clean
// clone against the published files (a local directory or the site's URL).
//
// For each market snapshot:
//   1. block     the pinned block exists at that height with that index_block_hash and is canonical
//   2. chain     re-read every position, on-chain total, parameter, live-contract pointer and
//                candidate probe AT THAT BLOCK, and diff them against the published values
//   3. recon     recompute every reconciliation check from the published positions and totals
//   4. health    recompute every position's USD values, health, band, liquidatable flag and dust flag
//   5. summary   recompute the market summary (counts, USD totals, risk buckets)
//   6. prices    re-fetch each exchange candle behind the reference median and recompute the median
//
// Exit code 0 only if every check passes.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getBlock, Reader } from "../lib/chain.ts";
import { ledgerSummary } from "../lib/http.ts";
import { lastCandle, recomputeMedian, to1e8, type Venue } from "../lib/prices.ts";
import { derive } from "../engine/math.ts";
import { governanceWatch, probeCandidates } from "../engine/migration.ts";
import { liquidationSummary, scanLiquidations } from "../engine/liquidations.ts";
import { sha256, snapshotCsvs } from "../engine/dataset.ts";
import { replaySwitch } from "../replay/replay.ts";
import { codeFingerprint } from "../engine/fingerprint.ts";
import { summarize, jsonReplacer, type PublishedPosition } from "../engine/snapshot.ts";
import { ADAPTERS, MARKET_IDS, loadConfig, positionKey, ROOT } from "../markets/index.ts";
import type { MarketId, Position } from "../markets/types.ts";

type Row = { market: string; check: string; result: "PASS" | "FAIL" | "SKIP"; detail: string };

async function rawLoader(from: string) {
  const isUrl = /^https?:\/\//.test(from);
  return async (rel: string): Promise<string | null> => {
    if (isUrl) {
      const r = await fetch(new URL(rel, from.endsWith("/") ? from : from + "/"), { headers: { "user-agent": "loadline-verify" } });
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(`fetch ${rel}: HTTP ${r.status}`);
      return r.text();
    }
    const f = path.join(from, rel);
    return fs.existsSync(f) ? fs.readFileSync(f, "utf8") : null;
  };
}

async function loader(from: string) {
  const raw = await rawLoader(from);
  return async (rel: string) => {
    const t = await raw(rel);
    if (t === null) throw new Error(`${rel}: not found`);
    return JSON.parse(t);
  };
}

const canon = (x: unknown) => JSON.stringify(x, jsonReplacer);

/**
 * Deep diff of a published value against its recomputation; returns up to `max`
 * "path: published != recomputed" lines. Every published field must be reproduced. Fields the
 * current code computes but an older snapshot does not carry are ignored: within a schema major
 * version, changes are additive (docs/DATASET.md), so older snapshots stay verifiable.
 */
function diff(a: any, b: any, p = "", out: string[] = [], max = 8): string[] {
  if (out.length >= max) return out;
  if (canon(a) === canon(b)) return out;
  if (a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
    for (const k of Object.keys(a)) {
      if (!(k in b)) out.push(`${p ? `${p}.${k}` : k}: published but not recomputed`);
      else diff(a[k], b[k], p ? `${p}.${k}` : k, out, max);
    }
    return out;
  }
  if (Array.isArray(a) && Array.isArray(b) && a.length === b.length) {
    a.forEach((x, i) => diff(x, b[i], `${p}[${i}]`, out, max));
    return out;
  }
  out.push(`${p || "(root)"}: published ${canon(a)?.slice(0, 120)} != recomputed ${canon(b)?.slice(0, 120)}`);
  return out;
}

const stripD = (p: PublishedPosition): Position => {
  const { d: _d, ...rest } = p;
  return rest;
};

export async function runVerify(o: { from: string; markets?: MarketId[]; skipPrices?: boolean; height?: number }): Promise<number> {
  const load = await loader(o.from);
  const latest = await load("latest.json");
  const raw = await rawLoader(o.from);
  const indexText = await raw("index.json");
  const index = indexText ? JSON.parse(indexText) : null;
  const ids = (o.markets ?? MARKET_IDS).filter((id) => latest.markets[id]);
  const rows: Row[] = [];
  const add = (market: string, check: string, ok: boolean | null, detail: string) => {
    rows.push({ market, check, result: ok === null ? "SKIP" : ok ? "PASS" : "FAIL", detail });
    console.log(`  ${ok === null ? "SKIP" : ok ? "PASS" : "FAIL"}  ${check.padEnd(8)} ${detail}`);
  };
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "loadline-verify-"));
  // All markets in one run share a block and its candles: fetch each candle once.
  const candleMemo = new Map<string, ReturnType<typeof lastCandle>>();
  const candle = (v: Venue, sym: string, t: number) => {
    const k = `${v}|${sym}|${t}`;
    if (!candleMemo.has(k)) candleMemo.set(k, lastCandle(v, sym, t).catch(() => null));
    return candleMemo.get(k)!;
  };
  const mine = codeFingerprint();
  console.log(`verify: published data from ${o.from}`);
  console.log(`verify: this checkout's code fingerprint ${mine.slice(0, 16)}`);

  for (const id of ids) {
    const rel = o.height ? `snapshots/${o.height}/${id}.json` : latest.markets[id].snapshot;
    if (!rel) {
      add(id, "snapshot", false, "no published snapshot");
      continue;
    }
    const snap = await load(rel);
    const ad = ADAPTERS[id];
    const cfg = { ...loadConfig(id), tolerances: snap.tolerances, dustUsd: snap.dustUsd };
    console.log(`\n${snap.name}  (${rel}, block ${snap.block.height}, state ${snap.state.state})`);
    if (snap.code?.fingerprint && snap.code.fingerprint !== mine) console.log(`  note: snapshot was produced by code ${snap.code.fingerprint.slice(0, 16)}; this checkout is ${mine.slice(0, 16)}. Check out the matching version if anything below fails.`);

    // 1. block
    const b = await getBlock(snap.block.height);
    add(id, "block", b.canonical && b.indexBlockHash === snap.block.indexBlockHash, `height ${b.height} index_block_hash ${b.indexBlockHash.slice(0, 16)}… canonical=${b.canonical}`);

    // 2. chain re-read at the pinned block
    const r = new Reader(snap.block);
    const accounts: string[] | undefined =
      id === "granite-usdcx" || id === "granite-aeusdc" ? snap.params.candidates : id === "zest-v1" ? snap.params.extraCandidates : id === "arkadiko-v2" ? [...new Set<string>(snap.positions.map((p: Position) => p.account))] : undefined;
    const t0 = Date.now();
    const out = await ad.read(r, cfg, { cacheDir, accounts, unlisted: snap.params.unlistedHolders, log: () => {} });
    const pubPos: PublishedPosition[] = snap.positions;
    const pub = new Map(pubPos.map((p) => [positionKey(p), stripD(p)]));
    const got = new Map(out.positions.map((p) => [positionKey(p), p]));
    const missing = [...pub.keys()].filter((k) => !got.has(k));
    const extra = [...got.keys()].filter((k) => !pub.has(k));
    const posDiffs: string[] = [];
    for (const [k, p] of pub) if (got.has(k)) diff(p, got.get(k), k, posDiffs, 5);
    add(id, "chain", !missing.length && !extra.length && !posDiffs.length, `${got.size} positions re-read at block ${snap.block.height}: ${missing.length} missing, ${extra.length} extra, ${posDiffs.length ? posDiffs.join("; ") : "all fields identical"}`);
    const totDiffs = diff(snap.onchain, out.onchain);
    add(id, "chain", !totDiffs.length, `${Object.keys(snap.onchain).length} on-chain totals ${totDiffs.length ? totDiffs.join("; ") : "identical"}`);
    const parDiffs = diff(snap.params, out.params);
    add(id, "chain", !parDiffs.length, `protocol parameters (thresholds, indices, ratios, on-chain prices) ${parDiffs.length ? parDiffs.join("; ") : "identical"}`);
    const ptr = await ad.pointers(r, cfg);
    const ptrDiffs = diff(snap.pointers.map((p: any) => p.actual), ptr.map((p) => p.actual));
    add(id, "chain", !ptrDiffs.length, `${ptr.length} live-contract pointer reads ${ptrDiffs.length ? ptrDiffs.join("; ") : `identical (${ptr.filter((p) => p.match).length}/${ptr.length} match the configured generation)`}`);
    const cands = await probeCandidates(r, cfg);
    const cDiffs = diff(snap.candidates.map((c: any) => [c.contract, c.deployed]), cands.map((c) => [c.contract, c.deployed]));
    add(id, "chain", !cDiffs.length, `${cands.length} next-version candidates ${cDiffs.length ? cDiffs.join("; ") : "identical"} (${((Date.now() - t0) / 1000).toFixed(0)} s, ${r.stats.stxerCalls} batch calls)`);

    // 3. reconciliation
    const checks = ad.checks(pubPos.map(stripD), snap.onchain, snap.params, cfg);
    const num = (cs: any[]) => cs.map((c) => [c.id, c.indexed, c.onchain, c.delta, c.status]);
    const rDiffs = diff(num(snap.checks), num(checks));
    add(id, "recon", !rDiffs.length, `${checks.length} reconciliation checks recomputed from published positions ${rDiffs.length ? rDiffs.join("; ") : "identical"}: ${checks.map((c) => `${c.id} Δ${c.delta} ${c.status}`).join(", ")}`);

    // 4. health
    const withD = pubPos.filter((p) => p.d);
    if (withD.length) {
      const hDiffs: string[] = [];
      for (const p of withD) diff(p.d, derive((x) => ad.value(stripD(p), snap.params, x), snap.priceVector ?? { BTC: "0", STX: "0", USDC: "0" }, snap.band, snap.dustUsd), positionKey(p), hDiffs, 5);
      add(id, "health", !hDiffs.length, `${withD.length} positions: USD values, health, band, liquidatable and dust flags ${hDiffs.length ? hDiffs.join("; ") : "identical"}`);
    } else add(id, "health", null, `risk figures withheld in this snapshot (${snap.withheld?.risk ?? "n/a"})`);

    // 5. summary
    const sDiffs = diff(snap.summary, summarize(pubPos, cfg));
    add(id, "summary", !sDiffs.length, `market summary ${sDiffs.length ? sDiffs.join("; ") : "identical"}`);

    // 6. liquidations: re-scan the entry contract's transactions up to the block, re-read each
    //    successful liquidation's token movements, recount the liquidation path, recompute the summary.
    if (snap.liquidations) {
      const l0 = Date.now();
      const lctx = { cacheDir, log: () => {} };
      const rec = await scanLiquidations(cacheDir, ad.liquidationSpec(cfg), snap.block);
      const lDiffs = diff(snap.liquidations, rec);
      add(id, "liquid", !lDiffs.length, `${rec.events.length} liquidation${rec.events.length === 1 ? "" : "s"} in the ${rec.window.days}-day window, ${rec.sinceActivation.successes} of ${rec.sinceActivation.attempts} calls successful since activation: ${lDiffs.length ? lDiffs.join("; ") : "re-scanned from the chain and identical, including every repaid and seized amount"}`);
      const lp = await ad.liquidationPath(r, cfg, out, lctx);
      const pDiffs = diff(snap.liquidationPath, lp);
      add(id, "liquid", !pDiffs.length, `liquidation path ${lp.status}: ${pDiffs.length ? pDiffs.join("; ") : "recounted and identical"}`);
      const excl = new Set<string>(((cfg as any).reconciliationExclusions ?? []).map((e: any) => e.account));
      const ls = liquidationSummary(pubPos, snap.liquidations, (a, amt) => ad.assetUsd(a, amt, snap.params, snap.priceVector, cfg), excl);
      const lsDiffs = diff(snap.liquidationSummary, ls);
      add(id, "liquid", !lsDiffs.length, `liquidatable vs liquidated summary ${lsDiffs.length ? lsDiffs.join("; ") : "recomputed and identical"} (${((Date.now() - l0) / 1000).toFixed(0)} s)`);
    } else add(id, "liquid", null, snap.withheld?.risk ? `liquidation figures withheld in this snapshot (${snap.withheld.risk})` : "this snapshot has no liquidation records: it was published before they were added");

    if (snap.redemptions) {
      const rr = await scanLiquidations(cacheDir, ad.redemptionSpec!(cfg), snap.block);
      const rDiffs2 = diff(snap.redemptions, rr);
      add(id, "liquid", !rDiffs2.length, `${rr.events.length} redemption${rr.events.length === 1 ? "" : "s"} in the ${rr.window.days}-day window: ${rDiffs2.length ? rDiffs2.join("; ") : "re-scanned and identical"}`);
    }
    if (snap.extras && ad.extras) {
      const xDiffs = diff(snap.extras, ad.extras(pubPos.map(stripD), snap.params, snap.priceVector));
      add(id, "extras", !xDiffs.length, `${Object.keys(snap.extras).join(", ")} ${xDiffs.length ? xDiffs.join("; ") : "recomputed from published positions and identical"}`);
    }

    // dataset: the published file matches the index hash, and every CSV export regenerates byte for byte
    if (index) {
      const entry = index.snapshots.find((s: any) => s.height === snap.block.height);
      const files: Record<string, { sha256: string }> = Object.fromEntries((entry?.files ?? []).map((f: any) => [f.path, f]));
      const jsonText = await raw(rel);
      const probs: string[] = [];
      if (!files[rel]) probs.push(`${rel} not in index.json`);
      else if (sha256(jsonText!) !== files[rel].sha256) probs.push(`${rel} sha256 differs from index.json`);
      const csvs = snapshotCsvs(snap);
      for (const [f, content] of Object.entries(csvs)) {
        const p = `snapshots/${snap.block.height}/csv/${f}`;
        const h = sha256(content);
        if (!files[p]) probs.push(`${f} not in index.json`);
        else if (files[p].sha256 !== h) probs.push(`${f}: index hash differs from the regenerated CSV`);
        const pub = await raw(p);
        if (pub === null) probs.push(`${f} not published`);
        else if (sha256(pub) !== h) probs.push(`${f}: published CSV differs from the regenerated one`);
      }
      add(id, "dataset", !probs.length, probs.length ? probs.slice(0, 4).join("; ") : `snapshot JSON matches index.json (sha256), ${Object.keys(csvs).length} CSV exports regenerated byte for byte`);
    } else add(id, "dataset", null, "no index.json published at this location");

    // 7. governance watch: re-derive the governance contract and re-scan its proposals up to the block
    if (snap.governance?.contract) {
      const gov = await governanceWatch(r, cfg, cacheDir, () => {});
      const g = { contract: gov.governance, txsScanned: gov.scanned, relevantProposalsInWindow: gov.relevantInWindow, pending: gov.pending };
      const gDiffs = diff(snap.governance, g);
      add(id, "gov", !gDiffs.length, `governance ${g.contract.split(".")[1]}: ${g.txsScanned} txs, ${g.relevantProposalsInWindow} migration proposals in window, ${g.pending.length} pending: ${gDiffs.length ? gDiffs.join("; ") : "re-scanned and identical"}`);
    }

    // 8. prices
    if (o.skipPrices || !snap.priceVector) add(id, "prices", null, o.skipPrices ? "skipped (--skip-prices)" : "no reference prices used");
    else {
      const target: number = snap.prices.targetMinute;
      const krakenGone = Date.now() / 1000 - target > 11 * 3600;
      const qs: string[] = [];
      let bad = 0;
      let skipped = 0;
      const all = [...snap.prices.usdtVenues.map((q: any) => ({ ...q, asset: "USDT" })), ...Object.values<any>(snap.prices.assets).flatMap((a) => a.venues.map((q: any) => ({ ...q, asset: a.asset })))];
      for (const q of all) {
        if (q.venue === "kraken" && krakenGone) {
          skipped++;
          continue;
        }
        const c = await candle(q.venue as Venue, q.sym, target);
        if (!c) {
          skipped++;
          continue;
        }
        if (c.t !== q.candleTime || c.close !== q.closeRaw) {
          bad++;
          qs.push(`${q.venue} ${q.sym}: published ${q.closeRaw}@${q.candleTime}, now ${c.close}@${c.t}`);
        }
      }
      const medDiffs: string[] = [];
      for (const a of Object.values<any>(snap.prices.assets)) {
        const m = recomputeMedian(a, snap.prices.usdtUsd);
        if (m === null ? a.median !== null : to1e8(m).toString() !== String(a.usd1e8)) medDiffs.push(`${a.asset}: published ${a.usd1e8}, recomputed ${m === null ? null : to1e8(m)}`);
      }
      add(id, "prices", !bad && !medDiffs.length, `${all.length - skipped} exchange candles re-fetched and identical${skipped ? `, ${skipped} not re-checkable (kraken keeps 12 h / venue unreachable)` : ""}; medians ${medDiffs.length ? medDiffs.join("; ") : "recomputed identically"}${qs.length ? " | " + qs.slice(0, 3).join("; ") : ""}`);
    }
  }

  // Migration replay: every pointer read at every checkpoint, re-read at that block.
  const replayText = o.markets ? null : await raw("replay/replay.json");
  if (replayText) {
    const pub = JSON.parse(replayText);
    const conf = JSON.parse(fs.readFileSync(path.join(ROOT, "config/replay.json"), "utf8"));
    console.log(`\nMigration replay  (replay/replay.json, ${pub.switches.length} switches)`);
    for (const s of pub.switches) {
      const c = conf.switches.find((x: any) => x.id === s.id);
      if (!c) {
        add("replay", "replay", false, `${s.id}: not in this checkout's config/replay.json`);
        continue;
      }
      const again = await replaySwitch(c, cacheDir);
      const d = diff(s, again);
      const reads = s.steps.reduce((a: number, st: any) => a + st.before.pointers.length + st.at.pointers.length, 0);
      add("replay", "replay", !d.length, `${s.id}: ${s.steps.length} step(s), ${reads} pointer reads at ${s.steps.length * 2} blocks, deploy ${s.warningMinutes} min before the first step: ${d.length ? d.join("; ") : "re-read and identical"}`);
    }
  }

  fs.rmSync(cacheDir, { recursive: true, force: true });
  const fails = rows.filter((r) => r.result === "FAIL");
  console.log(`\n${rows.filter((r) => r.result === "PASS").length} passed, ${fails.length} failed, ${rows.filter((r) => r.result === "SKIP").length} skipped`);
  console.log(`requests: ${Object.entries(ledgerSummary()).map(([h, e]) => `${h} ${e.requests}`).join(", ")}`);
  console.log(fails.length ? "RESULT: FAIL" : "RESULT: PASS");
  return fails.length ? 1 : 0;
}
