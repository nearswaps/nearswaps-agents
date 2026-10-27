#!/usr/bin/env node
// prompt-agent: a trading agent on @nearswaps/agent driven by a plain-language prompt. It runs a tool-calling loop
// against an OpenAI-compatible chat completions endpoint (NEAR AI Cloud by default, open models in TEEs), with the
// kit's twelve tools taken from the MCP server itself (packages/mcp), so the two never drift.
//
//   node examples/prompt-agent.mjs --account <id> "<prompt>" [--dry-run] [--max-steps 12] [--max-money 2] [--model <id>] [--color]
//
// The model: base URL from NEARSWAPS_LLM_BASE_URL, key from NEARSWAPS_LLM_API_KEY, model from --model or
// NEARSWAPS_LLM_MODEL; each falls back to ~/.nearswaps-agent/llm.json ({ "base_url", "api_key", "model" }).
//
// Guard rails in code, not in the prompt: at most --max-steps model turns; at most --max-money money tool calls a run
// (buy, sell, withdraw, recover_trade); a buy or sell the policy blocked is never sent again in the same run; every
// money call still goes through the policy and the contract (the MCP server's handlers call the Agent); and without
// --dry-run the loop does not start unless the agent key file is there.
//
// --dry-run loads no key and signs nothing: buy and sell run the kit's policy dry run ("would pass" or "blocked"),
// withdraw and recover_trade return a note. Plain text, one fact per line, no colour unless --color.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Agent, Kit, keyDir, keyPath, policyPath, moneyLines, previewLines, paint } from "@nearswaps/agent";
import { createServer, READ_TOOLS, MONEY_TOOLS } from "@nearswaps/agent-mcp";

/** NEAR AI Cloud's OpenAI-compatible API (docs.near.ai/cloud/quickstart). */
export const DEFAULT_BASE_URL = "https://cloud-api.near.ai/v1";
/** An open model NEAR AI Cloud runs itself, with tool calling (its /v1/models list, 27 Oct 2026). */
export const DEFAULT_MODEL = "z-ai/glm-5.3-flash";
export const DEFAULT_MAX_STEPS = 12;
export const DEFAULT_MAX_MONEY = 2;
/** How much of a read result is printed; the model gets it whole (up to MODEL_CHARS). */
const PRINT_CHARS = 240, MODEL_CHARS = 12000;

export const SYSTEM_PROMPT = `You are a trading agent for the nearswaps agent kit on NEAR. You act for one owner account through tools.

Vocabulary:
- The agent key is a NEAR function-call key that can call only trade, withdraw and recover_trade on nekoorders.near. It trades from the owner's 1-click balance, funds only the owner can withdraw.
- Hard limits are the contract's: withdraw pays the owner only, trades go only through pools the contract allows, the contract caps each trade.
- The policy is the kit's file: score floor, most unchecked findings, least liquidity, per-trade maximum, daily budget, deny list, trusted list, cool-down. get_policy shows it.
- The token check (check_token) scores a token from 0 to 100 with a verdict and findings. The score floor is what the policy compares it with.
- Every money tool (buy, sell, withdraw, recover_trade) returns an outcome: filled (done on chain), refused (the chain or the contract said no), blocked (the policy or a kit check stopped it before signing; nothing was signed), unclear or pending (still settling: follow with get_pending, never send it again). In a dry run the outcome of buy and sell is "would pass" or "blocked" and nothing is signed.

Rules:
1. Before any buy, run check_token on that token and get_quote for that exact trade (from near to the token, the same amount).
2. Never retry a blocked trade, and never send a pending or unclear trade again. Report it and move on.
3. Do only what the user asked. Stop as soon as the request is met: no extra trades, no extra reads.
4. Amounts are decimals in NEAR for buys ("0.2"). Use token ids exactly as the tools return them.
5. Do not poll the token check: it is rate limited and cached for 60 seconds.
6. In your final answer, report every money call you made with its outcome, its reason and its tx hash (or "no tx" when nothing was signed), then anything else the user asked for. Plain text, no emoji.`;

const MONEY = new Set(MONEY_TOOLS);

