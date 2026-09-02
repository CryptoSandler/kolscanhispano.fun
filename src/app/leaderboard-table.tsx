import { cabalChipClass } from "@/lib/cabal";
import type { LeaderboardFiat } from "@/lib/leaderboard";
import { Avatar } from "./avatar";
import { KolRow } from "./kol-row";
import { amountDirection, formatSignedArs, formatSignedSol, formatSignedUsd } from "@/lib/format";
import type { PublicLeaderboardEntry } from "@/lib/serialize";
import { usdToArs, type ArsRate } from "@/lib/fx";

/**
 * DESIGN.md `row-leaderboard`, as a `<ul>` of cards.
 *
 * **It was a `<table>` until 2026-09-02.** `docs/clone-map.md` §2 and §4: the
 * mould ranks in cards, and the table could not be made to fit 390px — its
 * fixed columns pushed the PnL, the figure the page is sorted by, off the right
 * edge behind a horizontal scroll. The cards wrap there instead; the CSS
 * carries the full reasoning and the reverted attempt.
 *
 * The rule the `<colgroup>` was there for survives as fixed grid **tracks**, so
 * a KOL crossing from `9,99` to `10,01 SOL` still reflows nothing.
 *
 * **No header row and no record column**, at either size: the mould has
 * neither. `Cerradas` and `% ganadas` came off the row on 2026-09-02 with the
 * rest of the clone decision.
 *
 * A server component. The one piece of client code on this surface is
 * {@link KolRow}, which wraps each `<li>` so the card can open the KOL modal;
 * the cells are passed to it as children and are still rendered here, on the
 * server.
 *
 * **The record columns are gone from the row and not from the data.**
 * `serialize.ts` still publishes `wins`, `losses` and `winRate`, because the
 * empty state below is keyed on `winRate === null` and `/api/leaderboard` is a
 * contract of its own. What changed is what the row prints.
 *
 * ponytail: the lazier version drops the three fields from the payload too. It
 * is not done because the empty-state rule needs one of them and the API has
 * its own consumers; the upgrade, if the record never comes back, is one
 * migration of the serializer and its contract test.
 */
