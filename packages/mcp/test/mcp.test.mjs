// The MCP server through the SDK's own client: the tool list in both modes (stdio for the real bin, in memory for a
// server around a test agent), a blocked buy that names the rule, and read tools with no key. Offline: the agent
// and the reads run against the agent package's fake chain built from recorded fixtures; nothing reaches mainnet.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Agent, Kit, DEFAULT_POLICY, newKeyPair, b58encode } from "@nearswaps/agent";
import { createServer, READ_TOOLS, MONEY_TOOLS } from "../dist/server.js";
import { fakeNet, fixture, tempHome, txOutcome, NEAR } from "../../agent/test/helpers.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = join(HERE, "..", "dist", "bin.js");
const USDC = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const CFG = fixture("trading-config.json");
const FX = fixture("routes/01-buy-usdc-with-1-near.json");
const MONEY_KEYS = ["outcome", "reason", "tx", "amount_in", "amount_out", "fee", "score", "policy_checks"];

/** A fake chain and read API (route fixture 01, 1 NEAR to USDC), as the agent package's result tests build it. */
function world(policy = {}) {
  const home = tempHome();
  const policyFile = join(home, ".nearswaps-agent", "policy.json");
  mkdirSync(dirname(policyFile), { recursive: true });
  writeFileSync(policyFile, JSON.stringify({ ...DEFAULT_POLICY, trusted: [], ...policy }));
  const sent = [];
  const net = fakeNet({
    views: {
      "nekoorders.near.get_trading_config": CFG,
      "nekoorders.near.get_trading": () => [{ token: "wrap.near", amount: (2n * NEAR).toString() }],
      "nekoorders.near.get_trading_parts": () => [{ token: "wrap.near", here: (2n * NEAR).toString(), rhea: "0", intear: "0" }],
      "nekoorders.near.are_open": ({ tokens }) => tokens.map(() => false),
      "nekoorders.near.trade_gas_tgas": () => 110,
      "nekoorders.near.get_pending": () => [],
      [USDC + ".ft_metadata"]: { symbol: "USDC", decimals: 6 },
      "nekonftstaking.near.get_stake": { fee_discount_bps: 0 },
      "v2.ref-finance.near.get_pool_by_ids": ({ pool_ids }) => pool_ids.map((id) => (FX.pool_kinds[id] === "SIMPLE_POOL" ? FX.pools[id] : null)),
      "v2.ref-finance.near.get_stable_pool": ({ pool_id }) => { if (!FX.pools[pool_id]) throw new Error("no pool"); return FX.pools[pool_id]; },
    },
    rpc: {
      block: () => ({ header: { hash: b58encode(new Uint8Array(32).fill(3)) } }),
      "query.view_access_key": () => ({ nonce: 5, permission: { FunctionCall: { receiver_id: "nekoorders.near", method_names: ["trade", "withdraw", "recover_trade"], allowance: null } } }),
      "query.view_account": () => ({ amount: (5n * NEAR).toString(), storage_usage: 0 }),
      send_tx: () => { sent.push(1); return txOutcome("TX" + sent.length, []); },
      tx: () => ({ transportError: true }),
    },
    http: [
      ["https://nearswaps.com/assets/swap-pools.json", fixture("swap-pools.json")],
      ["https://nearswaps.com/api/safety", (url) => ({ token: new URL(url).searchParams.get("token"), score: 88, verdict: "nothing dangerous found", checked_at: "2026-11-02T12:00:00Z", findings: [], note: "" })],
    ],
  });
  return { net, sent, home, policyFile };
}

async function connect(server) {
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}
async function agentClient(policy) {
  const w = world(policy);
  const agent = await Agent.open({ accountId: "agent-demo.near", key: newKeyPair("agent-demo.near"), fetch: w.net.fetch, home: w.home, policyFile: w.policyFile, sleep: async () => {}, now: () => Date.parse("2026-11-02T12:00:00Z") });
  return { w, client: await connect(createServer({ kit: agent, agent, policyFile: w.policyFile })) };
}
const body = (r) => JSON.parse(r.content[0].text);

test("--read-only over stdio: the eight read tools, each read-only, and no money tool", async () => {
  const client = new Client({ name: "test", version: "0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [BIN, "--read-only", "--home", tempHome()], stderr: "pipe" }));
  try {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), [...READ_TOOLS].sort());
    for (const t of tools) {
      assert.equal(t.annotations.readOnlyHint, true, t.name);
      assert.equal(t.annotations.destructiveHint, false, t.name);
      assert.match(t.description, /^Read-only: /, t.name);
    }
    assert.match(client.getInstructions(), /read-only: no key is loaded and no money tool is registered/);
  } finally { await client.close(); }
});

