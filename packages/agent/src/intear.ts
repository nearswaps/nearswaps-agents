// The Intear DEX venue, built as the 1-click panel builds it (neko-site/assets/swap.js plachRoutes, plachPlan,
// oneClickIntear): Intear's router asked with nekoorders.near as the trader, its answer checked like any Intear DEX
// route, then turned into the contract's Venue::Intear: one pool, or two through a middle token (TEAR) as `then`.
// A route split over several pools is not used (the contract runs one branch). For two pools, `mid` is the
// exchange's own simulation of the first pool, which the contract's min_mid floor is set from.
import { FEE_WALLET, NEAR, ORDERS, PLACH, PLACH_ROUTER, ROUTER_SLIPPAGE_BPS } from "./constants.js";
import type { FetchLike, Rpc } from "./rpc.js";

const MAX_PLACH_REG = 20000000000000000000000n;
const PLACH_MIDS = new Set(["near", "nep141:token.intear.near"]);
const b64json = (s: unknown): any => { try { return JSON.parse(Buffer.from(String(s || ""), "base64").toString("utf8")); } catch (e) { return null; } };

/** Intear's router (swap.js plachRoutes): Plach only, the fee wallet as referrer, this trader. */
export async function plachRoutes(fetchFn: FetchLike, tIn: string, tOut: string, amountIn: bigint, account: string | null, slippageBps = ROUTER_SLIPPAGE_BPS): Promise<any[]> {
  const p = new URLSearchParams({ token_in: tIn, token_out: tOut, amount_in: amountIn.toString(), max_wait_ms: "1500", slippage_type: "Fixed",
    slippage: String(slippageBps / 10000), dexes: "Plach", referrer_id: FEE_WALLET });
  if (account) p.set("trader_account_id", account);
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 7000);
  try {
    const r = await fetchFn(PLACH_ROUTER + "?" + p.toString(), { signal: ctl.signal });
    if (!r.ok) throw new Error("Intear's router answered " + r.status);
    const j = await r.json();
    return Array.isArray(j) ? j : [];
  } finally { clearTimeout(timer); }
}

export interface PlachPlan { swaps: any[]; branches: { part: bigint; ops: any[] }[]; pay: any; minOut: bigint; gas: number }

/** Checks a router answer (swap.js plachPlan). Registration steps are only accepted when they are exactly that,
 * for this account, with a small deposit. Returns null when anything doesn't fit. */
