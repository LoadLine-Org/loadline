// Helpers shared by market adapters.

import type { Reader, RO } from "../lib/chain.ts";
import { Err, ok as unwrapOk } from "../lib/clarity.ts";

/** Read-only calls that must all succeed: unwraps (ok ...) and throws on (err ...) or a runtime error. */
export async function strict(r: Reader, calls: RO[], what: string, chunk?: number): Promise<any[]> {
  const res = await r.ro(calls, chunk);
  return res.map((x, i) => {
    if (!x.ok) throw new Error(`${what} #${i} (${calls[i][0]}.${calls[i][1]}): ${x.error}`);
    return unwrapOk(x.value, `${what} #${i}`);
  });
}

/** Human-readable result of a pointer read, keeping (err ...) visible. */
export function show(x: { ok: boolean; value?: any; error?: string }): string {
  if (!x.ok) return `read failed: ${(x.error ?? "").slice(0, 80)}`;
  if (x.value instanceof Err) return `(err ${clar(x.value.value)})`;
  return clar(unwrapOk(x.value));
}

export const short = (c: string) => c.split(".")[1] ?? c;

/** Clarity-style rendering of a decoded scalar: uints as u123. */
export function clar(v: unknown): string {
  return typeof v === "bigint" ? `u${v}` : String(v);
}
