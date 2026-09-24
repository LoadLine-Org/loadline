// Every published file validates against the v1 JSON Schemas, and CSV exports are deterministic.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { snapshotCsvs } from "../src/engine/dataset.ts";

const require = createRequire(import.meta.url);
const Ajv2020 = require("ajv/dist/2020").default;
const addFormats = require("ajv-formats");
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
const schema = (n: string) => ajv.compile(JSON.parse(fs.readFileSync(`schema/v1/${n}.schema.json`, "utf8")));
const DATA = process.env.LOADLINE_TEST_DATA ?? "data/public";
const read = (rel: string) => JSON.parse(fs.readFileSync(path.join(DATA, rel), "utf8"));
const ok = (v: any, x: unknown, what: string) => assert.ok(v(x), `${what}: ${ajv.errorsText(v.errors)}`);

test("latest.json matches the latest schema", () => ok(schema("latest"), read("latest.json"), "latest.json"));

test("every snapshot matches the snapshot schema, and its CSVs are deterministic", () => {
  const v = schema("snapshot");
  const latest = read("latest.json");
  for (const m of Object.values<any>(latest.markets)) {
    if (!m.snapshot) continue;
    const snap = read(m.snapshot);
    ok(v, snap, m.snapshot);
    assert.deepEqual(snapshotCsvs(snap), snapshotCsvs(JSON.parse(JSON.stringify(snap))));
  }
});

test("index.json matches the index schema", { skip: !fs.existsSync(path.join(DATA, "index.json")) }, () => {
  ok(schema("index"), read("index.json"), "index.json");
});

test("oracle/summary.json matches the oracle schema", { skip: !fs.existsSync(path.join(DATA, "oracle/summary.json")) }, () => {
  ok(schema("oracle-summary"), read("oracle/summary.json"), "oracle/summary.json");
});

test("replay.json matches the replay schema", { skip: !fs.existsSync(path.join(DATA, "replay/replay.json")) }, () => {
  ok(schema("replay"), read("replay/replay.json"), "replay/replay.json");
});
