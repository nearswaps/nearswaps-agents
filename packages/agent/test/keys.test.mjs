// The key store and the key check: the kit runs only with a function-call key for nekoorders.near naming exactly
// trade, withdraw and recover_trade. A full-access key, another contract, an extra method, a missing method (such as
// the Terminal's own two-method 1-click key), or a key that is not on the account is refused at start.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { Agent, checkPermission, agentKeysOf, newKeyPair, saveKey, loadKey, keyPath } from "../dist/index.js";
import { fakeNet, tempHome } from "./helpers.mjs";

const K3 = ["trade", "withdraw", "recover_trade"];
const EXACT = /exactly trade, withdraw and recover_trade/;
const fc = (receiver_id, method_names, allowance = null) => ({ nonce: 7, permission: { FunctionCall: { receiver_id, method_names, allowance } } });

test("the exact agent permission passes, in any order, with or without a fee cap", () => {
  assert.equal(checkPermission(fc("nekoorders.near", K3)).ok, true);
  assert.equal(checkPermission(fc("nekoorders.near", ["recover_trade", "withdraw", "trade"], "1000000000000000000000000")).ok, true);
});

test("every wider or different key is refused", () => {
  const cases = [
    [{ nonce: 1, permission: "FullAccess" }, /full-access/],
    [fc("evil.near", K3), /evil\.near/],
    [fc("nekoorders.near", [...K3, "deposit_trading"]), EXACT],
    [fc("nekoorders.near", ["trade", "withdraw"]), EXACT],
    [fc("nekoorders.near", ["trade"]), EXACT],
    [fc("nekoorders.near", ["trade", "withdraw", "withdraw"]), EXACT],
    [fc("nekoorders.near", ["trade", "withdraw", "recover"]), EXACT],
    [fc("nekoorders.near", []), /every method/],
    [null, /not on the account/],
  ];
  for (const [ak, why] of cases) { const c = checkPermission(ak); assert.equal(c.ok, false, JSON.stringify(ak)); assert.match(c.reason, why); }
});

test("agentKeysOf lists only keys with the agent permission (not the Terminal's two-method 1-click key)", () => {
  const list = { keys: [{ public_key: "ed25519:A", access_key: fc("nekoorders.near", K3) }, { public_key: "ed25519:T", access_key: fc("nekoorders.near", ["trade", "withdraw"]) },
    { public_key: "ed25519:B", access_key: { permission: "FullAccess" } }, { public_key: "ed25519:C", access_key: fc("nekoorders.near", ["trade"]) }] };
  assert.deepEqual(agentKeysOf(list), ["ed25519:A"]);
});

test("key new writes ~/.nearswaps-agent/<account>.json, mode 600 (not on Windows), and never overwrites", () => {
  const home = tempHome();
  const k = newKeyPair("agent-demo.near");
  assert.match(k.publicKey, /^ed25519:[1-9A-HJ-NP-Za-km-z]{43,44}$/);
  const path = saveKey(k, home);
  assert.equal(path, keyPath("agent-demo.near", home));
  if (process.platform !== "win32") assert.equal(statSync(path).mode & 0o777, 0o600);
  const body = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(body.public_key, k.publicKey);
  assert.deepEqual(body.methods, K3);
  assert.throws(() => saveKey(newKeyPair("agent-demo.near"), home), /already exists/);
  assert.equal(loadKey("agent-demo.near", home).publicKey, k.publicKey);
});

test("a key file whose public key isn't its private key's is refused", () => {
  const home = tempHome();
  const a = newKeyPair("x.near"), b = newKeyPair("x.near");
  const path = saveKey(a, home);
  const body = JSON.parse(readFileSync(path, "utf8"));
  body.public_key = b.publicKey;
  writeFileSync(path, JSON.stringify(body));
  assert.throws(() => loadKey("x.near", home), /does not belong/);
  assert.throws(() => loadKey("nobody.near", home), /no agent key/);
  assert.equal(existsSync(keyPath("nobody.near", home)), false);
});

function chainWith(accessKey) {
  return fakeNet({ rpc: { "query.view_access_key": () => accessKey, block: () => ({ header: { hash: "11111111111111111111111111111111" } }) } });
}

test("on start the agent refuses a full-access key", async () => {
  const k = newKeyPair("agent-demo.near");
  const net = chainWith({ nonce: 1, permission: "FullAccess", block_height: 1 });
  await assert.rejects(Agent.open({ accountId: "agent-demo.near", key: k, fetch: net.fetch, home: tempHome() }), /refusing to run with this key.*full-access/);
});

test("on start the agent refuses a key with more or fewer methods, or another contract", async () => {
  const k = newKeyPair("agent-demo.near");
  await assert.rejects(Agent.open({ accountId: "agent-demo.near", key: k, fetch: chainWith(fc("nekoorders.near", [...K3, "execute"])).fetch, home: tempHome() }), /refusing to run/);
  await assert.rejects(Agent.open({ accountId: "agent-demo.near", key: k, fetch: chainWith(fc("nekoorders.near", ["trade", "withdraw"])).fetch, home: tempHome() }), /refusing to run.*exactly trade, withdraw and recover_trade/);
  await assert.rejects(Agent.open({ accountId: "agent-demo.near", key: k, fetch: chainWith(fc("v2.ref-finance.near", K3)).fetch, home: tempHome() }), /refusing to run/);
});

test("on start the agent says when the key isn't on the account yet", async () => {
  const k = newKeyPair("agent-demo.near");
  const net = fakeNet({ rpc: { "query.view_access_key": () => ({ rpcError: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_ACCESS_KEY", info: {} }, message: "access key does not exist" } }) } });
  await assert.rejects(Agent.open({ accountId: "agent-demo.near", key: k, fetch: net.fetch, home: tempHome() }), /not on agent-demo\.near.*nearswaps\.com\/agents/);
});

test("on start the agent runs with the exact key", async () => {
  const k = newKeyPair("agent-demo.near");
  const a = await Agent.open({ accountId: "agent-demo.near", key: k, fetch: chainWith(fc("nekoorders.near", K3)).fetch, home: tempHome() });
  assert.equal(a.accountId, "agent-demo.near");
});
