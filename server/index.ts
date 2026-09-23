// Hosted indexer: serves the published data and runs the daily jobs.
//
//   GET /data/<path>   files under $DATA_DIR/public (latest.json, snapshots/, oracle/, …)
//   GET /status        last run, next run, freshness
//   GET /healthz       liveness
//
// Jobs run one at a time: the five-market snapshot, then the oracle-record update,
// daily at SNAPSHOT_UTC (default 00:30), plus once at boot if today's snapshot is missing.
// All chain and exchange requests go through the same throttled client as the CLI.
// The site proxies /data/* to this server, so browsers only ever talk to the site.

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import zlib from "node:zlib";
import { runSnapshot } from "../src/engine/snapshot.ts";
import { runOracleRecord } from "../src/oracle/record.ts";
import { ROOT } from "../src/markets/index.ts";

const DATA_DIR = path.resolve(process.env.DATA_DIR ?? path.join(ROOT, "data"));
const PUBLIC = path.join(DATA_DIR, "public");
const PORT = Number(process.env.PORT ?? 8080);
const [HH, MM] = (process.env.SNAPSHOT_UTC ?? "00:30").split(":").map(Number);

const log = (m: string) => console.log(`${new Date().toISOString()} ${m}`);
const status: { running: string | null; lastOk: Record<string, string>; lastError: Record<string, string>; nextRun: string | null } = { running: null, lastOk: {}, lastError: {}, nextRun: null };

// First boot on an empty volume: start from the snapshot committed in the repo, and from the
// request cache shipped with the deploy (so the first run does not re-fetch 90 days of history).
function seed() {
  const pairs: [string, string, string][] = [
    [path.join(ROOT, "data/public"), PUBLIC, "latest.json"],
    [path.join(ROOT, "data/cache"), path.join(DATA_DIR, "cache"), "txscan"],
  ];
  for (const [src, dst, marker] of pairs) {
    if (src === dst || fs.existsSync(path.join(dst, marker)) || !fs.existsSync(path.join(src, marker))) continue;
    fs.mkdirSync(dst, { recursive: true });
    fs.cpSync(src, dst, { recursive: true });
    log(`seeded ${dst} from ${src}`);
  }
}

let chain = Promise.resolve();
function job(name: string, fn: () => Promise<unknown>) {
  chain = chain.then(async () => {
    status.running = name;
    log(`job ${name}: start`);
    try {
      await fn();
      status.lastOk[name] = new Date().toISOString();
      log(`job ${name}: done`);
    } catch (e) {
      status.lastError[name] = `${new Date().toISOString()} ${(e as Error).message}`;
      log(`job ${name}: FAILED ${(e as Error).stack}`);
    } finally {
      status.running = null;
    }
  });
  return chain;
}

function daily() {
  const opts = { outDir: PUBLIC, quarantineDir: path.join(DATA_DIR, "quarantine"), cacheDir: path.join(DATA_DIR, "cache"), log };
  job("snapshot", () => runSnapshot(opts));
  job("oracle", () => runOracleRecord({ outDir: PUBLIC, cacheDir: opts.cacheDir, log }));
}

function scheduleNext() {
  const now = new Date();
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), HH, MM));
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  status.nextRun = next.toISOString();
  setTimeout(() => {
    daily();
    scheduleNext();
  }, next.getTime() - now.getTime());
  log(`next daily run ${status.nextRun}`);
}

function snapshotToday(): boolean {
  try {
    const l = JSON.parse(fs.readFileSync(path.join(PUBLIC, "latest.json"), "utf8"));
    return new Date(l.block.blockTime * 1000).toISOString().slice(0, 10) === new Date().toISOString().slice(0, 10);
  } catch {
    return false;
  }
}

const TYPES: Record<string, string> = { ".json": "application/json; charset=utf-8", ".jsonl": "application/x-ndjson; charset=utf-8", ".csv": "text/csv; charset=utf-8" };

function cacheControl(rel: string): string {
  if (rel.startsWith("snapshots/")) return "public, max-age=31536000, immutable"; // a snapshot never changes
  if (rel.startsWith("oracle/")) return "public, max-age=3600, s-maxage=3600";
  return "public, max-age=300, s-maxage=300"; // latest.json, state.json, runs.jsonl
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405).end();
    return;
  }
  if (url.pathname === "/healthz") {
    res.writeHead(200, { "content-type": "text/plain" }).end("ok");
    return;
  }
  if (url.pathname === "/status") {
    let latest: any = null;
    try {
      latest = JSON.parse(fs.readFileSync(path.join(PUBLIC, "latest.json"), "utf8"));
    } catch {}
    const ageH = latest ? (Date.now() / 1000 - latest.block.blockTime) / 3600 : null;
    res.writeHead(ageH !== null && ageH < 26 ? 200 : 503, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({ ...status, latestBlock: latest?.block?.height ?? null, latestAgeHours: ageH === null ? null : Math.round(ageH * 10) / 10 }));
    return;
  }
  if (!url.pathname.startsWith("/data/")) {
    res.writeHead(404).end();
    return;
  }
  const rel = decodeURIComponent(url.pathname.slice("/data/".length));
  const file = path.resolve(PUBLIC, rel);
  if (!file.startsWith(PUBLIC + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404, { "content-type": "text/plain" }).end("not found");
    return;
  }
  const headers: Record<string, string> = {
    "content-type": TYPES[path.extname(file)] ?? "application/octet-stream",
    "cache-control": cacheControl(rel),
    "access-control-allow-origin": "*",
    "x-robots-tag": "noindex",
  };
  const gz = /\bgzip\b/.test(String(req.headers["accept-encoding"] ?? ""));
  if (gz) headers["content-encoding"] = "gzip";
  res.writeHead(200, headers);
  if (req.method === "HEAD") return res.end();
  const stream = fs.createReadStream(file);
  (gz ? stream.pipe(zlib.createGzip()) : stream).pipe(res);
});

seed();
server.listen(PORT, () => log(`serving ${PUBLIC} on :${PORT}`));
if (!snapshotToday()) daily();
scheduleNext();
