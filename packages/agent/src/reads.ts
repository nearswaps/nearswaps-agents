// The agent's eyes: nearswaps.com's public read endpoints (no key; CORS open) and the launchpads' own feeds.
// Everything here is read-only. /api/safety is limited per caller (30 a minute), so check_token answers are
// kept 60 seconds per token; agents should not poll.
import { API_BASE, CHECK_CACHE_MS, HOOT_API, NEARLY_API } from "./constants.js";
import { getJson } from "./http.js";
import { fromHoot, fromIntear, fromNearly, fromShards, mergeLaunches, type Launch, type Pad } from "./launches.js";
import type { FetchLike } from "./rpc.js";

/** The verdicts the token check prints (netlify/shared/safety.mjs verdictOf). */
export const VERDICTS = ["nothing dangerous found", "caution", "high risk"] as const;
export type Verdict = (typeof VERDICTS)[number];

export interface Finding { id: string; check: string; severity: string; title: string; detail: string; could_not_check?: boolean }
export interface TokenCheck {
  token: string;
  score: number;
  verdict: Verdict;
  checked_at: string;
  findings: Finding[];
  /** True when this answer came from the kit's 60 s cache. */
  cached: boolean;
  /** The token check's own note ("a list of things we checked, not a guarantee"). */
  note: string;
  /** Rhea LP holders the page reads in the visitor's browser are not sent by the kit (see the README). */
  lp_browser_pass: "skipped";
}

export type Timeframe = "1m" | "5m" | "15m" | "1h" | "4h" | "1d";

export interface ReadsOptions { fetch?: FetchLike; apiBase?: string; now?: () => number }

export class Reads {
  private readonly fetchFn: FetchLike;
  private readonly base: string;
  private readonly now: () => number;
  private checks = new Map<string, { at: number; body: TokenCheck }>();

  constructor(opts: ReadsOptions = {}) {
    this.fetchFn = opts.fetch || (globalThis.fetch as unknown as FetchLike);
    this.base = (opts.apiBase || API_BASE).replace(/\/$/, "");
    this.now = opts.now || Date.now;
  }

  private api(path: string, q: Record<string, string | number | undefined> = {}): Promise<any> {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== "") p.set(k, String(v));
    const qs = p.toString();
    return getJson(this.fetchFn, `${this.base}/${path}${qs ? "?" + qs : ""}`, 15000);
  }

  /** The token check (/api/safety): score 0 to 100, verdict, findings worst first. Cached 60 s per token. */
  async checkToken(token: string, opts: { fresh?: boolean } = {}): Promise<TokenCheck> {
    const id = String(token || "").trim().toLowerCase();
    const hit = this.checks.get(id);
    if (!opts.fresh && hit && this.now() - hit.at < CHECK_CACHE_MS) return { ...hit.body, cached: true };
    const j = await this.api("safety", { token: id });
    const score = Number(j && j.score);
    if (!(score >= 0 && score <= 100) || !VERDICTS.includes(j.verdict)) throw new Error("the token check's answer can't be read");
    const findings: Finding[] = (Array.isArray(j.findings) ? j.findings : []).map((f: any) => ({ id: String(f.id || ""), check: String(f.check || ""), severity: String(f.severity || ""),
      title: String(f.title || ""), detail: String(f.detail || ""), ...(f.could_not_check ? { could_not_check: true } : {}) }));
    const body: TokenCheck = { token: String(j.token || id), score, verdict: j.verdict, checked_at: String(j.checked_at || ""), findings, cached: false, note: String(j.note || ""), lp_browser_pass: "skipped" };
    this.checks.set(id, { at: this.now(), body });
    return body;
  }

  // Market data (/api/market, the Terminal's own cached source).
  pools(token: string) { return this.api("market", { kind: "pools", token }); }
  ohlcv(pool: string, tf: Timeframe = "15m", opts: { side?: "base" | "quote"; before?: number } = {}) { return this.api("market", { kind: "ohlcv", pool, tf, side: opts.side, before: opts.before }); }
  trades(pool: string) { return this.api("market", { kind: "trades", pool }); }
  holders(token: string) { return this.api("market", { kind: "holders", token }); }
  shardsLaunches() { return this.api("market", { kind: "launches" }); }

  /** Top Traders (7 and 30 days, by realised profit). */
  traders() { return this.api("traders"); }
  /** Any wallet's trading record. */
  wallet(id: string) { return this.api("wallet", { id }); }
  /** A wallet's open auto orders, fills and expiries. */
  orders(account: string) { return this.api("orders", { account }); }
  /** Intear launchpad tokens: `tokens` (listed) and `launches` (all). */
  intearTokens() { return this.api("intear-tokens"); }
  /** The busiest Rhea tokens of the last 12 hours. */
  trending() { return this.api("trending"); }
  nearlyListed() { return this.api("nearly-tokens"); }
  hootListed() { return this.api("hoot-tokens"); }

  /** Every new launch across Shards, Nearly, JustHoot and Intear, newest first, the way Pulse reads them.
   * `sinceMs`: only launches created after this time. Each feed's state is in `sources`. */
  async newLaunches(opts: { sinceMs?: number; limit?: number; pads?: Pad[] } = {}): Promise<{ launches: Launch[]; sources: Record<Pad, { ok: boolean; note: string }> }> {
    const sources = {} as Record<Pad, { ok: boolean; note: string }>;
    const want = new Set<Pad>(opts.pads && opts.pads.length ? opts.pads : ["shards", "nearly", "hoot", "intear"]);
    const settle = async <T>(pad: Pad, f: () => Promise<T>): Promise<T | null> => {
      if (!want.has(pad)) return null;
      try { const r = await f(); sources[pad] = { ok: true, note: "" }; return r; } catch (e) { sources[pad] = { ok: false, note: String((e as Error).message || e).slice(0, 120) }; return null; }
    };
    const [intear, nearly, hoot, shards, nearlyL, hootL] = await Promise.all([
      settle("intear", () => this.intearTokens()),
      settle("nearly", () => getJson(this.fetchFn, NEARLY_API + "?sort=new&limit=100", 9000)),
      settle("hoot", () => getJson(this.fetchFn, HOOT_API, 9000)),
      settle("shards", () => this.shardsLaunches()),
      want.has("nearly") ? this.nearlyListed().catch(() => null) : null,
      want.has("hoot") ? this.hootListed().catch(() => null) : null,
    ]);
    const nearUsd = Number(intear && intear.near_usd) || (Array.isArray(nearly) ? Number((nearly.find((t: any) => Number(t.near_usd) > 0) || {}).near_usd) : 0) || 0;
    const ids = (j: any) => new Set<string>(((j && j.tokens) || []).map((t: any) => String(t.id)));
    const intearListed = ids(intear);
    const cards = mergeLaunches(
      ((shards && shards.tokens) || []).map((t: any) => fromShards(t, nearUsd)),
      (Array.isArray(nearly) ? nearly : []).map((t: any) => fromNearly(t, ids(nearlyL))),
      ((hoot && hoot.rooms) || []).map((r: any) => fromHoot(r, ids(hootL), nearUsd)),
      ((intear && intear.launches) || []).map((t: any) => fromIntear(t, intearListed)),
    );
    const since = Number(opts.sinceMs) || 0;
    const launches = cards.filter((c) => c.created > since).sort((a, b) => b.created - a.created).slice(0, opts.limit || 100);
    return { launches, sources };
  }
}
