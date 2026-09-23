# LoadLine

A read-only index of every borrower position on five Stacks lending markets, reconciled against each protocol's own on-chain totals. Every published number can be re-checked by anyone, with one command and no API key.

It also keeps a 90-day record of the price oracles those markets depend on.

## The five markets

| Market | Positions come from | Reconciled against |
|---|---|---|
| Zest v2 | `v0-market-vault` account registry | vault `get-principal-scaled`; collateral held by `v0-market-vault` |
| Zest v1 | `users-id` in every `pool-borrow` version, plus zToken holders | reserve `total-borrows-variable`; zToken `get-total-supply` |
| Granite USDCx | every principal in `state-v1`'s transaction history | `total-debt-shares`; sBTC held by `state-v1` |
| Granite aeUSDC | same | same |
| Arkadiko v2 | the `vaults-sorted` linked lists | `total-vaults`; `vaults-data` total debt; tokens held by `vaults-pool-active` |

Each snapshot reads all five markets at one pinned Stacks block. For every market it records:
- **the live-contract pointer** it read, and the block the figures were verified at;
- **every reconciliation check:** Σ positions against the contract's own total, with the delta;
- **health per position**, and whether the market's liquidation path is `LIVE`, `UNPROVEN` or `BLOCKED`.

## Check the numbers yourself

```sh
git clone https://github.com/LoadLine-Org/loadline && cd loadline
npm ci
npm run verify                                   # the snapshot committed in data/public
npm run verify -- --from https://<site>/data     # the live site's latest snapshot
```

You need Node.js 22.18 or newer, and no API key. For each market, `verify`:
1. confirms the pinned block is canonical;
2. re-reads every position, on-chain total, protocol parameter and live-contract pointer **at that block**;
3. recomputes every reconciliation check, health figure and summary;
4. re-fetches the exchange candles behind the reference prices.

It exits non-zero if any published number differs. See [docs/VERIFY.md](docs/VERIFY.md).

## Run it

```sh
npm run snapshot   # all five markets at (tip − 6 blocks) → data/public/
npm run oracle     # 90-day oracle-health record → data/public/oracle/
npm test           # unit tests (state machine, bands, checks)
```

Requests are throttled on purpose. Reads are batched (about 180 batch calls for a full run), Hiro is spaced at least 1.3 s apart, and transaction histories are cached and fetched incrementally.

## What the numbers mean

- **Health on pull-oracle markets is a band.** Zest v1, Zest v2 and Granite verify a Pyth Lazer price inside each transaction and store no price between transactions. LoadLine uses a multi-exchange median, widened by the largest Lazer-vs-reference gap seen in successful transactions: BTC ±0.60%, STX ±1.05%. A position whose band straddles the liquidation line is reported as `band`. Arkadiko stores its price on-chain, so its health is exact.
- **Liquidatable is not liquidated.** On 2026-09-23:
  - Arkadiko's liquidation pool held 0.0016 USDA, enough for 0 of 116 vaults.
  - Zest v2's current market had 0 successful liquidations in 181 attempts.
- **Dust** (debt under $10) is counted in every total but left out of risk counts. **Bad debt** (debt with no collateral) is reported separately.
- **One known Zest v1 orphan record** (`SP174BBV…`, 1.40 sBTC principal) is left out of the reconciliation sum, because the reserve total leaves it out too. It is listed on its own.
- **USD totals use reference prices.** Token amounts are exact chain reads; their USD value is not.

## Safety: numbers are withheld rather than wrong

Each market is `VERIFIED`, `PENDING` or `UNVERIFIED`.
- **UNVERIFIED:** a live-contract pointer changed, a contract whose deployment activates it appeared, or a reconciliation check failed. Health and risk figures are withheld, and the last verified snapshot stays up, marked with its block.
- **Returning to VERIFIED** takes two consecutive clean runs. See [docs/METHOD.md](docs/METHOD.md).

## Caveats

- **The USDC band (±0.25%) is an estimate.** The BTC and STX bands are measured; the USDC one is not yet.
- **`verify` does not recount liquidation-path counts or governance-watch results.** Both are published with transaction ids so they can be checked on an explorer, but `verify` does not recompute them.
- **Lazer prices are not published.** The oracle record carries Lazer payload ages and transaction outcomes only, pending a licence answer from Pyth.
- **Dependence on a third-party read API:** chain reads go to the free stxer batch API, with the Hiro node API as fallback. Both are third parties with no SLA.
- **The name "LoadLine" is used by unrelated products,** including an AI risk-monitoring tool. This project is not affiliated with them.

## Layout

```
config/markets/*.json   live contracts per market, tolerances, candidates, governance watch
config/oracle.json      oracle-record thresholds
src/lib/                chain reads pinned to one block, exchange candles, throttled HTTP
src/markets/            one adapter per protocol: chain reads + pure health/reconciliation functions
src/engine/             snapshot run, state machine, migration watch, transaction scans
src/oracle/             90-day oracle-health record
src/verify/             the verify command
data/public/            published snapshots and oracle record
```

## Licence

MIT
