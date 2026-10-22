#!/usr/bin/env node
// nearswaps-agent: plain text, one fact per line, no colour, no emoji. --json prints the raw result instead.
// Session 1 ships the commands the first trade needs; the full CLI (with --color) follows with the MCP server.
import { readdirSync, existsSync } from "node:fs";
import { Agent, Kit } from "./agent.js";
import { ORDERS } from "./constants.js";
import { agentKeysOf, keyDir, loadKey, newKeyPair, saveKey } from "./keys.js";
import { loadPolicy, policyPath, writeDefaultPolicy } from "./policy.js";
import type { MoneyResult } from "./result.js";

const HELP = `nearswaps-agent: trade NEAR tokens from a 1-click balance only the owner can withdraw

Read-only (no key):
  nearswaps-agent check <token>                 token check: score, verdict, findings
  nearswaps-agent quote <from> <to> <amount>    1-click quote: amount out, minimum, fee, route
  nearswaps-agent launches [--since 1h]         new launches across Shards, Nearly, JustHoot, Intear

Agent key (kept in ~/.nearswaps-agent/<account>.json, mode 600):
  nearswaps-agent key new <account>             make a key pair; prints the public key to add on nearswaps.com/agents
  nearswaps-agent key show <account>            the public key and whether it is on the account, as the kit needs it

Policy (~/.nearswaps-agent/policy.json):
  nearswaps-agent policy init                   write the example policy
  nearswaps-agent policy show                   the policy, today's spend (UTC) and what is left

With the agent key (--account <id>, or the only key in the store):
  nearswaps-agent balance                       the 1-click balance
  nearswaps-agent pending                       trades still settling
  nearswaps-agent buy <token> <near>            buy with NEAR from the 1-click balance
  nearswaps-agent sell <token> <amount|50%|all> sell for NEAR into the 1-click balance
  nearswaps-agent withdraw [token] [amount]     withdraw to the owner's own wallet (default: all NEAR)
  nearswaps-agent recover <id>                  recover_trade: carry on a trade that stopped part way (see pending)

Options: --account <id>  --policy <file>  --slippage <bps|auto>  --json  --home <dir>`;

function parse(argv: string[]) {
  const pos: string[] = [], flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) { const k = a.slice(2); const v = argv[i + 1]; if (v !== undefined && !v.startsWith("--") && ["account", "policy", "slippage", "home", "since"].includes(k)) { flags[k] = v; i++; } else flags[k] = true; }
    else pos.push(a);
  }
  return { pos, flags };
}
const out = (lines: (string | false | null | undefined)[]) => { for (const l of lines) if (l) process.stdout.write(l + "\n"); };

function printMoney(r: MoneyResult) {
  out([`outcome: ${r.outcome}`, `reason: ${r.reason}`, r.amount_in && `amount in: ${r.amount_in}`, r.amount_out && `amount out: ${r.amount_out}`, r.fee && `fee: ${r.fee}`,
    r.score != null && `score: ${r.score}`, r.tx && `tx: https://nearblocks.io/txns/${r.tx}`]);
  for (const c of r.policy_checks) out([`check ${c.rule}: ${c.status} (${c.detail})`]);
}

function accountFrom(flags: Record<string, string | true>): string {
  if (typeof flags.account === "string") return flags.account;
  if (process.env.NEARSWAPS_AGENT_ACCOUNT) return process.env.NEARSWAPS_AGENT_ACCOUNT;
  const dir = keyDir(typeof flags.home === "string" ? flags.home : undefined);
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json") && f !== "policy.json" && !f.startsWith("ledger-")) : [];
  if (files.length === 1) return files[0].slice(0, -5);
  throw new Error(files.length ? "more than one agent key in the store: pass --account <id>" : "no agent key yet: run \"nearswaps-agent key new <account>\"");
}

const SINCE: Record<string, number> = { m: 60e3, h: 3600e3, d: 86400e3 };

