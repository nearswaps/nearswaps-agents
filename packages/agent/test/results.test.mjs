// The result shape (spec part C6) for every outcome, end to end through Agent.buy / sell / withdraw against a fake
// chain built from recorded data: the live get_trading_config of 22 Oct 2026 and the pool state of route fixture 01
// (1 NEAR to USDC). Money calls never throw; blocked results name the exact rule; nothing is sent when blocked.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { Agent, DEFAULT_POLICY, newKeyPair, b58encode } from "../dist/index.js";
import { fakeNet, fixture, tempHome, txOutcome, NEAR } from "./helpers.mjs";

const USDC = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const CFG = fixture("trading-config.json");
const FX = fixture("routes/01-buy-usdc-with-1-near.json");
const KEYS = ["outcome", "reason", "tx", "amount_in", "amount_out", "fee", "score", "policy_checks"];
const key = newKeyPair("agent-demo.near");

function world(over = {}) {
  const home = tempHome();
  const policyFile = join(home, ".nearswaps-agent", "policy.json");
  mkdirSync(join(home, ".nearswaps-agent"), { recursive: true });
  // The tests here buy USDC, which the default policy trusts; they clear the trusted list so the score floor applies,
  // except where a test is about the list itself.
  if (over.policy !== null) writeFileSync(policyFile, JSON.stringify({ ...DEFAULT_POLICY, trusted: [], ...(over.policy || {}) }));
  const bal = over.balances || { "wrap.near": { here: 2n * NEAR, rhea: 0n, intear: 0n }, [USDC]: { here: 0n, rhea: 50_000_000n, intear: 0n } };
  const total = (p) => (p.here + p.rhea + p.intear).toString();
  const sent = [];
  let clock = Date.parse("2026-11-02T12:00:00Z");
  const net = fakeNet({
    views: {
      "nekoorders.near.get_trading_config": { ...CFG, ...(over.cfg || {}) },
      "nekoorders.near.get_trading": () => Object.entries(bal).map(([token, p]) => ({ token, amount: total(p) })),
      "nekoorders.near.get_trading_parts": () => Object.entries(bal).map(([token, p]) => ({ token, here: p.here.toString(), rhea: p.rhea.toString(), intear: p.intear.toString() })),
      "nekoorders.near.are_open": ({ tokens }) => tokens.map(() => false),
      "nekoorders.near.trade_gas_tgas": ({ venue }) => ("Shift" in venue ? 130 : 110),
      "nekoorders.near.get_pending": () => over.pending || [],
      [USDC + ".ft_metadata"]: { symbol: "USDC", decimals: 6 },
      "nekonftstaking.near.get_stake": { fee_discount_bps: 0 },
      "v2.ref-finance.near.get_pool_by_ids": ({ pool_ids }) => pool_ids.map((id) => (FX.pool_kinds[id] === "SIMPLE_POOL" ? FX.pools[id] : null)),
      "v2.ref-finance.near.get_stable_pool": ({ pool_id }) => { if (!FX.pools[pool_id]) throw new Error("no pool"); return FX.pools[pool_id]; },
    },
    rpc: {
      block: () => ({ header: { hash: b58encode(new Uint8Array(32).fill(3)) } }),
      "query.view_access_key": () => ({ nonce: 5, permission: { FunctionCall: { receiver_id: "nekoorders.near", method_names: ["trade", "withdraw", "recover_trade"], allowance: null } } }),
      "query.view_account": () => ({ amount: (over.walletFree ?? 5n * NEAR).toString(), storage_usage: 0 }),
      send_tx: (p) => {
        const b = Buffer.from(p.signed_tx_base64, "base64");
        // the method name and args out of the signed transaction (borsh), to check what was asked of the contract
        let o = 0; const str = () => { const n = b.readUInt32LE(o); o += 4; const s = b.subarray(o, o + n).toString(); o += n; return s; };
        str(); o += 33 + 8; const receiver = str(); o += 32 + 4 + 1; const method = str(); const args = JSON.parse(str());
        sent.push({ receiver, method, args });
        return over.send ? over.send({ receiver, method, args }, sent.length) : txOutcome("TX" + sent.length, []);
      },
      tx: () => ({ transportError: true }),
    },
    http: [
      ["https://nearswaps.com/assets/swap-pools.json", fixture("swap-pools.json")],
      ["https://nearswaps.com/api/safety", (url) => over.safety ? over.safety(url) : { token: new URL(url).searchParams.get("token"), score: 88, verdict: "nothing dangerous found", checked_at: "2026-11-02T12:00:00Z", findings: [{ id: "keys", check: "keys", severity: "ok", title: "Locked", detail: "" }], note: "" }],
    ],
  });
  const open = () => Agent.open({ accountId: "agent-demo.near", key, fetch: net.fetch, home, policyFile, sleep: async () => { clock += 2500; }, now: () => clock });
  return { net, sent, open, policyFile, home, bal };
}
const tradeEv = (data) => ({ event: "trade", data: { id: "9", owner: "agent-demo.near", venue: "rhea", token_in: "wrap.near", token_out: USDC, amount_in: "1000000000000000000000000", amount_out: "4923084", fee_bps: 50, fee_amount: "24739", fee_to: "nekotesting.near", referrer: null, at: "rhea", ...data } });
const shape = (r) => assert.deepEqual(Object.keys(r).sort(), [...KEYS].sort());

