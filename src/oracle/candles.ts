// 1-minute reference series for the oracle record (history, not live).
//
// Per venue and symbol, candles are cached one file per UTC day, so a daily run
// only fetches the new day. The reference at minute m is the median of the
// venues that traded at m, carrying a venue's last trade forward at most
// MAX_CARRY minutes, and is marked degraded when fewer than the asset's
// minimum venues are present. USDT-quoted closes are converted with Coinbase's
// hourly USDT-USD candle.
//
// Venue choice: keyless venues with enough STX/BTC liquidity, limited to those that serve
// 90 days of 1-minute history keylessly (Gate keeps only 10,000 minutes; Kraken 720).

import fs from "node:fs";
import path from "node:path";
import { requestJson, type RequestOpts } from "../lib/http.ts";
import { median } from "../lib/prices.ts";

export type RefAsset = "BTC" | "STX";
type Src = { id: string; quote: "USD" | "USDT"; fetch: (from: number, to: number) => Promise<[number, number, number][]> };

const OPTS: RequestOpts = { timeoutMs: 20_000, maxAttempts: 4 };
const J = <T = any>(u: string) => requestJson<T>(u, OPTS);
const iso = (t: number) => new Date(t * 1000).toISOString().replace(".000", "");

// Each fetcher returns [openTime s, close, volume] for candles with open time in [from, to).
const binance = (host: string, pathName: string, sym: string): Src["fetch"] => async (from, to) => {
  const out: [number, number, number][] = [];
  for (let t = from; t < to; t += 1000 * 60) {
    const j = await J<any[]>(`https://${host}${pathName}?symbol=${sym}&interval=1m&startTime=${t * 1000}&endTime=${Math.min(to, t + 60000) * 1000 - 1}&limit=1000`);
    for (const k of j ?? []) out.push([k[0] / 1000, +k[4], +k[5]]);
  }
  return out;
};
const bybit = (sym: string): Src["fetch"] => async (from, to) => {
  const out: [number, number, number][] = [];
  for (let t = from; t < to; t += 1000 * 60) {
    const j = await J<any>(`https://api.bybit.com/v5/market/kline?category=spot&symbol=${sym}&interval=1&start=${t * 1000}&end=${Math.min(to, t + 60000) * 1000 - 1}&limit=1000`);
    for (const k of j?.result?.list ?? []) out.push([+k[0] / 1000, +k[4], +k[5]]);
  }
  return out;
};
const kucoin = (sym: string): Src["fetch"] => async (from, to) => {
  const out: [number, number, number][] = [];
  for (let t = from; t < to; t += 1500 * 60) {
    const j = await J<any>(`https://api.kucoin.com/api/v1/market/candles?type=1min&symbol=${sym}&startAt=${t}&endAt=${Math.min(to, t + 90000) - 1}`);
    for (const k of j?.data ?? []) out.push([+k[0], +k[2], +k[5]]);
  }
  return out;
};
const coinbase = (sym: string, gran = 60): Src["fetch"] => async (from, to) => {
  const out: [number, number, number][] = [];
  for (let t = from; t < to; t += 300 * gran) {
    const end = Math.min(to, t + 300 * gran) - gran;
    if (end < t) break; // no complete candle of this granularity yet (e.g. hourly, just after midnight)
    const j = await J<any[]>(`https://api.exchange.coinbase.com/products/${sym}/candles?granularity=${gran}&start=${iso(t)}&end=${iso(end)}`);
    for (const k of j ?? []) out.push([k[0], +k[4], +k[5]]);
  }
  return out;
};

export const SOURCES: Record<RefAsset, Src[]> = {
  BTC: [
    { id: "coinbase:BTC-USD", quote: "USD", fetch: coinbase("BTC-USD") },
    { id: "binance:BTCUSDT", quote: "USDT", fetch: binance("api.binance.com", "/api/v3/klines", "BTCUSDT") },
    { id: "bybit:BTCUSDT", quote: "USDT", fetch: bybit("BTCUSDT") },
  ],
  STX: [
    { id: "binance-perp:STXUSDT", quote: "USDT", fetch: binance("fapi.binance.com", "/fapi/v1/klines", "STXUSDT") },
    { id: "binance:STXUSDT", quote: "USDT", fetch: binance("api.binance.com", "/api/v3/klines", "STXUSDT") },
    { id: "bybit:STXUSDT", quote: "USDT", fetch: bybit("STXUSDT") },
    { id: "kucoin:STX-USDT", quote: "USDT", fetch: kucoin("STX-USDT") },
  ],
};
export const MIN_SOURCES: Record<RefAsset, number> = { BTC: 2, STX: 2 };
export const MAX_CARRY = 2; // minutes
const USDT_SRC: Src = { id: "coinbase:USDT-USD:1h", quote: "USD", fetch: coinbase("USDT-USD", 3600) };

