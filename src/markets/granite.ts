// Granite (two markets: USDCx and aeUSDC), indexed at each market's state-v1,
// the storage layer that survived every migration.
//
// Discovery: state-v1 has no enumerable list. Candidates come from every
// transaction that touched state-v1 (sender, top-level contract, and every
// principal in the call arguments). Exact equality of Σ debt-shares with
// total-debt-shares, and of Σ collateral with the sBTC held by state-v1,
// proves the candidate set is complete for every position holding either.
//
// Health mirrors liquidator-v1.account-health, with interest accrued to the
// block through the protocol's own linear-kinked-ir-v1.accrue-interest
// read-only (account-health itself does not accrue, and the stored
// open-interest can be a day old):
//   health = Σ floor(coll_value × liquidation-ltv / 1e8) × 1e8 / debt_value,  liquidatable when < 1e8.

import { Cl, Err } from "../lib/clarity.ts";
import { B, divDown, divUp, pow10, ratio, sumBy, toleranceCheck } from "../engine/math.ts";
import { scanTxs, scanEvents, getTx } from "../engine/txscan.ts";
import { strict, show, short } from "./util.ts";
import type { Adapter, HealthValue, MarketId, Position, ReadOut, ReconCheck } from "./types.ts";

const PRINCIPAL_RE = /'(S[PM][0-9A-HJKMNP-TV-Z]{26,41}(?:\.[a-zA-Z][a-zA-Z0-9_-]*)?)/g;

