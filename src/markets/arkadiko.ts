// Arkadiko v2 vaults, indexed at vaults-data / vaults-sorted (resolved through
// the arkadiko-dao registry).
//
// Discovery: the per-token sorted linked list in vaults-sorted (first-owner ->
// next-owner ...). Owners seen before are cached, so later runs batch-read the
// known links and only step one-by-one through new owners.
//
// Health mirrors vaults-helpers-v1-1.get-collateral-to-debt with the stored
// arkadiko-oracle-v2-3 price (exact: the protocol has no other price):
//   sf    = floor(floor(stability-fee × debt / 10000) × (burn-height − last-block) / 52560)
//   ratio = floor(floor(collateral × last-price × 100 / (debt + sf)) / (decimals / 100))
//   liquidatable when ratio < liquidation-ratio.

import fs from "node:fs";
import path from "node:path";
import { Cl } from "../lib/clarity.ts";
import { B, divDown, ratio as fratio, sumBy, toleranceCheck, lteCheck, exactCheck } from "../engine/math.ts";
import { scanTxs } from "../engine/txscan.ts";
import { strict, show, short } from "./util.ts";
import type { Adapter, HealthValue, Position, ReadOut, ReconCheck } from "./types.ts";

const KEY = (owner: string, token: string) => Cl.tuple({ owner: Cl.principal(owner), token: Cl.principal(token) });

