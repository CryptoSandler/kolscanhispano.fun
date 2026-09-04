import { cabalChipClass } from "@/lib/cabal";
import { monthGrid, monthSummary } from "@/lib/calendar";
import { formatDecimal, parseDecimal } from "@/lib/decimal";
import {
  amountDirection,
  formatSignedSol,
  formatSignedUsd,
  formatSol,
  formatUsdPrice,
  formatUtcMoment,
} from "@/lib/format";
import type { PublicKolDetail, PublicTrade } from "@/lib/serialize";
import { Avatar } from "./avatar";

/**
 * The contents of DESIGN.md's `modal-kol`, given one KOL's period.
 *
 * *"Header: 64px avatar, `name`, cabal chip, `@handle` or `Wallets ocultas`,
 * and the period's total PnL in `numeric-lg` by sign. **Where the reference
 * prints a truncated address, we print nothing.** Then, in order:
 * `card-calendario-pnl` ... `card-stats` ... `card-chain-pnl` ...
 * `list-defi-trades`."*
 *
 * **It holds no state, reads no context and mounts nothing**, which is what
 * lets `renderToStaticMarkup` render it — so `address-invariant.test.ts` can
 * scan the modal's *open* state as emitted HTML, rather than trusting that a
 * component nobody has rendered keeps the promise the serializer keeps.
 * The dialog itself, the fetch and the focus handling are `kol-modal.tsx`'s.
 *
 * The window segments are passed in rather than built here, for the same
 * reason: they are the one interactive thing on the surface, and they belong to
 * whatever is holding the window.
 *
 * On the handle: `b0f2a43` corrected `row-leaderboard` to *"the **`@handle`,
 * always** ... with `Wallets ocultas` in `hidden` **beside it**"*, and the
 * `modal-kol` paragraph still carries the older "or" wording. They are one
 * identity block and the correction states the rule for both — *"the handle is
 * public identity, the wallet is the secret"* — so the modal renders it the way
 * the row does. Recorded in the batch report.
 */
