import { Pool, type PoolClient } from "pg";
import { assertDistinctFromProduction, assertVerifyFull, hostFragment } from "./connection-identity";
import { loadEnvLocal } from "./env";

loadEnvLocal();

/**
 * Resolves and validates the connection string for the current environment
 * (`TEST_DATABASE_URL` under test, `DATABASE_URL` otherwise). Exported so a
 * caller that needs a connection of its own -- outside `pool` -- gets the
 * same validated string rather than re-deriving (and potentially
 * mis-deriving) which env var applies. See `lock.ts` for why that matters:
 * it opens a dedicated `Client` per call rather than borrowing from `pool`.
 */
export function resolveConnectionString(): string {
  const isTest = process.env.NODE_ENV === "test" || process.env.VITEST === "true";
  const variable = isTest ? "TEST_DATABASE_URL" : "DATABASE_URL";
  const value = process.env[variable]?.trim();

  if (!value) {
    // Never interpolate the value into the message: this string reaches logs.
    throw new Error(`${variable} is not set. See .env.example.`);
  }

  // Nothing in this repo passes an `ssl` option, so this substring is the only
  // thing standing between the app and an unencrypted connection to Neon.
  // Takes the returned string, not the input: a missing `sslmode` is corrected
  // here rather than refused, so a deploy never turns on a value nobody can read.
  const verified = assertVerifyFull(value, variable);

  if (isTest) {
    // connectionIdentity() is a cheap first line of defense, not a proof; the
    // real backstop is assertTestDatabaseMarker() below, which does not
    // depend on parsing anything.
    assertDistinctFromProduction(
      verified,
      "TEST_DATABASE_URL must not be the production database: the suite truncates it."
    );
  }

  return verified;
}

/**
 * Prints the `ep-…` host of the database this process just resolved, and
 * nothing else of the connection string.
 *
 * Every cron entry point calls it, and the reason is `loadEnvLocal()`: it fills
 * a variable that is *missing*, and only a missing one, so `unset DATABASE_URL`
 * does not make a script connect to nothing — it makes it connect to whatever
 * `.env.local` says, which is production. That is not hypothetical here; it
 * happened, and the run matched no rows by luck of the statement rather than by
 * anything about the method (see `env.ts`).
 *
 * A printed line is not a guard, and this does not pretend to be one: the guard
 * is `NODE_ENV=test` or an explicit `DATABASE_URL`. What it changes is that
 * "the requeue released nothing" and "the requeue released nothing *on
 * production*" stop looking identical in a terminal.
 *
 * It goes through `resolveConnectionString`, so it names the database the
 * process will actually use rather than re-deriving which variable applies —
 * the mis-derivation being exactly the failure it is reporting on.
 */
export function announceDatabaseTarget(): void {
  console.log(`Database target: ${hostFragment(resolveConnectionString())}`);
}

/**
 * `max: 1` on purpose (see `withTransaction`), which is also why the two
 * timeouts below are not optional: with one client, one call that never
 * returns is the whole process, the webhook included.
 *
 * **Both timeouts, because they defend different things.**
 *
 * `query_timeout` is a client-side timer in `pg`: it frees the *caller* after
 * 30 s and needs nothing from the server. It does not stop Neon executing the
 * statement it was already sent.
 *
 * `statement_timeout` is the server-side one, and it is the one that stops the
 * work. Getting it applied took three attempts, all measured against Neon on
 * 2026-08-31, because two of the obvious routes do not reach a pooled session:
 *
 * - as a `pg` pool option (a startup parameter): silently dropped —
 *   `SHOW statement_timeout` came back `0` and `pg_sleep(3)` ran to completion;
 * - in the connection string's `options=`: the pooler refuses to connect at
 *   all, answering `unsupported startup parameter in options`;
 * - as `ALTER ROLE neondb_owner SET statement_timeout`: applied, and visible
 *   on the **direct** endpoint (`SHOW` → `30s`) — but **not through the
 *   pooler**, where 24 fresh connections all read `0`.
 *
 * What does work through the pooler is an explicit `SET` on the session, which
 * is why it is issued here on every new connection: probed, `SET … '2s'` then
 * `pg_sleep(3)` is refused with *canceling statement due to statement timeout*.
 *
 * The `ALTER ROLE` default stays in place too — it is what covers the direct
 * endpoint, which is what migrations and the suite's advisory lock use. See
 * `operations.md`.
 *
 * 30 s because the slowest thing measured on any of these surfaces is the
 * KOL-detail read at 760 ms over four queries; 10 s to connect because Neon
 * scales to zero and a cold start is seconds, not milliseconds.
 */
export const STATEMENT_TIMEOUT_MS = 30_000;

export const pool = new Pool({
  connectionString: resolveConnectionString(),
  max: 1,
  query_timeout: 30_000,
  connectionTimeoutMillis: 10_000,
});

/**
 * Clients this process has already told about `statement_timeout`.
 *
 * **Not `pool.on("connect")`, and that cost a production incident.** `pg` does
 * not await an `on("connect")` listener, so a `client.query()` started there is
 * still in flight when the pool hands the client to a caller. The caller's own
 * query then arrives on a client that is already executing, which `pg` warns
 * about (*"Calling client.query() when the client is already executing a
 * query"*) and which killed a `parse-pending` run against production on
 * 2026-08-31 with *"Client has encountered a connection error and is not
 * queryable"* after 189 rows.
 *
 * Doing it on acquisition instead is awaited, so the ordering is guaranteed.
 * `max: 1` means this is one extra round trip per *connection*, not per query.
 *
 * A `WeakSet` because pooled clients are long-lived objects that the pool
 * reuses and eventually discards; nothing here should keep one alive.
 */
