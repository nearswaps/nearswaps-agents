// trench-bot against the agent package's fake chain (recorded config and the Rhea pools of route fixtures 01 and 02):
// which launches get the token check, which one is bought, and the refusal by the policy. Offline; nothing reaches
// mainnet.
import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { Agent, Kit, DEFAULT_POLICY, newKeyPair, b58encode } from "@nearswaps/agent";
import { fakeNet, fixture, tempHome, txOutcome, NEAR } from "../packages/agent/test/helpers.mjs";
import { MAX_CHECKS, toCheck, pickBuy, pickRefusal, runBot, parseArgs } from "./trench-bot.mjs";
const POL = { ...DEFAULT_POLICY, trusted: [] };

const USDC = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const NEKO = "ftv2.nekotoken.near";
const NOW = Date.parse("2026-11-02T12:00:00Z");
const CFG = fixture("trading-config.json");
const F1 = fixture("routes/01-buy-usdc-with-1-near.json"), F2 = fixture("routes/02-buy-neko-with-5-near.json");
const POOLS = { ...F1.pools, ...F2.pools }, KINDS = { ...F1.pool_kinds, ...F2.pool_kinds };
const SCORES = { [USDC]: 88, [NEKO]: 30 };

const launch = (id, pad, liquidity_near, holders = 10) => ({ id, pad, symbol: id.split(".")[0].toUpperCase(), name: id, created: NOW - 3 * 3600_000, mc_usd: 0, vol24_usd: 0, liquidity_near, holders, price_usd: 0, graduated: false, progress: 0, creator: "", tax_buy_bps: null, tax_sell_bps: null });
// Two tokens 1-click trades on Rhea, and twelve Nearly launches (Rhea DCL: read by the kit, not traded), all scoring 20.
const LAUNCHES = [launch(USDC, "intear", 900), launch(NEKO, "shards", 800), ...Array.from({ length: 12 }, (_, i) => launch(`t${i}.nearlytrade.near`, "nearly", 50 - i))];

function world() {
  const home = tempHome();
  const policyFile = join(home, ".nearswaps-agent", "policy.json");
  mkdirSync(dirname(policyFile), { recursive: true });
  writeFileSync(policyFile, JSON.stringify({ ...DEFAULT_POLICY, trusted: [] }));
  const sent = [], checked = [];
  const net = fakeNet({
    views: {
      "nekoorders.near.get_trading_config": CFG,
      "nekoorders.near.get_trading": () => [{ token: "wrap.near", amount: (2n * NEAR).toString() }],
      "nekoorders.near.get_trading_parts": () => [{ token: "wrap.near", here: (2n * NEAR).toString(), rhea: "0", intear: "0" }],
      "nekoorders.near.are_open": ({ tokens }) => tokens.map(() => false),
      "nekoorders.near.are_registered": ({ keys }) => keys.map(() => false),
      "nekoorders.near.trade_gas_tgas": () => 110,
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
        return txOutcome("FILL", [{ event: "trade", data: { id: "9", owner: "agent-demo.near", venue: "rhea", token_in: "wrap.near", token_out: USDC, amount_in: (NEAR / 5n).toString(), amount_out: "984616", fee_bps: 50, fee_amount: "4948", fee_to: "nekotesting.near", referrer: null, at: "rhea" } }]);
      },
      tx: () => ({ transportError: true }),
    },
    http: [
      ["https://nearswaps.com/assets/swap-pools.json", fixture("swap-pools.json")],
      ["https://nearswaps.com/api/safety", (url) => { const t = new URL(url).searchParams.get("token"); checked.push(t); return { token: t, score: SCORES[t] ?? 20, verdict: (SCORES[t] ?? 20) >= 70 ? "nothing dangerous found" : "high risk", checked_at: "2026-11-02T12:00:00Z", findings: [], note: "", facts: { liquidity_near: 5000 } }; }],
    ],
  });
  return { net, sent, checked, home, policyFile };
}
const withLaunches = (kit) => { kit.listNewLaunches = async () => ({ launches: LAUNCHES, sources: {} }); return kit; };

test("which launches get the token check: the chosen first, then the most NEAR in the pool, never more than 10", () => {
  const picked = toCheck(LAUNCHES, ["blackdragon.tkn.near"]);
  assert.equal(picked.length, MAX_CHECKS);
  assert.equal(picked[0].id, "blackdragon.tkn.near");
  assert.deepEqual(picked.slice(1, 3).map((x) => x.id), [USDC, NEKO]);
  assert.equal(toCheck(LAUNCHES).length, 10);
  assert.equal(toCheck(LAUNCHES.slice(0, 3)).length, 3);
});

