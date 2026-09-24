// 90-day oracle-health record.
//
// Inputs, all public and keyless:
//   - every DIA push (set-multiple-values) and Arkadiko push (update-price-multi) in the window,
//     decoded from transaction arguments;
//   - every Lazer-carrying transaction of the in-scope consumers (Zest v2 v0-7/v0-8, Zest v1
//     borrow-helper-v2-1-8, both Granite state-v1), decoded for the payload timestamp only;
//   - a 1-minute multi-venue reference for BTC and STX, and the on-chain stSTX ratio sampled
//     at blocks through the window.
//
// Outputs (data/public/oracle/):
//   dia-pushes.csv, arkadiko-pushes.csv   one row per push, with tx id, age and deviation
//   lazer-observations.csv                one row per Lazer-carrying tx: payload age and outcome (no prices)
//   episodes.csv / episodes.json          silence, frozen-but-fresh, deviation-band and stale-revert episodes
//   reference-1m.csv                      the per-minute reference used for every deviation
//   summary.json                          per-feed metrics, current status, standing findings, method

import fs from "node:fs";
import path from "node:path";
import { getBlock, HIRO, pinBlock, Reader, type Block } from "../lib/chain.ts";
import { Cl, ok as unwrapOk } from "../lib/clarity.ts";
import { ledgerSummary, requestJson } from "../lib/http.ts";
import { ROOT } from "../markets/index.ts";
import { scanTxs, type Tx } from "../engine/txscan.ts";
import { buildReference, refAt, MAX_CARRY, MIN_SOURCES, SOURCES, type RefSeries } from "./candles.ts";
import { lazerTimestampUs } from "./lazer.ts";
import { writeIndex } from "../engine/dataset.ts";

type Write = { t: number; h: number; txid: string; value: number; feedTs: number; seed?: boolean; extra?: Record<string, string | number> };
type Feed = { source: "DIA" | "Arkadiko"; feed: string; ref: string; frozen: any; writes: Write[]; consumers: string };
type Episode = {
  type: "silence" | "frozen" | "deviation" | "lazer-stale-burst";
  source: string;
  feed: string;
  severity: "info" | "warn" | "critical";
  band?: number;
  start: number;
  end: number | null; // null = ongoing at window end
  hours: number;
  writes?: number;
  value?: number;
  maxDeviationPct?: number;
  refMovePct?: number;
  startTx?: string;
  endTx?: string;
  detail?: string;
};

const iso = (t: number | null) => (t === null ? "" : new Date(t * 1000).toISOString().replace(".000Z", "Z"));
const q = (xs: number[], p: number) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(p * (xs.length - 1)))] : null);
const r4 = (x: number) => Math.round(x * 1e4) / 1e4;
const r2 = (x: number) => Math.round(x * 100) / 100;
const usd = (x: number) => "$" + (x >= 1 ? x.toLocaleString("en-US", { maximumFractionDigits: 2 }) : x.toPrecision(6));

function csv(rows: Record<string, unknown>[], cols: string[]): string {
  const esc = (v: unknown) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(","), ...rows.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\n") + "\n";
}

