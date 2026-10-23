// The kit: Kit reads (no key, for any agent or a judge's read-only session); Agent trades with the agent key,
// under the contract's hard limits and the policy. The trade path is the 1-click panel's (neko-site/assets/
// oneclick.js trade, withdraw, placeInput, shiftNow, checkReserve), signed once and sent once (sign.ts).
import { GAS_RECOVER, GAS_WITHDRAW, NEAR, POOL_LIST_URL, RESERVE_PER_TGAS, SYMBOLS, TGAS, WNEAR } from "./constants.js";
import { amountText, short, toRaw, units } from "./format.js";
import { checkPermission, isAccountId, loadKey, type AgentKey } from "./keys.js";
import { ledgerPath, Ledger, loadPolicy, policyPath, policyStatus, runChecks, type Policy, type PolicyCheck } from "./policy.js";
import { PoolSource } from "./pools.js";
import { feeBpsAsked, feeBpsCharged, Market, minOutFor, quote, resolveSlippage, VENUE_NAMES, type Quote, type Slippage, type VenueName } from "./quote.js";
import { Reads, type TokenCheck } from "./reads.js";
import { kitCheck, result, type MoneyResult } from "./result.js";
import { Rpc, type FetchLike } from "./rpc.js";
import { events, hashOf, Signer } from "./sign.js";
import { Views, type TradingConfig, type TradingParts, type Venue } from "./views.js";

export interface KitOptions {
  fetch?: FetchLike;
  rpcUrls?: string[];
  apiBase?: string;
  poolListUrl?: string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Progress lines while a call runs ("Sent, still settling..."). */
  onStatus?: (text: string) => void;
}

export interface QuoteResult {
  from: string;
  to: string;
  amount_in: string;
  /** Expected, after the 1-click fee. */
  amount_out: string;
  /** The floor sent to the contract as min_out (the venue's minimum, before the fee). */
  min_out: string;
  fee: string;
  fee_bps: number;
  slippage_bps: number;
  venue: string;
  route: { amount_in: string; hops: { pool_id: number; token_in: string; token_out: string }[] }[];
  impact_bps: number | null;
  quoted_at: string;
  raw: { amount_in: string; out: string; min_out: string; fee: string };
}

const clean = (m: unknown) => String((m as Error)?.message ?? m).replace(/^Error:\s*/, "").replace(/^Smart contract panicked:\s*/, "").trim();

export class Kit {
  readonly rpc: Rpc;
  readonly views: Views;
  readonly reads: Reads;
  readonly pools: PoolSource;
  protected readonly fetchFn: FetchLike;
  protected readonly now: () => number;
  protected readonly sleep: (ms: number) => Promise<void>;
  protected readonly status: (t: string) => void;
  private meta = new Map<string, { symbol: string; decimals: number }>();

  constructor(opts: KitOptions = {}) {
    this.fetchFn = opts.fetch || (globalThis.fetch as unknown as FetchLike);
    this.now = opts.now || Date.now;
    this.sleep = opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.status = opts.onStatus || (() => {});
    this.rpc = new Rpc({ urls: opts.rpcUrls, fetch: this.fetchFn });
    this.views = new Views(this.rpc);
    this.reads = new Reads({ fetch: this.fetchFn, apiBase: opts.apiBase, now: this.now });
    this.pools = new PoolSource(this.views, this.fetchFn, opts.poolListUrl || POOL_LIST_URL);
  }

  /** A token id from what an agent types: a symbol from the curated list ("usdc", "neko", "near") or an account id. */
  resolveToken(t: string): string {
    const s = String(t || "").trim().toLowerCase();
    if (SYMBOLS[s]) return SYMBOLS[s];
    if (!isAccountId(s)) throw new Error(`"${t}" is neither a known symbol nor a NEAR token account id`);
    return s;
  }
  async tokenMeta(token: string): Promise<{ symbol: string; decimals: number }> {
    if (token === WNEAR || token === NEAR) return { symbol: "NEAR", decimals: 24 };
    const hit = this.meta.get(token);
    if (hit) return hit;
    const m = await this.views.ftMetadata(token);
    const v = { symbol: m.symbol, decimals: m.decimals };
    this.meta.set(token, v);
    return v;
  }
  protected async txt(raw: bigint, token: string): Promise<string> { const m = await this.tokenMeta(token); return amountText(raw, m.decimals, m.symbol); }

  /** What 1-click knows about the contract and a token right now (fresh config). */
  async market(token?: string): Promise<Market> {
    const cfg = await this.views.getTradingConfig();
    const m = new Market(cfg);
    if (token && m.listTruncated()) {
      const keys = Market.keysFor(token).filter((k) => !(cfg.registered || []).includes(k));
      try { const r = await this.views.areRegistered(keys); keys.forEach((k, i) => m.setRegistered(k, !!(r && r[i]))); } catch (e) { /* the list is all we know */ }
    }
    if (token && m.v16) { try { const r = await this.views.areOpen([token]); m.setOpen(token, !!(r && r[0])); } catch (e) { /* not open */ } }
    return m;
  }

  // ------------------------------------------------------------------ reads (no key)

