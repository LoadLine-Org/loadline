# Method: discovery, reconciliation, health, migration watch, state machine

Contract IDs and every threshold below live in `config/markets/*.json`. That file is the single source; this document explains it.

## One block per run

Every run pins one Stacks block, 6 blocks behind the tip, and reads everything at that block's `index_block_hash`: positions, totals, parameters and pointers. Every figure in a snapshot therefore describes the same instant, and `verify` can re-read that same instant later.

## Discovery

| Market | Source | Completeness argument |
|---|---|---|
| Zest v2 | `v0-market-vault` registry ids `0 … get-nr`, then `get-position(account, MAX-U64)` for every non-zero mask | The registry is on-chain and gap-free; the count check compares entries read with `get-nr` |
| Zest v1 | Union of `users-id` over all 8 `pool-borrow` versions, plus current holders of all 10 zTokens (candidates only), then `get-user-assets` at the block | Debt and supplied principal both reconcile exactly. The holder lists were added after finding 3 stSTX suppliers (978 stSTX) and 1 STX borrower missing from every registry |
| Granite (both) | Every principal in `state-v1`'s transaction history: sender, top-level contract, all call arguments | Σ debt shares = `total-debt-shares` and Σ sBTC = sBTC held by `state-v1`, both exactly |
| Arkadiko | Each token's `vaults-sorted` linked list from `first-owner` | Walked count = `total-vaults` |

## Reconciliation tolerances

The tolerances are set about 10× above the noise observed while building the index.

| Check | OK | WARN | FAIL (→ UNVERIFIED) |
|---|---|---|---|
| Debt: Σ positions vs on-chain total | ≤ 0.05% (Zest v1 ≤ 0.1%) | up to 0.5% | > 0.5% |
| Collateral: Σ positions vs custody balance | ≤ 0.1% | up to 1% | > 1% |
| Arkadiko collateral | Σ vaults ≤ pool balance | | Σ vaults > pool balance |
| Counts (Zest v2 registry, Arkadiko vaults) | exact | | any difference |

What the checks measure:
- **Zest v2 debt:** reconciled on scaled debt (`get-principal-scaled`). A few base units of rounding residue are normal: 1–5 units on 2026-09-23.
- **Zest v1 debt:** reconciled on principal (`total-borrows-variable`). `reconciliationExclusions` lists the one known orphan record the reserve total does not include.
- **Zest v1 collateral:** reconciled on zToken principal (`get-principal-balance` vs `get-total-supply`). Health uses the interest-bearing `get-balance`.
- **Arkadiko collateral:** only an upper bound. The pool can hold more than the vaults' collateral: on 2026-09-23 it held 347,190 wSTX against 116,676 wSTX in vaults.

## Health

Each adapter mirrors its protocol's own liquidation check in integer arithmetic. The rounding direction matches the Clarity source.

| Market | Liquidatable when | Price the protocol uses | Price used here |
|---|---|---|---|
| Zest v2 | `LTV = debt_usd × 1e4 / coll_usd ≥ LTV-LIQ-PARTIAL` of the egroup that `v0-egroup.resolve(mask)` returns; only collateral enabled in `v0-assets.get-bitmap` counts | Pyth Lazer inside the tx (120 s max age); DIA for USDh | Reference median ± band. DIA, stSTX/stBTC ratios and liquidity indices are read on-chain; the next liquidity index is computed to the block time exactly as `accrue` would |
| Zest v1 | `HF = Σ coll_usd × LT / Σ debt_usd < 1e8`; the e-mode LT applies when the user's e-mode matches the asset's; only reserves with collateral enabled and the user's `use-as-collateral` flag count | Lazer via a per-tx session (360 s); stSTX = STX × ratio; fixed-price oracles for stables and legacy assets | Reference median ± band; every fixed price read from the protocol's own oracle contract (e.g. USDA at 0.943879, set in 2024) |
| Granite | `health = Σ ⌊coll_value × liquidation-ltv⌋ × 1e8 / debt_value < 1e8` | Lazer feed 1 (sBTC), feed 7 (USDC) for the debt, including aeUSDC debt | Reference median ± band. Interest is accrued to the block with the protocol's own `accrue-interest` read-only, because `account-health` does not accrue and the stored figure can be a day old |
| Arkadiko | `ratio = coll × price × 100 / (debt + stability fee) / (decimals / 100) < liquidation-ratio` | Stored `arkadiko-oracle-v2-3` price, with no staleness check | The same stored price: exact |

A position's `h` is normalised so that 1.0 is the liquidation line. `hLow`/`hHigh` are the minimum and maximum over every corner of the price band. `liquidatable` is `yes`, `no`, or `band` when the corners disagree.

## Liquidation path

`liquidatable` asks whether the rule is met. `liquidation path` asks whether a liquidation can actually execute, judged from on-chain evidence:
- **BLOCKED:** the path is disabled or cannot work. Examples: liquidations paused, or Arkadiko's pool holding less USDA than any vault's debt.
- **UNPROVEN:** enabled, but no successful liquidation since the current contracts went live.
- **LIVE:** at least one success since activation. The last one is shown.

## Migration watch

Every run does three things:
1. **Pointer reads.** It reads each protocol's authoritative "what is live" values: Zest v2 `get-impl`, Zest v1 `is-approved-contract` and the reserve oracles, Granite `is-allowed-contract` and `governance`, and the Arkadiko DAO registry. It compares them with the configured generation.
2. **Candidate probe.** It probes the next-version contract names in one batched read. Each candidate carries an effect:
   - Zest v2 market: **pending**, since switches have followed the deploy by 4–35 minutes.
   - Zest v1 `v0-transfer-v1-1`: **unverified**. It is already approved, so its deploy *is* its activation.
   - Others: **info**.
3. **Governance watch.** It re-derives the current governance contract (Granite aeUSDC has moved it twice) and scans its transactions. A migration-relevant proposal inside the protocol's window that hasn't been executed yet makes the market PENDING.

Replay check (2026-09-23): with today's config pinned at block 8,700,000 (2026-08-04), Zest v2 (`v0-5-market` live then), Zest v1 (`borrow-helper-v2-1-8` not approved) and both Granite markets (old contract sets and governance) all went UNVERIFIED, each for the correct pointer. Arkadiko, unchanged since then, stayed VERIFIED. Replaying history with the *right* numbers needs a config per past generation. Until one exists, the pipeline refuses to read a generation it has no config for, and withholds the numbers.

## State machine

```
            pending migration (candidate deployed / proposal in flight)
VERIFIED ────────────────────────────────────────▶ PENDING   (numbers published, banner)
   ▲  ▲                                                │
   │  └────────────── proposal executed/expired ◀─────┘
   │
   │ 2 consecutive clean runs, config matches chain
   │
UNVERIFIED ◀── pointer changed · activating contract deployed · reconciliation FAIL · read error
   (health and risk withheld; balances published only if they still reconcile;
    otherwise the last verified snapshot stays up, marked "as of block N")
```

Withheld snapshots are written to `data/quarantine/` for the operator. They are never written to `data/public/`.
