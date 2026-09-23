import { test } from "node:test";
import assert from "node:assert/strict";
import { corners, derive, divUp, pctDelta, toleranceCheck, lteCheck, exactCheck } from "../src/engine/math.ts";
import type { HealthValue, PriceVector } from "../src/markets/types.ts";

const px: PriceVector = { BTC: "8000000000000", STX: "30000000", USDC: "100000000" };

test("divUp rounds up like Clarity's div-up", () => {
  assert.equal(divUp(10n, 3n), 4n);
  assert.equal(divUp(9n, 3n), 3n);
});

test("band corners: 2^k vectors for k uncertain legs", () => {
  assert.equal(corners(px, { BTC: 0.6, STX: 1.05 }).length, 4);
  assert.equal(corners(px, {}).length, 1);
  const c = corners(px, { BTC: 1 });
  assert.deepEqual(c.map((v) => v.BTC).sort(), ["7920000000000", "8080000000000"]);
});

// A one-collateral (BTC) / one-debt (USD) position with liquidation at h = 1.
const simple = (collBtc: number, debtUsd: number) => (x: PriceVector): HealthValue => {
  const coll = collBtc * Number(x.BTC);
  const debt = Math.round(debtUsd * 1e8);
  const h = coll * 0.65 / debt;
  return { h, metric: "t", value: null, threshold: "1", liquidatable: h < 1, collUsd: String(Math.round(coll)), debtUsd: String(debt) };
};

test("a position straddling the line is 'band', not yes or no", () => {
  // h = 1.003 at the reference; ±0.6% on BTC crosses 1.0
  const d = derive(simple(1, 80000 * 0.65 / 1.003), px, { BTC: 0.6 }, 10);
  assert.equal(d.liquidatable, "band");
  assert.ok(d.hLow! < 1 && d.hHigh! > 1);
});

test("exact-price markets have a zero-width band", () => {
  const d = derive(simple(1, 30000), px, {}, 10);
  assert.equal(d.hLow, d.h);
  assert.equal(d.hHigh, d.h);
  assert.equal(d.liquidatable, "no");
});

test("dust flag uses the USD floor", () => {
  assert.equal(derive(simple(1, 5), px, {}, 10).dust, true);
  assert.equal(derive(simple(1, 50), px, {}, 10).dust, false);
});

test("tolerance, lte and exact checks", () => {
  const base = { id: "x", kind: "debt" as const, label: "x" };
  assert.equal(toleranceCheck({ ...base, indexed: "1000000", onchain: "1000000" }, { okPct: 0.05, failPct: 0.5 }).status, "OK");
  assert.equal(toleranceCheck({ ...base, indexed: "999000", onchain: "1000000" }, { okPct: 0.05, failPct: 0.5 }).status, "WARN");
  assert.equal(toleranceCheck({ ...base, indexed: "990000", onchain: "1000000" }, { okPct: 0.05, failPct: 0.5 }).status, "FAIL");
  assert.equal(lteCheck({ ...base, indexed: "5", onchain: "9" }).status, "OK");
  assert.equal(lteCheck({ ...base, indexed: "10", onchain: "9" }).status, "FAIL");
  assert.equal(exactCheck({ ...base, indexed: "5", onchain: "6" }).status, "FAIL");
  assert.equal(pctDelta(0n, 0n), 0);
  assert.equal(pctDelta(1n, 0n), null);
});
