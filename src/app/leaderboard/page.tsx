import Link from "next/link";
import {
  LEADERBOARD_UNITS,
  parseUnit,
  readLeaderboard,
  type LeaderboardUnit,
} from "@/lib/leaderboard";
import { LEADERBOARD_WINDOWS, parseWindow, type LeaderboardWindow } from "@/lib/windows";
import { LeaderboardTable } from "../leaderboard-table";

/** The window is relative to now and the rows behind it change as trades land. */
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Clasificación · kolscanhispano.fun",
  description: "PnL realizado de KOLs hispanohablantes en Solana, por día, semana y mes UTC.",
};

const WINDOW_LABELS: Record<LeaderboardWindow, string> = {
  diario: "Diario",
  semanal: "Semanal",
  mensual: "Mensual",
};

const UNIT_LABELS: Record<LeaderboardUnit, string> = { sol: "SOL", usd: "USD" };

type SearchParams = Record<string, string | string[] | undefined>;

function first(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

/**
 * Spec §2: ranked realized PnL, with `Diario / Semanal / Mensual` and
 * `SOL / USD`.
 *
 * The toggles are links, not a client component. Every combination is a real
 * URL, so the state survives a reload, a share and a back button, and the page
 * costs no JavaScript at all — the only script this product ships is the
 * feed's poll.
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

  const href = (next: { window?: LeaderboardWindow; unit?: LeaderboardUnit }) =>
    `/leaderboard?window=${next.window ?? window}&unit=${next.unit ?? unit}`;

  return (
    <section className="panel" style={{ marginTop: "var(--gutter)" }}>
      <div className="panel-head">
        <h1 className="headline">Clasificación</h1>
        <span className="label">PnL realizado</span>
      </div>

      <div className="controls">
        <div className="segmented" role="group" aria-label="Ventana">
          {LEADERBOARD_WINDOWS.map((option) => (
            <Link
              key={option}
              className={option === window ? "segment is-selected" : "segment"}
              aria-current={option === window ? "true" : undefined}
              href={href({ window: option })}
            >
              {WINDOW_LABELS[option]}
            </Link>
          ))}
        </div>

        <div className="segmented" role="group" aria-label="Unidad">
          {LEADERBOARD_UNITS.map((option) => (
            <Link
              key={option}
              className={option === unit ? "segment is-selected" : "segment"}
              aria-current={option === unit ? "true" : undefined}
              href={href({ unit: option })}
            >
              {UNIT_LABELS[option]}
            </Link>
          ))}
        </div>
      </div>

      {/*
        Spec §4.9, and DESIGN.md's `segmented-window`: the footnote sits under
        the control, because the reader who is choosing a window is the reader
        who needs to know where its boundary falls. The community spans UTC−6
        to UTC+1 and any local choice would hand the day to one country.
      */}
      <p className="label control-note">día UTC</p>

      {/*
        Spec §4.1 makes USD derived from the SOL price at each trade, and the
        derivation has a hole: a trade whose block was not covered by a
        `sol_price` row contributes nothing to the USD side, while a later,
        priced sell of the same position still gives up its share of the cost.
        The USD total is therefore overstated for anyone who traded through a
        gap. SOL has no equivalent failure, so the caveat appears only where it
        applies — and as text on the page, not as a tooltip: a figure whose
        caveat is hidden behind a hover is a figure published without it.
      */}
      {unit === "usd" && (
        <p className="label control-note">
          USD derivado del precio de SOL en el momento de cada operación; puede estar incompleto.
        </p>
      )}

      <LeaderboardTable entries={leaderboard.entries} unit={unit} />

      {/*
        Spec §4.8: the definition, stated, rather than a bare percentage. A
        position counts once, when 95 % of what was acquired has been sold, and
        it is a win if that episode's realized PnL is positive.
      */}
      <p className="label table-note">
        % ganadas = posiciones cerradas ganadoras / posiciones cerradas
      </p>
    </section>
  );
}
