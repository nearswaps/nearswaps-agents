// Rhea routing for 1-click: a port of netlify/shared/route.mjs (loadPools, bestRoute, toContractRoute) with the two
// things the Terminal's own router adds (neko-site/assets/swap.js bestRoute, which oneClickRoute calls): the
// stable-pool maths, since the site's routing list has a stable pool and the contract's open pools allow it, and
// the `allow` set (only pools whose tokens are all switched on for 1-click on Rhea, or, with closed pools, only
// the contract's trade_pools). Where the two differ the panel wins; the test suite checks this port against ten
// routes recorded from the live Terminal.

export const MAX_LEGS = 3;
export const SPLIT_STEPS = 20;

export interface SimplePool { id: number; kind: "SIMPLE_POOL"; tokens: string[]; amounts: bigint[]; fee: number }
export interface StablePool { id: number; kind: "STABLE_SWAP" | "RATED_SWAP"; tokens: string[]; decimals: number[]; fee: number; amp: number; c: number[]; rates: number[]; lpd: number; shares?: string }
export type Pool = SimplePool | StablePool;
/** Pools by id. A plain object on purpose: its integer keys iterate in ascending order, as swap.js poolState does. */
export type Pools = Record<string, Pool>;
export interface Hop { pool: Pool; tIn: string; tOut: string }
export interface Path { hops: Hop[] }
export interface Leg { path: Path; amountIn: bigint; out: bigint }
export interface Route { legs: Leg[]; out: bigint; impactBps: number }
export interface ContractLeg { amount_in: string; hops: { pool_id: number; token_in: string; token_out: string }[] }

/** Constant-product output with the pool's fee (bps), exact integer maths (Rhea SIMPLE_POOL). */
export function simpleOut(p: SimplePool, tIn: string, tOut: string, amt: bigint): bigint {
  const i = p.tokens.indexOf(tIn), o = p.tokens.indexOf(tOut);
  if (i < 0 || o < 0) return 0n;
  const rIn = p.amounts[i], rOut = p.amounts[o];
  if (amt <= 0n || rIn <= 0n || rOut <= 0n) return 0n;
  const withFee = amt * BigInt(10000 - p.fee);
  return (withFee * rOut) / (10000n * rIn + withFee);
}

// StableSwap (Rhea STABLE_SWAP / RATED_SWAP), the same float maths as swap.js (and Rhea's SDK).
function calcD(amp: number, c: number[]): number {
  const n = c.length, sum = c.reduce((a, b) => a + b, 0);
  let d = sum, dPrev = 0;
  for (let k = 0; k < 256; k++) {
    let dProd = d;
    for (const x of c) dProd = (dProd * d) / (x * n);
    dPrev = d;
    const ann = amp * n ** n;
    d = (dPrev * (dProd * n + ann * sum)) / (dPrev * (ann - 1) + dProd * (n + 1));
    if (Math.abs(d - dPrev) <= 1) break;
  }
  return d;
}
function calcY(amp: number, xNew: number, c: number[], ix: number, iy: number): number {
  const n = c.length, ann = amp * n ** n, d = calcD(amp, c);
  let s = xNew, cc = (d * d) / xNew;
  for (let k = 0; k < n; k++) if (k !== ix && k !== iy) { s += c[k]; cc = (cc * d) / c[k]; }
  cc = (cc * d) / (ann * n ** n);
  const b = d / ann + s;
  let y = d, yPrev = 0;
  for (let k = 0; k < 256; k++) { yPrev = y; y = (y * y + cc) / (2 * y + b - d); if (Math.abs(y - yPrev) <= 1) break; }
  return y;
}
export function stableOut(p: StablePool, tIn: string, tOut: string, amt: bigint): bigint {
  const i = p.tokens.indexOf(tIn), o = p.tokens.indexOf(tOut);
  if (amt <= 0n || i < 0 || o < 0) return 0n;
  const c = p.c.map((x, k) => x * p.rates[k]);
  if (c.some((x) => !(x > 0))) return 0n;
  const inC = (Number(amt) / 10 ** p.decimals[i]) * p.rates[i] * 10 ** p.lpd;
  const y = calcY(Number(p.amp), inC + c[i], c, i, o);
  const dy = c[o] - y;
  const out = (dy - (dy * p.fee) / 10000) / p.rates[o] / 10 ** p.lpd;
  if (!(out > 0) || !isFinite(out)) return 0n;
  // round down, and shave a hair off for float error so the minimum is never too tight
  return BigInt(Math.floor(out * 10 ** p.decimals[o] * 0.99999));
}
export function poolOut(p: Pool, tIn: string, tOut: string, amt: bigint): bigint {
  return p.kind === "SIMPLE_POOL" ? simpleOut(p, tIn, tOut, amt) : stableOut(p, tIn, tOut, amt);
}

