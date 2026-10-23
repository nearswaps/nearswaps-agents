// The CLI's text: plain, one fact per line, "name: value", mono-friendly, no emoji. No colour unless asked (--color):
// then mint (#01FAC0) for buys and gains, red (#FF5C5C) for sells and losses, as on nearswaps.com. Pure functions
// of the results, so the tests read the same lines a person does.
import type { PreviewResult, QuoteResult } from "./agent.js";
import type { Launch } from "./launches.js";
import type { Policy, PolicyCheck } from "./policy.js";
import type { TokenCheck } from "./reads.js";
import type { MoneyResult } from "./result.js";

export type Tone = "mint" | "red";
const SGR: Record<Tone, string> = { mint: "\x1b[38;2;1;250;192m", red: "\x1b[38;2;255;92;92m" };
export const paint = (text: string, tone: Tone | null, color: boolean): string => (color && tone ? SGR[tone] + text + "\x1b[0m" : text);
const sideTone = (side: string): Tone | null => (side === "buy" ? "mint" : side === "sell" ? "red" : null);
const signTone = (x: number): Tone | null => (x > 0 ? "mint" : x < 0 ? "red" : null);
const usd = (x: number) => `${x < 0 ? "-" : ""}${Math.abs(x).toLocaleString("en-US", { maximumFractionDigits: 2, minimumFractionDigits: 2 })} USD`;
const iso = (ms: number) => (ms > 0 ? new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z") : "unknown");
type Line = string | false | null | undefined;
const keep = (ls: Line[]): string[] => ls.filter((l): l is string => !!l);

export function checkLines(c: TokenCheck): string[] {
  return keep([`token: ${c.token}`, `score: ${c.score}`, `verdict: ${c.verdict}`, `checked at: ${c.checked_at}${c.cached ? " (cached)" : ""}`,
    ...c.findings.map((f) => `finding: ${f.severity}: ${f.title}`), !c.findings.length && "findings: none", "lp browser pass: skipped (see the README)"]);
}

export function quoteLines(q: QuoteResult, color = false): string[] {
  const side = q.from === "wrap.near" ? "buy" : "sell";
  return keep([paint(`side: ${side}`, sideTone(side), color), `amount in: ${q.amount_in}`, `amount out: ${q.amount_out}`, `minimum: ${q.min_out} (slippage ${q.slippage_bps / 100}%)`,
    `fee: ${q.fee} (${q.fee_bps / 100}%)`, `venue: ${q.venue}`, q.impact_bps != null && `price impact: ${(q.impact_bps / 100).toFixed(2)}%`,
    ...q.route.map((l, i) => `leg ${i + 1}: ${l.amount_in} raw in, ${l.hops.map((h) => `pool ${h.pool_id} ${h.token_in} to ${h.token_out}`).join(", then ")}`),
    `quoted at: ${q.quoted_at}`]);
}

export function launchLines(r: { launches: Launch[]; sources: Record<string, { ok: boolean; note: string }> }): string[] {
  return keep([...r.launches.map((l) => `launch: ${iso(l.created)} ${l.pad} ${l.id} ${l.symbol} holders ${l.holders}${l.graduated ? " listed" : ""}`),
    !r.launches.length && "launches: none in that window",
    ...Object.entries(r.sources).filter(([, v]) => !v.ok).map(([k, v]) => `source ${k}: not answering (${v.note})`)]);
}

export function tradersLines(r: any, window: "7d" | "30d", limit: number, color = false): string[] {
  const w = r && r.windows && r.windows[window];
  const rows: any[] = (w && Array.isArray(w.rows) ? w.rows : []).slice(0, limit);
  return keep([`window: ${window}`, w && `active wallets: ${w.active}`,
    ...rows.map((x) => paint(`rank ${x.rank}: ${x.w} profit ${usd(Number(x.pnl) || 0)} roi ${x.roi}% win ${x.win}% trades ${x.n}`, signTone(Number(x.pnl) || 0), color)),
    !rows.length && `traders: none qualified in ${window}${window === "7d" ? " (try --window 30d)" : ""}`,
    r && r.updated_at && `updated at: ${iso(Number(r.updated_at))}`]);
}

export function walletLines(j: any, color = false): string[] {
  const win = (k: string) => j.windows && j.windows[k];
  const lines: Line[] = [`wallet: ${j.wallet}`];
  for (const k of ["7d", "30d"]) {
    const w = win(k);
    lines.push(`rank ${k}: ${j.rank && j.rank[k] != null ? j.rank[k] : "not ranked"}`);
    if (w) lines.push(paint(`profit ${k}: ${usd(Number(w.pnl) || 0)} roi ${w.roi}% win ${w.win}% trades ${w.n}`, signTone(Number(w.pnl) || 0), color));
  }
  const o = j.open || { value: 0, upnl: 0 };
  lines.push(`holding now: ${usd(Number(o.value) || 0)}`, paint(`unrealised: ${usd(Number(o.upnl) || 0)}`, signTone(Number(o.upnl) || 0), color));
  for (const p of Array.isArray(j.positions) ? j.positions : []) {
    const sym = (j.tokens && j.tokens[p.t] && j.tokens[p.t].sym) || p.t;
    lines.push(paint(`position: ${sym} ${p.t} value ${usd(Number(p.value) || 0)}${p.upnl != null ? ` unrealised ${usd(Number(p.upnl))}` : ""}`, signTone(Number(p.upnl) || 0), color));
  }
  if (j.recent_error) lines.push(`recent trades: not available (${j.recent_error})`);
  return keep(lines);
}

export function balanceLines(b: { account: string; balances: { amount: string }[]; wallet_free: string | null }): string[] {
  return keep([`account: ${b.account}`, ...b.balances.map((x) => `1-click balance: ${x.amount}`), !b.balances.length && "1-click balance: empty",
    b.wallet_free && `wallet free for gas: ${b.wallet_free}`]);
}

export function pendingLines(p: { id: string; kind: string; token_in: string; token_out: string; stage: number; unclear: boolean; recoverable_at: string }[]): string[] {
  return p.length ? p.map((x) => `pending ${x.id}: ${x.kind} ${x.token_in} to ${x.token_out} stage ${x.stage}${x.unclear ? " unclear" : ""} recoverable ${x.recoverable_at}`) : ["pending: nothing in progress"];
}

export function policyLines(s: { file: string; policy: Policy; today_utc: string; account: string | null; spent_today_near: number | null; left_today_near: number | null }): string[] {
  return keep([`file: ${s.file}`, ...Object.entries(s.policy).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") || "(none)" : v}`),
    `today (UTC): ${s.today_utc}`, s.account ? `account: ${s.account}` : "account: none given (spend is per account: pass --account)",
    s.spent_today_near != null && `spent today: ${s.spent_today_near} NEAR`, s.left_today_near != null && `left today: ${s.left_today_near} NEAR`]);
}

const checkLine = (c: PolicyCheck) => `check ${c.rule}: ${c.status} (${c.detail})`;

export function previewLines(r: PreviewResult, color = false): string[] {
  return keep([paint(`side: ${r.side}`, sideTone(r.side), color), `token: ${r.token}`, `near: ${r.near}`, `outcome: ${r.outcome}`, `reason: ${r.reason}`,
    r.score != null && `score: ${r.score}`, !r.account && "ledger: none (no account given, so today's spend counts as 0)", "signed: nothing (a dry run)", ...r.policy_checks.map(checkLine)]);
}

export function moneyLines(r: MoneyResult, side: "buy" | "sell" | "withdraw" | "recover", color = false): string[] {
  const tone = r.outcome === "filled" ? sideTone(side) : null;
  return keep([paint(`outcome: ${r.outcome}`, tone, color), `reason: ${r.reason}`, r.amount_in && `amount in: ${r.amount_in}`, r.amount_out && paint(`amount out: ${r.amount_out}`, tone, color),
    r.fee && `fee: ${r.fee}`, r.score != null && `score: ${r.score}`, r.tx && `tx: https://nearblocks.io/txns/${r.tx}`, ...r.policy_checks.map(checkLine)]);
}
