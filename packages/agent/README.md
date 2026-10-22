# @nearswaps/agent

Node SDK and CLI for AI agents trading NEAR tokens on nearswaps from a 1-click balance only the owner can
withdraw, under the contract's hard limits and a policy file. See the repository README for the steps, the policy
and the result shape.

```js
import { Kit, Agent } from "@nearswaps/agent";

const kit = new Kit();                                   // read-only, no key
const check = await kit.checkToken("wrap.near");         // { score, verdict, findings, ... }
const quote = await kit.getQuote("near", "usdc", "1");   // { amount_out, min_out, fee, route, ... }

const agent = await Agent.open({ accountId: "agent-demo.near" }); // refuses any key but trade, withdraw, recover_trade on nekoorders.near
const r = await agent.buy("blackdragon", "0.1");         // { outcome, reason, tx, amount_in, amount_out, fee, score, policy_checks }
```
