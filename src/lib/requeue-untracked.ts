/**
 * Re-parsing the transactions that succeeded and found nobody.
 *
 * **This is not the roadmap's requeue.** `roadmap.md` §1 is about clearing
 * `parse_error` on rows the parser *refused*; this clears `parsed_at` on rows
 * the parser *accepted*, decided involved no wallet of ours, and recorded
 * nothing for. Two different states, and mixing them into one script would
 * make one nobody can reason about — so this one refuses to touch a row that
 * carries an error, and says so in its `WHERE`.
 *
 * `docs/padron.md` §3 has the measurement that makes it necessary: 4,503 rows
 * in production parsed with no error and no trade, because the roster was
 * empty when they arrived. Every wallet added to the roster makes some of them
 * attributable, and nothing else would ever look at them again.
 *
 * **Safe because the write is idempotent, which is a property of existing code
 * rather than a hope.** `insertTrade` is `ON CONFLICT (chain, signature_hmac,
 * instruction_index, wallet_id) DO NOTHING`, so a row that already produced a
 * trade cannot produce a second one, and a row that still matches nothing is
 * simply marked parsed again.
 */

import { query } from "./db";

/**
 * How many rows one call may move back into the queue.
 *
 * The caller passes it and there is no unbounded form, deliberately: resetting
 * every row in one statement hands the next cron tick thousands of payloads to
 * decrypt and parse inside a workflow budgeted for six minutes. An operator
 * moves a batch, watches it drain, and decides whether to move more.
 */
export const DEFAULT_REQUEUE_LIMIT = 500;

export type RequeueResult = {
  /** Rows moved back to `parsed_at IS NULL`. */
  requeued: number;
  /** Rows still eligible after this call, so the operator knows if more remain. */
  remaining: number;
};

/**
 * Moves up to `limit` already-parsed, trade-less rows back into the pending
 * queue.
 *
 * **Newest first.** A reader who adds a KOL wants that KOL's recent activity to
 * appear, not their oldest; and if an operator stops after one batch, the rows
 * that got through are the ones that matter most. `block_time DESC` with
 * `signature_hmac` as a tiebreak so the order is total and two calls cannot
 * disagree about which rows the first one took.
 *
 * The `NOT EXISTS` matches on **both** halves of `raw_tx`'s key — migration 011
 * made it `(chain, signature_hmac)`, and matching on the signature alone would
 * treat one chain's copy of a transaction as evidence about the other's.
 */
export async function requeueUntracked(
  limit: number = DEFAULT_REQUEUE_LIMIT,
): Promise<RequeueResult> {
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error("limit must be a positive integer");
  }

  const moved = await query<{ signature_hmac: Buffer }>(
    `WITH eligible AS (
       SELECT r.chain, r.signature_hmac
         FROM raw_tx r
        WHERE r.parsed_at IS NOT NULL
          AND r.parse_error IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM trade t
             WHERE t.chain = r.chain AND t.signature_hmac = r.signature_hmac
          )
        ORDER BY r.block_time DESC, r.signature_hmac
        LIMIT $1
     )
     UPDATE raw_tx r SET parsed_at = NULL
       FROM eligible e
      WHERE r.chain = e.chain AND r.signature_hmac = e.signature_hmac
      RETURNING r.signature_hmac`,
    [limit],
  );

  const [rest] = await query<{ n: number }>(
    `SELECT count(*)::int AS n
       FROM raw_tx r
      WHERE r.parsed_at IS NOT NULL
        AND r.parse_error IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM trade t
           WHERE t.chain = r.chain AND t.signature_hmac = r.signature_hmac
        )`,
  );

  return { requeued: moved.length, remaining: rest.n };
}
