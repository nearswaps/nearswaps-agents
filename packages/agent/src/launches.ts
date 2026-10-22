// New NEAR launches, read the way Pulse reads them (neko-site/assets/pulse-core.js and pulse.js): Nearly and
// JustHoot straight from their public APIs, Shards and Intear launchpad tokens through nearswaps.com's cached
// endpoints (their own APIs refuse other sites). One card shape for all four. Read-only.
import { HOOT_RE, INTEAR_LAUNCH_RE, NEARLY_RE, SHARDS_RE } from "./constants.js";

export type Pad = "shards" | "nearly" | "hoot" | "intear";
export interface Launch {
  id: string;
  pad: Pad;
  symbol: string;
  name: string;
  /** Unix ms, 0 when the feed doesn't say. */
  created: number;
  mc_usd: number;
  vol24_usd: number;
  /** NEAR in the pool, null when the feed doesn't say. */
  liquidity_near: number | null;
  holders: number;
  price_usd: number;
  /** Listed on nearswaps (100+ NEAR in the pool and 50+ holders), or graduated off a Shards curve. */
  graduated: boolean;
  /** 0 to 1: the way to that bar. */
  progress: number;
  creator: string;
  tax_buy_bps: number | null;
  tax_sell_bps: number | null;
}

export const LIST_NEAR = 100, LIST_HOLDERS = 50;
const n = (x: unknown) => { const v = Number(x); return isFinite(v) ? v : 0; };
const s = (x: unknown, len = 48) => String(x == null ? "" : x).replace(/[\u0000-\u001f\u007f<>]/g, "").trim().slice(0, len);
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

// Anything calling itself NEKO is never shown (pulse-core.js looksLikeNeko, the same rule as the swap lists).
const NEKO_HIDDEN = /[­͏؜ᅟᅠ឴឵᠋-᠏​-‏‪-‮⁠-⁯ㅤ︀-️﻿ﾠ]/g;
const NEKO_SAME: Record<string, string> = {
  "а": "a", "в": "b", "е": "e", "ё": "e", "є": "e", "э": "e", "ԑ": "e", "к": "k", "қ": "k", "ҝ": "k", "ҟ": "k", "ӄ": "k", "ҡ": "k",
  "м": "m", "о": "o", "ө": "o", "ӧ": "o", "р": "p", "с": "c", "т": "t", "у": "y", "х": "x", "і": "i", "ї": "i", "ј": "j", "ѕ": "s",
  "ԛ": "q", "ԝ": "w", "ү": "y", "һ": "h", "ң": "n", "ҥ": "n", "ӈ": "n", "ӊ": "n",
  "α": "a", "β": "b", "ε": "e", "ϵ": "e", "έ": "e", "ι": "i", "κ": "k", "ϰ": "k", "ο": "o", "ό": "o", "σ": "o", "ρ": "p", "τ": "t",
  "υ": "u", "χ": "x", "ω": "w", "ϲ": "c", "ϳ": "j", "ϻ": "m",
  "օ": "o", "ո": "n", "հ": "h", "ս": "u", "ø": "o", "ɵ": "o", "ĸ": "k", "ı": "i", "ŋ": "n", "ɴ": "n", "ᴇ": "e", "ᴋ": "k", "ᴏ": "o", "ᴎ": "n",
};
const NEKO_TWO: Record<string, [string, string]> = { "н": ["h", "n"], "ν": ["v", "n"], "η": ["h", "n"], "и": ["u", "n"], "й": ["u", "n"], "п": ["n", "n"], "π": ["n", "n"], "ի": ["h", "n"] };
export function looksLikeNeko(...texts: unknown[]): boolean {
  return texts.some((t) => {
    const x = String(t || "").normalize("NFKC").toLowerCase().replace(NEKO_HIDDEN, "");
    if (/ネコ|ねこ|猫|貓/.test(x)) return true;
    const flat = x.normalize("NFKD").replace(/\p{M}/gu, "");
    return [0, 1].some((v) => Array.from(flat, (c) => (NEKO_TWO[c] ? NEKO_TWO[c][v] : NEKO_SAME[c] || c)).join("")
      .replace(/0/g, "o").replace(/3/g, "e").replace(/[^a-z]/g, "").includes("neko"));
  });
}

