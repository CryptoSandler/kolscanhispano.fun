import Link from "next/link";
import { readFeedPage } from "@/lib/feed";
import { LEADERBOARD_TOP, readLeaderboard } from "@/lib/leaderboard";
import { FeedLive } from "./feed-live";
import { LeaderboardTable, USD_CAVEAT } from "./leaderboard-table";

/**
 * Spec §2: the home page is the live trade feed, newest first — and, beneath
 * it, the leaderboard's top ten.
 *
 * **Why both are here.** `docs/references.md` §5: *"a live feed on the home
 * page is not a genre requirement. Putting one there is our choice, and it is
 * the choice that makes the site read as alive on the first three seconds."*
 * kolscan.io keeps its feed on its own page and kolscanbrasil.io has none;
 * DESIGN.md takes the feed from the first and the podium from the second, so
 * this page carries both.
 *
 * The feed comes first because that is what spec §2 says this page is. The
 * top ten below it is the daily window in SOL — the same defaults the header's
 * controls show off `/leaderboard`, so the control and this panel agree.
 *
 * Both reads are issued together. They touch different tables and neither
 * needs the other's result, so waiting for them in sequence would add a Neon
 * round trip to the first paint for nothing.
 */
export const dynamic = "force-dynamic";

export default async function HomePage() {
  const [feed, leaderboard] = await Promise.all([
    readFeedPage(),
    readLeaderboard({ window: "diario", unit: "sol", limit: LEADERBOARD_TOP }),
  ]);

  return (
    <div className="panel" style={{ marginTop: "var(--stack)" }}>
      <FeedLive initialTrades={feed.trades} />

      <section className="panel-section">
        <div className="panel-head">
          <h2 className="headline">Clasificación</h2>
          <span className="head-aside">
            {/*
              The qualifiers of the figures below, on the line above them: the
              window, the UTC boundary (spec §4.9) and the USD caveat
              (spec §4.1). The caveat is here rather than under the table
              because the head already carries the other two, and because a
              second caption line is 16px this page does not have — see the
              note in `leaderboard-table.tsx`.
            */}
            <span className="label">Diario · día UTC · {USD_CAVEAT}</span>
            <Link className="panel-link" href="/leaderboard">
              Ver todo
            </Link>
          </span>
        </div>

        {/*
          No header row: `/leaderboard` is where a reader goes to compare
          columns, and the caption `LeaderboardTable` writes beneath itself
          names both count columns for the summary.
        */}
        <LeaderboardTable entries={leaderboard.entries} unit="sol" showHeader={false} />
      </section>
    </div>
  );
}
