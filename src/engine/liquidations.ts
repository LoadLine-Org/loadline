// Liquidatable vs actually liquidated.
//
// "Actually liquidated" is read from the chain, not inferred: every successful call of the
// market's liquidation function on its entry contract, up to the snapshot block, with the
// debt repaid and collateral seized taken from the transaction's own token events.
// Everything here is deterministic for a given block, so `verify` re-scans and recomputes it.

import type { PriceVector } from "../markets/types.ts";
import { B } from "./math.ts";
import { getTxMoves, scanTxs, type Move } from "./txscan.ts";

export const WINDOW_DAYS = 30;

export type LiquidationSpec = {
  /** Contract whose transactions are liquidation calls. */
  contract: string;
  fns: string[];
  /** A principal counts as "the protocol" when it starts with one of these. */
  protocolPrefixes: string[];
  /** Arkadiko: debt is burned from the liquidation pool, collateral moves to it. */
  mode: "liquidator-pays" | "pool-burns" | "caller-burns";
  /** pool-burns only: the pool contract and the burned token. */
  pool?: string;
  burnAsset?: string;
  /** Only liquidations at or after this block count as "since activation". */
  activationBlock: number;
};

export type Amount = { asset: string; amount: string };

export type LiquidationEvent = {
  txid: string;
  height: number;
  time: number;
  fn: string;
  liquidator: string;
  borrowers: string[];
  debtRepaid: Amount[];
  collateralSeized: Amount[];
};

export type LiquidationRecord = {
  contract: string;
  fns: string[];
  window: { days: number; fromTime: number; toHeight: number };
  /** Successful liquidation calls in the window, oldest first. */
  events: LiquidationEvent[];
  /** Since the configured generation's activation block (all attempts, for context). */
  sinceActivation: { fromHeight: number; attempts: number; successes: number };
  /** Successful txs touching the contract through another contract: not classified, shown so nothing is hidden. */
  indirectSuccessful: number;
  scanComplete: boolean;
};

const sum = (xs: Move[]): Amount[] => {
  const m = new Map<string, bigint>();
  for (const x of xs) m.set(x.asset, (m.get(x.asset) ?? 0n) + B(x.amount));
  return [...m].filter(([, v]) => v > 0n).map(([asset, v]) => ({ asset, amount: v.toString() }));
};

const PRINCIPAL = /'(S[PM][0-9A-HJKMNP-TV-Z]{26,41})(?![.\w])/g;

export async function scanLiquidations(cacheDir: string, spec: LiquidationSpec, block: { height: number; blockTime: number }, log?: (m: string) => void): Promise<LiquidationRecord> {
  const { txs, complete } = await scanTxs(cacheDir, spec.contract, block.height, { log });
  const fromTime = block.blockTime - WINDOW_DAYS * 86400;
  const calls = txs.filter((t) => t.cid === spec.contract && t.fn && spec.fns.includes(t.fn));
  const since = calls.filter((t) => t.h >= spec.activationBlock);
  const inWindow = calls.filter((t) => t.status === "success" && t.t >= fromTime).sort((a, b) => a.h - b.h || a.t - b.t);
  const isProtocol = (p: string | null) => !!p && spec.protocolPrefixes.some((x) => p.startsWith(x));
  const events: LiquidationEvent[] = [];
  for (const t of inWindow) {
    const tx = await getTxMoves(cacheDir, t.txid);
    let debt: Move[];
    let coll: Move[];
    if (spec.mode === "caller-burns") {
      // Arkadiko redemption: the caller burns USDA and receives the vault's collateral.
      debt = tx.moves.filter((m) => m.kind === "burn" && m.asset.startsWith(spec.burnAsset!) && m.sender === tx.sender);
      coll = tx.moves.filter((m) => m.kind === "transfer" && m.recipient === tx.sender && isProtocol(m.sender));
    } else if (spec.mode === "pool-burns") {
      debt = tx.moves.filter((m) => m.kind === "burn" && m.asset.startsWith(spec.burnAsset!) && m.sender === spec.pool);
      coll = tx.moves.filter((m) => m.kind === "transfer" && m.recipient === spec.pool && !m.asset.startsWith(spec.burnAsset!));
    } else {
      debt = tx.moves.filter((m) => m.kind === "transfer" && m.sender === tx.sender && isProtocol(m.recipient));
      coll = tx.moves.filter((m) => m.kind === "transfer" && m.recipient === tx.sender && isProtocol(m.sender));
    }
    const borrowers = [...new Set(tx.args.flatMap((a) => [...a.matchAll(PRINCIPAL)].map((m) => m[1])))].filter((p) => p !== tx.sender).sort();
    events.push({ txid: tx.txid, height: tx.h, time: tx.t, fn: tx.fn ?? "", liquidator: tx.sender, borrowers, debtRepaid: sum(debt), collateralSeized: sum(coll) });
  }
  return {
    contract: spec.contract,
    fns: spec.fns,
    window: { days: WINDOW_DAYS, fromTime, toHeight: block.height },
    events,
    sinceActivation: { fromHeight: spec.activationBlock, attempts: since.length, successes: since.filter((t) => t.status === "success").length },
    indirectSuccessful: txs.filter((t) => t.status === "success" && t.cid && t.cid !== spec.contract && t.fn).length,
    scanComplete: complete,
  };
}

