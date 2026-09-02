import { cabalChipClass } from "@/lib/cabal";
import { calendarGrid } from "@/lib/calendar";
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
}: {
  detail: PublicKolDetail;
  /** The `Diario · Semanal · Mensual` control, owned by the caller. */
  segments?: React.ReactNode;
}) {
  const direction = amountDirection(detail.realizedSol);

  return (
    <>
      <header className="modal-head">
        {/* DESIGN.md: "64px avatar" — from `/api/avatar/<kol_id>` like every
            other avatar on the site, never a hotlink and never keyed by an
            address. */}
        <Avatar name={detail.kol.name} src={detail.kol.avatarUrl} size={64} />

        <div className="modal-identity">
          <h2 className="headline">{detail.kol.name}</h2>
          <span className="identity-second">
            <a
              className="handle"
              href={`https://x.com/${encodeURIComponent(detail.kol.xHandle)}`}
              target="_blank"
              rel="noreferrer noopener"
              aria-label={`Perfil de ${detail.kol.name} en X`}
            >
              @{detail.kol.xHandle}
            </a>
            {detail.kol.hideWallets && <span className="hidden-wallets">Wallets ocultas</span>}
          </span>
        </div>

        {detail.kol.cabalTag && (
          <span className={cabalChipClass(detail.kol.cabalTag)}>{detail.kol.cabalTag}</span>
        )}

        {/* "the period's total PnL in `numeric-lg` by sign". The USD equivalent
            follows the row's shape — small, parenthesised, ink-muted — so the
            same pair of figures reads the same way on both surfaces. */}
        <span className="modal-pnl">
          <span className={`num-lg ${direction}`}>{formatSignedSol(detail.realizedSol)}</span>
          <span className="num secondary">({formatSignedUsd(detail.realizedUsd)})</span>
        </span>
      </header>

      {/* DESIGN.md `card-calendario-pnl`, and `docs/clone-map.md` §5's first
          block: their calendar heatmap, with our data in it. Full width, above
          the two columns, exactly as on the mould. */}
      <section className="card">
        <div className="card-head">
          <h3 className="label">Calendario de PnL</h3>
          {segments}
        </div>
        <PnlCalendar from={detail.from} to={detail.to} series={detail.series} />
      </section>

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
            <Stat label="Operaciones">
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
              <h3 className="label">PnL por cadena</h3>
            </div>
            <div className="chain-line">
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
          <WalletVisibility
            publicWallets={detail.publicWallets}
            privateWallets={detail.privateWallets}
          />
        </div>

        <div className="modal-column">
          <section className="card">
            <div className="card-head">
              <h3 className="label">Operaciones del período</h3>
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
}: {
  publicWallets: number;
  privateWallets: number;
}) {
  if (publicWallets === 0 && privateWallets === 0) return null;

  return (
    <section className="card card-wallets">
      <div className="card-head">
        <h3 className="label">Wallets</h3>
      </div>
      <div className="wallet-counts">
        {publicWallets > 0 && (
          <Stat label="Públicas">
            <span className="num">{publicWallets}</span>
          </Stat>
        )}
        {privateWallets > 0 && (
          <Stat label="Privadas">
            <span className="num">
              <Padlock />
              {privateWallets}
            </span>
          </Stat>
        )}
      </div>
    </section>
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
  from,
  to,
  series,
}: {
  from: string;
  to: string;
  series: PublicKolDetail["series"];
}) {
  if (series.length === 0) {
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

  const { cells, leading } = calendarGrid(from, to, series);

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

        if (cell.dailySol === null) {
          return <span key={cell.day} className={className} style={style} aria-hidden="true" />;
        }
        return (
          <time
            key={cell.day}
            className={className}
            style={style}
            dateTime={cell.day}
            aria-label={`${formatUtcDay(cell.day)}: ${formatSignedSol(cell.dailySol)}`}
          />
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
