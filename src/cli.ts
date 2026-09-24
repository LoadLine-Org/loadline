#!/usr/bin/env node
// LoadLine command line.
//
//   snapshot [--markets a,b] [--out data/public] [--height N]   read all markets at one pinned block and publish
//   verify   [--from <dir|url>] [--markets a,b] [--skip-prices]
//            recompute every published total from the chain, keyless, and diff it

import path from "node:path";
import { MARKET_IDS, ROOT } from "./markets/index.ts";
import type { MarketId } from "./markets/types.ts";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

function markets(): MarketId[] | undefined {
  const m = arg("markets");
  if (!m) return undefined;
  const ids = m.split(",") as MarketId[];
  for (const id of ids) if (!MARKET_IDS.includes(id)) throw new Error(`unknown market ${id}; known: ${MARKET_IDS.join(", ")}`);
  return ids;
}

const cmd = process.argv[2];
if (cmd === "snapshot") {
  const { runSnapshot } = await import("./engine/snapshot.ts");
  await runSnapshot({
    outDir: path.resolve(arg("out") ?? path.join(ROOT, "data/public")),
    quarantineDir: path.resolve(arg("quarantine") ?? path.join(ROOT, "data/quarantine")),
    cacheDir: path.resolve(arg("cache") ?? path.join(ROOT, "data/cache")),
    markets: markets(),
    height: arg("height") ? Number(arg("height")) : undefined,
  });
} else if (cmd === "oracle") {
  const { runOracleRecord } = await import("./oracle/record.ts");
  await runOracleRecord({
    outDir: path.resolve(arg("out") ?? path.join(ROOT, "data/public")),
    cacheDir: path.resolve(arg("cache") ?? path.join(ROOT, "data/cache")),
    height: arg("height") ? Number(arg("height")) : undefined,
  });
} else if (cmd === "replay") {
  const { runReplay } = await import("./replay/replay.ts");
  const { writeIndex } = await import("./engine/dataset.ts");
  const outDir = path.resolve(arg("out") ?? path.join(ROOT, "data/public"));
  await runReplay({ outDir, cacheDir: path.resolve(arg("cache") ?? path.join(ROOT, "data/cache")) });
  writeIndex(outDir);
} else if (cmd === "verify") {
  const { runVerify } = await import("./verify/verify.ts");
  const code = await runVerify({ from: arg("from") ?? path.join(ROOT, "data/public"), markets: markets(), skipPrices: flag("skip-prices"), height: arg("height") ? Number(arg("height")) : undefined });
  process.exit(code);
} else {
  console.log(`usage:
  node src/cli.ts snapshot [--markets zest-v2,zest-v1,...]
  node src/cli.ts oracle [--height N]          90-day oracle-health record -> data/public/oracle/
  node src/cli.ts replay                      light migration replay -> data/public/replay/
  node src/cli.ts verify [--from <published dir or https URL>] [--height N] [--markets ...] [--skip-prices]
markets: ${MARKET_IDS.join(", ")}`);
  process.exit(cmd ? 2 : 0);
}
