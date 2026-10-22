// Every policy rule, one by one: each blocks, each passes, in the order of spec part D (paused; deny list; score
// floor; per-trade maximum; daily budget; cool-down; the contract's caps). Sells are checked for budget and
// cool-down only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { DEFAULT_POLICY, Ledger, parsePolicy, runChecks, RULES } from "../dist/index.js";
import { NEAR, tempHome } from "./helpers.mjs";

const NOW = Date.parse("2026-11-02T12:00:00Z");
const ledger = () => new Ledger(join(tempHome(), "ledger-agent-demo.near.json"), "agent-demo.near", () => NOW);
const contract = { paused: false, trade_paused: false, max_trade_wnear: 10n * NEAR, max_trading_wnear: 50n * NEAR };
const input = (over = {}) => ({ side: "buy", token: "good.tkn.near", near: 0.5, nearRaw: NEAR / 2n, score: async () => ({ score: 90, verdict: "nothing dangerous found" }), contract, ...over });
const policy = (over = {}) => ({ ...DEFAULT_POLICY, ...over });
const statusOf = (r) => Object.fromEntries(r.checks.map((c) => [c.rule, c.status]));

test("a clean buy passes every rule, listed in order", async () => {
  const r = await runChecks(policy(), ledger(), input(), () => NOW);
  assert.equal(r.blocked, null);
  assert.deepEqual(r.checks.map((c) => c.rule), [...RULES]);
  assert.ok(r.checks.every((c) => c.status === "pass"));
  assert.equal(r.score, 90);
});

test("paused blocks first, and nothing else is asked", async () => {
  let asked = false;
  const r = await runChecks(policy({ paused: true }), ledger(), input({ score: async () => { asked = true; return { score: 99, verdict: "x" }; } }), () => NOW);
  assert.equal(r.blocked.rule, "paused");
  assert.equal(asked, false);
  assert.ok(r.checks.slice(1).every((c) => c.status === "skip"));
});

test("deny list blocks a buy before the token check is asked", async () => {
  let asked = false;
  const r = await runChecks(policy({ deny: ["good.tkn.near"] }), ledger(), input({ score: async () => { asked = true; return { score: 99, verdict: "x" }; } }), () => NOW);
  assert.equal(r.blocked.rule, "deny_list");
  assert.equal(asked, false);
});

test("score floor blocks below, passes at the floor, and blocks when the check can't be read", async () => {
  const low = await runChecks(policy({ min_score: 70 }), ledger(), input({ score: async () => ({ score: 42, verdict: "high risk" }) }), () => NOW);
  assert.equal(low.blocked.rule, "score_floor");
  assert.match(low.blocked.detail, /score 42 \(high risk\) is below the floor of 70/);
  assert.equal(low.score, 42);
  const at = await runChecks(policy({ min_score: 70 }), ledger(), input({ score: async () => ({ score: 70, verdict: "caution" }) }), () => NOW);
  assert.equal(at.blocked, null);
  const down = await runChecks(policy(), ledger(), input({ score: async () => { throw new Error("Too many requests"); } }), () => NOW);
  assert.equal(down.blocked.rule, "score_floor");
});

test("trusted tokens skip the score floor, and only the score floor", async () => {
  let asked = false;
  const low = async () => { asked = true; return { score: 20, verdict: "high risk" }; };
  const p = policy({ trusted: ["good.tkn.near"] });
  const r = await runChecks(p, ledger(), input({ score: low }), () => NOW);
  assert.equal(r.blocked, null);
  assert.equal(asked, false, "the token check isn't asked for a trusted token");
  assert.equal(statusOf(r).score_floor, "skip");
  assert.match(r.checks.find((c) => c.rule === "score_floor").detail, /trusted list/);
  assert.equal(r.score, null);
  // The deny list wins over the trusted list; the per-trade maximum, the budget and the cool-down still apply.
  assert.equal((await runChecks(policy({ trusted: ["good.tkn.near"], deny: ["good.tkn.near"] }), ledger(), input({ score: low }), () => NOW)).blocked.rule, "deny_list");
  assert.equal((await runChecks(p, ledger(), input({ score: low, near: 2, nearRaw: 2n * NEAR }), () => NOW)).blocked.rule, "max_trade_near");
  const l = ledger();
  l.settle(l.reserve("buy", "good.tkn.near", 0.1), "filled", "t");
  assert.equal((await runChecks(p, l, input({ score: low }), () => NOW)).blocked.rule, "cooldown_sec");
  // A token off the list is checked as before.
  assert.equal((await runChecks(p, ledger(), input({ token: "other.near", score: low }), () => NOW)).blocked.rule, "score_floor");
});

test("the default trusted list is native USDC, USDt and wrap.near", () => {
  assert.deepEqual(DEFAULT_POLICY.trusted, ["17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1", "usdt.tether-token.near", "wrap.near"]);
});

test("per-trade maximum blocks above, passes at it", async () => {
  assert.equal((await runChecks(policy({ max_trade_near: 1 }), ledger(), input({ near: 1.2, nearRaw: 12n * NEAR / 10n }), () => NOW)).blocked.rule, "max_trade_near");
  assert.equal((await runChecks(policy({ max_trade_near: 1 }), ledger(), input({ near: 1, nearRaw: NEAR }), () => NOW)).blocked, null);
});

