// Read-only chain views the kit uses, through FastNEAR with failover to drpc (rpc.ts). Shapes are the
// contract's own (staking-contract/orders/src/trading.rs and fast.rs).
import { ORDERS, REF, STAKING_CONTRACT, WNEAR } from "./constants.js";
import type { AccessKeyView } from "./keys.js";
import type { Rpc } from "./rpc.js";

export interface TradingConfig {
  trade_paused: boolean;
  paused: boolean;
  max_trading_wnear: string;
  max_trade_wnear: string;
  max_tokens: number;
  trading_storage: string;
  rhea: string;
  intear: string;
  intear_dex_ids: string[];
  registered: string[];
  registered_total: number;
  trade_pools: number[];
  pending: number;
  fee_wallet: string;
  ref_prices: [string, string][];
  max_pending_per_user: number;
  open_pools?: boolean;
  exec?: string;
  enable_cost?: [string, string][];
  at_venue?: boolean;
  shards_sells?: boolean;
}
export interface TradingBalance { token: string; amount: string }
export interface TradingParts { token: string; here: string; rhea: string; intear: string }
export interface PendingView { id: string; kind: string; owner: string; token_in: string; token_out: string; amount_in: string; stage: number; in_flight: boolean; started_ns: string; recoverable_ns: string }
export interface RawPool { pool_kind: string; token_account_ids: string[]; amounts: string[]; total_fee: number; shares_total_supply?: string; amp?: number }

/** The venue in the contract's JSON shape (trading.rs `Venue`). */
export type Venue =
  | { Rhea: { route: { amount_in: string; hops: { pool_id: number; token_in: string; token_out: string }[] }[] } }
  | { Intear: { dex_id: string; message: string; then?: { dex_id: string; message: string; mid: string; min_mid?: string } } }
  | { Dcl: { pool_ids: string[] } }
  | { Shards: { launch: string } }
  | { Shift: { from: "here" | "rhea" | "intear"; to: "here" | "rhea" | "intear" } };

export class Views {
  constructor(readonly rpc: Rpc) {}

  getTrading(account: string): Promise<TradingBalance[]> { return this.rpc.view(ORDERS, "get_trading", { account_id: account }); }
  getPending(account: string): Promise<PendingView[]> { return this.rpc.view(ORDERS, "get_pending", { account_id: account }); }
  getTradingConfig(): Promise<TradingConfig> { return this.rpc.view(ORDERS, "get_trading_config"); }
  /** v1.6: where each token of the balance sits (here, at Rhea, at Intear DEX). */
  getTradingParts(account: string): Promise<TradingParts[]> { return this.rpc.view(ORDERS, "get_trading_parts", { account_id: account }); }
  /** The Tgas `trade` asks for on this route (trading.rs trade_gas_tgas). */
  async tradeGasTgas(venue: Venue, tokenIn: string): Promise<number> { return Number(await this.rpc.view(ORDERS, "trade_gas_tgas", { venue, token_in: tokenIn })); }
  areOpen(tokens: string[]): Promise<boolean[]> { return this.rpc.view(ORDERS, "are_open", { tokens }); }
  areRegistered(keys: string[]): Promise<boolean[]> { return this.rpc.view(ORDERS, "are_registered", { keys }); }

  viewAccessKey(account: string, publicKey: string): Promise<AccessKeyView & { nonce: number; block_hash?: string }> {
    return this.rpc.query({ request_type: "view_access_key", finality: "optimistic", account_id: account, public_key: publicKey });
  }
  viewAccessKeyList(account: string): Promise<{ keys: { public_key: string; access_key: AccessKeyView }[] }> {
    return this.rpc.query({ request_type: "view_access_key_list", finality: "optimistic", account_id: account });
  }
  /** The owner's own spendable NEAR: balance less what storage locks (oneclick.js walletFree). */
  async walletFree(account: string): Promise<bigint | null> {
    try {
      const a = await this.rpc.query({ request_type: "view_account", finality: "optimistic", account_id: account });
      return BigInt(a.amount) - BigInt(a.storage_usage) * 10n ** 19n;
    } catch (e) { return null; }
  }

  /** Rhea classic pools by id (route.mjs loadPools reads them 100 at a time). Final, as the Terminal reads them
   * (swap.js view's default finality; the recorded routes confirm it). */
  getPoolByIds(ids: number[]): Promise<(RawPool | null)[]> { return this.rpc.view(REF, "get_pool_by_ids", { pool_ids: ids }, "final"); }
  getStablePool(id: number): Promise<any> { return this.rpc.view(REF, "get_stable_pool", { pool_id: id }, "final"); }
  getRatedPool(id: number): Promise<any> { return this.rpc.view(REF, "get_rated_pool", { pool_id: id }, "final"); }
  getReturn(poolId: number, tokenIn: string, amountIn: string, tokenOut: string): Promise<string> { return this.rpc.view(REF, "get_return", { pool_id: poolId, token_in: tokenIn, amount_in: amountIn, token_out: tokenOut }); }

  async ftMetadata(token: string): Promise<{ symbol: string; decimals: number; name?: string }> {
    const m = await this.rpc.view(token === "near" ? WNEAR : token, "ft_metadata");
    if (!m || !Number.isInteger(m.decimals) || m.decimals < 0 || m.decimals > 32) throw new Error("bad metadata for " + token);
    return { symbol: String(m.symbol || "?").slice(0, 16), decimals: m.decimals, name: m.name };
  }
  /** The Feline staker discount on the site fee (swap.js loadStake); 0 when it can't be read. */
  async feeDiscountBps(account: string): Promise<number> {
    try { const st = await this.rpc.view(STAKING_CONTRACT, "get_stake", { account_id: account }); return Math.max(0, Math.min(10000, Number(st && st.fee_discount_bps) || 0)); }
    catch (e) { return 0; }
  }
}
