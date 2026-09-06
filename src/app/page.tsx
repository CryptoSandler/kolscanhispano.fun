import Link from "next/link";
import { permanentRedirect } from "next/navigation";
import { LEADERBOARD_FIATS, parseFiat, readLeaderboard } from "@/lib/leaderboard";
import { ARS_SOURCE_LABELS, arsTooltip, readArsRate } from "@/lib/fx";
import { formatArsRate, formatUtcMoment } from "@/lib/format";
import { LEADERBOARD_WINDOWS, resolveWindow } from "@/lib/windows";
import { LeaderboardControls } from "./leaderboard-controls";
import { KolModalHost } from "./kol-modal-host";
import { ARS_CAVEAT, LeaderboardTable, USD_CAVEAT } from "./leaderboard-table";

/** The window is relative to now and the rows behind it change as trades land. */
export const dynamic = "force-dynamic";

export const metadata = {
  title: "kolscanhispano.fun · Clasificación de traders hispanos",
  description: "PnL realizado de KOLs hispanohablantes en Solana, por día, semana y mes UTC.",
};

type SearchParams = Record<string, string | string[] | undefined>;

function first(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

/**
 * **The home page is the ranking**, since 2026-09-03.
 *
 * `docs/clone-map.md` §2 recorded the mould's shape from the first day —
 * *"Their home **is** the leaderboard: no hero, no feed, no value props"* — and
 * left ours alone because the feed above it was a choice `docs/references.md`
 * §5 defends. The owner settled it: the feed has its own page at `/en-vivo`,
 * and the first thing a reader meets is the ranking, as on the mould.
 *
 * `/leaderboard` still answers and redirects here: it is a published URL, and
 * DESIGN.md's rule that the route survives a rename applies just as well to a
 * route that moved.
 *
 * Spec §2: ranked realized PnL, with `Diario / Semanal / Mensual` and
 * the currency toggle.
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
export default async function HomePage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  /*
    **A published calendar URL earns a 308, not a default.** `?window=diario`
    was correct for weeks; answering it with `1D` figures under no explanation
    would be the substitution `docs/round-ventanas-moviles.md` §1 argued
    against, and answering it with a `400` would break links that were right
    when they were made. `resolveWindow` returns the redirect and this page
    performs it before it reads anything.
  */
  const resolved = resolveWindow(first(params.window));
  if (resolved !== null && typeof resolved === "object") {
    const unit = first(params.unit);
    permanentRedirect(
      `/?window=${resolved.redirectTo}${unit === null ? "" : `&unit=${encodeURIComponent(unit)}`}`,
    );
  }
  const window = resolved ?? "1d";
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
      {/* `docs/clone-map.md` §2: the title and the controls share one row, the
          way `KOL Leaderboard` and its two pill groups do on the mould. They
          were in the site header until 2026-09-02. */}
      <div className="page-head is-row">
        {/* **The title alone**, the way `KOL Leaderboard` sits on the mould's
            controls row (`docs/parecido-2026-09-02.md` §2). The subtitle said
            `PnL realizado · <ventana> · SOL`: the window is on the toggle two
            centimetres to its right, and SOL stopped varying when the toggle
            became a currency. It was naming things that name themselves. */}
        {/*
          **`KOL Leaderboard`** — the mould's own title, kept in English by the
          owner's decision of 2026-09-05. It superseded `Clasificación de KOLs`,
          which `DESIGN.md` and `docs/copy.md` had required; both now record the
          change and why.

          The **route does not move**: `/leaderboard` still redirects here and
          `Clasificación` survives in identifiers, in `WINDOW_MEANINGS` and in
          prose. What changed is the name on the screen, and only that.
        */}
        <h1 className="page-title">KOL Leaderboard</h1>
        <LeaderboardControls windows={LEADERBOARD_WINDOWS} fiats={LEADERBOARD_FIATS} />
      </div>

      {/* **No `panel` around the ranking.** The mould's rows sit straight on the
          canvas at the container's own edge — measured x=224, 992 wide at 1440
          — while ours were inset inside a bordered card, so they started at 257
          and ran 926. Each row is already a card with its own border and
          radius; the panel was a second box around a list of boxes, and it cost
          the list 66px of the width the brief measured. */}
      {/* 26px between the title row and the first card, measured on the mould.
          It was `--stack` (12). See `.page-head` for the whole rhythm. */}
      <section style={{ marginTop: "26px" }}>
        {/* `KolModalHost` provides `KolModalContext`, which is what makes each
            row clickable and focusable — DESIGN.md `row-leaderboard`, "it opens
            the modal". It is handed this page's window so a modal opens on the
            period its row was ranked in. */}
        <KolModalHost window={window} fiat={fiat} rate={rate}>
          <LeaderboardTable
            entries={leaderboard.entries}
            fiat={fiat}
            rate={rate}
            window={window}
            closed={leaderboard.closed}
          />
        </KolModalHost>
      </section>

      {/*
        **The qualifiers, at the foot of the page.** They sat directly above the
        first row until 2026-09-03; the mould puts nothing between its title and
        its list, and the owner's brief moved them here.

        They are still *on the page* and still not behind a hover, which is what
        spec §4.1 and §4.9 actually require: `día UTC` because the community
        spans UTC−6 to UTC+1 and any local choice hands the day to one country,
        and the USD caveat unconditionally, because the peso figure is derived
        from the dollar one and inherits its incompleteness.

        The peso line names the rate, the casa and the moment it was quoted — a
        converted figure without them is a number pretending to be a fact
        (`docs/round-ars.md` §3). With no rate to name it says that instead, and
        the figures above read `sin precio`.
      */}
      <footer className="page-note">
        {/*
          **The feed's only door, since `Live` left the nav.**

          The nav is the mould's two items now (`● Trade  Cabals`), and this
          product has a live feed they do not. `site-nav.tsx` kept it in the nav
          precisely so the page would not be orphaned; this is what replaces
          that, and it is why removing the nav item was safe to do.
        */}
        <p className="label">
          <Link className="panel-link" href="/en-vivo">
            Ver el feed en vivo →
          </Link>
        </p>
        <p className="label">
          día UTC · {USD_CAVEAT}
          {fiat === "ars" && ` · ${ARS_CAVEAT}`}
        </p>
        {fiat === "ars" && (
          /*
            **La cotización vieja se muestra igual, con el aviso.** `fx.ts`
            separa dos umbrales: a las 6 h la cifra queda marcada como
            desactualizada y se sigue mostrando; a las 96 h `readArsRate`
            devuelve `null` y no hay cifra que mostrar. Ninguno de los dos
            imprime un cero — un total en pesos sin cotización detrás es una
            invención, y el cero es la más convincente que hay a mano.

            El `title` es el tooltip que pidió el dueño (`blue $X · actualizado
            hace N min`), y lo arma `arsTooltip` para que la frase viva en un
            solo lugar.
          */
          <p className="label" title={rate === null ? undefined : arsTooltip(rate)}>
            {rate === null
              ? "Sin tipo de cambio vigente: los importes en ARS no se pueden calcular."
              : `1 US$ = ${formatArsRate(rate.rate)} ARS · ${ARS_SOURCE_LABELS[rate.source]} · ${formatUtcMoment(rate.asOf)}`}
            {rate?.stale === true && (
              <span className="state-unpriced"> · cotización desactualizada</span>
            )}
          </p>
        )}
      </footer>
    </>
  );
}
