# 90-day oracle-health record

`npm run oracle` rebuilds the record for the 90 days ending at a block 6 behind the tip. It writes `data/public/oracle/`. Thresholds live in `config/oracle.json` and are copied into `summary.json`, so every episode can be traced to the rule that produced it.

## Feeds covered

| Feed | How it is observed | Who consumes it |
|---|---|---|
| DIA `BTC/USD`, `STX/USD`, `sBTC/USD`, `stSTX/USD`, `USDh/USD` | Every successful `set-multiple-values` push, decoded from its arguments (key, value, DIA timestamp) | `USDh/USD`: Zest v2 USDH debt (limit 86,400 s) and zUSDH collateral (limit 120 s). The others have no in-scope lending consumer |
| Arkadiko `arkadiko-oracle-v2-3` STX, BTC, stSTX | Every successful `update-price-multi` / `update-price-owner` push | Arkadiko v2 vaults, with **no staleness check** |
| Pyth Lazer, as seen inside consumer transactions | The payload timestamp decoded from each consumer transaction's `price-feeds` argument | Zest v2 (`v0-7`, `v0-8` market, limit 120 s), Zest v1 (`borrow-helper-v2-1-8`, 360 s), Granite USDCx and aeUSDC (300 s) |

**Lazer prices are not published.** Until Pyth / Douro Labs answers the licence question, the record publishes only payload **ages** and transaction **outcomes** for Lazer. It does not publish Lazer price values or deviations computed from them.

The value in force at the start of the window is read on-chain at the window's first block. For Arkadiko that was a price last written on 2026-06-16, nine days before the window opened.

## Reference

- **Per-minute median** of the venues that traded in that minute. A venue's last trade is carried forward for at most 2 minutes.
- **BTC:** Coinbase, Binance and Bybit spot; at least 2 venues.
- **STX:** Binance USDT-M perpetual, Binance, Bybit and KuCoin spot; at least 2 venues.
- **USDT conversion:** USDT-quoted closes are multiplied by Coinbase's hourly USDT-USD candle.
- **Degraded minutes:** a minute with too few venues is marked degraded and is left out of every deviation figure. The count is reported per feed.
- **stSTX** = the STX reference × the on-chain StackingDAO ratio.
  - The ratio is sampled every 2 days and interpolated.
  - StackingDAO moved its read-only mid-window. `data-core-v3` (with `reserve-v1`) answers until then; `data-stx-v2` answers from its initialisation. Where neither answers, the gap is bridged by interpolation. Each sample records its source.
- **Stablecoin keys** are compared with $1.
- **Why not the live 7-venue median:** Gate keeps only 10,000 minutes of history and Kraken 720, and OKX is unreachable from this host. The live snapshot reference and this historical reference therefore differ in venue list.
- **Published:** `reference-1m.csv`, with the venue count per minute.

## Episodes

| Type | Definition |
|---|---|
| silence | A gap between writes of one feed longer than 1 h (DIA) or 3.5 h (Arkadiko). Critical above 6 h |
| frozen | An identical value over N or more writes with advancing timestamps while the reference moved at least X%. DIA BTC/STX: N ≥ 2, X 0.3%. DIA sBTC/stSTX: N ≥ 3, X 0.5%. Arkadiko: N ≥ 3, X 1% |
| deviation | Minutes where the value in force is more than 2% or 5% from the reference; an episode lasts at least 2 minutes and closes only after 30 consecutive minutes back inside the band |
| lazer-stale-burst | 3 or more oracle-error reverts in one consumer, each within 15 minutes of the last |

A Lazer revert is classified from its result code, using each consumer's oracle error codes (read from the contract sources; listed in `config/oracle.json`):
- **`oracle-revert:stale`:** the code is an oracle error and the payload age exceeds the consumer's limit.
- **`oracle-revert:other`:** an oracle code within the limit, such as a monotonic race, a confidence failure or a signature failure.
- **`revert:non-oracle`:** any other failure.

Granite measures age from the previous block time plus a constant. The record uses the including block's time, which can differ by one block.

## Files

| File | One row per |
|---|---|
| `dia-pushes.csv` | DIA push of a tracked key: tx id, block, value, DIA timestamp, write lag, reference, deviation at publish |
| `arkadiko-pushes.csv` | Arkadiko push: tx id, block, value, signed burn block, reference, deviation |
| `lazer-observations.csv` | Lazer-carrying consumer tx: tx id, market, function, sender, payload time, age, limit, headroom, outcome, classification |
| `episodes.csv` / `.json` | Episode, with start and end tx ids |
| `reference-1m.csv` | Minute of the window |
| `summary.json` | Per-feed metrics, current status, standing findings, method and provenance |