/** Shards token (nearswaps.com/api/market?kind=launches). */
export function fromShards(t: any, nearUsd: number): Launch | null {
  if (!t || !SHARDS_RE.test(t.id)) return null;
  const graduated = t.status === "graduated" || t.progress_bps >= 10000;
  return { id: t.id, pad: "shards", symbol: s(t.symbol, 16) || "?", name: s(t.name), created: n(t.created), mc_usd: n(t.mcap_near) * nearUsd,
    vol24_usd: n(t.vol24_near) * nearUsd, liquidity_near: null, holders: n(t.holders), price_usd: n(t.price_near) * nearUsd, graduated,
    progress: graduated ? 1 : clamp01(n(t.progress_bps) / 10000), creator: s(t.creator, 80), tax_buy_bps: n(t.buy_tax_bps), tax_sell_bps: n(t.sell_tax_bps) };
}
/** Nearly launch (nearly.trade/api/launches). */
export function fromNearly(t: any, listed?: Set<string>): Launch | null {
  const id = s(t && t.token, 80);
  if (!NEARLY_RE.test(id) || t.step !== "Done" || t.quote !== "wrap.near") return null;
  const nearUsd = n(t.near_usd) || 0, liq = n(t.liquidity_near), holders = n(t.holders);
  const isListed = (listed && listed.has(id)) || (liq >= LIST_NEAR && holders >= LIST_HOLDERS);
  return { id, pad: "nearly", symbol: s(t.symbol, 16) || "?", name: s(t.name), created: n(t.created_at_ms), mc_usd: n(t.fdv_usd) || n(t.fdv_near) * nearUsd,
    vol24_usd: n(t.volume_24h_near) * nearUsd, liquidity_near: liq, holders, price_usd: n(t.price_usd), graduated: !!isListed,
    progress: isListed ? 1 : Math.min(0.99, Math.min(liq / LIST_NEAR, holders / LIST_HOLDERS)), creator: s(t.creator, 80), tax_buy_bps: null, tax_sell_bps: null };
}
/** JustHoot room (api.justhoot.fun/api/rooms). */
export function fromHoot(r: any, listed: Set<string> | undefined, nearUsd: number): Launch | null {
  const tok = (r && r.token) || {};
  const id = s(tok.id, 80);
  if (!HOOT_RE.test(id) || !r.quote || r.quote.id !== "wrap.near") return null;
  const holders = n(r.holder_count), isListed = !!(listed && listed.has(id));
  return { id, pad: "hoot", symbol: s(tok.symbol, 16) || "?", name: s(tok.name), created: Date.parse(r.created_at) || 0, mc_usd: n(r.market_cap_usd),
    vol24_usd: n(r.volume_24h_usd), liquidity_near: null, holders, price_usd: n(r.price_usd) || n(r.price) * nearUsd, graduated: isListed,
    progress: isListed ? 1 : Math.min(0.99, holders / LIST_HOLDERS), creator: s(r.creator_id, 80), tax_buy_bps: null, tax_sell_bps: null };
}
/** Intear launchpad token (nearswaps.com/api/intear-tokens "launches"). */
export function fromIntear(t: any, listed?: Set<string>): Launch | null {
  const id = s(t && t.id, 80);
  if (!INTEAR_LAUNCH_RE.test(id)) return null;
  const liq = n(t.pool_near), holders = n(t.holders), isListed = !!t.listed || !!(listed && listed.has(id));
  return { id, pad: "intear", symbol: s(t.symbol, 16) || "?", name: s(t.name), created: n(t.created_at), mc_usd: n(t.mcap_usd), vol24_usd: n(t.volume_24h_usd),
    liquidity_near: liq, holders, price_usd: n(t.price_usd), graduated: isListed, progress: isListed ? 1 : Math.min(0.99, Math.min(liq / LIST_NEAR, holders / LIST_HOLDERS)),
    creator: s(t.creator, 80), tax_buy_bps: null, tax_sell_bps: null };
}
/** Cards from all feeds, first one wins per id, NEKO look-alikes dropped (pulse-core.js merge). */
export function mergeLaunches(...lists: (Launch | null)[][]): Launch[] {
  const by = new Map<string, Launch>();
  for (const l of lists) for (const c of l || []) { if (!c || looksLikeNeko(c.symbol, c.name)) continue; if (!by.has(c.id)) by.set(c.id, c); }
  return [...by.values()];
}
