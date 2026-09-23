import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { arkadiko } from "./arkadiko.ts";
import { graniteAeusdc, graniteUsdcx } from "./granite.ts";
import type { Adapter, MarketConfig, MarketId, Position } from "./types.ts";
import { zestV1 } from "./zest-v1.ts";
import { zestV2 } from "./zest-v2.ts";

export const ADAPTERS: Record<MarketId, Adapter> = {
  "zest-v2": zestV2,
  "zest-v1": zestV1,
  "granite-usdcx": graniteUsdcx,
  "granite-aeusdc": graniteAeusdc,
  "arkadiko-v2": arkadiko,
};
export const MARKET_IDS = Object.keys(ADAPTERS) as MarketId[];

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export function loadConfig(id: MarketId): MarketConfig {
  const dir = process.env.LOADLINE_CONFIG_DIR ?? path.join(ROOT, "config/markets");
  return JSON.parse(fs.readFileSync(path.join(dir, `${id}.json`), "utf8"));
}

/** Unique key of a position inside its market (Arkadiko: one vault per owner per token). */
export const positionKey = (p: Position) => (p.meta.token ? `${p.account}|${p.meta.token}` : p.account);
