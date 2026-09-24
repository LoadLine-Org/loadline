// Light migration replay.
//
// For each configured switch, read the market's live-contract pointers with TODAY's config at the
// block before each step and at the step's block. Every value is a pinned-block chain read, so
// `verify` re-reads them all. Also records when the new entry contract was deployed, to show how
// much warning a deploy-watcher had before the switch.

import fs from "node:fs";
import path from "node:path";
import { getBlock, HIRO, Reader } from "../lib/chain.ts";
import { requestJson } from "../lib/http.ts";
import { getTx } from "../engine/txscan.ts";
import { ADAPTERS, loadConfig, ROOT } from "../markets/index.ts";
import type { MarketId, PointerResult } from "../markets/types.ts";

type StepCfg = { label: string; txid?: string; height?: number };
type SwitchCfg = { id: string; market: MarketId; title: string; newContract: string; steps: StepCfg[] };

export type Checkpoint = { height: number; indexBlockHash: string; time: number; pointers: { label: string; read: string; actual: string; match: boolean }[]; state: "VERIFIED" | "UNVERIFIED"; mismatches: number };

export async function replaySwitch(s: SwitchCfg, cacheDir: string) {
  const ad = ADAPTERS[s.market];
  const cfg = loadConfig(s.market);
  const read = async (height: number): Promise<Checkpoint> => {
    const b = await getBlock(height);
    const ps: PointerResult[] = await ad.pointers(new Reader(b), cfg);
    const pointers = ps.map((p) => ({ label: p.label, read: p.read, actual: p.actual, match: p.match }));
    const mismatches = pointers.filter((p) => !p.match).length;
    return { height, indexBlockHash: b.indexBlockHash, time: b.blockTime, pointers, state: mismatches ? "UNVERIFIED" : "VERIFIED", mismatches };
  };
  const deploy = await requestJson(`${HIRO}/extended/v1/contract/${s.newContract}`);
  const dtx = await getTx(cacheDir, deploy.tx_id);
  const steps = [];
  for (const st of s.steps) {
    let height = st.height;
    let tx = null;
    if (st.txid) {
      const t = await getTx(cacheDir, st.txid);
      if (t.status !== "success") throw new Error(`${s.id}: step tx ${st.txid} is ${t.status}`);
      height = t.h;
      tx = { txid: t.txid, height: t.h, time: t.t, fn: t.fn, cid: t.cid };
    }
    const before = await read(height! - 1);
    const at = await read(height!);
    const changed = at.pointers.filter((p, i) => p.actual !== before.pointers[i].actual).map((p) => p.label);
    steps.push({ label: st.label, tx, before, at, changed });
  }
  const first = steps[0];
  return {
    id: s.id,
    market: s.market,
    title: s.title,
    configGeneration: cfg.generation.id,
    newContract: s.newContract,
    newContractDeploy: { txid: dtx.txid, height: dtx.h, time: dtx.t },
    warningMinutes: Math.round((first.at.time - dtx.t) / 60),
    steps,
  };
}

export async function runReplay(o: { outDir: string; cacheDir: string; log?: (m: string) => void }) {
  const log = o.log ?? console.log;
  const conf = JSON.parse(fs.readFileSync(path.join(ROOT, "config/replay.json"), "utf8"));
  const switches = [];
  for (const s of conf.switches as SwitchCfg[]) {
    log(`replay ${s.id}`);
    switches.push(await replaySwitch(s, o.cacheDir));
  }
  const out = { schema: 1, generatedAt: new Date().toISOString(), note: conf.note, switches };
  fs.mkdirSync(path.join(o.outDir, "replay"), { recursive: true });
  fs.writeFileSync(path.join(o.outDir, "replay", "replay.json"), JSON.stringify(out, null, 1) + "\n");
  return out;
}
