import { parseUnit, readLeaderboard } from "@/lib/leaderboard";
import { WINDOW_LABELS, parseWindow } from "@/lib/windows";
import { KolModalHost } from "../kol-modal-host";
import { LeaderboardTable, USD_CAVEAT } from "../leaderboard-table";

/** The window is relative to now and the rows behind it change as trades land. */
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Clasificación · kolscanhispano.fun",
  description: "PnL realizado de KOLs hispanohablantes en Solana, por día, semana y mes UTC.",
};

type SearchParams = Record<string, string | string[] | undefined>;

function first(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

/**
 * Spec §2: ranked realized PnL, with `Diario / Semanal / Mensual` and
 * `SOL / USD`.
 *
 * **The two toggles are not on this page.** DESIGN.md, Layout: *"Header:
 * wordmark and subtitle left, nav centre, unit and window controls plus the
 * wallet action right."* They live in the site header (`LeaderboardControls`),
 * read the same query string this page reads, and apply the same fallbacks —
 * rendering a second copy here would be two controls over one piece of state.
 *
 * They are still links, so every combination is a real URL: the state survives
 * a reload, a share and a back button.
 *
 * An unreadable parameter falls back to the default here rather than
 * answering `400` the way `/api/leaderboard` does. A person following a stale
 * link should get the leaderboard; a program asking for `?unit=eur` should be
 * told it does not exist.
 */
export default async function LeaderboardPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const window = parseWindow(first(params.window)) ?? "diario";
  const unit = parseUnit(first(params.unit)) ?? "sol";

  const leaderboard = await readLeaderboard({ window, unit });

  return (
    <>
      {/* DESIGN.md's `display-lg`: the page's own title, above the panel that
          holds its data. */}
      <div className="page-head">
        <h1 className="display-lg">Clasificación</h1>
        <p className="page-subtitle">
          PnL realizado · {WINDOW_LABELS[window]} · {unit === "sol" ? "SOL" : "USD"}
        </p>
      </div>

      <section className="panel" style={{ marginTop: "var(--stack)" }}>
        {/*
          The qualifier line: everything a reader needs to know about the
          figures before reading them, directly above them.

          `día UTC` is spec §4.9 — the community spans UTC−6 to UTC+1 and any
          local choice would hand the day to one country.

          The USD caveat is spec §4.1, and it is here **unconditionally**: this
          table always prints a USD amount, as the ranked column or as the one
          in parentheses. See `USD_CAVEAT`.
        */}
        <p className="label control-note">día UTC · {USD_CAVEAT}</p>

        {/* Spec §4.8's definition is written by `LeaderboardTable`, beneath the
            column it defines.

            `KolModalHost` provides `KolModalContext`, which is what makes each
            row clickable and focusable — DESIGN.md `row-leaderboard`, "it opens
            the modal". It is handed this page's window so a modal opens on the
            period its row was ranked in. */}
        <KolModalHost window={window}>
          <LeaderboardTable entries={leaderboard.entries} unit={unit} />
        </KolModalHost>
      </section>
    </>
  );
}
