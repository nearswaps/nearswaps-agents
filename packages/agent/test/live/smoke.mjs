// Live, read-only smoke test (CI runs it on every push; no key, nothing signed, nothing sent):
//   1. check_token wrap.near returns a score from 0 to 100 and a verdict from the fixed list;
//   2. list_new_launches returns at least one row;
//   3. get_quote near to usdc 1 returns a route and a min_out within 2% of the chain's own answer for the same route.
// The Terminal can't run in CI, so (3) compares with what the Terminal's maths stands for: Rhea's own get_return,
// asked hop by hop for each leg of the route at the same finality, right after the quote. Tolerance 2%: a few blocks
// pass between the two reads, and a busy pool moves in that time. Stable-pool hops are left to the Rhea quote too.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Kit, VERDICTS } from "../../dist/index.js";

const kit = new Kit();

test("check_token wrap.near: a score from 0 to 100 and a verdict from the fixed list", async () => {
  const t0 = Date.now();
  const c = await kit.checkToken("wrap.near");
  assert.ok(c.score >= 0 && c.score <= 100, "score " + c.score);
  assert.ok(VERDICTS.includes(c.verdict), "verdict " + c.verdict);
  assert.ok(Array.isArray(c.findings) && c.findings.length > 0);
  console.log(`  score ${c.score}, ${c.verdict}, ${c.findings.length} findings, ${Date.now() - t0} ms`);
});

test("list_new_launches: at least one row", async () => {
  const r = await kit.listNewLaunches({ limit: 20 });
  assert.ok(r.launches.length >= 1, "launches: " + JSON.stringify(r.sources));
  for (const l of r.launches) assert.ok(l.id && l.pad && l.created >= 0);
  console.log(`  ${r.launches.length} launches, newest ${r.launches[0].id} (${r.launches[0].pad})`);
});

test("get_quote near usdc 1: a route, and a min_out within 2% of Rhea's own answer for that route", async () => {
  const q = await kit.getQuote("near", "usdc", "1");
  assert.ok(q.route.length >= 1 && q.route.length <= 3);
  const sum = q.route.reduce((s, l) => s + BigInt(l.amount_in), 0n);
  assert.equal(sum.toString(), q.raw.amount_in, "the legs add up to the amount");
  let chain = 0n;
  for (const leg of q.route) {
    let x = BigInt(leg.amount_in);
    for (const h of leg.hops) x = BigInt(await kit.views.getReturn(h.pool_id, h.token_in, x.toString(), h.token_out));
    chain += x;
  }
  const out = BigInt(q.raw.out), min = BigInt(q.raw.min_out);
  const diff = Number(out > chain ? out - chain : chain - out) / Number(chain);
  assert.ok(diff <= 0.02, `quote ${out} vs chain ${chain}: ${(diff * 100).toFixed(3)}%`);
  const chainMin = (chain * 9500n) / 10000n;
  const minDiff = Number(min > chainMin ? min - chainMin : chainMin - min) / Number(chainMin);
  assert.ok(minDiff <= 0.02, `min_out ${min} vs ${chainMin}`);
  console.log(`  ${q.amount_out}, minimum ${q.min_out}, ${q.route.length} legs; chain says ${chain} raw (${(diff * 100).toFixed(4)}% apart)`);
});
