// Constants of the live stack. Each one names the file it comes from (in the nearswaps site and the
// nekoorders.near contract source); keep them in step when those change.

/** The 1-click contract (staking-contract/orders, v1.6.2 on mainnet). */
export const ORDERS = "nekoorders.near";
export const WNEAR = "wrap.near";
export const NEAR = "near";
export const NEKO = "ftv2.nekotoken.near";
export const REF = "v2.ref-finance.near";
/** Intear DEX (swap.js PLACH) and its router. */
export const PLACH = "dex.intear.near";
export const PLACH_ROUTER = "https://router.intear.tech/route";
export const PLACH_XYK = "slimedragon.near/xyk";
/** The fee wallet: Intear's referrer and the router's referrer_id, as the panel sends them (swap.js FEE_WALLET). */
export const FEE_WALLET = "nekotesting.near";
/** Feline staking: the fee discount the panel applies (swap.js STAKING_CONTRACT, get_stake().fee_discount_bps). */
export const STAKING_CONTRACT = "nekonftstaking.near";

/** Read endpoints (nearswaps.com proxies /api/* to the shared backend). */
export const API_BASE = "https://nearswaps.com/api";
/** The site's Rhea routing list (the same file the Terminal loads). */
export const POOL_LIST_URL = "https://nearswaps.com/assets/swap-pools.json";
/** Pulse's launch feeds (assets/pulse-core.js). */
export const NEARLY_API = "https://nearly.trade/api/launches";
export const HOOT_API = "https://api.justhoot.fun/api/rooms?sort=new&limit=50";

/** The Terminal's key-signing nodes, in order (oneclick.js RPC_URLS without the site's own endpoint). */
export const RPC_URLS = ["https://free.rpc.fastnear.com", "https://near.drpc.org"];

/** The only access-key permission the kit runs with: these three methods on nekoorders.near, nothing else. */
export const KEY_METHODS = ["trade", "withdraw", "recover_trade"] as const;

// oneclick.js timings and gas.
export const TGAS = 1_000_000_000_000n;
export const GAS_WITHDRAW = 150n * TGAS;            // 150 Tgas (the contract asks at least 100)
export const GAS_RECOVER = 300n * TGAS;             // recover_trade: 300 Tgas (trading.rs GAS_RECOVER_MIN; oneclick.js GAS_RECOVER)
export const RETRY_MS = 2500;                       // the one retry after "try again in a moment"
export const SEND_TIMEOUT_MS = 20000;               // the one send; after that the hash is followed
export const POLL_MS = 2500;
export const POLL_FOR_MS = 120000;
/** NEAR reserves a transaction's prepaid gas at up to 10x the gas price: 0.001 NEAR per Tgas. */
export const RESERVE_PER_TGAS = 10n ** 21n;
export const E24 = 10n ** 24n;
/** The contract's storage hold per user (trading.rs TRADING_STORAGE). */
export const TRADING_STORAGE = 20_000_000_000_000_000_000n;

// swap.js fees (the contract clamps them to its floor and ceiling: trading.rs trade_fee_bps).
export const FEE_BPS_DEFAULT = 50;
export const FEE_BPS_NEKO = 100;

/** The kit's default slippage (spec part I: 5%). "auto" uses the panel's autoSlip. */
export const DEFAULT_SLIPPAGE_BPS = 500;
/** What the panel's auto slippage scales a route's impact to (oneclick.js AUTO_REF_NEAR). */
export const AUTO_REF_NEAR = 10n * E24;
/** The router's slippage setting as the swap page sends it by default (swap.js slippageBps = 100). */
export const ROUTER_SLIPPAGE_BPS = 100;

/** /api/safety is limited per caller (30 a minute): check_token answers are kept this long per token. */
export const CHECK_CACHE_MS = 60_000;

// Account id patterns (swap.js, pulse-core.js).
export const ACCOUNT_RE = /^(?=.{2,64}$)[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
export const IMPLICIT_RE = /^[0-9a-f]{64}$/;
export const NEARLY_RE = /^[a-z0-9][a-z0-9-]{0,40}\.nearlytrade\.near$/;
export const HOOT_RE = /^[a-z0-9][a-z0-9-]{0,40}\.launchpad\.justhoot\.near$/;
export const SHARDS_RE = /^l\d{6}\.factory\.shardsmarket\.near$/;
export const INTEAR_LAUNCH_RE = /^[a-z0-9][a-z0-9_-]{0,40}\.launch(-v2)?\.intear\.near$/;
/** Intear DEX's own token (swap.js PLACH_LISTED). */
export const TEAR = "token.intear.near";

/** The curated list of swap.js TOKENS: symbols an agent may type instead of an account id. */
export const SYMBOLS: Record<string, string> = {
  near: WNEAR,
  wnear: WNEAR,
  neko: NEKO,
  usdc: "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
  usdt: "usdt.tether-token.near",
  "usdc.e": "a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.factory.bridge.near",
  "usdt.e": "dac17f958d2ee523a2206206994597c13d831ec7.factory.bridge.near",
  dai: "6b175474e89094c44da98b954eedeac495271d0f.factory.bridge.near",
  rhea: "token.rhealab.near",
  ref: "token.v2.ref-finance.near",
  eth: "aurora",
  wbtc: "2260fac5e5542a773aa44fbcfedf7c193bc2c599.factory.bridge.near",
  nbtc: "nbtc.bridge.near",
  zec: "zec.omft.near",
  linear: "linear-protocol.near",
  stnear: "meta-pool.near",
  rnear: "lst.rhealab.near",
  brrr: "token.burrow.near",
  sweat: "token.sweat",
  aurora: "aaaaaa20d9e0e2461697782ef11675f668207961.factory.bridge.near",
  mpdao: "mpdao-token.near",
  blackdragon: "blackdragon.tkn.near",
  shitzu: "token.0xshitzu.near",
  lonk: "token.lonkingnearbackto2024.near",
  kat: "kat.token0.near",
  gear: "gear.enleap.near",
  purge: "purge-558.meme-cooking.near",
  jambo: "jambo-1679.meme-cooking.near",
  tear: TEAR,
};
