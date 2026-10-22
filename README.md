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

> Status: this README is a stub for session 1 of the build (the SDK core). The MCP server, the full CLI, the
> nearswaps.com/agents page and the full README follow. The package is not on npm yet: until it is, run it from this
> repository as shown below.

## Install (from this repository)

Node 18 or later. No native dependencies (the kit has no runtime dependencies at all).

```bash
git clone https://github.com/<org>/nearswaps-agents
cd nearswaps-agents
npm install
npm run build
npm link --workspace @nearswaps/agent
```

`npm link` puts `nearswaps-agent` on your path. Without it, use `node packages/agent/dist/cli.js` in place of
`nearswaps-agent` in every command below.

## Try it, no key

Read-only: no key, nothing signed.

| Do | See |
|---|---|
| `nearswaps-agent check wrap.near` | a score from 0 to 100, a verdict ("nothing dangerous found", "caution" or "high risk") and the findings |
| `nearswaps-agent quote near usdc 1` | amount out, the minimum at 5% slippage, the 1-click fee, the venue and the route legs |
| `nearswaps-agent launches --since 1h` | the launches of the last hour across Shards, Nearly, JustHoot and Intear |

Add `--json` to any command for the raw result.

The token check is `https://nearswaps.com/api/safety`. It takes 5 to 10 seconds the first time a token is checked
(the endpoint reads the chain and several indexers); the kit then keeps the answer for 60 seconds per token, so a
second `check` or a buy straight after is quick. The endpoint allows 30 requests a minute per caller; please don't
poll it. One difference from the check page: the
page also reads Rhea's LP holder list in your browser and sends those names along (the "browser LP pass"); the kit
skips that pass, so an LP-holder finding can read "holder unknown" where the page would name the holder. The score
the policy uses is the one the endpoint returns without that pass.

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

On Windows the key file is not mode 600: Windows ignores Unix file modes. The file sits in your user profile
(`%USERPROFILE%\.nearswaps-agent`), which other ordinary users of the machine can't read, but administrators and
programs running as you can. Keep only the agent key there, never a full-access key.

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

The kit trades on Rhea and on Intear DEX. Rhea DCL launches (Nearly, JustHoot) and Shards curves are read and
listed, but trading them stays in the Terminal for now.

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

Offline, from recorded fixtures: every policy rule (each blocks, each passes) and the trusted list, the key check
(any key but exactly `trade`, `withdraw` and `recover_trade` refused), `recover_trade` for each outcome,
the route port against ten routes recorded read-only from the live Terminal on 22 Oct 2026 (same legs, same output
to the last unit, same `min_out` at 5% and at auto slippage; the pool state in each fixture is checked against the
chain with `node packages/agent/test/check-fixtures.mjs`), the signing bytes against near-api-js 5.1.1, sign once
and send once, the result shape for every outcome, and the ledger across the UTC day boundary.

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
