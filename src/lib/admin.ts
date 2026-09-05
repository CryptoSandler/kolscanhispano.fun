/**
 * The admin gate and its audit trail.
 *
 * Spec §9 states both as properties of the admin rather than as habits:
 * *"`ADMIN_TOKEN`, every mutation in `audit_log` with actor, before, after and
 * `ip_hash`."* So they live together, and the writer below takes the same
 * arguments the spec names — a call that cannot fill them in is a mutation that
 * should not be reachable from here.
 */

import { timingSafeEqual } from "node:crypto";
import { appendAudit } from "./audit";
import { withTransaction } from "./db";
import { clientIp, ipHash } from "./rate-limit";

/**
 * Whether the request carries the admin token.
 *
 * **An absent `ADMIN_TOKEN` refuses, and that is the whole of it.** The
 * tempting alternative — "no token configured, so this is a dev machine, so
 * allow" — is how an admin route ships open: the variable is missing on exactly
 * the deployment where somebody forgot to set it, which is the deployment that
 * most needs the gate. `resolveConnectionString` earned the opposite treatment
 * because a missing `sslmode` is an omission with a safe correction; a missing
 * token has no safe correction.
 *
 * Constant time, and length-compared first because `timingSafeEqual` throws on
 * a length mismatch rather than returning `false`. Comparing lengths does leak
 * the token's length, which is not a secret worth a variable-time compare over.
 *
 * The header is `Authorization: Bearer <token>`, matching the webhook's shape
 * so there is one thing to know about authenticating against this app.
 */
export function isAdmin(header: string | null): boolean {
  const expected = process.env.ADMIN_TOKEN?.trim();
  if (!expected || !header) return false;
  const offered = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (offered.length === 0) return false;

  const a = Buffer.from(offered);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export type AuditEntry = {
  /** Who acted. `"admin"` for a token holder; a KOL id for a self-service change. */
  actor: string;
  action: string;
  targetType?: string;
  targetId?: string;
  before?: unknown;
  after?: unknown;
  /** The request, so the row can carry `ip_hash` without the caller hashing it. */
  request?: Request;
};

/**
 * One row in `audit_log`.
 *
 * **Nothing an address could travel in reaches `before` or `after`.** Those are
 * `JSONB` and they are the easiest place in this system to accidentally persist
 * a wallet in cleartext — a caller passing the request body would do it in one
 * line. Callers pass reason codes, counts and ids; there is a test that scans
 * the written rows for an address, because a rule stated in a comment here is a
 * rule the next caller does not read.
 *
 * The IP is stored as `ip_hash` through the same keyed digest `rate_limit`
 * uses, never as an address: spec §8 makes an IP personal data, and an audit
 * trail that deanonymises the reader is not a safety feature.
 */
export async function audit(entry: AuditEntry): Promise<void> {
  // Through `appendAudit` rather than a bare INSERT, so the admin's rows sit in
  // the **same hash chain** as the KOLs' signed ones. They used to be written
  // straight to the table, which left them with no `row_hash` — indistinguishable
  // to `verifyAuditChain` from rows written before the chain existed, and
  // therefore outside the thing that notices a rewrite. Two accounts of who did
  // what, one of them unguarded, is the seam this closes.
  //
  // No nonce, because no signature: the admin is authorised by a token we hold,
  // and `migrations/019` says the account states that by the absence of a
  // signature row rather than by a claim.
  await withTransaction((tx) =>
    appendAudit(tx, {
      actor: entry.actor,
      action: entry.action,
      targetType: entry.targetType,
      targetId: entry.targetId,
      before: entry.before,
      after: entry.after,
      // `clientIp` from the limiter, not a second reading of
      // `x-forwarded-for`: two readings would put two different hashes in two
      // tables for one reader, and the audit trail would stop lining up with
      // the rate-limit rows it exists to explain.
      ipHash: entry.request ? ipHash(clientIp(entry.request)) : null,
    }),
  );
}
