// Zest v1 (pool-borrow-v2-4 / pool-0-reserve-v2-0, entry point borrow-helper-v2-1-8).
//
// Discovery: every pool-borrow version keeps an on-chain `users-id` map; the
// union across all versions is the complete user list. get-user-assets gives
// each user's supplied and borrowed reserves.
//
// Health mirrors pool-0-reserve-v2-0.calculate-user-global-data:
//   HF = Σ collateral_usd_i × LT_i / Σ debt_usd_j   (1e8 scale), liquidatable when HF < 1e8.
// The protocol's own health read is gated (err u7000 / u6005 outside a price
// session), so HF is recomputed off-chain from the same inputs.
//
// Reconciliation:
//   debt:       Σ principal-borrow-balance = reserve total-borrows-variable (known orphan record excluded)
//   collateral: Σ zToken principal balance over all suppliers = zToken get-total-supply

import { Cl } from "../lib/clarity.ts";
import { B, divDown, pow10, ratio, sumBy, toleranceCheck, exactCheck } from "../engine/math.ts";
import { scanTxs } from "../engine/txscan.ts";
import { ftHolders } from "../engine/holders.ts";
import { strict, show, short } from "./util.ts";
import type { Adapter, HealthValue, Position, ReadOut, ReconCheck } from "./types.ts";

const ONE8 = 100_000_000n;

type Reserve = {
  asset: string;
  symbol: string;
  decimals: number;
  zToken: string;
  oracle: string;
  lt: string; // 1e8
  collateralEnabled: boolean;
  borrowingEnabled: boolean;
  totalBorrowsVariable: string;
  eModeType: string;
  priceKind: string; // BTC | STX | STX*ststxRatio | fixed
  fixedPrice: string | null; // 1e8, read from the protocol's fixed-price oracle
};

