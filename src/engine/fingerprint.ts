// Content hash of the code and config that produce a snapshot. Stamped into every
// snapshot so `verify` can tell whether it is running the same logic that
// produced the numbers (useful until there is a public commit to point at).

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "../markets/index.ts";

function files(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? files(p) : /\.(ts|json)$/.test(e.name) ? [p] : [];
  });
}

export function codeFingerprint(): string {
  const h = crypto.createHash("sha256");
  for (const f of [...files(path.join(ROOT, "src")), ...files(path.join(ROOT, "config"))].sort()) {
    h.update(path.relative(ROOT, f));
    h.update("\0");
    h.update(fs.readFileSync(f));
  }
  return h.digest("hex");
}
