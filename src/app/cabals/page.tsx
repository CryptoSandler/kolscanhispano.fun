import Link from "next/link";
import { readCabals } from "@/lib/cabals";
import { permanentRedirect } from "next/navigation";
import { LEADERBOARD_WINDOWS, WINDOW_LABELS, resolveWindow } from "@/lib/windows";
import { LeaderboardControls } from "../leaderboard-controls";
import { USD_CAVEAT } from "../leaderboard-table";
import { CabalsBoard } from "./board";

/** The window is relative to now and the rows behind it change as trades land. */
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Cabals · kolscanhispano.fun",
  description: "Grupos de traders hispanohablantes en Solana, por PnL realizado del período.",
};

type SearchParams = Record<string, string | string[] | undefined>;

function first(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

/**
 * `docs/clone-map.md` §6: the mould's richest surface, and the one we did not
 * have. `cabal` has existed since `001_core.sql` and `chip-cabal` has been on
 * every row since the ranking was built — the data was here, the page was not.
 *
 * The window toggle in the header applies here as it does to the ranking: the
 * control reads the query string and this page reads the same one. **The
 * currency toggle does not appear on this page's figures** — a cabal total is a
 * SOL figure with its USD equivalent beside it, exactly as a card is, and the
 * peso conversion belongs where the reader chose it.
 *
 * The surface itself, and both of its states, are `CabalsBoard`.
 */
export default async function CabalsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  /*
    **The board sums the rolling windows too since 2026-09-03**, and the note
    that stood here — explaining why it could only answer the calendar three —
    is gone with them. `cabals.ts` sums `trade.realized_sol` the way
    `leaderboard.ts` does; `migrations/015` is what made that possible, and it
    is the same column, so a cabal total and the sum of its members' rows cannot
    disagree.

    A published calendar URL earns a **308** here for the same reason it does on
    the ranking: `/cabals?window=mensual` was correct for weeks.
  */
  const resolved = resolveWindow(first(params.window));
  if (resolved !== null && typeof resolved === "object") {
    permanentRedirect(`/cabals?window=${resolved.redirectTo}`);
  }
  const window = resolved ?? "1d";
  const ranking = await readCabals({ window });

  return (
    <>
      <div className="page-head is-row">
        <div>
          <h1 className="display-lg">Cabals</h1>
          <p className="page-subtitle">Grupos de traders compitiendo por ganancias</p>
          <Link className="panel-link" href="/">
            ← Volver a la clasificación
          </Link>{" "}
          {/* The only way into `/mi-cabal`, and it belongs here rather than in
              the nav: the nav is the mould's, two items plus the feed, and a
              fourth would break the 1:1 it is measured against. A page nothing
              links to is an orphan, so it is linked from the page about the
              thing it administers. */}
          <Link className="panel-link" href="/mi-cabal">
            Mi cabal →
          </Link>
        </div>
        {/* No currency group: every figure on this page is a SOL total with its
            USD equivalent beside it, so there is nothing for a toggle to
            choose. */}
        <LeaderboardControls windows={LEADERBOARD_WINDOWS} fiats={[]} basePath="/cabals" />
      </div>

      <section className="panel" style={{ marginTop: "var(--stack)" }}>
        <p className="label control-note">
          {WINDOW_LABELS[window]} · día UTC · {USD_CAVEAT}
        </p>

        <CabalsBoard entries={ranking.entries} />
      </section>
    </>
  );
}