  /** The token check (/api/safety), cached 60 s per token. */
  checkToken(token: string): Promise<TokenCheck> { return this.reads.checkToken(this.resolveToken(token)); }
  listNewLaunches(opts: { sinceMs?: number; limit?: number } = {}) { return this.reads.newLaunches(opts); }
  listTopTraders() { return this.reads.traders(); }
  getWallet(id: string) { return this.reads.wallet(id); }

  /** Any account's 1-click balance (get_trading), with where each part sits (v1.6), and the wallet's own free NEAR
   * for gas. Public views: no key. */
  async getBalanceOf(account: string) {
    if (!isAccountId(account)) throw new Error(`"${account}" is not a NEAR account id`);
    const [list, parts, free] = await Promise.all([this.views.getTrading(account), this.views.getTradingParts(account).catch(() => [] as TradingParts[]), this.views.walletFree(account)]);
    const rows = [];
    for (const b of list || []) {
      const m = await this.tokenMeta(b.token).catch(() => ({ symbol: b.token, decimals: 24 }));
      const p = (parts || []).find((x) => x.token === b.token);
      rows.push({ token: b.token, amount: amountText(BigInt(b.amount), m.decimals, m.symbol), raw: b.amount, ...(p ? { here: p.here, rhea: p.rhea, intear: p.intear } : {}) });
    }
    return { account, balances: rows, wallet_free: free == null ? null : amountText(free > 0n ? free : 0n, 24, "NEAR") };
  }
  /** Any account's trades, deposits and withdrawals still in flight or parked (get_pending). Public view: no key. */
  async getPendingOf(account: string) {
    if (!isAccountId(account)) throw new Error(`"${account}" is not a NEAR account id`);
    const list = await this.views.getPending(account);
    return (list || []).map((p) => ({ ...p, unclear: Number(p.stage) === 99, recoverable_at: Number(p.recoverable_ns) > 0 ? new Date(Number(BigInt(p.recoverable_ns) / 1000000n)).toISOString() : "now" }));
  }

  /** A 1-click quote: NEAR to a token or a token to NEAR, on the venue 1-click would use, with min_out from the
   * slippage (default 5%) and the 1-click fee. Read-only. */
  async getQuote(from: string, to: string, amount: string | number, opts: { slippage?: Slippage; account?: string } = {}): Promise<QuoteResult> {
    const tIn = this.resolveToken(from), tOut = this.resolveToken(to);
    if ((tIn === WNEAR) === (tOut === WNEAR)) throw new Error("1-click trades have NEAR on exactly one side: quote near to a token, or a token to near");
    const token = tIn === WNEAR ? tOut : tIn;
    const market = await this.market(token);
    const venue = market.venueOf(token);
    if (!venue) throw new Error(`${token} isn't switched on for 1-click yet (switch it on in the Terminal's 1-click tab)`);
    if (venue !== "rhea" && venue !== "intear") throw new Error(`${token} trades on ${VENUE_NAMES[venue]}, which the kit doesn't trade yet; use the Terminal`);
    const mIn = await this.tokenMeta(tIn), mOut = await this.tokenMeta(tOut);
    const raw = toRaw(amount, mIn.decimals);
    if (!raw) throw new Error(`"${amount}" is not an amount of ${mIn.symbol}`);
    const q = await quote({ rpc: this.rpc, fetch: this.fetchFn, pools: this.pools }, market, tIn, tOut, raw, venue);
    if (!q) throw new Error(venue === "intear" ? `Intear's router has no single route 1-click can use for ${token} right now` : `no route through the pools 1-click can use for ${token}`);
    const slip = resolveSlippage(opts.slippage, q, tIn === WNEAR ? raw : q.out, market.isOpen(token));
    const owner = opts.account || "";
    const feeBps = feeBpsCharged(owner, tIn, tOut, feeBpsAsked(owner, tIn, tOut, 0));
    const fee = (q.out * BigInt(feeBps)) / 10000n, minOut = minOutFor(q.floor, slip);
    return {
      from: tIn, to: tOut, amount_in: amountText(raw, mIn.decimals, mIn.symbol), amount_out: amountText(q.out - fee, mOut.decimals, mOut.symbol),
      min_out: amountText(minOut, mOut.decimals, mOut.symbol), fee: amountText(fee, mOut.decimals, mOut.symbol), fee_bps: feeBps, slippage_bps: slip,
      venue: VENUE_NAMES[q.venueName], route: q.legs || [], impact_bps: q.impactBps ?? null, quoted_at: new Date(this.now()).toISOString(),
      raw: { amount_in: raw.toString(), out: q.out.toString(), min_out: minOut.toString(), fee: fee.toString() },
    };
  }

