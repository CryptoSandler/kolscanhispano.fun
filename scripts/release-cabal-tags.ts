/**
 * Cron entry point for `releaseCabalTags` (see `../src/lib/release-cabal-tags.ts`).
 *
 * The owner's decision in `docs/round-cabals.md` §4: a tag is released thirty
 * days after the cabal dissolves, and never reclaimed while it is in use. The
 * thirty days cannot live in an index predicate (`migrations/016` has the
 * refusal Postgres gives and why it is correct), so they live in a scheduled
 * write — this one.
 *
 * It rides the recompute workflow beside `prune-rate-limit`, for the same
 * reason: parsing is the ingestion critical path, and a tag that goes back into
 * the namespace a few hours later than it might have has no business standing
 * between a webhook payload and a trade.
 *
 * **A run that does not happen leaves every tag held**, which is the safe
 * direction. Late is an inconvenience; early hands somebody's identity to a
 * stranger.
 *
 * Prints how many were released and never which — a tag is a public label, but
 * a cron log is not the place a dissolution becomes news.
 */
import { loadEnvLocal } from "../src/lib/env";
loadEnvLocal();

import { announceDatabaseTarget } from "../src/lib/db";
import { withLock } from "../src/lib/lock";
import { releaseCabalTags } from "../src/lib/release-cabal-tags";

export async function main(): Promise<number> {
  try {
    const released = await withLock("release-cabal-tags", () => releaseCabalTags());
    if (released === null) {
      console.log("release-cabal-tags: another run holds the lock; did nothing");
      return 0;
    }
    console.log(`release-cabal-tags: released ${released.length}`);
    return 0;
  } catch {
    // Never the error's own text: it can carry connection detail (db.ts).
    console.error("release-cabal-tags: failed");
    return 1;
  }
}

if (process.argv[1]?.endsWith("release-cabal-tags.ts")) {
  announceDatabaseTarget();
  void main().then((code) => process.exit(code));
}
