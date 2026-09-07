import Link from "next/link";
import { readCabals } from "@/lib/cabals";
import { readArsRate } from "@/lib/fx";
import { LEADERBOARD_FIATS, parseFiat } from "@/lib/leaderboard";
import { permanentRedirect } from "next/navigation";
import { LEADERBOARD_WINDOWS, WINDOW_LABELS, resolveWindow } from "@/lib/windows";
import { LeaderboardControls } from "../leaderboard-controls";
import { ARS_CAVEAT, USD_CAVEAT } from "../leaderboard-table";
import { CabalsBoard } from "./board";

/** The window is relative to now and the rows behind it change as trades land. */
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Cabals",
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
 * control reads the query string and this page reads the same one.
 *
 * **El toggle de moneda vive acá también desde el 2026-09-05**, por decisión
 * del dueño. Antes no: el argumento era que un total de cabal es una cifra en
 * SOL con su equivalente en dólares al lado, igual que una tarjeta, y que la
 * conversión a pesos pertenecía a la página donde el lector la eligió. Lo que
 * ese argumento pasaba por alto es que el equivalente en dólares **es** lo que
 * el toggle convierte, y que la elección de moneda viaja en la query string:
 * un lector que puso la home en pesos y hace clic en `Cabals` no espera que
 * las cifras vuelvan a dólares por su cuenta.
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
  const fiat = parseFiat(first(params.unit)) ?? "usd";

  // La cotización solo se lee cuando se va a imprimir una cifra en pesos, y en
  // paralelo con el ranking: tocan tablas distintas y ninguna necesita el
  // resultado de la otra. Es el mismo razonamiento que la home.
  const [ranking, rate] = await Promise.all([
    readCabals({ window }),
    fiat === "ars" ? readArsRate() : Promise.resolve(null),
  ]);

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
        {/*
          **El grupo de moneda vuelve, por decisión del dueño del 2026-09-05.**

          Esta página se construyó sin toggle con el argumento de que cada cifra
          es un total en SOL con su equivalente en dólares al lado, así que no
          había nada que elegir. El equivalente en dólares es exactamente lo que
          el toggle convierte, en la home y acá: un lector que puso la home en
          pesos y entra a `/cabals` no espera que las cifras vuelvan a dólares
          solas.
        */}
        <LeaderboardControls
          windows={LEADERBOARD_WINDOWS}
          fiats={LEADERBOARD_FIATS}
          basePath="/cabals"
        />
      </div>

      <section className="panel" style={{ marginTop: "var(--stack)" }}>
        <p className="label control-note">
          {WINDOW_LABELS[window]} · día UTC · {USD_CAVEAT}
          {fiat === "ars" && ` · ${ARS_CAVEAT}`}
        </p>

        <CabalsBoard entries={ranking.entries} fiat={fiat} rate={rate} />

        {/*
          **El disclaimer legal, y éste es el único lugar donde queda.**

          Vivía en `/trade`, que se eliminó el 2026-09-06. Estuvo antes en el
          layout —o sea en todas las páginas— y ahí era mobiliario que nadie
          lee. Acá abajo, en una línea chica, es lo que la ley pide sin fingir
          que alguien lo va a leer dos veces.
        */}
        <p className="footnote">
          Datos on-chain públicos. Esto no es asesoramiento financiero y los resultados pasados no
          garantizan nada.
        </p>
      </section>
    </>
  );
}
