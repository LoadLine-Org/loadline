// Shared shapes for market adapters.
//
// Design rule: every published number is either
//   (a) a raw chain read pinned to the snapshot block (verify re-reads and diffs it), or
//   (b) a pure function of published inputs (verify recomputes and diffs it).
// Adapters therefore split into `read` (chain I/O) and pure functions
// (`value`, `checks`) that take only published data.

import type { Reader } from "../lib/chain.ts";
import type { LiquidationSpec } from "../engine/liquidations.ts";

export type MarketId = "zest-v2" | "zest-v1" | "granite-usdcx" | "granite-aeusdc" | "arkadiko-v2";

/** Amounts are decimal strings of integers in the token's base units. */
export type Amounts = Record<string, string>;

export type Position = {
  account: string;
  /** Collateral by asset key, base units, as read at the block. */
  collateral: Amounts;
  /** Debt by asset key, base units, accrued to the block (what the borrower owes now). */
  debt: Amounts;
  /** The stored quantity each debt reconciles on (Zest v2 scaled debt, Zest v1 principal, Granite shares, Arkadiko debt). */
  debtStored: Amounts;
  /** Other raw fields the pure functions need (mask, e-mode, flags, block numbers). */
  meta: Record<string, string | number | boolean | null>;
};

/** Reference prices the monitor uses, USD × 1e8, as decimal strings. */
export type PriceVector = { BTC: string; STX: string; USDC: string };

export type HealthValue = {
  /** Normalised health: 1.0 is the liquidation line; below 1 (Zest v2: at or below) is liquidatable. */
  h: number | null;
  /** The protocol's own metric and threshold, for display. */
  metric: string;
  value: string | null;
  threshold: string;
  liquidatable: boolean;
  collUsd: string; // USD × 1e8
  debtUsd: string; // USD × 1e8
};

export type Derived = {
  collUsd: string;
  debtUsd: string;
  metric: string;
  value: string | null;
  threshold: string;
  /** Health at the reference price. */
  h: number | null;
  /** Band across the price-uncertainty corners (pull-oracle markets); equal to h when exact. */
  hLow: number | null;
  hHigh: number | null;
  /** yes / no, or "band" when the uncertainty band straddles the liquidation line. */
  liquidatable: "yes" | "no" | "band" | "n/a";
  /** Below the dust floor: counted in totals, excluded from risk lists. */
  dust: boolean;
};

export type CheckStatus = "OK" | "WARN" | "FAIL";

export type ReconCheck = {
  id: string;
  kind: "debt" | "collateral" | "count" | "config";
  label: string;
  asset?: string;
  decimals?: number;
  indexed: string; // sum over indexed positions
  onchain: string; // the contract's own total
  delta: string; // onchain - indexed
  deltaPct: number | null; // |delta| / onchain * 100
  rule: "tolerance" | "lte" | "exact";
  okPct?: number;
  failPct?: number;
  status: CheckStatus;
  note?: string;
  excluded?: { account: string; amount: string; reason: string }[];
};

export type PointerResult = {
  label: string;
  read: string; // human description of the read, e.g. "SP1A27….v0-market-vault.get-impl()"
  expected: string;
  actual: string;
  match: boolean;
};

export type CandidateResult = {
  contract: string;
  meaning: string;
  effect: "pending" | "unverified" | "info";
  deployed: boolean;
};

export type LiquidationPath = {
  status: "LIVE" | "UNPROVEN" | "BLOCKED";
  summary: string;
  evidence: Record<string, unknown>;
};

export type ReadOut = {
  positions: Position[];
  /** On-chain totals and any per-asset reference values used by `checks`. */
  onchain: Record<string, string>;
  /** Protocol parameters read at the block and used by `value` (thresholds, indices, ratios, on-chain prices). */
  params: Record<string, any>;
  discovery: Record<string, unknown>;
};

export type BandPct = Partial<Record<keyof PriceVector, number>>;

export type MarketConfig = {
  id: MarketId;
  name: string;
  protocol: string;
  /** The protocol's price path, in words, and whether the monitor's price equals it. */
  priceBasis: { protocol: string; monitor: string; exact: boolean };
  dustUsd: number;
  tolerances: {
    debt: { okPct: number; failPct: number };
    collateral: { okPct: number; failPct: number };
  };
  generation: {
    id: string;
    activationBlock: number;
    evidence: string[];
    contracts: Record<string, string>;
  };
  [k: string]: any;
};

export type Adapter = {
  id: MarketId;
  read(r: Reader, cfg: MarketConfig, ctx: ReadContext): Promise<ReadOut>;
  /** Pure: health and USD values of one position at a price vector. */
  value(p: Position, params: Record<string, any>, px: PriceVector): HealthValue;
  /** Pure: reconciliation checks from positions and on-chain totals. */
  checks(positions: Position[], onchain: Record<string, string>, params: Record<string, any>, cfg: MarketConfig): ReconCheck[];
  /** Which reference-price legs are uncertain for this market (empty when the monitor's price is exact). */
  bandPct(cfg: MarketConfig): BandPct;
  pointers(r: Reader, cfg: MarketConfig): Promise<PointerResult[]>;
  liquidationPath(r: Reader, cfg: MarketConfig, out: ReadOut, ctx: ReadContext): Promise<LiquidationPath>;
  /** Which transactions are liquidations, and how their token movements read. */
  liquidationSpec(cfg: MarketConfig): LiquidationSpec;
  /** Optional: a second forced-deleveraging path read the same way (Arkadiko redemptions). */
  redemptionSpec?(cfg: MarketConfig): LiquidationSpec;
  /** Optional, pure: market-specific panels computed from published data only (recomputed by verify). */
  extras?(positions: Position[], params: Record<string, any>, px: PriceVector | null): Record<string, unknown>;
  /** Pure: USD (1e8) of a token amount (asset = FT id `contract::name`, or `STX`) at the snapshot's prices; null if unpriced. */
  assetUsd(asset: string, amount: string, params: Record<string, any>, px: PriceVector, cfg: MarketConfig): bigint | null;
};

export type ReadContext = {
  cacheDir: string;
  /** When set, discovery must use exactly these accounts (verify re-reading a published snapshot). */
  accounts?: string[];
  /** Zest v1 verify: published zToken holders that do not list the reserve, by symbol. */
  unlisted?: Record<string, string[]>;
  log: (msg: string) => void;
};