test("filled: amounts with symbols, the fee, the score, every check listed", async () => {
  const w = world({ send: () => txOutcome("FILL", [tradeEv({})]) });
  const r = await (await w.open()).buy("usdc", "1");
  shape(r);
  assert.equal(r.outcome, "filled");
  assert.equal(r.tx, "FILL");
  assert.equal(r.amount_in, "1 NEAR");
  assert.equal(r.amount_out, "4.923084 USDC");
  assert.equal(r.fee, "0.024739 USDC");
  assert.equal(r.score, 88);
  assert.deepEqual(r.policy_checks.map((c) => c.rule), ["venue", "balance", "paused", "deny_list", "score_floor", "max_trade_near", "daily_budget_near", "cooldown_sec", "contract_caps"]);
  // What was asked of the contract: a Rhea route of the recorded legs, min_out at 5%, 0 deposit, the gas the view gave.
  assert.equal(w.sent.length, 1);
  const a = w.sent[0];
  assert.equal(a.receiver, "nekoorders.near"); assert.equal(a.method, "trade");
  assert.deepEqual(a.args.venue, FX.panel.venue);
  assert.equal(a.args.min_out, FX.panel.min_out_500);
  assert.equal(a.args.fee_bps, 50);
  assert.equal(a.args.referrer, null);
  const led = JSON.parse(readFileSync(join(w.home, ".nearswaps-agent", "ledger-agent-demo.near.json"), "utf8"));
  assert.equal(led.days["2026-11-02"][0].outcome, "filled");
});

test("refused: the venue didn't fill at the minimum; the input is back", async () => {
  const w = world({ send: () => txOutcome("NOFILL", [{ event: "trade_failed", data: { id: "9", owner: "agent-demo.near", token_in: "wrap.near", amount_in: "1000000000000000000000000", reason: "Rhea did not fill at your minimum", at: "rhea" } }]) });
  const r = await (await w.open()).buy("usdc", "1");
  shape(r);
  assert.equal(r.outcome, "refused");
  assert.match(r.reason, /did not fill at your minimum.*back in the 1-click balance/);
  assert.equal(r.tx, "NOFILL");
  const a = await w.open();
  assert.equal(a.getPolicy().spent_today_near, 0, "a refused trade costs no budget");
});

test("unclear: the exchange's answer couldn't be read", async () => {
  const w = world({ send: () => txOutcome("UNC", [{ event: "trade_unclear", data: { id: "9", owner: "agent-demo.near", reason: "the swap's answer can't be read" } }]) });
  const r = await (await w.open()).buy("usdc", "1");
  shape(r);
  assert.equal(r.outcome, "unclear");
  assert.equal((await w.open()).getPolicy().spent_today_near, 1, "an unclear trade counts");
});

test("pending: sent, no answer from any node for two minutes; the hash is given and nothing is sent again", async () => {
  const w = world({ send: () => ({ transportError: true }) });
  const r = await (await w.open()).buy("usdc", "1");
  shape(r);
  assert.equal(r.outcome, "pending");
  assert.ok(r.tx && r.tx.length > 30);
  assert.equal(w.sent.length, 2, "the same signed transaction, once per node");
  assert.equal((await w.open()).getPolicy().spent_today_near, 1, "a pending trade counts");
});

