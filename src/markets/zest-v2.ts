// Zest v2 (v0-N-market over the invariant v0-market-vault storage).
//
// Discovery: the on-chain account registry in v0-market-vault (ids 0..get-nr).
// Health mirrors v0-8-market.liquidate-internal: LTV = debt_usd * 1e4 / coll_usd,
// liquidatable when LTV >= the resolved egroup's LTV-LIQ-PARTIAL.
// Prices: the protocol verifies Pyth Lazer payloads inside each tx and stores
// no price, so BTC/STX/USDC come from the reference median (band applies);
// DIA USDh, LST ratios and vault indices are read on-chain at the block.

import { Cl, buffToUint, ok as unwrapOk, Err } from "../lib/clarity.ts";
import { B, divDown, divUp, pow10, ratio, sumBy, toleranceCheck, exactCheck } from "../engine/math.ts";
import { scanTxs } from "../engine/txscan.ts";
import { strict, show } from "./util.ts";
import type { Adapter, HealthValue, Position, PriceVector, ReadOut, ReconCheck } from "./types.ts";

const MAX_U64 = 18446744073709551615n;
const INDEX = 10n ** 12n;
const BPS = 10000n;
const SECONDS_PER_YEAR_BPS = 31536000n * BPS;

const SYMBOL: Record<number, string> = {
  0: "STX", 1: "zSTX", 2: "sBTC", 3: "zsBTC", 4: "stSTX", 5: "zstSTX", 6: "USDC", 7: "zUSDC",
  8: "USDH", 9: "zUSDH", 10: "stSTXbtc", 11: "zstSTXbtc", 12: "stBTC", 13: "zstBTC",
};
const AID: Record<string, number> = Object.fromEntries(Object.entries(SYMBOL).map(([k, v]) => [v, Number(k)]));

// Pyth Lazer feed idents (v0-assets oracle.ident) -> reference asset.
const IDENT: Record<string, keyof PriceVector> = {
  "0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43": "BTC",
  "0xec7a775f46379b5e943c3526b1c8d54cd49749176b0b98e02dde68d1bd335c17": "STX",
  "0xeaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a": "USDC",
};
// zToken / callcode -> the vault (underlying asset id) whose liquidity index applies.
const CALLCODE_VAULT: Record<string, number> = { "0x01": 0, "0x02": 2, "0x03": 4, "0x04": 6, "0x05": 8, "0x06": 10 };

type AssetCfg = { id: number; addr: string; decimals: number; type: string; ident: string; callcode: string | null; maxStaleness: number; collateral: boolean; debt: boolean };