export function KolDetail({
  detail,
  segments,
  calendarNav,
}: {
  detail: PublicKolDetail;
  /** The window control, owned by the caller. */
  segments?: React.ReactNode;
  /**
   * The calendar's `‹ septiembre 2026 ›`, owned by the caller for the same
   * reason `segments` is: it changes what the caller fetches, and this
   * component renders a payload rather than deciding which one to ask for.
   */
  calendarNav?: React.ReactNode;
}) {
  const direction = amountDirection(detail.realizedSol);

  /*
    The month's own total, summed here from the days the calendar carries
    rather than sent as a field.

    It is **not** the header's figure and must not be confused with it: the
    header sums the window, this sums the month on the card, and since
    2026-09-03 those are two different periods that a reader can put out of step
    on purpose by paging the calendar. Printing it is what keeps the card
    honest — a grid of days under a header that adds up something else, with no
    statement of what the days themselves come to, is the shape that invites a
    reader to add the header's number to the grid.

    `decimal.ts`'s scaled `bigint`, like every other sum in this product; a
    running total in a double is exactly where SOL figures start drifting.
  */
  const monthTotal = formatDecimal(
    detail.calendar.days.reduce((sum, day) => sum + parseDecimal(day.dailySol), 0n),
  );
  const monthDirection = amountDirection(monthTotal);
  const summary = monthSummary(detail.calendar.month, detail.calendar.days);

  return (
    <>
      <header className="modal-head">
        {/* DESIGN.md: "64px avatar" — from `/api/avatar/<kol_id>` like every
            other avatar on the site, never a hotlink and never keyed by an
            address. */}
        {/* **56px**, read off the mould's own `<img>` at 1440 on 2026-09-03 —
            it was 64 here, taken from a picture. From `/api/avatar/<kol_id>`
            like every other avatar on the site, never a hotlink and never keyed
            by an address. */}
        <Avatar name={detail.kol.name} src={detail.kol.avatarUrl} size={56} />

        {/*
          **Three lines, which is the mould's header exactly** (its DOM, same
          measurement): the name with its marks, then the handle with the
          period's PnL beside it, then the wallet line.

          The PnL moved *into* the second line from a slot of its own on the
          right. That is theirs, and it also reads better: the figure belongs to
          the KOL named two centimetres to its left, and a number alone against
          the far edge of a 768px card had nothing to attach to.
        */}
        <div className="modal-identity">
          <div className="identity-line">
            <h2 className="headline">{detail.kol.name}</h2>
            <a
              className="x-glyph"
              href={`https://x.com/${encodeURIComponent(detail.kol.xHandle)}`}
              target="_blank"
              rel="noreferrer noopener"
              aria-label={`Perfil de ${detail.kol.name} en X`}
            >
              𝕏
            </a>
            {detail.kol.cabalTag && (
              <span className={cabalChipClass(detail.kol.cabalTag)}>{detail.kol.cabalTag}</span>
            )}
          </div>

          <div className="identity-second">
            <span className="handle">@{detail.kol.xHandle}</span>
            {/* "the period's total PnL by sign". The USD equivalent follows the
                row's shape — parenthesised, one weight down — so the same pair
                of figures reads the same way on both surfaces. */}
            <span className={`num modal-pnl ${direction}`}>
              {formatSignedSol(detail.realizedSol)}
            </span>
            <span className="num secondary">({formatSignedUsd(detail.realizedUsd)})</span>
          </div>

          {/*
            The third line, where the mould puts a truncated address chip.

            **We put the wallet statement there instead**, which is exception
            (a) of DESIGN.md's clone rule — no address, ever, on a public
            surface — and it is the same information one level less specific:
            how much of this KOL's operation is on show. `DECISIONES.md`,
            2026-08-31: a count and a padlock, never a list.

            It was a card of its own in the left column until 2026-09-03. The
            brief moved it here, and it belongs here: it is an identity fact,
            not a measurement, and the two columns below are measurements.
          */}
          <WalletVisibility
            publicWallets={detail.publicWallets}
            privateWallets={detail.privateWallets}
            hideWallets={detail.kol.hideWallets}
          />
        </div>
      </header>

      {/* DESIGN.md `card-calendario-pnl`, and `docs/clone-map.md` §5's first
          block: their calendar heatmap, with our data in it. Full width, above
          the two columns, exactly as on the mould. */}
      <section className="card card-calendar">
        {/* The mould's head: the block's name with the **month's** total under
            it on the left, and the month control on the right. Measured on its
            DOM at 1440 — a 48px-tall flex row with a 12px gap. */}
        <div className="calendar-head">
          <div className="calendar-title">
            <h3 className="label">Calendario de PnL</h3>
            <p className={`calendar-total ${monthDirection}`}>{formatSignedSol(monthTotal)}</p>
          </div>
          {calendarNav}
        </div>

        <PnlCalendar month={detail.calendar.month} days={detail.calendar.days} />

        {/* The row under the grid, and the four things the mould prints in it.
            It renders only when the month closed something: a row reading
            `0 · 0 · sin mejor día · 0 d · 0 ventas` over an empty grid is five
            zeros asserting a measurement nobody made, which is the rule
            DESIGN.md states about zeroed rows one surface up. */}
        {detail.calendar.days.length > 0 && (
          <p className="calendar-summary label">
            <span className="gain">{summary.gainDays} en verde</span>
            <span className="loss">{summary.lossDays} en rojo</span>
            {summary.best !== null && <span>mejor {formatSignedSol(summary.best)}</span>}
            {summary.streak > 0 && (
              <span>racha {summary.streak} {summary.streak === 1 ? "día" : "días"}</span>
            )}
            <span>
              {detail.calendar.sells} {detail.calendar.sells === 1 ? "venta" : "ventas"}
            </span>
          </p>
        )}
      </section>

      {/* **The window control sits below the calendar card, right-aligned**,
          which is where the mould puts it (`docs/parecido-2026-09-02.md` §3).
          It was in the card's head. Below the card it reads as governing
          everything under it, which it does: the stats, the chain line and the
          trade list all move with it. */}
      <div className="window-row">{segments}</div>

      {/*
        Two columns below the calendar (`docs/clone-map.md` §5): the figures on
        the left, the trade list on the right. It was one column until
        2026-09-02.

        The wallet counts stay with the figures rather than moving to the right
        column, even though they explain the `PRIVADO` rows over there: they are
        a fact about the KOL, and the right column is a log. At 640px the two
        columns become one and the original order is restored, which puts them
        back above the list they explain.
      */}
      <div className="modal-columns">
        <div className="modal-column">
          {/* DESIGN.md `card-stats`: "PnL total, trades, volume." */}
          <section className="card card-stats">
            <Stat label="PnL total">
              <span className={`num ${direction}`}>{formatSignedSol(detail.realizedSol)}</span>
            </Stat>
            <Stat label="Trades">
              <span className="num">{detail.tradeCount}</span>
            </Stat>
            <Stat label="Volumen">
              {/* Turnover: the SOL both sides of every trade moved, which is not a
              net and is not the PnL beside it. `kol.ts` defines it. */}
              <span className="num">{formatSol(detail.volumeSol)} SOL</span>
            </Stat>
          </section>

          {/* DESIGN.md `card-chain-pnl`: "one line, SOL, because that is every chain
          we index" — and the brief's gloss, "do not imply others". So: one row,
          no column of chains with one entry, no "otras cadenas" placeholder. */}
          <section className="card">
            <div className="card-head">
              <h3 className="label">Chain PnL</h3>
            </div>
            <div className="chain-line">
              {/* The coloured dot the mould puts before a chain's name. It is
                  not a figure, so the accent is free to mark it; green and red
                  stay direction of money. */}
              <span className="chain-dot" aria-hidden="true" />
              <span className="symbol">SOL</span>
              <span className={`num ${direction}`}>{formatSignedSol(detail.realizedSol)}</span>
            </div>
          </section>

          {/* `DECISIONES.md`, 2026-08-31: the visibility decision is per wallet, so
          the detail says how much of this KOL's operation is on show — as a
          **count and a padlock, never a list**. The number is the honest thing
          to publish: it states the shape of what is hidden without naming any
          of it. Publishing the public addresses would be a different decision
          and is not this one.

          It sits **immediately above `list-defi-trades`** rather than among the
          figures: it is an identity fact, not a measurement, and this is where
          it explains the `PRIVADO` rows the reader is about to meet. Putting it
          between `card-stats` and `card-chain-pnl` split two numeric cards with
          a non-numeric one. */}
        </div>

        <div className="modal-column">
          <section className="card">
            <div className="card-head">
              <h3 className="label">DeFi trades</h3>
            </div>
            <TradeList trades={detail.trades} hideWallets={detail.kol.hideWallets} />
          </section>
        </div>
      </div>
    </>
  );
}