export const arkadiko: Adapter = {
  id: "arkadiko-v2",

  async read(r, cfg, ctx): Promise<ReadOut> {
    const C = cfg.generation.contracts;
    const [tokens] = await strict(r, [[C["vaults-tokens"], "get-token-list"]], "token list");
    const per = await strict(
      r,
      (tokens as string[]).flatMap((t) => [[C["vaults-tokens"], "get-token", Cl.principal(t)], [C["vaults-sorted"], "get-token", Cl.principal(t)], [C["vaults-data"], "get-total-debt", Cl.principal(t)]] as any),
      "token params",
    );
    const tokenCfg: Record<string, any> = {};
    (tokens as string[]).forEach((t, i) => {
      const tc = per[3 * i];
      const so = per[3 * i + 1];
      tokenCfg[t] = {
        symbol: tc["token-name"],
        liquidationRatio: B(tc["liquidation-ratio"]).toString(),
        stabilityFee: B(tc["stability-fee"]).toString(),
        liquidationPenalty: B(tc["liquidation-penalty"]).toString(),
        redemptionFeeMin: B(tc["redemption-fee-min"]).toString(),
        redemptionFeeMax: B(tc["redemption-fee-max"]).toString(),
        redemptionFeeBlockInterval: B(tc["redemption-fee-block-interval"]).toString(),
        firstOwner: so["first-owner"],
        totalVaults: B(so["total-vaults"]).toString(),
        totalDebt: B(per[3 * i + 2]).toString(),
      };
    });
    const names = [...new Set(Object.values(tokenCfg).map((x) => x.symbol as string))];
    const pr = await strict(r, names.map((n) => [C.oracle, "get-price", Cl.stringAscii(n)] as any), "oracle prices");
    const prices: Record<string, any> = {};
    names.forEach((n, i) => (prices[n] = { lastPrice: B(pr[i]["last-price"]).toString(), lastBlock: B(pr[i]["last-block"]).toString(), decimals: B(pr[i].decimals).toString() }));

    // Walk each sorted list, using cached owners to batch the known part.
    const cacheFile = path.join(ctx.cacheDir, "arkadiko-owners.json");
    let known: Record<string, string[]> = {};
    try {
      known = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
    } catch {
      /* first run */
    }
    const positions: Position[] = [];
    let sequentialReads = 0;
    const walked: Record<string, number> = {};
    for (const t of tokens as string[]) {
      const links = new Map<string, any>();
      // verify passes the published owners as seeds; every link is still read from the chain.
      const kn = ctx.accounts ? [...new Set([...(known[t] ?? []), ...ctx.accounts])] : (known[t] ?? []);
      if (kn.length) {
        const rows = await r.maps(kn.map((o) => [C["vaults-sorted"], "vaults", KEY(o, t)] as any));
        kn.forEach((o, i) => rows[i].ok && rows[i].value && links.set(o, rows[i].value));
      }
      const order: string[] = [];
      let cur: string | null = tokenCfg[t].firstOwner;
      const seen = new Set<string>();
      while (cur) {
        if (seen.has(cur)) throw new Error(`arkadiko: cycle in sorted list for ${t} at ${cur}`);
        seen.add(cur);
        order.push(cur);
        let link = links.get(cur);
        if (!link) {
          const [row] = await r.maps([[C["vaults-sorted"], "vaults", KEY(cur, t)]]);
          sequentialReads++;
          if (!row.ok || !row.value) throw new Error(`arkadiko: sorted entry missing for ${cur}`);
          link = row.value;
          links.set(cur, link);
        }
        cur = link["next-owner"];
      }
      walked[t] = order.length;
      known[t] = order;
      const data = await r.maps(order.map((o) => [C["vaults-data"], "vaults", KEY(o, t)] as any));
      order.forEach((o, i) => {
        const v = data[i].ok ? data[i].value : null;
        if (!v) throw new Error(`arkadiko: vault data missing for ${o}`);
        const sym = tokenCfg[t].symbol;
        positions.push({
          account: o,
          collateral: { [sym]: B(v.collateral).toString() },
          debt: { USDA: B(v.debt).toString() },
          debtStored: { USDA: B(v.debt).toString() },
          meta: { token: t, status: Number(v.status), lastBlock: Number(v["last-block"]), nicr: B(links.get(o).nicr).toString(), listIndex: i },
        });
      });
    }
    fs.mkdirSync(ctx.cacheDir, { recursive: true });
    fs.writeFileSync(cacheFile, JSON.stringify(known));

    // Collateral custody: every vault token (including Arkadiko's wSTX, a real FT) is held by vaults-pool-active.
    const PA = C["vaults-pool-active"];
    const onchain: Record<string, string> = {};
    const held = await strict(r, (tokens as string[]).map((t) => [t, "get-balance", Cl.principal(PA)] as any), "pool balances");
    for (const [i, t] of (tokens as string[]).entries()) {
      const sym = tokenCfg[t].symbol;
      onchain[`collateral:${sym}`] = B(held[i]).toString();
      onchain[`debt:${sym}`] = tokenCfg[t].totalDebt;
      onchain[`count:${sym}`] = tokenCfg[t].totalVaults;
    }
    const [poolLiqUsda] = await strict(r, [[C.usda, "get-balance", Cl.principal(C["vaults-pool-liq"])]], "pool-liq USDA");
    // Redemption fee state per token (vaults-manager map), for the redemption-queue panel.
    const rbl = await strict(r, (tokens as string[]).map((t) => [C["vaults-manager"], "get-redemption-block-last", Cl.principal(t)] as any), "redemption-block-last");
    const redemptionBlockLast: Record<string, string> = {};
    (tokens as string[]).forEach((t, i) => (redemptionBlockLast[t] = B(rbl[i]["block-last"]).toString()));

    return {
      positions,
      onchain,
      params: { tokens: tokenCfg, prices, burnHeight: r.block.burnHeight, poolLiqUsda: B(poolLiqUsda).toString(), redemptionBlockLast, deployer: C.deployer },
      discovery: { method: "walk of each token's vaults-sorted linked list from first-owner (cached owners batch-read, new owners stepped)", walked, sequentialReads },
    };
  },

  value(p, params): HealthValue {
    const t = params.tokens[p.meta.token as string];
    const pr = params.prices[t.symbol];
    const debt = B(p.debtStored.USDA);
    const coll = B(p.collateral[t.symbol]);
    const blocks = BigInt(params.burnHeight) - BigInt(p.meta.lastBlock as number);
    const sf = divDown(divDown(B(t.stabilityFee) * debt, 10000n) * (blocks > 0n ? blocks : 0n), 144n * 365n);
    const owed = debt + sf;
    const lr = B(t.liquidationRatio);
    const dec = B(pr.decimals);
    const ratio = owed === 0n ? null : divDown(divDown(coll * B(pr.lastPrice) * 100n, owed), dec / 100n);
    const collUsd = divDown(coll * B(pr.lastPrice) * 100n, dec); // last-price is USD×1e6 -> ×100 = 1e8
    return {
      h: ratio === null ? null : fratio(ratio, lr),
      metric: "collateral-to-debt ratio (bps)",
      value: ratio === null ? null : ratio.toString(),
      threshold: lr.toString(),
      liquidatable: ratio !== null && ratio < lr,
      collUsd: collUsd.toString(),
      debtUsd: (owed * 100n).toString(), // USDA 6 decimals, valued at $1 as the protocol does
    };
  },

  checks(positions, onchain, params, cfg): ReconCheck[] {
    const out: ReconCheck[] = [];
    for (const [t, tc] of Object.entries<any>(params.tokens)) {
      const sym = tc.symbol;
      const mine = positions.filter((p) => p.meta.token === t);
      out.push(exactCheck({ id: `count:${sym}`, kind: "count", asset: sym, label: `${sym} vaults walked vs vaults-sorted total-vaults`, indexed: String(mine.length), onchain: onchain[`count:${sym}`] }));
      out.push(
        toleranceCheck(
          { id: `debt:${sym}`, kind: "debt", asset: "USDA", decimals: 6, label: `${sym} vaults USDA debt: Σ vaults vs vaults-data total-debt`, indexed: sumBy(mine, (p) => p.debtStored.USDA).toString(), onchain: onchain[`debt:${sym}`] },
          cfg.tolerances.debt,
        ),
      );
      out.push(
        lteCheck({
          id: `collateral:${sym}`, kind: "collateral", asset: sym, label: `${sym} collateral: Σ vaults ≤ balance of vaults-pool-active`,
          indexed: sumBy(mine, (p) => p.collateral[sym]).toString(), onchain: onchain[`collateral:${sym}`],
          note: "The pool can hold more than the vaults' collateral (surplus from redemptions, fees and direct transfers), so the check is Σ ≤ pool, with the surplus shown.",
        }),
      );
    }
    return out;
  },

  bandPct() {
    return {};
  },

  async pointers(r, cfg) {
    const C = cfg.generation.contracts;
    const names: string[] = cfg.registryNames;
    const res = await r.ro(names.map((n) => [C.dao, "get-qualified-name-by-name", Cl.stringAscii(n)] as any));
    return names.map((n, i) => ({ label: `DAO registry "${n}"`, read: `arkadiko-dao.get-qualified-name-by-name("${n}")`, expected: C[n], actual: show(res[i]), match: show(res[i]) === C[n] }));
  },

  liquidationSpec(cfg) {
    const C = cfg.generation.contracts;
    // The vault's debt is burned from the liquidation pool, and its collateral moves into the pool.
    return { contract: C["vaults-manager"], fns: ["liquidate-vault"], protocolPrefixes: [C.deployer], mode: "pool-burns", pool: C["vaults-pool-liq"], burnAsset: C.usda, activationBlock: 0 };
  },

  redemptionSpec(cfg) {
    const C = cfg.generation.contracts;
    return { contract: C["vaults-manager"], fns: ["redeem-vault"], protocolPrefixes: [C.deployer], mode: "caller-burns", burnAsset: C.usda, activationBlock: 0 };
  },

  extras(positions, params) {
    return { redemptionQueue: redemptionQueue(positions, params, (p) => { const v = arkadiko.value(p, params, { BTC: "0", STX: "0", USDC: "0" }).value; return v === null ? null : B(v); }) };
  },

  assetUsd(asset, amount, params, _px, cfg) {
    const contract = asset.split("::")[0];
    if (contract === cfg.generation.contracts.usda) return B(amount) * 100n; // USDA, 6 decimals, valued at $1 as the protocol does
    const t = params.tokens[contract];
    if (!t) return null;
    const pr = params.prices[t.symbol];
    return divDown(B(amount) * B(pr.lastPrice) * 100n, B(pr.decimals));
  },

  async liquidationPath(r, cfg, out, ctx) {
    const C = cfg.generation.contracts;
    const pool = B(out.params.poolLiqUsda);
    const borrowers = out.positions.filter((p) => B(p.debtStored.USDA) > 0n);
    const coverable = borrowers.filter((p) => B(p.debtStored.USDA) <= pool).length;
    const { txs } = await scanTxs(ctx.cacheDir, C["vaults-manager"], r.block.height, { log: ctx.log });
    const redeems = txs.filter((t) => t.fn === "redeem-vault" && t.status === "success");
    const liqs = txs.filter((t) => t.fn === "liquidate-vault");
    const liqOk = liqs.filter((t) => t.status === "success");
    const status = coverable === 0 ? "BLOCKED" : "LIVE";
    const lastRedeem = redeems[0];
    return {
      status,
      summary:
        status === "BLOCKED"
          ? `Liquidation burns the vault's debt from the liquidation pool, which holds ${(Number(pool) / 1e6).toFixed(6)} USDA: enough for 0 of ${borrowers.length} vaults. Redemption is the only forced-deleveraging path${lastRedeem ? ` (last successful redeem-vault at block ${lastRedeem.h})` : ""}.`
          : `The liquidation pool (${(Number(pool) / 1e6).toFixed(2)} USDA) covers ${coverable} of ${borrowers.length} vaults' debt.`,
      evidence: {
        poolLiqContract: C["vaults-pool-liq"], poolLiqUsda: pool.toString(), vaultsCoverable: coverable, vaultsWithDebt: borrowers.length,
        liquidateAttempts: liqs.length, liquidateSuccesses: liqOk.length, redemptions: redeems.length,
        lastRedemption: lastRedeem ? { txid: lastRedeem.txid, height: lastRedeem.h, time: lastRedeem.t } : null,
      },
    };
  },
};