function granite(id: MarketId): Adapter {
  return {
    id,

    async read(r, cfg, ctx): Promise<ReadOut> {
      const C = cfg.generation.contracts;
      const S = C.state;

      // Candidates from state-v1's full transaction history (cached, incremental)
      let candidates: string[];
      let txCount = 0;
      if (ctx.accounts) {
        candidates = ctx.accounts;
      } else {
        const { txs, complete } = await scanTxs(ctx.cacheDir, S, r.block.height, { log: ctx.log });
        if (!complete) throw new Error(`${id}: state-v1 tx history scan incomplete`);
        txCount = txs.length;
        const set = new Set<string>();
        for (const t of txs) {
          set.add(t.sender);
          if (t.cid) set.add(t.cid);
          for (const a of t.args) for (const m of a.matchAll(PRINCIPAL_RE)) set.add(m[1]);
        }
        set.delete(S);
        candidates = [...set].sort();
      }
      ctx.log(`  ${id}: ${candidates.length} candidates from ${txCount} state-v1 txs`);

      const mq = await r.maps(
        candidates.flatMap((u) => [
          [S, "positions", Cl.principal(u)],
          [S, "user-collaterals", Cl.tuple({ user: Cl.principal(u), collateral: Cl.principal(cfg.sbtc) })],
        ] as any),
        800,
      );
      const positions: Position[] = [];
      candidates.forEach((u, i) => {
        const p = mq[2 * i];
        const c = mq[2 * i + 1];
        if (!p.ok || !c.ok) throw new Error(`${id}: map read failed for ${u}`);
        const pv = p.value;
        const cv = c.value;
        if (!pv && !cv) return;
        const shares = pv ? B(pv["debt-shares"]) : 0n;
        const amount = cv ? B(cv.amount) : 0n;
        if (shares === 0n && amount === 0n) return;
        positions.push({
          account: u,
          collateral: amount > 0n ? { sBTC: amount.toString() } : {},
          debt: {}, // filled below from accrued open interest
          debtStored: shares > 0n ? { shares: shares.toString() } : {},
          meta: {
            borrowedBlock: pv ? Number(pv["borrowed-block"]) : null,
            borrowedAmount: pv ? B(pv["borrowed-amount"]).toString() : "0",
            collaterals: pv ? (pv.collaterals as string[]).map(short).join(",") : "",
          },
        });
      });

      const [debtParams, aip, collCfg, sbtcHeld, borrowEn, liqEn, mtd, sf, psf] = await strict(
        r,
        [
          [S, "get-debt-params"],
          [S, "get-accrue-interest-params"],
          [S, "get-collateral", Cl.principal(cfg.sbtc)],
          [cfg.sbtc, "get-balance", Cl.principal(S)],
          [S, "is-borrow-enabled"],
          [S, "is-liquidation-enabled"],
          [C.constants, "get-market-token-decimals"],
          [C.constants, "get-scaling-factor"],
          [C.constants, "get-price-scaling-factor"],
        ],
        `${id} params`,
      );
      // Interest accrued to this block, by the protocol's own read-only.
      const [acc] = await strict(
        r,
        [[C.ir, "accrue-interest", Cl.uint(B(aip["last-accrued-block-time"])), Cl.uint(B(aip["lp-interest"])), Cl.uint(B(aip["staked-interest"])), Cl.uint(0), Cl.uint(B(aip["protocol-interest"])), Cl.uint(B(aip["protocol-reserve-percentage"])), Cl.uint(B(aip["total-assets"]))]],
        `${id} accrue-interest`,
      );
      const oiStored = B(debtParams["open-interest"]);
      const oiNext = B(acc["lp-open-interest"]) + B(acc["staked-open-interest"]) + B(acc["protocol-open-interest"]);
      const totalShares = B(debtParams["total-debt-shares"]);
      for (const p of positions) {
        const s = B(p.debtStored.shares);
        if (s > 0n) p.debt[short(C.marketAsset)] = (totalShares === 0n ? s : divUp(oiNext * s, totalShares)).toString();
      }

      return {
        positions,
        onchain: { totalDebtShares: totalShares.toString(), sbtcHeldByState: B(sbtcHeld).toString(), openInterestStored: oiStored.toString() },
        params: {
          marketAsset: short(C.marketAsset),
          openInterestStored: oiStored.toString(),
          openInterestAccrued: oiNext.toString(),
          lastAccruedBlockTime: B(aip["last-accrued-block-time"]).toString(),
          totalDebtShares: totalShares.toString(),
          liquidationLtv: B(collCfg["liquidation-ltv"]).toString(),
          maxLtv: B(collCfg["max-ltv"]).toString(),
          collateralDecimals: Number(collCfg.decimals),
          marketTokenDecimals: Number(mtd),
          scalingFactor: B(sf).toString(),
          priceScalingFactor: B(psf).toString(),
          minimumHealth: "100000000",
          borrowEnabled: borrowEn,
          liquidationEnabled: liqEn,
          candidates,
        },
        discovery: { method: "every principal in state-v1's transaction history (sender, top-level contract, call arguments); positions + user-collaterals map reads at the block", stateTxs: txCount, candidates: candidates.length, positions: positions.length },
      };
    },

    value(p, params, px): HealthValue {
      const dec = params.marketTokenDecimals as number;
      const SF = B(params.scalingFactor);
      const PSF = B(params.priceScalingFactor);
      const shares = B(p.debtStored.shares);
      const debt = shares === 0n ? 0n : B(p.debt[params.marketAsset]);
      const debtValue = divUp(debt * B(px.USDC), SF); // get-market-asset-value (market-token units)
      const amount = B(p.collateral.sBTC);
      const raw = divDown(amount * B(px.BTC), PSF); // collateral value in collateral decimals
      const cd = params.collateralDecimals as number;
      const collValue = cd > dec ? divDown(raw, pow10(cd - dec)) : raw * pow10(dec - cd); // to-fixed
      const liquidLtv = divDown(collValue * B(params.liquidationLtv), SF);
      const health = debtValue > 0n ? divDown(liquidLtv * SF, debtValue) : null;
      const minH = B(params.minimumHealth);
      const toUsd8 = (v: bigint) => (dec <= 8 ? v * pow10(8 - dec) : divDown(v, pow10(dec - 8)));
      return {
        h: health === null ? null : ratio(health, minH),
        metric: "position-health (1e8 = 1.0)",
        value: health === null ? null : health.toString(),
        threshold: minH.toString(),
        liquidatable: health !== null && health < minH,
        collUsd: toUsd8(collValue).toString(),
        debtUsd: toUsd8(debtValue).toString(),
      };
    },

    checks(positions, onchain, _params, cfg): ReconCheck[] {
      return [
        toleranceCheck(
          { id: "debt:shares", kind: "debt", asset: "debt-shares", label: "Debt shares: Σ positions vs state-v1 total-debt-shares", indexed: sumBy(positions, (p) => p.debtStored.shares).toString(), onchain: onchain.totalDebtShares },
          cfg.tolerances.debt,
        ),
        toleranceCheck(
          { id: "collateral:sBTC", kind: "collateral", asset: "sBTC", decimals: 8, label: "sBTC collateral: Σ positions vs sBTC held by state-v1", indexed: sumBy(positions, (p) => p.collateral.sBTC).toString(), onchain: onchain.sbtcHeldByState },
          cfg.tolerances.collateral,
        ),
      ];
    },

    bandPct(cfg) {
      return cfg.band ?? {};
    },

    async pointers(r, cfg) {
      const C = cfg.generation.contracts;
      const S = C.state;
      const retired: string[] = cfg.retiredEntrypoints ?? [];
      const res = await r.ro([
        [S, "is-allowed-contract", Cl.principal(C.borrower)],
        [S, "is-allowed-contract", Cl.principal(C.liquidator)],
        ...retired.map((c) => [S, "is-allowed-contract", Cl.principal(c)] as any),
      ]);
      const [gov] = await r.vars([[S, "governance"]]);
      const out = [
        { label: "Borrower entry point allowed", read: `${short(S)}.is-allowed-contract(${C.borrower})`, expected: "true", actual: show(res[0]), match: show(res[0]) === "true" },
        { label: "Liquidator entry point allowed", read: `${short(S)}.is-allowed-contract(${C.liquidator})`, expected: "true", actual: show(res[1]), match: show(res[1]) === "true" },
        { label: "Governance contract", read: `${short(S)}::governance`, expected: C.governance, actual: show(gov), match: show(gov) === C.governance },
      ];
      retired.forEach((c, i) => {
        const a = show(res[2 + i]);
        out.push({ label: `Retired entry point stays disallowed`, read: `${short(S)}.is-allowed-contract(${c})`, expected: "(err u107)", actual: a, match: a === "(err u107)" });
      });
      return out;
    },

    async liquidationPath(r, cfg, out, ctx) {
      const C = cfg.generation.contracts;
      const enabled = out.params.liquidationEnabled === true;
      // Successful liquidations print from liquidator-v1 (also when called through a bot contract).
      const { events } = await scanEvents(ctx.cacheDir, C.liquidator);
      const liqEvents = events.filter((e) => /liquidat/i.test(e.repr));
      const txids = [...new Set(liqEvents.map((e) => e.txid))];
      const txs = [];
      for (const t of txids.slice(0, 50)) txs.push(await getTx(ctx.cacheDir, t));
      const ok = txs.filter((t) => t.status === "success" && t.h <= r.block.height).sort((a, b) => b.h - a.h);
      const last = ok[0];
      const status = !enabled ? "BLOCKED" : ok.length === 0 ? "UNPROVEN" : "LIVE";
      return {
        status,
        summary: !enabled
          ? "Liquidations are disabled on this market (state-v1.is-liquidation-enabled = false)."
          : ok.length === 0
            ? `No liquidation has executed through ${short(C.liquidator)} since this generation went live.`
            : `${ok.length} liquidation transaction${ok.length === 1 ? "" : "s"} through ${C.liquidator.split(".")[0].slice(0, 8)}…${short(C.liquidator)}; last at block ${last.h} (${((r.block.blockTime - last.t) / 86400).toFixed(1)} days before this block).`,
        evidence: { contract: C.liquidator, liquidationEnabled: enabled, successfulTxs: ok.length, lastSuccess: last ? { txid: last.txid, height: last.h, time: last.t } : null },
      };
    },
  };
}

export const graniteUsdcx = granite("granite-usdcx");
export const graniteAeusdc = granite("granite-aeusdc");
