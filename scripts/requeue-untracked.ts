/**
 * Operator entry point for `requeueUntracked` (see `../src/lib/requeue-untracked.ts`).
 *
 *     npx tsx scripts/requeue-untracked.ts [limit]
 *
 * Moves already-parsed transactions that produced no trade back into the
 * pending queue, so the next `parsePending` run re-evaluates them against the
 * roster as it stands now. `docs/padron.md` §3 is why this exists at all.
 *
 * **Not a cron.** It runs when somebody adds a KOL, which is not a schedule;
 * putting it on one would re-decrypt and re-parse the whole history every few
 * minutes for a roster that changes weekly. It takes the same advisory lock the
 * crons take, so a manual run and a scheduled parse cannot race.
 *
 * The limit is an argument, and the default is deliberately smaller than the
 * backlog: an operator moves a batch, watches the parse drain it, and decides
 * whether to move more. Nothing here prints a secret; the summary is counts.
 */
import { loadEnvLocal } from "../src/lib/env";
loadEnvLocal();

import { announceDatabaseTarget } from "../src/lib/db";
import { withLock } from "../src/lib/lock";
import { DEFAULT_REQUEUE_LIMIT, requeueUntracked } from "../src/lib/requeue-untracked";

function parseLimit(argument: string | undefined): number {
  if (argument === undefined) return DEFAULT_REQUEUE_LIMIT;
  // Strict rather than falling back: a typo that silently became the default
  // would move a different number of rows than the operator asked for, and they
  // would have no way to tell from the output.
  if (!/^\d+$/.test(argument) || Number(argument) === 0) {
    throw new Error("limit must be a positive integer");
  }
  return Number(argument);
}

async function main(): Promise<number> {
  const limit = parseLimit(process.argv[2]);
  announceDatabaseTarget();

  // `"parse-pending"`, the parse cron's own lock name, not a new one: this
  // moves rows *into* the queue that cron reads, and two runs touching the same
  // rows from both ends is exactly what a lock is for.
  const result = await withLock("parse-pending", async () => requeueUntracked(limit));

  if (result === null) {
    console.log("requeue-untracked: another run holds the parse lock; did nothing");
    return 0;
  }
  console.log(
    `requeue-untracked: moved ${result.requeued} row(s) back to pending; ` +
      `${result.remaining} still eligible`,
  );
  if (result.remaining > 0) {
    console.log("Run again after the queue drains to move the rest.");
  }
  return 0;
}

try {
  process.exitCode = await main();
} catch (error) {
  console.error("requeue-untracked failed:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