async function main() {
  const { pos, flags } = parse(process.argv.slice(2));
  const json = flags.json === true, home = typeof flags.home === "string" ? flags.home : undefined;
  const policyFile = typeof flags.policy === "string" ? flags.policy : policyPath(home);
  const slippage = typeof flags.slippage === "string" ? (flags.slippage === "auto" ? "auto" as const : Number(flags.slippage)) : undefined;
  const [cmd, a1, a2, a3] = pos;
  const show = (v: unknown, lines: () => void) => { if (json) process.stdout.write(JSON.stringify(v, null, 2) + "\n"); else lines(); };
  const kit = new Kit();
  switch (cmd) {
    case "check": {
      if (!a1) throw new Error("usage: nearswaps-agent check <token>");
      const c = await kit.checkToken(a1);
      return show(c, () => { out([`token: ${c.token}`, `score: ${c.score}`, `verdict: ${c.verdict}`, `checked at: ${c.checked_at}${c.cached ? " (cached)" : ""}`]); for (const f of c.findings) out([`finding: ${f.severity}: ${f.title}`]); });
    }
    case "quote": {
      if (!a1 || !a2 || !a3) throw new Error("usage: nearswaps-agent quote <from> <to> <amount>");
      const q = await kit.getQuote(a1, a2, a3, { slippage });
      return show(q, () => { out([`amount in: ${q.amount_in}`, `amount out: ${q.amount_out}`, `minimum: ${q.min_out} (slippage ${q.slippage_bps / 100}%)`, `fee: ${q.fee} (${q.fee_bps / 100}%)`, `venue: ${q.venue}`, q.impact_bps != null && `price impact: ${(q.impact_bps / 100).toFixed(2)}%`]);
        q.route.forEach((l, i) => out([`leg ${i + 1}: ${l.amount_in} raw in, ${l.hops.map((h) => `pool ${h.pool_id} ${h.token_in} to ${h.token_out}`).join(", then ")}`])); });
    }
    case "launches": {
      const m = typeof flags.since === "string" ? /^(\d+)([mhd])$/.exec(flags.since) : null;
      const sinceMs = m ? Date.now() - Number(m[1]) * SINCE[m[2]] : 0;
      const r = await kit.listNewLaunches({ sinceMs, limit: 50 });
      return show(r, () => { for (const l of r.launches) out([`${new Date(l.created).toISOString()} ${l.pad} ${l.id} ${l.symbol} holders ${l.holders}${l.graduated ? " listed" : ""}`]);
        for (const [k, v] of Object.entries(r.sources)) if (!v.ok) out([`source ${k}: not answering (${v.note})`]); if (!r.launches.length) out(["no launches in that window"]); });
    }
    case "key": {
      if (a1 === "new") {
        if (!a2) throw new Error("usage: nearswaps-agent key new <account>");
        const k = newKeyPair(a2), path = saveKey(k, home);
        return show({ account: a2, public_key: k.publicKey, file: path }, () => out([`account: ${a2}`, `public key: ${k.publicKey}`, `key file: ${path}`,
          `next: open nearswaps.com/agents, paste the public key, approve one AddKey in the wallet (${ORDERS}, methods trade, withdraw and recover_trade)`]));
      }
      if (a1 === "show") {
        const acct = a2 || accountFrom(flags), k = loadKey(acct, home);
        const kitA = new Kit();
        let on = "not on the account yet", others: string[] = [];
        try {
          const { checkPermission } = await import("./keys.js");
          const ak = await kitA.views.viewAccessKey(acct, k.publicKey).catch(() => null);
          const c = checkPermission(ak);
          on = c.ok ? "On" : c.reason;
          others = agentKeysOf(await kitA.views.viewAccessKeyList(acct)).filter((p) => p !== k.publicKey);
        } catch (e) { on = "couldn't check: " + (e as Error).message; }
        return show({ account: acct, public_key: k.publicKey, status: on, other_agent_keys: others }, () => { out([`account: ${acct}`, `public key: ${k.publicKey}`, `status: ${on}`]); for (const o of others) out([`other key with the same permission: ${o}`]); });
      }
      throw new Error("usage: nearswaps-agent key new|show <account>");
    }
    case "policy": {
      if (a1 === "init") { const f = writeDefaultPolicy(policyFile); return out([`policy written: ${f}`, "edit it before the first trade"]); }
      if (a1 === "show" || !a1) {
        const p = loadPolicy(policyFile);
        return show(p, () => out([`file: ${policyFile}`, ...Object.entries(p).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") || "(none)" : v}`)]));
      }
      throw new Error("usage: nearswaps-agent policy init|show");
    }
    case "balance": case "pending": case "buy": case "sell": case "withdraw": case "recover": {
      const agent = await Agent.open({ accountId: accountFrom(flags), home, policyFile, onStatus: (t) => { if (!json) process.stderr.write(t + "\n"); } });
      if (cmd === "balance") { const b = await agent.getBalance(); return show(b, () => { out([`account: ${b.account}`]); if (!b.balances.length) out(["1-click balance: empty"]); for (const x of b.balances) out([`1-click balance: ${x.amount}`]); out([b.wallet_free && `wallet free for gas: ${b.wallet_free}`]); }); }
      if (cmd === "pending") { const p = await agent.getPending(); return show(p, () => { if (!p.length) out(["nothing in progress"]); for (const x of p) out([`${x.id} ${x.kind} ${x.token_in} to ${x.token_out} stage ${x.stage}${x.unclear ? " unclear" : ""} recover ${x.recoverable_at}`]); }); }
      let r: MoneyResult;
      if (cmd === "buy") { if (!a1 || !a2) throw new Error("usage: nearswaps-agent buy <token> <near>"); r = await agent.buy(a1, a2, { slippage }); }
      else if (cmd === "sell") { if (!a1 || !a2) throw new Error("usage: nearswaps-agent sell <token> <amount|50%|all>"); r = await agent.sell(a1, a2, { slippage }); }
      else if (cmd === "recover") { if (!a1) throw new Error("usage: nearswaps-agent recover <id>"); r = await agent.recoverTrade(a1); }
      else r = await agent.withdraw(a1 || "near", a2);
      show(r, () => printMoney(r));
      if (r.outcome === "blocked" || r.outcome === "refused") process.exitCode = 2;
      return;
    }
    case undefined: case "help": case "--help": return out([HELP]);
    default: throw new Error(`unknown command "${cmd}"; run nearswaps-agent help`);
  }
}

main().catch((e) => { process.stderr.write("error: " + String((e && e.message) || e) + "\n"); process.exitCode = 1; });
