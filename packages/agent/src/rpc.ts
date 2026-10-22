// NEAR JSON-RPC over fetch, one attempt per call (oneclick.js rpcCall). Reads fail over from FastNEAR to drpc;
// key-signed sends never go through here twice by themselves: sign.ts decides, exactly as the Terminal does.
import { RPC_URLS } from "./constants.js";

export type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<any>; text?(): Promise<string> }>;

export interface RpcError extends Error {
  /** No usable answer came back (the node may or may not have taken a send). */
  transport?: boolean;
  /** The node said it is rate limited: it took nothing. */
  busy?: boolean;
  /** The node's JSON-RPC error object. */
  rpc?: any;
  /** The transaction ran and failed on chain (a contract panic). */
  onchain?: boolean;
  res?: any;
}

/** What a node's error says (oneclick.js rpcText): the innermost reason, then the details. */
export function rpcText(err: any): string {
  const c = err && err.cause, d = err && err.data, info = c && c.info && Object.keys(c.info).length ? c.info : null;
  const detail = info || (d && typeof d === "object" ? d : null);
  let reason = "";
  for (let x = detail, i = 0; x && typeof x === "object" && i < 6; i++) { const k = Object.keys(x)[0]; if (!k) break; reason = k; x = x[k]; }
  const extra = detail ? JSON.stringify(detail).slice(0, 220) : typeof d === "string" ? d.slice(0, 200) : "";
  return String((c && c.name) || (err && err.name) || "") + (reason ? ": " + reason : "") + (extra ? " " + extra : "");
}

export interface RpcOptions {
  urls?: string[];
  fetch?: FetchLike;
}

export class Rpc {
  readonly urls: string[];
  private readonly fetchFn: FetchLike;
  private pick = { url: "", at: 0 };

  constructor(opts: RpcOptions = {}) {
    this.urls = opts.urls && opts.urls.length ? opts.urls.slice() : RPC_URLS.slice();
    this.fetchFn = opts.fetch || (globalThis.fetch as unknown as FetchLike);
    this.pick = { url: this.urls[0], at: 0 };
  }

  /** One JSON-RPC call to one node, one attempt. */
  async call(url: string, method: string, params: unknown, timeoutMs: number): Promise<any> {
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      let r;
      try {
        r = await this.fetchFn(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: "agent", method, params }), signal: ctl.signal });
      } catch (e) {
        throw Object.assign(new Error("the network didn't answer (" + String((e as Error).message || e).slice(0, 80) + ")"), { transport: true });
      }
      if (!r.ok) throw Object.assign(new Error("the network answered " + r.status), { transport: true, busy: r.status === 429 });
      let j;
      try { j = await r.json(); } catch (e) { throw Object.assign(new Error("the network's answer can't be read"), { transport: true }); }
      // "Rate limited" means the node took nothing: treated like no answer, so the call moves to the next node.
      if (j && j.error && /-429|rate limit|too many requests/i.test(JSON.stringify(j.error))) throw Object.assign(new Error("the network service is busy (rate limited)"), { transport: true, busy: true });
      if (j && j.error) throw Object.assign(new Error(rpcText(j.error)), { rpc: j.error });
      return j ? j.result : undefined;
    } finally {
      clearTimeout(timer);
    }
  }

  /** The node that answers: FastNEAR, else drpc, checked again when the last check is older than `maxAge` or
   * a call on it failed (oneclick.js liveRpc). */
  async live(skip?: string, maxAge = 60000): Promise<string> {
    if (!skip && Date.now() - this.pick.at < maxAge) return this.pick.url;
    for (const url of this.urls.filter((u) => u !== skip).concat(skip ? [skip] : [])) {
      try { await this.call(url, "block", { finality: "final" }, 6000); this.pick = { url, at: Date.now() }; return url; } catch (e) { /* next */ }
    }
    throw new Error("the NEAR network isn't answering right now; nothing was sent. Try again in a moment");
  }

  setPicked(url: string): void { this.pick = { url, at: Date.now() }; }

  /** A read with failover: each node once, in order, starting with the one that answered last. */
  async read(method: string, params: unknown, timeoutMs = 10000): Promise<any> {
    const order = [this.pick.url, ...this.urls.filter((u) => u !== this.pick.url)];
    let last: RpcError | null = null;
    for (const url of order) {
      try { const r = await this.call(url, method, params, timeoutMs); if (url !== this.pick.url) this.setPicked(url); return r; }
      catch (e) {
        last = e as RpcError;
        // A contract or account error is the answer, not the node's fault: the other node says the same.
        if (last.rpc && !/TIMEOUT|INTERNAL|UNKNOWN_BLOCK|NO_SYNCED/i.test(JSON.stringify(last.rpc))) throw last;
      }
    }
    throw last || new Error("the NEAR network isn't answering right now");
  }

  /** A contract view (call_function), answered as JSON. */
  async view<T = any>(contract: string, method: string, args: unknown = {}, finality: "optimistic" | "final" = "optimistic"): Promise<T> {
    const r = await this.read("query", { request_type: "call_function", finality, account_id: contract, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString("base64") });
    if (r && r.error) throw Object.assign(new Error(String(r.error)), { rpc: { name: "CONTRACT_EXECUTION_ERROR", data: r.error } });
    const bytes = Buffer.from(Uint8Array.from((r && r.result) || []));
    return JSON.parse(bytes.toString("utf8") || "null") as T;
  }

  async query(params: Record<string, unknown>): Promise<any> {
    const r = await this.read("query", params);
    if (r && r.error) throw Object.assign(new Error(String(r.error)), { rpc: { name: "QUERY_ERROR", data: r.error } });
    return r;
  }
}