export async function runOracleRecord(o: { outDir: string; cacheDir: string; height?: number; log?: (m: string) => void }) {
  const log = o.log ?? console.log;
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "config/oracle.json"), "utf8"));
  const end: Block = o.height ? await getBlock(o.height) : await pinBlock(6);
  const W1 = end.blockTime;
  const W0 = W1 - cfg.windowDays * 86400;
  log(`oracle record: ${iso(W0)} → ${iso(W1)} (block ${end.height})`);

  // ---- 1. transactions
  const dia = await scanTxs(o.cacheDir, cfg.dia.contract, end.height, { sinceTime: W0 - 86400, log });
  const ark = await scanTxs(o.cacheDir, cfg.arkadiko.contract, end.height, { sinceTime: W0 - 86400, log });
  log(`  DIA txs ${dia.txs.length}, Arkadiko txs ${ark.txs.length}`);

  // ---- 2. decode pushes
  const TUPLE = /\(tuple \(key "([^"]+)"\) \(timestamp u(\d+)\) \(value u(\d+)\)\)/g;
  const diaByKey = new Map<string, Write[]>();
  for (const t of dia.txs) {
    if (t.status !== "success" || !t.fn || !["set-multiple-values", "set-value"].includes(t.fn)) continue;
    for (const a of t.args)
      for (const m of a.matchAll(TUPLE)) {
        if (!cfg.dia.keys[m[1]]) continue;
        const w: Write = { t: t.t, h: t.h, txid: t.txid, value: Number(m[3]) / 1e8, feedTs: Number(m[2]) / 1000 };
        (diaByKey.get(m[1]) ?? diaByKey.set(m[1], []).get(m[1])!).push(w);
      }
  }
  const arkByTok = new Map<string, Write[]>();
  for (const t of ark.txs) {
    if (t.status !== "success" || !t.fn || !cfg.arkadiko.fns.includes(t.fn)) continue;
    // update-price-multi(block, token-id, price, decimals, signatures)
    const [block, tok, price] = t.args;
    const id = tok?.replace(/^u/, "");
    if (!cfg.arkadiko.tokens[id]) continue;
    const w: Write = { t: t.t, h: t.h, txid: t.txid, value: Number(price.replace(/^u/, "")) / 1e6, feedTs: t.t, extra: { signedBurnBlock: block ? Number(block.replace(/^u/, "")) : "", fn: t.fn } };
    (arkByTok.get(id) ?? arkByTok.set(id, []).get(id)!).push(w);
  }

  // ---- 3. seed the value in force at the window start (read at the first block after W0)
  const firstAfter = [...dia.txs].filter((t) => t.t >= W0).sort((a, b) => a.t - b.t)[0];
  const b0 = await getBlock(firstAfter.h - 1);
  const r0 = new Reader(b0);
  const seedDia = Object.keys(cfg.dia.keys).filter((k) => !(diaByKey.get(k) ?? []).some((w) => w.t < W0));
  const sd = await r0.ro(seedDia.map((k) => [cfg.dia.contract, "get-value", Cl.stringAscii(k)]));
  seedDia.forEach((k, i) => {
    const v = sd[i].ok ? unwrapOk(sd[i].value) : null;
    if (v && BigInt(v.timestamp) > 0n) (diaByKey.get(k) ?? diaByKey.set(k, []).get(k)!).push({ t: Number(v.timestamp) / 1000, h: b0.height, txid: `state@${b0.height}`, value: Number(v.value) / 1e8, feedTs: Number(v.timestamp) / 1000, seed: true });
  });
  const ARK_NAME: Record<string, string> = { "1": "STX", "2": "xBTC", "8": "stSTX" };
  for (const id of Object.keys(cfg.arkadiko.tokens)) {
    if ((arkByTok.get(id) ?? []).some((w) => w.t < W0)) continue;
    const v = unwrapOk(await r0.one(cfg.arkadiko.contract, "get-price", Cl.stringAscii(ARK_NAME[id])));
    const bb = await requestJson(`${HIRO}/extended/v2/burn-blocks/${Number(v["last-block"])}`);
    (arkByTok.get(id) ?? arkByTok.set(id, []).get(id)!).push({ t: bb.burn_block_time, h: b0.height, txid: `state@${b0.height} (last-block burn ${v["last-block"]})`, value: Number(v["last-price"]) / 1e6, feedTs: bb.burn_block_time, seed: true });
  }

  // ---- 4. stSTX ratio through the window (sampled every N days, linear between samples).
  // StackingDAO moved its ratio read-only mid-window: data-core-v3 (with reserve-v1) answers until
  // its migration, data-stx-v2 from its initialisation (it reads 0 before). Samples where neither
  // answers are skipped and bridged by interpolation; each sample records its source.
  const ratioPts: [number, number, string][] = [];
  const readRatio = async (blk: Block): Promise<[number, string] | null> => {
    const res = await new Reader(blk).ro(cfg.ststxRatioSources.map((src: any) => [src.contract, src.fn, ...(src.reserve ? [Cl.principal(src.reserve)] : [])]));
    for (const [i, x] of res.entries()) {
      if (!x.ok) continue;
      const v = Number(unwrapOk(x.value));
      if (v > 0) return [v / 1e6, cfg.ststxRatioSources[i].contract.split(".")[1]];
    }
    return null;
  };
  const diaSorted = [...dia.txs].filter((t) => t.t >= W0).sort((a, b) => a.t - b.t);
  for (let t = W0; t < W1; t += cfg.ratioSampleDays * 86400) {
    const tx = diaSorted.find((x) => x.t >= t) ?? diaSorted[diaSorted.length - 1];
    const blk = await getBlock(tx.h);
    const v = await readRatio(blk);
    if (v) ratioPts.push([blk.blockTime, v[0], v[1]]);
  }
  const endRatio = await readRatio(end);
  if (endRatio) ratioPts.push([end.blockTime, endRatio[0], endRatio[1]]);
  if (ratioPts.length < 2) throw new Error("stSTX ratio: fewer than 2 readable samples in the window");
  const ratio = (t: number) => {
    if (t <= ratioPts[0][0]) return ratioPts[0][1];
    for (let i = 1; i < ratioPts.length; i++) if (t <= ratioPts[i][0]) {
      const [a, ra] = ratioPts[i - 1], [b, rb] = ratioPts[i];
      return ra + ((rb - ra) * (t - a)) / (b - a || 1);
    }
    return ratioPts[ratioPts.length - 1][1];
  };

  // ---- 5. reference
  log("  building 1-minute reference (cached per day)…");
  const refBTC = await buildReference(o.cacheDir, "BTC", W0, W1, log);
  const refSTX = await buildReference(o.cacheDir, "STX", W0, W1, log);
  const ref = (kind: string, t: number): number => (kind === "BTC" ? refAt(refBTC, t) : kind === "STX" ? refAt(refSTX, t) : kind === "STX*ratio" ? refAt(refSTX, t) * ratio(t) : kind === "par" ? 1 : NaN);

  // ---- 6. per-feed analysis
  const feeds: Feed[] = [
    ...Object.entries<any>(cfg.dia.keys).map(([k, c]) => ({ source: "DIA" as const, feed: k, ref: c.ref, frozen: c.frozen, writes: (diaByKey.get(k) ?? []).sort((a, b) => a.t - b.t), consumers: cfg.dia.consumers[k] })),
    ...Object.entries<any>(cfg.arkadiko.tokens).map(([id, c]) => ({ source: "Arkadiko" as const, feed: `${c.name} (token ${id})`, ref: c.ref, frozen: c.frozen, writes: (arkByTok.get(id) ?? []).sort((a, b) => a.t - b.t), consumers: cfg.arkadiko.consumers })),
  ];
  const episodes: Episode[] = [];
  const pushRows: Record<string, Record<string, unknown>[]> = { DIA: [], Arkadiko: [] };
  const summary: any = { feeds: {}, lazer: {}, findings: [] };
  const bands: number[] = cfg.deviationBandsPct;

  for (const f of feeds) {
    const all = f.writes;
    const inWin = all.filter((w) => w.t >= W0 && w.t <= W1 && !w.seed);
    const startIdx = Math.max(0, all.findIndex((w) => w.t >= W0) - 1);
    // push rows (at-publish deviation: against the reference at the feed's own timestamp)
    const atPublish: number[] = [];
    for (const w of inWin) {
      const rv = ref(f.ref, f.source === "DIA" ? w.feedTs : w.t);
      const dev = Number.isFinite(rv) ? (w.value / rv - 1) * 100 : null;
      if (dev !== null) atPublish.push(Math.abs(dev));
      pushRows[f.source].push({
        block_time_utc: iso(w.t), block_height: w.h, tx_id: w.txid, feed: f.feed, value_usd: w.value,
        ...(f.source === "DIA" ? { feed_timestamp_utc: iso(w.feedTs), write_lag_s: Math.round(w.t - w.feedTs) } : { signed_burn_block: w.extra?.signedBurnBlock ?? "" }),
        reference_usd: Number.isFinite(rv) ? r4(rv) : "", deviation_at_publish_pct: dev === null ? "" : r4(dev),
      });
    }
    // gaps / silence
    const gaps: number[] = [];
    const silenceS = f.source === "DIA" ? cfg.dia.silenceS : cfg.arkadiko.silence.warnS;
    const seq = all.slice(startIdx).filter((w) => w.t <= W1);
    for (let i = 0; i <= seq.length - 1; i++) {
      const a = seq[i];
      const bT = i + 1 < seq.length ? seq[i + 1].t : W1;
      const g = bT - Math.max(a.t, W0);
      if (i + 1 < seq.length && a.t >= W0) gaps.push(seq[i + 1].t - a.t);
      if (bT - a.t > silenceS && bT > W0) {
        const sev = f.source === "Arkadiko" ? (bT - a.t > cfg.arkadiko.silence.critS ? "critical" : "warn") : bT - a.t > 6 * 3600 ? "critical" : bT - a.t > 2 * 3600 ? "warn" : "info";
        episodes.push({ type: "silence", source: f.source, feed: f.feed, severity: sev, start: a.t, end: i + 1 < seq.length ? bT : null, hours: r2((bT - a.t) / 3600), startTx: a.txid, endTx: i + 1 < seq.length ? seq[i + 1].txid : undefined, detail: a.t < W0 ? `began before the window (${r2(g / 3600)} h inside it)` : undefined });
      }
    }
    // frozen-but-fresh: identical value across N writes with advancing timestamps while the reference moved
    let frozenHours = 0;
    if (f.frozen) {
      for (let i = 0; i < seq.length; ) {
        let j = i;
        while (j + 1 < seq.length && seq[j + 1].value === seq[i].value && seq[j + 1].feedTs > seq[j].feedTs) j++;
        const n = j - i + 1;
        if (n >= f.frozen.warnN) {
          const r0v = ref(f.ref, seq[i].t);
          let move = 0;
          for (let t = seq[i].t; t <= seq[j].t; t += 60) {
            const rv = ref(f.ref, t);
            if (Number.isFinite(rv) && Number.isFinite(r0v)) move = Math.max(move, Math.abs(rv / r0v - 1) * 100);
          }
          if (move >= f.frozen.warnMovePct) {
            const sev = n >= f.frozen.critN || move >= f.frozen.critMovePct ? "critical" : "warn";
            const endT = seq[j].t;
            frozenHours += Math.max(0, Math.min(endT, W1) - Math.max(seq[i].t, W0)) / 3600;
            episodes.push({ type: "frozen", source: f.source, feed: f.feed, severity: sev, start: seq[i].t, end: j + 1 < seq.length ? endT : null, hours: r2((endT - seq[i].t) / 3600), writes: n, value: seq[i].value, refMovePct: r2(move), startTx: seq[i].txid, endTx: seq[j].txid });
          }
        }
        i = j + 1;
      }
    }
    // minute-by-minute: age and as-read deviation of the value in force
    const bandMin: Record<number, number> = Object.fromEntries(bands.map((b) => [b, 0]));
    const ageOver: Record<string, number> = { "1350": 0, "3600": 0, "12600": 0, "21600": 0, "86400": 0, "le120": 0 };
    let degraded = 0;
    let maxDev = 0;
    let validMin = 0;
    const open: Record<number, Episode | null> = Object.fromEntries((cfg.episodeBandsPct as number[]).map((b) => [b, null]));
    const quiet: Record<number, number> = Object.fromEntries((cfg.episodeBandsPct as number[]).map((b) => [b, 0]));
    const mergeMin: number = cfg.episodeMergeMinutes;
    let k = startIdx;
    for (let t = Math.floor(W0 / 60) * 60; t < W1; t += 60) {
      while (k + 1 < all.length && all[k + 1].t <= t) k++;
      const w = all[k];
      if (!w || w.t > t) continue;
      const age = t - w.feedTs;
      for (const th of ["1350", "3600", "12600", "21600", "86400"]) if (age > Number(th)) ageOver[th]++;
      if (age <= 120) ageOver.le120++;
      const rv = ref(f.ref, t);
      if (!Number.isFinite(rv)) {
        degraded++;
        continue;
      }
      validMin++;
      const dev = Math.abs(w.value / rv - 1) * 100;
      maxDev = Math.max(maxDev, dev);
      for (const b of bands) if (dev > b) bandMin[b]++;
      for (const b of cfg.episodeBandsPct as number[]) {
        const e = open[b];
        if (dev > b) {
          if (e) {
            e.end = t + 60;
            quiet[b] = 0;
            e.maxDeviationPct = Math.max(e.maxDeviationPct!, r2(dev));
          } else open[b] = { type: "deviation", source: f.source, feed: f.feed, severity: b >= 5 ? "critical" : "warn", band: b, start: t, end: t + 60, hours: 0, maxDeviationPct: r2(dev), value: w.value, startTx: w.txid };
        } else if (e && ++quiet[b] >= mergeMin) {
          // hysteresis: an episode closes only after `mergeMin` consecutive minutes back inside the band
          e.hours = r2((e.end! - e.start) / 3600);
          if (e.end! - e.start >= 120) episodes.push(e); // persistence: >= 2 minutes above the band
          open[b] = null;
          quiet[b] = 0;
        }
      }
    }
    for (const e of Object.values(open)) if (e) {
      const ongoing = W1 - e.end! < mergeMin * 60;
      e.hours = r2(((ongoing ? W1 : e.end!) - e.start) / 3600);
      if (ongoing) e.end = null;
      if (W1 - e.start >= 120) episodes.push(e);
    }
    const last = all.filter((w) => w.t <= W1).at(-1);
    const nowRef = last ? ref(f.ref, W1 - 60) : NaN;
    summary.feeds[`${f.source}:${f.feed}`] = {
      source: f.source, feed: f.feed, reference: f.ref, consumers: f.consumers,
      writesInWindow: inWin.length,
      gapS: { p50: q(gaps, 0.5), p90: q(gaps, 0.9), p99: q(gaps, 0.99), max: gaps.length ? Math.max(...gaps) : null },
      hoursAgeOver: { "1350s": r2(ageOver["1350"] / 60), "1h": r2(ageOver["3600"] / 60), "3.5h": r2(ageOver["12600"] / 60), "6h": r2(ageOver["21600"] / 60), "24h": r2(ageOver["86400"] / 60) },
      shareOfMinutesAgeAtMost120s: r4(ageOver.le120 / (cfg.windowDays * 1440)),
      hoursDeviationOver: Object.fromEntries(bands.map((b) => [`${b}%`, r2(bandMin[b] / 60)])),
      maxAsReadDeviationPct: r2(maxDev),
      atPublishDeviationPct: { p50: atPublish.length ? r4(q(atPublish, 0.5)!) : null, p99: atPublish.length ? r4(q(atPublish, 0.99)!) : null, max: atPublish.length ? r4(Math.max(...atPublish)) : null },
      frozenHours: r2(frozenHours),
      referenceDegradedMinutes: degraded,
      referenceValidMinutes: validMin,
      now: last ? { value: last.value, lastWriteUtc: iso(last.t), lastTx: last.txid, ageS: Math.round(W1 - last.feedTs), deviationPct: Number.isFinite(nowRef) ? r2((last.value / nowRef - 1) * 100) : null } : null,
    };
  }

  // ---- 7. Lazer-carrying consumer txs: payload age and outcome only
  const lazerRows: Record<string, unknown>[] = [];
  for (const c of cfg.lazer.consumers) {
    const { txs } = await scanTxs(o.cacheDir, c.contract, end.height, { log });
    const obs: { t: number; age: number; status: string; cls: string; sender: string; txid: string }[] = [];
    for (const t of txs) {
      if (t.t < W0 || t.t > W1) continue;
      const us = lazerTimestampUs(t.args);
      if (us === null) continue;
      const age = t.t - us / 1e6;
      const oracleErr = c.oracleErrors[t.result];
      const cls = t.status === "success" ? "ok" : oracleErr ? ((c.strict ? age >= c.limitS : age > c.limitS) ? "oracle-revert:stale" : "oracle-revert:other") : "revert:non-oracle";
      obs.push({ t: t.t, age, status: t.status, cls, sender: t.sender, txid: t.txid });
      lazerRows.push({
        block_time_utc: iso(t.t), block_height: t.h, tx_id: t.txid, market: c.market, contract: c.contract, function: t.fn, sender: t.sender,
        payload_time_utc: iso(Math.floor(us / 1e6)), payload_age_s: r2(age), limit_s: c.limitS, headroom_s: r2(c.limitS - age), tx_status: t.status, result: t.result.slice(0, 40),
        classification: cls, meaning: oracleErr ?? "",
      });
    }
    obs.sort((a, b) => a.t - b.t);
    const okAges = obs.filter((x) => x.cls === "ok").map((x) => x.age);
    const reverts = obs.filter((x) => x.cls.startsWith("oracle-revert"));
    for (let i = 0; i < reverts.length; ) {
      let j = i;
      while (j + 1 < reverts.length && reverts[j + 1].t - reverts[j].t <= cfg.lazer.burst.gapS) j++;
      const n = j - i + 1;
      if (n >= cfg.lazer.burst.minReverts) {
        const ages = reverts.slice(i, j + 1).map((x) => x.age);
        const senders = new Set(reverts.slice(i, j + 1).map((x) => x.sender));
        episodes.push({ type: "lazer-stale-burst", source: "Pyth Lazer", feed: `${c.market} ${c.contract.split(".")[1]}`, severity: n >= 5 ? "critical" : "warn", start: reverts[i].t, end: reverts[j].t, hours: r2((reverts[j].t - reverts[i].t) / 3600), writes: n, startTx: reverts[i].txid, endTx: reverts[j].txid, detail: `${n} oracle reverts from ${senders.size} sender(s); payload age ${Math.round(Math.min(...ages))}–${Math.round(Math.max(...ages))} s vs limit ${c.limitS} s` });
      }
      i = j + 1;
    }
    const key = `${c.market}:${c.contract.split(".")[1]}`;
    summary.lazer[key] = {
      market: c.market, contract: c.contract, limitS: c.limitS,
      lazerTxs: obs.length, ok: okAges.length,
      oracleRevertsStale: obs.filter((x) => x.cls === "oracle-revert:stale").length,
      oracleRevertsOther: obs.filter((x) => x.cls === "oracle-revert:other").length,
      nonOracleReverts: obs.filter((x) => x.cls === "revert:non-oracle").length,
      payloadAgeAtInclusionOkS: { p50: q(okAges, 0.5), p90: q(okAges, 0.9), p99: q(okAges, 0.99), max: okAges.length ? r2(Math.max(...okAges)) : null },
      firstObserved: obs.length ? iso(obs[0].t) : null,
      lastObserved: obs.length ? iso(obs[obs.length - 1].t) : null,
    };
  }

  // ---- 8. standing findings, computed from the data above
  const arkLong = episodes.filter((e) => e.type === "silence" && e.source === "Arkadiko" && e.start >= W0 && e.hours >= 24).sort((a, b) => a.start - b.start);
  if (arkLong.length) {
    const hs = arkLong.map((e) => e.hours);
    const lo = Math.round(Math.min(...hs)), hi = Math.round(Math.max(...hs));
    summary.findings.push({
      id: "arkadiko-silence", severity: "critical",
      title: `Arkadiko oracle silent for ${lo === hi ? lo : `${lo}–${hi}`} h`,
      statement: `arkadiko-oracle-v2-3 received no price for ${arkLong.map((e) => `${e.feed.split(" ")[0]} ${e.hours} h (${iso(e.start)} → ${e.end ? iso(e.end) : "ongoing"})`).join(", ")}. Arkadiko vaults read the stored price with no staleness check, so the old price stayed live for mints, redemptions and liquidations.`,
      evidence: arkLong.map((e) => ({ feed: e.feed, hours: e.hours, start: iso(e.start), end: e.end ? iso(e.end) : null, lastWriteBefore: e.startTx, firstWriteAfter: e.endTx ?? null })),
    });
  }
  const diaCore = episodes.filter((e) => e.type === "silence" && e.source === "DIA" && (e.feed === "BTC/USD" || e.feed === "STX/USD") && e.hours > 6 && e.start >= W0);
  if (diaCore.length) summary.findings.push({
    id: "dia-core-outages", severity: "warn",
    title: `DIA BTC/USD and STX/USD: ${new Set(diaCore.map((e) => e.start)).size} outage(s) over 6 h`,
    statement: `DIA's healthiest keys stopped updating together: ${[...new Map(diaCore.map((e) => [e.start, e])).values()].map((e) => `${e.hours} h from ${iso(e.start)}`).join("; ")}. Values stayed within ${summary.feeds["DIA:BTC/USD"].hoursDeviationOver["5%"] === 0 ? "5%" : "the bands shown"} of the reference, but any consumer with a staleness limit under the gap would have stopped.`,
    evidence: diaCore.map((e) => ({ feed: e.feed, hours: e.hours, start: iso(e.start), end: e.end ? iso(e.end) : null, lastWriteBefore: e.startTx, firstWriteAfter: e.endTx })),
  });
  for (const key of ["sBTC/USD", "stSTX/USD"]) {
    const fz = episodes.filter((e) => e.type === "frozen" && e.source === "DIA" && e.feed === key).sort((a, b) => b.hours - a.hours);
    const sil = episodes.filter((e) => e.type === "silence" && e.source === "DIA" && e.feed === key).sort((a, b) => b.hours - a.hours);
    const s = summary.feeds[`DIA:${key}`];
    if (fz.length || sil.length) summary.findings.push({
      id: `dia-${key.split("/")[0].toLowerCase()}-frozen`, severity: "warn",
      title: `DIA ${key}: ${Math.round(s.frozenHours)} h frozen-but-fresh${sil[0] ? `, ${Math.round(sil[0].hours)} h silent` : ""}`,
      statement: `DIA kept writing ${key} with fresh timestamps and an identical value for ${Math.round(s.frozenHours)} h in the window (${fz.length} episode${fz.length === 1 ? "" : "s"}; longest ${fz[0]?.hours ?? 0} h over ${fz[0]?.writes ?? 0} writes at ${fz[0] ? usd(fz[0].value!) : "n/a"}), and was more than 5% off its reference for ${s.hoursDeviationOver["5%"]} h. A timestamp-only staleness check passes throughout. No in-scope lending market consumes this key.`,
      evidence: { longestFrozen: fz[0] ? { start: iso(fz[0].start), end: fz[0].end ? iso(fz[0].end) : "ongoing", writes: fz[0].writes, value: fz[0].value, startTx: fz[0].startTx, endTx: fz[0].endTx } : null, longestSilence: sil[0] ? { start: iso(sil[0].start), end: sil[0].end ? iso(sil[0].end) : "ongoing", hours: sil[0].hours } : null, now: s.now },
    });
  }
  // Zest v2 zUSDH: collateral priced from DIA USDh with a 120 s limit on a ~900 s heartbeat
  const re = new Reader(end);
  const [z9, z8] = (await re.ro([[cfg.zestV2.assets, "get-status", Cl.uint(cfg.zestV2.zusdhAssetId)], [cfg.zestV2.assets, "get-status", Cl.uint(cfg.zestV2.usdhAssetId)]])).map((x) => (x.ok ? unwrapOk(x.value) : null));
  const usdh = summary.feeds["DIA:USDh/USD"];
  const zv2Txs = [...(await scanTxs(o.cacheDir, "SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7.v0-8-market", end.height)).txs, ...(await scanTxs(o.cacheDir, "SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7.v0-7-market", end.height)).txs];
  const touching = zv2Txs.filter((t) => t.args.some((a) => a.includes(cfg.zestV2.vaultUsdh))).length;
  if (z9) summary.findings.push({
    id: "zest-v2-zusdh-staleness-trap", severity: "warn",
    title: `Zest v2 zUSDH: ${Number(z9.oracle["max-staleness"])} s limit on a ~${cfg.dia.heartbeatS} s DIA heartbeat`,
    statement: `v0-assets asset ${cfg.zestV2.zusdhAssetId} (zUSDH, collateral ${z9.collateral ? "enabled" : "disabled"}) is priced from DIA "USDh/USD" with max-staleness ${Number(z9.oracle["max-staleness"])} s. DIA pushes that key about every ${cfg.dia.heartbeatS} s, so its age was within ${Number(z9.oracle["max-staleness"])} s only ${r2(usdh.shareOfMinutesAgeAtMost120s * 100)}% of minutes in the window. A priced operation for an account holding zUSDH would revert most of the time. USDH debt (asset ${cfg.zestV2.usdhAssetId}) uses the same key with max-staleness ${z8 ? Number(z8.oracle["max-staleness"]) : "?"} s. ${touching} Zest v2 v0-7/v0-8 transaction(s) have referenced v0-vault-usdh.`,
    evidence: { block: end.height, zusdh: { maxStalenessS: Number(z9.oracle["max-staleness"]), oracleType: z9.oracle.type, collateral: z9.collateral }, usdhDebt: z8 ? { maxStalenessS: Number(z8.oracle["max-staleness"]) } : null, diaUsdhShareOfMinutesAgeAtMost120s: usdh.shareOfMinutesAgeAtMost120s, txsReferencingVaultUsdh: touching },
  });
  const burst = episodes.filter((e) => e.type === "lazer-stale-burst").sort((a, b) => (b.writes ?? 0) - (a.writes ?? 0))[0];
  if (burst) summary.findings.push({
    id: "lazer-stale-revert-burst", severity: burst.severity,
    title: `Largest Lazer stale-revert burst: ${burst.writes} reverts (${burst.feed})`,
    statement: `${burst.detail}, ${iso(burst.start)} → ${iso(burst.end)}.`,
    evidence: { firstTx: burst.startTx, lastTx: burst.endTx },
  });

  // ---- 9. write
  const out = path.join(o.outDir, "oracle");
  fs.mkdirSync(out, { recursive: true });
  const byT = (a: any, b: any) => (a.block_time_utc < b.block_time_utc ? -1 : 1);
  fs.writeFileSync(path.join(out, "dia-pushes.csv"), csv(pushRows.DIA.sort(byT), ["block_time_utc", "block_height", "tx_id", "feed", "value_usd", "feed_timestamp_utc", "write_lag_s", "reference_usd", "deviation_at_publish_pct"]));
  fs.writeFileSync(path.join(out, "arkadiko-pushes.csv"), csv(pushRows.Arkadiko.sort(byT), ["block_time_utc", "block_height", "tx_id", "feed", "value_usd", "signed_burn_block", "reference_usd", "deviation_at_publish_pct"]));
  fs.writeFileSync(path.join(out, "lazer-observations.csv"), csv(lazerRows.sort(byT), ["block_time_utc", "block_height", "tx_id", "market", "contract", "function", "sender", "payload_time_utc", "payload_age_s", "limit_s", "headroom_s", "tx_status", "result", "classification", "meaning"]));
  episodes.sort((a, b) => a.start - b.start);
  const epRows = episodes.map((e) => ({ ...e, start_utc: iso(e.start), end_utc: e.end === null ? "ongoing" : iso(e.end) }));
  fs.writeFileSync(path.join(out, "episodes.csv"), csv(epRows, ["type", "severity", "source", "feed", "band", "start_utc", "end_utc", "hours", "writes", "value", "maxDeviationPct", "refMovePct", "startTx", "endTx", "detail"]));
  fs.writeFileSync(path.join(out, "episodes.json"), JSON.stringify(epRows, null, 1));
  const refRows: Record<string, unknown>[] = [];
  for (let i = 0; i < refBTC.minutes; i++) refRows.push({ minute_utc: iso(refBTC.from + i * 60), btc_usd: Number.isFinite(refBTC.price[i]) ? r2(refBTC.price[i]) : "", btc_venues: refBTC.sources[i], stx_usd: Number.isFinite(refSTX.price[i]) ? Math.round(refSTX.price[i] * 1e6) / 1e6 : "", stx_venues: refSTX.sources[i], ststx_ratio: Math.round(ratio(refBTC.from + i * 60) * 1e6) / 1e6 });
  fs.writeFileSync(path.join(out, "reference-1m.csv"), csv(refRows, ["minute_utc", "btc_usd", "btc_venues", "stx_usd", "stx_venues", "ststx_ratio"]));
  const counts = (t: string) => episodes.filter((e) => e.type === t).length;
  const full = {
    schema: 1,
    generatedAt: new Date().toISOString(),
    window: { from: iso(W0), to: iso(W1), days: cfg.windowDays, endBlock: end },
    method: {
      pushes: "Every successful DIA set-multiple-values / set-value and Arkadiko update-price-multi / update-price-owner in the window, decoded from tx arguments. The value in force at the window start is read on-chain at the first block of the window.",
      reference: `Per-minute median of venues that traded in that minute, carrying a venue's last trade forward up to ${MAX_CARRY} min; BTC from ${SOURCES.BTC.map((s) => s.id).join(", ")} (min ${MIN_SOURCES.BTC}); STX from ${SOURCES.STX.map((s) => s.id).join(", ")} (min ${MIN_SOURCES.STX}); USDT quotes x Coinbase hourly USDT-USD. stSTX reference = STX x on-chain data-stx-v2 ratio, sampled every ${cfg.ratioSampleDays} days and interpolated. Stablecoin keys against $1 par.`,
      asRead: "Deviation and age are evaluated every minute for the value in force (last write at or before the minute).",
      atPublish: "DIA values are compared with the reference at the feed's own timestamp; Arkadiko values (no feed timestamp) at the block time.",
      frozen: "A run of identical values over N or more writes with advancing timestamps while the reference moved by at least the configured percentage (config/oracle.json).",
      silence: `A gap between writes of a feed longer than ${cfg.dia.silenceS} s (DIA) or ${cfg.arkadiko.silence.warnS} s (Arkadiko).`,
      deviation: `Minutes with |value/reference - 1| above ${cfg.episodeBandsPct.join("% / ")}%; an episode lasts at least 2 minutes and closes only after ${cfg.episodeMergeMinutes} consecutive minutes back inside the band.`,
      lazer: cfg.lazer.note + " Age = Stacks block time - payload timestamp. A revert is 'oracle-revert:stale' when its result is one of the consumer's oracle error codes and the payload age exceeds the consumer's limit, 'oracle-revert:other' for oracle codes within the limit (monotonic races, confidence, signature).",
      thresholds: cfg,
    },
    provenance: { diaTxs: dia.txs.filter((t) => t.t >= W0).length, arkadikoTxs: ark.txs.filter((t) => t.t >= W0).length, ststxRatioSamples: ratioPts.map(([t, v, src]) => ({ time: iso(t), ratio: v, source: src })), referenceVenueCoverage: { BTC: refBTC.venueCoverage, STX: refSTX.venueCoverage }, requests: ledgerSummary() },
    episodeCounts: { silence: counts("silence"), frozen: counts("frozen"), deviation: counts("deviation"), lazerStaleBurst: counts("lazer-stale-burst") },
    ...summary,
  };
  fs.writeFileSync(path.join(out, "summary.json"), JSON.stringify(full, null, 1));
  writeIndex(o.outDir);
  log(`  wrote ${out}: ${pushRows.DIA.length} DIA rows, ${pushRows.Arkadiko.length} Arkadiko rows, ${lazerRows.length} Lazer rows, ${episodes.length} episodes`);
  return full;
}

export type { RefSeries, Tx };
