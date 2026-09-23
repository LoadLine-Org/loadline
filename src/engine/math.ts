// Integer helpers mirroring Clarity's uint arithmetic, plus the shared
// reconciliation and band logic.

import type { BandPct, CheckStatus, Derived, HealthValue, Position, PriceVector, ReconCheck } from "../markets/types.ts";

export const B = (x: string | number | bigint | null | undefined): bigint => (x === null || x === undefined || x === "" ? 0n : BigInt(x));
export const divDown = (a: bigint, b: bigint): bigint => a / b;
export const divUp = (a: bigint, b: bigint): bigint => (a + b - 1n) / b;
export const pow10 = (n: number | bigint): bigint => 10n ** BigInt(n);

/** Percentage |a-b|/b as a float, null when b is zero and a is non-zero. */
export function pctDelta(indexed: bigint, onchain: bigint): number | null {
  const d = onchain - indexed;
  if (onchain === 0n) return d === 0n ? 0 : null;
  const ad = d < 0n ? -d : d;
  // Keep precision for tiny deltas: scale by 1e12 before converting.
  return Number((ad * 10n ** 12n) / onchain) / 1e10;
}

export function toleranceCheck(
  base: Omit<ReconCheck, "delta" | "deltaPct" | "status" | "rule" | "okPct" | "failPct">,
  tol: { okPct: number; failPct: number },
): ReconCheck {
  const i = B(base.indexed);
  const o = B(base.onchain);
  const p = pctDelta(i, o);
  let status: CheckStatus;
  if (p === null) status = "FAIL";
  else if (p <= tol.okPct) status = "OK";
  else if (p <= tol.failPct) status = "WARN";
  else status = "FAIL";
  return { ...base, delta: (o - i).toString(), deltaPct: p, rule: "tolerance", okPct: tol.okPct, failPct: tol.failPct, status };
}

/** indexed must not exceed onchain (the contract may hold a surplus). */
export function lteCheck(base: Omit<ReconCheck, "delta" | "deltaPct" | "status" | "rule">): ReconCheck {
  const i = B(base.indexed);
  const o = B(base.onchain);
  return { ...base, delta: (o - i).toString(), deltaPct: pctDelta(i, o), rule: "lte", status: i <= o ? "OK" : "FAIL" };
}

export function exactCheck(base: Omit<ReconCheck, "delta" | "deltaPct" | "status" | "rule">, warnWithin = 0n): ReconCheck {
  const i = B(base.indexed);
  const o = B(base.onchain);
  const d = o - i;
  const ad = d < 0n ? -d : d;
  return { ...base, delta: d.toString(), deltaPct: pctDelta(i, o), rule: "exact", status: ad === 0n ? "OK" : ad <= warnWithin ? "WARN" : "FAIL" };
}

export function sumBy(positions: Position[], pick: (p: Position) => string | undefined): bigint {
  let s = 0n;
  for (const p of positions) s += B(pick(p));
  return s;
}

/** Price vector with each uncertain leg moved by ±pct, all 2^k corners. */
export function corners(px: PriceVector, band: BandPct): PriceVector[] {
  const legs = (Object.keys(band) as (keyof PriceVector)[]).filter((k) => (band[k] ?? 0) > 0);
  const out: PriceVector[] = [];
  for (let m = 0; m < 1 << legs.length; m++) {
    const v = { ...px };
    legs.forEach((k, i) => {
      const f = (m >> i) & 1 ? 1 + band[k]! / 100 : 1 - band[k]! / 100;
      // f expressed in parts per 1e6 to stay in integers
      v[k] = ((B(px[k]) * BigInt(Math.round(f * 1e6))) / 1_000_000n).toString();
    });
    out.push(v);
  }
  return out;
}

export function derive(
  valueAt: (px: PriceVector) => HealthValue,
  px: PriceVector,
  band: BandPct,
  dustUsd: number,
): Derived {
  const point = valueAt(px);
  let hLow = point.h;
  let hHigh = point.h;
  let anyLiq = point.liquidatable;
  let allLiq = point.liquidatable;
  const cs = corners(px, band);
  if (cs.length > 1) {
    for (const c of cs) {
      const v = valueAt(c);
      if (v.h !== null) {
        hLow = hLow === null ? v.h : Math.min(hLow, v.h);
        hHigh = hHigh === null ? v.h : Math.max(hHigh, v.h);
      }
      anyLiq ||= v.liquidatable;
      allLiq &&= v.liquidatable;
    }
  }
  const noDebt = B(point.debtUsd) === 0n;
  const liquidatable: Derived["liquidatable"] = noDebt ? "n/a" : allLiq ? "yes" : anyLiq ? "band" : "no";
  return {
    collUsd: point.collUsd,
    debtUsd: point.debtUsd,
    metric: point.metric,
    value: point.value,
    threshold: point.threshold,
    h: round6(point.h),
    hLow: round6(hLow),
    hHigh: round6(hHigh),
    liquidatable,
    dust: !noDebt && B(point.debtUsd) < BigInt(Math.round(dustUsd * 1e8)),
  };
}

export const round6 = (x: number | null): number | null => (x === null || !Number.isFinite(x) ? null : Math.round(x * 1e6) / 1e6);

/** Float ratio of two bigints (for display-only health figures). */
export function ratio(a: bigint, b: bigint): number | null {
  if (b === 0n) return null;
  return Number((a * 10n ** 12n) / b) / 1e12;
}

export const usd = (x: bigint | string): string => (Number(B(x)) / 1e8).toLocaleString("en-US", { maximumFractionDigits: 2 });
