// The CLI: one fact per line, no colour codes unless --color (then mint for buys, red for sells), no emoji; the
// offline commands run end to end in a temporary home. Nothing here reaches the network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { checkLines, moneyLines, quoteLines, tradersLines, previewLines, pendingLines, balanceLines } from "../dist/lines.js";
import { HERE, tempHome } from "./helpers.mjs";

const CLI = join(HERE, "..", "dist", "cli.js");
const run = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8" });
const ESC = /\x1b\[/;
const MINT = "\x1b[38;2;1;250;192m", RED = "\x1b[38;2;255;92;92m";
const plain = (lines) => { for (const l of lines) { assert.doesNotMatch(l, ESC, l); assert.doesNotMatch(l, /[^\x20-\x7e]/, l); assert.doesNotMatch(l, /\n/, l); } };

const quote = { from: "wrap.near", to: "usdc.near", amount_in: "1 NEAR", amount_out: "4.9 USDC", min_out: "4.6 USDC", fee: "0.02 USDC", fee_bps: 50, slippage_bps: 500, venue: "Rhea",
  route: [{ amount_in: "1000", hops: [{ pool_id: 4512, token_in: "wrap.near", token_out: "usdc.near" }] }], impact_bps: 3, quoted_at: "2026-11-02T12:00:00.000Z", raw: {} };
const filled = { outcome: "filled", reason: "bought usdc on Rhea", tx: "HASH", amount_in: "1 NEAR", amount_out: "4.9 USDC", fee: "0.02 USDC", score: 88,
  policy_checks: [{ rule: "deny_list", status: "pass", detail: "not on the deny list" }] };

test("lines: one fact per line, plain by default", () => {
  const q = quoteLines(quote);
  plain(q);
  assert.deepEqual(q.slice(0, 7), ["side: buy", "amount in: 1 NEAR", "amount out: 4.9 USDC", "minimum: 4.6 USDC (slippage 5%)", "fee: 0.02 USDC (0.5%)", "venue: Rhea", "price impact: 0.03%"]);
  assert.equal(q[7], "leg 1: 1000 raw in, pool 4512 wrap.near to usdc.near");
  const m = moneyLines(filled, "buy");
  plain(m);
  assert.deepEqual(m, ["outcome: filled", "reason: bought usdc on Rhea", "amount in: 1 NEAR", "amount out: 4.9 USDC", "fee: 0.02 USDC", "score: 88", "tx: https://nearblocks.io/txns/HASH", "check deny_list: pass (not on the deny list)"]);
  plain(checkLines({ token: "wrap.near", score: 96, verdict: "nothing dangerous found", checked_at: "t", findings: [{ severity: "ok", title: "Locked" }], cached: true }));
  assert.deepEqual(pendingLines([]), ["pending: nothing in progress"]);
  assert.deepEqual(balanceLines({ account: "a.near", balances: [], wallet_free: "1 NEAR" }), ["account: a.near", "1-click balance: empty", "wallet free for gas: 1 NEAR"]);
});

test("lines: --color paints buys mint and sells red, and nothing else", () => {
  assert.equal(moneyLines(filled, "buy", true)[0], MINT + "outcome: filled\x1b[0m");
  assert.equal(moneyLines(filled, "sell", true)[0], RED + "outcome: filled\x1b[0m");
  assert.equal(quoteLines({ ...quote, from: "usdc.near", to: "wrap.near" }, true)[0], RED + "side: sell\x1b[0m");
  // a blocked trade isn't a buy or a sell that happened: no colour
  plain(moneyLines({ ...filled, outcome: "blocked", tx: null }, "buy", true));
  const t = tradersLines({ windows: { "7d": { active: 3, rows: [{ rank: 1, w: "a.near", pnl: 10, roi: 1, win: 50, n: 2 }, { rank: 2, w: "b.near", pnl: -5, roi: -1, win: 0, n: 1 }] } } }, "7d", 5, true);
  assert.ok(t[2].startsWith(MINT) && t[3].startsWith(RED));
  plain(tradersLines({ windows: { "7d": { rows: [] } } }, "7d", 5));
  assert.equal(tradersLines({ windows: { "7d": { rows: [] } } }, "7d", 5).at(-1), "traders: none qualified in 7d (try --window 30d)");
});

test("lines: a dry run says nothing was signed and which rule would block", () => {
  const l = previewLines({ outcome: "blocked", reason: "5 NEAR is above the per-trade maximum of 1 NEAR", side: "buy", token: "x.near", near: "5 NEAR", account: null, score: 80,
    policy_checks: [{ rule: "max_trade_near", status: "fail", detail: "5 NEAR is above the per-trade maximum of 1 NEAR" }] });
  plain(l);
  assert.ok(l.includes("outcome: blocked"));
  assert.ok(l.includes("signed: nothing (a dry run)"));
  assert.ok(l.includes("check max_trade_near: fail (5 NEAR is above the per-trade maximum of 1 NEAR)"));
});

test("cli: help lists every command; policy init, check and show; key new; exit codes", () => {
  const h = run("help");
  assert.equal(h.status, 0);
  for (const c of ["check", "quote", "launches", "traders", "wallet", "balance", "key new", "key show", "policy init", "policy show", "policy check", "buy", "sell", "withdraw", "pending", "recover", "--color"]) assert.ok(h.stdout.includes(c), c);
  plain(h.stdout.trim().split("\n"));
  const home = tempHome();
  const init = run("policy", "init", "--home", home);
  assert.equal(init.status, 0);
  assert.match(init.stdout, /^policy written: .*policy\.json\n/);
  assert.equal(run("policy", "init", "--home", home).status, 1, "never overwrites a policy");
  const check = run("policy", "check", "--home", home);
  assert.equal(check.status, 0);
  assert.match(check.stdout, /policy: valid/);
  const key = run("key", "new", "agent-demo.near", "--home", home);
  assert.equal(key.status, 0);
  assert.match(key.stdout, /^account: agent-demo\.near\npublic key: ed25519:[1-9A-HJ-NP-Za-km-z]{32,44}\nkey file: /);
  const show = run("policy", "show", "--home", home);
  assert.equal(show.status, 0);
  const lines = show.stdout.trim().split("\n");
  plain(lines);
  assert.ok(lines.includes("max_trade_near: 1"));
  assert.ok(lines.includes("account: agent-demo.near"), "the only key in the store names the ledger");
  assert.ok(lines.includes("spent today: 0 NEAR"));
  const j = JSON.parse(run("policy", "show", "--home", home, "--json").stdout);
  assert.equal(j.policy.daily_budget_near, 3);
  const bad = run("nope");
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /^error: unknown command "nope"/);
  assert.equal(run("launches", "--since", "soon").status, 1);
});