export function parseArgs(argv) {
  const o = { account: null, prompt: null, dryRun: false, maxSteps: DEFAULT_MAX_STEPS, maxMoney: DEFAULT_MAX_MONEY, model: null, color: false, policy: null, home: undefined };
  const val = (i, k) => { const v = argv[i + 1]; if (v === undefined || v.startsWith("--")) throw new Error(`--${k} needs a value`); return v; };
  const count = (v, k, min) => { const n = Number(v); if (!(Number.isInteger(n) && n >= min)) throw new Error(`--${k} is a whole number, ${min} or more`); return n; };
  const words = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--account") o.account = val(i++, "account");
    else if (a === "--max-steps") o.maxSteps = count(val(i++, "max-steps"), "max-steps", 1);
    else if (a === "--max-money") o.maxMoney = count(val(i++, "max-money"), "max-money", 0);
    else if (a === "--model") o.model = val(i++, "model");
    else if (a === "--policy") o.policy = val(i++, "policy");
    else if (a === "--home") o.home = val(i++, "home");
    else if (a === "--dry-run") o.dryRun = true;
    else if (a === "--color") o.color = true;
    else if (a.startsWith("--")) throw new Error(`unknown argument "${a}"`);
    else words.push(a);
  }
  o.prompt = words.join(" ").trim() || null;
  if (!o.prompt) throw new Error("say what to do, in quotes: \"buy 0.2 NEAR of ...\"");
  if (!o.account) o.account = process.env.NEARSWAPS_AGENT_ACCOUNT || null;
  if (!o.account && !o.dryRun) throw new Error("--account <id> is needed for a real run (a dry run can go without one)");
  return o;
}

/** The model endpoint: environment first, then ~/.nearswaps-agent/llm.json, then NEAR AI Cloud and DEFAULT_MODEL.
 * `model` (--model) wins over both. The key is never printed. */
export function loadLlmConfig({ env = process.env, home, model = null } = {}) {
  const file = join(keyDir(home), "llm.json");
  let f = {};
  if (existsSync(file)) {
    try { f = JSON.parse(readFileSync(file, "utf8")) || {}; } catch (e) { throw new Error(`${file} is not JSON: ${e.message}`); }
  }
  const baseUrl = String(env.NEARSWAPS_LLM_BASE_URL || f.base_url || DEFAULT_BASE_URL).replace(/\/+$/, "");
  const apiKey = env.NEARSWAPS_LLM_API_KEY || f.api_key || null;
  return { baseUrl, apiKey, model: model || env.NEARSWAPS_LLM_MODEL || f.model || DEFAULT_MODEL, file };
}

/** Whether a real run may start: the agent key file must be there. Returns null, or the reason it may not. */
export function startRefusal({ dryRun, account, home }) {
  if (dryRun) return null;
  const file = keyPath(account, home);
  return existsSync(file) ? null : `no agent key for ${account} (${file}): run "nearswaps-agent key new ${account}" and add it on nearswaps.com/agents, or use --dry-run`;
}

/** The kit's twelve tools, from the MCP server through an in-memory MCP client: the same names, descriptions, input
 * schemas and handlers as nearswaps-agent-mcp. In a dry run the server gets a stand-in agent so the money tools are
 * listed; their calls never reach it (runPromptAgent answers them with the policy dry run). */
export async function kitTools({ kit, agent, policyFile, account }) {
  const stand = agent || { accountId: account, dryRun: true };
  const server = createServer({ kit, agent: stand, policyFile, account });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "nearswaps-prompt-agent", version: "0.1.0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  const { tools } = await client.listTools();
  const defs = tools.map((t) => {
    const { $schema, ...parameters } = t.inputSchema || { type: "object", properties: {} };
    return { type: "function", function: { name: t.name, description: t.description || t.title || t.name, parameters } };
  });
  return { client, defs, close: () => client.close() };
}