export function poolsFor(pools: Pools, a: string, b: string): Pool[] {
  return Object.values(pools).filter((p) => p.tokens.includes(a) && p.tokens.includes(b));
}
/** Every direct and two-hop path from a to b (only through the pools in `allow` when it is given). */
export function allPaths(pools: Pools, a: string, b: string, allow?: Set<number>): Path[] {
  const ok = (p: Pool) => !allow || allow.has(Number(p.id));
  const paths: Path[] = [];
  for (const p of poolsFor(pools, a, b)) if (ok(p)) paths.push({ hops: [{ pool: p, tIn: a, tOut: b }] });
  const mids = new Set<string>();
  for (const p of Object.values(pools)) if (ok(p) && p.tokens.includes(a)) p.tokens.forEach((t) => { if (t !== a && t !== b) mids.add(t); });
  for (const m of mids) {
    const first = poolsFor(pools, a, m).filter(ok), second = poolsFor(pools, m, b).filter(ok);
    for (const p1 of first) for (const p2 of second) if (p1.id !== p2.id) paths.push({ hops: [{ pool: p1, tIn: a, tOut: m }, { pool: p2, tIn: m, tOut: b }] });
  }
  return paths;
}
export function pathOut(path: Path, amt: bigint): bigint {
  let x = amt;
  for (const h of path.hops) { x = poolOut(h.pool, h.tIn, h.tOut, x); if (x <= 0n) return 0n; }
  return x;
}
const pathPools = (path: Path) => path.hops.map((h) => h.pool.id);

/** Best way to trade `total`: every path alone, then a greedy split across up to MAX_LEGS paths that share no pool
 * (so each leg's quote stays exact). */
export function bestRoute(pools: Pools, a: string, b: string, total: bigint, allow?: Set<number>): Route | null {
  if (total <= 0n) return null;
  const paths = allPaths(pools, a, b, allow);
  if (!paths.length) return null;
  const scored = paths.map((p) => ({ p, out: pathOut(p, total) })).filter((x) => x.out > 0n).sort((x, y) => (y.out > x.out ? 1 : y.out < x.out ? -1 : 0));
  if (!scored.length) return null;
  const cands = scored.slice(0, 10).map((x) => x.p);
  const alloc = new Map<Path, bigint>();
  const chunk = total / BigInt(SPLIT_STEPS);
  if (chunk > 0n) {
    for (let s = 0; s < SPLIT_STEPS; s++) {
      const add = s === SPLIT_STEPS - 1 ? total - chunk * BigInt(SPLIT_STEPS - 1) : chunk;
      const used = new Set([...alloc.keys()].flatMap(pathPools));
      let best: Path | null = null, bestGain = -1n;
      for (const c of cands) {
        const cur = alloc.get(c) || 0n;
        if (!alloc.has(c) && (alloc.size >= MAX_LEGS || pathPools(c).some((id) => used.has(id)))) continue;
        const gain = pathOut(c, cur + add) - (cur > 0n ? pathOut(c, cur) : 0n);
        if (gain > bestGain) { bestGain = gain; best = c; }
      }
      if (!best) break;
      alloc.set(best, (alloc.get(best) || 0n) + add);
    }
  }
  let legs: Leg[] = [...alloc.entries()].map(([p, amt]) => ({ path: p, amountIn: amt, out: pathOut(p, amt) }));
  const splitOut = legs.reduce((s, l) => s + l.out, 0n);
  const single = { path: scored[0].p, amountIn: total, out: scored[0].out };
  if (!legs.length || single.out >= splitOut) legs = [single];
  // Rhea needs the leg amounts to add up exactly to what is sent.
  const sum = legs.reduce((s, l) => s + l.amountIn, 0n);
  if (sum !== total) { legs[0].amountIn += total - sum; legs[0].out = pathOut(legs[0].path, legs[0].amountIn); }
  const out = legs.reduce((s, l) => s + l.out, 0n);
  // Price impact: each leg against a tiny trade on that same path.
  let impactBps = 0, ideal = 0n;
  for (const l of legs) {
    const tiny = l.amountIn / 10000n;
    if (tiny <= 0n) { ideal = 0n; break; }
    ideal += pathOut(l.path, tiny) * 10000n;
  }
  if (ideal > out) impactBps = Number(((ideal - out) * 10000n) / ideal);
  return { legs, out, impactBps };
}

/** The route in the contract's `Leg` shape. */
export function toContractRoute(route: Route): ContractLeg[] {
  return route.legs.map((l) => ({ amount_in: l.amountIn.toString(), hops: l.path.hops.map((h) => ({ pool_id: Number(h.pool.id), token_in: h.tIn, token_out: h.tOut })) }));
}

/** The pools 1-click may route through right now (swap.js oneClickRoute): with open pools, every pool known whose
 * tokens are all switched on for 1-click on Rhea; otherwise the contract's trade_pools. */
export function allowedPools(pools: Pools, tradePools: number[], open: boolean, registered: (token: string) => boolean): Set<number> {
  return open ? new Set(Object.values(pools).filter((p) => p.tokens.every(registered)).map((p) => Number(p.id))) : new Set(tradePools.map(Number));
}