  /** A dry run of the policy for a buy or a sell: the same rules, in the same order, as a trade runs them, with
   * nothing signed and no key. With an account, today's spend and the cool-downs come from its ledger; without one
   * the ledger is empty. The 1-click balance and the wallet's gas reserve are checked only when the trade runs. */
  async previewTrade(side: "buy" | "sell", tokenArg: string, amountArg: string | number, opts: { policyFile: string; account?: string | null }): Promise<PreviewResult> {
    const token = this.resolveToken(tokenArg);
    if (token === WNEAR) throw new Error("pick the token to trade against NEAR, not NEAR itself");
    const policy = loadPolicy(opts.policyFile);
    const account = opts.account || null;
    const ledger = new Ledger(account ? ledgerPath(opts.policyFile, account) : null, account || "", this.now);
    const market = await this.market(token);
    const cfg = market.cfg, venueName = market.venueOf(token), wanted = market.venueWanted(token);
    if (wanted !== "rhea" && wanted !== "intear") throw new Error(`${token} trades on ${VENUE_NAMES[wanted]}; the kit trades on Rhea and Intear DEX only`);
    if (!venueName) throw new Error(`${token} isn't switched on for 1-click yet`);
    const tIn = side === "buy" ? WNEAR : token, tOut = side === "buy" ? token : WNEAR;
    const mIn = await this.tokenMeta(tIn);
    const raw = toRaw(amountArg, mIn.decimals);
    if (!raw) throw new Error(side === "buy" ? `"${amountArg}" is not a NEAR amount` : `"${amountArg}" is not an amount of ${mIn.symbol} (a dry run takes a number, not a percent or "all")`);
    let nearRaw = raw;
    if (side === "sell") {
      const q = await quote({ rpc: this.rpc, fetch: this.fetchFn, pools: this.pools }, market, tIn, tOut, raw, venueName);
      if (!q) throw new Error(`no route 1-click can use for ${token} right now`);
      nearRaw = q.out;
    }
    const near = Number(units(nearRaw, 24));
    const run = await runChecks(policy, ledger, { side, token, near, nearRaw, score: () => this.reads.checkToken(token),
      contract: { paused: cfg.paused, trade_paused: cfg.trade_paused, max_trade_wnear: BigInt(cfg.max_trade_wnear || "0"), max_trading_wnear: BigInt(cfg.max_trading_wnear || "0") } }, this.now);
    return { outcome: run.blocked ? "blocked" : "would pass", reason: run.blocked ? run.blocked.detail : "every policy rule passes; the 1-click balance and the gas reserve are checked when the trade runs",
      side, token, near: amountText(nearRaw, 24, "NEAR"), account, score: run.score, policy_checks: run.checks };
  }
}

/** previewTrade's answer: what the policy would say, nothing signed. */
export interface PreviewResult {
  outcome: "would pass" | "blocked";
  reason: string;
  side: "buy" | "sell";
  token: string;
  /** The NEAR the trade spends (buy) or is expected to bring back (sell). */
  near: string;
  /** The ledger used, or null (empty ledger). */
  account: string | null;
  score: number | null;
  policy_checks: PolicyCheck[];
}

export interface AgentOptions extends KitOptions {
  accountId: string;
  /** Where ~/.nearswaps-agent lives (default: the user's home). */
  home?: string;
  /** The policy file (default ~/.nearswaps-agent/policy.json); the ledger sits next to it. */
  policyFile?: string;
  /** A key given directly (tests); otherwise read from the key store. */
  key?: AgentKey;
}

type Parts = { here: bigint; rhea: bigint; intear: bigint };
type Loc = "here" | "rhea" | "intear";

class KitRefusal extends Error { constructor(readonly check: PolicyCheck) { super(check.detail); } }

/** Said on any result that stops after a Venue::Shift went through: the balance sits elsewhere than before. */
const movedNote = (what: string) => ` (the ${what} wasn't sent; a move of the 1-click balance between the contract and the exchange had already gone through: see get_balance)`;

export class Agent extends Kit {
  readonly accountId: string;
  readonly key: AgentKey;
  readonly signer: Signer;
  readonly policyFile: string;
  private allowance: bigint | null = null;
  /** Venue::Shift calls that completed, so a call that stops later can say the balance moved. */
  private shifts = 0;
  private discount: number | null = null;
  private started = false;

  private constructor(opts: AgentOptions, key: AgentKey) {
    super(opts);
    this.accountId = opts.accountId;
    this.key = key;
    this.signer = new Signer(this.rpc, key, { sleep: this.sleep, onStatus: this.status, now: this.now });
    this.policyFile = opts.policyFile || policyPath(opts.home);
  }

  /** Load the agent key and check it on chain. Refuses any key that isn't exactly trade, withdraw and recover_trade on
   * nekoorders.near (a full-access key in the key file is an error). */
  static async open(opts: AgentOptions): Promise<Agent> {
    if (!isAccountId(opts.accountId)) throw new Error(`"${opts.accountId}" is not a NEAR account id`);
    const key = opts.key || loadKey(opts.accountId, opts.home);
    if (key.accountId !== opts.accountId) throw new Error("the key is for another account");
    const a = new Agent(opts, key);
    await a.start();
    return a;
  }

