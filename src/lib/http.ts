// Throttled HTTP with per-host minimum spacing, retry-after handling and a
// request ledger. Every outbound request in the project goes through here so
// that request volume stays low and is reported per run.

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

type HostPolicy = { gapMs: number; last: number; chain: Promise<void> };

// Minimum spacing per host. Hiro anonymous is 50/min per IP, so 1.3 s keeps us
// at ~46/min even if nothing else is running. stxer returned 429s on bursts
// during research, so it gets a similar gap. CEX venues are spaced gently too.
const DEFAULT_GAP_MS: Record<string, number> = {
  "api.hiro.so": 1300,
  "api.stxer.xyz": 1500,
  "api.exchange.coinbase.com": 600,
};
const FALLBACK_GAP_MS = 400;

const policies = new Map<string, HostPolicy>();
export const ledger = new Map<string, { requests: number; retries: number; bytes: number }>();

export function setHostGap(host: string, gapMs: number): void {
  policy(host).gapMs = gapMs;
}

function policy(host: string): HostPolicy {
  let p = policies.get(host);
  if (!p) {
    p = { gapMs: DEFAULT_GAP_MS[host] ?? FALLBACK_GAP_MS, last: 0, chain: Promise.resolve() };
    policies.set(host, p);
  }
  return p;
}

function account(host: string, field: "requests" | "retries", bytes = 0): void {
  const e = ledger.get(host) ?? { requests: 0, retries: 0, bytes: 0 };
  e[field]++;
  e.bytes += bytes;
  ledger.set(host, e);
}

// Serialise requests per host and enforce the gap between them.
async function slot(host: string): Promise<void> {
  const p = policy(host);
  const prev = p.chain;
  let release!: () => void;
  p.chain = new Promise<void>((r) => (release = r));
  await prev;
  const wait = p.gapMs - (Date.now() - p.last);
  if (wait > 0) await sleep(wait);
  p.last = Date.now();
  release();
}

export class HttpError extends Error {
  status: number;
  url: string;
  constructor(status: number, url: string, body: string) {
    super(`HTTP ${status} for ${url}: ${body.slice(0, 200)}`);
    this.status = status;
    this.url = url;
  }
}

export type RequestOpts = {
  method?: "GET" | "POST";
  body?: unknown;
  headers?: Record<string, string>;
  /** Return null instead of throwing on 404. */
  allow404?: boolean;
  maxAttempts?: number;
  timeoutMs?: number;
};

const USER_AGENT = "loadline-indexer/0.1 (read-only; low request rate)";

export async function requestText(url: string, opts: RequestOpts = {}): Promise<string | null> {
  const host = new URL(url).host;
  const maxAttempts = opts.maxAttempts ?? 8;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await slot(host);
    let res: Response;
    try {
      res = await fetch(url, {
        method: opts.method ?? (opts.body === undefined ? "GET" : "POST"),
        headers: {
          "user-agent": USER_AGENT,
          ...(opts.body === undefined ? {} : { "content-type": "application/json" }),
          ...opts.headers,
        },
        body: opts.body === undefined ? undefined : typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body),
        signal: AbortSignal.timeout(opts.timeoutMs ?? 60_000),
      });
    } catch (e) {
      lastErr = e;
      account(host, "retries");
      await sleep(Math.min(30_000, 2000 * attempt));
      continue;
    }
    const text = await res.text();
    account(host, "requests", text.length);
    if (res.status === 404 && opts.allow404) return null;
    if (res.status === 429 || res.status >= 500) {
      account(host, "retries");
      const ra = Number(res.headers.get("retry-after"));
      const backoff = Number.isFinite(ra) && ra > 0 ? (ra + 1) * 1000 : Math.min(60_000, 3000 * attempt);
      // Slow the whole host down after a 429 so later requests do not burst.
      if (res.status === 429) policy(host).gapMs = Math.min(10_000, Math.round(policy(host).gapMs * 1.5));
      lastErr = new HttpError(res.status, url, text);
      await sleep(backoff);
      continue;
    }
    if (!res.ok) throw new HttpError(res.status, url, text);
    // Recover gradually from a 429 slowdown once the host answers normally again.
    const base = DEFAULT_GAP_MS[host] ?? FALLBACK_GAP_MS;
    const pol = policy(host);
    if (pol.gapMs > base) pol.gapMs = Math.max(base, Math.round(pol.gapMs * 0.9));
    return text;
  }
  throw lastErr instanceof Error ? lastErr : new Error(`request failed: ${url}`);
}

export async function requestJson<T = any>(url: string, opts: RequestOpts = {}): Promise<T | null> {
  const text = await requestText(url, opts);
  if (text === null) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`non-JSON response from ${url}: ${text.slice(0, 200)}`);
  }
}

export function ledgerSummary(): Record<string, { requests: number; retries: number; kb: number }> {
  const out: Record<string, { requests: number; retries: number; kb: number }> = {};
  for (const [h, e] of ledger) out[h] = { requests: e.requests, retries: e.retries, kb: Math.round(e.bytes / 1024) };
  return out;
}
