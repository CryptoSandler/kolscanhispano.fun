import { Pool } from "pg";
import { assertDistinctFromProduction } from "./connection-identity";
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

  if (isTest) {
    // connectionIdentity() is a cheap first line of defense, not a proof; the
    // real backstop is assertTestDatabaseMarker() below, which does not
    // depend on parsing anything.
    assertDistinctFromProduction(
      value,
      "TEST_DATABASE_URL must not be the production database: the suite truncates it."
    );
  }

  return value;
}

export const pool = new Pool({ connectionString: resolveConnectionString(), max: 1 });

// Neon scales to zero and can drop idle connections; without a handler that
// surfaces as an uncaught exception instead of a recoverable, logged event.
// Never interpolate the connection string here.
pool.on("error", (err) => {
  console.error("Unexpected error on idle database client:", err.message);
});

export async function query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  const result = await pool.query(sql, params);
  return result.rows as T[];
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

/**
 * A sentinel that does not depend on parsing any connection string: a
 * database can only carry this marker if it was migrated with
 * `npm run db:migrate:test`, no matter how TEST_DATABASE_URL happens to be
 * spelled. `runQuery` is injectable so this can be unit-tested against a
 * fake without a second, deliberately unmarked database.
 *
 * Fails closed on any error, including a genuine connectivity problem:
 * rethrowing the original driver error risks leaking a connection-string
 * fragment (a hostname, for example) into the message.
 */
export async function assertTestDatabaseMarker(
  runQuery: (sql: string, params?: unknown[]) => Promise<unknown[]> = query
): Promise<void> {
  try {
    const rows = await runQuery("SELECT stamped_at FROM test_database_marker LIMIT 1");
    if (rows.length === 0) throw new Error("test_database_marker has no row");
  } catch {
    throw new Error(
      "TEST_DATABASE_URL does not point at a stamped test database (test_database_marker is missing). " +
        "Run `npm run db:migrate:test` to stamp one. If this fires unexpectedly, TEST_DATABASE_URL is " +
        "pointing somewhere it should not."
    );
  }
}