  /** The start check: the key on chain has exactly the agent key's permission. */
  async start(): Promise<void> {
    let ak;
    try { ak = await this.views.viewAccessKey(this.accountId, this.key.publicKey); }
    catch (e) {
      const m = String((e as Error).message) + JSON.stringify((e as any).rpc || "");
      if (/UNKNOWN_ACCESS_KEY|does not exist|UNKNOWN_ACCOUNT/i.test(m)) throw new Error(`the agent key ${this.key.publicKey} is not on ${this.accountId}: the owner adds it on nearswaps.com/agents (one wallet approval)`);
      throw new Error("the agent key couldn't be checked on chain right now: " + clean(e));
    }
    const c = checkPermission(ak);
    if (!c.ok) throw new Error(`refusing to run with this key on ${this.accountId}: ${c.reason}`);
    const fc: any = ak && typeof ak.permission === "object" ? ak.permission.FunctionCall : null;
    this.allowance = fc && fc.allowance != null ? BigInt(fc.allowance) : null;
    this.started = true;
  }

  private policyAndLedger(): { policy: Policy; ledger: Ledger } {
    const policy = loadPolicy(this.policyFile);
    return { policy, ledger: new Ledger(ledgerPath(this.policyFile, this.accountId), this.accountId, this.now) };
  }

  // ------------------------------------------------------------------ reads with the owner's account

  /** The 1-click balance (get_trading), with where each part sits (v1.6), and the wallet's own free NEAR for gas. */
  getBalance() { return this.getBalanceOf(this.accountId); }
  /** Trades, deposits and withdrawals still in flight or parked (get_pending). */
  getPending() { return this.getPendingOf(this.accountId); }
  /** The policy as it runs, today's spend (UTC) and what is left. */
  getPolicy() { return policyStatus(this.policyFile, this.accountId, this.now); }

  // ------------------------------------------------------------------ money

  /** Buy `token` with `near` NEAR from the 1-click balance. */
  buy(token: string, near: string | number, opts: { slippage?: Slippage } = {}): Promise<MoneyResult> { return this.trade("buy", token, near, opts); }
  /** Sell `amount` of `token` for NEAR: a token amount, "50%" of the balance, or "all". */
  sell(token: string, amount: string | number, opts: { slippage?: Slippage } = {}): Promise<MoneyResult> { return this.trade("sell", token, amount, opts); }

  private async parts(token: string, market: Market): Promise<{ bal: bigint; p: Parts }> {
    const [list, parts] = await Promise.all([this.views.getTrading(this.accountId), market.v16 ? this.views.getTradingParts(this.accountId).catch(() => null) : null]);
    const b = (list || []).find((x) => x.token === token), bal = b ? BigInt(b.amount) : 0n;
    const x = (parts || []).find((y) => y.token === token);
    return { bal, p: x ? { here: BigInt(x.here), rhea: BigInt(x.rhea), intear: BigInt(x.intear) } : { here: bal, rhea: 0n, intear: 0n } };
  }
  private fastLoc(market: Market, venue: Venue): Loc | null {
    if (!(market.v16 && market.cfg.at_venue)) return null;
    return "Rhea" in venue ? "rhea" : "Intear" in venue ? "intear" : null;
  }

  /** NEAR reserves the attached gas at up to 10x the gas price from the key's allowance (if it has a cap) and from
   * the wallet's free NEAR; short of either the node refuses outright. Checked first (oneclick.js checkReserve). */
  private async checkReserve(gasT: number): Promise<void> {
    const reserve = BigInt(gasT) * RESERVE_PER_TGAS;
    if (this.allowance != null && this.allowance < reserve) throw new KitRefusal(kitCheck("gas_reserve", false, "this agent key has a fee cap too small for this trade; add a key with no cap on nearswaps.com/agents"));
    const free = await this.views.walletFree(this.accountId);
    if (free != null && free < reserve + 5n * 10n ** 21n) {
      throw new KitRefusal(kitCheck("gas_reserve", false, `keep at least ${short(reserve + 10n ** 22n, 24)} NEAR free in the owner's wallet ${this.accountId} itself (not the 1-click balance) for this trade's network fee reserve; almost all of it comes back within seconds. The wallet has ${short(free > 0n ? free : 0n, 24)} NEAR free`));
    }
  }

  /** Move part of the 1-click balance between the contract and a venue (Venue::Shift), with the agent key. */
  private async shiftNow(token: string, from: Loc, to: Loc, amount: bigint): Promise<void> {
    this.status(`Moving ${short(amount, (await this.tokenMeta(token)).decimals)} ${(await this.tokenMeta(token)).symbol} ${to === "here" ? "back from " + from : "to " + to} first...`);
    const venue: Venue = { Shift: { from, to } };
    const gasT = await this.views.tradeGasTgas(venue, token);
    await this.checkReserve(gasT);
    const args = { venue, token_in: token, token_out: token, amount_in: amount.toString(), min_out: "1", fee_bps: null, referrer: null };
    const res = await this.signer.keyCall("trade", args, BigInt(gasT) * TGAS);
    const ev = events(res).find((x) => x.event === "trading_shift" && x.data && x.data.owner === this.accountId);
    if (!ev || !ev.data.ok) throw new Error(`moving the ${token} balance didn't complete; it is still in the 1-click balance. Try again in a moment`);
    this.shifts++;
  }

