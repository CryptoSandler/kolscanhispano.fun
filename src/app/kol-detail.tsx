import { cabalChipClass } from "@/lib/cabal";
import { chartGeometry } from "@/lib/chart";
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
 * `card-pnl-evolution` ... `card-stats` ... `card-chain-pnl` ...
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

      <section className="card">
        <div className="card-head">
          <h3 className="label">PnL acumulado</h3>
          {segments}
        </div>
        <PnlEvolution series={detail.series} direction={direction} />
      </section>

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

      <section className="card">
        <div className="card-head">
          <h3 className="label">Operaciones del período</h3>
        </div>
        <TradeList trades={detail.trades} hideWallets={detail.kol.hideWallets} />
      </section>
    </>
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

/** The drawing box, in the SVG's own units. It scales with the card through `viewBox`. */
const CHART = { width: 640, height: 160, pad: 10 };

/** Marker radius. It is what `CHART.pad` has to clear so nothing is clipped. */
const MARKER = 3;

/**
 * DESIGN.md `card-pnl-evolution`: *"a line chart in `semantic-gain` (or
 * `semantic-loss` when the period is negative) with point markers ... and a
 * time axis."*
 *
 * Inline SVG, no dependency: the geometry is `chart.ts`, which is where the one
 * point / two points / all-equal / empty cases are pinned. `currentColor`
 * carries the sign colour, so the class on the `<svg>` is the only place the
 * direction is stated.
 *
 * `aria-hidden` on the drawing with the figures already on `card-stats` beside
 * it: a polyline read aloud is noise, and the numbers it draws are all in text
 * a few lines down.
 */
function PnlEvolution({
  series,
  direction,
}: {
  series: PublicKolDetail["series"];
  direction: "gain" | "loss" | "";
}) {
  if (series.length === 0) {
    // DESIGN.md, "Every surface has two states": `| modal-kol chart | line with
    // points | Sin operaciones cerradas en este período. |`. Verbatim, and it
    // sits in the space the chart would occupy rather than collapsing the card.
    return (
      <div className="state-empty chart-empty">
        <p className="state-empty-lead">Sin operaciones cerradas en este período.</p>
      </div>
    );
  }

  const { points, polyline } = chartGeometry(
    series.map((point) => point.cumulativeSol),
    CHART,
  );

  return (
    <>
      {/* No `preserveAspectRatio="none"`: a non-uniform scale would draw every
          circular marker as an ellipse and thin the line horizontally. The
          stylesheet gives the element the viewBox's own 4:1 ratio instead, so
          the drawing scales with the card without being distorted by it. */}
      <svg
        className={`chart ${direction}`}
        viewBox={`0 0 ${CHART.width} ${CHART.height}`}
        role="presentation"
        aria-hidden="true"
      >
        {/* A single point has no line to draw, and a `<polyline>` with one
            vertex renders nothing anyway — the marker below is the whole
            chart in that case. */}
        {points.length > 1 && <polyline className="chart-line" points={polyline} />}
        {points.map((point, index) => (
          <circle key={series[index].day} cx={point.x} cy={point.y} r={MARKER} />
        ))}
      </svg>

      {/* The time axis. The first and last day the series actually carries, in
          the `label` role — not a tick per point, which at thirty days would be
          thirty overlapping dates in a 640-unit box. A one-point series names
          its single day once rather than printing it twice. */}
      <div className="chart-axis label">
        <span>{series[0].day}</span>
        {series.length > 1 && <span>{series[series.length - 1].day}</span>}
      </div>
    </>
  );
}

/**
 * DESIGN.md `list-defi-trades`: *"the KOL's trades, each with verb, SOL amount
 * by sign and its USD equivalent, and where the wallet is hidden the row reads
 * `PRIVADO` with a padlock instead of a signature link."*
 *
 * *"by sign"* is read the way the same document reads it everywhere else — *"the
 * period's total PnL in `numeric-lg` **by sign**"*, *"in `semantic-gain` or
 * `semantic-loss` **by the period's sign**"* — as *coloured* by direction. A
 * trade's direction is its side, and the feed row already colours a buy green
 * and a sell red; two surfaces in one product must not disagree about that, so
 * the amount is printed unsigned and coloured, exactly as the feed prints it.
 */
function TradeList({ trades, hideWallets }: { trades: PublicTrade[]; hideWallets: boolean }) {
  if (trades.length === 0) {
    // **DESIGN.md specifies no empty state for this list.** Its two-states table
    // covers the leaderboard, the feed, the chart, the win rate and an unpriced
    // figure, and stops there. This line is derived from the one the same table
    // gives the chart — `Sin operaciones cerradas en este período.` — with
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
          href={`https://solscan.io/tx/${trade.signature}`}
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
