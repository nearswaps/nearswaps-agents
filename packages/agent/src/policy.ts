// The policy: what the SDK enforces on top of the contract's hard limits. It lives where the agent runs
// (policy.json), with a local ledger of each UTC day's spend next to it. Checked before every money call, in this
// order (spec part D): paused flag; deny list; score floor; unchecked findings; liquidity; per-trade maximum in NEAR;
// daily budget; cool-down since the last trade in that token; the contract's own caps, read live. Sells are checked
// for budget and cool-down only: selling a bad token is never blocked by its score.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isAccountId, keyDir } from "./keys.js";
import { SYMBOLS, WNEAR } from "./constants.js";

export interface Policy {
  /** Stop every buy and sell (withdrawals always work). */
  paused: boolean;
  /** Token ids the agent never buys. */
  deny: string[];
  /** Token ids whose buys skip the three token-check rules (score floor, unchecked findings, liquidity) and only
   * those: the deny list and every other rule still apply. For tokens the token check scores low for reasons the owner
   * accepts, such as native USDC, whose issuer keeps its keys. */
  trusted: string[];
  /** The least token-check score a token must have for a buy (0 to 100). */
  min_score: number;
  /** The most "could not check" findings a token check may have for a buy. A finding the check couldn't make costs the
   * score nothing, so an empty launch can out-score a real token; this rule catches that. */
  max_unchecked: number;
  /** The least liquidity, in NEAR, the token check must find for a buy. */
  min_liquidity_near: number;
  /** The most NEAR one buy may spend. */
  max_trade_near: number;
  /** The most NEAR the agent may trade in one UTC day (buys: NEAR spent; sells: NEAR expected back). */
  daily_budget_near: number;
  /** Seconds to wait after a trade in a token before the next trade in that token. */
  cooldown_sec: number;
  /** Slippage for min_out, in bps (500 = 5%), or "auto" for the Terminal's auto slippage. */
  slippage_bps: number | "auto";
}

/** The README's example policy (also what "policy init" writes). */
export const DEFAULT_TRUSTED = [SYMBOLS.usdc, SYMBOLS.usdt, WNEAR];
export const DEFAULT_POLICY: Policy = { paused: false, deny: [], trusted: [...DEFAULT_TRUSTED], min_score: 70, max_unchecked: 3, min_liquidity_near: 100, max_trade_near: 1, daily_budget_near: 3, cooldown_sec: 600, slippage_bps: 500 };

export const policyPath = (home?: string) => join(keyDir(home), "policy.json");
export const ledgerPath = (policyFile: string, account: string) => join(dirname(policyFile), `ledger-${account}.json`);

/** Fields added after the first policy files were written (27 Oct 2026). A file without them still loads, with the
 * defaults filled in and one line saying so: the one exception to "missing is an error". */
export const ADDED_FIELDS = ["max_unchecked", "min_liquidity_near"] as const;

/** A policy file checked field by field: anything missing or out of range is an error, never a silent default, except
 * the ADDED_FIELDS, which take their defaults (`onNotice` is told which). */
export function parsePolicy(raw: unknown, onNotice?: (line: string) => void): Policy {
  const given = raw as Record<string, unknown>;
  if (!given || typeof given !== "object" || Array.isArray(given)) throw new Error("the policy must be a JSON object");
  const missing = ADDED_FIELDS.filter((k) => !(k in given));
  const p: Record<string, unknown> = { ...given };
  for (const k of missing) p[k] = DEFAULT_POLICY[k];
  if (missing.length && onNotice) onNotice(`policy: this file has no ${missing.join(" or ")}, so the defaults apply (${missing.map((k) => `${k} ${DEFAULT_POLICY[k]}`).join(", ")}); add them to the file to choose`);
  const known = new Set(Object.keys(DEFAULT_POLICY));
  const extra = Object.keys(p).filter((k) => !known.has(k));
  if (extra.length) throw new Error(`the policy has fields the kit doesn't know: ${extra.join(", ")}`);
  const num = (k: keyof Policy, lo: number, hi: number) => {
    const v = p[k];
    if (typeof v !== "number" || !isFinite(v) || v < lo || v > hi) throw new Error(`policy ${k} must be a number from ${lo} to ${hi}`);
    return v;
  };
  const int = (k: keyof Policy, lo: number, hi: number) => {
    const v = num(k, lo, hi);
    if (!Number.isInteger(v)) throw new Error(`policy ${k} must be a whole number from ${lo} to ${hi}`);
    return v;
  };
  if (typeof p.paused !== "boolean") throw new Error("policy paused must be true or false");
  const ids = (k: "deny" | "trusted") => {
    const v = p[k];
    if (!Array.isArray(v) || v.some((t) => typeof t !== "string" || !isAccountId(t.trim().toLowerCase()))) throw new Error(`policy ${k} must be a list of token account ids`);
    return (v as string[]).map((t) => t.trim().toLowerCase());
  };
  const deny = ids("deny"), trusted = ids("trusted");
  const slip = p.slippage_bps;
  if (!(slip === "auto" || (typeof slip === "number" && Number.isInteger(slip) && slip >= 1 && slip <= 2000))) throw new Error("policy slippage_bps must be 1 to 2000, or \"auto\"");
  return {
    paused: p.paused,
    deny,
    trusted,
    min_score: num("min_score", 0, 100),
    max_unchecked: int("max_unchecked", 0, 100),
    min_liquidity_near: num("min_liquidity_near", 0, 1e9),
    max_trade_near: num("max_trade_near", 0, 1e6),
    daily_budget_near: num("daily_budget_near", 0, 1e7),
    cooldown_sec: num("cooldown_sec", 0, 30 * 86400),
    slippage_bps: slip as number | "auto",
  };
}