test("with an agent: twelve tools; readOnlyHint on the reads, destructiveHint on buy, sell and withdraw", async () => {
  const { client } = await agentClient();
  const { tools } = await client.listTools();
  const by = Object.fromEntries(tools.map((t) => [t.name, t]));
  assert.deepEqual(Object.keys(by).sort(), [...READ_TOOLS, ...MONEY_TOOLS].sort());
  for (const n of READ_TOOLS) assert.equal(by[n].annotations.readOnlyHint, true, n);
  for (const n of ["buy", "sell", "withdraw"]) { assert.equal(by[n].annotations.readOnlyHint, false, n); assert.equal(by[n].annotations.destructiveHint, true, n); }
  assert.equal(by.recover_trade.annotations.readOnlyHint, false);
  assert.equal(by.recover_trade.annotations.destructiveHint, false, "recover_trade only ever credits the owner");
  for (const n of MONEY_TOOLS) { assert.match(by[n].description, /^Moves money/, n); assert.deepEqual(Object.keys(by[n].outputSchema.properties).sort(), [...MONEY_KEYS].sort(), n); }
  for (const t of tools) {
    // One sentence each, plain text: no full stop before the end, no em dash, nothing outside printable ASCII.
    assert.match(t.description, /^[^.]*(\.[a-z0-9_)"][^.]*)*\.$/i, t.name);
    assert.doesNotMatch(t.description, /[^\x20-\x7e]/, t.name);
    assert.doesNotMatch(t.description, /\b(safe|verified|audited)\b/i, t.name);
  }
  assert.match(by.buy.description, /score floor/);
  assert.match(by.buy.description, /per-trade maximum/);
  assert.match(by.buy.description, /1-click fee/);
  assert.match(by.withdraw.description, /no recipient/);
});

test("a blocked buy returns the result shape and names the rule; nothing is signed", async () => {
  const { w, client } = await agentClient({ deny: [USDC] });
  const r = await client.callTool({ name: "buy", arguments: { token: "usdc", near: "1" } });
  assert.notEqual(r.isError, true);
  assert.deepEqual(Object.keys(r.structuredContent).sort(), [...MONEY_KEYS].sort());
  assert.deepEqual(body(r), r.structuredContent);
  assert.equal(r.structuredContent.outcome, "blocked");
  assert.equal(r.structuredContent.reason, `${USDC} is on the policy's deny list`);
  const failed = r.structuredContent.policy_checks.filter((c) => c.status === "fail");
  assert.deepEqual(failed.map((c) => c.rule), ["deny_list"]);
  assert.equal(r.structuredContent.tx, null);
  assert.equal(w.sent.length, 0);
});

test("a buy above the per-trade maximum is blocked by that rule", async () => {
  const { w, client } = await agentClient();
  const r = await client.callTool({ name: "buy", arguments: { token: "usdc", near: "1.5" } });
  assert.equal(r.structuredContent.outcome, "blocked");
  assert.equal(r.structuredContent.policy_checks.find((c) => c.status === "fail").rule, "max_trade_near");
  assert.match(r.structuredContent.reason, /1\.5 NEAR is above the per-trade maximum of 1 NEAR/);
  assert.equal(w.sent.length, 0);
});

test("read tools work with no key: check_token, get_balance for a named account, get_policy", async () => {
  const w = world();
  const client = await connect(createServer({ kit: new Kit({ fetch: w.net.fetch }), agent: null, policyFile: w.policyFile }));
  const { tools } = await client.listTools();
  assert.equal(tools.some((t) => MONEY_TOOLS.includes(t.name)), false);
  const c = await client.callTool({ name: "check_token", arguments: { token: "usdc" } });
  assert.notEqual(c.isError, true);
  assert.equal(body(c).token, USDC);
  assert.equal(body(c).score, 88);
  assert.equal(body(c).verdict, "nothing dangerous found");
  const noAccount = await client.callTool({ name: "get_balance", arguments: {} });
  assert.equal(noAccount.isError, true);
  assert.match(noAccount.content[0].text, /name an account/);
  const b = await client.callTool({ name: "get_balance", arguments: { account: "agent-demo.near" } });
  assert.equal(body(b).balances[0].amount, "2 NEAR");
  const p = await client.callTool({ name: "get_policy", arguments: {} });
  assert.equal(body(p).policy.max_trade_near, 1);
  assert.equal(body(p).spent_today_near, null);
  assert.equal(w.net.log.some((x) => x.method === "send_tx"), false);
});

test("a read that fails says so as a tool error, not a crash", async () => {
  const client = await connect(createServer({ kit: new Kit({ fetch: world().net.fetch }), agent: null, policyFile: "/nonexistent/policy.json" }));
  const r = await client.callTool({ name: "check_token", arguments: { token: "not a token!" } });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /^error: /);
  const p = await client.callTool({ name: "get_policy", arguments: {} });
  assert.equal(p.isError, true);
  assert.match(p.content[0].text, /no policy file/);
});

test("without --read-only and with no agent key, the server refuses to start", () => {
  const r = spawnSync(process.execPath, [BIN, "--home", tempHome()], { encoding: "utf8", input: "" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no agent key: run "nearswaps-agent key new <account>" first, or start with --read-only/);
  assert.equal(r.stdout, "", "stdout is the protocol's only");
});