export function plachPlan(route: any, buy: boolean, token: string, swapIn: bigint, account: string): PlachPlan | null {
  if (!route || route.dex_id !== "Plach" || !Array.isArray(route.execution_instructions) || !route.execution_instructions.length) return null;
  const ins = route.execution_instructions.map((i: any) => i && i.NearTransaction);
  if (ins.some((t: any) => !t || typeof t.receiver_id !== "string" || !Array.isArray(t.actions) || !t.actions.length)) return null;
  const tokAsset = "nep141:" + token;
  const lastIn = ins[ins.length - 1];
  const regIns = ins.slice(0, -1);
  if (lastIn.actions.length > 1) {
    if (lastIn.actions.length > 4) return null;
    regIns.push({ receiver_id: lastIn.receiver_id, actions: lastIn.actions.slice(0, -1) });
  }
  for (const t of regIns) {
    for (const a of t.actions) {
      const f = a && a.FunctionCall, args = f && b64json(f.args);
      if (!f || !args) return null;
      let dep: bigint; try { dep = BigInt(String(f.deposit || "0")); } catch (e) { return null; }
      if (dep > MAX_PLACH_REG) return null;
      const forMe = (x: unknown) => x === undefined || x === null || x === account;
      const ok = (t.receiver_id === PLACH && f.method_name === "storage_deposit" && forMe(args.account_id))
        || (t.receiver_id === PLACH && f.method_name === "register_assets" && Array.isArray(args.asset_ids) && args.asset_ids.length && args.asset_ids.every((x: string) => x === "near" || x === tokAsset || PLACH_MIDS.has(x)) && forMe(args.for))
        || (t.receiver_id === token && f.method_name === "storage_deposit" && forMe(args.account_id));
      if (!ok) return null;
    }
  }
  const lastAct = lastIn.actions[lastIn.actions.length - 1];
  if (!lastAct || !lastAct.FunctionCall) return null;
  const f = lastAct.FunctionCall, args = b64json(f.args);
  if (!args) return null;
  let msg: any;
  if (buy) {
    if (lastIn.receiver_id !== PLACH || f.method_name !== "deposit_near" || String(f.deposit) !== swapIn.toString() || !args.operations) return null;
    msg = args.operations;
  } else {
    if (lastIn.receiver_id !== token || f.method_name !== "ft_transfer_call" || args.receiver_id !== PLACH || String(args.amount) !== swapIn.toString()) return null;
    try { msg = JSON.parse(args.msg); } catch (e) { return null; }
  }
  const ops = msg && msg.operations;
  if (!Array.isArray(ops) || ops.length < 2 || ops.length > 7) return null;
  const swaps = ops.slice(0, -1), w = ops[ops.length - 1] && ops[ops.length - 1].Withdraw;
  const aIn = buy ? "near" : tokAsset, aOut = buy ? tokAsset : "near";
  let total = 0n, open: string | null = null;
  const branches: { part: bigint; ops: any[] }[] = [];
  for (const o of swaps) {
    const s = o && o.SwapSimple;
    if (!s || Object.keys(o).length !== 1 || typeof s.dex_id !== "string" || !/^[a-z0-9._-]{2,64}\/[A-Za-z0-9_-]{1,32}$/.test(s.dex_id) || !s.amount) return null;
    if (s.amount === "OutputOfLastIn") {
      if (!open || s.asset_in !== open) return null;
      branches[branches.length - 1].ops.push(o);
    } else {
      if (open || s.asset_in !== aIn || !s.amount.Amount || s.amount.Amount.ExactIn === undefined) return null;
      let part: bigint; try { part = BigInt(String(s.amount.Amount.ExactIn)); } catch (e) { return null; }
      if (part <= 0n) return null;
      total += part;
      branches.push({ part, ops: [o] });
    }
    if (s.asset_out === aOut) open = null;
    else if (PLACH_MIDS.has(s.asset_out) && s.asset_out !== aIn) open = s.asset_out;
    else return null;
    if (branches[branches.length - 1].ops.length > 3) return null;
  }
  if (open || total !== swapIn) return null;
  if (!w || w.asset_id !== aOut || (w.to !== null && w.to !== undefined) || !w.amount || !w.amount.Full) return null;
  let minOut: bigint; try { minOut = BigInt(String(w.amount.Full.at_least)); } catch (e) { return null; }
  if (minOut <= 0n) return null;
  return { swaps, branches, pay: ops[ops.length - 1], minOut, gas: Number(f.gas) || 0 };
}

export interface IntearQuote {
  out: bigint;
  mid: bigint | null;
  venue: { Intear: { dex_id: string; message: string; then?: { dex_id: string; message: string; mid: string; min_mid?: string } } };
}

/** 1-click on Intear DEX (swap.js oneClickIntear): a buy of `token` with NEAR, or a sell of it for NEAR. */
export async function oneClickIntear(fetchFn: FetchLike, rpc: Rpc, buy: boolean, token: string, rawIn: bigint): Promise<IntearQuote | null> {
  const amount = BigInt(rawIn);
  const r = (await plachRoutes(fetchFn, buy ? NEAR : token, buy ? token : NEAR, amount, ORDERS)).find((x) => x && x.dex_id === "Plach");
  if (!r) return null;
  let out = 0n; try { out = BigInt(String((r.estimated_amount || {}).amount_out || "0")); } catch (e) { /* 0 */ }
  const plan = plachPlan(r, buy, token, amount, ORDERS);
  if (!plan || out <= 0n || plan.minOut > out || plan.branches.length !== 1) return null;
  const ops = plan.branches[0].ops.map((o) => o.SwapSimple);
  if (ops.length < 1 || ops.length > 2) return null;
  const venue: IntearQuote["venue"] = { Intear: { dex_id: ops[0].dex_id, message: String(ops[0].message || "") } };
  let mid: bigint | null = null;
  if (ops.length === 2) {
    if (!/^nep141:/.test(ops[0].asset_out)) return null;
    const sim = await rpc.view(PLACH, "simulate_swap_simple", { dex_id: ops[0].dex_id, message: ops[0].message, trader: ORDERS, asset_in: ops[0].asset_in,
      asset_out: ops[0].asset_out, amount: { ExactIn: amount.toString() }, referrer: FEE_WALLET }).catch(() => null);
    if (!Array.isArray(sim) || !/^\d+$/.test(String(sim[1])) || BigInt(String(sim[1])) <= 0n) return null;
    mid = BigInt(String(sim[1]));
    venue.Intear.then = { dex_id: ops[1].dex_id, message: String(ops[1].message || ""), mid: ops[0].asset_out.slice(7) };
  }
  return { out, mid, venue };
}
