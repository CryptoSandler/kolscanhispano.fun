import { cabalChipClass } from "@/lib/cabal";
import type { LeaderboardUnit } from "@/lib/leaderboard";
import { Avatar } from "./avatar";
import { KolRow } from "./kol-row";
import { formatPercent, formatSignedSol, formatSignedUsd } from "@/lib/format";
import type { PublicLeaderboardEntry } from "@/lib/serialize";

/**
 * DESIGN.md `row-leaderboard`, as a real `<table>`.
 *
 * Fixed column widths through `<colgroup>` and `table-layout: fixed`, because
 * DESIGN.md's rule is *"fixed column widths so a live update never reflows a
 * table"*: with automatic layout a KOL crossing from `9,99` to `10,01 SOL`
 * widens its column and shifts every row on the page.
 *
 * A server component. The one piece of client code on this surface is
 * {@link KolRow}, which wraps each `<tr>` so the row can open the KOL modal;
 * the cells are passed to it as children and are still rendered here, on the
 * server.
 *
 * **The row carries two columns DESIGN.md's `row-leaderboard` paragraph does
 * not enumerate** — `Cerradas` and `% ganadas`. That paragraph is not
 * exhaustive: the same document's *"Every surface has two states"* table lists
 * `| row, no closed episodes | win rate | sin cierres |`, which only means
 * something if the populated row prints a win rate. `docs/references.md` §6
 * settles the pair the same way, taking kolscan.io's record column —
 * *"**kolscan.io.** We compute win rate, and `sin cierres` covers its
 * absence"*.
 */
export function LeaderboardTable({
  entries,
  unit,
  showHeader = true,
}: {
  entries: PublicLeaderboardEntry[];
  unit: LeaderboardUnit;
  /**
   * The home page's top-ten summary drops the header row: `/leaderboard` is
   * where a reader goes to compare columns, and the caption beneath the table
   * already names both count columns.
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

    DESIGN.md — *"above all **no zeroed rows**: kolscan.io was captured twice
    showing fifty rows of `+0.00 Sol` from a stalled indexer, which reads as
    fifty traders who all broke exactly even"* — is about a surface with no data
    at all, where every row is zero and the page as a whole asserts a
    measurement nobody made.

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
 * one in parentheses when it does not.
 *
 * Why it is overstated: spec §4.1 fixes the USD value of a trade at its block
 * time. A trade whose block was not covered by a `sol_price` row contributes
 * nothing to the USD side, while a later, priced sell of the same position
 * still gives up its share of the cost. SOL has no equivalent failure.
 *
 * It is rendered by the callers rather than by this component, and both put it
 * on the qualifier line **above** the table, beside the window and `día UTC`.
 * On the page, in DESIGN.md's `label` token, never behind a hover — a caveat
 * you have to point at is a figure published without one.
 */
export const USD_CAVEAT =
  "USD derivado del precio de SOL en el momento de cada operación; puede estar incompleto.";

/**
 * DESIGN.md: *"the medal glyph in the matching `podium-N`"*, and, in Colors,
 * *"The podium is three tints, not three metals."* A tinted glyph is therefore
 * required and an emoji medal is ruled out twice over — it carries its own
 * colour, so it can be neither tinted nor kept out of the green/red the same
 * document reserves for money. `★` takes `currentColor`.
 *
 * It is outside the latin subset `next/font` loads, so the browser resolves it
 * from a system face. That is glyph fallback, not a second typeface: no rule in
 * this codebase declares a font for it.
 */
const MEDAL = "★";

function Row({ entry, unit }: { entry: PublicLeaderboardEntry; unit: LeaderboardUnit }) {
  const primaryText = unit === "sol" ? entry.realizedSol : entry.realizedUsd;
  const secondaryText = unit === "sol" ? entry.realizedUsd : entry.realizedSol;
  const primary = unit === "sol" ? formatSignedSol(primaryText) : formatSignedUsd(primaryText);
  const secondary =
    unit === "sol" ? formatSignedUsd(secondaryText) : formatSignedSol(secondaryText);

  // DESIGN.md: green and red mean direction of money and nothing else. A
  // window in which nothing was realized is neither, so it stays ink.
  const direction = signum(primaryText);
  const podium = entry.rank <= 3 ? (entry.rank as 1 | 2 | 3) : null;

  return (
    <KolRow name={entry.kol.name} slug={entry.kol.slug} podium={podium}>
      <td>
        {/* The flex row lives in a span, not on the `td`: `display: flex` on a
            table cell takes it out of table layout, and the fixed column
            widths go with it. */}
        <span className="rank-cell">
          {/* DESIGN.md: "rank as zero-padded `numeric`". It does not fix the
              width; three digits is what `docs/references.md` §6 captured
              (`001.`) on the site the owner chose the podium from, and it is
              the width at which a roster that grows past 99 does not change
              shape. */}
          <span className="num rank-num">{String(entry.rank).padStart(3, "0")}</span>
          {/* Rendered on every row so the podium glyph does not shift the rank
              column by its own width on ranks 1-3. */}
          <span className={podium === null ? "medal" : `medal medal-${podium}`} aria-hidden="true">
            {podium === null ? "" : MEDAL}
          </span>
        </span>
      </td>
      <td>
        <span className="identity">
          <Avatar name={entry.kol.name} src={entry.kol.avatarUrl} size={36} />
          <span className="identity-lines">
            <span className="name">{entry.kol.name}</span>
            {/*
              DESIGN.md, `row-leaderboard`: "beneath it the **`@handle`,
              always**, linked to X, with `Wallets ocultas` in `hidden`
              **beside it** where that KOL's wallets are hidden."

              That paragraph was corrected in `b0f2a43`, and this row was built
              against the draft it replaced: "The handle and the hidden marker
              are **not alternatives**, and an earlier draft of this document
              wrongly wrote them as one. On both references a row carries a
              handle *and* an identity chip that is either a truncated address
              or `Wallets Ocultas`: the handle is public identity, the wallet is
              the secret. `hide_wallets` defaults to `TRUE` here, so treating it
              as a handle switch would erase the person from almost every row."

              So `hideWallets` decides the *address slot* and nothing else, and
              spec §7's "Spanish label wherever a wallet would otherwise appear"
              is exactly that slot. The handle is the KOL's public persona
              (spec §6) and is never withheld.
            */}
            <span className="identity-second">
              <a
                className="handle"
                href={`https://x.com/${encodeURIComponent(entry.kol.xHandle)}`}
                target="_blank"
                rel="noreferrer noopener"
                aria-label={`Perfil de ${entry.kol.name} en X`}
              >
                @{entry.kol.xHandle}
              </a>
              {entry.kol.hideWallets && (
                <span className="hidden-wallets">Wallets ocultas</span>
              )}
            </span>
          </span>
          {/* DESIGN.md `chip-cabal`: the tint is per cabal and decided by the
              tag alone, so the row and the modal's header cannot disagree
              about which colour a cabal is. See `src/lib/cabal.ts`. */}
          {entry.kol.cabalTag && (
            <span className={cabalChipClass(entry.kol.cabalTag)}>{entry.kol.cabalTag}</span>
          )}
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
      {/* DESIGN.md: "right-aligned, the SOL figure in `numeric-lg` coloured by
          sign, and the USD total in `numeric` `ink-muted` in parentheses." The
          unit toggle swaps which of the two is the ranked figure; the shape —
          large and signed, then small and parenthesised — does not move. */}
      <td className={`num-lg pnl ${direction}`}>{primary}</td>
      <td className="num secondary">({secondary})</td>
    </KolRow>
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