export const zestV2: Adapter = {
  id: "zest-v2",

  async read(r, cfg, ctx): Promise<ReadOut> {
    const C = cfg.generation.contracts;
    const MV = C.marketVault;
    const [nr, bitmap, anonce] = await strict(r, [[MV, "get-nr"], [C.assets, "get-bitmap"], [C.assets, "get-nonce"]], "zest-v2 base");

    // Asset registry
    const ids = [...Array(Number(anonce)).keys()];
    const st = await strict(r, ids.map((i) => [C.assets, "get-status", Cl.uint(i)]), "v0-assets.get-status");
    const assets: Record<number, AssetCfg> = {};
    st.forEach((a: any) => {
      a = unwrapOk(a);
      assets[Number(a.id)] = {
        id: Number(a.id), addr: a.addr, decimals: Number(a.decimals), type: a.oracle.type, ident: a.oracle.ident,
        callcode: a.oracle.callcode, maxStaleness: Number(a.oracle["max-staleness"]), collateral: a.collateral, debt: a.debt,
      };
    });

    // Registry (on-chain list of every account that ever opened a position)
    ctx.log(`  zest-v2: registry ${nr} ids`);
    const regIds = [...Array(Number(nr)).keys()];
    const reg = await r.maps(regIds.map((i) => [MV, "registry", Cl.uint(i)]));
    const entries = reg.map((x, i) => {
      if (!x.ok || !x.value) throw new Error(`registry ${i} unreadable`);
      return x.value;
    });
    const registryEntriesRead = entries.filter((e: any) => B(e.id) >= 0n).length;
    const active = entries.filter((e: any) => B(e.mask) !== 0n);
    const pos = await strict(r, active.map((e: any) => [MV, "get-position", Cl.principal(e.account), Cl.uint(MAX_U64)]), "get-position");

    const positions: Position[] = pos.map((p0: any, k) => {
      const p = unwrapOk(p0);
      const collateral: Record<string, string> = {};
      const debtStored: Record<string, string> = {};
      for (const c of p.collateral) collateral[SYMBOL[Number(c.aid)] ?? `aid${c.aid}`] = c.amount.toString();
      for (const d of p.debt) debtStored[SYMBOL[Number(d.aid)] ?? `aid${d.aid}`] = d.scaled.toString();
      return {
        account: p.account,
        collateral,
        debt: {}, // filled below once indices are known
        debtStored,
        meta: { id: Number(active[k].id), mask: p.mask.toString(), lastBorrowBlock: Number(p["last-borrow-block"]), lastUpdate: Number(p["last-update"]) },
      };
    });

    // Vault state (indices, rates, totals)
    const vaultIds = Object.keys(cfg.vaults).map(Number);
    const vfns = ["get-next-index", "get-index", "get-principal-scaled", "get-debt", "get-liquidity-index", "get-interest-rate", "get-utilization", "get-fee-reserve", "get-last-update", "get-pause-states", "get-total-supply"];
    const vres = await strict(r, vaultIds.flatMap((a) => vfns.map((f) => [`${C.deployer}.v0-vault-${cfg.vaults[a]}`, f] as [string, string])), "vault reads");
    const vaults: Record<string, any> = {};
    vaultIds.forEach((a, i) => {
      const v: Record<string, any> = {};
      vfns.forEach((f, j) => (v[f] = unwrapOk(vres[i * vfns.length + j])));
      const lindex = B(v["get-liquidity-index"]);
      const dt = BigInt(r.block.blockTime) - B(v["get-last-update"]);
      const paused = v["get-pause-states"]?.accrue === true;
      // next-liquidity-index, as in v0-vault-*.accrue (round down)
      const liqRate = (((B(v["get-interest-rate"]) * B(v["get-utilization"])) / BPS) * (BPS - B(v["get-fee-reserve"]))) / BPS;
      const mult = dt <= 0n || paused ? INDEX : INDEX + (liqRate * dt * INDEX) / SECONDS_PER_YEAR_BPS;
      vaults[a] = {
        symbol: SYMBOL[a],
        nextIndex: v["get-next-index"].toString(),
        index: v["get-index"].toString(),
        principalScaled: v["get-principal-scaled"].toString(),
        debt: v["get-debt"].toString(),
        lindexStored: lindex.toString(),
        lindexNext: ((lindex * mult) / INDEX).toString(),
        interestRateBps: v["get-interest-rate"].toString(),
        utilizationBps: v["get-utilization"].toString(),
        lastUpdate: v["get-last-update"].toString(),
        totalSupply: v["get-total-supply"].toString(),
        paused: v["get-pause-states"],
      };
    });

    // Actual debt accrued to the block: ceil(scaled * next-index / 1e12)
    for (const p of positions) {
      for (const [sym, scaled] of Object.entries(p.debtStored)) {
        const v = vaults[AID[sym]];
        p.debt[sym] = divUp(B(scaled) * B(v.nextIndex), INDEX).toString();
      }
    }

    // Risk groups for each distinct mask with debt
    const masks = [...new Set(positions.filter((p) => Object.keys(p.debtStored).length).map((p) => p.meta.mask as string))];
    const eg = await r.ro(masks.map((m) => [C.egroup, "resolve", Cl.uint(B(m))]));
    const egroups: Record<string, any> = {};
    masks.forEach((m, i) => {
      const x = eg[i];
      if (!x.ok || x.value instanceof Err) {
        egroups[m] = null;
        return;
      }
      const g = unwrapOk(x.value);
      egroups[m] = {
        id: Number(g.id),
        ltvBorrow: buffToUint(g["LTV-BORROW"]).toString(),
        ltvLiqPartial: buffToUint(g["LTV-LIQ-PARTIAL"]).toString(),
        ltvLiqFull: buffToUint(g["LTV-LIQ-FULL"]).toString(),
        penaltyMin: buffToUint(g["LIQ-PENALTY-MIN"]).toString(),
        penaltyMax: buffToUint(g["LIQ-PENALTY-MAX"]).toString(),
      };
    });

    // On-chain price inputs other than Lazer
    const M = C.market;
    const [ststx, stbtc, dia, haircut, pauseLiq] = await strict(
      r,
      [
        [C.ststxRatio, "get-stx-per-ststx"],
        [C.stbtcRatio, "get-sbtc-per-stbtc"],
        [C.dia, "get-value", Cl.stringAscii("USDh/USD")],
        [M, "get-stbtc-haircut-bps"],
        [M, "get-pause-liquidation"],
      ],
      "zest-v2 price inputs",
    );
    const graceIds = [100, ...ids];
    const grace = await strict(r, graceIds.map((i) => [M, "get-liquidation-grace-period-asset", Cl.uint(i)]), "grace periods");
    const graceEnds: Record<string, string> = {};
    graceIds.forEach((i, k) => (graceEnds[String(i)] = B(unwrapOk(grace[k]) ?? 0).toString()));

    // Collateral custody: token balances held by the market vault, per collateral asset held
    const collAids = [...new Set(positions.flatMap((p) => Object.keys(p.collateral).map((s) => AID[s])))].sort((a, b) => a - b);
    const bal = await strict(r, collAids.map((a) => [assets[a].addr, "get-balance", Cl.principal(MV)]), "custody balances");
    const onchain: Record<string, string> = { registryCount: B(nr).toString() };
    collAids.forEach((a, i) => (onchain[`collateral:${SYMBOL[a]}`] = B(unwrapOk(bal[i])).toString()));
    for (const a of vaultIds) onchain[`debtScaled:${SYMBOL[a]}`] = vaults[a].principalScaled;
    for (const a of vaultIds) onchain[`debtActual:${SYMBOL[a]}`] = vaults[a].debt;

    const diaV = unwrapOk(dia);
    return {
      positions,
      onchain,
      params: {
        bitmap: B(bitmap).toString(),
        assets,
        vaults,
        egroups,
        ststxRatio: B(unwrapOk(ststx)).toString(),
        stbtcRatio: B(unwrapOk(stbtc)).toString(),
        stbtcHaircutBps: B(unwrapOk(haircut)).toString(),
        diaUsdh: { value: B(diaV.value).toString(), timestamp: B(diaV.timestamp).toString() },
        pauseLiquidation: unwrapOk(pauseLiq),
        graceEnds,
        blockTime: r.block.blockTime,
        registryEntriesRead,
      },
      discovery: { method: "v0-market-vault registry ids 0..get-nr, get-position(account, MAX-U64) for every non-zero mask", registryIds: Number(nr), activePositions: active.length },
    };
  },

  value(p, params, px): HealthValue {
    const assets: Record<number, AssetCfg> = params.assets;
    const bitmap = B(params.bitmap);
    const base = (a: AssetCfg): bigint => {
      if (a.type === "0x01") return B(params.diaUsdh.value); // DIA
      const k = IDENT[a.ident];
      if (!k) throw new Error(`zest-v2: unknown oracle ident ${a.ident}`);
      return B(px[k]);
    };
    const lidx = (vaultAid: number) => B(params.vaults[vaultAid].lindexNext);
    const price = (aid: number): bigint => {
      const a = assets[aid];
      const p = base(a);
      switch (a.callcode) {
        case null:
          return p;
        case "0x00":
          return divDown(p * B(params.ststxRatio), 1_000_000n);
        case "0x03":
          return divDown(divDown(p * B(params.ststxRatio), 1_000_000n) * lidx(4), INDEX);
        case "0x07": {
          const r = divDown(B(params.stbtcRatio) * (BPS - B(params.stbtcHaircutBps)), BPS);
          return divDown(p * r, 100_000_000n);
        }
        default: {
          const v = CALLCODE_VAULT[a.callcode];
          if (v === undefined) throw new Error(`zest-v2: unknown callcode ${a.callcode}`);
          return divDown(p * lidx(v), INDEX);
        }
      }
    };
    let coll = 0n;
    for (const [sym, amt] of Object.entries(p.collateral)) {
      const aid = AID[sym];
      if (((bitmap >> BigInt(aid)) & 1n) === 0n) continue; // disabled collateral is not counted by the market
      coll += divDown(B(amt) * price(aid), pow10(assets[aid].decimals));
    }
    let debt = 0n;
    for (const [sym, amt] of Object.entries(p.debt)) {
      const aid = AID[sym];
      debt += divUp(B(amt) * price(aid), pow10(assets[aid].decimals));
    }
    const g = params.egroups[p.meta.mask as string];
    const partial = g ? B(g.ltvLiqPartial) : null;
    const ltv = coll === 0n ? (debt === 0n ? 0n : BPS) : (debt * BPS) / coll;
    const liquidatable = debt > 0n && partial !== null && ltv >= partial;
    // h = partial / LTV (continuous); <= 1 is liquidatable
    const h = debt === 0n || partial === null ? null : coll === 0n ? 0 : ratio(partial * coll, debt * BPS);
    return {
      h,
      metric: "LTV (bps) vs egroup LTV-LIQ-PARTIAL",
      value: debt === 0n ? null : ltv.toString(),
      threshold: partial === null ? "none" : partial.toString(),
      liquidatable,
      collUsd: coll.toString(),
      debtUsd: debt.toString(),
    };
  },

  checks(positions, onchain, params, cfg): ReconCheck[] {
    const out: ReconCheck[] = [];
    for (const [aid, v] of Object.entries(params.vaults as Record<string, any>)) {
      const sym = v.symbol as string;
      out.push(
        toleranceCheck(
          {
            id: `debt:${sym}`, kind: "debt", asset: sym, decimals: params.assets[aid].decimals,
            label: `${sym} scaled debt: Σ positions vs v0-vault-${cfg.vaults[aid]}.get-principal-scaled`,
            indexed: sumBy(positions, (p) => p.debtStored[sym]).toString(), onchain: onchain[`debtScaled:${sym}`],
            note: "Rounding residue of a few base units is expected (scaled amounts are rounded per operation).",
          },
          cfg.tolerances.debt,
        ),
      );
    }
    for (const k of Object.keys(onchain).filter((k) => k.startsWith("collateral:"))) {
      const sym = k.slice(11);
      out.push(
        toleranceCheck(
          {
            id: k, kind: "collateral", asset: sym, decimals: params.assets[AID[sym]].decimals,
            label: `${sym} collateral: Σ positions vs balance held by v0-market-vault`,
            indexed: sumBy(positions, (p) => p.collateral[sym]).toString(), onchain: onchain[k],
          },
          cfg.tolerances.collateral,
        ),
      );
    }
    out.push(
      exactCheck({
        id: "count:registry", kind: "count", label: "Registry entries read vs v0-market-vault.get-nr",
        indexed: String(params.registryEntriesRead), onchain: onchain.registryCount,
      }),
    );
    return out;
  },

  bandPct(cfg) {
    return cfg.band ?? {};
  },

  async pointers(r, cfg) {
    const C = cfg.generation.contracts;
    const vaultNames = Object.values(cfg.vaults as Record<string, string>);
    const res = await r.ro([
      [C.marketVault, "get-impl"],
      [C.daoExecutor, "get-impl"],
      ...vaultNames.map((v) => [`${C.deployer}.v0-vault-${v}`, "is-authorized-contract", Cl.principal(C.market)] as any),
    ]);
    return [
      { label: "Live market implementation", read: `${C.marketVault}.get-impl()`, expected: C.market, actual: show(res[0]), match: show(res[0]) === C.market },
      { label: "DAO executor implementation", read: `${C.daoExecutor}.get-impl()`, expected: C.daoMultisig, actual: show(res[1]), match: show(res[1]) === C.daoMultisig },
      ...vaultNames.map((v, i) => ({
        label: `v0-vault-${v} authorises the market`, read: `v0-vault-${v}.is-authorized-contract(${C.market.split(".")[1]})`, expected: "true", actual: show(res[2 + i]), match: show(res[2 + i]) === "true",
      })),
    ];
  },

  async liquidationPath(r, cfg, out, ctx) {
    const C = cfg.generation.contracts;
    const { txs, complete } = await scanTxs(ctx.cacheDir, C.market, r.block.height, { log: ctx.log });
    const liq = txs.filter((t) => t.cid === C.market && (t.fn === "liquidate" || t.fn === "liquidate-multi-with-feeds" || t.fn === "liquidate-redeem"));
    const ok = liq.filter((t) => t.status === "success");
    const errs: Record<string, number> = {};
    for (const t of liq) if (t.status !== "success") errs[t.result] = (errs[t.result] ?? 0) + 1;
    const paused = out.params.pauseLiquidation === true;
    const graceActive = Object.values(out.params.graceEnds as Record<string, string>).some((e) => B(e) > BigInt(r.block.blockTime));
    const status = paused || graceActive ? "BLOCKED" : ok.length === 0 ? "UNPROVEN" : "LIVE";
    const last = ok[0];
    return {
      status,
      summary:
        status === "BLOCKED"
          ? `Liquidations paused on ${C.market.split(".")[1]}${graceActive ? " (grace period active)" : ""}.`
          : status === "UNPROVEN"
            ? `${ok.length} of ${liq.length} liquidation attempts on ${C.market.split(".")[1]} have succeeded since it went live; a liquidatable position here has never actually been liquidated.`
            : `${ok.length} of ${liq.length} liquidation attempts succeeded; last at block ${last.h}.`,
      evidence: { contract: C.market, attempts: liq.length, successes: ok.length, failuresByResult: errs, lastSuccess: last ? { txid: last.txid, height: last.h, time: last.t } : null, scanComplete: complete, pauseLiquidation: paused, graceActive },
    };
  },
};