// ---- redemption queue (pure; published with each snapshot and recomputed by verify)

/** Owed = debt + stability fee accrued to the block, exactly as vaults-helpers computes it. */
export function owedUsda(p: Position, params: Record<string, any>): bigint {
  const t = params.tokens[p.meta.token as string];
  const debt = B(p.debtStored.USDA);
  const blocks = BigInt(params.burnHeight) - BigInt(p.meta.lastBlock as number);
  const sf = divDown(divDown(B(t.stabilityFee) * debt, 10000n) * (blocks > 0n ? blocks : 0n), 144n * 365n);
  return debt + sf;
}

/** vaults-manager.get-redemption-fee at the block, in basis points. */
export function redemptionFeeBps(token: string, params: Record<string, any>): bigint {
  const t = params.tokens[token];
  const min = B(t.redemptionFeeMin), max = B(t.redemptionFeeMax), interval = B(t.redemptionFeeBlockInterval);
  const diff = max - min;
  const blockDiff = BigInt(params.burnHeight) - B(params.redemptionBlockLast[token]);
  const change = interval === 0n ? diff : (diff * blockDiff) / interval;
  return change >= diff ? min : max - change;
}

export type QueueEntry = { rank: number; owner: string; ownerIsDeployer: boolean; collateral: string; owedUsda: string; owedAheadUsda: string; ratioBps: string | null; nicr: string };
export type QueueToken = { token: string; symbol: string; vaults: number; owedTotalUsda: string; feeBps: string; feeMinBps: string; feeMaxBps: string; liquidationRatioBps: string; head: QueueEntry | null; deployerVaults: number; deployerOwedUsda: string; entries: QueueEntry[] };

