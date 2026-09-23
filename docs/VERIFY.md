# Verifying the published numbers

`verify` needs a clean clone, Node.js 22.18 or newer, and network access. No API key. It trusts nothing from the publisher except the published files it is checking.

```sh
npm ci
npm run verify                                   # data/public in this checkout
npm run verify -- --from https://<site>/data     # the live site
npm run verify -- --height 9049309               # a specific past snapshot
npm run verify -- --markets zest-v2,granite-usdcx
npm run verify -- --skip-prices                  # skip the exchange-candle re-fetch
```

## What it checks, per market

| Step | What is compared | How |
|---|---|---|
| block | the snapshot's block | Its height, `index_block_hash` and canonical status, from the Hiro API |
| chain | every position (all fields), every on-chain total, every protocol parameter (thresholds, interest indices, LST ratios, on-chain prices), every live-contract pointer read, every next-version candidate probe | Re-read from the chain **at the snapshot's pinned block** and diffed field by field |
| recon | every reconciliation check (Σ positions vs the contract's own total, delta, OK/WARN/FAIL) | Recomputed from the published positions and totals |
| health | every position's USD values, health, band, liquidatable and dust flags | Recomputed from the published position, parameters and reference prices, with the same pure function the publisher used |
| summary | counts, USD totals, bad debt, risk buckets, nearest-to-liquidation list | Recomputed from the published positions |
| prices | every exchange candle behind each reference median | Re-fetched from the exchange's public candle API, and the median recomputed |

## Reads and trust

- **Chain reads** go to `api.stxer.xyz` (batched, keyless), falling back to the Stacks node RPC at `api.hiro.so`. Every batch response carries the block it was evaluated at, and verify rejects any response not evaluated at the pinned block. Hiro reads send the block without a `0x` prefix, because Hiro silently ignores a prefixed tip and serves current state.
- **Discovery lists for re-reading** come from the published snapshot, but completeness does not rest on them:
  - Granite: the candidate accounts are published. Exact equality of Σ debt shares with `total-debt-shares`, and of Σ collateral with the sBTC held by `state-v1`, shows no position was left out (every amount is non-negative).
  - Zest v1: verify rebuilds the on-chain `users-id` union at the block itself. Only the handful of extra accounts found through zToken holder lists (which are not pinned to a block) come from the snapshot.
  - Zest v2 and Arkadiko: discovery is fully on-chain.
- **Prices:** Kraken serves only the last 12 hours of 1-minute candles, so older snapshots re-check the other venues and report Kraken as not re-checkable.
- **Code version:** each snapshot records a fingerprint of the code and config that produced it. If yours differs, verify says so. A difference in logic would show up as FAIL lines, not silently.

## Not covered by verify

- **Liquidation-path evidence** (attempt and success counts) and **governance-watch results** come from transaction history. They are published with transaction ids, so each can be checked on an explorer, but verify does not recount them.
- **Health is only as exact as the reference price.** For pull-oracle markets it is a band by design (see the README).

## Example output (2026-09-23, block 9,049,309)

```
Zest v1  (snapshots/9049309/zest-v1.json, block 9049309, state VERIFIED)
  PASS  block    height 9049309 index_block_hash e09ec7824541c05d… canonical=true
  PASS  chain    1584 positions re-read at block 9049309: 0 missing, 0 extra, all fields identical
  PASS  chain    20 on-chain totals identical
  PASS  chain    protocol parameters (thresholds, indices, ratios, on-chain prices) identical
  PASS  chain    7 live-contract pointer reads identical (7/7 match the configured generation)
  PASS  chain    6 next-version candidates identical (202 s, 130 batch calls)
  PASS  recon    17 reconciliation checks recomputed from published positions identical: debt:stSTX Δ0 OK, …
  PASS  health   1584 positions: USD values, health, band, liquidatable and dust flags identical
  PASS  summary  market summary identical
  PASS  prices   19 exchange candles re-fetched and identical; medians recomputed identically
…
50 passed, 0 failed, 0 skipped
RESULT: PASS
```

A tampered file fails. In a test against the earlier snapshot at block 9,047,469, shaving 1% off one Granite borrower's debt shares in the published JSON gives:

```
  FAIL  chain    38 positions re-read at block 9047469: 0 missing, 0 extra, SP1HZ88S…debtStored.shares: published "166589713852" != recomputed "168272438235"
  FAIL  recon    … debt:shares Δ1682724383 WARN
RESULT: FAIL
```