  /** Put a trade's input where the trade takes it (oneclick.js placeInput). Returns whether anything moved. */
  private async placeInput(token: string, raw: bigint, venue: Venue, market: Market): Promise<boolean> {
    if (!market.v16) return false;
    const { p } = await this.parts(token, market);
    const loc = this.fastLoc(market, venue), plan: [Loc, Loc, bigint][] = [];
    if (loc) {
      const at = p[loc] < raw ? p[loc] : raw, fromHere = raw - at, other: Loc = loc === "rhea" ? "intear" : "rhea";
      if (fromHere > p.here && p[other] >= fromHere - p.here) plan.push([other, loc, fromHere - p.here]);
    } else if (p.here < raw) {
      let need = raw - p.here;
      for (const o of ["rhea", "intear"] as Loc[]) { const x = p[o] < need ? p[o] : need; if (x > 0n) { plan.push([o, "here", x]); need -= x; } }
    }
    for (const [from, to, amt] of plan) await this.shiftNow(token, from, to, amt);
    return plan.length > 0;
  }

  private async trade(side: "buy" | "sell", tokenArg: string, amountArg: string | number, opts: { slippage?: Slippage }): Promise<MoneyResult> {
    const checks: PolicyCheck[] = [];
    let score: number | null = null, ledger: Ledger | null = null, entry: string | null = null;
    const shifts0 = this.shifts, shifted = () => this.shifts > shifts0;
    const blockedBy = (c: PolicyCheck) => result("blocked", c.detail, { policy_checks: [...checks, c], score });
    try {
      if (!this.started) await this.start();
      let token: string;
      try { token = this.resolveToken(tokenArg); } catch (e) { return blockedBy(kitCheck("token", false, clean(e))); }
      if (token === WNEAR) return blockedBy(kitCheck("token", false, "pick the token to trade against NEAR, not NEAR itself"));
      let policy: Policy;
      try { ({ policy, ledger } = this.policyAndLedger()); } catch (e) { return blockedBy(kitCheck("policy_file", false, clean(e))); }
      const market = await this.market(token);
      const cfg = market.cfg;
      const wanted = market.venueWanted(token), venueName = market.venueOf(token);
      if (wanted !== "rhea" && wanted !== "intear") return blockedBy(kitCheck("venue", false, `${token} trades on ${VENUE_NAMES[wanted]}; the kit trades on Rhea and Intear DEX only, so trade it in the Terminal`));
      if (!venueName) return blockedBy(kitCheck("venue", false, `${token} isn't switched on for 1-click yet; anyone can switch it on in the Terminal's 1-click tab (one wallet approval, once for everyone)`));
      checks.push(kitCheck("venue", true, `trades on ${VENUE_NAMES[venueName]}`));
      const tIn = side === "buy" ? WNEAR : token, tOut = side === "buy" ? token : WNEAR;
      const mIn = await this.tokenMeta(tIn), mOut = await this.tokenMeta(tOut);
      const open = market.isOpen(token);
      if (open && cfg.at_venue === false) return blockedBy(kitCheck("venue", false, `fast trades are off right now, and ${token} was switched on by the community: it trades again once they are back on; it can be withdrawn meanwhile`));
      // The amount.
      const { bal, p } = await this.parts(tIn, market);
      let raw: bigint | null;
      if (side === "buy") raw = toRaw(amountArg, 24);
      else {
        const base = market.v16 && open ? p.rhea : bal;
        if (base === 0n && bal > 0n) return blockedBy(kitCheck("balance", false, `${token} was switched on by the community: it trades only from the 1-click balance at Rhea; withdraw what is here instead`));
        const a = String(amountArg).trim().toLowerCase();
        if (a === "all") raw = base;
        else if (/%$/.test(a)) { const pct = Number(a.slice(0, -1)); raw = pct > 0 && pct <= 100 ? (base * BigInt(Math.round(pct * 100))) / 10000n : null; }
        else raw = toRaw(a, mIn.decimals);
      }
      if (!raw || raw <= 0n) return blockedBy(kitCheck("amount", false, side === "buy" ? `"${amountArg}" is not a NEAR amount` : `"${amountArg}" is not an amount of ${mIn.symbol}, a percent or "all"`));
      if (raw > bal) return blockedBy(kitCheck("balance", false, `the 1-click balance has ${amountText(bal, mIn.decimals, mIn.symbol)}; deposit more in the Terminal first`));
      checks.push(kitCheck("balance", true, `${amountText(bal, mIn.decimals, mIn.symbol)} in the 1-click balance`));
      // A first quote: a sell's NEAR value for the budget, and whether there is a route at all.
      const deps = { rpc: this.rpc, fetch: this.fetchFn, pools: this.pools };
      let q: Quote | null = await quote(deps, market, tIn, tOut, raw, venueName);
      if (!q) return result("refused", venueName === "intear" ? `Intear's router has no single route 1-click can use for ${token} right now; nothing was sent` : `no route through the pools 1-click can use for ${token}; nothing was sent`, { policy_checks: checks });
      const nearRaw = side === "buy" ? raw : q.out;
      const near = Number(units(nearRaw, 24));
      // The policy, in order.
      const run = await runChecks(policy, ledger, { side, token, near, nearRaw, score: () => this.reads.checkToken(token),
        contract: { paused: cfg.paused, trade_paused: cfg.trade_paused, max_trade_wnear: BigInt(cfg.max_trade_wnear || "0"), max_trading_wnear: BigInt(cfg.max_trading_wnear || "0") } }, this.now);
      score = run.score;
      checks.push(...run.checks);
      if (run.blocked) return result("blocked", run.blocked.detail, { policy_checks: checks, score });
      if (this.discount == null) this.discount = await this.views.feeDiscountBps(this.accountId);
      const amountIn = amountText(raw, mIn.decimals, mIn.symbol);
      // From here the trade may go out: it counts against the budget until it is known not to have.
      entry = ledger.reserve(side, token, near);
      let res: any = null, slip = 0;
      const auto = (opts.slippage ?? policy.slippage_bps) === "auto";
      for (let attempt = 1; ; attempt++) {
        // v1.6: the input must sit where the trade takes it (at the exchange or in the contract); moved there first if not.
        if (await this.placeInput(tIn, raw, q.venue, market)) q = await quote(deps, market, tIn, tOut, raw, venueName);
        if (!q) throw new Error(`no route 1-click can use for ${token} right now`);
        slip = resolveSlippage(opts.slippage ?? policy.slippage_bps, q, side === "buy" ? raw : q.out, open);
        const minOut = minOutFor(q.floor, slip);
        const venue: any = JSON.parse(JSON.stringify(q.venue));
        // Two Intear pools: the first pool's floor (min_mid) is its own quote less the same slippage.
        if (venue.Intear && venue.Intear.then && q.mid != null) venue.Intear.then.min_mid = minOutFor(q.mid, slip).toString();
        const fee = feeBpsAsked(this.accountId, tIn, tOut, this.discount);
        const args = { venue, token_in: tIn, token_out: tOut, amount_in: raw.toString(), min_out: minOut.toString(), fee_bps: Number.isInteger(fee) ? fee : null, referrer: null };
        let gasT = await this.views.tradeGasTgas(venue, tIn);
        await this.checkReserve(gasT);
        this.status(`${side === "buy" ? "Buying" : "Selling"} ${token}...`);
        try { res = await this.signer.keyCall("trade", args, BigInt(gasT) * TGAS); }
        catch (e) {
          const m = clean(e);
          if ((e as any).onchain && /per-trade cap/i.test(m)) throw new KitRefusal(kitCheck("contract_caps", false, `the contract refused it: above its per-trade cap, max_trade_wnear ${short(BigInt(cfg.max_trade_wnear), 24)} NEAR (a hard limit); nothing moved`));
          // v1.6: the balance moved since it was read (refused on chain before anything moved): read, place, retry once.
          if (!((e as any).onchain && /MOVE_FIRST|Attach at least/.test(m))) throw e;
          await this.placeInput(tIn, raw, q.venue, market);
          const need = /Attach at least (\d+) Tgas/.exec(m);
          gasT = Math.max(await this.views.tradeGasTgas(venue, tIn), need ? Number(need[1]) : 0);
          await this.checkReserve(gasT);
          res = await this.signer.keyCall("trade", args, BigInt(gasT) * TGAS);
        }
        // Auto slippage: the exchange didn't fill at the minimum, so nothing changed hands. Quoted afresh and sent once
        // more (a fixed setting is never retried; nor is the second Intear pool refusing).
        const ev1 = events(res).filter((x) => x.data && x.data.owner === this.accountId);
        const why = String(((ev1.find((x) => x.event === "trade_failed") || {}).data || {}).reason || "");
        if (auto && attempt === 1 && !ev1.some((x) => x.event === "trade") && /did not fill at your minimum/.test(why) && !/second Intear/.test(why)) {
          this.status(`The price moved more than ${slip / 100}% before the fill. Trying once more at the new price...`);
          q = await quote(deps, market, tIn, tOut, raw, venueName);
          if (!q) break;
          continue;
        }
        break;
      }
      return await this.tradeResult(res, side, token, tIn, tOut, amountIn, checks, score, ledger, entry);
    } catch (e) {
      if (e instanceof KitRefusal) {
        if (ledger && entry) ledger.settle(entry, "refused", null);
        return result("blocked", e.check.detail + (shifted() ? movedNote("trade") : ""), { policy_checks: [...checks, e.check], score });
      }
      return this.failure(e, checks, score, ledger, entry, shifted() ? "trade" : null);
    }
  }