export function LeaderboardTable({
  entries,
  fiat,
  rate,
}: {
  entries: PublicLeaderboardEntry[];
  /** Which currency the parenthesised total is printed in. */
  fiat: LeaderboardFiat;
  /**
   * The peso rate, when `fiat` is `ars`. `null` — no rate stored, or one too
   * old to believe — makes every peso figure `sin precio` rather than a number
   * computed from last week's dollar. See `src/lib/fx.ts`.
   */
  rate: ArsRate | null;
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
    when nothing closed in the window"*. The row stopped printing a rate on
    2026-09-02, so this is now the only place that field is read on this
    surface — it is the cheapest true answer to "did anything close in this
    window", not a leftover of the column that is gone. `entries.every` also
    covers the no-approved-KOL case, where it is vacuously true.
  */
  if (entries.every((entry) => entry.winRate === null)) {
    return (
      <div className="state-empty">
        <p className="state-empty-lead">Todavía no hay operaciones cerradas.</p>
        <p className="state-empty-note">
          Aquí va la clasificación por PnL realizado del período, en cuanto los KOL del padrón
          cierren su primera posición.
        </p>
      </div>
    );
  }

  return (
    <>
      {/*
        A list, and read as one. Each card is a `<li>`; `KolRow` keeps the
        listitem semantics rather than taking `role="button"`, for the same
        reason it kept the row semantics when this was a table — see there.
      */}
      <ul className="board">
        {entries.map((entry) => (
          <Row key={entry.kol.slug} entry={entry} fiat={fiat} rate={rate} />
        ))}
      </ul>
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
export const ARS_CAVEAT =
  "ARS convertido del total en USD al tipo de cambio de referencia; no es una medición.";

/**
 * The peso's own sentence, and why it is separate from {@link USD_CAVEAT}
 * rather than folded into it.
 *
 * They are two different admissions. The dollar figure may be **incomplete**,
 * because a trade whose block had no `sol_price` row contributes nothing to it.
 * The peso figure inherits that and adds one of its own: it is a **conversion**
 * of a total, at one rate, taken at one moment — not the sum of each day's
 * trades at that day's rate, which is what a reader might reasonably assume a
 * peso PnL to be. `docs/round-ars.md` §3 fixes that arithmetic; this line is
 * what says so on the page.
 */
export const USD_CAVEAT =
  "USD derivado del precio de SOL en el momento de cada operación; puede estar incompleto.";

/**
 * The podium glyphs, per rank.
 *
 * **They were a tinted `★` until 2026-09-02.** DESIGN.md read *"three tints,
 * not three metals"*, which ruled an emoji out twice over — it carries its own
 * colour, so it can be neither tinted nor kept out of the green and red that
 * document reserves for money. The owner's clone decision overruled it and
 * DESIGN.md was rewritten rather than worked around: the mould's own 🏆🥈🥉,
 * which are Unicode and nobody's asset (`docs/clone-map.md`, exception c).
 *
 * The tints did not leave with the glyph — `podium-N` still paints the left bar
 * and the wash, which is where the rank now reads from. The emoji's colours are
 * therefore the only ones in this system that answer to nothing, and they are
 * confined to a box that carries no figure.
 *
 * They are outside the latin subset `next/font` loads, so the browser resolves
 * them from the system emoji face. That is glyph fallback, not a second
 * typeface: no rule in this codebase declares a font for them.
 */
const MEDALS = { 1: "🏆", 2: "🥈", 3: "🥉" } as const;

function Row({
  entry,
  fiat,
  rate,
}: {
  entry: PublicLeaderboardEntry;
  fiat: LeaderboardFiat;
  rate: ArsRate | null;
}) {
  /*
    **SOL is always the ranked figure**, and the toggle only decides the
    currency in parentheses — the mould's arrangement, and what `ORDERED` in
    `leaderboard.ts` now sorts by unconditionally. Until 2026-09-02 the toggle
    swapped the two, which is why the pair used to be computed from `unit`.

    The peso is a **display conversion** of the USD total at one rate
    (`docs/round-ars.md`), never a second measurement: the same figure, in
    another currency, with the rate and its date printed above the list.
  */
  const secondary =
    fiat === "usd"
      ? formatSignedUsd(entry.realizedUsd)
      : rate === null
        ? null
        : formatSignedArs(usdToArs(entry.realizedUsd, rate.rate));
  const primary = formatSignedSol(entry.realizedSol);

  // DESIGN.md: green and red mean direction of money and nothing else. A
  // window in which nothing was realized is neither, so it stays ink. The rule
  // lives in `format.ts` because the modal colours its header by the same one.
  const direction = amountDirection(entry.realizedSol);
  const podium = entry.rank <= 3 ? (entry.rank as 1 | 2 | 3) : null;

  return (
    <KolRow name={entry.kol.name} slug={entry.kol.slug} podium={podium}>
      {/* The rank: the medal on the podium, a plain numeral below it — the
          mould's arrangement, and the owner's decision of 2026-09-02. It was
          `001` in a zero-padded three-digit box; padding a numeral to a width
          the roster has not reached says something about the roster that is not
          true.

          The box is a fixed grid track, so a numeral and a medal occupy the
          same width and nothing shifts between windows. The medal is
          `aria-hidden`: the position is already in the list order and in the
          modal's accessible name, and a screen reader reading "trophy" adds a
          metaphor rather than a fact. */}
      <span className="rank-cell">
        {podium === null ? (
          <span className="num rank-num">{entry.rank}</span>
        ) : (
          <span className="medal" aria-hidden="true">
            {MEDALS[podium]}
          </span>
        )}
      </span>
      <span className="identity">
        <Avatar name={entry.kol.name} src={entry.kol.avatarUrl} size={36} />
        {/*
          **One line, not two**, since 2026-09-02: name, handle, the hidden
          marker and the cabal chip, in that order — the mould's arrangement
          (`docs/clone-map.md` §3), which reads `name`, chip, `𝕏`, then a
          truncated address or `Wallets Ocultas`.

          Two of those four are ours and stay. The **handle** is printed where
          theirs prints only a glyph: `docs/references.md` §6 — the handle is
          public identity and the wallet is the secret. `Wallets ocultas`
          occupies the address slot and nothing else, which is the whole of
          spec §7's "Spanish label wherever a wallet would otherwise appear";
          `hide_wallets` defaults to `TRUE`, so treating it as a handle switch
          would erase the person from almost every row. That correction was
          made in `b0f2a43` and survives the change of shape: the handle and
          the marker are **not alternatives**, they are two things on one line.

          The row stays 56px. The two-line block was what that height was
          originally for; the 36px avatar is what keeps it now.
        */}
        <span className="identity-line">
          {/* The name is **not** the link, and that is deliberate: `KolRow`
              excludes anything inside an `<a>` from opening the modal, so a
              linked name would take the row's largest click target away from
              the thing the row is for. The handle is the link, as it was when
              this block had two lines. */}
          <span className="name">{entry.kol.name}</span>
          <a
            className="handle"
            href={`https://x.com/${encodeURIComponent(entry.kol.xHandle)}`}
            target="_blank"
            rel="noreferrer noopener"
            aria-label={`Perfil de ${entry.kol.name} en X`}
          >
            @{entry.kol.xHandle}
          </a>
          {entry.kol.hideWallets && <span className="hidden-wallets">Wallets ocultas</span>}
          {/* DESIGN.md `chip-cabal`: the tint is per cabal and decided by the
              tag alone, so the row and the modal's header cannot disagree
              about which colour a cabal is. See `src/lib/cabal.ts`. */}
          {entry.kol.cabalTag && (
            <span className={cabalChipClass(entry.kol.cabalTag)}>{entry.kol.cabalTag}</span>
          )}
        </span>
      </span>
      <span className={`num-lg pnl ${direction}`}>{primary}</span>
      {/* DESIGN.md, `state-unpriced`: `sin precio`, never a dash and never a
          zero. A peso figure with no rate behind it is the same absence as a
          SOL amount with no price. */}
      <span className="num secondary">
        {secondary === null ? <span className="state-unpriced">sin precio</span> : `(${secondary})`}
      </span>
    </KolRow>
  );
}
