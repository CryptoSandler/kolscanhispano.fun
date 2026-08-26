import { defineConfig, devices } from "@playwright/test";
import { loadEnvLocal } from "./src/lib/env";

// The connection strings live in `.env.local`, never on a command line.
loadEnvLocal();

/**
 * The viewport guard, and nothing else yet.
 *
 * **Not part of `npm test`.** The unit suite already runs over seven minutes
 * against a remote Postgres; a browser launch on top of that would make the
 * gate slower than it is useful. `npm run test:e2e` is its own command.
 *
 * The app is started against `TEST_DATABASE_URL`, not `DATABASE_URL`:
 * `global-setup.ts` truncates before it seeds, and that must never be pointed
 * at a developer's working database, let alone a real one. `loadEnvLocal` only
 * sets variables that are not already set, so this assignment wins inside the
 * server process.
 *
 * `next dev` rather than a production build, because the assertion is about
 * layout and the CSS is identical either way — and a build would add a minute
 * to a command whose whole point is that it is quick to run.
 */
const PORT = Number(process.env.E2E_PORT ?? 3210);

export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/global-setup.ts",
  // One worker: the tests share one seeded database.
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    ...devices["Desktop Chrome"],
  },
  projects: [{ name: "chromium" }],
  webServer: {
    command: `npm run dev -- --port ${PORT}`,
    url: `http://127.0.0.1:${PORT}/leaderboard`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? "",
      // Turbopack's first compile of a route is slow enough to matter against
      // the 120s budget above; the leaderboard is the one the guard needs.
      NEXT_TELEMETRY_DISABLED: "1",
    },
  },
});
