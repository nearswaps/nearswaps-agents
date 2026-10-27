# The demo agent's trade (27 Oct 2026, tome.near)

Run on screen for the demo video, by the owner, in PowerShell:

    node examples/trench-bot.mjs --account tome.near --token blackdragon --refuse tear --amount 0.2 --color

Read back from the chain and the kit's ledger:

    outcome: filled
    tx: EUThexn73NHBJb8AkGTu5U8j5DkG6Xtyph3yexnkhfEE   (nearblocks.io/txns/EUThexn73NHBJb8AkGTu5U8j5DkG6Xtyph3yexnkhfEE)
    contract event: trade id 49, venue rhea, wrap.near -> blackdragon.tkn.near
    amount in:  0.2 NEAR
    amount out: 137,724,627.88 BLACKDRAGON
    fee: 25 bps

The refusal test in the same run (TEAR, token.intear.near, score 50): blocked by score_floor, nothing signed. Its
dry run the same day is in the README's "A scripted agent" section.
