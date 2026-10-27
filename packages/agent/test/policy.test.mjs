// Every policy rule, one by one: each blocks, each passes, in the order of spec part D (paused; deny list; score
// floor; unchecked findings; liquidity; per-trade maximum; daily budget; cool-down; the contract's caps). Sells are checked for budget and
// cool-down only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { DEFAULT_POLICY, ADDED_FIELDS, Ledger, Reads, loadPolicy, parsePolicy, runChecks, RULES } from "../dist/index.js";
import { NEAR, tempHome } from "./helpers.mjs";

const NOW = Date.parse("2026-11-02T12:00:00Z");
const ledger = () => new Ledger(join(tempHome(), "ledger-agent-demo.near.json"), "agent-demo.near", () => NOW);
const contract = { paused: false, trade_paused: false, max_trade_wnear: 10n * NEAR, max_trading_wnear: 50n * NEAR };
const input = (over = {}) => ({ side: "buy", token: "good.tkn.near", near: 0.5, nearRaw: NEAR / 2n, score: async () => ({ score: 90, verdict: "nothing dangerous found", liquidity_near: 5000 }), contract, ...over });
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
  const r = await runChecks(policy({ paused: true }), ledger(), input({ score: async () => { asked = true; return { score: 99, verdict: "x", liquidity_near: 5000 }; } }), () => NOW);
  assert.equal(r.blocked.rule, "paused");
  assert.equal(asked, false);
  assert.ok(r.checks.slice(1).every((c) => c.status === "skip"));
});

test("deny list blocks a buy before the token check is asked", async () => {
  let asked = false;
  const r = await runChecks(policy({ deny: ["good.tkn.near"] }), ledger(), input({ score: async () => { asked = true; return { score: 99, verdict: "x", liquidity_near: 5000 }; } }), () => NOW);
  assert.equal(r.blocked.rule, "deny_list");
  assert.equal(asked, false);
});

test("score floor blocks below, passes at the floor, and blocks when the check can't be read", async () => {
  const low = await runChecks(policy({ min_score: 70 }), ledger(), input({ score: async () => ({ score: 42, verdict: "high risk", liquidity_near: 5000 }) }), () => NOW);
  assert.equal(low.blocked.rule, "score_floor");
  assert.match(low.blocked.detail, /score 42 \(high risk\) is below the floor of 70/);
  assert.equal(low.score, 42);
  const at = await runChecks(policy({ min_score: 70 }), ledger(), input({ score: async () => ({ score: 70, verdict: "caution", liquidity_near: 5000 }) }), () => NOW);
  assert.equal(at.blocked, null);
  const down = await runChecks(policy(), ledger(), input({ score: async () => { throw new Error("Too many requests"); } }), () => NOW);
  assert.equal(down.blocked.rule, "score_floor");
});

test("trusted tokens skip the three token-check rules, and only those", async () => {
  let asked = false;
  const low = async () => { asked = true; return { score: 20, verdict: "high risk", liquidity_near: 5000 }; };
  const p = policy({ trusted: ["good.tkn.near"] });
  const r = await runChecks(p, ledger(), input({ score: low }), () => NOW);
  assert.equal(r.blocked, null);
  assert.equal(asked, false, "the token check isn't asked for a trusted token");
  for (const rule of ["score_floor", "max_unchecked", "min_liquidity_near"]) {
    assert.equal(statusOf(r)[rule], "skip", rule);
    assert.match(r.checks.find((c) => c.rule === rule).detail, /trusted list/, rule);
  }
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
  const r = await runChecks(p, ledger(), input({ side: "sell", token: "bad.near", near: 2, nearRaw: 2n * NEAR, score: async () => { asked = true; return { score: 1, verdict: "high risk", liquidity_near: 5000 }; } }), () => NOW);
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

// The token check of an empty launch as /api/safety answered it on 27 Oct 2026 (shibainu.nearlytrade.near): score 80,
// four "could not check" findings, 0 NEAR of liquidity.
const EMPTY_LAUNCH = { token: "shibainu.nearlytrade.near", score: 80, verdict: "caution", unchecked: 4, checked_at: "2026-10-27T21:10:00Z", note: "", facts: { liquidity_near: 0 },
  findings: [{ title: "Locked: no access keys", severity: "ok" }, { title: "Could not check: supply since launch", severity: "info", could_not_check: true }, { title: "Very little liquidity", severity: "high" },
    { title: "Could not check: sell depth", severity: "info", could_not_check: true }, { title: "Could not check: holder concentration", severity: "info", could_not_check: true }, { title: "Could not check: 7-day activity", severity: "info", could_not_check: true }] };
const readsOf = (body) => new Reads({ fetch: async () => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) }) });

test("the token check result counts the findings it could not make and carries the liquidity figure", async () => {
  const c = await readsOf(EMPTY_LAUNCH).checkToken("shibainu.nearlytrade.near");
  assert.equal(c.unchecked, 4);
  assert.equal(c.liquidity_near, 0);
  const none = await readsOf({ ...EMPTY_LAUNCH, facts: {} }).checkToken("x.near");
  assert.equal(none.liquidity_near, null, "absent, not 0: the policy says so when it counts it as 0");
});

