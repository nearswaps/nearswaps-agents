// Sign once, send once (the port of oneclick.js signAndSendOnce / sendSigned / followTx / keyCall): a dropped
// answer is followed by the hash and never signed or sent again; the same signed bytes may go to the other node
// once; a fresh signature only after the node refuses the nonce, or after the contract's own "try again in a
// moment" (both before anything ran), and only once.
import { test } from "node:test";
import assert from "node:assert/strict";
import { newKeyPair, Rpc, Signer, b58encode } from "../dist/index.js";
import { fakeNet, txOutcome } from "./helpers.mjs";

const URLS = ["https://a.example", "https://b.example"];
const BLOCK = b58encode(new Uint8Array(32).fill(7));
const key = newKeyPair("agent-demo.near");

/** Decode the nonce out of a signed transaction (borsh: signer_id, public key, nonce, ...). */
function nonceOf(b64) {
  const b = Buffer.from(b64, "base64");
  const n = b.readUInt32LE(0);
  return b.readBigUInt64LE(4 + n + 33);
}

function world(send, opts = {}) {
  let viewNonce = opts.viewNonce ?? 100;
  let clock = 0;
  const net = fakeNet({ rpc: {
    block: () => ({ header: { hash: BLOCK } }),
    "query.view_access_key": () => ({ nonce: typeof viewNonce === "function" ? viewNonce() : viewNonce, permission: { FunctionCall: { receiver_id: "nekoorders.near", method_names: ["trade", "withdraw", "recover_trade"] } } }),
    send_tx: (p, url) => send(p, url),
    tx: (p, url) => (opts.tx ? opts.tx(p, url) : { transportError: true }),
    EXPERIMENTAL_tx_status: () => ({ receipts_outcome: [] }),
  } });
  const rpc = new Rpc({ urls: URLS, fetch: net.fetch });
  const signer = new Signer(rpc, key, { sleep: async () => { clock += 2500; }, now: () => clock });
  const sends = () => net.log.filter((x) => x.method === "send_tx");
  return { net, rpc, signer, sends, setNonce: (n) => { viewNonce = n; } };
}
const args = { venue: { Shift: { from: "rhea", to: "here" } }, token_in: "wrap.near", token_out: "wrap.near", amount_in: "1", min_out: "1", fee_bps: null, referrer: null };

test("one signature, one send; the nonce is the key's next", async () => {
  const w = world(() => txOutcome("H", []));
  const res = await w.signer.keyCall("trade", args, 300n * 10n ** 12n);
  assert.equal(res.transaction.hash, "H");
  assert.equal(w.sends().length, 1);
  assert.equal(nonceOf(w.sends()[0].params.signed_tx_base64), 101n);
  assert.equal(w.sends()[0].params.wait_until, "EXECUTED_OPTIMISTIC");
});

test("never below the last nonce this process signed, even when the view lags", async () => {
  const w = world(() => txOutcome("H", []));
  await w.signer.keyCall("trade", args, 1n);
  await w.signer.keyCall("trade", args, 1n);
  assert.deepEqual(w.sends().map((s) => nonceOf(s.params.signed_tx_base64)), [101n, 102n]);
});

test("no answer from the first node: the SAME signed bytes go to the other node, nothing is signed again", async () => {
  const w = world((p, url) => (url === URLS[0] ? { transportError: true } : txOutcome("H", [])));
  const res = await w.signer.keyCall("trade", args, 1n);
  assert.equal(res.transaction.hash, "H");
  const s = w.sends();
  assert.equal(s.length, 2);
  assert.deepEqual(s.map((x) => x.url), URLS);
  assert.equal(s[0].params.signed_tx_base64, s[1].params.signed_tx_base64);
});

test("no answer from either node: the hash is followed until final, never sent again", async () => {
  let polls = 0;
  const w = world(() => ({ transportError: true }), { tx: () => (++polls < 3 ? { transportError: true } : txOutcome("H", [])) });
  const res = await w.signer.keyCall("trade", args, 1n);
  assert.equal(res.transaction.hash, "H");
  assert.equal(w.sends().length, 2, "one send per node, same bytes");
  assert.equal(new Set(w.sends().map((s) => s.params.signed_tx_base64)).size, 1);
  assert.ok(w.net.log.filter((x) => x.method === "tx").every((x) => x.params.wait_until === "EXECUTED_OPTIMISTIC" && x.params.sender_account_id === "agent-demo.near"));
});

