import { createHmac } from "node:crypto";
import { query } from "./db";

/**
 * Client IPs are personal data we have no use for. We keep a keyed hash, which
 * is enough to count and not enough to identify. The key is the HMAC key
 * already loaded for the blind index.
 */
export function ipHash(ip: string): Buffer {
  const key = Buffer.from(process.env.WALLET_HMAC_KEY ?? "", "base64");
  if (key.length !== 32) throw new Error("WALLET_HMAC_KEY must be 32 bytes, base64-encoded");
  return createHmac("sha256", key).update(`ip:${ip}`, "utf8").digest();
}

/**
 * Fixed window. Returns true when the caller has exceeded `limit` in the
 * window.
 *
 * The window is floored from Postgres's clock, not the application's:
 * `now()` is transaction start time on the server, so every app process
 * agrees which window a request belongs to no matter how their own clocks
 * drift. `atEpochSeconds` overrides *that instant and nothing else* -- the
 * flooring, the conflict target and the increment are untouched, so a call
 * that supplies one exercises exactly the code path a call that omits one
 * does. Omitting it produces the original statement verbatim, server clock
 * included.
 *
 * It exists for the tests, and deliberately not as a module-level mutable
 * clock or a `vi.setSystemTime`: this clock lives in Postgres, so a JS fake
 * would not move it and a test that appeared to pass against one would be
 * pinning nothing. Passing the instant through the query is the only form of
 * injection that reaches the thing under test. Production callers pass
 * nothing.
 */
export async function hitLimit(
  ip: string,
  bucket: string,
  limit: number,
  windowSeconds: number,
  atEpochSeconds?: number,
): Promise<boolean> {
  // Cast to numeric, which is what `extract(epoch FROM now())` itself returns
  // (Postgres 14+), so the division, the floor and the multiplication are the
  // same arithmetic on both paths rather than float arithmetic on one of them.
  const epoch = atEpochSeconds === undefined ? "extract(epoch FROM now())" : "$4::numeric";
  const params: unknown[] = [ipHash(ip), bucket, windowSeconds];
  if (atEpochSeconds !== undefined) params.push(atEpochSeconds);

  const rows = await query<{ hits: number }>(
    `INSERT INTO rate_limit (ip_hash, bucket, window_start, hits)
     VALUES ($1, $2, to_timestamp(floor(${epoch} / $3) * $3), 1)
     ON CONFLICT (ip_hash, bucket, window_start)
       DO UPDATE SET hits = rate_limit.hits + 1
     RETURNING hits`,
    params,
  );
  return rows[0].hits > limit;
}