test("max_unchecked: an empty launch that scores 80 is blocked, and the findings are named", async () => {
  const reads = readsOf(EMPTY_LAUNCH);
  const tok = "shibainu.nearlytrade.near";
  const r = await runChecks(policy(), ledger(), input({ token: tok, score: () => reads.checkToken(tok) }), () => NOW);
  assert.equal(statusOf(r).score_floor, "pass", "the score alone lets it through");
  assert.equal(r.blocked.rule, "max_unchecked");
  assert.equal(r.blocked.detail, "the token check could not check 4 things, more than the most of 3: supply since launch; sell depth; holder concentration; 7-day activity");
  // at the most it passes, and the next rule (liquidity) is the one that stops it
  const at = await runChecks(policy({ max_unchecked: 4 }), ledger(), input({ token: tok, score: () => reads.checkToken(tok) }), () => NOW);
  assert.equal(statusOf(at).max_unchecked, "pass");
  assert.equal(at.blocked.rule, "min_liquidity_near");
  assert.equal(at.blocked.detail, "0 NEAR of liquidity, below the least of 100 NEAR");
});

test("min_liquidity_near: blocks below, passes at it, and counts a missing figure as 0 (saying so)", async () => {
  const chk = (liquidity_near) => async () => ({ score: 90, verdict: "nothing dangerous found", findings: [], liquidity_near });
  const thin = await runChecks(policy(), ledger(), input({ score: chk(99.5) }), () => NOW);
  assert.equal(thin.blocked.rule, "min_liquidity_near");
  assert.equal(thin.blocked.detail, "99.5 NEAR of liquidity, below the least of 100 NEAR");
  assert.equal((await runChecks(policy(), ledger(), input({ score: chk(100) }), () => NOW)).blocked, null);
  const none = await runChecks(policy(), ledger(), input({ score: chk(undefined) }), () => NOW);
  assert.equal(none.blocked.rule, "min_liquidity_near");
  assert.match(none.blocked.detail, /no liquidity figure from the token check \(counted as 0 NEAR\)/);
  assert.equal((await runChecks(policy({ min_liquidity_near: 0 }), ledger(), input({ score: chk(undefined) }), () => NOW)).blocked, null, "0 turns the rule off");
});

test("the two new rules run right after the score floor, for buys only", async () => {
  assert.deepEqual(RULES.slice(2, 5), ["score_floor", "max_unchecked", "min_liquidity_near"]);
  const r = await runChecks(policy({ daily_budget_near: 100 }), ledger(), input({ side: "sell", token: "shibainu.nearlytrade.near", near: 0.1, nearRaw: NEAR / 10n, score: () => readsOf(EMPTY_LAUNCH).checkToken("x") }), () => NOW);
  assert.equal(r.blocked, null, "an empty launch can always be sold");
  assert.equal(statusOf(r).max_unchecked, "skip");
  assert.equal(statusOf(r).min_liquidity_near, "skip");
  // a score below the floor stops first; the two are then skipped
  const low = await runChecks(policy(), ledger(), input({ score: async () => ({ score: 10, verdict: "high risk", findings: [], liquidity_near: 0 }) }), () => NOW);
  assert.equal(low.blocked.rule, "score_floor");
  assert.equal(statusOf(low).max_unchecked, "skip");
});

test("a policy file written before the two rules still loads, with the defaults and one line saying so", () => {
  const old = { ...DEFAULT_POLICY };
  for (const k of ADDED_FIELDS) delete old[k];
  const notes = [];
  const p = parsePolicy(old, (l) => notes.push(l));
  assert.equal(p.max_unchecked, 3);
  assert.equal(p.min_liquidity_near, 100);
  assert.deepEqual(notes, ["policy: this file has no max_unchecked or min_liquidity_near, so the defaults apply (max_unchecked 3, min_liquidity_near 100); add them to the file to choose"]);
  // one missing: only that one is named; none missing: nothing said
  const { max_unchecked, ...noMax } = DEFAULT_POLICY;
  const one = []; assert.equal(parsePolicy(noMax, (l) => one.push(l)).max_unchecked, 3);
  assert.equal(one.length, 1); assert.match(one[0], /no max_unchecked,/);
  const quiet = []; parsePolicy({ ...DEFAULT_POLICY }, (l) => quiet.push(l)); assert.deepEqual(quiet, []);
  // every other field is still required
  const { cooldown_sec, ...noCool } = old;
  assert.throws(() => parsePolicy(noCool), /cooldown_sec/);
  // loadPolicy: a caller's own notice hears every load; the default writes to stderr once per file
  const file = join(tempHome(), "policy.json");
  writeFileSync(file, JSON.stringify(old));
  const seen = [];
  loadPolicy(file, (l) => seen.push(l)); loadPolicy(file, (l) => seen.push(l));
  assert.equal(seen.length, 2);
  assert.equal(loadPolicy(file).min_liquidity_near, 100);
});

test("the new fields are checked like the others", () => {
  for (const [bad, re] of [[{ max_unchecked: -1 }, /max_unchecked/], [{ max_unchecked: 1.5 }, /max_unchecked/], [{ max_unchecked: "3" }, /max_unchecked/], [{ min_liquidity_near: -5 }, /min_liquidity_near/], [{ min_liquidity_near: null }, /min_liquidity_near/]]) {
    assert.throws(() => parsePolicy({ ...DEFAULT_POLICY, ...bad }), re);
  }
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
