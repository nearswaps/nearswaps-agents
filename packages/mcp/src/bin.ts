#!/usr/bin/env node
// nearswaps-agent-mcp: the MCP server on stdio. stdout carries the protocol only; every other line goes to stderr.
//   --read-only        no key loaded, no money tool registered (reads only)
//   --account <id>     the agent's account (default: the only key in ~/.nearswaps-agent, or NEARSWAPS_AGENT_ACCOUNT)
//   --policy <file>    the policy file (default ~/.nearswaps-agent/policy.json)
//   --home <dir>       where .nearswaps-agent lives (default: the user's home)
import { existsSync, readdirSync } from "node:fs";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Agent, Kit, keyDir, policyPath } from "@nearswaps/agent";
import { createServer, VERSION } from "./server.js";

const HELP = `nearswaps-agent-mcp ${VERSION}: the nearswaps agent kit as an MCP server (stdio)

  nearswaps-agent-mcp --read-only              reads only: no key loaded, no money tool registered
  nearswaps-agent-mcp [--account <id>]         reads and money tools, with the agent key for <id>

Options: --account <id>  --policy <file>  --home <dir>  --read-only  --help`;

function parse(argv: string[]) {
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) throw new Error(`unexpected argument "${a}"`);
    const k = a.slice(2);
    if (["account", "policy", "home"].includes(k)) { const v = argv[++i]; if (v === undefined || v.startsWith("--")) throw new Error(`--${k} needs a value`); flags[k] = v; }
    else if (k === "read-only" || k === "help") flags[k] = true;
    else throw new Error(`unknown option --${k}`);
  }
  return flags;
}

function accountFrom(flags: Record<string, string | true>, home?: string): string {
  if (typeof flags.account === "string") return flags.account;
  if (process.env.NEARSWAPS_AGENT_ACCOUNT) return process.env.NEARSWAPS_AGENT_ACCOUNT;
  const dir = keyDir(home);
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json") && f !== "policy.json" && f !== "llm.json" && !f.startsWith("ledger-")) : [];
  if (files.length === 1) return files[0].slice(0, -5);
  throw new Error(files.length ? "more than one agent key in the store: pass --account <id>" : "no agent key: run \"nearswaps-agent key new <account>\" first, or start with --read-only");
}

async function main() {
  const flags = parse(process.argv.slice(2));
  if (flags.help) { process.stderr.write(HELP + "\n"); return; }
  const home = typeof flags.home === "string" ? flags.home : undefined;
  const policyFile = typeof flags.policy === "string" ? flags.policy : policyPath(home);
  const log = (t: string) => process.stderr.write(t + "\n");
  let server;
  if (flags["read-only"]) {
    server = createServer({ kit: new Kit(), agent: null, policyFile, account: typeof flags.account === "string" ? flags.account : null });
    log(`nearswaps-agent-mcp ${VERSION}: read-only (no key loaded, no money tools)`);
  } else {
    // The key is checked on chain before any tool is offered: anything but trade, withdraw and recover_trade on
    // nekoorders.near is refused, and the server does not start.
    const agent = await Agent.open({ accountId: accountFrom(flags, home), home, policyFile, onStatus: log });
    server = createServer({ kit: agent, agent, policyFile });
    log(`nearswaps-agent-mcp ${VERSION}: trading for ${agent.accountId} (agent key On; policy ${policyFile})`);
  }
  await server.connect(new StdioServerTransport());
}

main().catch((e) => { process.stderr.write("nearswaps-agent-mcp: " + String((e && e.message) || e) + "\n"); process.exit(1); });
