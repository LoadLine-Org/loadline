import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, REQUIRED_PASSES, type MarketState } from "../src/engine/state.ts";

const ok = { height: 1, time: 1, critical: [], pending: [] };

test("clean first run is VERIFIED", () => {
  assert.equal(decide(undefined, ok).state, "VERIFIED");
});

test("any critical cause makes a market UNVERIFIED", () => {
  const s = decide(undefined, { ...ok, critical: ["live-contract pointer changed"] });
  assert.equal(s.state, "UNVERIFIED");
  assert.deepEqual(s.reasons, ["live-contract pointer changed"]);
});

test("pending migration without a critical cause is PENDING", () => {
  const s = decide(undefined, { ...ok, pending: [{ kind: "candidate-deployed", summary: "v0-9-market deployed" }] });
  assert.equal(s.state, "PENDING");
});

test(`leaving UNVERIFIED needs ${REQUIRED_PASSES} consecutive clean runs`, () => {
  let s: MarketState = decide(undefined, { ...ok, critical: ["x"] });
  s = decide(s, { ...ok, height: 2 });
  assert.equal(s.state, "UNVERIFIED", "one clean run is not enough");
  s = decide(s, { ...ok, height: 3 });
  assert.equal(s.state, "VERIFIED");
});

test("a critical cause during re-verification resets the count", () => {
  let s: MarketState = decide(undefined, { ...ok, critical: ["x"] });
  s = decide(s, ok);
  s = decide(s, { ...ok, critical: ["y"] });
  s = decide(s, ok);
  assert.equal(s.state, "UNVERIFIED");
  assert.equal(s.passesSinceUnverified, 1);
});

test("UNVERIFIED keeps its original 'since' block while it persists", () => {
  let s: MarketState = decide(undefined, { ...ok, height: 10, critical: ["x"] });
  s = decide(s, { ...ok, height: 11, critical: ["x"] });
  assert.equal(s.since.height, 10);
});
