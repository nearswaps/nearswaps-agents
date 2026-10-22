// The kit signs without near-api-js (its 5.1.1 bundle pulls in a native secp256k1 module). Its transaction bytes,
// hash and signed bytes are checked here against a vector made with near-api-js 5.1.1 itself, the bundle the
// Terminal signs with (test/fixtures/sign-vector.json). The vector's key is a fixed test key that holds nothing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { encodeTransaction, encodeSigned, b58decode, b58encode, publicKeyBytes } from "../dist/index.js";
import { fixture } from "./helpers.mjs";

const v = fixture("sign-vector.json");

test("transaction bytes, hash and signed bytes match near-api-js 5.1.1", async () => {
  const { signBytes } = await import("../dist/keys.js");
  const key = { accountId: v.signer_id, publicKey: v.public_key, secretKey: v.secret_key };
  const tx = encodeTransaction({ signerId: v.signer_id, publicKey: publicKeyBytes(v.public_key), nonce: BigInt(v.nonce), receiverId: v.receiver_id,
    blockHash: b58decode(v.block_hash), methodName: v.method_name, args: new TextEncoder().encode(JSON.stringify(v.args)), gas: BigInt(v.gas), deposit: BigInt(v.deposit) });
  assert.equal(Buffer.from(tx).toString("base64"), v.tx_base64);
  const hash = createHash("sha256").update(tx).digest();
  assert.equal(b58encode(hash), v.hash);
  const signed = encodeSigned(tx, signBytes(key, hash));
  assert.equal(Buffer.from(signed).toString("base64"), v.signed_base64);
});

test("base58 round trip, leading zeros kept", () => {
  for (const hex of ["", "00", "0000ff", "ffffffff", "0001020304"]) {
    const b = Uint8Array.from(Buffer.from(hex, "hex"));
    assert.deepEqual(Buffer.from(b58decode(b58encode(b))).toString("hex"), hex);
  }
});

test("amounts that don't fit are refused, not wrapped", () => {
  const base = { signerId: "a.near", publicKey: new Uint8Array(32), nonce: 1n, receiverId: "nekoorders.near", blockHash: new Uint8Array(32), methodName: "trade", args: new Uint8Array(), gas: 1n, deposit: 0n };
  assert.throws(() => encodeTransaction({ ...base, gas: 1n << 64n }));
  assert.throws(() => encodeTransaction({ ...base, nonce: -1n }));
});
