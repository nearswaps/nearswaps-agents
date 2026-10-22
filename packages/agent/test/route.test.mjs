// The route port against ten cases recorded read-only from the live Terminal (nearswaps.com/terminal, the 1-click
// panel's own window.nekoSwap.oneClickRoute / oneClickIntear) on 22 Oct 2026. Each fixture holds the inputs, the
// contract config, the pool state the panel read (block heights and SHA-256 of each answer in pool_reads; checked
// against the chain with test/check-fixtures.mjs) and the panel's route and min_out. The port must give the same
// route legs, the same output to the last unit, and the same min_out at 5% and at auto slippage.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Market, quote, autoSlip, minOutFor, PoolSource, Rpc, Views } from "../dist/index.js";
import { routeFixtures, fixture, fakeNet } from "./helpers.mjs";

const POOL_LIST = fixture("swap-pools.json");

function worldFor(fx) {
  const kinds = fx.pool_kinds || {};
  const views = {
    "v2.ref-finance.near.get_pool_by_ids": ({ pool_ids }) => pool_ids.map((id) => (kinds[id] === "SIMPLE_POOL" ? fx.pools[id] : null)),
    "v2.ref-finance.near.get_stable_pool": ({ pool_id }) => { if (kinds[pool_id] !== "STABLE_SWAP") throw new Error("not in the fixture"); return fx.pools[pool_id]; },
  };
  const router = (fx.calls || []).find((c) => c.kind === "http");
  const http = [["https://nearswaps.com/assets/swap-pools.json", POOL_LIST]];
  if (router) http.push(["https://router.intear.tech/route", (url) => {
    // The same question the panel asked (parameters in any order).
    const want = new URL(router.url).searchParams, got = new URL(url).searchParams;
    for (const [k, v] of want) assert.equal(got.get(k), v, `router parameter ${k}`);
    return router.body;
  }]);
  const sims = (fx.calls || []).filter((c) => c.kind === "view" && c.method_name === "simulate_swap_simple");
  if (sims.length) views["dex.intear.near.simulate_swap_simple"] = sims[0].result;
  return fakeNet({ views, http });
}

for (const fx of routeFixtures()) {
  test(`route ${fx.file}: ${fx.label} (recorded ${fx.recorded_at})`, async () => {
    const net = worldFor(fx);
    const rpc = new Rpc({ fetch: net.fetch });
    const views = new Views(rpc);
    const cfg = { ...fx.config, registered_total: fx.config.registered.length };
    const market = new Market(cfg);
    const { token_in: tIn, token_out: tOut, amount_in, venue } = fx.inputs;
    const raw = BigInt(amount_in);
    const q = await quote({ rpc, fetch: net.fetch, pools: new PoolSource(views, net.fetch) }, market, tIn, tOut, raw, venue);
    assert.ok(q, "the port finds a route");
    const p = fx.panel;
    assert.equal(q.out.toString(), p.out, "same output as the panel");
    const sentVenue = JSON.parse(JSON.stringify(q.venue));
    if (sentVenue.Intear && sentVenue.Intear.then && q.mid != null) sentVenue.Intear.then.min_mid = minOutFor(q.mid, 500).toString();
    assert.deepEqual(sentVenue, p.venue, "same venue and route legs as the panel");
    if (venue === "rhea") assert.equal(q.impactBps, p.impact_bps, "same price impact");
    assert.equal(minOutFor(q.floor, 500).toString(), p.min_out_500, "same min_out at the kit's default 5%");
    const auto = autoSlip(q, tIn === "wrap.near" ? raw : q.out, fx.config.token_open === true);
    assert.equal(auto, p.auto_slip_bps, "same auto slippage");
    assert.equal(minOutFor(q.floor, auto).toString(), p.min_out_auto, "same min_out at auto slippage");
  });
}

test("ten recorded cases: seven Rhea (one through the stable pool), three Intear DEX", () => {
  const all = routeFixtures();
  assert.equal(all.length, 10);
  assert.equal(all.filter((f) => f.inputs.venue === "rhea").length, 7);
  assert.ok(all.some((f) => Object.values(f.pool_kinds || {}).includes("STABLE_SWAP") && JSON.stringify(f.panel.venue).includes('"pool_id":1910')), "a route through stable pool 1910");
  assert.ok(all.some((f) => (f.panel.venue.Rhea?.route.length || 0) === 3), "a three-leg split");
  for (const f of all) assert.ok(Date.parse(f.recorded_at) > 0 && f.source.includes("nearswaps.com/terminal"));
});
