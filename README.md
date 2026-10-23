# nearswaps agent kit

Set a bot loose with 5 NEAR. It can trade, it can't run off with your wallet.

The nearswaps agent kit lets an AI agent (Claude Code, Codex, a Python bot, a Telegram bot) trade NEAR tokens on
nearswaps through the live 1-click contract, `nekoorders.near`, from a 1-click balance only the owner can withdraw.
Two layers of limits apply. The **hard limits** are on chain: the agent key is a function-call key that can call
only `trade`, `withdraw` and `recover_trade` on `nekoorders.near`; `withdraw` pays the owner only; `recover_trade`
only ever credits the owner; trades go only through pools the contract allows; the contract caps each trade and
each balance and can pause trading. The **policy** is the kit's own, in a file next to the agent: a token-check
score floor (with a trusted list that skips it), a per-trade maximum, a daily budget, a deny list and a cool-down.
Every agent trade pays the normal 1-click fee.

> Status: the SDK, the CLI and the MCP server are built (sessions 1 and 2). The nearswaps.com/agents page and the
> full README follow. The packages are not on npm yet: until they are, run them from this repository as shown below.

## Install (from this repository)

Node 18 or later. No native dependencies (the SDK has no runtime dependencies at all; the MCP server adds the
official `@modelcontextprotocol/sdk` and `zod`).

```bash
git clone https://github.com/<org>/nearswaps-agents
cd nearswaps-agents
npm install
npm run build
npm link --workspace @nearswaps/agent --workspace @nearswaps/agent-mcp
```

`npm link` puts `nearswaps-agent` (the CLI) and `nearswaps-agent-mcp` (the MCP server) on your path. Without it, use
`node packages/agent/dist/cli.js` and `node packages/mcp/dist/bin.js` in their place in every command below.

## Try it in two minutes, no key

Read-only: no key, nothing signed, nothing sent. Each step is "do X, see Y"; the output is plain text, one fact per
line, the same shape every time (the values below are from a run on 23 Oct 2026).

**1. Check a token.**

```bash
nearswaps-agent check wrap.near
```

```text
token: wrap.near
score: 96
verdict: nothing dangerous found
checked at: 2026-10-23T08:38:38.064Z
finding: ok: Locked: no access keys
finding: ok: Known template: Wrapped NEAR
finding: info: Could not check: who holds the LP of Rhea pool 3514 (STNEAR/wNEAR, 997,662 NEAR)
finding: low: No icon
lp browser pass: skipped (see the README)
```

Shape: `token`, `score` (0 to 100), `verdict` (one of "nothing dangerous found", "caution", "high risk"), `checked at`,
then one `finding: <severity>: <title>` line per finding (17 for `wrap.near`; shortened here), then
`lp browser pass: skipped`. It takes 5 to 10 seconds the first time; the kit keeps the answer for 60 seconds.

**2. Quote a trade.**

```bash
nearswaps-agent quote near usdc 1
```

```text
side: buy
amount in: 1 NEAR
amount out: 4.913706 USDC
minimum: 4.691477 USDC (slippage 5%)
fee: 0.024691 USDC (0.5%)
venue: Rhea
price impact: 0.00%
leg 1: 1000000000000000000000000 raw in, pool 4512 wrap.near to 17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1
quoted at: 2026-10-23T08:38:45.465Z
```

Shape: `side`, `amount in`, `amount out` (after the 1-click fee), `minimum` (the `min_out` sent to the contract, at the
slippage), `fee`, `venue` (Rhea or Intear DEX), `price impact` when known, one `leg N:` line per route leg, `quoted at`.

**3. Ask an AI agent.** Add the MCP server, read-only, to Claude Code (or Codex, below):

```bash
claude mcp add nearswaps -- nearswaps-agent-mcp --read-only
```

Run `/mcp` in Claude Code: `nearswaps` is connected with eight tools, all read-only (`get_quote`, `check_token`,
`list_new_launches`, `list_top_traders`, `get_wallet`, `get_balance`, `get_pending`, `get_policy`) and no money tool.
Then ask:

```text
Which NEAR tokens launched in the last hour, and what do they score?
```