/**
 * Only the first vault of a token's sorted list can be redeemed (vaults-manager ERR_NOT_FIRST_VAULT).
 * A redeemer burns USDA 1:1 against that vault's debt and receives its collateral at the oracle price,
 * minus the redemption fee. "Owed ahead" is the USDA that must be redeemed before a vault reaches the head.
 */
export function redemptionQueue(positions: Position[], params: Record<string, any>, ratio: (p: Position) => bigint | null): QueueToken[] {
  const out: QueueToken[] = [];
  for (const [token, t] of Object.entries<any>(params.tokens)) {
    const vs = positions.filter((p) => p.meta.token === token).sort((a, b) => Number(a.meta.listIndex) - Number(b.meta.listIndex));
    let ahead = 0n;
    const entries: QueueEntry[] = vs.map((p, i) => {
      const owed = owedUsda(p, params);
      const r = ratio(p);
      const e: QueueEntry = { rank: i + 1, owner: p.account, ownerIsDeployer: p.account === params.deployer, collateral: p.collateral[t.symbol], owedUsda: owed.toString(), owedAheadUsda: ahead.toString(), ratioBps: r === null ? null : r.toString(), nicr: String(p.meta.nicr) };
      ahead += owed;
      return e;
    });
    const dep = entries.filter((e) => e.ownerIsDeployer);
    out.push({
      token, symbol: t.symbol, vaults: entries.length, owedTotalUsda: ahead.toString(), feeBps: redemptionFeeBps(token, params).toString(), feeMinBps: t.redemptionFeeMin, feeMaxBps: t.redemptionFeeMax, liquidationRatioBps: t.liquidationRatio,
      head: entries[0] ?? null, deployerVaults: dep.length, deployerOwedUsda: dep.reduce((a, e) => a + B(e.owedUsda), 0n).toString(), entries,
    });
  }
  return out;
}
