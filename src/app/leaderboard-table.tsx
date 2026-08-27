import type { LeaderboardUnit } from "@/lib/leaderboard";
import { Avatar } from "./avatar";
import { formatPercent, formatSignedSol, formatSignedUsd } from "@/lib/format";
import type { PublicLeaderboardEntry } from "@/lib/serialize";

/**
 * DESIGN.md `row-leaderboard`, as a real `<table>`.
 *
 * Fixed column widths through `<colgroup>` and `table-layout: fixed`, because
 * DESIGN.md's rule is that a figure never reflows as data updates: with
 * automatic layout a KOL crossing from `9,99` to `10,01 SOL` widens its column
 * and shifts every row on the page.
 *
 * Ranks 1–3 carry a 2px cyan bar on the left edge. No medal, no trophy, no
 * emoji — DESIGN.md forbids all three by name, and spec §2's "ranks 1–3 get
 * medals" is a description of the reference sites, which the design document
 * deliberately departs from.
 *
 * A server component: it holds no state, and everything it renders is already
 * on the server by the time the page is built.
 */
export function LeaderboardTable({
  entries,
  unit,
  showHeader = true,
}: {
  entries: PublicLeaderboardEntry[];
  unit: LeaderboardUnit;
  /**
   * The home page's top-ten summary drops the header row. Not for taste: the
   * whole argument for this design is that ten leaderboard rows and eight feed
   * rows fit one 900px viewport, and the header row is 25px of that budget
   * with a caption beneath the table already naming both count columns. The
   * full page keeps it.
   */
  showHeader?: boolean;
}) {
  /*
    DESIGN.md, "Every surface has two states". The empty state stays inside the
    panel and the hairline the table sits in, and says what will be here without
    apologising — two lines, verbatim from that document's table. The caption
    below the table goes with the table: it defines a column that is not there.

    **Why the condition is "nothing closed", not "no rows".** Two normative
    documents look like they contradict each other here and do not; they answer
    different questions.

    Spec §2 — *"inactive approved KOLs stay in the list at zero — the roster is
    part of the point"* — is about a roster that exists. A KOL who is approved
    and did not trade this window is information about that KOL, and the zeros
    are legible precisely because other rows carry real figures.

    DESIGN.md — *"no zeroed rows, no ghost placeholders"*, with the measured case
    that *"kolscan.io's leaderboard was captured twice showing fifty rows of
    `+0.00 Sol` from a stalled indexer, which reads as fifty traders who all
    broke exactly even"* — is about a surface with no data at all, where every
    row is zero and the page as a whole asserts a measurement nobody made.

    So the discriminator is whether **anything closed in this window**. If no
    entry has a closed episode the table is entirely zeros and carries nothing,
    and the empty state is the honest render. If even one entry has one, every
    row goes out including the zeros — that is spec §2's roster, and a zero
    beside a real figure means something.

    The signal is `winRate === null`, which `serialize.ts` defines as *"`null`
    when nothing closed in the window"*. It is the same field the row below uses
    to print `sin cierres`, so the panel-level rule and the cell-level rule read
    off one value and cannot drift apart. `entries.every` also covers the
    no-approved-KOL case, where it is vacuously true.
  */
  if (entries.every((entry) => entry.winRate === null)) {
    return (
      <div className="state-empty">
        <p className="state-empty-lead">Todavía no hay operaciones cerradas.</p>
        <p className="state-empty-note">
          Aquí va el ranking por PnL realizado del período, en cuanto los KOL del padrón cierren su
          primera posición.
        </p>
      </div>
    );
  }

  return (
    <>
      <table className="leaderboard">
        <colgroup>
          <col className="col-rank" />
          <col className="col-kol" />
          <col className="col-closed" />
          <col className="col-rate" />
          <col className="col-primary" />
          <col className="col-secondary" />
        </colgroup>
        {showHeader && (
          <thead>
            <tr>
              <th scope="col" className="label">
                #
              </th>
              <th scope="col" className="label">
                KOL
              </th>
              <th scope="col" className="label num-head">
                Cerradas
              </th>
              <th scope="col" className="label num-head">
                % ganadas
              </th>
              <th scope="col" className="label num-head">
                {unit === "sol" ? "PnL realizado (SOL)" : "PnL realizado (USD)"}
              </th>
              <th scope="col" className="label num-head">
                {unit === "sol" ? "USD" : "SOL"}
              </th>
            </tr>
          </thead>
        )}
        <tbody>
          {entries.map((entry) => (
            <Row key={entry.kol.slug} entry={entry} unit={unit} />
          ))}
        </tbody>
      </table>

      {/*
        Spec §4.8: the definition, stated, rather than a bare percentage. When
        the header row is off, this line names the count columns as well.
      */}
      <p className="label table-note">
        {showHeader
          ? "% ganadas = posiciones cerradas ganadoras / posiciones cerradas"
          : "Cerradas = ganadas / perdidas · % ganadas = posiciones cerradas ganadoras / posiciones cerradas"}
      </p>

    </>
  );
}

