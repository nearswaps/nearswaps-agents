# First mainnet trade through the agent key (23 Oct 2026, tome.near)

Read back from the chain and the kit's ledger after the run; the owner ran the commands by hand in PowerShell.

## 1. Refused before signing: not enough free NEAR in the wallet for the gas reserve

    nearswaps-agent buy blackdragon 0.1 --account tome.near

    outcome: blocked
    reason: keep at least 0.21 NEAR free in the owner's wallet tome.near itself (not the 1-click balance) for this
            trade's network fee reserve; almost all of it comes back within seconds. The wallet has 0.194709 NEAR free
    score: 80
    check venue: pass (trades on Rhea)
    check balance: pass (0.777503 NEAR in the 1-click balance)
    check paused: pass
    check deny_list: pass
    check score_floor: pass (score 80 (caution) meets the floor of 70)
    check max_trade_near: pass (0.1 NEAR is within the per-trade maximum of 1 NEAR)
    check daily_budget_near: pass (0 NEAR traded today (UTC); 0.1 NEAR with this trade, within 3 NEAR)
    check cooldown_sec: pass (no earlier trade in blackdragon.tkn.near)
    check contract_caps: pass (within the contract's max_trade_wnear of 10000 NEAR)
    check gas_reserve: fail

Nothing was signed or sent. The owner then sent 1 NEAR to tome.near and ran the same command again.

## 2. Filled

    outcome: filled
    tx: CjetygCtZzcM1LZq49ZznVKW4d3ftQnxDSqnQjMgcmP1   (nearblocks.io/txns/CjetygCtZzcM1LZq49ZznVKW4d3ftQnxDSqnQjMgcmP1)
    contract event: trade id 44, venue rhea, wrap.near -> blackdragon.tkn.near
    amount in:  0.1 NEAR
    amount out: 44,056,878.29046 BLACKDRAGON
    fee: 25 bps (110,418.24 BLACKDRAGON to nekotesting.near; the owner's Feline-staker discount halves the 50 bps fee)
    gas burnt: 25.67 Tgas, 0.00241 NEAR, paid from the owner's wallet

1-click balance after: 0.52 NEAR; 44,056,878.29046 BLACKDRAGON (held at Rhea, as v1.6 keeps fast-trade balances).
