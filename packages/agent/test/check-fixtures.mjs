// Checks that the recorded route fixtures hold real chain state: every pool read the panel made (pool_reads) is asked
// again at its block height, and the answer's SHA-256 must match the one recorded in the browser. Read-only.
// Ordinary nodes keep about two and a half days of state; after that, point it at an archival node:
//   node test/check-fixtures.mjs https://archival-rpc.mainnet.fastnear.com
import { createHash } from "node:crypto";
import { routeFixtures } from "./helpers.mjs";

const RPC = process.argv[2] || "https://free.rpc.fastnear.com";
let ok = 0, bad = 0;
for (const fx of routeFixtures()) {
  for (const r of fx.pool_reads || []) {
    const body = { jsonrpc: "2.0", id: 1, method: "query", params: { request_type: "call_function", block_id: r.block_height, account_id: "v2.ref-finance.near", method_name: r.method, args_base64: Buffer.from(JSON.stringify(r.args)).toString("base64") } };
    const j = await (await fetch(RPC, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })).json();
    const bytes = j && j.result && j.result.result;
    const sha = bytes ? createHash("sha256").update(Buffer.from(bytes).toString("utf8")).digest("hex") : "";
    if (sha === r.result_sha256) ok++;
    else { bad++; console.log(`${fx.file}: ${r.method} at block ${r.block_height}: ${bytes ? "different answer" : "no answer (" + JSON.stringify(j.error || {}).slice(0, 100) + ")"}`); }
  }
}
console.log(`pool reads matching the chain: ${ok}; not matching: ${bad}`);
process.exitCode = bad ? 1 : 0;
