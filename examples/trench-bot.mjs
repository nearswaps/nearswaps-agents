#!/usr/bin/env node
// trench-bot: a scripted agent on @nearswaps/agent, the one in the demo video. It reads the new launches, runs the
// token check on up to 10 of them, buys the best one the policy allows with the agent key, then tries the
// lowest-scoring one at the same amount so a refusal by the policy shows on screen, and ends with the 1-click balance.
//
//   node examples/trench-bot.mjs --account <id> [--since 1440] [--amount 0.2] [--token <id>] [--refuse <id>] [--dry-run] [--color]
//
// --token and --refuse choose the buy and the refusal test instead of the launch list (for a recording, when nothing
// that launched trades on Rhea or Intear DEX: most launches are Nearly and JustHoot tokens on Rhea DCL, which the kit
// reads but does not trade).
//
// --dry-run loads no key and signs nothing: each buy becomes a dry run of the policy (the same rules in the same
// order), printed as "would pass" or "blocked". Without it the buys are real: the agent key signs them, under the
// contract's hard limits and the policy file, from the owner's 1-click balance.
//
// Plain text, one fact per line, no colour unless --color.
import { pathToFileURL } from "node:url";
import { Agent, Kit, loadPolicy, policyPath, moneyLines, previewLines, balanceLines, paint } from "@nearswaps/agent";

/** The most token checks one run makes: /api/safety allows 30 a minute per caller, and the kit caches each 60 s. */
export const MAX_CHECKS = 10;

const RHEA_OR_INTEAR = new Set(["rhea", "intear"]);

export function parseArgs(argv) {
  const o = { account: null, sinceMin: 1440, amount: "0.2", token: null, refuse: null, dryRun: false, color: false, policy: null, home: undefined };
  const val = (i, k) => { const v = argv[i + 1]; if (v === undefined || v.startsWith("--")) throw new Error(`--${k} needs a value`); return v; };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--account") o.account = val(i++, "account");
    else if (a === "--since") { o.sinceMin = Number(val(i++, "since")); if (!(Number.isInteger(o.sinceMin) && o.sinceMin > 0)) throw new Error("--since is a whole number of minutes"); }
    else if (a === "--amount") { o.amount = val(i++, "amount"); if (!/^\d+(\.\d+)?$/.test(o.amount) || Number(o.amount) <= 0) throw new Error("--amount is a NEAR amount, such as 0.2"); }
    else if (a === "--token") o.token = val(i++, "token");
    else if (a === "--refuse") o.refuse = val(i++, "refuse");
    else if (a === "--policy") o.policy = val(i++, "policy");
    else if (a === "--home") o.home = val(i++, "home");
    else if (a === "--dry-run") o.dryRun = true;
    else if (a === "--color") o.color = true;
    else throw new Error(`unknown argument "${a}"`);
  }
  if (!o.account) o.account = process.env.NEARSWAPS_AGENT_ACCOUNT || null;
  if (!o.account && !o.dryRun) throw new Error("--account <id> is needed for a real run (a dry run can go without one)");
  return o;
}

/** Which launches get the token check: the chosen tokens first (--token, --refuse), then the launches with the most
 * NEAR in the pool (then the most holders), at most MAX_CHECKS in all. */
export function toCheck(launches, chosen = [], max = MAX_CHECKS) {
  const seen = new Set(), out = [];
  for (const id of chosen.filter(Boolean)) if (!seen.has(id)) { out.push({ id, pad: "chosen", created: 0, liquidity_near: null, holders: 0, forced: true }); seen.add(id); }
  const ranked = launches.slice().sort((a, b) => (b.liquidity_near ?? -1) - (a.liquidity_near ?? -1) || b.holders - a.holders || b.created - a.created);
  for (const l of ranked) { if (out.length >= max) break; if (!seen.has(l.id)) { seen.add(l.id); out.push(l); } }
  return out;
}

/** Whether a row meets the policy's three token-check rules (score floor, unchecked findings, liquidity), as the policy
 * runs them: a trusted token skips all three, a missing liquidity figure counts as 0. */
export const meetsChecks = (r, policy) => (policy.trusted || []).includes(r.id)
  || (r.score != null && r.score >= policy.min_score && (r.unchecked ?? 0) <= policy.max_unchecked && (r.liquidity_near ?? 0) >= policy.min_liquidity_near);

/** The buy: the forced token if given, else the highest score among the tokens that meet the token-check rules and
 * that 1-click trades on Rhea or Intear DEX (the kit's venues). Rows carry { id, score, unchecked, liquidity_near,
 * tradeable }; `policy` is the policy file's. */
export function pickBuy(rows, policy, forced = null) {
  if (forced) return rows.find((r) => r.id === forced) || null;
  return rows.filter((r) => r.tradeable && r.score != null && meetsChecks(r, policy)).sort((a, b) => b.score - a.score)[0] || null;
}

/** The refusal: the lowest score below the floor, preferring a token the kit can trade, so that the policy (not the
 * venue) is what stops it. Never the token just bought. Null when every score meets the floor. */
export function pickRefusal(rows, minScore, boughtId = null, forced = null) {
  if (forced) return rows.find((r) => r.id === forced) || null;
  const low = rows.filter((r) => r.id !== boughtId && r.score != null && r.score < minScore).sort((a, b) => a.score - b.score);
  return low.find((r) => r.tradeable) || low[0] || null;
}

const age = (createdMs, now) => {
  if (!createdMs) return "unknown";
  const m = Math.max(0, Math.round((now - createdMs) / 60000));
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
};
const liq = (x) => (x == null ? "unknown" : `${(+x.toFixed(2)).toLocaleString("en-US")} NEAR`);