  /** Turn the transaction's events into the result (oneclick.js trade, after the send). */
  private async tradeResult(res: any, side: "buy" | "sell", token: string, tIn: string, tOut: string, amountIn: string, checks: PolicyCheck[], score: number | null, ledger: Ledger, entry: string): Promise<MoneyResult> {
    const evs = events(res).filter((x) => x.data && x.data.owner === this.accountId);
    const ok = evs.find((x) => x.event === "trade"), bad = evs.find((x) => x.event === "trade_failed"), unclear = evs.find((x) => x.event === "trade_unclear");
    const tx = hashOf(res) || null;
    if (ok) {
      const d = ok.data, used = BigInt(d.amount_in), out = BigInt(d.amount_out), fee = BigInt(d.fee_amount || "0");
      ledger.settle(entry, "filled", tx, Number(units(side === "buy" ? used : out + fee, 24)));
      return result("filled", `${side === "buy" ? "bought" : "sold"} ${token} on ${VENUE_NAMES[(d.venue as VenueName) || "rhea"] || d.venue}`, {
        tx, amount_in: await this.txt(used, tIn), amount_out: await this.txt(out, tOut), fee: await this.txt(fee, tOut), score, policy_checks: checks });
    }
    if (bad) {
      ledger.settle(entry, "refused", tx);
      return result("refused", `not filled: ${String(bad.data.reason || "the price moved past the slippage limit")}; the input is back in the 1-click balance`, { tx, amount_in: amountIn, score, policy_checks: checks });
    }
    if (unclear) {
      ledger.settle(entry, "unclear", tx);
      return result("unclear", `the exchange's answer couldn't be read (${String(unclear.data.reason || "")}), so the trade is kept aside under In progress for nearswaps to settle by hand; nothing is lost`, { tx, amount_in: amountIn, score, policy_checks: checks });
    }
    ledger.settle(entry, "pending", tx);
    return result("pending", "sent; it is still settling. Follow it with get_pending; if it stops, it shows there with a recover time an hour later. Don't send it again", { tx, amount_in: amountIn, score, policy_checks: checks });
  }

