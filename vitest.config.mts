import { configDefaults, defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "scripts/**/*.test.ts"],
    // Contract checks (real third-party calls, e.g. prices.contract.test.ts)
    // run separately via `npm run test:contract` — see vitest.contract.config.mts.
    // `npm test` is the blocking gate every task must pass to ship, and a
    // check that can fail because a third party is slow or down does not
    // belong on it.
    exclude: [...configDefaults.exclude, "**/*.contract.test.ts"],
    setupFiles: ["./vitest.env.ts"],
    // Holds a run-scoped advisory lock so a second suite queues behind this
    // one instead of truncating its fixtures mid-run. See the file itself.
    globalSetup: ["./vitest.globalSetup.ts"],
    // Tests share one database and truncate between cases, so they cannot run
    // in parallel against each other.
    fileParallelism: false,
    // Every query is a network round-trip to Neon; the local default is far too tight.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