/**
 * The run. `kit` reads (an Agent is a Kit); `agent` signs, or null for a dry run. `out` takes one line at a time.
 * Returns what happened, for the tests: { rows, buy, refusal, buyResult, refusalResult }.
 */
export async function runBot({ kit, agent = null, policyFile, account = null, sinceMin = 1440, amount = "0.2", token = null, refuse = null, color = false, out = (l) => process.stdout.write(l + "\n"), now = Date.now }) {
  const policy = loadPolicy(policyFile);
  const dry = !agent;
  out(`mode: ${dry ? "dry run (no key loaded; nothing signed)" : `trading for ${agent.accountId} with the agent key`}`);
  out(`policy: ${policyFile}`);
  out(`score floor: ${policy.min_score}`);
  out(`most unchecked findings: ${policy.max_unchecked}`);
  out(`least liquidity: ${policy.min_liquidity_near} NEAR`);
  out(`per-trade maximum: ${policy.max_trade_near} NEAR`);
  out(`amount per buy: ${amount} NEAR`);

  // 1. New launches across the four launchpads.
  const forced = token ? kit.resolveToken(token) : null, forcedRefusal = refuse ? kit.resolveToken(refuse) : null;
  const r = await kit.listNewLaunches({ sinceMs: now() - sinceMin * 60_000, limit: 200 });
  out(`launches in the last ${sinceMin} minutes: ${r.launches.length}`);
  for (const [k, v] of Object.entries(r.sources || {})) if (!v.ok) out(`source ${k}: not answering (${v.note})`);

  // 2. The token check, one at a time, at most MAX_CHECKS (the kit's 60 s cache answers repeats).
  const picked = toCheck(r.launches, [forced, forcedRefusal]);
  out(`token checks this run: ${picked.length} (at most ${MAX_CHECKS})`);
  const rows = [];
  for (const l of picked) {
    let score = null, verdict = "token check failed", unchecked = null, liquidity_near = null;
    try { const c = await kit.checkToken(l.id); score = c.score; verdict = c.verdict; unchecked = c.unchecked; liquidity_near = c.liquidity_near; } catch (e) { verdict = `token check failed (${String(e.message || e).slice(0, 60)})`; }
    let tradeable = false;
    try { const m = await kit.market(l.id); tradeable = RHEA_OR_INTEAR.has(m.venueOf(l.id)); } catch (e) { /* not tradeable as far as we know */ }
    // Liquidity as the token check found it (what the policy uses); the launch feed's figure when the check gave none.
    rows.push({ id: l.id, pad: l.pad, age: l.forced ? "chosen" : age(l.created, now()), liquidity: liq(liquidity_near ?? l.liquidity_near), score, verdict, unchecked, liquidity_near, tradeable });
  }

  // 3. One line per token.
  for (const x of rows) out(`token: ${x.id} | launchpad ${x.pad} | age ${x.age} | liquidity ${x.liquidity} | score ${x.score ?? "none"} | unchecked ${x.unchecked ?? "none"} | verdict ${x.verdict} | 1-click ${x.tradeable ? "yes" : "no"}`);

  const attempt = async (row, label) => {
    out(`${label}: ${row.id} (score ${row.score ?? "none"})`);
    if (dry) {
      let p;
      try { p = await kit.previewTrade("buy", row.id, amount, { policyFile, account }); }
      catch (e) { p = { outcome: "blocked", reason: String(e.message || e), side: "buy", token: row.id, near: `${amount} NEAR`, account, score: row.score, policy_checks: [{ rule: "venue", status: "fail", detail: String(e.message || e) }] }; }
      for (const l of previewLines(p, color)) out(l);
      return p;
    }
    const res = await agent.buy(row.id, amount);
    for (const l of moneyLines(res, "buy", color)) out(l);
    return res;
  };
  const stopRule = (res) => (res.policy_checks || []).find((c) => c.status === "fail");

  // 4. The buy.
  const buy = pickBuy(rows, policy, forced);
  let buyResult = null;
  if (buy) buyResult = await attempt(buy, "buy");
  else out(`buy: none (no token checked this run meets the score floor of ${policy.min_score}, at most ${policy.max_unchecked} unchecked findings and ${policy.min_liquidity_near} NEAR of liquidity, and trades on Rhea or Intear DEX)`);

  // 5. The refusal, shown on purpose: the lowest score, at the same amount.
  const refusal = pickRefusal(rows, policy.min_score, buy ? buy.id : null, forcedRefusal);
  let refusalResult = null;
  if (refusal) {
    refusalResult = await attempt(refusal, "refusal test");
    const rule = stopRule(refusalResult);
    out(rule ? paint(`stopped by: ${rule.rule} (${["venue", "balance", "token", "amount", "gas_reserve"].includes(rule.rule) ? "a check the kit makes before signing" : rule.rule === "contract_caps" ? "a hard limit" : "the policy"})`, "red", color)
      : `stopped by: nothing (outcome ${refusalResult.outcome})`);
  } else out(`refusal test: none (every token checked this run scores ${policy.min_score} or more)`);

  // 6. The 1-click balance.
  if (account) { const b = await kit.getBalanceOf(account); for (const l of balanceLines(b)) out(l); }
  else out("1-click balance: no account given");
  return { rows, buy, refusal, buyResult, refusalResult };
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  const policyFile = o.policy || policyPath(o.home);
  const status = (t) => process.stderr.write(t + "\n");
  const agent = o.dryRun ? null : await Agent.open({ accountId: o.account, home: o.home, policyFile, onStatus: status });
  const kit = agent || new Kit();
  await runBot({ kit, agent, policyFile, account: o.account, sinceMin: o.sinceMin, amount: o.amount, token: o.token, refuse: o.refuse, color: o.color });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { process.stderr.write("error: " + String((e && e.message) || e) + "\n"); process.exitCode = 1; });
}