/**
 * `Wallets públicas` and `Wallets privadas`, as counts.
 *
 * **A KOL with no wallets at all renders nothing.** DESIGN.md's rule is that
 * *"Absence is rendered as absence, never as a zero"*, and two zeroes under a
 * heading would read as a measurement of a KOL who chose to publish none —
 * which is a different statement from having none to publish.
 *
 * Each half is omitted when it is zero, for the same reason: `0 wallets
 * privadas` invites the reader to wonder what happened to them, and a KOL who
 * published everything has nothing private to count.
 *
 * The padlock is {@link Padlock}, the same drawn one the `PRIVADO` chip uses,
 * and **not** an emoji. DESIGN.md's objection to an emoji medal applies here
 * exactly: an emoji carries its own colour, so it can be neither tinted with
 * the text nor kept out of the green and red this document reserves for money.
 * `kol-detail.test.ts` asserts the absence of `🔒` for that reason, and it
 * caught this component using one.
 *
 * It carries `aria-hidden`: the label already says `Privadas`, and a screen
 * reader announcing "lock" before a number it cannot place is noise. The count
 * is the accessible content.
 */
function WalletVisibility({
  publicWallets,
  privateWallets,
  hideWallets,
}: {
  publicWallets: number;
  privateWallets: number;
  /** Every wallet private, which is what the row's `Wallets ocultas` says. */
  hideWallets: boolean;
}) {
  /*
    **A line in the header since 2026-09-03**, where the mould puts a truncated
    address chip, rather than a card in the left column.

    `hideWallets` is `publicWallets === 0` in the serializer, so this says the
    same thing the row says and in the row's words — one string, one meaning,
    both surfaces. Below that it is counts and a padlock: `DECISIONES.md`,
    2026-08-31, *"never a list"*.
  */
  if (publicWallets === 0 && privateWallets === 0) return null;

  return (
    <div className="identity-third">
      {/*
        **`Wallets ocultas` and the count, not one instead of the other.**

        The first version of this line printed the phrase alone when every
        wallet was private — and that dropped the count, which is the thing
        `DECISIONES.md` (2026-08-31) actually asked the detail to state: *"un
        conteo y un candado, nunca una lista."* The phrase says the wallets are
        hidden; the number says how much operation is behind them, and a reader
        deciding whether a `Wallets ocultas` KOL is running one wallet or nine
        needs the second. `modal-kol.spec.ts` caught the loss.

        The row keeps saying only the phrase: it has one line and no room, and
        the modal is where the detail goes.
      */}
      {hideWallets && <span className="hidden-wallets">Wallets ocultas</span>}
      {publicWallets > 0 && (
        <span className="wallet-chip">
          {publicWallets} {publicWallets === 1 ? "wallet pública" : "wallets públicas"}
        </span>
      )}
      {privateWallets > 0 && (
        <span className="wallet-chip">
          <Padlock />
          {privateWallets} {privateWallets === 1 ? "privada" : "privadas"}
        </span>
      )}
    </div>
  );
}

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="stat">
      <span className="label">{label}</span>
      {children}
    </div>
  );
}