test("blocked by policy: below the score floor, with the finding's score; nothing signed", async () => {
  const w = world({ safety: (url) => ({ token: new URL(url).searchParams.get("token"), score: 41, verdict: "high risk", checked_at: "x", findings: [], note: "" }) });
  const r = await (await w.open()).buy("usdc", "1");
  shape(r);
  assert.equal(r.outcome, "blocked");
  assert.match(r.reason, /score 41 \(high risk\) is below the floor of 70/);
  assert.equal(r.score, 41);
  assert.equal(r.policy_checks.find((c) => c.status === "fail").rule, "score_floor");
  assert.equal(w.sent.length, 0);
});

test("blocked by policy: above the per-trade maximum and the daily budget", async () => {
  const w = world({ policy: { max_trade_near: 0.5 } });
  const r = await (await w.open()).buy("usdc", "1");
  assert.equal(r.outcome, "blocked");
  assert.equal(r.policy_checks.find((c) => c.status === "fail").rule, "max_trade_near");
  const w2 = world({ policy: { daily_budget_near: 0.5 } });
  assert.equal((await (await w2.open()).buy("usdc", "1")).policy_checks.find((c) => c.status === "fail").rule, "daily_budget_near");
  assert.equal(w.sent.length + w2.sent.length, 0);
});

test("blocked by the kit's own checks: not enough in the 1-click balance, no policy file, an unknown token", async () => {
  const w = world();
  const r = await (await w.open()).buy("usdc", "3");
  assert.equal(r.outcome, "blocked");
  assert.equal(r.policy_checks.at(-1).rule, "balance");
  assert.match(r.reason, /the 1-click balance has 2 NEAR/);
  const w2 = world({ policy: null });
  const r2 = await (await w2.open()).buy("usdc", "1");
  assert.equal(r2.policy_checks.at(-1).rule, "policy_file");
  assert.match(r2.reason, /policy init/);
  const r3 = await (await w.open()).buy("Not A Token!", "1");
  assert.equal(r3.policy_checks.at(-1).rule, "token");
  assert.equal(w.sent.length + w2.sent.length, 0);
});

test("blocked: Rhea DCL and Shards launches are traded in the Terminal, not by the kit", async () => {
  const w = world();
  const r = await (await w.open()).buy("nearagents.nearlytrade.near", "1");
  assert.equal(r.outcome, "blocked");
  assert.match(r.reason, /Rhea DCL; the kit trades on Rhea and Intear DEX only/);
});

test("blocked: the owner's wallet lacks the gas reserve (nothing sent)", async () => {
  const w = world({ walletFree: 10n ** 21n });
  const r = await (await w.open()).buy("usdc", "1");
  assert.equal(r.outcome, "blocked");
  assert.equal(r.policy_checks.at(-1).rule, "gas_reserve");
  assert.equal(w.sent.length, 0);
  assert.equal((await w.open()).getPolicy().spent_today_near, 0);
});

test("refused by the contract before anything moved", async () => {
  const w = world({ send: () => txOutcome("PANIC", [], { ActionError: { kind: { FunctionCallError: { ExecutionError: "Smart contract panicked: 1-click trading is paused" } } } }) });
  const r = await (await w.open()).buy("usdc", "1");
  shape(r);
  assert.equal(r.outcome, "refused");
  assert.match(r.reason, /the contract refused it before anything moved: 1-click trading is paused/);
});

test("a contract cap hit on chain is named as the contract's hard limit", async () => {
  const w = world({ send: () => txOutcome("CAP", [], { ActionError: { kind: { FunctionCallError: { ExecutionError: "Smart contract panicked: Above the per-trade cap" } } } }) });
  const r = await (await w.open()).sell("usdc", "10");
  assert.equal(r.outcome, "blocked");
  assert.match(r.reason, /per-trade cap, max_trade_wnear 10,000 NEAR \(a hard limit\)/);
});

