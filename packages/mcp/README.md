# @nearswaps/agent-mcp

The nearswaps agent kit as an MCP server (stdio): the tools `get_quote`, `check_token`, `list_new_launches`,
`list_top_traders`, `get_wallet`, `get_balance`, `get_pending`, `get_policy` (read-only), and `buy`, `sell`,
`withdraw`, `recover_trade` (they move money, under the contract's hard limits and the policy file). See the
repository README for the setup, the policy and the result shape.

```bash
claude mcp add nearswaps -- nearswaps-agent-mcp --read-only
```

`--read-only` loads no key and registers no money tool. Without it the server loads the agent key for `--account`,
refuses any key that isn't exactly `trade`, `withdraw` and `recover_trade` on `nekoorders.near`, and adds the money
tools.

```js
import { createServer } from "@nearswaps/agent-mcp";
import { Kit } from "@nearswaps/agent";

const server = createServer({ kit: new Kit(), agent: null, policyFile: "policy.json" }); // an McpServer, read-only
```
