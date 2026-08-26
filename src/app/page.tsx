import Link from "next/link";
import { readFeedPage } from "@/lib/feed";
import { LEADERBOARD_TOP, readLeaderboard } from "@/lib/leaderboard";
import { FeedLive } from "./feed-live";
import { LeaderboardTable, USD_CAVEAT } from "./leaderboard-table";

/**
 * Spec §2: the home page is the live trade feed, newest first — and, beneath
 * it, the leaderboard's top ten.
 *
 * **Why both are here.** DESIGN.md's whole argument for the 36px row is that
 * *"the leaderboard's top ten and the live feed's last eight should share one
 * 900px viewport without scrolling"*, and it lists fitting them on one screen
 * first among its Do's. That thesis is only testable on a page that carries
 * both; the feed's `min-height` in `globals.css` was already sized against it
 * — eight rows rather than twelve, explicitly to leave room for a leaderboard
 * that needs about 425px. Spec §2's one-line description of `/` predates the
 * design document, and the design document is the binding authority on layout.
 *
 * The feed comes first because that is what spec §2 says this page is. The
 * top ten below it is the daily window in SOL, with no toggles: `/leaderboard`
 * is where a reader changes the window, and duplicating the control here would
 * duplicate the state that URL already holds.
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
          No header row: it costs 25px, and the caption `LeaderboardTable`
          writes beneath itself names both count columns instead. The whole
          point of this page is what fits in 900px.
        */}
        <LeaderboardTable entries={leaderboard.entries} unit="sol" showHeader={false} />
      </section>
    </div>
  );
}
