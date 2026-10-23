// Makes signing vectors with near-api-js 5.1.1: createTransaction + functionCall + SignedTransaction.encode,
// as the first vector (test/fixtures/sign-vector.json) was made. Not part of the test run. Usage, from a scratch folder
// with near-api-js 5.1.1 installed (npm install near-api-js@5.1.1): node make-sign-vectors.cjs <that folder> <out dir>
const { createRequire } = require("node:module");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const [installDir, outDir] = process.argv.slice(2);
const req = createRequire(path.join(installDir, "package.json"));
const nearApi = req("near-api-js");
const { transactions, KeyPair, utils } = nearApi;
const pkg = JSON.parse(fs.readFileSync(path.join(installDir, "node_modules", "near-api-js", "package.json"), "utf8"));
if (pkg.version !== "5.1.1") throw new Error("expected near-api-js 5.1.1, found " + pkg.version);

// The same fixed test key as the first vector (it holds nothing).
const SECRET = "ed25519:2K5t4gfxE4JDth1vyNDnBp3SRjrt3ZjsZt7pzuYtkz5vdFN9bNr8B6FHmeNgFYXS1aoH62RNcNB5YNUXTT3rpj4k";
const kp = KeyPair.fromString(SECRET);

function make(name, note, { signer_id, receiver_id, nonce, block_hash, method_name, args, gas, deposit }) {
  const action = transactions.functionCall(method_name, args, BigInt(gas), BigInt(deposit));
  const tx = transactions.createTransaction(signer_id, kp.getPublicKey(), receiver_id, BigInt(nonce), [action], utils.serialize.base_decode(block_hash));
  const bytes = tx.encode();
  const hash = createHash("sha256").update(bytes).digest();
  const sig = kp.sign(new Uint8Array(hash));
  const signed = new transactions.SignedTransaction({ transaction: tx, signature: new transactions.Signature({ keyType: kp.getPublicKey().keyType, data: sig.signature }) });
  const v = {
    note, secret_key: SECRET, public_key: kp.getPublicKey().toString(), signer_id, receiver_id, nonce, block_hash, method_name, args, gas, deposit,
    args_bytes: Buffer.byteLength(JSON.stringify(args)),
    tx_base64: Buffer.from(bytes).toString("base64"),
    hash: utils.serialize.base_encode(hash),
    signed_base64: Buffer.from(signed.encode()).toString("base64"),
  };
  fs.writeFileSync(path.join(outDir, name), JSON.stringify(v, null, 1) + "\n");
  console.log(name, "args", v.args_bytes, "bytes, tx", bytes.length, "bytes, hash", v.hash);
}

// A fixed 32-byte block hash: sha256 of a label.
const fixedHash = (label) => utils.serialize.base_encode(createHash("sha256").update("nearswaps sign vector: " + label).digest());
const USDC = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const hop = (pool_id, token_in, token_out) => ({ pool_id, token_in, token_out });
// A long args payload: a three-leg Rhea route of three hops each (over 1 KB of JSON, so the borsh length takes two bytes).
const legs = [
  { amount_in: "400000000000000000000000", hops: [hop(4512, "wrap.near", USDC), hop(3433, USDC, "usdt.tether-token.near"), hop(4179, "usdt.tether-token.near", "blackdragon.tkn.near")] },
  { amount_in: "350000000000000000000000", hops: [hop(3879, "wrap.near", "token.rhealab.near"), hop(5949, "token.rhealab.near", USDC), hop(5470, USDC, "blackdragon.tkn.near")] },
  { amount_in: "250000000000000000000000", hops: [hop(4663, "wrap.near", "ftv2.nekotoken.near"), hop(4887, "ftv2.nekotoken.near", "dac17f958d2ee523a2206206994597c13d831ec7.factory.bridge.near"), hop(4180, "dac17f958d2ee523a2206206994597c13d831ec7.factory.bridge.near", "blackdragon.tkn.near")] },
];
make("sign-vector-long-args.json", "Generated with near-api-js 5.1.1 (the bundle the Terminal signs with): createTransaction + functionCall + SignedTransaction.encode. A long args payload: a three-leg, nine-hop Rhea route.", {
  signer_id: "agent-demo.near", receiver_id: "nekoorders.near", nonce: "181818181818", block_hash: fixedHash("long args"),
  method_name: "trade",
  args: { venue: { Rhea: { route: legs } }, token_in: "wrap.near", token_out: "blackdragon.tkn.near", amount_in: "1000000000000000000000000", min_out: "123456789012345678901234567890", fee_bps: 50, referrer: null },
  gas: "300000000000000", deposit: "0",
});
// A nonce above 2^32 (and above 2^53, where a JS number would lose it): 2^60 + 987654321.
make("sign-vector-big-nonce.json", "Generated with near-api-js 5.1.1 (the bundle the Terminal signs with): createTransaction + functionCall + SignedTransaction.encode. A nonce above 2^32 and 2^53 (2^60 + 987654321).", {
  signer_id: "agent-demo.near", receiver_id: "nekoorders.near", nonce: (2n ** 60n + 987654321n).toString(), block_hash: fixedHash("big nonce"),
  method_name: "withdraw", args: { token: "wrap.near", amount: null },
  gas: "150000000000000", deposit: "0",
});