export const zestV1: Adapter = {
  id: "zest-v1",

  async read(r, cfg, ctx): Promise<ReadOut> {
    const C = cfg.generation.contracts;
    const R = C.reserve;
    const [assetList, hfThreshold, staleThreshold, ststxRatio] = await strict(
      r,
      [[R, "get-assets"], [R, "get-health-factor-liquidation-threshold"], [C.oracle, "get-stale-price-threshold"], [C.ststxRatio, "get-stx-per-ststx"]],
      "zest-v1 base",
    );

    // Reserves
    const rs = await strict(r, (assetList as string[]).flatMap((a) => [[R, "get-reserve-state", Cl.principal(a)], [R, "get-asset-e-mode-type", Cl.principal(a)]] as any), "reserve state");
    const reserves: Record<string, Reserve> = {};
    (assetList as string[]).forEach((a, i) => {
      const s = rs[2 * i];
      const known = cfg.assets[a];
      if (!known) throw new Error(`zest-v1: reserve ${a} not in config (new reserve listed: update config)`);
      reserves[a] = {
        asset: a, symbol: known.symbol, decimals: Number(s.decimals), zToken: s["a-token-address"], oracle: s.oracle,
        lt: B(s["liquidation-threshold"]).toString(), collateralEnabled: s["usage-as-collateral-enabled"], borrowingEnabled: s["borrowing-enabled"],
        totalBorrowsVariable: B(s["total-borrows-variable"]).toString(), eModeType: rs[2 * i + 1], priceKind: known.price, fixedPrice: null,
      };
    });
    // Fixed-price oracles: read the protocol's own value (it may differ from market; that is what liquidates).
    const fixed = Object.values(reserves).filter((x) => x.priceKind === "fixed");
    const fp = await r.ro(fixed.map((x) => [x.oracle, "get-price"]));
    fixed.forEach((x, i) => (x.fixedPrice = fp[i].ok ? B(fp[i].value).toString() : null));

    const eTypes = [...new Set(Object.values(reserves).map((x) => x.eModeType).filter((t) => t !== "0x00"))];
    const ec = await strict(r, eTypes.map((t) => [R, "get-e-mode-type-config", Cl.bufferFromHex(t.slice(2))] as any), "e-mode config");
    const eModes: Record<string, { lt: string; ltv: string }> = {};
    eTypes.forEach((t, i) => (eModes[t] = { lt: B(ec[i]["liquidation-threshold"]).toString(), ltv: B(ec[i].ltv).toString() }));

    // User registry: union of users-id across every pool-borrow version
    const all = new Set<string>();
    const perRegistry: Record<string, number> = {};
    for (const v of cfg.userRegistries as string[]) {
      const pb = `${C.deployer}.${v}`;
      const [last] = await strict(r, [[pb, "get-last-user-id"]], `${v}.get-last-user-id`);
      const n = Number(last);
      perRegistry[v] = n;
      const rows = await r.maps([...Array(n).keys()].map((i) => [pb, "users-id", Cl.uint(i)]), 1000);
      rows.forEach((x) => x.ok && x.value && all.add(x.value));
    }
    const registryCount = all.size;
    // The users-id registries miss some suppliers (found 2026-09-23: 3 stSTX suppliers holding 978 stSTX
    // that never appear in any registry). zToken holder lists close that gap; they are candidates only.
    const holderCounts: Record<string, number> = {};
    const holdersBySym: Record<string, string[]> = {};
    const registry = new Set(all);
    if (ctx.accounts) {
      // verify: the published extra candidates stand in for the (unpinned) holder lists
      ctx.accounts.forEach((a) => all.add(a));
    } else {
      for (const [sym, ft] of Object.entries<string>(cfg.zTokenFts ?? {})) {
        const h = await ftHolders(ctx.cacheDir, ft, cfg.holdersRefreshHours ?? 24, ctx.log);
        holderCounts[sym] = h.holders.length;
        holdersBySym[sym] = h.holders;
        h.holders.forEach((a) => all.add(a));
      }
    }
    const extraCandidates = [...all].filter((a) => !registry.has(a)).sort();
    const users = [...all].sort();
    ctx.log(`  zest-v1: ${registryCount} registry principals + zToken holders = ${users.length} candidates`);

    const ua = await strict(r, users.map((u) => [R, "get-user-assets", Cl.principal(u)]), "get-user-assets", 1000);
    const userAssets: Record<string, { supplied: string[]; borrowed: string[] }> = {};
    users.forEach((u, i) => (userAssets[u] = { supplied: ua[i]["assets-supplied"], borrowed: ua[i]["assets-borrowed"] }));
    const borrowers = users.filter((u) => userAssets[u].borrowed.length > 0);

    // Borrower detail
    type Q = { u: string; a: string | null; kind: "emode" | "urd" | "bb" | "bal" | "pbal" };
    const qs: Q[] = [];
    for (const u of borrowers) {
      qs.push({ u, a: null, kind: "emode" });
      for (const a of new Set([...userAssets[u].supplied, ...userAssets[u].borrowed])) {
        qs.push({ u, a, kind: "urd" }, { u, a, kind: "bb" }, { u, a, kind: "bal" }, { u, a, kind: "pbal" });
      }
    }
    const call = (q: Q): any => {
      const zt = q.a ? reserves[q.a].zToken : "";
      switch (q.kind) {
        case "emode": return [R, "get-user-e-mode", Cl.principal(q.u)];
        case "urd": return [R, "get-user-reserve-data", Cl.principal(q.u), Cl.principal(q.a!)];
        case "bb": return [R, "get-user-borrow-balance", Cl.principal(q.u), Cl.principal(q.a!)];
        case "bal": return [zt, "get-balance", Cl.principal(q.u)];
        case "pbal": return [zt, "get-principal-balance", Cl.principal(q.u)];
      }
    };
    const res = await strict(r, qs.map(call), "borrower detail");
    const byUser: Record<string, any> = {};
    qs.forEach((q, i) => {
      const o = (byUser[q.u] ??= { emode: "0x00", assets: {} });
      if (q.kind === "emode") o.emode = res[i];
      else (o.assets[q.a!] ??= {})[q.kind] = res[i];
    });

    const positions: Position[] = borrowers.map((u) => {
      const o = byUser[u];
      const collateral: Record<string, string> = {};
      const debt: Record<string, string> = {};
      const debtStored: Record<string, string> = {};
      const collFlags: Record<string, boolean> = {};
      for (const [a, d] of Object.entries<any>(o.assets)) {
        const sym = reserves[a].symbol;
        const bal = B(d.bal);
        if (bal > 0n) {
          collateral[sym] = bal.toString();
          collFlags[sym] = d.urd?.["use-as-collateral"] === true;
        }
        const principal = B(d.urd?.["principal-borrow-balance"]);
        if (principal > 0n) {
          debtStored[sym] = principal.toString();
          debt[sym] = B(d.bb?.["compounded-balance"]).toString();
        }
      }
      return {
        account: u,
        collateral,
        debt,
        debtStored,
        meta: { eMode: o.emode, useAsCollateral: JSON.stringify(collFlags), principalBalances: JSON.stringify(Object.fromEntries(Object.entries<any>(o.assets).map(([a, d]) => [reserves[a].symbol, B(d.pbal).toString()]))) },
      };
    });

    // Collateral reconciliation needs the principal zToken balance of every supplier, not only borrowers.
    // Suppliers per reserve = users listing it in assets-supplied ∪ current holders of its zToken
    // (a zToken can be held without the reserve being listed, e.g. after a liquidation seize).
    const supplierQs: { u: string; a: string }[] = [];
    // Holders of a zToken that do not list its reserve in assets-supplied; published so verify reads the same set.
    const unlistedHolders: Record<string, string[]> = {};
    for (const x of Object.values(reserves)) {
      const listing = new Set(users.filter((u) => userAssets[u].supplied.includes(x.asset)));
      const holders: string[] = ctx.accounts ? (ctx.unlisted?.[x.symbol] ?? []) : (holdersBySym[x.symbol] ?? []);
      unlistedHolders[x.symbol] = holders.filter((h) => !listing.has(h)).sort();
      for (const u of new Set([...listing, ...unlistedHolders[x.symbol]])) if (!byUser[u] || !byUser[u].assets[x.asset]) supplierQs.push({ u, a: x.asset });
    }
    const sres = await strict(r, supplierQs.map((q) => [reserves[q.a].zToken, "get-principal-balance", Cl.principal(q.u)] as any), "supplier balances", 1000);
    const principalSupply: Record<string, bigint> = {};
    for (const p of positions) for (const [sym, v] of Object.entries<string>(JSON.parse(p.meta.principalBalances as string))) principalSupply[sym] = (principalSupply[sym] ?? 0n) + B(v);
    // (borrowers' balances for reserves they do not list are read in supplierQs above)
    supplierQs.forEach((q, i) => {
      const sym = reserves[q.a].symbol;
      principalSupply[sym] = (principalSupply[sym] ?? 0n) + B(sres[i]);
    });
    const zts = Object.values(reserves);
    const ts = await strict(r, zts.map((x) => [x.zToken, "get-total-supply"] as any), "zToken total supply");

    const onchain: Record<string, string> = {};
    const suppliedIndexed: Record<string, string> = {};
    zts.forEach((x, i) => {
      onchain[`debtPrincipal:${x.symbol}`] = x.totalBorrowsVariable;
      onchain[`zTokenSupply:${x.symbol}`] = B(ts[i]).toString();
      suppliedIndexed[x.symbol] = (principalSupply[x.symbol] ?? 0n).toString();
    });

    return {
      positions,
      onchain,
      params: {
        reserves,
        eModes,
        hfThreshold: B(hfThreshold).toString(),
        staleThresholdS: B(staleThreshold).toString(),
        ststxRatio: B(ststxRatio).toString(),
        suppliedPrincipalIndexed: suppliedIndexed,
        suppliers: supplierQs.length,
        extraCandidates,
        unlistedHolders,
      },
      discovery: {
        method: "union of users-id over every pool-borrow version, plus current holders of every zToken (candidates only), then get-user-assets per principal at the block",
        registries: perRegistry,
        registryPrincipals: registryCount,
        extraCandidates: extraCandidates.length,
        zTokenHolders: holderCounts,
        candidates: users.length,
        borrowers: borrowers.length,
      },
    };
  },

  value(p, params, px): HealthValue {
    const reserves: Record<string, Reserve> = params.reserves;
    const bySym: Record<string, Reserve> = Object.fromEntries(Object.values(reserves).map((x) => [x.symbol, x]));
    const price = (x: Reserve): bigint => {
      switch (x.priceKind) {
        case "BTC": return B(px.BTC);
        case "STX": return B(px.STX);
        case "STX*ststxRatio": return divDown(B(px.STX) * B(params.ststxRatio), 1_000_000n);
        case "fixed": return B(x.fixedPrice);
        default: throw new Error(`zest-v1: price kind ${x.priceKind}`);
      }
    };
    const flags: Record<string, boolean> = JSON.parse((p.meta.useAsCollateral as string) || "{}");
    const eMode = p.meta.eMode as string;
    let collUsd = 0n;
    let weighted = 0n; // Σ coll_usd × LT (1e16 scale)
    for (const [sym, amt] of Object.entries(p.collateral)) {
      const x = bySym[sym];
      const v = divDown(B(amt) * price(x), pow10(x.decimals));
      if (!(x.collateralEnabled && flags[sym])) continue;
      const lt = eMode !== "0x00" && eMode === x.eModeType && params.eModes[eMode] ? B(params.eModes[eMode].lt) : B(x.lt);
      collUsd += v;
      weighted += v * lt;
    }
    let debtUsd = 0n;
    for (const [sym, amt] of Object.entries(p.debt)) {
      const x = bySym[sym];
      debtUsd += divDown(B(amt) * price(x), pow10(x.decimals));
    }
    const hf = debtUsd === 0n ? null : weighted / debtUsd; // 1e8 scale
    const threshold = B(params.hfThreshold);
    return {
      h: hf === null ? null : ratio(hf, threshold),
      metric: "health factor (1e8 = 1.0)",
      value: hf === null ? null : hf.toString(),
      threshold: threshold.toString(),
      liquidatable: hf !== null && hf < threshold,
      collUsd: collUsd.toString(),
      debtUsd: debtUsd.toString(),
    };
  },

  checks(positions, onchain, params, cfg): ReconCheck[] {
    const out: ReconCheck[] = [];
    const excl: { account: string; asset: string; reason: string }[] = cfg.reconciliationExclusions ?? [];
    for (const x of Object.values(params.reserves as Record<string, Reserve>)) {
      const sym = x.symbol;
      const ex = excl.filter((e) => e.asset === sym);
      const excluded = ex
        .map((e) => ({ account: e.account, amount: positions.find((p) => p.account === e.account)?.debtStored[sym] ?? "0", reason: e.reason }))
        .filter((e) => B(e.amount) > 0n);
      const indexed = sumBy(positions.filter((p) => !ex.some((e) => e.account === p.account)), (p) => p.debtStored[sym]);
      const total = onchain[`debtPrincipal:${sym}`];
      if (B(total) === 0n && indexed === 0n) continue;
      out.push(
        toleranceCheck(
          {
            id: `debt:${sym}`, kind: "debt", asset: sym, decimals: x.decimals,
            label: `${sym} debt principal: Σ borrowers vs reserve total-borrows-variable`,
            indexed: indexed.toString(), onchain: total, excluded: excluded.length ? excluded : undefined,
          },
          cfg.tolerances.debt,
        ),
      );
    }
    for (const x of Object.values(params.reserves as Record<string, Reserve>)) {
      const sym = x.symbol;
      const total = onchain[`zTokenSupply:${sym}`];
      const indexed = params.suppliedPrincipalIndexed[sym] ?? "0";
      if (B(total) === 0n && B(indexed) === 0n) continue;
      out.push(
        toleranceCheck(
          { id: `collateral:${sym}`, kind: "collateral", asset: sym, decimals: x.decimals, label: `${sym} supplied principal: Σ all suppliers vs ${short(x.zToken)}.get-total-supply`, indexed, onchain: total },
          cfg.tolerances.collateral,
        ),
      );
    }
    return out;
  },

  bandPct(cfg) {
    return cfg.band ?? {};
  },

  async pointers(r, cfg) {
    const C = cfg.generation.contracts;
    const assets = Object.keys(cfg.assets);
    const res = await r.ro([
      [C.pool, "is-approved-contract", Cl.principal(C.helper)],
      [C.reserve, "get-assets"],
      ...assets.map((a) => [C.reserve, "get-reserve-state", Cl.principal(a)] as any),
    ]);
    const vars = await r.vars([[C.reserve, "lending-pool"], [C.reserve, "liquidator"]]);
    const out = [
      { label: "Entry point approved on the lending pool", read: `${short(C.pool)}.is-approved-contract(${short(C.helper)})`, expected: "true", actual: show(res[0]), match: show(res[0]) === "true" },
      { label: "Reserve's lending pool", read: `${short(C.reserve)}::lending-pool`, expected: C.pool, actual: show(vars[0]), match: show(vars[0]) === C.pool },
      { label: "Reserve's liquidator", read: `${short(C.reserve)}::liquidator`, expected: C.liquidationManager, actual: show(vars[1]), match: show(vars[1]) === C.liquidationManager },
    ];
    // Oracle per volatile reserve must still be the configured generation's oracle.
    assets.forEach((a, i) => {
      if (cfg.assets[a].price === "fixed") return;
      const x = res[2 + i];
      const actual = x.ok ? String((x.value as any).value?.oracle ?? (x.value as any).oracle) : `read failed`;
      out.push({ label: `${cfg.assets[a].symbol} reserve oracle`, read: `${short(C.reserve)}.get-reserve-state(${short(a)}).oracle`, expected: C.oracle, actual, match: actual === C.oracle });
    });
    return out;
  },

  async liquidationPath(r, cfg, _out, ctx) {
    const C = cfg.generation.contracts;
    const { txs, complete } = await scanTxs(ctx.cacheDir, C.helper, r.block.height, { log: ctx.log });
    const liq = txs.filter((t) => t.cid === C.helper && t.fn === "liquidation-call" && t.h >= cfg.generation.activationBlock);
    const ok = liq.filter((t) => t.status === "success");
    const last = ok[0];
    const days = last ? (r.block.blockTime - last.t) / 86400 : null;
    const status = ok.length === 0 ? "UNPROVEN" : "LIVE";
    const senders = new Set(ok.map((t) => t.sender));
    return {
      status,
      summary: last
        ? `${ok.length} of ${liq.length} liquidation calls through ${short(C.helper)} succeeded since activation, by ${senders.size} keeper${senders.size === 1 ? "" : "s"}; last ${days!.toFixed(1)} days before this block.`
        : `No successful liquidation through ${short(C.helper)} since activation.`,
      evidence: { contract: C.helper, attempts: liq.length, successes: ok.length, keepers: [...senders], lastSuccess: last ? { txid: last.txid, height: last.h, time: last.t } : null, scanComplete: complete },
    };
  },
};
