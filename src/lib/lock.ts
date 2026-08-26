import { createHash } from "node:crypto";
import { pool } from "./db";

/**
 * Hashes `name` to a signed 64-bit integer, returned as a decimal string so
 * it can be bound as a query parameter with no precision loss -- a JS
 * `number` cannot represent the full bigint range that
 * `pg_try_advisory_xact_lock(bigint)` accepts.
 *
 * Exported only so the test suite can make a second, independent connection
 * contend for the same key without duplicating the hash.
 */
export function lockKey(name: string): string {
  const digest = createHash("sha256").update(name, "utf8").digest();
  return digest.readBigInt64BE(0).toString();
}

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
 * **Transaction-scoped, not session-scoped, and that is load-bearing here.**
 * Both `DATABASE_URL` and `TEST_DATABASE_URL` point at Neon's pooled
 * (`-pooler`) endpoint, which multiplexes client connections over Postgres
 * backends in PgBouncer transaction-pooling mode: outside an explicit
 * transaction, two statements sent one after another on what looks like the
 * same client connection can land on two different backends. A session-level
 * `pg_try_advisory_lock` acquired in one statement is then not reliably the
 * same session that later calls `pg_advisory_unlock`, or that a rival's
 * `pg_try_advisory_lock` is checked against. Wrapping the whole call in one
 * `BEGIN` / `COMMIT`/`ROLLBACK` keeps one backend pinned for its entire
 * duration, and `pg_try_advisory_xact_lock` releases automatically at the
 * matching `COMMIT` or `ROLLBACK` -- including the one Postgres performs on
 * its own when a backend's connection drops, so a killed runner still
 * releases the lock with no unlock call needed.
 */
export async function withLock<T>(name: string, fn: () => Promise<T>): Promise<T | null> {
  const key = lockKey(name);
  const client = await pool.connect();

  // A client whose ROLLBACK failed may still have an open transaction on it;
  // returning it to the pool would hand that state to the next caller (see
  // the same guard in withTransaction, db.ts).
  let broken = false;
  try {
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
      try {
        await client.query("ROLLBACK");
      } catch {
        broken = true;
      }
      throw error;
    }
  } finally {
    client.release(broken ? new Error("rollback failed; discarding client") : undefined);
  }
}