const DAY = 86400;
const dayKey = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);

/** Candles for [from, to) from the day cache, fetching missing or incomplete days. */
async function series(cacheDir: string, src: Src, from: number, to: number, step: number, log: (m: string) => void): Promise<Map<number, [number, number]>> {
  const dir = path.join(cacheDir, "candles", src.id.replace(/[^A-Za-z0-9.-]/g, "_"));
  fs.mkdirSync(dir, { recursive: true });
  const out = new Map<number, [number, number]>();
  const now = Math.floor(Date.now() / 1000);
  let fetched = 0;
  for (let d = Math.floor(from / DAY) * DAY; d < to; d += DAY) {
    const f = path.join(dir, dayKey(d) + ".json");
    let rows: [number, number, number][] | null = null;
    const complete = d + DAY + 600 < now; // a day is final 10 minutes after it ends
    if (fs.existsSync(f)) {
      const c = JSON.parse(fs.readFileSync(f, "utf8"));
      if (c.complete || !complete) rows = c.rows;
      if (!complete) rows = null; // today: always refresh
    }
    if (!rows) {
      rows = (await src.fetch(d, Math.min(d + DAY, Math.floor(now / 60) * 60 - 60))).filter((r) => r[0] >= d && r[0] < d + DAY);
      fs.writeFileSync(f, JSON.stringify({ complete, rows }));
      fetched++;
    }
    for (const [t, c, v] of rows) if (t >= from && t < to && t % step === 0) out.set(t, [c, v]);
  }
  if (fetched) log(`  candles ${src.id}: fetched ${fetched} day(s)`);
  return out;
}

export type RefSeries = {
  from: number; // first minute (unix s)
  minutes: number;
  price: Float64Array; // NaN where degraded
  sources: Uint8Array; // venues contributing at that minute
  venueCoverage: Record<string, number>; // share of minutes each venue traded
};

export async function buildReference(cacheDir: string, asset: RefAsset, from: number, to: number, log: (m: string) => void): Promise<RefSeries> {
  from = Math.floor(from / 60) * 60;
  const minutes = Math.floor((to - from) / 60);
  const [usdt, ...venues] = await Promise.all([series(cacheDir, USDT_SRC, from - 3600, to, 3600, log), ...SOURCES[asset].map((s) => series(cacheDir, s, from - MAX_CARRY * 60, to, 60, log))]);
  const usdtAt = (t: number) => usdt.get(Math.floor(t / 3600) * 3600)?.[0] ?? usdt.get(Math.floor(t / 3600) * 3600 - 3600)?.[0] ?? 1;
  const price = new Float64Array(minutes).fill(NaN);
  const sources = new Uint8Array(minutes);
  const traded: Record<string, number> = {};
  SOURCES[asset].forEach((s) => (traded[s.id] = 0));
  for (let i = 0; i < minutes; i++) {
    const t = from + i * 60;
    const xs: number[] = [];
    SOURCES[asset].forEach((s, k) => {
      for (let back = 0; back <= MAX_CARRY; back++) {
        const c = venues[k].get(t - back * 60);
        if (c && c[1] > 0 && c[0] > 0) {
          xs.push(s.quote === "USDT" ? c[0] * usdtAt(t) : c[0]);
          if (back === 0) traded[s.id]++;
          break;
        }
      }
    });
    sources[i] = xs.length;
    if (xs.length >= MIN_SOURCES[asset]) price[i] = median(xs);
  }
  const venueCoverage = Object.fromEntries(Object.entries(traded).map(([k, v]) => [k, Math.round((v / minutes) * 1000) / 1000]));
  return { from, minutes, price, sources, venueCoverage };
}

/** Reference at time t (the minute containing t); NaN if degraded or out of range. */
export function refAt(r: RefSeries, t: number): number {
  const i = Math.floor((t - r.from) / 60);
  return i >= 0 && i < r.minutes ? r.price[i] : NaN;
}