/** One chat completions request. Throws with the status and a short body; the key is not in the message. */
export async function chat({ baseUrl, apiKey, model, fetch = globalThis.fetch }, messages, tools) {
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
    body: JSON.stringify({ model, messages, tools, tool_choice: "auto", temperature: 0 }),
    signal: AbortSignal.timeout(180_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`the model endpoint answered ${res.status}: ${text.replace(/\s+/g, " ").slice(0, 200)}`);
  let j;
  try { j = JSON.parse(text); } catch { throw new Error("the model endpoint did not answer JSON"); }
  const m = j && j.choices && j.choices[0] && j.choices[0].message;
  if (!m) throw new Error("the model endpoint answered with no message");
  return m;
}

const oneLine = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
const trim = (s, n) => (s.length > n ? s.slice(0, n) + ` ... (${s.length - n} more characters)` : s);
const sideOf = (name) => (name === "recover_trade" ? "recover" : name);

/**
 * The loop. `kit` reads (an Agent is a Kit); `agent` signs, or null for a dry run. `llm` is { baseUrl, apiKey, model,
 * fetch }. `out` takes one line at a time. Returns { steps, moneyCalls, calls, answer, stopped } for the tests:
 * `calls` is every tool call with { name, args, result, executed }; `stopped` is "answer", "max_steps" or "error".
 */
