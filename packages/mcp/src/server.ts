// The MCP server: the kit's reads and money calls as tools (spec part C6), one process, stdio. Read tools carry
// readOnlyHint, so a client can offer them without asking; buy, sell and withdraw carry destructiveHint. Read-only
// mode (no Agent) loads no key and registers no money tool, which is how a judge or a first-time user runs it.
// Every money tool returns the kit's one result shape, and never throws: a blocked result names the exact rule.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { policyStatus, type Agent, type Kit, type MoneyResult } from "@nearswaps/agent";

export const VERSION = "0.1.0";

export const READ_TOOLS = ["get_quote", "check_token", "list_new_launches", "list_top_traders", "get_wallet", "get_balance", "get_pending", "get_policy"] as const;
export const MONEY_TOOLS = ["buy", "sell", "withdraw", "recover_trade"] as const;

export interface ServerOptions {
  /** Reads (no key). With an agent, pass the agent itself: an Agent is a Kit. */
  kit: Kit;
  /** The agent, with its key checked on chain; null or absent: read-only, no money tools. */
  agent?: Agent | null;
  /** The policy file get_policy reads (the agent's own when there is an agent). */
  policyFile: string;
  /** The account get_balance, get_pending and get_policy default to (the agent's when there is an agent). */
  account?: string | null;
}

const INSTRUCTIONS = `nearswaps agent kit: trade NEAR tokens on nearswaps from a 1-click balance only the owner can withdraw.
Read tools (get_quote, check_token, list_new_launches, list_top_traders, get_wallet, get_balance, get_pending, get_policy) sign nothing.
Money tools (buy, sell, withdraw, recover_trade), when present, sign with the agent key: a function-call key that can call only trade, withdraw and recover_trade on nekoorders.near.
Two layers of limits apply. Hard limits are the contract's: withdraw pays the owner only, trades go only through pools the contract allows, the contract caps each trade. The policy is the kit's: score floor, per-trade maximum, daily budget, deny list, trusted list, cool-down.
Every money tool returns { outcome: filled | refused | blocked | unclear | pending, reason, tx, amount_in, amount_out, fee, score, policy_checks }. A blocked result names the rule that stopped it and nothing was signed. A pending result is still settling: follow it with get_pending and never send it again.
The token check is rate limited (30 a minute per caller) and cached 60 seconds per token: do not poll it.`;

const slippage = z.union([z.number().int().min(1).max(2000), z.literal("auto")]).optional()
  .describe("min_out is the quote less this, in bps (500 = 5%), or \"auto\" for the Terminal's auto slippage; default: the policy's slippage_bps (a quote without a policy: 5%)");
const token = (what: string) => z.string().min(1).max(100).describe(`${what}: a symbol from the curated list (near, usdc, usdt, neko, blackdragon, ...) or a NEAR token account id`);
const account = z.string().min(2).max(64).describe("a NEAR account id");

const moneyShape = {
  outcome: z.enum(["filled", "refused", "blocked", "unclear", "pending"]),
  reason: z.string(),
  tx: z.string().nullable(),
  amount_in: z.string().nullable(),
  amount_out: z.string().nullable(),
  fee: z.string().nullable(),
  score: z.number().nullable(),
  policy_checks: z.array(z.object({ rule: z.string(), status: z.enum(["pass", "fail", "skip"]), detail: z.string() })),
};

const text = (v: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(v, null, 2) }] });
const fail = (e: unknown) => ({ isError: true, content: [{ type: "text" as const, text: "error: " + String((e as Error)?.message ?? e).replace(/^Error:\s*/, "") }] });
async function read(f: () => Promise<unknown> | unknown) {
  try { return text(await f()); } catch (e) { return fail(e); }
}
async function money(f: () => Promise<MoneyResult>) {
  try { const r = await f(); return { ...text(r), structuredContent: r as unknown as Record<string, unknown> }; } catch (e) { return fail(e); }
}

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };

