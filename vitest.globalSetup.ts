import { Client } from "pg";
import { loadEnvLocal } from "./src/lib/env";
import { lockKey } from "./src/lib/lock-key";

/**
 * Serializes whole suite runs against the shared test database.
 *
 * Every test file in this repo truncates tables the next one also uses (see
 * `fileParallelism` in vitest.config.ts), so two suites running at once
 * delete each other's fixtures mid-assertion. That is not hypothetical: with
 * several Claude Code sessions open on this repo it happened, and the losing
 * run sat for 28 minutes of wall clock against 270s of actual test time.
 * This makes the second run *wait* instead of interleaving.
 *
 * `withLock` in src/lib/lock.ts is deliberately not reused here. It is
 * transaction-scoped and non-blocking by design -- it returns `null` and
 * skips the work when someone else holds the lock, which is right for a cron
 * job and exactly wrong for a suite run, which must queue rather than be
 * silently skipped. It also holds its lock inside an open transaction, which
 * would pin a PgBouncer backend as "idle in transaction" for the entire run.
 *
 * ponytail: a local file lock (flock, proper-lockfile) would be fewer lines
 * and serialize the sessions on this machine. It is a database lock instead
 * because the resource being protected is the database, not this laptop -- a
 * run from CI or a second machine would walk straight past a file lock.
 */
const RUN_LOCK_NAME = "kolscanhispano:test-suite";

/**
 * How long to queue behind another run before giving up. A full suite is
 * ~7 minutes, so this leaves room for two ahead of us and then fails with a
 * real message rather than hanging until someone notices.
 */
const WAIT_TIMEOUT_MS = 20 * 60 * 1000;

/**
 * The `-pooler` host multiplexes over PgBouncer in transaction-pooling mode,
 * where a *session*-level `pg_advisory_lock` is not reliably held by the same
 * backend that later statements land on -- lock.ts documents this failure in
 * detail. A run-scoped lock has to outlive every transaction in the run, so
 * it needs a real dedicated backend: Neon serves that on the same endpoint
 * with `-pooler` dropped from the host.
 */
function directEndpoint(url: string): string {
  const parsed = new URL(url);
  parsed.host = parsed.host.replace("-pooler.", ".");
  return parsed.toString();
}

let client: Client | undefined;

export async function setup(): Promise<void> {
  loadEnvLocal();
  const url = process.env.TEST_DATABASE_URL?.trim();
  // Never interpolate the value into the message: this string reaches logs.
  if (!url) throw new Error("TEST_DATABASE_URL is not set. See .env.example.");

  client = new Client({ connectionString: directEndpoint(url) });
  // Without a listener a dropped connection is an uncaught exception rather
  // than a rejected query. Mirrors the pool's handler in db.ts.
  client.on("error", () => {});
  await client.connect();

  const key = lockKey(RUN_LOCK_NAME);
  const { rows } = await client.query<{ got: boolean }>(
    "SELECT pg_try_advisory_lock($1::bigint) AS got",
    [key],
  );
  if (rows[0].got) return;

  const startedAt = Date.now();
  console.log("Another run of this suite holds the test database. Waiting for it to finish...");
  // lock_timeout applies to advisory-lock waits, so a stuck holder surfaces
  // as an error with a name attached instead of an indefinite hang.
  await client.query(`SET lock_timeout = ${WAIT_TIMEOUT_MS}`);
  try {
    await client.query("SELECT pg_advisory_lock($1::bigint)", [key]);
  } catch (error) {
    await client.end().catch(() => {});
    client = undefined;
    throw new Error(
      `Gave up after ${Math.round(WAIT_TIMEOUT_MS / 60_000)} minutes waiting for another run of this ` +
        `suite to release the test database. Check for a stray 'vitest run' before retrying. ` +
        `(${error instanceof Error ? error.message : String(error)})`,
    );
  }
  console.log(`Waited ${Math.round((Date.now() - startedAt) / 1000)}s for the test database.`);
}

export async function teardown(): Promise<void> {
  // Closing the connection releases the session lock; no unlock call needed,
  // which is also what frees it when a run is killed rather than exiting.
  await client?.end().catch(() => {});
  client = undefined;
}
