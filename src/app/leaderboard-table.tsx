import Link from "next/link";
import { cabalChipClass } from "@/lib/cabal";
import type { LeaderboardFiat } from "@/lib/leaderboard";
import { LEADERBOARD_WINDOWS, WINDOW_LABELS, type LeaderboardWindow } from "@/lib/windows";
import { Avatar } from "./avatar";
import { ChainAmounts } from "./chain-amounts";
import { WalletChip } from "./wallet-chip";
import { KolRow } from "./kol-row";
import { VerifiedTick } from "./verified-tick";
import type { PublicLeaderboardEntry } from "@/lib/serialize";
import type { ChainPnl } from "@/lib/chain-pnl";
import type { PublicWallet } from "@/lib/public-wallets";

/**
 * A row, plus the per-chain split `leaderboard.ts` attaches from its own
 * statement. `chains` is empty for a KOL who closed nothing, which is what
 * renders no columns rather than a line of zeroes.
 */
type RankedEntry = PublicLeaderboardEntry & {
  chains: ChainPnl[];
  /** Only `is_public` wallets ever reach here. See `public-wallets.ts`. */
  publicWalletList: PublicWallet[];
};
import { fiatTotal } from "@/lib/fiat-total";
import { arsTooltip, type ArsRate } from "@/lib/fx";

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
  window,
  closed,
}: {
  entries: RankedEntry[];
  /** Which currency the parenthesised total is printed in. */
  fiat: LeaderboardFiat;
  /**
   * Which window these rows were aggregated over. Only the empty state reads
   * it, and it needs it for both halves of what it says: *which* period closed
   * nothing, and which other two are one click away.
   */
  window: LeaderboardWindow;
  /** Whether anything closed in this window. See the note at the branch below. */
  closed: boolean;
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
  /*
    **The caller answers this now, and the reason is a bug this rule caused.**

    The discriminator was `entries.every((entry) => entry.winRate === null)`,
    and the long note above is still why "nothing closed" rather than "no rows"
    is the right question. What changed on 2026-09-03 is who answers it:
    `winRate` comes from `wins + losses`, which spec §4.8 counts per *closed
    position per day* — so on a rolling window it is zero by construction and
    every row's `winRate` is null even when the window is full. `?window=7d`
    rendered the empty state over thirteen KOLs with figures.

    `readLeaderboard` counts it in the statement it actually ran. The rule is
    unchanged; the inference is gone.
  */
  if (!closed) {
    return <EmptyWindow window={window} fiat={fiat} roster={entries.length} />;
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
 * **The empty window, as a designed state rather than an absence.**
 *
 * DESIGN.md, "Every surface has two states", and the owner's instruction of
 * 2026-09-03: *"nunca una lista vacía muda"*. It was one sentence and a
 * promise before that — true, and useless to the reader who most needs it: the
 * one who opened `Diario` at 09:00 UTC. That reader has three questions and the
 * old copy answered none of them. **Is the site broken? Is anybody here? Where
 * is the data?**
 *
 * So it answers all three, in that order:
 *
 * 1. **Which period closed nothing**, named. `Nadie cerró operaciones hoy
 *    todavía` cannot be misread as "there is nothing here"; `Todavía no hay
 *    operaciones cerradas` could, and did.
 * 2. **How many KOLs are in the roster.** A count is the cheapest proof that
 *    the roster loaded and the emptiness is about the day rather than about
 *    the site. Spec §2 — *"inactive approved KOLs stay in the list at zero —
 *    the roster is part of the point"* — is the same argument one layer up:
 *    when even the zeros are suppressed, the roster is what is left to show.
 * 3. **The other two windows, as links.** A day is empty far more often than a
 *    month, and the reader who wants to know whether anyone trades here should
 *    not have to find the toggle to answer it. The links carry the currency
 *    forward, so choosing `ARS` and then following one does not silently
 *    revert to dollars.
 *
 * With an empty roster there is no count to give and no other window that
 * would have rows either, so it says that instead and offers no links: a link
 * to a second empty page is a worse answer than a sentence.
 *
 * The count is `entries.length` and not a second query. `readLeaderboard`
 * returns one entry per approved KOL — the zeros included, which is exactly
 * what this branch establishes — so the roster is already in hand, and a
 * `SELECT count(*)` here would be a second read that can disagree with the
 * first.
 */
const NADIE_CERRO: Record<LeaderboardWindow, string> = {
  // Each names the **interval**, never a period: there is no word for "the last
  // 24 hours" that a reader would not hear as "today", and hearing it as today
  // is exactly the confusion these windows replaced.
  "1d": "Nadie cerró operaciones en las últimas 24 horas.",
  "7d": "Nadie cerró operaciones en los últimos 7 días.",
  "30d": "Nadie cerró operaciones en los últimos 30 días.",
};

function EmptyWindow({
  window,
  fiat,
  roster,
}: {
  window: LeaderboardWindow;
  fiat: LeaderboardFiat;
  roster: number;
}) {
  const others = LEADERBOARD_WINDOWS.filter((option) => option !== window);

  if (roster === 0) {
    return (
      <div className="state-empty is-card">
        <p className="state-empty-lead">El padrón todavía está vacío.</p>
        <p className="state-empty-note">
          Aquí va la clasificación por PnL realizado del período, en cuanto entre el primer KOL y
          cierre su primera posición.
        </p>
      </div>
    );
  }

  return (
    <div className="state-empty is-card">
      <p className="state-empty-lead">{NADIE_CERRO[window]}</p>
      <p className="state-empty-note">
        {roster === 1 ? "Hay 1 KOL en el padrón" : `Hay ${roster} KOLs en el padrón`}: en cuanto
        cierre una posición, aparece acá con su PnL realizado.
      </p>
      <p className="state-empty-actions">
        {others.map((option) => (
          <Link key={option} className="panel-link" href={`/?window=${option}&unit=${fiat}`}>
            Ver {WINDOW_LABELS[option].toLocaleLowerCase("es")}
          </Link>
        ))}
      </p>
    </div>
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
  entry: RankedEntry;
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
  const secondary = fiatTotal(entry.realizedUsd, fiat, rate);

  /*
    Whether anything in this row could be priced at all.

    A row with *some* unpriced chains still shows the quoted total — that is the
    owner's decision of 2026-09-05, and it is the same rule the ranking sorts by:
    a KOL ranks on what quotes. A row where **nothing** quotes has no total to
    show, and shows `(—)` rather than a zero.

    `chains.length === 0` is a KOL who closed nothing, which is a real zero and
    keeps its `(US$0,00)`.
  */
  const quoted =
    entry.chains.length > 0 && entry.chains.every((chain) => chain.realizedUsd === null)
      ? null
      : secondary;
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
        <Avatar name={entry.kol.name} src={entry.kol.avatarUrl} size={44} />
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
          {/* The chip sits against the name, as on the mould, so the two read
              as one identity rather than as a name and a badge. */}
          {entry.kol.cabalTag && (
            <span className={cabalChipClass(entry.kol.cabalTag)}>{entry.kol.cabalTag}</span>
          )}
          {/*
            **The glyph is the link and the handle is not in the row** —
            the mould's arrangement, and the owner's decision of 2026-09-05.

            It was printed here from `b0f2a43` until then, on the reasoning in
            `docs/references.md` §6 that the handle is public identity while the
            wallet is the secret. That reasoning still holds and the handle is
            still published — in the KOL's modal, where there is room for it. The
            row is what changed: at 1440 the extra text pushed the identity line
            into a second line on most rows, and the card grew from 76 to 84
            against a mould whose rows are 76 without exception.

            `aria-label` still names the person, so the link says whose profile
            it opens to somebody who cannot see the glyph.
          */}
          <a
            className="x-glyph"
            href={`https://x.com/${encodeURIComponent(entry.kol.xHandle)}`}
            target="_blank"
            rel="noreferrer noopener"
            aria-label={`Perfil de ${entry.kol.name} en X, @${entry.kol.xHandle}`}
          >
            𝕏
          </a>
          {/* `verified-tick.tsx` carries the reasoning: a tick means a signed
              tweet proved the handle, and a hand-seeded KOL never gets one. */}
          <VerifiedTick verified={entry.kol.verified} />
          {/*
            The address slot. Published wallets when the KOL opted them in
            (`is_public`, the owner\'s decision of 2026-09-05), `Wallets ocultas`
            otherwise — and `WalletChip` is handed nothing but public ones, so it
            cannot render a private address even by mistake.
          */}
          <WalletChip wallets={entry.publicWalletList} />
        </span>
      </span>
      {/*
        **One grid for the four figure slots**, so the fiat cannot slide left
        when a chain is missing. Measured in their DOM at 1440 on 2026-09-05:
        ETH x676 w120, BNB x796 w130, SOL x926 w130, fiat x1056 w140 — four
        fixed tracks ending exactly at the card's inner edge.

        They were two siblings until now, and `+12.50 SOL(+US$7.275,00)` in the
        capture is what that produced: the amounts sized to their content and
        the total butted straight against them.
      */}
      <span className="row-figures">
      {/* One amount per chain that produced a row, each with its own sign
          colour. Absent for every chain nothing was measured on — never
          `0.00`. With no EVM ingestion this renders a single SOL figure and
          the row is exactly what it was. */}
      <ChainAmounts chains={entry.chains} />
      {/* DESIGN.md, `state-unpriced`: `sin precio`, never a dash and never a
          zero. A peso figure with no rate behind it is the same absence as a
          SOL amount with no price. */}
      {/*
        **The parentheses carry the total of what could be priced, and no label.**

        The row said `SIN PRECIO` whenever any chain was unquoted, which put a
        caps label where every other row has a number and made one unpriced
        position shout louder than the figures beside it. The owner's decision of
        2026-09-05: the parenthesis shows the quoted total; when *nothing* quotes
        it shows `(—)`, muted; and the explanation — which position, in which
        unit, and why — belongs in the KOL's modal, not on a list row.

        `nunca en cero` still holds. `(—)` is not `US$0,00`: the dash says we
        made no measurement, the zero would say we measured nothing.
      */}
      {/* El tooltip de la cotización acompaña a la cifra que el lector mira,
          no solo al pie de la lista: `blue $X · actualizado hace N min`, y el
          aviso de desactualizada cuando corresponde. En dólares no hay nada
          que aclarar, así que no lleva `title`. */}
      <span
        className={`pnl-fiat${quoted === null ? " is-unquoted" : ""}`}
        title={fiat === "ars" && rate !== null ? arsTooltip(rate) : undefined}
      >
        {quoted === null ? "(—)" : `(${secondary})`}
      </span>
      </span>
    </KolRow>
  );
}