/**
 * DESIGN.md `card-calendario-pnl`: the mould's calendar heatmap, one cell per
 * UTC day of the window, painted green or red by that day's realized figure and
 * shaded by its size against the window's own biggest day.
 *
 * The grid is `calendar.ts` — every date decision lives there, dateless of the
 * runner's clock. This function is layout and words.
 *
 * **A day with no row is an empty cell, not a zero.** DESIGN.md: *"Absence is
 * rendered as absence"*; `kol.ts` writes no `pnl_daily` row for a day that
 * closed nothing, and a grey square is what that looks like.
 *
 * The weekday header is `aria-hidden` and so are the empty cells: a screen
 * reader that announced seven letters and then twenty blanks would bury the
 * four days that carry a figure. Each painted cell is a `<time>` labelled with
 * its date and its amount, which is the whole content of this card in text.
 */
function PnlCalendar({
  month,
  days,
}: {
  month: string;
  days: PublicKolDetail["calendar"]["days"];
}) {
  if (days.length === 0) {
    // DESIGN.md, "Every surface has two states": `| modal-kol calendar | a cell
    // per day of the window | Sin operaciones cerradas en este período. |`.
    // Verbatim, and it sits in the space the grid would occupy rather than
    // collapsing the card.
    return (
      <div className="state-empty calendar-empty">
        <p className="state-empty-lead">Sin operaciones cerradas en este período.</p>
      </div>
    );
  }

  const { cells, leading } = monthGrid(month, days);

  return (
    <div className="calendar">
      {/* Monday first: `windows.ts` computes `Semanal` as the ISO week, so a
          calendar that started on Sunday would put that window's first day in
          the second column of its own grid. */}
      {WEEKDAYS.map((letter, index) => (
        <span key={index} className="calendar-weekday label" aria-hidden="true">
          {letter}
        </span>
      ))}
      {cells.map((cell, index) => {
        const className = `calendar-cell${cell.level === 0 ? "" : ` ${cell.direction} level-${cell.level}`}`;
        // Only the first cell needs placing; the rest follow it across the
        // seven columns on their own.
        const style = index === 0 && leading > 0 ? { gridColumnStart: leading + 1 } : undefined;

        // The day of the month, which every calendar prints and ours did not:
        // the cells were 14px squares with nothing in them, so the grid could
        // be read as a heatmap but not as a calendar.
        const number = Number(cell.day.slice(8));

        if (cell.dailySol === null) {
          return (
            <span key={cell.day} className={className} style={style}>
              <span className="calendar-day" aria-hidden="true">
                {number}
              </span>
            </span>
          );
        }
        return (
          <time
            key={cell.day}
            className={className}
            style={style}
            dateTime={cell.day}
            aria-label={`${formatUtcDay(cell.day)}: ${formatSignedSol(cell.dailySol)}`}
          >
            <span className="calendar-day" aria-hidden="true">
              {number}
            </span>
            {/* The figure inside the cell, which is the mould's calendar and
                not a heatmap's: `aria-hidden` because the `aria-label` above
                already says the same thing in full, and a screen reader should
                not read the amount twice. */}
            <span className="calendar-amount" aria-hidden="true">
              {formatSignedSol(cell.dailySol)}
            </span>
          </time>
        );
      })}
    </div>
  );
}

/** `es-ES` weekday initials, Monday first. `X` for miércoles, as Spain writes it. */
const WEEKDAYS = ["L", "M", "X", "J", "V", "S", "D"] as const;

