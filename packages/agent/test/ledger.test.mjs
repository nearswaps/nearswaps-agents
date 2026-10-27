// The local spend ledger across the UTC day boundary: the budget resets at 00:00 UTC (not local midnight), the
// cool-down does not; a trade that never went out gives its budget and cool-down back; one whose send never came
// back counts until it is known.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { Ledger, utcDay, runChecks, DEFAULT_POLICY } from "../dist/index.js";
import { NEAR, tempHome } from "./helpers.mjs";

const contract = { paused: false, trade_paused: false, max_trade_wnear: 10n * NEAR, max_trading_wnear: 50n * NEAR };

test("utcDay is the UTC date", () => {
  assert.equal(utcDay(Date.parse("2026-11-02T23:59:59.999Z")), "2026-11-02");
  assert.equal(utcDay(Date.parse("2026-11-03T00:00:00.000Z")), "2026-11-03");
  // 01:30 in UTC+2 is still the day before in UTC.
  assert.equal(utcDay(Date.parse("2026-11-03T01:30:00+02:00")), "2026-11-02");
});

test("the budget resets at 00:00 UTC; the cool-down carries over", async () => {
  let now = Date.parse("2026-11-02T23:58:00Z");
  const file = join(tempHome(), "ledger-agent-demo.near.json");
  const l = new Ledger(file, "agent-demo.near", () => now);
  l.settle(l.reserve("buy", "a.near", 2.5), "filled", "t1");
  now = Date.parse("2026-11-02T23:59:59.999Z");
  assert.equal(l.spentToday(), 2.5);
  const p = { ...DEFAULT_POLICY, daily_budget_near: 3, cooldown_sec: 600 };
  const inp = (token, near) => ({ side: "buy", token, near, nearRaw: BigInt(Math.round(near * 1e6)) * 10n ** 18n, score: async () => ({ score: 90, verdict: "nothing dangerous found", liquidity_near: 5000 }), contract });
  assert.equal((await runChecks(p, l, inp("b.near", 1), () => now)).blocked.rule, "daily_budget_near");
  now = Date.parse("2026-11-03T00:00:00.000Z");
  assert.equal(l.spentToday(), 0);
  assert.equal((await runChecks(p, l, inp("b.near", 1), () => now)).blocked, null);
  // a.near was traded two minutes ago, yesterday: still cooling down.
  assert.equal((await runChecks(p, l, inp("a.near", 0.1), () => now)).blocked.rule, "cooldown_sec");
  // A fresh process reads the same file.
  const again = new Ledger(file, "agent-demo.near", () => now);
  assert.equal(again.spentToday(), 0);
  assert.equal(again.lastTradeAt("a.near"), Date.parse("2026-11-02T23:58:00Z"));
});

test("refused trades give the budget and the cool-down back; sending, pending and unclear count", () => {
  const now = Date.parse("2026-11-02T10:00:00Z");
  const l = new Ledger(join(tempHome(), "l.json"), "agent-demo.near", () => now);
  const a = l.reserve("buy", "a.near", 1);
  assert.equal(l.spentToday(), 1, "counted from before the send");
  l.settle(a, "refused", null);
  assert.equal(l.spentToday(), 0);
  assert.equal(l.lastTradeAt("a.near"), null);
  l.settle(l.reserve("buy", "a.near", 0.5), "pending", "t");
  l.settle(l.reserve("buy", "b.near", 0.25), "unclear", "u");
  l.reserve("sell", "c.near", 0.125);
  assert.equal(l.spentToday(), 0.875);
});

test("a filled trade is booked at what actually traded", () => {
  const now = Date.parse("2026-11-02T10:00:00Z");
  const file = join(tempHome(), "l.json");
  const l = new Ledger(file, "agent-demo.near", () => now);
  l.settle(l.reserve("sell", "a.near", 1.0), "filled", "t", 0.97);
  assert.equal(l.spentToday(), 0.97);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).days["2026-11-02"][0].tx, "t");
});

test("a ledger that can't be read stops the kit instead of guessing", async () => {
  const { writeFileSync } = await import("node:fs");
  const file = join(tempHome(), "l.json");
  writeFileSync(file, "{not json");
  assert.throws(() => new Ledger(file, "agent-demo.near"), /won't guess/);
});
