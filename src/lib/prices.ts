// Reference prices from keyless public 1-minute candles.
//
// A snapshot's reference price is the median close of the last *completed*
// 1-minute candle before the pinned block's time, across up to 7 venues.
// Candles are historical and public, so `verify` can re-fetch the same candles
// later and reproduce the median. (Kraken only serves the last 720 minutes, so
// older snapshots are re-checked against the remaining venues.)
//
// USDT-quoted venues are converted to USD with the median USDT/USD candle from
// Kraken and Coinbase. Prices are returned as integers scaled by 1e8.

import { requestJson as rawRequestJson, type RequestOpts } from "./http.ts";

// Exchange endpoints get a short timeout and few attempts: a venue that is
// unreachable from the host's region (OKX, Binance in some regions) must not
// stall a snapshot. A venue that fails is skipped for the rest of the process.
const CEX_OPTS: RequestOpts = { timeoutMs: 12_000, maxAttempts: 2 };
const deadVenues = new Map<string, string>();
const requestJson = <T = any>(url: string) => rawRequestJson<T>(url, CEX_OPTS);

export type Asset = "BTC" | "STX" | "USDC";
export type Venue = "coinbase" | "kraken" | "binance" | "bybit" | "okx" | "kucoin" | "gate";

export const VENUES: Venue[] = ["coinbase", "kraken", "binance", "bybit", "okx", "kucoin", "gate"];
/** Minimum number of venues with a candle in the window for the median to be used. */
export const MIN_VENUES: Record<Asset, number> = { BTC: 4, STX: 4, USDC: 3 };
/** How far back a venue's last traded candle may be (thin STX books skip minutes). */
export const MAX_CANDLE_AGE_S = 300;

type Quote = "USD" | "USDT";
const SYMBOLS: Record<Venue, Partial<Record<Asset | "USDT", { sym: string; quote: Quote }>>> = {
  coinbase: { BTC: { sym: "BTC-USD", quote: "USD" }, STX: { sym: "STX-USD", quote: "USD" }, USDT: { sym: "USDT-USD", quote: "USD" } },
  kraken: { BTC: { sym: "XBTUSD", quote: "USD" }, STX: { sym: "STXUSD", quote: "USD" }, USDC: { sym: "USDCUSD", quote: "USD" }, USDT: { sym: "USDTUSD", quote: "USD" } },
  binance: { BTC: { sym: "BTCUSDT", quote: "USDT" }, STX: { sym: "STXUSDT", quote: "USDT" }, USDC: { sym: "USDCUSDT", quote: "USDT" } },
  bybit: { BTC: { sym: "BTCUSDT", quote: "USDT" }, STX: { sym: "STXUSDT", quote: "USDT" }, USDC: { sym: "USDCUSDT", quote: "USDT" } },
  okx: { BTC: { sym: "BTC-USDT", quote: "USDT" }, STX: { sym: "STX-USDT", quote: "USDT" }, USDC: { sym: "USDC-USDT", quote: "USDT" } },
  kucoin: { BTC: { sym: "BTC-USDT", quote: "USDT" }, STX: { sym: "STX-USDT", quote: "USDT" }, USDC: { sym: "USDC-USDT", quote: "USDT" } },
  gate: { BTC: { sym: "BTC_USDT", quote: "USDT" }, STX: { sym: "STX_USDT", quote: "USDT" }, USDC: { sym: "USDC_USDT", quote: "USDT" } },
};

/** One candle: open time (unix s) and close. */
export type Candle = { t: number; close: number; volume: number };

async function candles(venue: Venue, sym: string, from: number, to: number): Promise<Candle[]> {
  // [from, to] are candle open times (unix seconds, minute aligned), inclusive.
  switch (venue) {
    case "coinbase": {
      const j = await requestJson<any[]>(
        `https://api.exchange.coinbase.com/products/${sym}/candles?granularity=60&start=${new Date(from * 1000).toISOString()}&end=${new Date(to * 1000).toISOString()}`,
      );
      return (j ?? []).map((k) => ({ t: k[0], close: +k[4], volume: +k[5] }));
    }
    case "kraken": {
      const j = await requestJson<any>(`https://api.kraken.com/0/public/OHLC?pair=${sym}&interval=1&since=${from - 60}`);
      if (j?.error?.length) throw new Error(`kraken ${sym}: ${j.error.join(",")}`);
      const rows = Object.entries(j.result).find(([k]) => k !== "last")?.[1] as any[];
      return (rows ?? []).map((k) => ({ t: +k[0], close: +k[4], volume: +k[6] }));
    }
    case "binance": {
      const j = await requestJson<any[]>(`https://api.binance.com/api/v3/klines?symbol=${sym}&interval=1m&startTime=${from * 1000}&endTime=${to * 1000}&limit=20`);
      return (j ?? []).map((k) => ({ t: k[0] / 1000, close: +k[4], volume: +k[5] }));
    }
    case "bybit": {
      const j = await requestJson<any>(`https://api.bybit.com/v5/market/kline?category=spot&symbol=${sym}&interval=1&start=${from * 1000}&end=${to * 1000}&limit=20`);
      return (j?.result?.list ?? []).map((k: any[]) => ({ t: +k[0] / 1000, close: +k[4], volume: +k[5] }));
    }
    case "okx": {
      // `after` returns candles strictly older than the given ms timestamp.
      const j = await requestJson<any>(`https://www.okx.com/api/v5/market/history-candles?instId=${sym}&bar=1m&after=${(to + 60) * 1000}&limit=20`);
      return (j?.data ?? []).map((k: any[]) => ({ t: +k[0] / 1000, close: +k[4], volume: +k[5] }));
    }
    case "kucoin": {
      const j = await requestJson<any>(`https://api.kucoin.com/api/v1/market/candles?type=1min&symbol=${sym}&startAt=${from}&endAt=${to + 60}`);
      return (j?.data ?? []).map((k: any[]) => ({ t: +k[0], close: +k[2], volume: +k[5] }));
    }
    case "gate": {
      const j = await requestJson<any[]>(`https://api.gateio.ws/api/v4/spot/candlesticks?currency_pair=${sym}&interval=1m&from=${from}&to=${to}`);
      return (j ?? []).map((k) => ({ t: +k[0], close: +k[2], volume: +k[1] }));
    }
  }
}

