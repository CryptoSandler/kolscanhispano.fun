import { parseFiat, readLeaderboard } from "@/lib/leaderboard";
import { ARS_SOURCE_LABELS, readArsRate } from "@/lib/fx";
import { formatArsRate, formatUtcMoment } from "@/lib/format";
import { WINDOW_LABELS, parseWindow } from "@/lib/windows";
import { KolModalHost } from "../kol-modal-host";
import { ARS_CAVEAT, LeaderboardTable, USD_CAVEAT } from "../leaderboard-table";

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
 * told it does not exist. **`?unit=sol` is now such a link** — the toggle
 * stopped naming the ranked unit on 2026-09-02 — and it lands on the USD
 * default rather than on an error.
 */
export default async function LeaderboardPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const window = parseWindow(first(params.window)) ?? "diario";
  const fiat = parseFiat(first(params.unit)) ?? "usd";

  /*
    The rate is read only when a peso figure is going to be printed, and it is
    read **beside** the ranking rather than after it: they touch different
    tables and neither needs the other's result, so waiting for them in sequence
    would add a Neon round trip to the first paint for nothing — the same
    reasoning the home page gives for its two reads.
  */
  const [leaderboard, rate] = await Promise.all([
    readLeaderboard({ window }),
    fiat === "ars" ? readArsRate() : Promise.resolve(null),
  ]);

  return (
    <>
      {/* DESIGN.md's `display-lg`: the page's own title, above the panel that
          holds its data. */}
      <div className="page-head">
        <h1 className="display-lg">Clasificación</h1>
        {/* The ranked figure is SOL whatever the toggle says — the toggle
            chooses the currency in parentheses, not the sort. */}
        <p className="page-subtitle">
          PnL realizado · {WINDOW_LABELS[window]} · SOL
        </p>
      </div>

      <section className="panel" style={{ marginTop: "var(--stack)" }}>
        {/*
          The qualifier line: everything a reader needs to know about the
          figures before reading them, directly above them.

          `día UTC` is spec §4.9 — the community spans UTC−6 to UTC+1 and any
          local choice would hand the day to one country.

          The USD caveat is spec §4.1, and it is here **unconditionally**: the
          peso figure is derived from the dollar one, so the dollar's
          incompleteness is the peso's too. See `USD_CAVEAT`.

          The peso line names the rate, the casa and the moment it was quoted.
          A converted figure without them is a number pretending to be a fact,
          and `docs/round-ars.md` §3 makes printing them part of the change
          rather than a nicety. With no rate to name, the line says that
          instead — the figures beside it read `sin precio`.
        */}
        <p className="label control-note">
          día UTC · {USD_CAVEAT}
          {fiat === "ars" && ` · ${ARS_CAVEAT}`}
        </p>
        {fiat === "ars" && (
          <p className="label control-note">
            {rate === null
              ? "Sin tipo de cambio vigente: los importes en ARS no se pueden calcular."
              : `1 US$ = ${formatArsRate(rate.rate)} ARS · ${ARS_SOURCE_LABELS[rate.source]} · ${formatUtcMoment(rate.asOf)}`}
          </p>
        )}

        {/* `KolModalHost` provides `KolModalContext`, which is what makes each
            row clickable and focusable — DESIGN.md `row-leaderboard`, "it opens
            the modal". It is handed this page's window so a modal opens on the
            period its row was ranked in. */}
        <KolModalHost window={window}>
          <LeaderboardTable entries={leaderboard.entries} fiat={fiat} rate={rate} />
        </KolModalHost>
      </section>
    </>
  );
}