const timeoutSet = new WeakSet<object>();

async function withTimeoutSet<T>(run: (c: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    if (!timeoutSet.has(client)) {
      await client.query(`SET statement_timeout = ${STATEMENT_TIMEOUT_MS}`);
      timeoutSet.add(client);
    }
    return await run(client);
  } finally {
    client.release();
  }
}

// Neon scales to zero and can drop idle connections; without a handler that
// surfaces as an uncaught exception instead of a recoverable, logged event.
//
// The message is a constant. This was the one place in the repo that logged a
// caught error's `.message`, and a driver error's message can carry the host,
// the database and — for some failure shapes — the connection string that
// produced it. Everything else here logs a static string or a SQLSTATE code
// (see `assertTestDatabaseMarker`, which tells two failures apart on `.code`
// alone for exactly this reason).
pool.on("error", () => {
  console.error("Unexpected error on idle database client");
});

export async function query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  return withTimeoutSet(async (client) => {
    const result = await client.query(sql, params);
    return result.rows as T[];
  });
}

/**
 * The same shape as {@link query}, but bound to the single client holding an
 * open transaction.
 */
export type TxQuery = <T>(sql: string, params?: unknown[]) => Promise<T[]>;

/**
 * Runs `fn` inside one `BEGIN`/`COMMIT`, rolling back if it throws and
 * releasing the client either way.
 *
 * Needed the moment a derived table is rewritten from a source one: the
 * `position` rewrite and its `pnl_daily` rows describe the same replay, and a
 * crash between them leaves a position whose daily rows contradict it —
 * quietly, because both halves are individually well-formed.
 *
 * **Everything inside `fn` must go through the `tx` argument.** The module
 * pool is `max: 1`, so a stray call to the module-level {@link query} from
 * inside a transaction waits for a client that `fn` itself is holding and
 * hangs until the test times out. That is deliberate: the alternative failure
 * — a statement silently committing outside the transaction it looks like it
 * belongs to — is far harder to see. For the same reason, `withTransaction`
 * does not nest.
 */
export async function withTransaction<T>(fn: (tx: TxQuery) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  const tx: TxQuery = async <R>(sql: string, params: unknown[] = []) =>
    (await client.query(sql, params)).rows as R[];

  // A client whose ROLLBACK failed may still have an open transaction on it;
  // returning it to the pool would hand that state to the next caller.
  let broken = false;
  try {
    await client.query("BEGIN");
    const result = await fn(tx);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      broken = true;
    }
    // The caller's error, never the rollback's: the rollback failure says
    // nothing about why the work failed, and its message can carry
    // connection detail.
    throw error;
  } finally {
    client.release(broken ? new Error("rollback failed; discarding client") : undefined);
  }
}

/** Postgres's SQLSTATE for "the relation doesn't exist" -- see assertTestDatabaseMarker. */
const UNDEFINED_TABLE = "42P01";

/**
 * A sentinel that does not depend on parsing any connection string: a
 * database can only carry this marker if it was migrated with
 * `npm run db:migrate:test`, no matter how TEST_DATABASE_URL happens to be
 * spelled. `runQuery` is injectable so this can be unit-tested against a
 * fake without a second, deliberately unmarked database.
 *
 * Fails closed on any error -- but not with the same message for every one.
 * "The marker table is genuinely absent" (never migrated) and "the database
 * could not be reached at all" (a transient outage, a stale connection) are
 * different problems with different remedies, and conflating them sent a
 * reviewer chasing a migration that didn't need running when the real
 * problem was a dead connection. They are told apart on the driver
 * error's **`.code`** alone, never its `.message`: a `pg` error's `code` is
 * a fixed five-character SQLSTATE (`42P01`, undefined_table, is Postgres's
 * code for "no such relation") and cannot itself carry a hostname or any
 * other connection detail the way a message string can. `code` is read
 * defensively -- `runQuery` is injectable, so a caller's fake might throw
 * anything -- and its absence is treated the same as a connection problem,
 * which is the safer of the two given a code that can't be identified.
 */
export async function assertTestDatabaseMarker(
  runQuery: (sql: string, params?: unknown[]) => Promise<unknown[]> = query
): Promise<void> {
  let rows: unknown[];
  try {
    rows = await runQuery("SELECT stamped_at FROM test_database_marker LIMIT 1");
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error ? String((error as { code: unknown }).code) : null;

    if (code === UNDEFINED_TABLE) {
      throw new Error(
        "TEST_DATABASE_URL does not point at a stamped test database (test_database_marker is missing). " +
          "Run `npm run db:migrate:test` to stamp one. If this fires unexpectedly, TEST_DATABASE_URL is " +
          "pointing somewhere it should not."
      );
    }
    throw new Error(
      "Could not verify TEST_DATABASE_URL points at a stamped test database -- the query failed" +
        (code ? ` (driver error code ${code})` : "") +
        ". This looks like a connectivity problem, not a missing migration: check that the database is " +
        "reachable before running `npm run db:migrate:test`."
    );
  }
  if (rows.length === 0) {
    throw new Error(
      "TEST_DATABASE_URL does not point at a stamped test database (test_database_marker is missing). " +
        "Run `npm run db:migrate:test` to stamp one. If this fires unexpectedly, TEST_DATABASE_URL is " +
        "pointing somewhere it should not."
    );
  }
}
