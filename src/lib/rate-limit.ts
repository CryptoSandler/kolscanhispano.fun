import { blindIndex } from "./crypto";
import { query } from "./db";

/**
 * Client IPs are personal data we have no use for. We keep a keyed hash, which
 * is enough to count and not enough to identify.
 *
 * Through `crypto.ts`, not around it. This function used to read
 * `WALLET_HMAC_KEY` straight out of `process.env` and build its own HMAC, which
 * meant it was the one keyed digest in the repo that skipped `crypto.ts`'s
 * check that the two keys differ -- so an operator who pasted the same value
 * into both variables got a hard failure everywhere except here, where the
 * counting quietly carried on under a key the ciphertext key could reproduce.
 *
 * The digest is byte-identical to what it was: the old body hashed `ip:${ip}`
 * under `WALLET_HMAC_KEY`, and that is exactly what `blindIndex(ip, "ip")`
 * computes. No `rate_limit` row is orphaned by this change, which is why it
 * needs no migration -- pinned by the test below it.
 */
export function ipHash(ip: string): Buffer {
  return blindIndex(ip, "ip");
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

/**
 * The client's address, from the one header a request can be trusted to carry
 * it in.
 *
 * The **first** hop of `x-forwarded-for`, because everything after it is a
 * proxy the caller named and a caller can name anything. `x-real-ip` is the
 * fallback a self-hosted deploy behind nginx would supply.
 *
 * Whether the first hop is the *client* depends on the platform overwriting the
 * header rather than passing the caller's through, and **that has not been
 * measured here** — measuring it needs a request answered by Vercel's edge, and
 * the security batch this belongs to touches neither production nor preview.
 * An earlier version of this comment asserted it. So: this is a counter, and it
 * is a good one against accidental load and a poor one against a caller who
 * varies the header on purpose. The control that does not depend on the guess
 * is a platform rule — Vercel's own firewall rate limiting — which is what
 * `src/proxy.ts` says it would be replaced by.
 *
 * When neither is present the caller is counted as `"unknown"`, which is one
 * shared bucket. That is deliberately the *conservative* reading and it is
 * only reachable off Vercel: locally, in `next dev` and under Playwright,
 * every request is the same person anyway. Extracted from the webhook route,
 * which had this expression inline, so the five public surfaces cannot drift
 * apart on what "the caller" means.
 */
export function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0].trim();
  if (forwarded) return forwarded;
  return request.headers.get("x-real-ip")?.trim() || "unknown";
}

/** One minute, for every public bucket. See {@link PUBLIC_LIMITS}. */
export const PUBLIC_WINDOW_SECONDS = 60;

/**
 * What one caller may ask of each public surface per minute.
 *
 * The audit of `20040c7` found no limit at all on any of them, and measured
 * what 60 unauthenticated GETs cost: `/api/feed` 23.0 s, `/api/leaderboard`
 * 11.6 s, `/api/kol/<slug>?window=diario` 45.5 s — about 760 ms and four Neon
 * queries each. `next.config.ts` marks `/api/*` `no-store`, so no cache
 * absorbs any of it, and `db.ts`'s pool is `max: 1`. One laptop saturates it.
 *
 * **Four different numbers, because the per-request cost differs by an order
 * of magnitude and so does what a real reader does.** One number for all of
 * them would be too loose for `/api/kol` or too tight for the feed.
 *
 * - **`feed` — 240.** `FeedLive` polls every four seconds: 15 requests a
 *   minute per open tab, and a quiet poll is a `304` off a two-row validator
 *   probe rather than the 383 ms full read. 240 is sixteen tabs' worth, which
 *   also covers a household or a small office behind one NAT address.
 * - **`leaderboard` — 120.** Not polled. One request per navigation plus one
 *   per toggle, and there are only six window/unit combinations to click
 *   through. 120 is far past anything a person does and still half the feed's,
 *   because nothing here is on a timer.
 * - **`kol-detail` — 60.** The expensive one: 760 ms and four queries. A modal
 *   open costs one, and switching all three windows inside it costs three
 *   more. 60 is a modal opened every four seconds for a solid minute.
 * - **`avatar` — 600.** Deliberately the loosest, because in production the
 *   CDN answers almost all of it and the limiter only ever sees a cache
 *   *miss* (see the route: it now refuses a query string, so an attacker
 *   cannot mint fresh cache keys). What a real cold visitor spends is one
 *   request per distinct KOL on screen — up to about sixty on a full feed plus
 *   ranking — and a second visitor behind the same address spends the same
 *   again until the edge is warm. 600 still bounds the outbound `unavatar.io`
 *   fetches this route can be made to issue to ten a second.
 * - **`page` — 120.** `/` and `/leaderboard`, both `force-dynamic`, each one
 *   feed read plus one leaderboard read. Navigation and prefetch both land
 *   here, so it is twice the leaderboard route's and it is not a number a
 *   reader reaches by reading.
 *
 * All five are per address per minute, so a shared exit address is the case
 * they are sized for rather than the case they are tuned against.
 */
