import Link from "next/link";
import { readCabals } from "@/lib/cabals";
import { WINDOW_LABELS, parseWindow } from "@/lib/windows";
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
  const window = parseWindow(first(params.window)) ?? "diario";
  const ranking = await readCabals({ window });

  return (
    <>
      <div className="page-head">
        <h1 className="display-lg">Cabals</h1>
        <p className="page-subtitle">Grupos de traders compitiendo por ganancias</p>
        <Link className="panel-link" href="/leaderboard">
          ← Volver a la clasificación
        </Link>
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