The agent calls `list_new_launches` (`since_minutes: 60`), then `check_token` for the launches it picks, and answers
with each token's id, launchpad, holders, score and verdict. Every tool answers in JSON; `check_token` gives
`{ token, score, verdict, checked_at, findings: [{ severity, title, detail }], cached, note, lp_browser_pass }`.

Add `--json` to any CLI command for the raw result, and `--color` for mint buys and red sells in a terminal that
supports it (no colour codes by default).

## Add the MCP server to Claude Code or Codex

The server is `nearswaps-agent-mcp`, on stdio. `--read-only` loads no key and registers no money tool; without it the
server loads the agent key, checks it on chain (exactly `trade`, `withdraw` and `recover_trade` on `nekoorders.near`,
anything else refused) and adds `buy`, `sell`, `withdraw` and `recover_trade`. If the key is missing or wrong the
server does not start, and says why on stderr.

Claude Code:

```bash
claude mcp add nearswaps -- nearswaps-agent-mcp --read-only
```

```bash
claude mcp add nearswaps-trade -- nearswaps-agent-mcp --account <account>
```

Codex:

```bash
codex mcp add nearswaps -- nearswaps-agent-mcp --read-only
```

or in `~/.codex/config.toml`:

```toml
[mcp_servers.nearswaps]
command = "nearswaps-agent-mcp"
args = ["--read-only"]
```

For trading, use `args = ["--account", "<account>"]`. Without `npm link`, the command is `node` and the first
argument is the full path to `packages/mcp/dist/bin.js` (on Windows, for example
`C:\Users\<you>\nearswaps-agents\packages\mcp\dist\bin.js`). Options: `--account <id>` (default: the only key in
`~/.nearswaps-agent`, or `NEARSWAPS_AGENT_ACCOUNT`), `--policy <file>`, `--home <dir>`, `--read-only`.

The read tools carry `readOnlyHint`, so a client can run them without asking; `buy`, `sell` and `withdraw` carry
`destructiveHint`, so a client asks before each one unless you tell it otherwise. `recover_trade` moves money but only
ever credits the owner, so it is marked neither read-only nor destructive.

The token check behind `check_token` and the policy's score floor is `https://nearswaps.com/api/safety`. It takes 5 to
10 seconds the first time a token is checked (the endpoint reads the chain and several indexers); the kit then keeps
the answer for 60 seconds per token, so a second `check` or a buy straight after is quick. The endpoint allows 30
requests a minute per caller; please don't poll it. One difference from the check page: the page also reads Rhea's
LP holder list in your browser and sends those names along (the "browser LP pass"); the kit skips that pass, so an
LP-holder finding can read "holder unknown" where the page would name the holder. The score the policy uses is the
one the endpoint returns without that pass.

## Let it trade

| Step | Command or place | Expected result |
|---|---|---|
| 1. Make the agent key | `nearswaps-agent key new <account>` | a public key `ed25519:...`; the key pair is in `~/.nearswaps-agent/<account>.json` (mode 600 on macOS and Linux; see below for Windows) |
| 2. Add it to the account | nearswaps.com/agents (coming), or near-cli below | one AddKey: receiver `nekoorders.near`, methods `trade`, `withdraw` and `recover_trade`; `nearswaps-agent key show <account>` says `status: On` |
| 3. Deposit | nearswaps.com/terminal, 1-click tab, Deposit | `nearswaps-agent balance` shows the deposit |
| 4. Write the policy | `nearswaps-agent policy init`, then edit `~/.nearswaps-agent/policy.json` | `nearswaps-agent policy show` prints it |
| 5. Trade | `nearswaps-agent buy <token> 0.2` | `outcome: filled`, a tx link and the fee; or `outcome: blocked` with the rule that stopped it |
| 6. Withdraw | `nearswaps-agent withdraw near` | the NEAR is back in the owner's wallet; the agent cannot name a recipient |
| If a trade stopped part way | `nearswaps-agent pending`, then `nearswaps-agent recover <id>` once it is recoverable | `outcome: filled` (settled into the 1-click balance), or `pending` with what to do next |

Until the /agents page is live, the owner adds the agent key with near-cli (near-cli-rs; the owner signs with their
own full-access key, which never touches the kit):

