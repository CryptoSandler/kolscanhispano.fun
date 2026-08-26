import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

/**
 * Runs the contract checks the unit suite excludes (see vitest.config.mts) —
 * tests that make one real call to a third party to verify an assumption
 * about its response shape still holds, rather than pinning a fixture.
 *
 * Deliberately not part of `npm test`: that command is the blocking gate
 * every task in this plan must pass to ship, and a check that can fail
 * because a third party is slow or down has different failure semantics
 * than a regression suite and should not share its gate.
 *
 * Shares `setupFiles`/`globalSetup` with the unit config on purpose: the
 * network guard installed by vitest.env.ts still applies here. A contract
 * test reaches the network through the guard's named escape hatch
 * (`realFetch` from src/lib/network-guard.ts), not because this config
 * leaves the guard out.
 */
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: {
    environment: "node",
    include: ["src/**/*.contract.test.ts", "scripts/**/*.contract.test.ts"],
    setupFiles: ["./vitest.env.ts"],
    globalSetup: ["./vitest.globalSetup.ts"],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
