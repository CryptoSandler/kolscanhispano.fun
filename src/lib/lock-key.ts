import { createHash } from "node:crypto";

/**
 * Hashes `name` to a signed 64-bit integer, returned as a decimal string so
 * it can be bound as a query parameter with no precision loss -- a JS
 * `number` cannot represent the full bigint range that
 * `pg_try_advisory_xact_lock(bigint)` accepts.
 *
 * Its own module, separate from `lock.ts`, for one reason: `vitest.globalSetup.ts`
 * needs this key and nothing else. Importing it from `lock.ts` would pull in
 * `db.ts`, which builds the module `Pool` at import time -- inside Vitest's
 * *main* process, where `VITEST` is not `"true"`, so `resolveConnectionString()`
 * would resolve `DATABASE_URL` and point that pool at production. It would
 * never connect, but a production pool constructed by the test harness is not
 * a thing to leave lying around.
 */
export function lockKey(name: string): string {
  const digest = createHash("sha256").update(name, "utf8").digest();
  return digest.readBigInt64BE(0).toString();
}