```bash
near account add-key <account> grant-function-call-access --allowance unlimited --contract-account-id nekoorders.near --function-names trade,withdraw,recover_trade use-manually-provided-public-key <public key from step 1> network-config mainnet sign-with-keychain send
```

No allowance cap, as the Terminal's own 1-click key: NEAR reserves up to 10 times the gas price against a key's
allowance and does not give it back to the allowance, so a capped key runs dry. The key still can only call
`trade`, `withdraw` and `recover_trade` on `nekoorders.near`. Gas for each call comes out of the owner's own NEAR
balance (keep about 1 NEAR free in the wallet itself: each trade reserves up to 0.9 NEAR there for a few seconds).

The kit checks the key on start and refuses to run with any key that isn't exactly `trade`, `withdraw` and
`recover_trade` on `nekoorders.near`: a full-access key in the key file is an error, not a feature. The Terminal's
own 1-click key (two methods, kept in your browser) is a different key and is never taken for the agent key.

On Windows, NTFS ignores mode 600, so administrators and any program running as you can read the key file: keep the kit
on a machine only you use, and never put a full-access key in that file.

## The policy

`~/.nearswaps-agent/policy.json` (or `--policy <file>`). The example `policy init` writes:

```json
{
  "paused": false,
  "deny": [],
  "trusted": [
    "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
    "usdt.tether-token.near",
    "wrap.near"
  ],
  "min_score": 70,
  "max_trade_near": 1,
  "daily_budget_near": 3,
  "cooldown_sec": 600,
  "slippage_bps": 500
}
```

| Field | What it does |
|---|---|
| `paused` | `true` stops every buy and sell; withdrawals still work |
| `deny` | token ids the agent never buys |
| `trusted` | token ids whose buys skip the score floor, and only that: the deny list and every other rule still apply. The default is native USDC, USDt and `wrap.near`: native USDC scores 20 ("high risk") today because its issuer keeps keys on the token contract |
| `min_score` | the least token-check score (0 to 100) a token needs for a buy |
| `max_trade_near` | the most NEAR one buy may spend |
| `daily_budget_near` | the most NEAR traded per UTC day: buys count the NEAR spent, sells the NEAR expected back |
| `cooldown_sec` | seconds after a trade in a token before the next trade in that token |
| `slippage_bps` | `min_out` is the quote less this (500 = 5%), or `"auto"` for the Terminal's auto slippage |

Every field is required; a missing or unknown field is an error, never a silent default. Checked before every buy
and sell, in this order: paused; deny list; score floor (a fresh token check, skipped for trusted tokens); per-trade
maximum; daily budget (from the local ledger `ledger-<account>.json` next to the policy, reset at 00:00 UTC);
cool-down; the contract's own `max_trade_wnear` and pause, read live, so a block by the contract says so. A sell is
checked for the budget and the cool-down only: selling a bad token is never blocked by its score. Withdrawals and
`recover_trade` are not trades: the policy doesn't apply to them, and they work while the policy is paused.

## Hard limits versus policy

| Hard limits (the contract, on chain) | Policy (the kit, where the agent runs) |
|---|---|
| The agent key calls `trade`, `withdraw` and `recover_trade` on `nekoorders.near`, nothing else | Score floor from the token check, with a trusted list |
| `withdraw` pays the owner only; there is no recipient argument; `recover_trade` only ever credits the owner | Per-trade maximum in NEAR |
| Trades only through pools and venues the contract allows, against tokens switched on for 1-click | Daily budget per UTC day |
| `max_trade_wnear` per trade, `max_trading_wnear` per 1-click balance | Deny list |
| A pause switch for trading (withdrawals always work) | Cool-down per token |
| A function-call key can't attach NEAR: no deposits, no auto orders, no transfers | A paused flag |

`nekoorders.near` still holds its own keys (the lock step has not been run) and the fee wallet's key rotation is
open: the contract can still be upgraded by its owner.

## What the kit returns

Every money call (`buy`, `sell`, `withdraw`, `recover_trade`) returns the same shape and never throws:

```json
{ "outcome": "filled", "reason": "...", "tx": "<hash>", "amount_in": "0.1 NEAR", "amount_out": "... BLACKDRAGON",
  "fee": "... BLACKDRAGON", "score": 80, "policy_checks": [{ "rule": "score_floor", "status": "pass", "detail": "..." }] }
```