export async function runPromptAgent({ kit, agent = null, policyFile, account = null, prompt, llm, maxSteps = DEFAULT_MAX_STEPS, maxMoney = DEFAULT_MAX_MONEY, color = false, out = (l) => process.stdout.write(l + "\n") }) {
  const dry = !agent;
  out(`mode: ${dry ? "dry run (no key loaded; nothing signed)" : `trading for ${agent.accountId} with the agent key`}`);
  out(`account: ${account || "none given"}`);
  out(`policy: ${policyFile}`);
  out(`model: ${llm.model} at ${llm.baseUrl}`);
  out(`most steps: ${maxSteps}`);
  out(`most money calls: ${maxMoney}`);
  out(`prompt: ${oneLine(prompt)}`);

  const tools = await kitTools({ kit, agent, policyFile, account });
  const messages = [{ role: "system", content: SYSTEM_PROMPT + `\nThe owner account is ${account || "not given (ask for none; use reads that need no account)"}.${dry ? "\nThis run is a dry run: buy and sell return the policy's answer, nothing is signed." : ""}` }, { role: "user", content: prompt }];
  const calls = [], blocked = new Set();
  let moneyCalls = 0, answer = null, stopped = "max_steps", step = 0;

  const money = async (name, args) => {
    const key = `${name}:${kit.resolveToken ? safeResolve(kit, args.token) : args.token}`;
    if ((name === "buy" || name === "sell") && blocked.has(key)) {
      return { executed: false, result: { outcome: "blocked", reason: `not sent: the same ${name} of ${args.token} was blocked earlier in this run, and a blocked trade is never retried`, tx: null, policy_checks: [] } };
    }
    if (moneyCalls >= maxMoney) {
      return { executed: false, result: { outcome: "blocked", reason: `not sent: this run's cap of ${maxMoney} money calls is reached (a guard in the runner, not the policy)`, tx: null, policy_checks: [] } };
    }
    moneyCalls++;
    let result;
    if (dry && (name === "buy" || name === "sell")) {
      const amount = name === "buy" ? args.near : args.amount;
      try { result = await kit.previewTrade(name, args.token, amount, { policyFile, account }); }
      catch (e) { const m = String(e.message || e); result = { outcome: "blocked", reason: m, side: name, token: args.token, near: name === "buy" ? `${amount} NEAR` : "unknown", account, score: null, policy_checks: [{ rule: "before_signing", status: "fail", detail: m }] }; }
    } else if (dry) {
      result = { outcome: "dry run", reason: `a dry run: ${name} signs nothing and sends nothing`, tx: null, policy_checks: [] };
    } else {
      const r = await tools.client.callTool({ name, arguments: args });
      result = r.structuredContent || { outcome: "refused", reason: oneLine(r.content && r.content[0] && r.content[0].text), tx: null, policy_checks: [] };
    }
    if ((name === "buy" || name === "sell") && result.outcome === "blocked") blocked.add(key);
    return { executed: true, result };
  };

  try {
    for (step = 1; step <= maxSteps; step++) {
      let msg;
      try { msg = await chat(llm, messages, tools.defs); }
      catch (e) { out(`step ${step}: error: ${oneLine(e.message || e)}`); stopped = "error"; break; }
      const toolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
      messages.push({ role: "assistant", content: msg.content ?? null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) });
      if (!toolCalls.length) {
        answer = String(msg.content || "").trim();
        for (const l of (answer || "(no answer)").split(/\r?\n/).map((x) => x.trim()).filter(Boolean)) out(`answer: ${l}`);
        stopped = "answer";
        break;
      }
      if (msg.content && oneLine(msg.content)) out(`step ${step}: model: ${oneLine(msg.content)}`);
      for (const tc of toolCalls) {
        const name = tc.function && tc.function.name;
        let args = {}, parseError = null;
        try { args = tc.function.arguments ? JSON.parse(tc.function.arguments) : {}; } catch (e) { parseError = e.message; }
        out(`step ${step}: call ${name} ${parseError ? oneLine(tc.function.arguments) : JSON.stringify(args)}`);
        let content, rec;
        if (parseError) {
          content = `error: the arguments are not JSON (${parseError})`;
          out(`step ${step}: result: ${content}`);
          rec = { name, args: null, result: content, executed: false };
        } else if (MONEY.has(name)) {
          const { executed, result } = await money(name, args);
          if (result.outcome === "blocked") result.note = "blocked: nothing was signed; do not retry this trade in this run";
          content = JSON.stringify(result);
          if (!executed) out(`step ${step}: result: ${result.outcome} (${result.reason})`);
          else {
            const lines = result.outcome === "would pass" || (dry && result.side) ? previewLines(result, color) : result.outcome === "dry run" ? [`outcome: dry run`, `reason: ${result.reason}`] : moneyLines(result, sideOf(name), color);
            for (const l of lines) out(`step ${step}: ${l}`);
          }
          rec = { name, args, result, executed };
        } else if (READ_TOOLS.includes(name)) {
          const r = await tools.client.callTool({ name, arguments: args });
          const text = (r.content || []).map((c) => c.text || "").join("\n");
          content = trim(text, MODEL_CHARS);
          out(`step ${step}: result: ${trim(oneLine(text), PRINT_CHARS)}`);
          rec = { name, args, result: text, executed: true, isError: !!r.isError };
        } else {
          content = `error: there is no tool named "${name}"`;
          out(`step ${step}: result: ${content}`);
          rec = { name, args, result: content, executed: false };
        }
        calls.push(rec);
        messages.push({ role: "tool", tool_call_id: tc.id, content });
      }
    }
    if (stopped === "max_steps") { step = maxSteps; out(paint(`stopped: the cap of ${maxSteps} steps is reached with no final answer`, "red", color)); }
  } finally {
    await tools.close();
  }
  out(`money calls this run: ${moneyCalls} of at most ${maxMoney}`);
  return { steps: step, moneyCalls, calls, answer, stopped };
}

function safeResolve(kit, t) { try { return kit.resolveToken(t); } catch { return t; } }

async function main() {
  const o = parseArgs(process.argv.slice(2));
  const policyFile = o.policy || policyPath(o.home);
  const refusal = startRefusal({ dryRun: o.dryRun, account: o.account, home: o.home });
  if (refusal) throw new Error(refusal);
  const llm = loadLlmConfig({ home: o.home, model: o.model });
  if (!llm.apiKey) throw new Error(`no model key: set NEARSWAPS_LLM_API_KEY, or put { "base_url", "api_key", "model" } in ${llm.file}`);
  const status = (t) => process.stderr.write(t + "\n");
  const agent = o.dryRun ? null : await Agent.open({ accountId: o.account, home: o.home, policyFile, onStatus: status });
  const kit = agent || new Kit();
  const r = await runPromptAgent({ kit, agent, policyFile, account: o.account, prompt: o.prompt, llm, maxSteps: o.maxSteps, maxMoney: o.maxMoney, color: o.color });
  if (r.stopped !== "answer") process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { process.stderr.write("error: " + String((e && e.message) || e) + "\n"); process.exitCode = 1; });
}
