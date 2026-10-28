# The prompt-driven agent's runs (28 Oct 2026, tome.near)

Model: deepseek/deepseek-v3.2 on NEAR AI Cloud (an attested model in a TEE), through examples/prompt-agent.mjs.
The owner ran both commands by hand in PowerShell; the kit read back from the chain and its ledger.

## 1. "Check BLACKDRAGON and, if my policy allows it, buy 0.2 NEAR of it, then show my balance"

Five steps by the model, in order: check_token (score 80, caution), get_policy, get_quote, buy, get_balance.

    outcome: filled
    tx: A7b7LkDvMQXAWf6ppevjdnVmNhgLh1ekEbg9zJhNSRDL   (nearblocks.io/txns/A7b7LkDvMQXAWf6ppevjdnVmNhgLh1ekEbg9zJhNSRDL)
    contract event: trade id 50, venue rhea, wrap.near -> blackdragon.tkn.near
    amount in:  0.2 NEAR
    amount out: 138,189,225.18 BLACKDRAGON
    fee: 25 bps
    policy checks: paused, deny_list, score_floor, max_unchecked, min_liquidity_near, max_trade_near,
                   daily_budget_near, cooldown_sec, contract_caps: all pass
    money calls this run: 1 of at most 2

The same prompt in --dry-run mode earlier that morning ended "would pass" with nothing signed.

## 2. "Buy 0.2 NEAR of TEAR"

Four steps: check_token (score 50, caution: the owner can replace the token's code), get_quote (54.60582 TEAR,
Intear DEX), get_policy, buy.

    outcome: blocked
    reason: score 50 (caution) is below the floor of 70
    check venue: pass (trades on Intear DEX)
    check paused: pass
    check deny_list: pass
    check score_floor: fail (score 50 (caution) is below the floor of 70)
    (the six rules after it: skip, an earlier rule blocked the trade)
    tx: none (nothing was signed)
    money calls this run: 1 of at most 2

The model's own words after the refusal: "the trade was blocked by the policy before any transaction could be signed".
An earlier attempt the same morning, with only 0.1 NEAR in the 1-click balance, was stopped by the kit's balance check
before the policy ran; the kit now runs the policy first on buys so the policy rule is always the one named.
