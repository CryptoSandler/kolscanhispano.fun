import { existsSync, readFileSync } from "node:fs";

/**
 * Loaded from a file rather than the shell so a connection string (or a key)
 * never has to be typed on a command line, where it would land in shell history.
 *
 * **It fills a variable that is missing, and only a missing one** -- the
 * `!process.env[name]` below. So an env var you set wins, and an env var you
 * *unset* does not become absent: it becomes whatever `.env.local` says,
 * which for `DATABASE_URL` is production. Every script in this repo calls
 * this at import, so `unset DATABASE_URL` before running one by hand points
 * it at production rather than at nothing. (Measured 2026-08-26: a
 * one-off run of the requeue with `DATABASE_URL` unset connected to the
 * production branch. It matched no rows and wrote nothing, which was luck of
 * the statement, not of the method.)
 *
 * To run a script against the test branch, set `NODE_ENV=test` -- `db.ts`'s
 * `resolveConnectionString` then reads `TEST_DATABASE_URL` on purpose, which
 * is what every `scripts/*.test.ts` subprocess case does -- or set
 * `DATABASE_URL` explicitly to the branch you mean. Never by unsetting.
 */
export function loadEnvLocal(): void {
  if (!existsSync(".env.local")) return;
  for (const line of readFileSync(".env.local", "utf8").split("\n")) {
    const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].trim();
  }
}
