// A key-signed call is signed ONCE and sent ONCE: a port of neko-site/assets/oneclick.js signAndSendOnce,
// sendSigned, followTx and keyCall (lines 172 to 250 and 889 to 897). If the connection drops or the node times
// out, the transaction is followed by its hash until it is final; it is never signed or sent again, so a trade
// can't happen twice. Two exceptions, both refused before anything ran: a nonce the node rejects (signed afresh
// once), and the contract's own "try again in a moment" (signed afresh once after a short wait).
// near-api-js's own send is never used: it re-posts on errors and re-signs on InvalidNonce.
import { createHash } from "node:crypto";
import { b58decode, b58encode, encodeSigned, encodeTransaction, toB64 } from "./codec.js";
import { ORDERS, POLL_FOR_MS, POLL_MS, RETRY_MS, SEND_TIMEOUT_MS } from "./constants.js";
import { publicKeyBytes, signBytes, type AgentKey } from "./keys.js";
import type { Rpc, RpcError } from "./rpc.js";

const sleepReal = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** What a transaction's failure says (a contract panic: "Smart contract panicked: ..."). */
export function failureText(f: any): string {
  try {
    const k = f.ActionError && f.ActionError.kind;
    const fe = k && k.FunctionCallError;
    if (fe && fe.ExecutionError) return String(fe.ExecutionError);
    return JSON.stringify(f).slice(0, 220);
  } catch (e) { return "the transaction failed"; }
}
export function checkOutcome(res: any): any {
  if (res && res.status && res.status.Failure) throw Object.assign(new Error(failureText(res.status.Failure)), { onchain: true, res });
  return res;
}
/** The node refused the transaction outright (bad nonce, allowance used up, expired...): nothing ran. */
export const refusedOutright = (err: any): boolean => {
  const n = String((err && err.cause && err.cause.name) || (err && err.name) || "");
  return /INVALID_TRANSACTION|REQUEST_VALIDATION_ERROR|PARSE_ERROR/.test(n);
};
/** The contract refused before anything moved, and asks for another go (oneclick.js retryable). */
export const retryable = (e: any): boolean => !!(e && e.onchain) && /try again in a moment/i.test(String(e.message || ""));

export interface NeoEvent { standard: string; version?: string; event: string; data: any }
/** EVENT_JSON lines of the orders contract in a transaction outcome (oneclick.js events). */
export function events(res: any): NeoEvent[] {
  const out: NeoEvent[] = [];
  for (const r of (res && res.receipts_outcome) || []) {
    const o = r && r.outcome; if (!o || o.executor_id !== ORDERS) continue;
    for (const l of o.logs || []) {
      if (!String(l).startsWith("EVENT_JSON:")) continue;
      try { const e = JSON.parse(String(l).slice(11)); if (e && e.standard === "neko-orders") out.push(e); } catch (e) { /* not ours */ }
    }
  }
  return out;
}
export const hashOf = (res: any): string => (res && res.transaction && res.transaction.hash) || (res && res.transaction_outcome && res.transaction_outcome.id) || "";

export interface SignerOptions {
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Plain-text progress lines ("Sent, still settling..."). */
  onStatus?: (text: string) => void;
}
export interface CallOptions {
  /** v1.6: the receipts executed so far, read every 350 ms while the send waits (the early "about" figure). */
  onPartial?: (partial: any) => void;
}

/** The signer for one account and its agent key. Keeps the last nonce it signed and a recent final block. */
export class Signer {
  private nonce: Record<string, bigint> = {};
  private block: { hash: Uint8Array; at: number; url: string } | null = null;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly status: (text: string) => void;
  private readonly now: () => number;

  constructor(readonly rpc: Rpc, readonly key: AgentKey, opts: SignerOptions = {}) {
    this.sleep = opts.sleep || sleepReal;
    this.status = opts.onStatus || (() => {});
    this.now = opts.now || Date.now;
  }

  /** Forget the kept nonce and block (oneclick.js dropSigner). */
  drop(): void { this.nonce = {}; this.block = null; }

  /** A recent final block hash, reused for a minute (a transaction may name any block of the last ~14 hours). */
  private async blockHash(url: string): Promise<Uint8Array> {
    if (this.block && this.now() - this.block.at < 60000) return this.block.hash;
    const b = await this.rpc.call(url, "block", { finality: "final" }, 10000);
    const hash = b58decode(String(b && b.header && b.header.hash));
    if (hash.length !== 32) throw Object.assign(new Error("the network's block answer can't be read"), { transport: true });
    this.block = { hash, at: this.now(), url };
    return hash;
  }

