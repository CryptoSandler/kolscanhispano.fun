import Link from "next/link";
import {
  LEADERBOARD_UNITS,
  parseUnit,
  readLeaderboard,
  type LeaderboardUnit,
} from "@/lib/leaderboard";
import { LEADERBOARD_WINDOWS, parseWindow, type LeaderboardWindow } from "@/lib/windows";
import { LeaderboardTable, USD_CAVEAT } from "../leaderboard-table";

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
    <section className="panel" style={{ marginTop: "var(--stack)" }}>
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
        The qualifier line: everything a reader needs to know about the figures
        before reading them, directly above them.

        `día UTC` is spec §4.9 and DESIGN.md's `segmented-window` — it sits
        under the control because the reader choosing a window is the reader
        who needs to know where its boundary falls. The community spans UTC−6
        to UTC+1 and any local choice would hand the day to one country.

        The USD caveat is spec §4.1, and it is here **unconditionally**. It
        used to be conditional on `unit === "usd"`, which left the secondary
        USD column unlabelled on this page and the home panel's USD column
        unlabelled entirely; this table always prints a USD amount, as the
        ranked column or as the one in parentheses. See `USD_CAVEAT`.
      */}
      <p className="label control-note">día UTC · {USD_CAVEAT}</p>

      {/* Spec §4.8's definition is written by `LeaderboardTable`, beneath the
          column it defines. */}
      <LeaderboardTable entries={leaderboard.entries} unit={unit} />
    </section>
  );
}
