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
 *
 * ## The host is `localhost`, and it is load-bearing
 *
 * It used to be `127.0.0.1`, and **that silently ran every spec with no client
 * JavaScript at all.** Next 16 "blocks cross-origin requests to dev-only assets
 * and endpoints during development by default", where the allowed origin is
 * *"the hostname the server was initialized with (`localhost` by default)"*
 * (`node_modules/next/dist/docs/.../allowedDevOrigins.md`). `127.0.0.1` is a
 * different origin from `localhost` by that rule, so every request for
 * `/_next/static/chunks/*` came back `403`, nothing hydrated, and no event
 * handler on the page was ever attached.
 *
 * It went unnoticed because the only spec here measured server-rendered layout,
 * which is identical with the bundle blocked. The moment a spec needed a click
 * to do something — `modal-kol.spec.ts` — all twelve of its cases failed on a
 * dialog that never opened.
 *
 * The fix is the harness, not `next.config.ts`: `allowedDevOrigins` would widen
 * what the dev server accepts to make a test speak to it wrongly, where asking
 * on the origin the server actually serves costs one word.
 */
const HOST = "localhost";

const PORT = Number(process.env.E2E_PORT ?? 3210);

export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/global-setup.ts",
  globalTeardown: "./e2e/global-teardown.ts",
  // One worker: the tests share one seeded database.
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: `http://${HOST}:${PORT}`,
    ...devices["Desktop Chrome"],
  },
  projects: [{ name: "chromium" }],
  webServer: {
    command: `npm run dev -- --port ${PORT}`,
    url: `http://${HOST}:${PORT}/leaderboard`,
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
