// Clarity value decoding into plain JS values.
// uint/int -> bigint, bool -> boolean, principals -> string, buffers -> "0x.." hex,
// strings -> string, none -> null, some x -> x, tuples -> objects, lists -> arrays.
// Responses are kept tagged (Ok / Err) so an `(err u107)` can never be mistaken
// for a successful value.

import { Cl, hexToCV, serializeCV, type ClarityValue } from "@stacks/transactions";

export class Ok<T = unknown> {
  readonly value: T;
  constructor(value: T) {
    this.value = value;
  }
}
export class Err<T = unknown> {
  readonly value: T;
  constructor(value: T) {
    this.value = value;
  }
}

export type Decoded = any;

export function decodeCV(cv: ClarityValue): Decoded {
  const v = cv as any;
  switch (v.type) {
    case "uint":
    case "int":
      return BigInt(v.value);
    case "true":
      return true;
    case "false":
      return false;
    case "address":
    case "contract":
      return v.value as string;
    case "buffer":
      return "0x" + v.value;
    case "ascii":
    case "utf8":
      return v.value as string;
    case "none":
      return null;
    case "some":
      return decodeCV(v.value);
    case "ok":
      return new Ok(decodeCV(v.value));
    case "err":
      return new Err(decodeCV(v.value));
    case "tuple": {
      const o: Record<string, Decoded> = {};
      for (const [k, x] of Object.entries(v.value)) o[k] = decodeCV(x as ClarityValue);
      return o;
    }
    case "list":
      return (v.value as ClarityValue[]).map(decodeCV);
    default:
      throw new Error(`unknown clarity type ${v.type}`);
  }
}

export function decodeHex(hex: string): Decoded {
  return decodeCV(hexToCV(hex));
}

/** Serialise a Clarity value to hex without the 0x prefix. */
export function hex(cv: ClarityValue): string {
  return serializeCV(cv).replace(/^0x/, "");
}

/** Unwrap a (response ok) or throw with context on (err ...). Non-responses pass through. */
export function ok<T = Decoded>(x: Decoded, ctx = ""): T {
  if (x instanceof Err) throw new Error(`unexpected (err ${String(x.value)}) ${ctx}`);
  if (x instanceof Ok) return x.value as T;
  return x as T;
}

/** Big-endian buffer ("0x..") to bigint, as Clarity's buff-to-uint-be. */
export function buffToUint(b: string): bigint {
  const h = b.replace(/^0x/, "");
  return h.length === 0 ? 0n : BigInt("0x" + h);
}

export { Cl };