test("v1.6: a balance held at the other exchange is moved first with a Shift, then traded", async () => {
  const w = world({ balances: { "wrap.near": { here: 0n, rhea: 0n, intear: 2n * NEAR } }, send: ({ args }, n) => (n === 1
    ? txOutcome("SHIFT", [{ event: "trading_shift", data: { id: "8", owner: "agent-demo.near", token: "wrap.near", from: "intear", to: "rhea", amount: args.amount_in, moved: args.amount_in, ok: true } }])
    : txOutcome("FILL", [tradeEv({})])) });
  const r = await (await w.open()).buy("usdc", "1");
  assert.equal(r.outcome, "filled");
  assert.deepEqual(w.sent[0].args.venue, { Shift: { from: "intear", to: "rhea" } });
  assert.equal(w.sent[0].args.amount_in, NEAR.toString());
  assert.equal(w.sent[1].args.venue.Rhea.route.length > 0, true);
});

test("a sell of 50% sells half the balance and is not blocked by a bad score", async () => {
  const w = world({ policy: { daily_budget_near: 10 }, safety: () => ({ score: 3, verdict: "high risk", findings: [], checked_at: "x", note: "" }), send: () => txOutcome("S", [tradeEv({ token_in: USDC, token_out: "wrap.near", amount_in: "25000000", amount_out: "5000000000000000000000000", fee_amount: "25000000000000000000000" })]) });
  const r = await (await w.open()).sell("usdc", "50%");
  assert.equal(r.outcome, "filled");
  assert.equal(r.score, null);
  assert.equal(w.sent[0].args.amount_in, "25000000");
  assert.equal(r.amount_in, "25 USDC");
  assert.equal(r.amount_out, "5 NEAR");
});

test("withdraw: to the owner only, after bringing it home from the exchange", async () => {
  const w = world({ balances: { [USDC]: { here: 10_000_000n, rhea: 40_000_000n, intear: 0n } }, send: ({ method, args }, n) => method === "trade"
    ? txOutcome("SH", [{ event: "trading_shift", data: { owner: "agent-demo.near", token: USDC, ok: true } }])
    : txOutcome("WD", [{ event: "trading_withdraw", data: { owner: "agent-demo.near", token: USDC, amount: "50000000", claimable: false } }]) });
  const r = await (await w.open()).withdraw("usdc");
  shape(r);
  assert.equal(r.outcome, "filled");
  assert.equal(r.amount_out, "50 USDC");
  assert.deepEqual(w.sent[0].args.venue, { Shift: { from: "rhea", to: "here" } });
  assert.equal(w.sent[1].method, "withdraw");
  assert.deepEqual(Object.keys(w.sent[1].args).sort(), ["amount", "token"], "no recipient anywhere");
  assert.equal(w.sent[1].args.amount, null, "all of it");
  assert.equal(r.policy_checks[0].rule, "withdraw_to_owner");
});

test("withdraw works while the policy is paused", async () => {
  const w = world({ policy: { paused: true }, send: () => txOutcome("WD", [{ event: "trading_withdraw", data: { owner: "agent-demo.near", token: "wrap.near", amount: "2000000000000000000000000", claimable: false } }]) });
  const a = await w.open();
  assert.equal((await a.buy("usdc", "1")).policy_checks.find((c) => c.status === "fail").rule, "paused");
  const r = await a.withdraw("near");
  assert.equal(r.outcome, "filled");
  assert.equal(r.amount_out, "2 NEAR");
});

test("the trusted list skips the score floor only: native USDC (score 20) is bought under the default policy", async () => {
  const low = (url) => ({ token: new URL(url).searchParams.get("token"), score: 20, verdict: "high risk", checked_at: "x", findings: [], note: "" });
  const w = world({ policy: { trusted: DEFAULT_POLICY.trusted }, safety: low, send: () => txOutcome("FILL", [tradeEv({})]) });
  const r = await (await w.open()).buy("usdc", "1");
  assert.equal(r.outcome, "filled");
  const sf = r.policy_checks.find((c) => c.rule === "score_floor");
  assert.equal(sf.status, "skip");
  assert.match(sf.detail, /trusted list/);
  assert.equal(r.score, null);
  // Every other rule still applies to a trusted token.
  const w2 = world({ policy: { trusted: DEFAULT_POLICY.trusted, max_trade_near: 0.5 }, safety: low });
  assert.equal((await (await w2.open()).buy("usdc", "1")).policy_checks.find((c) => c.status === "fail").rule, "max_trade_near");
  // Off the list, the same score is blocked.
  const w3 = world({ safety: low });
  assert.equal((await (await w3.open()).buy("usdc", "1")).policy_checks.find((c) => c.status === "fail").rule, "score_floor");
  assert.equal(w2.sent.length + w3.sent.length, 0);
});

