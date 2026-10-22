// Rhea pool state for 1-click routes, read the way the Terminal reads it (swap.js loadPoolList, loadPools,
// oneClickExtraPools): the site's routing list (assets/swap-pools.json: classic and stable pools), each classic
// pool's reserves from get_pool_by_ids 100 at a time, each stable pool from get_stable_pool / get_rated_pool, and the
// contract's trade_pools that the list doesn't carry (classic only). Kept 15 seconds, like the Terminal.
import { POOL_LIST_URL } from "./constants.js";
import { getJson } from "./http.js";
import type { Pool, Pools } from "./route.js";
import type { FetchLike } from "./rpc.js";
import type { RawPool, Views } from "./views.js";

export interface PoolList { tokens: string[]; pools: [number, string][] }

/** A classic pool from get_pool_by_ids, or null when it isn't one 1-click routes through. */
export function parseSimple(id: number, p: RawPool | null): Pool | null {
  if (!p || p.pool_kind !== "SIMPLE_POOL" || !Array.isArray(p.token_account_ids) || p.token_account_ids.length !== 2) return null;
  return { id, kind: "SIMPLE_POOL", tokens: p.token_account_ids, amounts: p.amounts.map(BigInt), fee: p.total_fee };
}
/** A stable pool from get_stable_pool / get_rated_pool (swap.js loadPools). */
export function parseStable(id: number, kind: string, d: any): Pool {
  const lpd = kind === "RATED_SWAP" ? 24 : 18;
  const rates = kind === "RATED_SWAP" ? d.rates.map((x: string) => Number(x) / 10 ** 24) : d.c_amounts.map(() => 1);
  return { id, kind: kind as "STABLE_SWAP", tokens: d.token_account_ids, decimals: d.decimals, fee: d.total_fee, amp: d.amp, c: d.c_amounts.map(Number), rates, lpd, shares: d.shares_total_supply };
}

export class PoolSource {
  private list: { id: number; kind: string }[] | null = null;
  private listAt = 0;
  private state: Pools = {};
  private stateAt = 0;
  private extra: Pools = {};
  private extraKey = "";
  private extraAt = 0;

  constructor(private views: Views, private fetchFn: FetchLike, private listUrl = POOL_LIST_URL, private ttlMs = 15000) {}

  /** The routing list (swap.js applyPoolData: SIMPLE_POOL and STABLE_SWAP entries with integer ids). Kept an hour. */
  async poolList(): Promise<{ id: number; kind: string }[]> {
    if (this.list && Date.now() - this.listAt < 3600_000) return this.list;
    const data = (await getJson(this.fetchFn, this.listUrl, 9000)) as PoolList;
    this.list = (Array.isArray(data && data.pools) ? data.pools : []).filter(([id, kind]) => Number.isInteger(id) && ["SIMPLE_POOL", "STABLE_SWAP"].includes(kind)).map(([id, kind]) => ({ id, kind }));
    this.listAt = Date.now();
    return this.list;
  }

  /** Live state of the listed pools (swap.js loadPools). */
  async pools(force = false): Promise<Pools> {
    if (!force && Date.now() - this.stateAt < this.ttlMs) return this.state;
    const list = await this.poolList();
    const simpleIds = list.filter((p) => p.kind === "SIMPLE_POOL").map((p) => p.id);
    const stable = list.filter((p) => p.kind === "STABLE_SWAP" || p.kind === "RATED_SWAP");
    const chunks: number[][] = [];
    for (let i = 0; i < simpleIds.length; i += 100) chunks.push(simpleIds.slice(i, i + 100));
    const [simpleRes, stableRes] = await Promise.all([
      Promise.all(chunks.map((ids) => this.views.getPoolByIds(ids).then((arr) => arr.map((p, i) => [ids[i], p] as const)))),
      Promise.all(stable.map((p) => (p.kind === "RATED_SWAP" ? this.views.getRatedPool(p.id) : this.views.getStablePool(p.id)).then((d) => [p, d] as const).catch(() => null))),
    ]);
    const next: Pools = {};
    for (const [id, p] of simpleRes.flat()) { const x = parseSimple(id, p); if (x) next[id] = x; }
    for (const r of stableRes) { if (!r || !r[1]) continue; next[r[0].id] = parseStable(r[0].id, r[0].kind, r[1]); }
    if (!Object.keys(next).length) throw new Error("couldn't read any Rhea pools");
    this.state = next;
    this.stateAt = Date.now();
    return this.state;
  }

  /** Allowed pools missing from the listed state, read live and kept 15 seconds (swap.js oneClickExtraPools). */
  async extraPools(allow: Set<number>, have: Pools): Promise<Pools> {
    const missing = [...allow].filter((id) => Number.isInteger(id) && !have[id]).sort((x, y) => x - y);
    if (!missing.length) return {};
    const key = missing.join(",");
    if (key === this.extraKey && Date.now() - this.extraAt < this.ttlMs) return this.extra;
    const next: Pools = {};
    for (let i = 0; i < missing.length; i += 100) {
      const ids = missing.slice(i, i + 100);
      try {
        const arr = await this.views.getPoolByIds(ids);
        (arr || []).forEach((p, k) => { const x = parseSimple(ids[k], p); if (x) next[ids[k]] = x; });
      } catch (e) { /* those pools sit this quote out */ }
    }
    this.extra = next; this.extraAt = Date.now(); this.extraKey = key;
    return next;
  }
}
