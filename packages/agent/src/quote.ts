// Where a token trades for 1-click and what a trade would give: the panel's venueWanted, missingFor, quote,
// autoSlip and fee rule (neko-site/assets/oneclick.js lines 330 to 480 and 1000 to 1020; swap.js feeBpsFor).
// The kit trades on Rhea and on Intear DEX (spec part B). Rhea DCL launches (Nearly, JustHoot) and Shards
// curves are read but not traded by the kit: their trades go through the Terminal.
import { AUTO_REF_NEAR, DEFAULT_SLIPPAGE_BPS, FEE_BPS_DEFAULT, FEE_BPS_NEKO, FEE_WALLET, HOOT_RE, INTEAR_LAUNCH_RE, NEARLY_RE, NEKO, SHARDS_RE, TEAR, WNEAR } from "./constants.js";
import { oneClickIntear } from "./intear.js";
import type { PoolSource } from "./pools.js";
import { allowedPools, bestRoute, toContractRoute, type ContractLeg } from "./route.js";
import type { FetchLike, Rpc } from "./rpc.js";
import type { TradingConfig, Venue } from "./views.js";

export type VenueName = "rhea" | "intear" | "dcl" | "shards";
export const VENUE_NAMES: Record<VenueName, string> = { rhea: "Rhea", intear: "Intear DEX", dcl: "Rhea DCL", shards: "Shards" };

/** What 1-click knows about the contract right now. */
export class Market {
  constructor(readonly cfg: TradingConfig, private extraRegistered = new Map<string, boolean>(), private open = new Map<string, boolean>()) {}
  /** v1.5 is live when the contract lists what switching a token on costs. */
  get v15(): boolean { return Array.isArray(this.cfg.enable_cost) && this.cfg.enable_cost.length > 0; }
  /** v1.6: balances may sit at a venue. */
  get v16(): boolean { return typeof this.cfg.at_venue === "boolean"; }
  regd(key: string): boolean { return (Array.isArray(this.cfg.registered) && this.cfg.registered.includes(key)) || this.extraRegistered.get(key) === true; }
  listTruncated(): boolean { return Number(this.cfg.registered_total) > (this.cfg.registered || []).length; }
  setRegistered(key: string, on: boolean) { this.extraRegistered.set(key, on); }
  isOpen(t: string): boolean { return this.open.get(t) === true; }
  knowsOpen(t: string): boolean { return this.open.has(t); }
  setOpen(t: string, on: boolean) { this.open.set(t, on); }

  /** Where a token trades (oneclick.js venueWanted). The panel's isPlach list is every Intear launchpad token
   * and TEAR, as Pulse opens them. */
  venueWanted(t: string): VenueName {
    if (t === TEAR || INTEAR_LAUNCH_RE.test(t)) return "intear";
    if (this.v15 && SHARDS_RE.test(t)) return "shards";
    if (this.v15 && (NEARLY_RE.test(t) || HOOT_RE.test(t))) return "dcl";
    return "rhea";
  }
  /** What still has to be switched on for `t` on its venue (oneclick.js missingFor). */
  missingFor(t: string): [string, string][] {
    const v = this.venueWanted(t), need: [string, string][] = [];
    if (v === "intear") { if (!this.regd("intear|nep141:" + t)) need.push(["intear", t]); if (!this.regd("intear|near")) need.push(["intear", WNEAR]); }
    else if (v === "dcl") { if (!this.regd("dcl|" + t)) need.push(["dcl", t]); if (!this.regd("dcl|" + WNEAR)) need.push(["dcl", WNEAR]); }
    else if (v === "shards") { if (!this.regd("shards|" + t)) need.push(["shards", t]); if (!this.regd("shards|" + WNEAR) && !this.regd("dcl|" + WNEAR)) need.push(["dcl", WNEAR]); }
    else { if (!this.regd("rhea|" + t)) need.push(["rhea", t]); if (!this.regd("rhea|" + WNEAR)) need.push(["rhea", WNEAR]); }
    return need;
  }
  venueOf(t: string): VenueName | null { return this.missingFor(t).length ? null : this.venueWanted(t); }
  /** The keys a token needs, for are_registered when the config's list is cut short (oneclick.js keysFor). */
  static keysFor(t: string): string[] { return ["rhea|" + t, "rhea|" + WNEAR, "intear|nep141:" + t, "intear|near", "dcl|" + t, "dcl|" + WNEAR, "shards|" + t, "shards|" + WNEAR]; }
}

