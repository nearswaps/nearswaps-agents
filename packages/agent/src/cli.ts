#!/usr/bin/env node
// nearswaps-agent: plain text, one fact per line, no colour unless --color, no emoji. --json prints the raw result.
// The read commands need no key; buy, sell, withdraw and recover sign with the agent key, under the policy.
import { readdirSync, existsSync } from "node:fs";
import { Agent, Kit } from "./agent.js";
import { ORDERS } from "./constants.js";
import { agentKeysOf, checkPermission, keyDir, loadKey, newKeyPair, saveKey } from "./keys.js";
import { balanceLines, checkLines, launchLines, moneyLines, pendingLines, policyLines, previewLines, quoteLines, tradersLines, walletLines } from "./lines.js";
import { loadPolicy, policyPath, policyStatus, writeDefaultPolicy } from "./policy.js";
import type { MoneyResult } from "./result.js";

const HELP = `nearswaps-agent: trade NEAR tokens from a 1-click balance only the owner can withdraw

Read-only (no key, nothing signed):
  nearswaps-agent check <token>                 token check: score, verdict, findings
  nearswaps-agent quote <from> <to> <amount>    1-click quote: amount out, minimum, fee, route
  nearswaps-agent launches [--since 1h]         new launches across Shards, Nearly, JustHoot, Intear
  nearswaps-agent traders [--window 7d|30d]     Top Traders by realised profit
  nearswaps-agent wallet <account>              any wallet's trading record
  nearswaps-agent balance                       the 1-click balance (any account with --account)
  nearswaps-agent pending                       trades still settling (any account with --account)

Agent key (kept in ~/.nearswaps-agent/<account>.json, mode 600 on macOS and Linux):
  nearswaps-agent key new <account>             make a key pair; prints the public key to add on nearswaps.com/agents
  nearswaps-agent key show [account]            the public key and whether it is on the account, as the kit needs it

Policy (~/.nearswaps-agent/policy.json):
  nearswaps-agent policy init                   write the example policy
  nearswaps-agent policy show                   the policy, today's spend (UTC) and what is left
  nearswaps-agent policy check                  check the file: every field present and in range
  nearswaps-agent policy check buy <token> <near>
  nearswaps-agent policy check sell <token> <amount>
                                                a dry run of the policy for that trade; nothing signed

Money (signed with the agent key, under the contract's hard limits and the policy):
  nearswaps-agent buy <token> <near>            buy with NEAR from the 1-click balance
  nearswaps-agent sell <token> <amount|50%|all> sell for NEAR into the 1-click balance
  nearswaps-agent withdraw [token] [amount]     withdraw to the owner's own wallet (default: all NEAR)
  nearswaps-agent recover <id>                  recover_trade: carry on a trade that stopped part way (see pending)

Options: --account <id>  --policy <file>  --slippage <bps|auto>  --home <dir>  --limit <n>  --json  --color
Exit codes: 0 done, 1 error, 2 blocked or refused.`;

const VALUED = ["account", "policy", "slippage", "home", "since", "window", "limit"];

function parseArgs(argv: string[]) {
  const pos: string[] = [], flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const [k, inline] = a.slice(2).split(/=(.*)/s, 2);
      if (inline !== undefined) flags[k] = inline;
      else if (VALUED.includes(k)) { const v = argv[i + 1]; if (v === undefined || v.startsWith("--")) throw new Error(`--${k} needs a value`); flags[k] = v; i++; }
      else flags[k] = true;
    } else pos.push(a);
  }
  return { pos, flags };
}
const out = (lines: string[]) => { for (const l of lines) process.stdout.write(l + "\n"); };

function accountFrom(flags: Record<string, string | true>, home?: string): string {
  if (typeof flags.account === "string") return flags.account;
  if (process.env.NEARSWAPS_AGENT_ACCOUNT) return process.env.NEARSWAPS_AGENT_ACCOUNT;
  const dir = keyDir(home);
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json") && f !== "policy.json" && f !== "llm.json" && !f.startsWith("ledger-")) : [];
  if (files.length === 1) return files[0].slice(0, -5);
  throw new Error(files.length ? "more than one agent key in the store: pass --account <id>" : "no account: pass --account <id>, or run \"nearswaps-agent key new <account>\" first");
}

const SINCE: Record<string, number> = { m: 60e3, h: 3600e3, d: 86400e3 };

