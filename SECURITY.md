# Reporting a problem

If you find a way for the kit to do something outside what the README says the agent key can do, to skip a policy
rule, to sign or send a trade twice, or to leak a key file, please tell us before you tell anyone else. Write to
tomeblazevski@gmail.com with "nearswaps agent kit" in the subject. Say what you did, what you expected and what
happened, with the command or the code and the version (the commit hash). Do not
include a real key; if a key was exposed, remove it from the account first (`DeleteKey` on the account, or on
nearswaps.com/agents) and then write.

This is a one-person project. We will read every report and answer as soon as we can, and we will credit you in the fix
if you want that. We do not run a bounty and cannot promise a payment or a response time. Please test against your own
account with small amounts, and do not test against other people's wallets or the live site's backend.

Problems in the contract `nekoorders.near` itself, or in nearswaps.com, can be reported to the same address. The
contract's source is not in this repository.