  /** Sign ONE transaction with the agent key and send it ONCE (signAndSendOnce). */
  async signAndSendOnce(methodName: string, args: unknown, gas: bigint, opts: CallOptions = {}): Promise<any> {
    const acct = this.key.accountId, pub = this.key.publicKey;
    // Reads first (nonce, block): if the node fails here nothing has been signed yet, so the other node is tried.
    let url = "", txBytes: Uint8Array | null = null, nonce = 0n;
    for (let attempt = 0; ; attempt++) {
      url = await this.rpc.live(attempt ? url : undefined);
      try {
        let ak: any;
        try { ak = await this.rpc.call(url, "query", { request_type: "view_access_key", finality: "optimistic", account_id: acct, public_key: pub }, 10000); }
        catch (e) {
          const err = e as RpcError;
          if (err.rpc && /UNKNOWN_ACCESS_KEY|does not exist/i.test(JSON.stringify(err.rpc) + err.message)) throw new Error("the agent key isn't on " + acct + " any more; add it again on nearswaps.com/agents");
          throw err;
        }
        if (!ak || ak.error) {
          if (ak && /does not exist/i.test(String(ak.error))) throw new Error("the agent key isn't on " + acct + " any more; add it again on nearswaps.com/agents");
          throw Object.assign(new Error("the access key can't be read"), { transport: true });
        }
        // The nonce: never below the last one this process signed (a trade still settling isn't in the view yet).
        let n = BigInt(ak.nonce);
        if (this.nonce[pub] != null && n < this.nonce[pub]) n = this.nonce[pub];
        nonce = n + 1n;
        const blockHash = await this.blockHash(url);
        txBytes = encodeTransaction({ signerId: acct, publicKey: publicKeyBytes(pub), nonce, receiverId: ORDERS, blockHash,
          methodName, args: new TextEncoder().encode(JSON.stringify(args)), gas, deposit: 0n });
        break;
      } catch (e) {
        if (attempt > 0 || /isn't on .* any more/.test(String((e as Error).message))) throw e;
      }
    }
    const hashBytes = Uint8Array.from(createHash("sha256").update(txBytes).digest());
    const signed = encodeSigned(txBytes, signBytes(this.key, hashBytes));
    this.nonce[pub] = nonce;
    const hash = b58encode(hashBytes);
    let done = false;
    if (opts.onPartial) (async () => {
      await this.sleep(400);
      while (!done) {
        try { const p = await this.rpc.call(url, "EXPERIMENTAL_tx_status", { tx_hash: hash, sender_account_id: acct, wait_until: "NONE" }, 3000); if (!done && p) opts.onPartial!(p); } catch (e) { /* the send answers */ }
        await this.sleep(350);
      }
    })();
    try { return await this.sendSigned(url, signed, pub, hash); } finally { done = true; }
  }

  private async sendSigned(url: string, signed: Uint8Array, pub: string, hash: string): Promise<any> {
    const b64 = toB64(signed);
    let res;
    try {
      res = await this.rpc.call(url, "send_tx", { signed_tx_base64: b64, wait_until: "EXECUTED_OPTIMISTIC" }, SEND_TIMEOUT_MS);
    } catch (e) {
      const err = e as RpcError;
      if (err.rpc && refusedOutright(err.rpc)) {
        delete this.nonce[pub];
        // A nonce the kept signer had wrong: refused before anything ran, so keyCall signs afresh once.
        if (/InvalidNonce/.test(err.message)) { this.drop(); throw Object.assign(new Error("the key's counter was out of date; nothing was sent"), { renonce: true }); }
        throw Object.assign(new Error(/NotEnoughAllowance/.test(err.message) ? "this agent key's fee cap is too small for this trade; add a key with no cap on nearswaps.com/agents; nothing was sent"
          : /NotEnoughBalance|LackBalanceForState/.test(err.message) ? "the owner's wallet itself (not the 1-click balance) needs more free NEAR for this trade's network fee reserve, up to 0.9 NEAR, almost all returned within seconds; nothing was sent"
          : "the network refused it (" + err.message.trim() + "); nothing was sent"), { refusedOutright: true });
      }
      // The node didn't answer: the SAME signed transaction goes to the other node (same hash and nonce, so it runs
      // at most once; it is never signed again). Whatever that node says short of a result, the hash is followed.
      if (err.transport) {
        for (const other of this.rpc.urls.filter((u) => u !== url)) {
          try {
            const r2 = await this.rpc.call(other, "send_tx", { signed_tx_base64: b64, wait_until: "EXECUTED_OPTIMISTIC" }, SEND_TIMEOUT_MS);
            this.rpc.setPicked(other);
            return checkOutcome(r2);
          } catch (e2) { const x = e2 as RpcError; if (x && x.onchain) throw x; if (!(x && x.busy)) break; }
        }
        // Busy everywhere and nothing took it: say so plainly (the same signed transaction was never accepted).
        if (err.busy) { delete this.nonce[pub]; throw Object.assign(new Error("every NEAR network service was busy (rate limited), so nothing was sent. Try again in a few seconds"), { refusedOutright: true }); }
      }
      // Dropped connection, timeout, or a node error: it may still land. Follow it, never send it again.
      this.status("Sent, still settling...");
      return this.followTx(hash);
    }
    return checkOutcome(res);
  }

  /** A transaction whose answer was lost: ask any node by its hash until it is final (followTx). */
  async followTx(hash: string): Promise<any> {
    const until = this.now() + POLL_FOR_MS;
    for (let i = 0; this.now() < until; i++) {
      const url = this.rpc.urls[i % this.rpc.urls.length];
      try { return checkOutcome(await this.rpc.call(url, "tx", { tx_hash: hash, sender_account_id: this.key.accountId, wait_until: "EXECUTED_OPTIMISTIC" }, 10000)); }
      catch (e) { if ((e as RpcError).onchain) throw e; }
      await this.sleep(POLL_MS);
    }
    throw Object.assign(new Error("Sent, but the network hasn't confirmed it yet (tx " + hash + "). Don't send it again: the 1-click balance shows the result in a minute."), { settling: true, hash });
  }

  /** A call signed with the agent key (0 deposit), as keyCall: one fresh signature after a refused nonce or after the
   * contract's "try again in a moment"; nothing else is retried. */
  async keyCall(methodName: string, args: unknown, gas: bigint, opts: CallOptions = {}): Promise<any> {
    await this.rpc.live(undefined, 5000).catch(() => null);
    try { return await this.signAndSendOnce(methodName, args, gas, opts); }
    catch (e) {
      if (e && (e as any).renonce) return this.signAndSendOnce(methodName, args, gas, opts);
      if (!retryable(e)) throw e;
      this.status("That token is busy for a moment. Trying again...");
      await this.sleep(RETRY_MS);
      return this.signAndSendOnce(methodName, args, gas, opts);
    }
  }
}
