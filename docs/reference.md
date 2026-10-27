# Reference

The parts of the kit the [README](../README.md) does not repeat: the MCP server's options, the policy rules in their order, the result shape, every CLI command, every MCP tool, and the tests. Plain text, one fact per line, no screenshots.

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

## The policy

`~/.nearswaps-agent/policy.json` (or `--policy <file>`). (The example `policy init` writes is in the [README](../README.md#the-policy).)

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