export type VenueQuote = { venue: Venue; sym: string; candleTime: number; closeRaw: number; quote: Quote; usd: number };
export type AssetPrice = {
  asset: Asset;
  /** Median in USD, scaled 1e8 (integer). Null when fewer than MIN_VENUES venues had data. */
  usd1e8: bigint | null;
  median: number | null;
  venues: VenueQuote[];
  missing: { venue: Venue; reason: string }[];
};
export type ReferencePrices = {
  method: string;
  targetMinute: number; // open time of the candle used
  usdtUsd: number | null;
  usdtVenues: VenueQuote[];
  assets: Record<Asset, AssetPrice>;
};

export function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export const to1e8 = (x: number): bigint => BigInt(Math.round(x * 1e8));

async function lastCandle(venue: Venue, sym: string, target: number): Promise<Candle | null> {
  const cs = await candles(venue, sym, target - MAX_CANDLE_AGE_S, target);
  const ok = cs.filter((c) => c.t <= target && c.t >= target - MAX_CANDLE_AGE_S && c.volume > 0 && c.close > 0);
  ok.sort((a, b) => b.t - a.t);
  return ok[0] ?? null;
}

/** Reference prices for the last completed minute strictly before `blockTime`. */
export async function referencePrices(blockTime: number, assets: Asset[] = ["BTC", "STX", "USDC"]): Promise<ReferencePrices> {
  const target = Math.floor(blockTime / 60) * 60 - 60;

  const usdtVenues: VenueQuote[] = [];
  for (const v of ["kraken", "coinbase"] as Venue[]) {
    const s = SYMBOLS[v].USDT!;
    try {
      const c = await lastCandle(v, s.sym, target);
      if (c) usdtVenues.push({ venue: v, sym: s.sym, candleTime: c.t, closeRaw: c.close, quote: "USD", usd: c.close });
    } catch {
      /* recorded implicitly by absence */
    }
  }
  const usdtUsd = usdtVenues.length ? median(usdtVenues.map((q) => q.closeRaw)) : null;

  const out = {} as Record<Asset, AssetPrice>;
  for (const a of assets) {
    const venues: VenueQuote[] = [];
    const missing: { venue: Venue; reason: string }[] = [];
    for (const v of VENUES) {
      const s = SYMBOLS[v][a];
      if (!s) continue;
      if (s.quote === "USDT" && usdtUsd === null) {
        missing.push({ venue: v, reason: "no USDT/USD rate" });
        continue;
      }
      const dead = deadVenues.get(v);
      if (dead) {
        missing.push({ venue: v, reason: `unreachable this run: ${dead}` });
        continue;
      }
      try {
        const c = await lastCandle(v, s.sym, target);
        if (!c) {
          missing.push({ venue: v, reason: "no traded candle in window" });
          continue;
        }
        const usd = s.quote === "USDT" ? c.close * usdtUsd! : c.close;
        venues.push({ venue: v, sym: s.sym, candleTime: c.t, closeRaw: c.close, quote: s.quote, usd });
      } catch (e) {
        const reason = (e as Error).message.slice(0, 120);
        if (!(e as any).status) deadVenues.set(v, reason); // network-level failure, not an HTTP answer
        missing.push({ venue: v, reason });
      }
    }
    const enough = venues.length >= MIN_VENUES[a];
    const med = enough ? median(venues.map((q) => q.usd)) : null;
    out[a] = { asset: a, usd1e8: med === null ? null : to1e8(med), median: med, venues, missing };
  }
  return {
    method: "median of last traded 1m candle close (<=300 s old) before block time; USDT quotes x median USDT/USD (kraken, coinbase)",
    targetMinute: target,
    usdtUsd,
    usdtVenues,
    assets: out,
  };
}

/** Recompute a published median from published venue quotes (used by verify). */
export function recomputeMedian(p: AssetPrice, usdtUsd: number | null): number | null {
  if (p.venues.length < MIN_VENUES[p.asset]) return null;
  return median(p.venues.map((q) => (q.quote === "USDT" ? q.closeRaw * (usdtUsd as number) : q.closeRaw)));
}

export { lastCandle };
