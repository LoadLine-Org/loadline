// Open dataset: CSV exports and the snapshot index.
//
// CSVs are a pure function of each published snapshot JSON (verify regenerates them and compares
// hashes). The index lists every published file with its size and SHA-256, so a consumer can mirror
// the dataset and check integrity without trusting the server.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { positionKey } from "../markets/index.ts";

export const DATASET_SCHEMA = 1;
export const INDEX_FILE = "index.json";

const esc = (v: unknown) => {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const csv = (cols: string[], rows: unknown[][]) => [cols.join(","), ...rows.map((r) => r.map(esc).join(","))].join("\n") + "\n";

/** CSV files for one market snapshot, keyed by file name. Deterministic: same JSON in, same bytes out. */
export function snapshotCsvs(snap: any): Record<string, string> {
  const id = snap.market;
  const h = snap.block.height;
  const files: Record<string, string> = {};
  const positions: any[] = snap.positions ?? [];
  files[`${id}.positions.csv`] = csv(
    ["block_height", "market", "position", "account", "coll_usd_e8", "debt_usd_e8", "health", "health_low", "health_high", "liquidatable", "dust"],
    positions.map((p) => [h, id, positionKey(p), p.account, p.d?.collUsd ?? "", p.d?.debtUsd ?? "", p.d?.h ?? "", p.d?.hLow ?? "", p.d?.hHigh ?? "", p.d?.liquidatable ?? "", p.d ? p.d.dust : ""]),
  );
  const holdings: unknown[][] = [];
  for (const p of positions)
    for (const [side, m] of [["collateral", p.collateral], ["debt", p.debt], ["debt_stored", p.debtStored]] as const)
      for (const [asset, amount] of Object.entries(m ?? {}).sort()) holdings.push([h, id, positionKey(p), p.account, side, asset, amount]);
  files[`${id}.holdings.csv`] = csv(["block_height", "market", "position", "account", "side", "asset", "amount_base_units"], holdings);
  files[`${id}.checks.csv`] = csv(
    ["block_height", "market", "check", "kind", "asset", "decimals", "indexed", "onchain", "delta", "delta_pct", "rule", "status"],
    (snap.checks ?? []).map((c: any) => [h, id, c.id, c.kind, c.asset ?? "", c.decimals ?? "", c.indexed, c.onchain, c.delta, c.deltaPct ?? "", c.rule, c.status]),
  );
  const liq: unknown[][] = [];
  for (const [kind, rec] of [["liquidation", snap.liquidations], ["redemption", snap.redemptions]] as const)
    for (const e of rec?.events ?? []) {
      for (const x of e.debtRepaid) liq.push([h, id, kind, e.txid, e.height, e.time, e.liquidator, e.borrowers.join(" "), "debt_repaid", x.asset, x.amount]);
      for (const x of e.collateralSeized) liq.push([h, id, kind, e.txid, e.height, e.time, e.liquidator, e.borrowers.join(" "), "collateral_seized", x.asset, x.amount]);
    }
  files[`${id}.liquidations.csv`] = csv(["snapshot_block", "market", "kind", "txid", "tx_height", "tx_time", "caller", "borrowers", "movement", "asset", "amount_base_units"], liq);
  return files;
}

export const sha256 = (s: string | Buffer) => crypto.createHash("sha256").update(s).digest("hex");

function fileEntry(abs: string, rel: string) {
  const b = fs.readFileSync(abs);
  return { path: rel, bytes: b.length, sha256: sha256(b) };
}

/**
 * CSV exports for any published snapshot that lacks them (snapshots written before the exports
 * existed). The snapshot JSON itself is never touched; the CSVs are derived from it.
 */
function backfillCsvs(snapDir: string): void {
  for (const h of fs.readdirSync(snapDir).filter((d) => /^\d+$/.test(d))) {
    const dir = path.join(snapDir, h);
    for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".json"))) {
      const snap = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
      if (!fs.existsSync(path.join(dir, "csv", `${snap.market}.positions.csv`))) writeSnapshotCsvs(path.dirname(snapDir), snap);
    }
  }
}

/** Rebuild index.json from what is on disk under outDir. */
export function writeIndex(outDir: string): void {
  const snapDir = path.join(outDir, "snapshots");
  if (fs.existsSync(snapDir)) backfillCsvs(snapDir);
  const heights = fs.existsSync(snapDir) ? fs.readdirSync(snapDir).filter((d) => /^\d+$/.test(d)).map(Number).sort((a, b) => a - b) : [];
  const snapshots = heights.map((h) => {
    const dir = path.join(snapDir, String(h));
    const files: ReturnType<typeof fileEntry>[] = [];
    let block: any = null;
    for (const f of fs.readdirSync(dir).sort()) {
      if (f.endsWith(".json")) {
        files.push(fileEntry(path.join(dir, f), `snapshots/${h}/${f}`));
        if (!block) block = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")).block;
      }
    }
    const csvDir = path.join(dir, "csv");
    if (fs.existsSync(csvDir)) for (const f of fs.readdirSync(csvDir).sort()) files.push(fileEntry(path.join(csvDir, f), `snapshots/${h}/csv/${f}`));
    return { height: h, indexBlockHash: block?.indexBlockHash ?? null, blockTime: block?.blockTime ?? null, bytes: files.reduce((a, f) => a + f.bytes, 0), files };
  });
  const oracleDir = path.join(outDir, "oracle");
  const oracle = fs.existsSync(oracleDir) ? fs.readdirSync(oracleDir).sort().map((f) => fileEntry(path.join(oracleDir, f), `oracle/${f}`)) : [];
  const replayDir = path.join(outDir, "replay");
  const replay = fs.existsSync(replayDir) ? fs.readdirSync(replayDir).sort().map((f) => fileEntry(path.join(replayDir, f), `replay/${f}`)) : [];
  const recent = snapshots.slice(-7);
  const index = {
    schema: DATASET_SCHEMA,
    generatedAt: new Date().toISOString(),
    schemaDocs: "https://github.com/LoadLine-Org/loadline/blob/main/docs/DATASET.md",
    jsonSchemas: `https://github.com/LoadLine-Org/loadline/tree/main/schema/v${DATASET_SCHEMA}`,
    deprecations: [] as { field: string; since: string; removeAfter: string; note: string }[],
    growth: {
      snapshots: snapshots.length,
      bytesPerSnapshotRecent: recent.length ? Math.round(recent.reduce((a, s) => a + s.bytes, 0) / recent.length) : 0,
      note: "One snapshot per day. Snapshots are immutable once published; oracle/ is rewritten daily and does not grow.",
    },
    latest: heights.length ? heights[heights.length - 1] : null,
    snapshots,
    oracle,
    replay,
  };
  fs.writeFileSync(path.join(outDir, INDEX_FILE), JSON.stringify(index, null, 1) + "\n");
}

export function writeSnapshotCsvs(outDir: string, snap: any): void {
  const dir = path.join(outDir, "snapshots", String(snap.block.height), "csv");
  fs.mkdirSync(dir, { recursive: true });
  for (const [f, content] of Object.entries(snapshotCsvs(snap))) fs.writeFileSync(path.join(dir, f), content);
}