/**
 * The USD caveat. One sentence, `es-ES`, and it goes on **every** surface that
 * renders a USD figure — which is every leaderboard, because the table always
 * prints a USD amount: as the ranked column when `unit === "usd"`, and as the
 * secondary column in parentheses when it does not. It used to appear only on
 * `/leaderboard?unit=usd`, which left the secondary column unlabelled there
 * and the home panel's USD column unlabelled entirely. An unlabelled figure
 * that is *systematically overstated* is the exact case the sentence exists
 * for.
 *
 * Why it is overstated: spec §4.1 fixes the USD value of a trade at its block
 * time. A trade whose block was not covered by a `sol_price` row contributes
 * nothing to the USD side, while a later, priced sell of the same position
 * still gives up its share of the cost. SOL has no equivalent failure.
 *
 * It is rendered by the callers rather than by this component, and both put it
 * on the qualifier line **above** the table, beside the window and `día UTC`:
 * those lines already exist, so the sentence costs no height, and the home
 * page's whole argument is what fits in 900px. On the page, in DESIGN.md's
 * `label` token, never behind a hover — a caveat you have to point at is a
 * figure published without one.
 */
export const USD_CAVEAT =
  "USD derivado del precio de SOL en el momento de cada operación; puede estar incompleto.";

function Row({ entry, unit }: { entry: PublicLeaderboardEntry; unit: LeaderboardUnit }) {
  const primaryText = unit === "sol" ? entry.realizedSol : entry.realizedUsd;
  const secondaryText = unit === "sol" ? entry.realizedUsd : entry.realizedSol;
  const primary = unit === "sol" ? formatSignedSol(primaryText) : formatSignedUsd(primaryText);
  const secondary =
    unit === "sol" ? formatSignedUsd(secondaryText) : formatSignedSol(secondaryText);

  // DESIGN.md: green and red mean direction of money and nothing else. A
  // window in which nothing was realized is neither, so it stays ink.
  const direction = signum(primaryText);

  return (
    <tr className={entry.rank <= 3 ? "row-leaderboard is-podium" : "row-leaderboard"}>
      <td className="num rank">{entry.rank}</td>
      <td className="kol">
        {/* The flex row lives in a span, not on the `td`: `display: flex` on a
            table cell takes it out of table layout, and the fixed column
            widths go with it. */}
        <span className="kol-cell">
          <Avatar name={entry.kol.name} src={entry.kol.avatarUrl} />
          {/* Plain text, not a link: `/kol/<slug>` is a later task, and a
              name that navigates to a 404 is worse than a name that does not
              navigate. The feed row reads the same way for the same reason. */}
          <span className="kol-name">{entry.kol.name}</span>
          {entry.kol.cabalTag && <span className="chip-cabal">{entry.kol.cabalTag}</span>}
          {/* The X handle is the KOL's public persona (spec §6), not a wallet:
              nothing about publishing it touches the hidden-wallet promise. */}
          <a
            className="x-link"
            href={`https://x.com/${encodeURIComponent(entry.kol.xHandle)}`}
            target="_blank"
            rel="noreferrer noopener"
            aria-label={`Perfil de ${entry.kol.name} en X`}
          >
            {/* A plain capital X, not U+1D54F. The double-struck glyph spec §2
                sketches the row with is absent from Inter and falls back to
                whatever the system has, which rendered a hairline mark half the
                size of everything beside it. */}
            X
          </a>
        </span>
      </td>
      <td className="num closed">
        {entry.wins} / {entry.losses}
      </td>
      <td className={entry.winRate === null ? "rate" : "num rate"}>
        {/*
          Spec §4.8 counts closed positions, and a rate over none of them is
          undefined rather than zero. `0 %` beside `0 / 0` looked consistent
          and still said something false: it is the shape of a KOL who closed
          nine positions and lost all nine. Said in words, the way DESIGN.md's
          `state-unpriced` says a missing price.
        */}
        {entry.winRate === null ? (
          <span className="state-none">sin cierres</span>
        ) : (
          formatPercent(entry.winRate)
        )}
      </td>
      <td className={`num-lg pnl ${direction}`}>{primary}</td>
      <td className="num secondary">({secondary})</td>
    </tr>
  );
}

/**
 * The sign of a `numeric` string, without parsing it into anything. A leading
 * `-` is the only thing Postgres puts in front of a negative, and `0`, `0.00`
 * and `-0` all have to come out neutral.
 */
function signum(text: string): "gain" | "loss" | "" {
  if (/^-0*(\.0*)?$/.test(text)) return "";
  if (text.startsWith("-")) return "loss";
  return /^0*(\.0*)?$/.test(text) ? "" : "gain";
}
