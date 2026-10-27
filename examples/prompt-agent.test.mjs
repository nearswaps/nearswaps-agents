// prompt-agent against a fake OpenAI-compatible server (on 127.0.0.1, scripted turn by turn) and the agent package's
// fake chain (recorded config and the Rhea pools of route fixtures 01 and 02): a research-then-buy that fills, a
// blocked buy that is not sent again, the step cap and the money-call cap. Offline; nothing reaches mainnet or a model.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer as httpServer } from "node:http";
import { dirname, join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { Agent, Kit, DEFAULT_POLICY, newKeyPair, saveKey, b58encode } from "@nearswaps/agent";
import { READ_TOOLS, MONEY_TOOLS } from "@nearswaps/agent-mcp";
import { fakeNet, fixture, tempHome, txOutcome, NEAR } from "../packages/agent/test/helpers.mjs";
import { runPromptAgent, parseArgs, loadLlmConfig, startRefusal, SYSTEM_PROMPT, DEFAULT_BASE_URL, DEFAULT_MODEL } from "./prompt-agent.mjs";

const USDC = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const NEKO = "ftv2.nekotoken.near";
const NOW = Date.parse("2026-11-02T12:00:00Z");
const CFG = fixture("trading-config.json");
const F1 = fixture("routes/01-buy-usdc-with-1-near.json"), F2 = fixture("routes/02-buy-neko-with-5-near.json");
const POOLS = { ...F1.pools, ...F2.pools }, KINDS = { ...F1.pool_kinds, ...F2.pool_kinds };
const SCORES = { [USDC]: 88, [NEKO]: 30 };
const TX = "8xQnfV3pJk2Yc6sGQe1t7mRZbqD4uWv9LhN5aKoE3iPs";
const PROMPT = "buy 0.2 NEAR of the best token that launched today scoring over 70, then show my balance";

const launch = (id, pad, liquidity_near) => ({ id, pad, symbol: id.slice(0, 6).toUpperCase(), name: id, created: NOW - 3 * 3600_000, mc_usd: 0, vol24_usd: 0, liquidity_near, holders: 10, price_usd: 0, graduated: false, progress: 0, creator: "", tax_buy_bps: null, tax_sell_bps: null });
const LAUNCHES = [launch(USDC, "intear", 900), launch(NEKO, "shards", 800)];

function world() {
  const home = tempHome();
  const policyFile = join(home, ".nearswaps-agent", "policy.json");
  mkdirSync(dirname(policyFile), { recursive: true });
  writeFileSync(policyFile, JSON.stringify({ ...DEFAULT_POLICY, trusted: [] }));
  const sent = [];
  const net = fakeNet({
    views: {
      "nekoorders.near.get_trading_config": CFG,
      "nekoorders.near.get_trading": () => [{ token: "wrap.near", amount: (2n * NEAR).toString() }],
      "nekoorders.near.get_trading_parts": () => [{ token: "wrap.near", here: (2n * NEAR).toString(), rhea: "0", intear: "0" }],
      "nekoorders.near.are_open": ({ tokens }) => tokens.map(() => false),
      "nekoorders.near.are_registered": ({ keys }) => keys.map(() => false),
      "nekoorders.near.trade_gas_tgas": () => 110,
      "nekoorders.near.get_pending": () => [],
      [USDC + ".ft_metadata"]: { symbol: "USDC", decimals: 6 },
      [NEKO + ".ft_metadata"]: { symbol: "NEKO", decimals: 24 },
      "nekonftstaking.near.get_stake": { fee_discount_bps: 0 },
      "v2.ref-finance.near.get_pool_by_ids": ({ pool_ids }) => pool_ids.map((id) => (KINDS[id] === "SIMPLE_POOL" ? POOLS[id] : null)),
      "v2.ref-finance.near.get_stable_pool": ({ pool_id }) => { if (!POOLS[pool_id]) throw new Error("no pool"); return POOLS[pool_id]; },
    },
    rpc: {
      block: () => ({ header: { hash: b58encode(new Uint8Array(32).fill(3)) } }),
      "query.view_access_key": () => ({ nonce: 5, permission: { FunctionCall: { receiver_id: "nekoorders.near", method_names: ["trade", "withdraw", "recover_trade"], allowance: null } } }),
      "query.view_account": () => ({ amount: (5n * NEAR).toString(), storage_usage: 0 }),
      send_tx: () => {
        sent.push(1);
        return txOutcome(TX, [{ event: "trade", data: { id: "9", owner: "agent-demo.near", venue: "rhea", token_in: "wrap.near", token_out: USDC, amount_in: (NEAR / 5n).toString(), amount_out: "984616", fee_bps: 50, fee_amount: "4948", fee_to: "nekotesting.near", referrer: null, at: "rhea" } }]);
      },
      tx: () => ({ transportError: true }),
    },
    http: [
      ["https://nearswaps.com/assets/swap-pools.json", fixture("swap-pools.json")],
      ["https://nearswaps.com/api/safety", (url) => { const t = new URL(url).searchParams.get("token"); const s = SCORES[t] ?? 20; return { token: t, score: s, verdict: s >= 70 ? "nothing dangerous found" : "high risk", checked_at: "2026-11-02T12:00:00Z", findings: [], note: "", facts: { liquidity_near: 5000 } }; }],
    ],
  });
  return { net, sent, home, policyFile };
}
const withLaunches = (kit) => { kit.listNewLaunches = async () => ({ launches: LAUNCHES, sources: {} }); return kit; };
const openAgent = (w) => Agent.open({ accountId: "agent-demo.near", key: newKeyPair("agent-demo.near"), fetch: w.net.fetch, home: w.home, policyFile: w.policyFile, sleep: async () => {}, now: () => NOW });

/** A fake OpenAI-compatible chat completions server. `script(turn, body)` returns the assistant message for the
 * turn-th request (0-based): { content } for an answer, or { calls: [[name, args], ...] } for tool calls. */
async function fakeModel(script) {
  const requests = [];
  const srv = httpServer((req, res) => {
    let s = "";
    req.on("data", (d) => (s += d)).on("end", () => {
      const body = JSON.parse(s);
      requests.push({ url: req.url, auth: req.headers.authorization, body });
      const m = script(requests.length - 1, body);
      const message = m.calls
        ? { role: "assistant", content: m.content ?? null, tool_calls: m.calls.map(([name, args], i) => ({ id: `call_${requests.length}_${i}`, type: "function", function: { name, arguments: JSON.stringify(args) } })) }
        : { role: "assistant", content: m.content };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "x", object: "chat.completion", model: body.model, choices: [{ index: 0, message, finish_reason: m.calls ? "tool_calls" : "stop" }] }));
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const llm = { baseUrl: `http://127.0.0.1:${srv.address().port}/v1`, apiKey: "test-key", model: "test/model" };
  return { llm, requests, close: () => new Promise((r) => srv.close(r)) };
}
const toolMessages = (req) => req.body.messages.filter((m) => m.role === "tool");

/** Research, then buy, then the balance, then the answer: what a model asked PROMPT should do. */
const researchThenBuy = (answer) => (turn) => [
  { calls: [["list_new_launches", { since_minutes: 1440 }]] },
  { content: "Two launches today. Checking both.", calls: [["check_token", { token: USDC }], ["check_token", { token: NEKO }]] },
  { calls: [["get_quote", { from: "near", to: USDC, amount: "0.2" }]] },
  { calls: [["buy", { token: USDC, near: "0.2" }]] },
  { calls: [["get_balance", {}]] },
  { content: answer },
][turn];

test("a real run: research, a filled buy with its tx hash, the balance, the answer; the twelve tools from the MCP server", async () => {
  const w = world();
  const agent = withLaunches(await openAgent(w));
  const m = await fakeModel(researchThenBuy(`buy ${USDC}: filled, 0.2 NEAR in, tx ${TX}\n1-click balance: 2 NEAR`));
  const lines = [];
  try {
    const r = await runPromptAgent({ kit: agent, agent, policyFile: w.policyFile, account: "agent-demo.near", prompt: PROMPT, llm: m.llm, out: (l) => lines.push(l) });
    assert.equal(r.stopped, "answer");
    assert.equal(r.steps, 6);
    assert.equal(r.moneyCalls, 1);
    assert.equal(w.sent.length, 1, "the buy was signed once");
    const buy = r.calls.find((c) => c.name === "buy");
    assert.equal(buy.result.outcome, "filled");
    assert.equal(buy.result.tx, TX);
    // the request: the system prompt, the user's words, and exactly the kit's twelve tools
    const first = m.requests[0];
    assert.equal(first.url, "/v1/chat/completions");
    assert.equal(first.auth, "Bearer test-key");
    assert.equal(first.body.model, "test/model");
    assert.ok(first.body.messages[0].content.startsWith(SYSTEM_PROMPT));
    assert.equal(first.body.messages[1].content, PROMPT);
    assert.deepEqual(first.body.tools.map((t) => t.function.name).sort(), [...READ_TOOLS, ...MONEY_TOOLS].sort());
    assert.ok(first.body.tools.every((t) => t.type === "function" && t.function.parameters.type === "object" && !("$schema" in t.function.parameters)));
    // the model got the full buy result back
    assert.equal(JSON.parse(toolMessages(m.requests[4]).at(-1).content).tx, TX);
    assert.ok(lines.includes("mode: trading for agent-demo.near with the agent key"));
    assert.ok(lines.includes(`step 4: call buy {"token":"${USDC}","near":"0.2"}`));
    assert.ok(lines.includes("step 4: outcome: filled"));
    assert.ok(lines.includes(`step 4: tx: https://nearblocks.io/txns/${TX}`));
    assert.ok(lines.includes("step 2: model: Two launches today. Checking both."));
    assert.ok(lines.includes(`answer: buy ${USDC}: filled, 0.2 NEAR in, tx ${TX}`));
    assert.ok(lines.includes("answer: 1-click balance: 2 NEAR"));
    assert.ok(lines.includes("money calls this run: 1 of at most 2"));
    assert.ok(lines.filter((l) => l.includes(": result: ")).every((l) => l.length < 340), "read results are trimmed");
    for (const l of lines) { assert.doesNotMatch(l, /\x1b\[|[^\x20-\x7e]/, l); assert.doesNotMatch(l, /test-key/); }
  } finally { await m.close(); }
});

test("a blocked buy: nothing signed, the model is told not to retry, and a retry is not sent", async () => {
  const w = world();
  const agent = withLaunches(await openAgent(w));
  const m = await fakeModel((turn) => [
    { calls: [["check_token", { token: NEKO }]] },
    { calls: [["get_quote", { from: "near", to: NEKO, amount: "0.2" }]] },
    { calls: [["buy", { token: NEKO, near: "0.2" }]] },
    { calls: [["buy", { token: "neko", near: "0.2" }]] }, // a model that retries anyway, by symbol
    { content: `buy ${NEKO}: blocked by score_floor, no tx` },
  ][turn]);
  const lines = [];
  try {
    const r = await runPromptAgent({ kit: agent, agent, policyFile: w.policyFile, account: "agent-demo.near", prompt: "buy 0.2 NEAR of neko", llm: m.llm, out: (l) => lines.push(l) });
    assert.equal(r.stopped, "answer");
    assert.equal(w.sent.length, 0, "nothing was signed");
    const [first, retry] = r.calls.filter((c) => c.name === "buy");
    assert.equal(first.executed, true);
    assert.equal(first.result.outcome, "blocked");
    assert.equal(first.result.policy_checks.find((c) => c.status === "fail").rule, "score_floor");
    const told = JSON.parse(toolMessages(m.requests[3]).at(-1).content);
    assert.match(told.note, /do not retry/);
    assert.equal(retry.executed, false);
    assert.match(retry.result.reason, /blocked earlier in this run/);
    assert.equal(r.moneyCalls, 1, "the refused retry is not a money call");
    assert.ok(lines.includes("step 3: outcome: blocked"));
    assert.ok(lines.includes("step 3: check score_floor: fail (score 30 (high risk) is below the floor of 70)"));
    assert.ok(lines.some((l) => l.startsWith("step 4: result: blocked (not sent: the same buy of neko was blocked earlier")));
  } finally { await m.close(); }
});

test("the step cap: a model that never answers is stopped after --max-steps turns", async () => {
  const w = world();
  const kit = new Kit({ fetch: w.net.fetch, now: () => NOW });
  const m = await fakeModel(() => ({ calls: [["get_policy", {}]] }));
  const lines = [];
  try {
    const r = await runPromptAgent({ kit, policyFile: w.policyFile, account: "agent-demo.near", prompt: "keep reading", llm: m.llm, maxSteps: 3, out: (l) => lines.push(l) });
    assert.equal(r.stopped, "max_steps");
    assert.equal(m.requests.length, 3);
    assert.equal(r.calls.length, 3);
    assert.ok(lines.includes("stopped: the cap of 3 steps is reached with no final answer"));
  } finally { await m.close(); }
});

test("a dry run: buy is the policy's dry run, withdraw is a note, and the money-call cap refuses the third", async () => {
  const w = world();
  const kit = new Kit({ fetch: w.net.fetch, now: () => NOW });
  const m = await fakeModel((turn) => [
    { calls: [["buy", { token: USDC, near: "0.2" }]] },
    { calls: [["withdraw", {}]] },
    { calls: [["buy", { token: USDC, near: "0.1" }]] },
    { content: "done" },
  ][turn]);
  const lines = [];
  try {
    const r = await runPromptAgent({ kit, agent: null, policyFile: w.policyFile, account: "agent-demo.near", prompt: "buy twice and withdraw", llm: m.llm, out: (l) => lines.push(l) });
    const [b1, wd, b2] = r.calls;
    assert.equal(b1.result.outcome, "would pass");
    assert.equal(wd.result.outcome, "dry run");
    assert.equal(b2.executed, false);
    assert.match(b2.result.reason, /cap of 2 money calls/);
    assert.equal(r.moneyCalls, 2);
    assert.equal(w.net.log.some((x) => x.method === "send_tx"), false, "nothing sent");
    assert.ok(lines.includes("mode: dry run (no key loaded; nothing signed)"));
    assert.ok(lines.includes("step 1: signed: nothing (a dry run)"));
    assert.ok(lines.includes("step 2: outcome: dry run"));
  } finally { await m.close(); }
});

test("the research-then-buy prompt as a dry run (the README transcript)", async () => {
  const w = world();
  const kit = withLaunches(new Kit({ fetch: w.net.fetch, now: () => NOW }));
  const m = await fakeModel(researchThenBuy(`The best launch today scoring over 70 is ${USDC} (USDC, score 88).\nbuy: would pass (a dry run; nothing signed, no tx)\n1-click balance: 2 NEAR`));
  const lines = [];
  try {
    const r = await runPromptAgent({ kit, agent: null, policyFile: w.policyFile, account: "agent-demo.near", prompt: PROMPT, llm: m.llm, out: (l) => lines.push(l) });
    assert.equal(r.stopped, "answer");
    assert.equal(r.calls.find((c) => c.name === "buy").result.outcome, "would pass");
    if (process.env.PRINT_TRANSCRIPT) process.stderr.write(lines.join("\n") + "\n");
  } finally { await m.close(); }
});

test("arguments, the model config and the start refusal", () => {
  assert.throws(() => parseArgs(["--account", "a.near"]), /say what to do/);
  assert.throws(() => parseArgs(["buy it"]), /--account/);
  assert.throws(() => parseArgs(["--dry-run", "--max-steps", "0", "x"]), /--max-steps/);
  const o = parseArgs(["--account", "tome.near", "buy 0.2 NEAR", "--dry-run", "--max-steps", "5", "--model", "m/x"]);
  assert.deepEqual([o.account, o.prompt, o.dryRun, o.maxSteps, o.maxMoney, o.model], ["tome.near", "buy 0.2 NEAR", true, 5, 2, "m/x"]);

  const home = tempHome();
  assert.deepEqual(loadLlmConfig({ env: {}, home }), { baseUrl: DEFAULT_BASE_URL, apiKey: null, model: DEFAULT_MODEL, file: join(home, ".nearswaps-agent", "llm.json") });
  mkdirSync(join(home, ".nearswaps-agent"), { recursive: true });
  writeFileSync(join(home, ".nearswaps-agent", "llm.json"), JSON.stringify({ base_url: "https://example.test/v1/", api_key: "k1", model: "file/model" }));
  const f = loadLlmConfig({ env: {}, home });
  assert.deepEqual([f.baseUrl, f.apiKey, f.model], ["https://example.test/v1", "k1", "file/model"]);
  const e = loadLlmConfig({ env: { NEARSWAPS_LLM_BASE_URL: "http://localhost:8000/v1", NEARSWAPS_LLM_API_KEY: "k2" }, home, model: "flag/model" });
  assert.deepEqual([e.baseUrl, e.apiKey, e.model], ["http://localhost:8000/v1", "k2", "flag/model"]);

  assert.equal(startRefusal({ dryRun: true, account: "tome.near", home }), null);
  assert.match(startRefusal({ dryRun: false, account: "tome.near", home }), /no agent key for tome\.near/);
  saveKey(newKeyPair("tome.near"), home);
  assert.equal(startRefusal({ dryRun: false, account: "tome.near", home }), null);
});