const NS = (ms) => (BigInt(ms) * 1000000n).toString();
const NOW_MS = Date.parse("2026-11-02T12:00:00Z");
const row = (over) => ({ id: "12", kind: "trade", owner: "agent-demo.near", token_in: "wrap.near", token_out: USDC, amount_in: "1000000000000000000000000", stage: 2, in_flight: false, started_ns: NS(NOW_MS - 7200e3), recoverable_ns: "0", ...over });

test("recover_trade is signed with the agent key: 300 Tgas, 0 deposit, and the settled trade is filled", async () => {
  const w = world({ pending: [row()], send: () => txOutcome("REC", [{ event: "trade_recovered", data: { id: "12", stage: 2 } }, tradeEv({ id: "12" })]) });
  const r = await (await w.open()).recoverTrade(12);
  shape(r);
  assert.equal(r.outcome, "filled");
  assert.equal(r.tx, "REC");
  assert.equal(r.amount_out, "4.923084 USDC");
  assert.equal(w.sent.length, 1);
  assert.equal(w.sent[0].method, "recover_trade");
  assert.deepEqual(w.sent[0].args, { id: "12" });
  assert.equal(r.policy_checks[0].rule, "credits_owner");
  assert.equal((await w.open()).getPolicy().spent_today_near, 0, "recovering costs no budget");
});

test("recover_trade on a withdrawal settles it to the owner", async () => {
  const w = world({ pending: [row({ kind: "withdraw", token_in: "wrap.near", token_out: "wrap.near", in_flight: true, recoverable_ns: NS(NOW_MS - 1000) })],
    send: () => txOutcome("REC", [{ event: "trading_withdraw", data: { owner: "agent-demo.near", token: "wrap.near", amount: "1000000000000000000000000", claimable: false } }, { event: "trade_recovered", data: { id: "12", stage: 3 } }]) });
  const r = await (await w.open()).recoverTrade("12");
  assert.equal(r.outcome, "filled");
  assert.match(r.reason, /withdrawal was sent to agent-demo\.near/);
  assert.equal(r.amount_out, "1 NEAR");
});

test("recover_trade: too soon and unknown ids are blocked before anything is signed", async () => {
  const w = world({ pending: [row({ in_flight: true, recoverable_ns: NS(NOW_MS + 600e3) })] });
  const a = await w.open();
  const soon = await a.recoverTrade(12);
  assert.equal(soon.outcome, "blocked");
  assert.match(soon.reason, /too soon.*2026-11-02T12:10:00/);
  assert.equal((await a.recoverTrade(99)).outcome, "blocked");
  assert.equal((await a.recoverTrade("12; drop")).outcome, "blocked");
  assert.equal(w.sent.length, 0);
});

test("recover_trade works while the policy is paused; an unclear trade only frees its tokens", async () => {
  const w = world({ policy: { paused: true }, pending: [row({ stage: 99, recoverable_ns: NS(NOW_MS - 1000) })],
    send: () => txOutcome("REC", [{ event: "trade_recovered", data: { id: "12", stage: 99, note: "the tokens are free again; nothing is credited and the record stays for a look by hand" } }]) });
  const r = await (await w.open()).recoverTrade(12);
  assert.equal(r.outcome, "unclear");
  assert.match(r.reason, /nothing was credited/);
  assert.equal(w.sent.length, 1);
});

test("recover_trade on a trade parked over an hour frees it first: pending, call again", async () => {
  const w = world({ pending: [row()], send: () => txOutcome("REC", [{ event: "trade_recovered", data: { id: "12", stage: 2, note: "parked over an hour: its tokens are free again; recover again to retry" } }]) });
  const r = await (await w.open()).recoverTrade(12);
  assert.equal(r.outcome, "pending");
  assert.match(r.reason, /call recover_trade once more/);
});

test("recover_trade refused by the contract: refused, nothing moved", async () => {
  const w = world({ pending: [row()], send: () => txOutcome("REC", [], { ActionError: { kind: { FunctionCallError: { ExecutionError: "Smart contract panicked: That trade is still running; recover is possible an hour after its last step" } } } }) });
  const r = await (await w.open()).recoverTrade(12);
  assert.equal(r.outcome, "refused");
  assert.match(r.reason, /before anything moved: That trade is still running/);
});
