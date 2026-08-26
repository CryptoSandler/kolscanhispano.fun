/**
 * A contract check, not a regression test — deliberately outside `npm test`.
 *
 * Every other test in `prices.test.ts` runs on a fixture and pins *this
 * codebase's* parsing of a frozen response shape; it would keep passing even
 * if DexScreener quietly changed a field name or a number format tomorrow.
 * This test is the only thing in the suite that would notice — it makes one
 * real call and asserts on the shape of what comes back, not a pinned value.
 *
 * It is split out of `prices.test.ts` (and excluded from the unit `include`
 * in vitest.config.mts) because `npm test` is the blocking gate every task in
 * this plan must pass to ship. A contract check and a regression suite have
 * different failure semantics — this one can fail because DexScreener is
 * slow or down, for reasons that have nothing to do with the code under
 * test — and they should not share a gate. Run it explicitly with
 * `npm run test:contract`.
 *
 * It runs under `vitest.contract.config.mts`, which reuses the same
 * `setupFiles`/`globalSetup` as the unit suite, so the network guard from
 * `vitest.env.ts` is installed here too. The call below goes through
 * `realFetch` (network-guard.ts's named escape hatch) rather than the
 * ambient `fetch`, exactly as it did before the split — the guard still
 * applies to this file; the live call is explicitly opted into, not run
 * because this file happens to be ungoverned.
 *
 * **Open item:** nothing currently schedules this. It runs when a human (or
 * CI job not yet written) types `npm run test:contract`. Until such a
 * schedule exists, treat this as coverage that exists but is not
 * continuously exercised — write that down rather than imply otherwise.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { query } from "./db";
import { realFetch } from "./network-guard";
import { refreshSolPrice, solUsdAt } from "./prices";

beforeEach(async () => {
  await query("TRUNCATE token, sol_price CASCADE");
});

describe("refreshSolPrice (contract)", () => {
  it("resolves a real SOL/USD rate from the live DexScreener API", async () => {
    const wrote = await refreshSolPrice(realFetch, new Date());
    expect(wrote).toBe(true);
    const usd = await solUsdAt(new Date());
    expect(usd).not.toBeNull();
    // Sanity bounds, not a pinned value: SOL has traded well within this
    // range for years, and the point is only to prove a real number came
    // back, not to assert what it currently is.
    const asNumber = Number(usd) / 1e18;
    expect(asNumber).toBeGreaterThan(1);
    expect(asNumber).toBeLessThan(100_000);
  }, 15_000);
});
