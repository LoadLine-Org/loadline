# The LoadLine dataset

Everything the site shows is published as static files under `/data/`. You can mirror them, check them against `index.json`, and re-derive them from the chain with `npm run verify`. The data is free to use; the code that produces it is MIT.

## Files

| Path | What it is | Changes |
|---|---|---|
| `index.json` | Every published file with its size and SHA-256, the dataset schema version, and the deprecation list | rewritten after each run |
| `latest.json` | Current state and summary of each market, and which snapshot each figure comes from | rewritten daily |
| `snapshots/<height>/<market>.json` | One market at one Stacks block: every position, check, parameter, pointer, and liquidation | **immutable** |
| `snapshots/<height>/csv/<market>.positions.csv` | One row per position: USD values, health band, liquidatable, dust | immutable |
| `snapshots/<height>/csv/<market>.holdings.csv` | Long format: one row per position, side (collateral, debt, stored debt) and asset, in base units | immutable |
| `snapshots/<height>/csv/<market>.checks.csv` | Every reconciliation check | immutable |
| `snapshots/<height>/csv/<market>.liquidations.csv` | Every liquidation (and Arkadiko redemption) in the 30-day window, per token movement | immutable |
| `oracle/…` | The 90-day oracle record ([ORACLE.md](ORACLE.md)) | rewritten daily |
| `state.json`, `transitions.jsonl`, `runs.jsonl` | State machine, its history, one line per run | appended/rewritten daily |

The CSV files are a pure function of the snapshot JSON beside them (`src/engine/dataset.ts`). `verify` regenerates them and compares them byte for byte.

## Units

- **Token amounts:** decimal strings in the token's base units (no decimals applied), e.g. `"140104912"` sBTC = 1.40104912 sBTC.
- **USD:** decimal strings of dollars × 10⁸ (`collUsd`, `debtUsd`, `…Usd`), e.g. `"1167331000000"` = $11,673.31.
- **Health:** `h`, `hLow`, `hHigh` are numbers normalised so 1.0 is the protocol's liquidation line, rounded to 6 decimals.
- **Times:** Unix seconds (Stacks block time). **Heights:** Stacks block heights.
- **Assets** in liquidation records are Stacks fungible-token identifiers (`contract::name`) or `STX`.

JSON Schemas (draft 2020-12) are in [`schema/v1/`](../schema/v1/): `index`, `latest`, `snapshot` and `oracle-summary`. The test suite validates every published file against them.

## Versioning and deprecation

- The `schema` field in every file is the dataset's **major version**, currently `1`.
- **Within a major version, changes are additive only.** A field may be added. An existing field keeps its name, type, unit and meaning.
- **Retiring a field** within a major version: it is listed in `index.json` → `deprecations` with the date and a `removeAfter` date at least **90 days** later, and marked `deprecated` in the JSON Schema. It keeps being published until that date. It is then removed only in the next major version.
- **A breaking change** means a new major version. The new version is published at `/data/v2/…` alongside v1 for at least 90 days, with v1 still produced daily. The change is announced in `index.json` and in this file.
- **Published snapshots are never edited.** A snapshot keeps the schema version it was written with. If one turns out to be wrong, the correction is a new snapshot, and the error is recorded here.

## Growth

One snapshot is taken per day. The measured size is in `index.json` → `growth.bytesPerSnapshotRecent` (JSON plus CSV, uncompressed): 3.4 MB per day on 2026-09-24, so about 1.2 GB a year. The server gzips responses; measured on the snapshot at block 9,049,309, that brings the JSON to 17% of its size. `oracle/` and the other rewritten files don't grow.

## Mirroring

```sh
curl -s https://loadline.0xo.in/data/index.json > index.json
# then fetch any listed path and check it:
curl -s https://loadline.0xo.in/data/snapshots/<height>/<market>.json | shasum -a 256
```
