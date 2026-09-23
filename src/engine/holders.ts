// Fungible-token holder lists, used only as a *candidate* source for discovery.
// Balances are always re-read at the pinned block; a holder list is "current"
// (not pinned), so it is cached and refreshed at most every `maxAgeHours`.

import fs from "node:fs";
import path from "node:path";
import { HIRO } from "../lib/chain.ts";
import { requestJson } from "../lib/http.ts";

export async function ftHolders(cacheDir: string, assetId: string, maxAgeHours: number, log?: (m: string) => void): Promise<{ holders: string[]; fetchedAt: number }> {
  const dir = path.join(cacheDir, "holders");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, assetId.replace(/[^A-Za-z0-9.-]/g, "_") + ".json");
  try {
    const c = JSON.parse(fs.readFileSync(file, "utf8"));
    if (Date.now() / 1000 - c.fetchedAt < maxAgeHours * 3600) return c;
  } catch {
    /* refresh */
  }
  const holders: string[] = [];
  let offset = 0;
  for (;;) {
    const j = await requestJson(`${HIRO}/extended/v1/tokens/ft/${assetId}/holders?limit=200&offset=${offset}`);
    for (const h of j.results ?? []) if (BigInt(h.balance) > 0n) holders.push(h.address);
    offset += (j.results ?? []).length;
    if (!j.results?.length || offset >= j.total) break;
    if (offset % 2000 === 0) log?.(`  holders ${assetId}: ${offset}/${j.total}`);
  }
  const out = { holders, fetchedAt: Math.floor(Date.now() / 1000) };
  fs.writeFileSync(file, JSON.stringify(out));
  return out;
}