test("the buy is the best score at the floor or above that 1-click trades; the refusal prefers a tradeable low score", () => {
  const ok = { unchecked: 0, liquidity_near: 5000 };
  const rows = [{ id: "a", score: 95, tradeable: false, ...ok }, { id: "b", score: 80, tradeable: true, ...ok }, { id: "c", score: 72, tradeable: true, ...ok }, { id: "d", score: 10, tradeable: false, ...ok }, { id: "e", score: 40, tradeable: true, ...ok }];
  assert.equal(pickBuy(rows, POL).id, "b", "95 doesn't trade on Rhea or Intear DEX");
  assert.equal(pickBuy(rows, { ...POL, min_score: 90 }), null);
  assert.equal(pickBuy(rows, POL, "d").id, "d", "--token wins");
  // an empty launch scoring 99 is passed over: too many unchecked findings, or too little liquidity
  assert.equal(pickBuy([{ id: "empty", score: 99, tradeable: true, unchecked: 4, liquidity_near: 5000 }, ...rows], POL).id, "b");
  assert.equal(pickBuy([{ id: "thin", score: 99, tradeable: true, unchecked: 0, liquidity_near: 0 }, ...rows], POL).id, "b");
  assert.equal(pickBuy([{ id: "nofig", score: 99, tradeable: true, unchecked: 0, liquidity_near: null }, ...rows], POL).id, "b", "no figure counts as 0");
  assert.equal(pickBuy([{ id: "usdc.near", score: 20, tradeable: true, unchecked: 9, liquidity_near: 0 }], { ...POL, trusted: ["usdc.near"] }).id, "usdc.near", "trusted skips all three");
  assert.equal(pickRefusal(rows, 70, "b").id, "e", "the lowest the policy, not the venue, will stop");
  assert.equal(pickRefusal(rows.filter((r) => r.id !== "e"), 70, "b").id, "d", "else the lowest of all");
  assert.equal(pickRefusal(rows, 5), null);
  assert.equal(pickRefusal(rows, 70, "b", "c").id, "c", "--refuse wins");
  assert.throws(() => parseArgs(["--amount", "abc", "--dry-run"]));
  assert.throws(() => parseArgs([]), /--account/);
  assert.deepEqual(parseArgs(["--dry-run", "--since", "60"]).sinceMin, 60);
});

test("a real run: buys the best, the lowest is blocked by the score floor, then the balance; at most 10 checks", async () => {
  const w = world();
  const agent = withLaunches(await Agent.open({ accountId: "agent-demo.near", key: newKeyPair("agent-demo.near"), fetch: w.net.fetch, home: w.home, policyFile: w.policyFile, sleep: async () => {}, now: () => NOW }));
  const lines = [];
  const r = await runBot({ kit: agent, agent, policyFile: w.policyFile, account: "agent-demo.near", out: (l) => lines.push(l), now: () => NOW });
  assert.ok(new Set(w.checked).size <= MAX_CHECKS && w.checked.length <= MAX_CHECKS, "the buy's own check came from the 60 s cache");
  assert.equal(r.buy.id, USDC);
  assert.equal(r.buyResult.outcome, "filled");
  assert.equal(r.refusal.id, NEKO, "score 30 and trades on Rhea, chosen over the Nearly tokens at 20");
  assert.equal(r.refusalResult.outcome, "blocked");
  assert.equal(r.refusalResult.policy_checks.find((c) => c.status === "fail").rule, "score_floor");
  assert.equal(w.sent.length, 1, "only the buy was signed");
  assert.ok(lines.includes("outcome: filled"));
  assert.ok(lines.includes("check score_floor: fail (score 30 (high risk) is below the floor of 70)"));
  assert.ok(lines.includes("stopped by: score_floor (the policy)"));
  assert.ok(lines.includes("1-click balance: 2 NEAR"));
  assert.ok(lines.some((l) => l.startsWith(`token: ${USDC} | launchpad intear | age 3h 0m | liquidity 5,000 NEAR | score 88 | unchecked 0 |`)));
  for (const l of lines) { assert.doesNotMatch(l, /\x1b\[|[^\x20-\x7e]/, l); assert.doesNotMatch(l, /\n/); }
});

test("a dry run: no key, nothing signed; would pass and blocked", async () => {
  const w = world();
  const kit = withLaunches(new Kit({ fetch: w.net.fetch, now: () => NOW }));
  const lines = [];
  const r = await runBot({ kit, agent: null, policyFile: w.policyFile, out: (l) => lines.push(l), now: () => NOW });
  assert.equal(r.buyResult.outcome, "would pass");
  assert.equal(r.refusalResult.outcome, "blocked");
  assert.equal(w.net.log.some((x) => x.method === "send_tx"), false);
  assert.ok(lines.includes("mode: dry run (no key loaded; nothing signed)"));
  assert.ok(lines.includes("1-click balance: no account given"));
  assert.ok(lines.filter((l) => l === "signed: nothing (a dry run)").length === 2);
});