export const PUBLIC_LIMITS = {
  feed: 240,
  leaderboard: 120,
  "kol-detail": 60,
  avatar: 600,
  page: 120,
  /**
   * `/registro`'s three endpoints, and the tightest numbers here by a wide
   * margin, because these are the only public surfaces that **write**.
   *
   * - **`registro-nonce` — 20.** A nonce per wallet, and nobody connects twenty
   *   wallets a minute. It is a row in `wallet_proof_nonce` per call, so the
   *   limit is also what bounds that table between prunes.
   * - **`registro` — 6.** The submit. It verifies a signature per wallet —
   *   curve arithmetic, which is the one CPU-bound thing this app does — and
   *   writes a KOL. Six is a person retrying a failed submit five times.
   * - **`registro-tweet` — 10.** Each call makes an outbound request to
   *   `publish.twitter.com`, so this is the number that bounds what this app
   *   can be made to send *somebody else*. Ten a minute per address is a person
   *   pasting a link and fixing it, and nothing like a useful amplifier.
   */
  "registro-nonce": 20,
  registro: 6,
  "registro-tweet": 10,
} as const;

export type PublicBucket = keyof typeof PUBLIC_LIMITS;

/**
 * Callers already known to be over their limit, and the instant their window
 * ends: `<ip_hash>|<bucket>` to an epoch second.
 *
 * {@link hitLimit} costs an upsert on **every** call, answered or refused, so
 * a limiter that consults it for a caller it has already refused turns each
 * blocked request into a write against a `max: 1` pool -- the limiter becomes
 * the amplifier it was installed to stop. Once the database has said "over",
 * nothing about that answer can change before the window ends, so the second
 * refusal and every one after it is free.
 *
 * The consequences of this being per-process and per-instance are all in the
 * safe direction: a cold instance simply asks the database, which is the
 * behaviour without the memo. It never *creates* a refusal -- an entry is only
 * ever written after a real `hitLimit` returned true.
 *
 * ponytail: a Map with a sweep, not an LRU dependency. It holds one entry per
 * (blocked caller, bucket) and clears itself; reach for a real cache only if
 * something here ever needs eviction by cost rather than by expiry.
 */
const blockedUntil = new Map<string, number>();

/**
 * A ceiling on the map above, since its keys come from whoever is sending the
 * traffic. Sweeping the expired entries is the normal path; a flood spread
 * across enough distinct addresses to survive that clears the map instead,
 * which costs a database round trip per blocked caller -- exactly the
 * behaviour there would be with no memo at all.
 */
const MEMO_MAX_ENTRIES = 10_000;

function sweepMemo(nowSeconds: number): void {
  if (blockedUntil.size < MEMO_MAX_ENTRIES) return;
  for (const [key, until] of blockedUntil) {
    if (until <= nowSeconds) blockedUntil.delete(key);
  }
  if (blockedUntil.size >= MEMO_MAX_ENTRIES) blockedUntil.clear();
}