test("daily budget counts today's trades and blocks the one that would go over", async () => {
  const l = ledger();
  l.settle(l.reserve("buy", "a.near", 2), "filled", "tx1");
  assert.equal((await runChecks(policy({ daily_budget_near: 3 }), l, input({ near: 1, nearRaw: NEAR }), () => NOW)).blocked, null);
  const r = await runChecks(policy({ daily_budget_near: 3, max_trade_near: 2 }), l, input({ near: 1.5, nearRaw: 15n * NEAR / 10n }), () => NOW);
  assert.equal(r.blocked.rule, "daily_budget_near");
  assert.match(r.blocked.detail, /2 NEAR traded today \(UTC\); this trade would make 3\.5 NEAR/);
});

test("cool-down blocks a second trade in the same token, not in another", async () => {
  const l = ledger();
  l.settle(l.reserve("buy", "good.tkn.near", 0.1), "filled", "tx");
  const r = await runChecks(policy({ cooldown_sec: 600 }), l, input(), () => NOW + 60_000);
  assert.equal(r.blocked.rule, "cooldown_sec");
  assert.match(r.blocked.detail, /wait 540 s/);
  assert.equal((await runChecks(policy({ cooldown_sec: 600 }), l, input({ token: "other.near" }), () => NOW + 60_000)).blocked, null);
  assert.equal((await runChecks(policy({ cooldown_sec: 600 }), l, input(), () => NOW + 600_000)).blocked, null);
});

test("the contract's caps and pause are named as hard limits", async () => {
  const over = await runChecks(policy({ max_trade_near: 100, daily_budget_near: 100 }), ledger(), input({ near: 11, nearRaw: 11n * NEAR }), () => NOW);
  assert.equal(over.blocked.rule, "contract_caps");
  assert.match(over.blocked.detail, /max_trade_wnear 10 NEAR \(a hard limit\)/);
  const paused = await runChecks(policy(), ledger(), input({ contract: { ...contract, trade_paused: true } }), () => NOW);
  assert.equal(paused.blocked.rule, "contract_caps");
  assert.match(paused.blocked.detail, /paused on the contract/);
});

test("a sell is checked for budget and cool-down only: a bad score, the deny list and the per-trade maximum never block it", async () => {
  const p = policy({ deny: ["bad.near"], min_score: 99, max_trade_near: 0.1 });
  let asked = false;
  const r = await runChecks(p, ledger(), input({ side: "sell", token: "bad.near", near: 2, nearRaw: 2n * NEAR, score: async () => { asked = true; return { score: 1, verdict: "high risk" }; } }), () => NOW);
  assert.equal(r.blocked, null);
  assert.equal(asked, false);
  const s = statusOf(r);
  assert.equal(s.deny_list, "skip"); assert.equal(s.score_floor, "skip"); assert.equal(s.max_trade_near, "skip");
  assert.equal(s.daily_budget_near, "pass"); assert.equal(s.cooldown_sec, "pass");
  const l = ledger();
  l.settle(l.reserve("sell", "bad.near", 2.5), "filled", "t");
  assert.equal((await runChecks(p, l, input({ side: "sell", token: "x.near", near: 1, nearRaw: NEAR }), () => NOW)).blocked.rule, "daily_budget_near");
  assert.equal((await runChecks(policy({ daily_budget_near: 100 }), l, input({ side: "sell", token: "bad.near", near: 0.1, nearRaw: NEAR / 10n }), () => NOW + 1000)).blocked.rule, "cooldown_sec");
});

test("the policy file is checked field by field", () => {
  assert.deepEqual(parsePolicy({ ...DEFAULT_POLICY }), DEFAULT_POLICY);
  assert.deepEqual(parsePolicy({ ...DEFAULT_POLICY, slippage_bps: "auto", deny: [" Bad.Near "] }).deny, ["bad.near"]);
  assert.deepEqual(parsePolicy({ ...DEFAULT_POLICY, trusted: [] }).trusted, []);
  const { trusted, ...noTrusted } = DEFAULT_POLICY;
  assert.throws(() => parsePolicy(noTrusted), /trusted/, "a missing trusted list is an error, not a silent default");
  for (const bad of [{ ...DEFAULT_POLICY, trusted: "usdc" }, { ...DEFAULT_POLICY, trusted: ["not a token!"] }, { ...DEFAULT_POLICY, min_score: 101 }, { ...DEFAULT_POLICY, max_trade_near: -1 }, { ...DEFAULT_POLICY, paused: "no" }, { ...DEFAULT_POLICY, deny: "x" },
    { ...DEFAULT_POLICY, slippage_bps: 0 }, { ...DEFAULT_POLICY, slippage_bps: 2500 }, { ...DEFAULT_POLICY, extra: 1 }, (() => { const { cooldown_sec, ...r } = DEFAULT_POLICY; return r; })(), [], null]) {
    assert.throws(() => parsePolicy(bad));
  }
});
