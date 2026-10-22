// Test helpers: a fake network (NEAR JSON-RPC and the HTTP reads) built from recorded fixtures, so every test runs
// offline. Nothing here reaches mainnet.
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const HERE = dirname(fileURLToPath(import.meta.url));
export const fixture = (name) => JSON.parse(readFileSync(join(HERE, "fixtures", name), "utf8"));
export const routeFixtures = () => readdirSync(join(HERE, "fixtures", "routes")).filter((f) => f.endsWith(".json")).sort().map((f) => ({ file: f, ...fixture("routes/" + f) }));
export const tempHome = () => mkdtempSync(join(tmpdir(), "nearswaps-agent-test-"));

const json = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });
const viewResult = (value) => ({ result: Array.from(Buffer.from(JSON.stringify(value))), logs: [], block_height: 1, block_hash: "x" });

/**
 * A fake fetch. `views[account + "." + method]` answers call_function (a value, or a function of the args);
 * `rpc[method]` answers other JSON-RPC methods (a function of params, may throw { rpcError } or return
 * { transportError: true }); `http` is a list of [test(url), body | function(url)].
 * Every JSON-RPC request is logged in `log`.
 */
export function fakeNet({ views = {}, rpc = {}, http = [] } = {}) {
  const log = [];
  const fetch = async (url, init = {}) => {
    if (init.method === "POST") {
      const req = JSON.parse(init.body);
      log.push({ url, method: req.method, params: req.params });
      if (req.method === "query" && req.params.request_type === "call_function") {
        const key = req.params.account_id + "." + req.params.method_name;
        if (!(key in views)) return json({ jsonrpc: "2.0", id: req.id, error: { name: "HANDLER_ERROR", cause: { name: "NO_VIEW", info: { key } }, message: "no fake for " + key } });
        const args = JSON.parse(Buffer.from(req.params.args_base64, "base64").toString() || "{}");
        const v = views[key];
        let value;
        try { value = typeof v === "function" ? await v(args, req.params) : v; }
        catch (e) { return json({ jsonrpc: "2.0", id: req.id, result: { error: String(e.message || e), logs: [] } }); }
        return json({ jsonrpc: "2.0", id: req.id, result: viewResult(value) });
      }
      const name = req.method === "query" ? "query." + req.params.request_type : req.method;
      const h = rpc[name];
      if (!h) return json({ jsonrpc: "2.0", id: req.id, error: { name: "HANDLER_ERROR", cause: { name: "NO_FAKE", info: { name } }, message: "no fake for " + name } });
      try {
        const r = await h(req.params, url);
        if (r && r.transportError) throw new Error("fetch failed");
        if (r && r.rpcError) return json({ jsonrpc: "2.0", id: req.id, error: r.rpcError });
        return json({ jsonrpc: "2.0", id: req.id, result: r });
      } catch (e) {
        if (e && e.rpcError) return json({ jsonrpc: "2.0", id: req.id, error: e.rpcError });
        throw e;
      }
    }
    for (const [test, body] of http) if (typeof test === "string" ? url.startsWith(test) : test.test(url)) {
      const b = typeof body === "function" ? await body(url) : body;
      return b && b.__status ? json(b.body || {}, b.__status) : json(b);
    }
    return json({ error: "no fake for " + url }, 404);
  };
  return { fetch, log };
}

/** The receipts of a transaction whose orders-contract receipts logged these events. */
export function txOutcome(hash, evs, failure) {
  return {
    status: failure ? { Failure: failure } : { SuccessValue: "" },
    transaction: { hash },
    transaction_outcome: { id: hash },
    receipts_outcome: [{ id: "r1", outcome: { executor_id: "nekoorders.near", logs: evs.map((e) => "EVENT_JSON:" + JSON.stringify({ standard: "neko-orders", version: "1.4.0", ...e })), status: { SuccessValue: "" } } }],
  };
}

export const NEAR = 10n ** 24n;