/**
 * `429`, never cached.
 *
 * `no-store` is explicit rather than inherited: `next.config.ts` no longer
 * sets `Cache-Control` on `/api/avatar/*` at all, and a refusal that a shared
 * cache held for five minutes would hand one caller's 429 to everyone else.
 * `Retry-After` is the seconds left in the window, which is the true answer
 * and is what a well-behaved client waits for.
 */
function tooManyRequests(retryAfterSeconds: number): Response {
  return new Response("rate limited", {
    status: 429,
    headers: {
      "retry-after": String(Math.max(1, Math.ceil(retryAfterSeconds))),
      "cache-control": "no-store",
    },
  });
}

/**
 * Spec §10's *"`ip_hash` rate limiting"*, for one public surface: a `429` when
 * the caller is over {@link PUBLIC_LIMITS}, `null` when the handler should
 * carry on.
 *
 * Called first in the handler, before any read, because a limit enforced after
 * the work is done has bounded nothing.
 *
 * Errors are not swallowed. Every route that calls this needs the same
 * database on the next line, so a limiter that failed open here would only
 * move the failure one statement along while quietly removing the control.
 * The page proxy is the exception and says so where it fails open.
 */
export async function rateLimited(request: Request, bucket: PublicBucket): Promise<Response | null> {
  const ip = clientIp(request);
  const key = `${ipHash(ip).toString("base64")}|${bucket}`;
  const now = Date.now() / 1000;

  const until = blockedUntil.get(key);
  if (until !== undefined) {
    if (now < until) return tooManyRequests(until - now);
    blockedUntil.delete(key);
  }

  if (!(await hitLimit(ip, bucket, PUBLIC_LIMITS[bucket], PUBLIC_WINDOW_SECONDS))) return null;

  // The window this instant falls in ends at the next boundary. Floored on the
  // application's clock where `hitLimit` floors on Postgres's, so the two can
  // disagree by however far the clocks have drifted -- which changes only how
  // long a caller stays blocked without a write, never whether it was blocked.
  const windowEnd = (Math.floor(now / PUBLIC_WINDOW_SECONDS) + 1) * PUBLIC_WINDOW_SECONDS;
  sweepMemo(now);
  blockedUntil.set(key, windowEnd);
  return tooManyRequests(windowEnd - now);
}

/** Seven days. See {@link pruneRateLimit}. */
const DEFAULT_RETENTION_SECONDS = 7 * 24 * 60 * 60;

/**
 * Deletes rate-limit windows older than `retentionSeconds` and returns how
 * many rows went. Nothing else deletes from this table, and the table is
 * written on every request from every visitor, so without this it is the one
 * place in the schema that grows without bound.
 *
 * Seven days by default: far longer than the longest window any bucket uses
 * (the webhook's is a minute), short enough that the table stays small, and
 * long enough that a week of abuse is still there if anyone ever looks. No
 * caller reads a row this old -- `hitLimit` only ever touches the window it
 * is in -- so the retention is about forensics, not correctness.
 *
 * Cut against `now()`, the server's clock, for the same reason `hitLimit`
 * floors against it: the rows were written by that clock.
 *
 * The count comes back through a CTE rather than `RETURNING 1` so one row
 * crosses the wire instead of one per deleted window -- the first prune of a
 * table that has never been pruned is exactly the call where that difference
 * is large.
 */
export async function pruneRateLimit(
  retentionSeconds: number = DEFAULT_RETENTION_SECONDS,
): Promise<number> {
  const rows = await query<{ deleted: number }>(
    `WITH gone AS (
       DELETE FROM rate_limit
        WHERE window_start < now() - make_interval(secs => $1::double precision)
       RETURNING 1
     )
     SELECT count(*)::int AS deleted FROM gone`,
    [retentionSeconds],
  );
  return rows[0].deleted;
}
