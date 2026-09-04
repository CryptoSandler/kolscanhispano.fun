import { createHash } from "node:crypto";
import { query, type TxQuery } from "./db";
import type { ProofAction } from "./wallet-proof";

/**
 * The account of who did what, as a chain.
 *
 * `migrations/018` makes `audit_log` append-only with a trigger and gives every
 * row a link to the one before it. This module is the only thing that writes
 * here, so the chain has exactly one place that can get it wrong.
 *
 * ## What a row commits to
 *
 * The hash covers the row's own content **and** the previous row's hash, so a
 * row cannot be altered without breaking every link after it. What it does not
 * cover is anything outside this table: the point is to detect a rewrite of the
 * account, not to prove the account describes reality.
 *
 * **It is a tripwire and not a proof**, and the migration says so in the same
 * words: whoever can write rows can rebuild the chain from the point they
 * changed. It catches the realistic case — a console edit, a migration that
 * "fixes" a row, a bug that rewrites history — and claims nothing about an
 * attacker with write access and time.
 *
 * ## Why the write is serialised
 *
 * Two appends racing would both read the same tip and both link to it, leaving
 * a fork that verification reports as tampering when nothing was tampered with.
 * The insert takes a transaction-scoped advisory lock, so appends queue instead.
 * Cabal mutations are rare — a leader acts a handful of times a day — so the
 * contention this costs is nothing against a chain that cannot fork.
 */

/** The lock every append serialises on. Arbitrary, and used nowhere else. */
const AUDIT_LOCK = 0x4155_4449; // "AUDI"

export type AuditEntry = {
  /** Who acted: a KOL's `@handle`, or `admin`. Never an address. */
  actor: string;
  action: ProofAction | string;
  /** What it was about — a cabal tag or a `@handle`. Never an address, never an id. */
  subject?: string;
  targetType?: string;
  targetId?: string;
  before?: unknown;
  after?: unknown;
  /**
   * The nonce whose signature authorised this. Absent only for actions that
   * are not signed — the admin's own, which are authorised by the admin token.
   */
  nonce?: string;
};

/** The bytes a row commits to. Field names included, so a value cannot slide between columns. */
function digest(entry: AuditEntry, at: string, prevHash: string): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        actor: entry.actor,
        action: entry.action,
        subject: entry.subject ?? null,
        targetType: entry.targetType ?? null,
        targetId: entry.targetId ?? null,
        before: entry.before ?? null,
        after: entry.after ?? null,
        nonce: entry.nonce ?? null,
        at,
        prev: prevHash,
      }),
    )
    .digest("hex");
}

/** The chain's first link, so the head row has something to commit to. */
export const GENESIS_HASH = "0".repeat(64);

/**
 * Appends one entry, inside the caller's transaction.
 *
 * **It takes the transaction's query fn, not a connection.** A cabal mutation and its audit
 * row are one fact: a transfer that happened with no entry, or an entry for a
 * transfer that rolled back, are both worse than either failing. The caller
 * commits both or neither.
 */
export async function appendAudit(
  tx: TxQuery,
  entry: AuditEntry,
): Promise<{ id: string; rowHash: string }> {
  await tx("SELECT pg_advisory_xact_lock($1)", [AUDIT_LOCK]);

  const [tip] = await tx<{ row_hash: string | null }>(
    "SELECT row_hash FROM audit_log ORDER BY at DESC, id DESC LIMIT 1",
  );
  const prevHash = tip?.row_hash ?? GENESIS_HASH;
  const at = new Date().toISOString();
  const rowHash = digest(entry, at, prevHash);

  const id = crypto.randomUUID();
  await tx(
    `INSERT INTO audit_log (id, actor, action, subject, target_type, target_id,
                            before, after, nonce, prev_hash, row_hash, at)
     VALUES ($1::uuid, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10, $11, $12::timestamptz)`,
    [
      id,
      entry.actor,
      entry.action,
      entry.subject ?? null,
      entry.targetType ?? null,
      entry.targetId ?? null,
      entry.before === undefined ? null : JSON.stringify(entry.before),
      entry.after === undefined ? null : JSON.stringify(entry.after),
      entry.nonce ?? null,
      prevHash,
      rowHash,
      at,
    ],
  );
  // The id is returned, not just the hash: `audit_signature` references the row
  // and the two must be written in the same transaction, so the caller needs it.
  return { id, rowHash };
}

export type ChainBreak = {
  id: string;
  at: string;
  /** `link` — the row does not follow its predecessor. `content` — the row's own hash is wrong. */
  kind: "link" | "content";
};

/**
 * Walks the chain and returns every row that does not follow.
 *
 * Reads in the same order the append writes, and recomputes rather than trusts:
 * a verifier that compared `prev_hash` to the previous row's stored `row_hash`
 * without recomputing that row would miss an edit to the row's own content,
 * which is half of what this exists to catch.
 */
export async function verifyAuditChain(limit = 10_000): Promise<ChainBreak[]> {
  const rows = await query<{
    id: string;
    actor: string;
    action: string;
    subject: string | null;
    target_type: string | null;
    target_id: string | null;
    before: unknown;
    after: unknown;
    nonce: string | null;
    prev_hash: string | null;
    row_hash: string | null;
    at: Date;
  }>(
    `SELECT id, actor, action, subject, target_type, target_id, before, after, nonce,
            prev_hash, row_hash, at
       FROM audit_log
      ORDER BY at ASC, id ASC
      LIMIT $1`,
    [limit],
  );

  const breaks: ChainBreak[] = [];
  let expectedPrev = GENESIS_HASH;

  for (const row of rows) {
    // Rows written before `migrations/018` carry no hash at all. They are not
    // breaks — nothing claimed they were linked — and the chain restarts from
    // the first row that does carry one.
    if (row.row_hash === null) continue;

    const at = row.at.toISOString();
    const recomputed = digest(
      {
        actor: row.actor,
        action: row.action,
        subject: row.subject ?? undefined,
        targetType: row.target_type ?? undefined,
        targetId: row.target_id ?? undefined,
        before: row.before ?? undefined,
        after: row.after ?? undefined,
        nonce: row.nonce ?? undefined,
      },
      at,
      row.prev_hash ?? GENESIS_HASH,
    );

    if (recomputed !== row.row_hash) breaks.push({ id: row.id, at, kind: "content" });
    else if (row.prev_hash !== expectedPrev && expectedPrev !== GENESIS_HASH) {
      breaks.push({ id: row.id, at, kind: "link" });
    }
    expectedPrev = row.row_hash;
  }

  return breaks;
}