export interface Quote {
  venueName: VenueName;
  venue: Venue;
  /** Expected output before the site fee. */
  out: bigint;
  /** What min_out is taken from. */
  floor: bigint;
  /** Two Intear pools: the first pool's own quote. */
  mid?: bigint | null;
  impactBps?: number;
  legs?: ContractLeg[];
}

/** A quote for 1-click (oneclick.js quote): Rhea through the pools 1-click may use, or Intear DEX through its router. */
export async function quote(deps: { rpc: Rpc; fetch: FetchLike; pools: PoolSource }, market: Market, tIn: string, tOut: string, raw: bigint, venue: VenueName): Promise<Quote | null> {
  if (venue === "intear") {
    const buy = tIn === WNEAR, token = buy ? tOut : tIn;
    const r = await oneClickIntear(deps.fetch, deps.rpc, buy, token, raw);
    return r ? { venueName: "intear", out: r.out, floor: r.out, mid: r.mid, venue: r.venue } : null;
  }
  if (venue !== "rhea") return null;
  const cfg = market.cfg;
  const listed = new Set((cfg.trade_pools || []).map(Number));
  const base = await deps.pools.pools();
  const extra = await deps.pools.extraPools(listed, base);
  const pools = { ...base, ...extra };
  const allow = cfg.open_pools === true ? allowedPools(pools, cfg.trade_pools || [], true, (t) => market.regd("rhea|" + t)) : listed;
  const r = bestRoute(pools, tIn, tOut, raw, allow);
  if (!r || !(r.out > 0n)) return null;
  const legs = toContractRoute(r);
  return { venueName: "rhea", out: r.out, floor: r.out, impactBps: r.impactBps, legs, venue: { Rhea: { route: legs } } };
}

/** Auto slippage for one trade in bps (oneclick.js autoSlip): Rhea by pool depth (1% deep, up to 5% thin; at
 * least 3% for a token the community switched on), launches 5%, a Shards curve 10%. */
export function autoSlip(q: Pick<Quote, "venue" | "impactBps"> | null, nearValue: bigint, open: boolean): number {
  const v: any = q && q.venue;
  if (!v) return 500;
  if (v.Shards) return 1000;
  if (v.Dcl || v.Intear) return 500;
  const imp = Number(q!.impactBps);
  let s = 300;
  if (imp >= 0 && nearValue > 0n) {
    const ref = imp * Number((AUTO_REF_NEAR * 1000n) / nearValue) / 1000;
    s = ref <= 100 ? 100 : ref <= 500 ? 200 : ref <= 1500 ? 300 : 500;
  }
  return open && s < 300 ? 300 : s;
}

/** The trade's floor less the slippage, never below 1 (oneclick.js `less`). */
export const minOutFor = (floor: bigint, slipBps: number): bigint => { const m = (floor * BigInt(10000 - slipBps)) / 10000n; return m > 0n ? m : 1n; };

export type Slippage = number | "auto";
export function resolveSlippage(s: Slippage | undefined, q: Quote, nearValue: bigint, open: boolean): number {
  if (s === "auto") return autoSlip(q, nearValue, open);
  const v = s == null ? DEFAULT_SLIPPAGE_BPS : Number(s);
  if (!Number.isInteger(v) || v < 1 || v > 2000) throw new Error("slippage must be between 1 and 2000 bps (0.01% to 20%), or \"auto\"");
  return v;
}

/** The site fee the panel asks for (swap.js effectiveFeeBps): 0.5%, 1% with NEKO on either side, less the Feline
 * staker discount; nothing for the fee wallet. */
export function feeBpsAsked(owner: string, tIn: string, tOut: string, discountBps: number): number {
  if (owner === FEE_WALLET) return 0;
  const base = tIn === NEKO || tOut === NEKO ? FEE_BPS_NEKO : FEE_BPS_DEFAULT;
  return Math.round((base * (10000 - discountBps)) / 10000);
}
/** What the contract charges for that ask (trading.rs trade_fee_bps: floor 0.25%, 0.5% with NEKO, at most 1%). */
export function feeBpsCharged(owner: string, tIn: string, tOut: string, asked: number | null): number {
  if (owner === FEE_WALLET) return 0;
  const floor = tIn === NEKO || tOut === NEKO ? 50 : 25;
  return Math.min(100, Math.max(floor, asked == null ? floor * 2 : asked));
}
