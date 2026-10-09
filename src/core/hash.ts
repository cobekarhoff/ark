/**
 * hash.ts — canonical JSON and a pure SHA-256. @layer core.
 *
 * Exists because `Pipeline.hash` is "of the canonical form" and core may not import `node:crypto`
 * (tsconfig.core.json). Shell code that needs a digest of FILE BYTES uses node:crypto; this one hashes
 * strings and is only for values core itself must derive (the pipeline hash, gate-pin comparison).
 */
import type { Sha256 } from "./ids.ts";

/** JSON with object keys sorted at every depth; the same value always yields the same string. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (typeof v === "object" && v !== null) {
    const o = v as Record<string, unknown>;
    const parts = Object.keys(o).sort().filter((k) => o[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`);
    return `{${parts.join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

const frac32 = (x: number): number => Math.floor((x - Math.floor(x)) * 2 ** 32);
const PRIMES: number[] = [];
for (let n = 2; PRIMES.length < 64; n++) if (PRIMES.every((p) => n % p !== 0)) PRIMES.push(n);
const K = PRIMES.map((p) => frac32(Math.cbrt(p)));
const H0 = PRIMES.slice(0, 8).map((p) => frac32(Math.sqrt(p)));
const rotr = (x: number, n: number): number => (x >>> n) | (x << (32 - n));

/** "sha256:<hex>" of the UTF-8 encoding of `msg`. */
export function sha256(msg: string): Sha256 {
  const utf8 = unescape(encodeURIComponent(msg));
  const bytes: number[] = [];
  for (let i = 0; i < utf8.length; i++) bytes.push(utf8.charCodeAt(i));
  const bitLen = bytes.length * 8;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  const hi = Math.floor(bitLen / 2 ** 32);
  for (const w of [hi, bitLen >>> 0]) for (let s = 24; s >= 0; s -= 8) bytes.push((w >>> s) & 0xff);

  const h = [...H0];
  const w = new Array<number>(64).fill(0);
  for (let off = 0; off < bytes.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = (bytes[off + 4 * i]! << 24) | (bytes[off + 4 * i + 1]! << 16) | (bytes[off + 4 * i + 2]! << 8) | bytes[off + 4 * i + 3]!;
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15]!, b = w[i - 2]!;
      w[i] = (w[i - 16]! + (rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3)) + w[i - 7]! + (rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10))) | 0;
    }
    let [a, b, c, d, e, f, g, hh] = h as [number, number, number, number, number, number, number, number];
    for (let i = 0; i < 64; i++) {
      const t1 = (hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i]! + w[i]!) | 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      hh = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    [a, b, c, d, e, f, g, hh].forEach((v, i) => { h[i] = (h[i]! + v) | 0; });
  }
  return `sha256:${h.map((v) => (v >>> 0).toString(16).padStart(8, "0")).join("")}` as Sha256;
}