test("followed for two minutes without an answer: pending with the hash, still not sent again", async () => {
  const w = world(() => ({ transportError: true }));
  await assert.rejects(w.signer.keyCall("trade", args, 1n), (e) => e.settling === true && typeof e.hash === "string" && /Don't send it again/.test(e.message));
  assert.equal(w.sends().length, 2);
});

test("every node busy (rate limited): nothing was sent, and it says so", async () => {
  const w = world(() => ({ rpcError: { code: -429, message: "rate limit" } }));
  await assert.rejects(w.signer.keyCall("trade", args, 1n), /busy \(rate limited\), so nothing was sent/);
  assert.equal(w.sends().length, 2);
});

test("a nonce the node refuses: signed afresh once, before anything ran", async () => {
  let n = 0;
  // The view lags the chain: the first read says 100, the node knows 150.
  let reads = 0;
  const w = world(() => (++n === 1 ? { rpcError: { name: "HANDLER_ERROR", cause: { name: "INVALID_TRANSACTION", info: {} }, data: { TxExecutionError: { InvalidTxError: { InvalidNonce: { tx_nonce: 101, ak_nonce: 150 } } } } } } : txOutcome("H", [])),
    { viewNonce: () => (++reads === 1 ? 100 : 150) });
  await w.signer.keyCall("trade", args, 1n);
  const s = w.sends();
  assert.equal(s.length, 2);
  assert.equal(nonceOf(s[0].params.signed_tx_base64), 101n);
  assert.notEqual(s[0].params.signed_tx_base64, s[1].params.signed_tx_base64);
  assert.equal(nonceOf(s[1].params.signed_tx_base64), 151n);
});

test("the contract's \"try again in a moment\": signed afresh once after the wait, then no more", async () => {
  const busy = txOutcome("H1", [], { ActionError: { kind: { FunctionCallError: { ExecutionError: "Smart contract panicked: an auto order is moving wrap.near right now; try again in a moment" } } } });
  let n = 0;
  const w = world(() => (++n === 1 ? busy : txOutcome("H2", [])));
  const res = await w.signer.keyCall("trade", args, 1n);
  assert.equal(res.transaction.hash, "H2");
  assert.equal(w.sends().length, 2);
  const w2 = world(() => busy);
  await assert.rejects(w2.signer.keyCall("trade", args, 1n), (e) => e.onchain === true);
  assert.equal(w2.sends().length, 2, "one retry only");
});

test("any other on-chain refusal is not retried", async () => {
  const w = world(() => txOutcome("H", [], { ActionError: { kind: { FunctionCallError: { ExecutionError: "Smart contract panicked: Above the per-trade cap" } } } }));
  await assert.rejects(w.signer.keyCall("trade", args, 1n), (e) => e.onchain === true && /per-trade cap/.test(e.message));
  assert.equal(w.sends().length, 1);
});

test("a refusal outright (allowance, balance) is not retried and says nothing was sent", async () => {
  const w = world(() => ({ rpcError: { name: "HANDLER_ERROR", cause: { name: "INVALID_TRANSACTION", info: {} }, data: { TxExecutionError: { InvalidTxError: { NotEnoughBalance: {} } } } } }));
  await assert.rejects(w.signer.keyCall("trade", args, 1n), /nothing was sent/);
  assert.equal(w.sends().length, 1);
});

test("the key gone from the account: refused before signing", async () => {
  const net = fakeNet({ rpc: { block: () => ({ header: { hash: BLOCK } }), "query.view_access_key": () => ({ rpcError: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_ACCESS_KEY", info: {} }, message: "does not exist" } }), send_tx: () => { throw new Error("must not send"); } } });
  const signer = new Signer(new Rpc({ urls: URLS, fetch: net.fetch }), key, { sleep: async () => {} });
  await assert.rejects(signer.keyCall("trade", args, 1n), /isn't on agent-demo\.near any more/);
});