  /** `shifted`: what wasn't sent ("trade", "withdrawal") when a Venue::Shift had already gone through, else null. */
  private failure(e: unknown, checks: PolicyCheck[], score: number | null, ledger: Ledger | null, entry: string | null, shifted: string | null): MoneyResult {
    const err = e as any, m = clean(e);
    if (err && err.settling) { if (ledger && entry) ledger.settle(entry, "pending", err.hash || null); return result("pending", m, { tx: err.hash || null, score, policy_checks: checks }); }
    if (err && err.onchain) {
      // The transaction ran and the contract panicked: its state rolled back, nothing moved.
      const evs = events(err.res).filter((x) => x.data && x.data.owner === this.accountId);
      if (evs.some((x) => x.event === "trade" || x.event === "trade_unclear")) { if (ledger && entry) ledger.settle(entry, "unclear", hashOf(err.res) || null); return result("unclear", "the transaction failed after the trade had started: " + m + "; check get_pending", { tx: hashOf(err.res) || null, score, policy_checks: checks }); }
      if (ledger && entry) ledger.settle(entry, "refused", hashOf(err.res) || null);
      return result("refused", "the contract refused it before anything moved: " + m, { tx: hashOf(err.res) || null, score, policy_checks: checks });
    }
    if (ledger && entry) ledger.settle(entry, "refused", null);
    const moved = shifted ? movedNote(shifted) : "";
    return result("refused", (/nothing was sent/.test(m) ? m : m + "; nothing was sent") + moved, { score, policy_checks: checks });
  }

  /** Withdraw `token` (all of it unless `amount` is given) from the 1-click balance to the owner's own wallet. The
   * contract pays the caller only; there is no recipient anywhere. wNEAR arrives as NEAR. Always allowed. */
  async withdraw(tokenArg = "near", amountArg?: string | number): Promise<MoneyResult> {
    const checks: PolicyCheck[] = [kitCheck("withdraw_to_owner", true, `the contract pays ${this.accountId} only: withdraw has no recipient argument`)];
    const shifts0 = this.shifts, shifted = () => this.shifts > shifts0;
    try {
      if (!this.started) await this.start();
      let token: string;
      try { token = this.resolveToken(tokenArg); } catch (e) { return result("blocked", clean(e), { policy_checks: [...checks, kitCheck("token", false, clean(e))] }); }
      const market = await this.market(token);
      const { bal, p } = await this.parts(token, market);
      const m = await this.tokenMeta(token);
      let take = bal;
      if (amountArg !== undefined && String(amountArg).trim().toLowerCase() !== "all") {
        const r = toRaw(amountArg, m.decimals);
        if (!r) return result("blocked", `"${amountArg}" is not an amount of ${m.symbol}`, { policy_checks: [...checks, kitCheck("amount", false, `"${amountArg}" is not an amount of ${m.symbol}`)] });
        take = r;
      }
      if (take <= 0n || take > bal) return result("blocked", `the 1-click balance has ${amountText(bal, m.decimals, m.symbol)}`, { policy_checks: [...checks, kitCheck("balance", false, `the 1-click balance has ${amountText(bal, m.decimals, m.symbol)}`)] });
      // v1.6: what sits at an exchange comes home first (withdrawals pay out of what the contract holds).
      let need = take - (p.here < take ? p.here : take);
      for (const o of ["rhea", "intear"] as Loc[]) { if (need <= 0n) break; const x = p[o] < need ? p[o] : need; if (x > 0n) { await this.shiftNow(token, o, "here", x); need -= x; } }
      this.status(`Withdrawing ${m.symbol}...`);
      const args = { token, amount: amountArg === undefined || take === bal ? null : take.toString() };
      const res = await this.signer.keyCall("withdraw", args, GAS_WITHDRAW);
      const tx = hashOf(res) || null;
      const ev = events(res).find((x) => x.event === "trading_withdraw" && x.data.owner === this.accountId);
      const amt = ev ? amountText(BigInt(ev.data.amount), m.decimals, m.symbol) : amountText(take, m.decimals, m.symbol);
      if (ev && ev.data.claimable) return result("pending", `the owner's wallet isn't registered on ${m.symbol}, so it waits to be claimed in the Terminal's Auto orders tab`, { tx, amount_in: amt, policy_checks: checks });
      if (ev && ev.data.returned) return result("refused", "unwrapping the NEAR didn't go through this time; it is back in the 1-click balance. Try again in a moment", { tx, amount_in: amt, policy_checks: checks });
      if (!ev) return result("pending", "sent; if it doesn't arrive, it shows in get_pending with a recover time an hour later", { tx, amount_in: amt, policy_checks: checks });
      return result("filled", `${m.symbol} sent to ${this.accountId}${token === WNEAR ? " as NEAR" : ""}`, { tx, amount_in: amt, amount_out: amt, policy_checks: checks });
    } catch (e) {
      if (e instanceof KitRefusal) return result("blocked", e.check.detail + (shifted() ? movedNote("withdrawal") : ""), { policy_checks: [...checks, e.check] });
      return this.failure(e, checks, null, null, null, shifted() ? "withdrawal" : null);
    }
  }