// ---- pure summary (recomputed by verify)

export type UsdOf = (asset: string, amount: string) => bigint | null;

type Row = { n: number; debtUsd: string };
export type LiquidationSummary = {
  /** Borrowers above the dust floor, by status at reference prices; USD is debt at reference. */
  liquidatable: Row;
  band: Row;
  healthy: Row;
  /** Debt with no collateral: cannot be liquidated, counted apart. */
  noCollateral: Row;
  dust: Row;
  liquidated: {
    days: number;
    txs: number;
    borrowers: number;
    /** Valued at this snapshot's reference prices, not the price at the time of liquidation. */
    debtRepaidUsd: string | null;
    collateralSeizedUsd: string | null;
    unpricedAssets: string[];
    /** Borrowers liquidated in the window that are still liquidatable at this block. */
    stillLiquidatable: number;
  };
};

type Pos = { account: string; debtStored: Record<string, string>; d: { debtUsd: string; collUsd: string; liquidatable: string; dust: boolean } | null };

export function liquidationSummary(positions: Pos[], rec: LiquidationRecord, usdOf: UsdOf, excluded: Set<string>): LiquidationSummary | null {
  const borrowers = positions.filter((p) => Object.values(p.debtStored).some((v) => B(v) > 0n) && !excluded.has(p.account));
  if (borrowers.some((p) => !p.d)) return null; // risk withheld
  const row = (ps: Pos[]): Row => ({ n: ps.length, debtUsd: ps.reduce((a, p) => a + B(p.d!.debtUsd), 0n).toString() });
  const live = borrowers.filter((p) => !p.d!.dust && B(p.d!.collUsd) > 0n);
  const priced = (xs: Amount[]) => {
    let total = 0n;
    const missing: string[] = [];
    for (const x of xs) {
      const v = usdOf(x.asset, x.amount);
      if (v === null) missing.push(x.asset);
      else total += v;
    }
    return { total, missing };
  };
  const debt = priced(rec.events.flatMap((e) => e.debtRepaid));
  const coll = priced(rec.events.flatMap((e) => e.collateralSeized));
  const liquidatedBorrowers = new Set(rec.events.flatMap((e) => e.borrowers));
  const liquidatableNow = new Set(live.filter((p) => p.d!.liquidatable === "yes").map((p) => p.account));
  return {
    liquidatable: row(live.filter((p) => p.d!.liquidatable === "yes")),
    band: row(live.filter((p) => p.d!.liquidatable === "band")),
    healthy: row(live.filter((p) => p.d!.liquidatable === "no")),
    noCollateral: row(borrowers.filter((p) => !p.d!.dust && B(p.d!.collUsd) === 0n)),
    dust: row(borrowers.filter((p) => p.d!.dust)),
    liquidated: {
      days: rec.window.days,
      txs: rec.events.length,
      borrowers: liquidatedBorrowers.size,
      debtRepaidUsd: debt.missing.length ? null : debt.total.toString(),
      collateralSeizedUsd: coll.missing.length ? null : coll.total.toString(),
      unpricedAssets: [...new Set([...debt.missing, ...coll.missing])].sort(),
      stillLiquidatable: [...liquidatedBorrowers].filter((b) => liquidatableNow.has(b)).length,
    },
  };
}

export type { PriceVector };
