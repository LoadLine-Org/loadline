// Per-market state machine: VERIFIED / PENDING / UNVERIFIED.
//
//   UNVERIFIED  when any of: a live-contract pointer differs from the configured
//               generation; a candidate whose deploy is its activation appears;
//               a reconciliation check FAILs; the snapshot errors.
//               Health, liquidation signals and per-position risk are withheld;
//               balances are published only if reconciliation still passes.
//   PENDING     no UNVERIFIED cause, but a migration is in flight (a candidate
//               deployed, or a relevant governance proposal not yet executed).
//               Numbers are published with a banner.
//   VERIFIED    otherwise.
//
// Leaving UNVERIFIED needs the config to match the chain again *and* two
// consecutive passing runs, so one lucky read cannot re-publish numbers.

import type { PendingItem } from "./migration.ts";

export type State = "VERIFIED" | "PENDING" | "UNVERIFIED";

export type MarketState = {
  state: State;
  since: { height: number; time: number };
  reasons: string[];
  pending: PendingItem[];
  passesSinceUnverified: number;
  lastVerified: { height: number; indexBlockHash: string; time: number; snapshot: string } | null;
};

export type Inputs = {
  height: number;
  time: number;
  critical: string[]; // causes for UNVERIFIED
  pending: PendingItem[];
};

export const REQUIRED_PASSES = 2;

export function decide(prev: MarketState | undefined, inp: Inputs): MarketState {
  const at = { height: inp.height, time: inp.time };
  if (inp.critical.length) {
    return {
      state: "UNVERIFIED",
      since: prev?.state === "UNVERIFIED" ? prev.since : at,
      reasons: inp.critical,
      pending: inp.pending,
      passesSinceUnverified: 0,
      lastVerified: prev?.lastVerified ?? null,
    };
  }
  if (prev?.state === "UNVERIFIED") {
    const passes = prev.passesSinceUnverified + 1;
    if (passes < REQUIRED_PASSES) {
      return {
        ...prev,
        reasons: [`re-verifying: ${passes}/${REQUIRED_PASSES} consecutive passing runs`],
        pending: inp.pending,
        passesSinceUnverified: passes,
      };
    }
  }
  const state: State = inp.pending.length ? "PENDING" : "VERIFIED";
  return {
    state,
    since: prev && prev.state === state ? prev.since : at,
    reasons: inp.pending.map((p) => p.summary),
    pending: inp.pending,
    passesSinceUnverified: 0,
    lastVerified: prev?.lastVerified ?? null,
  };
}

/** Numbers that depend on the health formula or price path are published only in these states. */
export const publishesRisk = (s: State) => s === "VERIFIED" || s === "PENDING";