  /** recover_trade carries on one of the owner's trades, deposits or withdrawals that stopped part way (oneclick.js
   * recover), signed with the agent key: 300 Tgas, 0 deposit. It only ever credits the owner, never twice; on an unclear
   * trade it only frees the tokens for other trades and credits nothing. Not a trade: the policy doesn't apply (it
   * works while the policy is paused) and it costs no budget. */
  async recoverTrade(id: string | number): Promise<MoneyResult> {
    const checks: PolicyCheck[] = [kitCheck("credits_owner", true, `recover_trade only ever credits ${this.accountId}'s 1-click balance, and never twice`)];
    const stop = (c: PolicyCheck) => result("blocked", c.detail, { policy_checks: [...checks, c] });
    try {
      if (!this.started) await this.start();
      const sid = String(id).trim();
      if (!/^\d{1,20}$/.test(sid)) return stop(kitCheck("pending", false, `"${id}" is not a pending id; get_pending lists them`));
      const row = (await this.getPending()).find((x) => String(x.id) === sid);
      if (!row) return stop(kitCheck("pending", false, `nothing with id ${sid} is in progress for ${this.accountId}; get_pending lists what is`));
      // The contract refuses an early call (an hour after the last step); checked first, so no gas is spent on it.
      const at = Number(BigInt(row.recoverable_ns || "0") / 1000000n);
      if (at > this.now()) return stop(kitCheck("pending", false, `too soon: ${row.kind} ${sid} is still running; recover_trade is possible from ${new Date(at).toISOString()}`));
      checks.push(kitCheck("pending", true, `${row.unclear ? "unclear " : ""}${row.kind} ${sid} (${row.token_in} to ${row.token_out}) may be recovered now`));
      await this.checkReserve(300);
      this.status(`Recovering ${row.kind} ${sid}...`);
      const res = await this.signer.keyCall("recover_trade", { id: sid }, GAS_RECOVER);
      const tx = hashOf(res) || null, evs = events(res);
      const mine = evs.filter((x) => x.data && x.data.owner === this.accountId);
      const rec = evs.find((x) => x.event === "trade_recovered"), freed = !!rec && /free again/.test(String((rec.data && rec.data.note) || ""));
      if (row.unclear || evs.some((x) => x.event === "trade_unclear")) return result("unclear", "its tokens are free for other trades again; nothing was credited, and nearswaps settles this one by hand", { tx, policy_checks: checks });
      const ok = mine.find((x) => x.event === "trade"), bad = mine.find((x) => x.event === "trade_failed"), moved = mine.find((x) => x.event === "trading_withdraw" || x.event === "trading_deposit");
      if (ok) {
        const d = ok.data;
        return result("filled", `recovered: the trade settled into the 1-click balance`, { tx, amount_in: await this.txt(BigInt(d.amount_in), d.token_in), amount_out: await this.txt(BigInt(d.amount_out), d.token_out), fee: await this.txt(BigInt(d.fee_amount || "0"), d.token_out), policy_checks: checks });
      }
      if (bad) return result("refused", `recovered: not filled (${String(bad.data.reason || "")}); the input is back in the 1-click balance`, { tx, amount_in: await this.txt(BigInt(bad.data.amount_in), bad.data.token_in), policy_checks: checks });
      if (moved) {
        const amt = await this.txt(BigInt(moved.data.amount), moved.data.token);
        return result("filled", moved.event === "trading_withdraw" ? `recovered: the withdrawal was sent to ${this.accountId}` : "recovered: the deposit is in the 1-click balance", { tx, amount_in: amt, amount_out: amt, policy_checks: checks });
      }
      if (freed) return result("pending", "it had been stopped for over an hour, so its tokens are free again; call recover_trade once more to retry it", { tx, policy_checks: checks });
      return result("pending", "sent; the 1-click balance shows the result in a moment (get_pending)", { tx, policy_checks: checks });
    } catch (e) {
      if (e instanceof KitRefusal) return stop(e.check);
      return this.failure(e, checks, null, null, null, null);
    }
  }
}

