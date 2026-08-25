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

/** Fixed window. Returns true when the caller has exceeded `limit` in the window. */
export async function hitLimit(
  ip: string,
  bucket: string,
  limit: number,
  windowSeconds: number,
): Promise<boolean> {
  const rows = await query<{ hits: number }>(
    `INSERT INTO rate_limit (ip_hash, bucket, window_start, hits)
     VALUES ($1, $2, to_timestamp(floor(extract(epoch FROM now()) / $3) * $3), 1)
     ON CONFLICT (ip_hash, bucket, window_start)
       DO UPDATE SET hits = rate_limit.hits + 1
     RETURNING hits`,
    [ipHash(ip), bucket, windowSeconds],
  );
  return rows[0].hits > limit;
}