| Outcome | Meaning |
|---|---|
| `filled` | the venue filled the trade (contract event `trade`), or a withdrawal was paid out |
| `refused` | nothing changed hands: the venue didn't fill at the minimum (`trade_failed`, the input is back), or the contract or the network refused the call before anything moved |
| `blocked` | the policy, or a check the kit makes before signing (balance, venue, gas reserve), stopped it; nothing was signed; `policy_checks` names the rule |
| `unclear` | the venue's answer couldn't be read (`trade_unclear`): kept aside, settled by hand; nothing is lost |
| `pending` | sent and still settling: follow it with `nearswaps-agent pending`; never send it again |

Each key-signed call is signed once and sent once. If the connection drops or a node times out, the same signed
transaction may go to the other node, then it is followed by its hash until it is final; it is never signed or sent
again, so a trade can't happen twice. The only fresh signatures are after a refused nonce and after the contract's
own "try again in a moment", both before anything ran, and only once (the Terminal's own rule).

Money calls on one agent run one at a time, in the order they were asked for, so an MCP client that calls two at
once can't pass the daily budget or the cool-down twice, or sign two transactions with the same nonce.

The kit trades on Rhea and on Intear DEX. Rhea DCL launches (Nearly, JustHoot) and Shards curves are read and
listed, but trading them stays in the Terminal for now.

## The CLI

`nearswaps-agent <command>`; plain text, one fact per line, no colour unless `--color`, no emoji. Exit code 0 when
done, 1 on an error, 2 when a money command (or `policy check` for a trade) is blocked or refused.

| Command | Key | What it prints |
|---|---|---|
| `check <token>` | no | the token check: score, verdict, findings |
| `quote <from> <to> <amount>` | no | amount out, minimum, fee, venue, route legs |
| `launches [--since 1h] [--limit n]` | no | one line per new launch: time, launchpad, id, symbol, holders |
| `traders [--window 7d\|30d] [--limit n]` | no | one line per Top Trader: rank, wallet, realised profit, return, win rate, trades |
| `wallet <account>` | no | any wallet's rank, realised profit, holdings and positions |
| `balance [--account id]` | no | the 1-click balance and the wallet's NEAR free for gas |
| `pending [--account id]` | no | trades, deposits and withdrawals still settling, with the recover time |
| `key new <account>` | makes it | the public key to add on nearswaps.com/agents and the key file |
| `key show [account]` | reads it | the public key and whether it is On, as the kit needs it |
| `policy init` | no | writes the example policy |
| `policy show` | no | the policy, today's spend (UTC) and what is left |
| `policy check` | no | whether the file is valid: every field present and in range |
| `policy check buy <token> <near>`, `policy check sell <token> <amount>` | no | a dry run of the policy for that trade: each rule, pass or fail; nothing signed |
| `buy <token> <near>` | signs | the money result: outcome, reason, amounts, fee, score, tx link, every check |
| `sell <token> <amount\|50%\|all>` | signs | the same |
| `withdraw [token] [amount]` | signs | the same; always to the owner's own wallet |
| `recover <id>` | signs | the same, for a trade that stopped part way (`pending` lists the ids) |

Options: `--account <id>`, `--policy <file>`, `--slippage <bps|auto>`, `--home <dir>`, `--limit <n>`, `--json`, `--color`.

## The MCP tools

| Tool | Kind | Description (as the server gives it) |
|---|---|---|
| `get_quote` | read-only | quotes a 1-click trade of NEAR for a token or a token for NEAR, with the amount out after the fee, the `min_out` and the route |
| `check_token` | read-only | the token check: score, verdict, findings; the score the score floor uses (cached 60 s) |
| `list_new_launches` | read-only | new launches across Shards, Nearly, JustHoot and Intear, newest first |
| `list_top_traders` | read-only | Top Traders of 7 or 30 days by realised profit in USD |
| `get_wallet` | read-only | any wallet's trading record |
| `get_balance` | read-only | an account's 1-click balance and NEAR free for gas |
| `get_pending` | read-only | an account's trades still settling, with the recover time |
| `get_policy` | read-only | the policy, today's spend (UTC) and what is left |
| `buy` | moves money, destructive | buys with NEAR from the 1-click balance; blocked by the policy (paused, deny list, score floor unless trusted, per-trade maximum, daily budget, cool-down); pays the 1-click fee |
| `sell` | moves money, destructive | sells for NEAR into the 1-click balance; blocked only when paused, above the daily budget or inside the cool-down, never by score; pays the 1-click fee |
| `withdraw` | moves money, destructive | to the owner's own wallet only (no recipient argument); works while the policy is paused |
| `recover_trade` | moves money to the owner | carries on a trade that stopped part way; only ever credits the owner; outside the policy |

The money tools return the result shape above as both text and structured content, and never throw. `--read-only`
registers the first eight only.

## The first mainnet trade (0.1 NEAR, by the owner)

Not run by the build; Tome runs it from the demo wallet once steps 1 to 4 are done: the agent key added with all
three methods (`trade`, `withdraw`, `recover_trade`; `nearswaps-agent key show <demo account>` must say
`status: On`, and a key added earlier with two methods is refused), the policy as in the example (`max_trade_near`
1, `daily_budget_near` 3, the default trusted list), at least 0.1 NEAR in the 1-click balance and about 1 NEAR free
in the wallet itself:

```bash
nearswaps-agent buy blackdragon 0.1 --account <demo account>
```

Expected: `outcome: filled`, `amount in: 0.1 NEAR`, the BLACKDRAGON received, the fee and a NearBlocks link; the
score (80 on 22 Oct 2026) and every policy check listed. If the score has dropped under 70 by then the result is
`outcome: blocked` with `check score_floor: fail`, and nothing is sent. BLACKDRAGON is not on the trusted list, so
this first trade also shows the score floor at work. If the result is `pending`, check `nearswaps-agent pending
--account <demo account>`; a trade that stopped part way can be carried on with `nearswaps-agent recover <id>
--account <demo account>` an hour after its last step. Then, to close the loop:

```bash
nearswaps-agent sell blackdragon all --account <demo account>
```

```bash
nearswaps-agent withdraw near --account <demo account>
```

## Tests

```bash
npm test
```

Offline, from recorded fixtures, for both packages from the repository root: every policy rule (each blocks, each
passes) and the trusted list, the policy dry run, the key check (any key but exactly `trade`, `withdraw` and
`recover_trade` refused), `recover_trade` for each outcome, the route port against ten routes recorded read-only from
the live Terminal on 22 Oct 2026 (same legs, same output to the last unit, same `min_out` at 5% and at auto slippage;
the pool state in each fixture is checked against the chain with `node packages/agent/test/check-fixtures.mjs`), the
signing bytes against near-api-js 5.1.1 (three vectors: a one-leg trade, a long args payload, a nonce above 2^32;
`packages/agent/test/make-sign-vectors.cjs` makes them), sign once and send once, the result shape for every outcome,
the ledger across the UTC day boundary, and the CLI's lines (plain by default, mint and red with `--color`). The MCP
server is tested through the MCP SDK's own client: the tool list in both modes (the real `--read-only` server over
stdio), the hints on every tool, a blocked buy that returns the rule with nothing signed, and read tools with no key.

```bash
npm run smoke
```

Live and read-only (CI runs it on every push): `check wrap.near` returns a score from 0 to 100 and a verdict from
the fixed list; the launch list has at least one row; `quote near usdc 1` returns a route and a `min_out` within 2%
of Rhea's own `get_return` for the same legs, read straight after (a few blocks pass between the two reads).

## Built for NEAR HACKATHON 2026

Tracks: AI Security & Defense, Agent Economy, Unstoppable DeFi.

Predates the hackathon: the `nekoorders.near` contract and its 1-click trading, the nearswaps.com site and its read
endpoints, the token check, the keeper and the backend. Built during it: this SDK, the MCP server, the
nearswaps.com/agents page, the docs and the video.

## Licence

MIT, for the kit in this repository (see `LICENSE`). The contract's source is not in this repository; its code is
on chain at `nekoorders.near`.

## Links

- nearswaps.com
- The Terminal: nearswaps.com/terminal
- The token check: nearswaps.com/check
