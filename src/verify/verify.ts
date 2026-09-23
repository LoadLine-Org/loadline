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
import { probeCandidates } from "../engine/migration.ts";
import { codeFingerprint } from "../engine/fingerprint.ts";
import { summarize, jsonReplacer, type PublishedPosition } from "../engine/snapshot.ts";
import { ADAPTERS, MARKET_IDS, loadConfig, positionKey } from "../markets/index.ts";
import type { MarketId, Position } from "../markets/types.ts";

type Row = { market: string; check: string; result: "PASS" | "FAIL" | "SKIP"; detail: string };

async function loader(from: string) {
  const isUrl = /^https?:\/\//.test(from);
  return async (rel: string) => {
    if (isUrl) {
      const r = await fetch(new URL(rel, from.endsWith("/") ? from : from + "/"), { headers: { "user-agent": "loadline-verify" } });
      if (!r.ok) throw new Error(`fetch ${rel}: HTTP ${r.status}`);
      return r.json();
    }
    return JSON.parse(fs.readFileSync(path.join(from, rel), "utf8"));
  };
}

const canon = (x: unknown) => JSON.stringify(x, jsonReplacer);

/** Deep diff; returns up to `max` "path: published != recomputed" lines. */
function diff(a: any, b: any, p = "", out: string[] = [], max = 8): string[] {
  if (out.length >= max) return out;
  if (canon(a) === canon(b)) return out;
  if (a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) diff(a[k], b[k], p ? `${p}.${k}` : k, out, max);
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

    // 6. prices
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

  fs.rmSync(cacheDir, { recursive: true, force: true });
  const fails = rows.filter((r) => r.result === "FAIL");
  console.log(`\n${rows.filter((r) => r.result === "PASS").length} passed, ${fails.length} failed, ${rows.filter((r) => r.result === "SKIP").length} skipped`);
  console.log(`requests: ${Object.entries(ledgerSummary()).map(([h, e]) => `${h} ${e.requests}`).join(", ")}`);
  console.log(fails.length ? "RESULT: FAIL" : "RESULT: PASS");
  return fails.length ? 1 : 0;
}
