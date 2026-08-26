import { Client } from "pg";
import { resolveConnectionString } from "./db";

// Re-exported so `lockKey` stays importable from "./lock" -- the test suite
// makes a second, independent connection contend for the same key, and
// `vitest.globalSetup.ts` imports it from `./src/lib/lock-key` directly (see
// the note there for why that module exists at all).
export { lockKey } from "./lock-key";
import { lockKey } from "./lock-key";

/**
 * Runs `fn` while holding a Postgres advisory lock named `name`, so that two
 * processes racing to do the same work -- a scheduled cron run and a manual
 * dispatch, for example -- cannot both proceed. Returns `null` without
 * calling `fn` when another session already holds the lock; otherwise runs
 * `fn` and returns its result.
 *
 * This is deliberately not a table row: it needs no migration, and it cannot
 * leave stale state behind if a runner is killed -- Postgres drops the lock
 * the moment the holding connection closes, no cleanup query required.
 *
 * **A dedicated connection, not the shared pool -- on purpose, and do not
 * "simplify" this back to `pool.connect()`.** The module pool in `db.ts` is
 * `max: 1`. An earlier version of this function borrowed that pool's one
 * client and held it for the whole call. Since the intended caller is
 * exactly `withLock(name, () => someQueryHeavyJob())` -- Task 2's cron
 * scripts are nothing but queries -- any query `fn` made through the shared
 * `pool`/`query` would wait for the very connection this call was holding,
 * and hang forever rather than fail. Confirmed directly:
 * `withLock("x", () => query("SELECT 1"))` timed out instead of completing.
 * A lock that can silently deadlock the work it's supposed to guard is worse
 * than not having one, so `withLock` opens its own `Client`, wholly separate
 * from `pool`, and closes it when done -- `fn` is then free to use the
 * shared pool normally. One extra connection per call is the cost, against
 * a pooled endpoint that exists for exactly that.
 *
 * **Transaction-scoped, not session-scoped, and that is load-bearing too.**
 * Both `DATABASE_URL` and `TEST_DATABASE_URL` point at Neon's pooled
 * (`-pooler`) endpoint, which multiplexes client connections over Postgres
 * backends in PgBouncer transaction-pooling mode: outside an explicit
 * transaction, two statements sent one after another on what looks like the
 * same client connection can land on two different backends. A session-level
 * `pg_try_advisory_lock` acquired in one statement is then not reliably the
 * same session that later calls `pg_advisory_unlock`, or that a rival's
 * `pg_try_advisory_lock` is checked against -- confirmed directly: a second
 * client could acquire a lock the first client still held. Wrapping the
 * whole call in one `BEGIN` / `COMMIT`/`ROLLBACK` keeps one backend pinned
 * for its entire duration, and `pg_try_advisory_xact_lock` releases
 * automatically at the matching `COMMIT` or `ROLLBACK` -- including the one
 * Postgres performs on its own when a backend's connection drops, so a
 * killed runner still releases the lock with no unlock call needed.
 */
export async function withLock<T>(name: string, fn: () => Promise<T>): Promise<T | null> {
  const key = lockKey(name);
  const client = new Client({ connectionString: resolveConnectionString() });
  // Neon scales to zero and can drop a connection mid-call. pg surfaces that
  // as an EventEmitter "error", which with no listener is an uncaught
  // exception no try/catch in this function could contain. Mirrors the pool's
  // handler in db.ts. Never log the error: it can carry connection detail.
  client.on("error", () => {});

  try {
    // connect() is inside the try so that a connection that fails *during*
    // startup -- TLS negotiated, auth rejected -- is still closed by the
    // finally below. Left outside, that path returned without ever calling
    // end(), leaking the socket for the OS to reap.
    await client.connect();
    await client.query("BEGIN");
    const { rows } = await client.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_xact_lock($1::bigint) AS locked",
      [key],
    );
    if (!rows[0].locked) {
      await client.query("ROLLBACK");
      return null;
    }

    try {
      const result = await fn();
      await client.query("COMMIT");
      return result;
    } catch (error) {
      // The caller's error, never the rollback's: it says nothing about why
      // the work failed and could carry connection detail. There is no pool
      // here to poison if the rollback itself fails (unlike withTransaction
      // in db.ts) -- this connection is closed below either way.
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    }
  } finally {
    // Closing must not mask the caller's error, and must not skip closing
    // when the connection is already unhealthy. An `await client.end()` that
    // rejects here replaced whatever the try block threw -- so a job that
    // failed for its own reasons surfaced as a connection error instead --
    // and left this connection attached to a PgBouncer backend, where an
    // interrupted call shows up as "idle in transaction" until the server
    // times it out. Releasing the advisory lock is not enough on its own:
    // the lock goes at ROLLBACK, the backend goes only when this closes.
    await client.end().catch(() => {});
  }
}