export function createServer(opts: ServerOptions): McpServer {
  const { kit, agent = null, policyFile } = opts;
  const defaultAccount = agent ? agent.accountId : opts.account || null;
  const whose = (a?: string) => {
    const id = a || defaultAccount;
    if (!id) throw new Error("name an account: this server runs read-only, with no agent account of its own");
    return id;
  };
  const server = new McpServer({ name: "nearswaps-agent", version: VERSION }, { instructions: INSTRUCTIONS + (agent ? `\nThe agent trades for ${agent.accountId}.` : "\nThis server is read-only: no key is loaded and no money tool is registered.") });

  server.registerTool("get_quote", {
    title: "Quote a 1-click trade",
    description: "Read-only: quotes a 1-click trade of NEAR for a token or a token for NEAR on the venue 1-click would use, with the amount out after the 1-click fee, the min_out at the slippage and the route, and signs nothing.",
    inputSchema: { from: token("what goes in (near to buy)"), to: token("what comes out (near to sell)"), amount: z.string().min(1).max(40).describe("the amount of `from`, as a decimal: \"1\", \"0.25\""), slippage_bps: slippage },
    annotations: { title: "Quote a 1-click trade", ...READ, idempotentHint: false },
  }, ({ from, to, amount, slippage_bps }) => read(() => kit.getQuote(from, to, amount, { slippage: slippage_bps, account: defaultAccount || undefined })));

  server.registerTool("check_token", {
    title: "Token check",
    description: "Read-only: runs the nearswaps token check on a token and returns its score from 0 to 100, its verdict (\"nothing dangerous found\", \"caution\" or \"high risk\") and its findings, the score the policy's score floor uses (cached 60 s; do not poll).",
    inputSchema: { token: token("the token") },
    annotations: { title: "Token check", ...READ },
  }, ({ token: t }) => read(() => kit.checkToken(t)));

  server.registerTool("list_new_launches", {
    title: "New launches",
    description: "Read-only: lists new token launches across Shards, Nearly, JustHoot and Intear, newest first, with holders, market cap and whether each is listed on nearswaps.",
    inputSchema: {
      since_minutes: z.number().int().min(1).max(30 * 24 * 60).optional().describe("only launches of the last this many minutes (default: all the feeds return)"),
      limit: z.number().int().min(1).max(100).optional().describe("at most this many (default 20)"),
    },
    annotations: { title: "New launches", ...READ, idempotentHint: false },
  }, ({ since_minutes, limit }) => read(() => kit.listNewLaunches({ sinceMs: since_minutes ? Date.now() - since_minutes * 60_000 : 0, limit: limit || 20 })));

  server.registerTool("list_top_traders", {
    title: "Top Traders",
    description: "Read-only: lists the nearswaps Top Traders of the last 7 or 30 days, ranked by realised profit in USD, with return, win rate and trade count.",
    inputSchema: {
      window: z.enum(["7d", "30d"]).optional().describe("7d (default) or 30d"),
      limit: z.number().int().min(1).max(100).optional().describe("at most this many (default 20)"),
    },
    annotations: { title: "Top Traders", ...READ, idempotentHint: false },
  }, ({ window, limit }) => read(async () => {
    const r: any = await kit.listTopTraders(), w = window || "7d", win = r && r.windows && r.windows[w];
    return { window: w, updated_at: r && r.updated_at ? new Date(Number(r.updated_at)).toISOString() : null, active: win ? win.active : null,
      rows: (win && Array.isArray(win.rows) ? win.rows : []).slice(0, limit || 20).map((x: any) => ({ rank: x.rank, wallet: x.w, profit_usd: x.pnl, roi_pct: x.roi, win_pct: x.win, trades: x.n, volume_usd: x.vol })) };
  }));

  server.registerTool("get_wallet", {
    title: "Wallet record",
    description: "Read-only: returns any NEAR wallet's trading record on nearswaps: rank, realised profit, what it holds now and its open positions.",
    inputSchema: { account },
    annotations: { title: "Wallet record", ...READ, idempotentHint: false },
  }, ({ account: a }) => read(() => kit.getWallet(a)));

  server.registerTool("get_balance", {
    title: "1-click balance",
    description: `Read-only: returns an account's 1-click balance and the NEAR free in its wallet for gas (${agent ? "the agent's own account" : "an account must be named"} unless another is named).`,
    inputSchema: { account: account.optional() },
    annotations: { title: "1-click balance", ...READ, idempotentHint: false },
  }, ({ account: a }) => read(() => kit.getBalanceOf(whose(a))));

  server.registerTool("get_pending", {
    title: "Trades in progress",
    description: "Read-only: lists an account's trades, deposits and withdrawals still settling or parked, with the time recover_trade becomes possible for each.",
    inputSchema: { account: account.optional() },
    annotations: { title: "Trades in progress", ...READ, idempotentHint: false },
  }, ({ account: a }) => read(() => kit.getPendingOf(whose(a))));

  server.registerTool("get_policy", {
    title: "Policy",
    description: "Read-only: returns the policy the money tools run under (paused, deny list, trusted list, score floor, per-trade maximum, daily budget, cool-down, slippage) with today's spend (UTC) and what is left of the daily budget.",
    inputSchema: {},
    annotations: { title: "Policy", ...READ, idempotentHint: false, openWorldHint: false },
  }, () => read(() => policyStatus(policyFile, defaultAccount)));

  if (!agent) return server;

  server.registerTool("buy", {
    title: "Buy with NEAR",
    description: "Moves money: buys a token with NEAR from the 1-click balance, blocked by policy when paused, on the deny list, below the score floor (unless trusted), above the per-trade maximum or the daily budget, or inside the token's cool-down, and pays the 1-click fee.",
    inputSchema: { token: token("the token to buy"), near: z.string().min(1).max(40).describe("the NEAR to spend from the 1-click balance, as a decimal: \"0.2\""), slippage_bps: slippage },
    outputSchema: moneyShape,
    annotations: { title: "Buy with NEAR", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  }, ({ token: t, near, slippage_bps }) => money(() => agent.buy(t, near, { slippage: slippage_bps })));

  server.registerTool("sell", {
    title: "Sell for NEAR",
    description: "Moves money: sells a token for NEAR into the 1-click balance (an amount, a percent such as \"50%\", or \"all\"), blocked by policy only when paused, above the daily budget or inside the token's cool-down (never by its score), and pays the 1-click fee.",
    inputSchema: { token: token("the token to sell"), amount: z.string().min(1).max(40).describe("a token amount (\"1000\"), a percent of the 1-click balance (\"50%\") or \"all\""), slippage_bps: slippage },
    outputSchema: moneyShape,
    annotations: { title: "Sell for NEAR", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  }, ({ token: t, amount, slippage_bps }) => money(() => agent.sell(t, amount, { slippage: slippage_bps })));

  server.registerTool("withdraw", {
    title: "Withdraw to the owner",
    description: "Moves money: withdraws a token (all NEAR by default) from the 1-click balance to the owner's own wallet, the only place the contract pays out (there is no recipient argument), and works while the policy is paused.",
    inputSchema: { token: token("the token to withdraw").optional().describe("default: near"), amount: z.string().min(1).max(40).optional().describe("a token amount, or \"all\" (default: all)") },
    outputSchema: moneyShape,
    annotations: { title: "Withdraw to the owner", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  }, ({ token: t, amount }) => money(() => agent.withdraw(t || "near", amount)));

  server.registerTool("recover_trade", {
    title: "Recover a stopped trade",
    description: "Moves money back to the owner: carries on a trade, deposit or withdrawal that stopped part way (an id from get_pending, once its recover time has passed), which only ever credits the owner's 1-click balance and is outside the policy.",
    inputSchema: { id: z.string().regex(/^\d{1,20}$/).describe("the pending id from get_pending") },
    outputSchema: moneyShape,
    annotations: { title: "Recover a stopped trade", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, ({ id }) => money(() => agent.recoverTrade(id)));

  return server;
}