const noticed = new Set<string>();
/** Where loadPolicy says an older file took defaults: stderr (stdout is the MCP protocol's), once per file and process. */
const stderrOnce = (file: string) => (line: string) => { if (noticed.has(file)) return; noticed.add(file); process.stderr.write(`${line} (${file})\n`); };

export function loadPolicy(file: string, onNotice: (line: string) => void = stderrOnce(file)): Policy {
  if (!existsSync(file)) throw Object.assign(new Error(`no policy file at ${file}: run "nearswaps-agent policy init" and edit it`), { noPolicy: true });
  let j: unknown;
  try { j = JSON.parse(readFileSync(file, "utf8")); } catch (e) { throw new Error(`the policy file ${file} is not valid JSON`); }
  return parsePolicy(j, onNotice);
}

export function writeDefaultPolicy(file: string): string {
  if (existsSync(file)) throw new Error(`a policy file already exists at ${file}`);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify(DEFAULT_POLICY, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  return file;
}

// ------------------------------------------------------------------ the ledger

/** The UTC day a time falls on: "2026-11-02". */
export const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

export type EntryOutcome = "sending" | "filled" | "refused" | "unclear" | "pending";
export interface LedgerEntry { id: string; at: number; side: "buy" | "sell"; token: string; near: number; outcome: EntryOutcome; tx: string | null }
interface LedgerFile { version: 1; account: string; days: Record<string, LedgerEntry[]>; last: Record<string, number> }

/** Outcomes that may have moved funds: they count against the budget and start the cool-down. A trade whose send
 * never came back ("sending") counts too, until it is known. */
const COUNTS = new Set<EntryOutcome>(["sending", "filled", "unclear", "pending"]);

export class Ledger {
  private data: LedgerFile;
  /** `file` null: an empty ledger kept in memory only (a dry run with no account). */
  constructor(readonly file: string | null, readonly account: string, private now: () => number = Date.now) {
    this.data = { version: 1, account, days: {}, last: {} };
    if (file && existsSync(file)) {
      try {
        const j = JSON.parse(readFileSync(file, "utf8"));
        if (j && j.version === 1 && j.account === account && j.days && j.last) this.data = j;
        else throw new Error("bad ledger");
      } catch (e) { throw new Error(`the ledger ${file} can't be read; it holds today's spend, so the kit won't guess: fix or remove it`); }
    }
  }
  private save() {
    if (!this.file) return;
    // Days older than 30 are dropped; the cool-down times stay.
    const keep = utcDay(this.now() - 30 * 86400_000);
    for (const d of Object.keys(this.data.days)) if (d < keep) delete this.data.days[d];
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = this.file + ".tmp";
    writeFileSync(tmp, JSON.stringify(this.data, null, 2) + "\n", { mode: 0o600 });
    renameSync(tmp, this.file);
  }
  /** NEAR traded so far this UTC day. */
  spentToday(): number {
    return (this.data.days[utcDay(this.now())] || []).filter((e) => COUNTS.has(e.outcome)).reduce((s, e) => s + e.near, 0);
  }
  entriesToday(): LedgerEntry[] { return (this.data.days[utcDay(this.now())] || []).slice(); }
  lastTradeAt(token: string): number | null { const v = this.data.last[token]; return typeof v === "number" ? v : null; }
  /** Written BEFORE the transaction is signed, so a crash mid-send still counts. Returns the entry id. */
  reserve(side: "buy" | "sell", token: string, near: number): string {
    const at = this.now(), id = at.toString(36) + Math.random().toString(36).slice(2, 6);
    (this.data.days[utcDay(at)] = this.data.days[utcDay(at)] || []).push({ id, at, side, token, near, outcome: "sending", tx: null });
    this.data.last[token] = at;
    this.save();
    return id;
  }
  /** The trade's outcome. A trade that never went out gives its budget and cool-down back. */
  settle(id: string, outcome: EntryOutcome, tx: string | null, near?: number): void {
    for (const list of Object.values(this.data.days)) {
      const e = list.find((x) => x.id === id);
      if (!e) continue;
      e.outcome = outcome; e.tx = tx;
      if (typeof near === "number" && isFinite(near)) e.near = near;
      if (!COUNTS.has(outcome)) {
        const prev = Object.values(this.data.days).flat().filter((x) => x.token === e.token && x.id !== id && COUNTS.has(x.outcome)).map((x) => x.at);
        if (prev.length) this.data.last[e.token] = Math.max(...prev); else delete this.data.last[e.token];
      }
      this.save();
      return;
    }
  }
}

/** The policy as it runs: the file, today's spend (UTC) and what is left. With no account, the policy alone (the ledger
 * is per account). Reads local files only: no key, no network. */
export function policyStatus(policyFile: string, account: string | null, now: () => number = Date.now) {
  const policy = loadPolicy(policyFile);
  const base = { file: policyFile, policy, today_utc: utcDay(now()) };
  if (!account) return { ...base, account: null, spent_today_near: null, left_today_near: null, trades_today: [] as LedgerEntry[] };
  const ledger = new Ledger(ledgerPath(policyFile, account), account, now);
  const spent = ledger.spentToday();
  return { ...base, account, spent_today_near: +spent.toFixed(6), left_today_near: +Math.max(0, policy.daily_budget_near - spent).toFixed(6), trades_today: ledger.entriesToday() };
}

// ------------------------------------------------------------------ the checks

export type CheckStatus = "pass" | "fail" | "skip";
export interface PolicyCheck { rule: string; status: CheckStatus; detail: string }

export interface CheckInput {
  side: "buy" | "sell";
  token: string;
  /** NEAR this trade spends (buy) or is expected to bring back (sell). */
  near: number;
  /** Raw wNEAR of the same, for the contract's per-trade cap. */
  nearRaw: bigint;
  /** The token check, fetched only for buys (a function, so a blocked deny-list buy never asks). Its findings marked
   * could_not_check and its liquidity_near feed max_unchecked and min_liquidity_near. */
  score: () => Promise<{ score: number; verdict: string; findings?: { title: string; could_not_check?: boolean }[]; liquidity_near?: number | null }>;
  contract: { paused: boolean; trade_paused: boolean; max_trade_wnear: bigint; max_trading_wnear: bigint };
}

const nearTxt = (x: number) => `${+x.toFixed(6)} NEAR`;
const wnearTxt = (raw: bigint) => `${+(Number(raw / 10n ** 18n) / 1e6).toFixed(6)} NEAR`;
/** The order of the rules, as listed in every money result. */
export const RULES = ["paused", "deny_list", "score_floor", "max_unchecked", "min_liquidity_near", "max_trade_near", "daily_budget_near", "cooldown_sec", "contract_caps"] as const;

/** Run the rules in order; the first failure stops the run (the rules after it are listed as "skip"). */
export async function runChecks(policy: Policy, ledger: Ledger, input: CheckInput, now: () => number = Date.now): Promise<{ checks: PolicyCheck[]; blocked: PolicyCheck | null; score: number | null }> {
  const checks: PolicyCheck[] = [];
  let score: number | null = null, check: Awaited<ReturnType<CheckInput["score"]>> | null = null;
  const sell = input.side === "sell", trusted = policy.trusted.includes(input.token);
  const notForThis = (rule: string): PolicyCheck | null => sell ? { rule, status: "skip", detail: "not applied to sells" }
    : trusted ? { rule, status: "skip", detail: `${input.token} is on the policy's trusted list: the token-check rules are not applied` } : null;
  const rules: [string, () => Promise<PolicyCheck>][] = [
    ["paused", async () => policy.paused ? { rule: "paused", status: "fail", detail: "the policy is paused (paused: true); withdrawals still work" } : { rule: "paused", status: "pass", detail: "the policy is not paused" }],
    ["deny_list", async () => sell ? { rule: "deny_list", status: "skip", detail: "not applied to sells" }
      : policy.deny.includes(input.token) ? { rule: "deny_list", status: "fail", detail: `${input.token} is on the policy's deny list` } : { rule: "deny_list", status: "pass", detail: "not on the deny list" }],
    ["score_floor", async () => {
      const skip = notForThis("score_floor"); if (skip) return skip;
      let r;
      try { r = await input.score(); } catch (e) { return { rule: "score_floor", status: "fail", detail: `the token check couldn't be read (${String((e as Error).message || e).slice(0, 100)}), so the score floor can't be met` }; }
      score = r.score; check = r;
      return r.score >= policy.min_score ? { rule: "score_floor", status: "pass", detail: `score ${r.score} (${r.verdict}) meets the floor of ${policy.min_score}` }
        : { rule: "score_floor", status: "fail", detail: `score ${r.score} (${r.verdict}) is below the floor of ${policy.min_score}` };
    }],
    ["max_unchecked", async () => {
      const skip = notForThis("max_unchecked"); if (skip) return skip;
      const not = (check?.findings || []).filter((f) => f.could_not_check).map((f) => f.title.replace(/^Could not check:\s*/i, ""));
      const named = not.length ? `: ${not.join("; ")}` : "";
      return not.length <= policy.max_unchecked ? { rule: "max_unchecked", status: "pass", detail: `${not.length} "could not check" finding${not.length === 1 ? "" : "s"}, within the most of ${policy.max_unchecked}${named}` }
        : { rule: "max_unchecked", status: "fail", detail: `the token check could not check ${not.length} things, more than the most of ${policy.max_unchecked}${named}` };
    }],
    ["min_liquidity_near", async () => {
      const skip = notForThis("min_liquidity_near"); if (skip) return skip;
      const known = typeof check?.liquidity_near === "number" && isFinite(check.liquidity_near);
      const liq = known ? (check!.liquidity_near as number) : 0;
      const what = known ? `${nearTxt(liq)} of liquidity` : "no liquidity figure from the token check (counted as 0 NEAR)";
      return liq >= policy.min_liquidity_near ? { rule: "min_liquidity_near", status: "pass", detail: `${what}, at or above the least of ${nearTxt(policy.min_liquidity_near)}` }
        : { rule: "min_liquidity_near", status: "fail", detail: `${what}, below the least of ${nearTxt(policy.min_liquidity_near)}` };
    }],
    ["max_trade_near", async () => sell ? { rule: "max_trade_near", status: "skip", detail: "not applied to sells" }
      : input.near <= policy.max_trade_near ? { rule: "max_trade_near", status: "pass", detail: `${nearTxt(input.near)} is within the per-trade maximum of ${nearTxt(policy.max_trade_near)}` }
      : { rule: "max_trade_near", status: "fail", detail: `${nearTxt(input.near)} is above the per-trade maximum of ${nearTxt(policy.max_trade_near)}` }],
    ["daily_budget_near", async () => {
      const spent = ledger.spentToday(), after = spent + input.near;
      return after <= policy.daily_budget_near + 1e-12 ? { rule: "daily_budget_near", status: "pass", detail: `${nearTxt(spent)} traded today (UTC); ${nearTxt(after)} with this trade, within ${nearTxt(policy.daily_budget_near)}` }
        : { rule: "daily_budget_near", status: "fail", detail: `${nearTxt(spent)} traded today (UTC); this trade would make ${nearTxt(after)}, above the daily budget of ${nearTxt(policy.daily_budget_near)}` };
    }],
    ["cooldown_sec", async () => {
      const last = ledger.lastTradeAt(input.token);
      const wait = last == null ? 0 : Math.ceil((last + policy.cooldown_sec * 1000 - now()) / 1000);
      return wait <= 0 ? { rule: "cooldown_sec", status: "pass", detail: last == null ? `no earlier trade in ${input.token}` : `the last trade in ${input.token} was more than ${policy.cooldown_sec} s ago` }
        : { rule: "cooldown_sec", status: "fail", detail: `the last trade in ${input.token} was less than ${policy.cooldown_sec} s ago; wait ${wait} s` };
    }],
    ["contract_caps", async () => {
      const c = input.contract;
      if (c.paused || c.trade_paused) return { rule: "contract_caps", status: "fail", detail: "1-click trading is paused on the contract (a hard limit); withdrawals still work" };
      if (c.max_trade_wnear > 0n && input.nearRaw > c.max_trade_wnear) return { rule: "contract_caps", status: "fail", detail: `${nearTxt(input.near)} is above the contract's per-trade cap, max_trade_wnear ${wnearTxt(c.max_trade_wnear)} (a hard limit)` };
      return { rule: "contract_caps", status: "pass", detail: `within the contract's max_trade_wnear of ${wnearTxt(c.max_trade_wnear)}${sell ? " (a sell is valued at the expected NEAR out)" : ""}; max_trading_wnear ${wnearTxt(c.max_trading_wnear)} caps the 1-click balance at deposit` };
    }],
  ];
  let blocked: PolicyCheck | null = null;
  for (const [rule, run] of rules) {
    if (blocked) { checks.push({ rule, status: "skip", detail: "not checked: an earlier rule blocked the trade" }); continue; }
    const c = await run();
    checks.push(c);
    if (c.status === "fail") blocked = c;
  }
  return { checks, blocked, score };
}
