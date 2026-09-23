// Pyth Lazer payload decoding, limited to what the record publishes: the payload
// timestamp. Envelope: magic 2a22999a | 65-byte signature | u16 length | payload
// (magic 93c7d375 | u64 timestamp in microseconds | ...), big-endian, as in
// stx-labs/stacks-pyth-lazer pyth-lazer-decoder-v1. Prices are not decoded here.

const ENVELOPE = /0x(2a22999a[0-9a-f]+)/;

export function lazerTimestampUs(args: string[]): number | null {
  for (const a of args) {
    const m = ENVELOPE.exec(a);
    if (!m) continue;
    const b = Buffer.from(m[1], "hex");
    if (b.length < 71 + 12) return null;
    const p = b.subarray(71);
    if (p.subarray(0, 4).toString("hex") !== "93c7d375") return null;
    return Number(p.readBigUInt64BE(4));
  }
  return null;
}