/** `2026-08-25` as `25/08`, to label a cell the way a trade row labels a row. */
function formatUtcDay(day: string): string {
  const [, month, date] = day.split("-");
  return `${date}/${month}`;
}

function TradeList({ trades, hideWallets }: { trades: PublicTrade[]; hideWallets: boolean }) {
  if (trades.length === 0) {
    // **DESIGN.md specifies no empty state for this list.** Its two-states table
    // covers the leaderboard, the feed, the calendar, the win rate and an unpriced
    // figure, and stops there. This line is derived from the one the same table
    // gives the calendar — `Sin operaciones cerradas en este período.` — with
    // `cerradas` dropped, because this list is every trade rather than only the
    // closes. Recorded in the batch report as a gap in the document rather than
    // presented as a rule it states.
    return (
      <div className="state-empty">
        <p className="state-empty-lead">Sin operaciones en este período.</p>
      </div>
    );
  }

  return (
    <ul className="trade-list">
      {trades.map((trade) => (
        <TradeRow key={trade.id} trade={trade} hideWallets={hideWallets} />
      ))}
    </ul>
  );
}

function TradeRow({ trade, hideWallets }: { trade: PublicTrade; hideWallets: boolean }) {
  const direction = trade.side === "buy" ? "gain" : "loss";
  const verb = trade.side === "buy" ? "compró" : "vendió";
  const moment = formatUtcMoment(trade.blockTime);

  return (
    <li className="row-trade">
      <span className={direction}>{verb}</span>
      <span className={`num ${direction}`}>{formatSol(trade.solAmount)} SOL</span>
      <span className="symbol">{trade.symbol ? `$${trade.symbol}` : "un token sin símbolo"}</span>

      {/* "its USD equivalent" — the trade's own `usd_amount`, fixed at its block
          (spec §4.1). `formatUsdPrice` is `US$` at four significant digits,
          which is the rule a trade's value wants as much as a price does; it is
          reused rather than copied under a second name.

          A block no `sol_price` row covered has none, and DESIGN.md's
          `state-unpriced` says so in words: "never a dash, never a red −100 %". */}
      <span className="trade-usd">
        {trade.usdAmount === null ? (
          <span className="state-unpriced">sin precio</span>
        ) : (
          <span className="num quantity">{formatUsdPrice(trade.usdAmount)}</span>
        )}
      </span>

      {/*
        The slot the reference fills with a signature link. Spec §7: "For hidden
        KOLs, neither the signature nor the link is exposed" — and `serialize.ts`
        has already dropped the signature by the time it reaches here, so this
        branch cannot leak one even if it were written wrongly. `hideWallets` is
        what decides the label, not `signature === null`: a stored ciphertext
        that will not open also yields a null signature, and a KOL that publishes
        its wallets must not be labelled `PRIVADO` because of a key rotation.
      */}
      {hideWallets ? (
        <span className="privado">
          <Padlock />
          PRIVADO
        </span>
      ) : trade.signature === null ? (
        <time className="num row-moment" dateTime={trade.blockTime}>
          {moment}
        </time>
      ) : (
        <a
          className="num row-moment"
          // encodeURIComponent, like the handle links beside it. A signature is
          // base58 and every base58 character survives encoding unchanged, so
          // this is belt and braces on today's data -- the reason it is here is
          // that it is the only interpolation on this page that did not encode,
          // and "harmless because of what the value happens to be" is a
          // property of the pipeline, not of this line.
          href={`https://solscan.io/tx/${encodeURIComponent(trade.signature)}`}
          target="_blank"
          rel="noreferrer noopener"
        >
          <time dateTime={trade.blockTime}>{moment}</time>
        </a>
      )}
    </li>
  );
}

/**
 * The padlock, drawn rather than typed.
 *
 * `🔒` is an emoji: it carries its own colour, so it can be neither tinted with
 * the text beside it nor kept out of the green and red DESIGN.md reserves for
 * money — the same objection that ruled out an emoji medal on the podium. The
 * text-presentation selector is unreliable across platforms, and there is no
 * padlock in the `latin` subset `next/font` loads. Nine lines of SVG take
 * `currentColor` and need no font at all.
 */
function Padlock() {
  return (
    <svg viewBox="0 0 12 14" width="10" height="12" aria-hidden="true" focusable="false">
      <path
        d="M3 6V4a3 3 0 0 1 6 0v2"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
      <rect x="1" y="6" width="10" height="7" rx="1.5" fill="currentColor" />
    </svg>
  );
}
