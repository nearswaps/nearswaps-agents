// Encodings the kit needs, with no dependency: base58 (keys, hashes), and the borsh layout of the one kind of
// transaction the agent key ever signs (one FunctionCall action, 0 deposit). The layout is NEAR's
// (nearcore `Transaction` V0 / `SignedTransaction`); the test suite checks it byte for byte against
// near-api-js 5.1.1, the bundle the Terminal signs with.

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** Base58 of bytes (oneclick.js b58). */
export function b58encode(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let s = "";
  while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
  for (const b of bytes) { if (b !== 0) break; s = "1" + s; }
  return s;
}

export function b58decode(s: string): Uint8Array {
  let n = 0n;
  for (const c of s) {
    const i = B58.indexOf(c);
    if (i < 0) throw new Error("not base58");
    n = n * 58n + BigInt(i);
  }
  const out: number[] = [];
  while (n > 0n) { out.unshift(Number(n % 256n)); n /= 256n; }
  for (const c of s) { if (c !== "1") break; out.unshift(0); }
  return Uint8Array.from(out);
}

class Writer {
  private parts: number[] = [];
  u8(v: number) { this.parts.push(v & 255); }
  u32(v: number) { for (let i = 0; i < 4; i++) this.parts.push((v >>> (8 * i)) & 255); }
  uint(v: bigint, bytes: number) {
    if (v < 0n || v >= 1n << BigInt(8 * bytes)) throw new Error("number out of range");
    for (let i = 0; i < bytes; i++) { this.parts.push(Number(v & 255n)); v >>= 8n; }
  }
  fixed(b: Uint8Array) { for (const x of b) this.parts.push(x); }
  bytes(b: Uint8Array) { this.u32(b.length); this.fixed(b); }
  str(s: string) { this.bytes(new TextEncoder().encode(s)); }
  done(): Uint8Array { return Uint8Array.from(this.parts); }
}

export interface FunctionCallTx {
  signerId: string;
  /** 32 raw bytes of the ed25519 public key. */
  publicKey: Uint8Array;
  nonce: bigint;
  receiverId: string;
  /** 32 raw bytes (a recent block hash). */
  blockHash: Uint8Array;
  methodName: string;
  args: Uint8Array;
  gas: bigint;
  deposit: bigint;
}

/** Borsh of `Transaction` with exactly one `Action::FunctionCall` (enum index 2). */
export function encodeTransaction(t: FunctionCallTx): Uint8Array {
  if (t.publicKey.length !== 32 || t.blockHash.length !== 32) throw new Error("bad key or block hash length");
  const w = new Writer();
  w.str(t.signerId);
  w.u8(0); w.fixed(t.publicKey);        // PublicKey::ED25519
  w.uint(t.nonce, 8);
  w.str(t.receiverId);
  w.fixed(t.blockHash);
  w.u32(1);                             // one action
  w.u8(2);                              // Action::FunctionCall
  w.str(t.methodName);
  w.bytes(t.args);
  w.uint(t.gas, 8);
  w.uint(t.deposit, 16);
  return w.done();
}

/** Borsh of `SignedTransaction` (the transaction, then Signature::ED25519 and its 64 bytes). */
export function encodeSigned(txBytes: Uint8Array, signature: Uint8Array): Uint8Array {
  if (signature.length !== 64) throw new Error("bad signature length");
  const out = new Uint8Array(txBytes.length + 65);
  out.set(txBytes, 0);
  out[txBytes.length] = 0;
  out.set(signature, txBytes.length + 1);
  return out;
}

export const toB64 = (b: Uint8Array): string => Buffer.from(b).toString("base64");
export const fromB64 = (s: string): Uint8Array => Uint8Array.from(Buffer.from(s, "base64"));