async function main() {
  const { pos, flags } = parseArgs(process.argv.slice(2));
  const json = flags.json === true, color = flags.color === true && !json;
  const home = typeof flags.home === "string" ? flags.home : undefined;
  const policyFile = typeof flags.policy === "string" ? flags.policy : policyPath(home);
  const slippage = typeof flags.slippage === "string" ? (flags.slippage === "auto" ? "auto" as const : Number(flags.slippage)) : undefined;
  if (typeof slippage === "number" && !(Number.isInteger(slippage) && slippage >= 1 && slippage <= 2000)) throw new Error("--slippage must be 1 to 2000 bps, or auto");
  const limit = typeof flags.limit === "string" ? Math.max(1, Math.min(200, Number(flags.limit) || 0)) : undefined;
  const [cmd, a1, a2, a3, a4] = pos;
  const show = (v: unknown, lines: () => string[]) => out(json ? [JSON.stringify(v, null, 2)] : lines());
  const kit = new Kit();
  switch (cmd) {
    case "check": {
      if (!a1) throw new Error("usage: nearswaps-agent check <token>");
      const c = await kit.checkToken(a1);
      return show(c, () => checkLines(c));
    }
    case "quote": {
      if (!a1 || !a2 || !a3) throw new Error("usage: nearswaps-agent quote <from> <to> <amount>");
      const q = await kit.getQuote(a1, a2, a3, { slippage });
      return show(q, () => quoteLines(q, color));
    }
    case "launches": {
      const since = typeof flags.since === "string" ? flags.since : "";
      const m = /^(\d+)([mhd])$/.exec(since);
      if (since && !m) throw new Error("--since takes a number and m, h or d: 30m, 1h, 2d");
      const r = await kit.listNewLaunches({ sinceMs: m ? Date.now() - Number(m[1]) * SINCE[m[2]] : 0, limit: limit || 50 });
      return show(r, () => launchLines(r));
    }
    case "traders": {
      const w = typeof flags.window === "string" ? flags.window : "7d";
      if (w !== "7d" && w !== "30d") throw new Error("--window is 7d or 30d");
      const r = await kit.listTopTraders();
      return show(r, () => tradersLines(r, w, limit || 20, color));
    }
    case "wallet": {
      if (!a1) throw new Error("usage: nearswaps-agent wallet <account>");
      const r = await kit.getWallet(a1);
      return show(r, () => walletLines(r, color));
    }
    case "balance": {
      const b = await kit.getBalanceOf(accountFrom(flags, home));
      return show(b, () => balanceLines(b));
    }
    case "pending": {
      const p = await kit.getPendingOf(accountFrom(flags, home));
      return show(p, () => pendingLines(p));
    }
    case "key": {
      if (a1 === "new") {
        if (!a2) throw new Error("usage: nearswaps-agent key new <account>");
        const k = newKeyPair(a2), path = saveKey(k, home);
        return show({ account: a2, public_key: k.publicKey, file: path }, () => [`account: ${a2}`, `public key: ${k.publicKey}`, `key file: ${path}`,
          `next: open nearswaps.com/agents, paste the public key, approve one AddKey in the wallet (${ORDERS}, methods trade, withdraw and recover_trade)`]);
      }
      if (a1 === "show") {
        const acct = a2 || accountFrom(flags, home), k = loadKey(acct, home);
        let status = "not on the account yet", others: string[] = [];
        try {
          const ak = await kit.views.viewAccessKey(acct, k.publicKey).catch(() => null);
          const c = checkPermission(ak);
          status = c.ok ? "On" : c.reason;
          others = agentKeysOf(await kit.views.viewAccessKeyList(acct)).filter((p) => p !== k.publicKey);
        } catch (e) { status = "couldn't check: " + (e as Error).message; }
        return show({ account: acct, public_key: k.publicKey, status, other_agent_keys: others }, () => [`account: ${acct}`, `public key: ${k.publicKey}`, `status: ${status}`,
          ...others.map((o) => `other key with the same permission: ${o}`)]);
      }
      throw new Error("usage: nearswaps-agent key new|show <account>");
    }
    case "policy": {
      if (a1 === "init") { const f = writeDefaultPolicy(policyFile); return show({ file: f }, () => [`policy written: ${f}`, "next: edit it before the first trade"]); }
      if (a1 === "show" || !a1) {
        let acct: string | null = null;
        try { acct = accountFrom(flags, home); } catch (e) { /* the policy alone */ }
        const s = policyStatus(policyFile, acct);
        return show(s, () => policyLines(s));
      }
      if (a1 === "check") {
        if (!a2) { const p = loadPolicy(policyFile); return show({ file: policyFile, valid: true, policy: p }, () => [`file: ${policyFile}`, "policy: valid (every field present and in range)"]); }
        if ((a2 !== "buy" && a2 !== "sell") || !a3 || !a4) throw new Error("usage: nearswaps-agent policy check [buy <token> <near> | sell <token> <amount>]");
        let acct: string | null = null;
        try { acct = accountFrom(flags, home); } catch (e) { /* an empty ledger */ }
        const r = await kit.previewTrade(a2, a3, a4, { policyFile, account: acct });
        show(r, () => previewLines(r, color));
        if (r.outcome === "blocked") process.exitCode = 2;
        return;
      }
      throw new Error("usage: nearswaps-agent policy init|show|check");
    }
    case "buy": case "sell": case "withdraw": case "recover": {
      const agent = await Agent.open({ accountId: accountFrom(flags, home), home, policyFile, onStatus: (t) => { if (!json) process.stderr.write(t + "\n"); } });
      let r: MoneyResult;
      if (cmd === "buy") { if (!a1 || !a2) throw new Error("usage: nearswaps-agent buy <token> <near>"); r = await agent.buy(a1, a2, { slippage }); }
      else if (cmd === "sell") { if (!a1 || !a2) throw new Error("usage: nearswaps-agent sell <token> <amount|50%|all>"); r = await agent.sell(a1, a2, { slippage }); }
      else if (cmd === "recover") { if (!a1) throw new Error("usage: nearswaps-agent recover <id>"); r = await agent.recoverTrade(a1); }
      else r = await agent.withdraw(a1 || "near", a2);
      show(r, () => moneyLines(r, cmd, color));
      if (r.outcome === "blocked" || r.outcome === "refused") process.exitCode = 2;
      return;
    }
    case undefined: case "help": return out([HELP]);
    default: throw new Error(`unknown command "${cmd}"; run nearswaps-agent help`);
  }
}

if (process.argv.includes("--help") || process.argv.includes("-h")) out([HELP]);
else main().catch((e) => { process.stderr.write("error: " + String((e && e.message) || e) + "\n"); process.exitCode = 1; });
