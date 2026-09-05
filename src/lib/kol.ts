/**
 * One KOL's period, for DESIGN.md's `modal-kol`.
 *
 * The same split `feed.ts` and `leaderboard.ts` already make: the query lives
 * here so the modal's route and any future server render apply one set of
 * filters, and nothing here decides what is published — that is
 * `serialize.ts`, which this module hands complete rows to.
 *
 * **It reads `pnl_daily`, like the leaderboard, and derives nothing.** Spec §3
 * makes `trade` the only source of truth and `pnl_daily` the derived table the
 * ranking is read from; a modal that recomputed realized PnL from the trade log
 * would put a second, drifting copy of spec §4.5's exclusion rule in a query,
 * and would let the row and the modal print two different numbers for the same
 * KOL and the same window. They read the same table and the same window bounds,
 * so they cannot.
 *
 * The two figures `pnl_daily` cannot answer — how many trades, and how much SOL
 * changed hands — come from `trade` directly, because they are counts over the
 * log rather than results of the replay.
 *
 * ## The calendar's series
 *
 * `pnl_daily` is keyed `(kol_id, day)`, so the finest grain available is a UTC
 * day. `Diario` therefore yields **one** point, and that is the honest render:
 * intraday realized PnL is not a number this system has computed anywhere, and
 * inventing one here by replaying episodes in a page query is exactly the shape
 * of derivation the paragraph above refuses. `calendar.ts` draws one day as one
 * cell.
 *
 * Days with nothing closed have no row at all and are simply absent from the
 * series. That is deliberate: a zero inserted for them would read as "closed
 * out flat today", which is a measurement, and DESIGN.md's rule is that
 * *"Absence is rendered as absence, never as a zero."*
 */
import { orderChains, readChainPnl } from "./chain-pnl";
import { query } from "./db";
import { formatDecimal, parseDecimal } from "./decimal";
import { readKolTrades } from "./feed";
import {
  serializeKolDetail,
  type KolDetailRow,
  type KolSeriesPoint,
  type PublicKolDetail,
} from "./serialize";
import { monthRange, utcMonthString } from "./calendar";
import { utcDayString, windowBounds, type LeaderboardWindow } from "./windows";

/**
 * How many trades `list-defi-trades` carries.
 *
 * The same page size the feed uses, for the same reason: it is a list a reader
 * scrolls, not a dataset, and a KOL who traded four hundred times in a month
 * must not turn one modal into a four-hundred-row payload. The cap is
 * documented on the surface rather than hidden — see `kol-detail.tsx`.
 */
export const KOL_TRADES_LIMIT = 50;

/**
 * A slug reaches this module straight from a URL path segment.
 *
 * The query is parameterised, so this is not about injection. It is about not
 * sending an unbounded attacker-chosen string to Postgres on every request:
 * `kol.slug` is written by the admin flow and is a short identifier, so
 * anything past this bound is not a slug that can exist and is answered as
 * "no such KOL" without a round trip.
 */
const MAX_SLUG_LENGTH = 128;

/**
 * `k.status = 'approved'` is spec §9's public-surface filter, in the query
 * rather than after it: a suspended KOL must not be reachable by guessing its
 * slug, and the caller cannot tell "suspended" from "never existed".
 *
 * **No wallet column is selected, and none may be added.** This query used to
 * carry `encode(w.address_hmac,'hex') AS address`, which nothing read: the row
 * is spread into {@link serializeKolDetail}, so the only thing between that
 * column and a public response was a serializer that happens to name its
 * fields one at a time. `address_hmac` is spec §8.1's blind index — stable and
 * globally unique over addresses — so publishing it would let two personas be
 * joined on a shared wallet without any address being recovered, which is the
 * linkage SECURITY.md names as *the* asset. A read that does not select it
 * cannot leak it, and that is a cheaper guarantee than one function body's
 * good manners. `address-invariant.test.ts` scans for the digest in every
 * encoding it could arrive in.
 *
 * The window join is the leaderboard's, half-open on `date` literals built by
 * {@link utcDayString} — passing a `Date` would have `pg` send a timestamp for
 * Postgres to cast in the *session* time zone, which is the local-time leak
 * `windows.ts` exists to prevent.
 */
/**
 * Counted with scalar subqueries rather than a join, for the reason
 * `leaderboard.ts` spells out at `PUBLIC_WALLETS`: this statement sums
 * `pnl_daily`, and a join to `kol_wallet` would multiply those sums by the
 * number of wallets. `status = 'active'` because a withdrawn wallet is not
 * part of what this KOL operates, and the counts are what the detail prints.
 */
const WALLET_COUNTS = `
  (SELECT count(*)::int FROM kol_wallet w
    WHERE w.kol_id = k.id AND w.status = 'active' AND w.is_public) AS public_wallets,
  (SELECT count(*)::int FROM kol_wallet w
    WHERE w.kol_id = k.id AND w.status = 'active' AND NOT w.is_public) AS private_wallets`;

/**
 * The detail's identity and its window figures, summing the per-sell amounts
 * `migrations/015` records. The `pnl_daily` statement that stood here until
 * 2026-09-03 went with the calendar windows: a day bucket cannot be cut at an
 * arbitrary hour, so there is nothing left for it to answer.
 */
const DETAIL_SQL = `
  SELECT k.id AS kol_id, k.slug, k.display_name, k.x_handle, k.hide_wallets,
         c.tag AS cabal_tag,
         ${WALLET_COUNTS},
         COALESCE(SUM(t.realized_sol), 0) AS realized_sol,
         COALESCE(SUM(t.realized_usd), 0) AS realized_usd
    FROM kol k
    LEFT JOIN cabal c ON c.id = k.cabal_id
    LEFT JOIN trade t
           ON t.kol_id = k.id
          AND t.realized_sol IS NOT NULL
          AND t.block_time >= $2::timestamptz AND t.block_time < $3::timestamptz
   WHERE k.slug = $1 AND k.status = 'approved'
   GROUP BY k.id, c.tag`;

/**
 * `card-stats`' other two figures.
 *
 * Volume is the SOL both sides of every trade moved, which is what "volume"
 * means for a swap: a buy spends SOL and a sell receives it, and adding them is
 * turnover rather than a net. It is deliberately not the same measurement as
 * realized PnL and is labelled as its own thing on the card.
 */
const ACTIVITY_SQL = `
  SELECT COUNT(*)::int AS trade_count,
         COALESCE(SUM(t.sol_amount), 0) AS volume_sol
    FROM trade t
   WHERE t.kol_id = $1::uuid
     AND t.block_time >= $2::timestamptz
     AND t.block_time < $3::timestamptz`;

/**
 * The calendar's raw series: one row per day that closed something.
 *
 * `to_char` rather than the `date` itself, because `pg` parses a `date` into a
 * `Date` at the *runner's* local midnight — so a UTC day would arrive as the
 * previous day for the whole of this product's audience. The string is the
 * value; nothing downstream reparses it.
 */
const SERIES_SQL = `
  SELECT to_char(d.day, 'YYYY-MM-DD') AS day, d.realized_sol
    FROM pnl_daily d
   WHERE d.kol_id = $1::uuid AND d.day >= $2::date AND d.day < $3::date
   ORDER BY d.day ASC`;

/**
 * How many sells the month carries — the last figure in the calendar's summary
 * row, and the only one there that a series of daily totals cannot produce.
 *
 * Sells rather than trades, because the calendar is about realized PnL and
 * spec §4.7 realizes on the sell: a month of buying closes nothing and the row
 * should say so.
 */
const MONTH_SELLS_SQL = `
  SELECT count(*)::int AS sells
    FROM trade t
   WHERE t.kol_id = $1::uuid
     AND t.side = 'sell'
     AND t.block_time >= $2::timestamptz
     AND t.block_time < $3::timestamptz`;

/**
 * What `DETAIL_SQL` alone produces. The two activity columns come from a
 * different table and are joined on in {@link readKolDetail}; typing them out
 * of this row is what stops `query<KolDetailRow>` from asserting the query
 * returned columns it never selected.
 */
type IdentityRow = Omit<KolDetailRow, "trade_count" | "volume_sol">;

type ActivityRow = { trade_count: number; volume_sol: string };
type SeriesRow = { day: string; realized_sol: string };
type SellsRow = { sells: number };

/**
 * Daily realized PnL, kept **and** accumulated.
 *
 * In `decimal.ts`'s scaled `bigint`, not in doubles: these are the same SOL
 * figures the leaderboard prints, and a running sum is precisely where a float
 * would start drifting. The last point is therefore *exactly* the window total
 * `DETAIL_SQL` summed in Postgres, which is what lets the calendar and the modal's
 * header be read as one statement.
 */
function accumulate(rows: SeriesRow[]): KolSeriesPoint[] {
  let running = 0n;
  return rows.map((row) => {
    running += parseDecimal(row.realized_sol);
    return { day: row.day, dailySol: row.realized_sol, cumulativeSol: formatDecimal(running) };
  });
}

export type KolDetailQuery = {
  slug: string;
  window: LeaderboardWindow;
  /**
   * Which calendar month the PnL calendar shows, `YYYY-MM`.
   *
   * **It is deliberately independent of the window.** Since 2026-09-03 the
   * calendar is a month the reader can page through while the window governs
   * everything below it — the owner's brief, overruling
   * `docs/round-ventanas-moviles.md` §3.4. An unreadable value falls back to
   * the current UTC month rather than erroring: it arrives from a query string.
   */
  month?: string;
  /** Injectable so a caller can pin the window; defaults to the current instant. */
  now?: Date;
};

/**
 * `null` when there is no such KOL **or** it is not on a public surface. The
 * two are one answer on purpose: whether a slug exists is not information this
 * read owes an anonymous caller (the same rule `/api/avatar` follows).
 */
export async function readKolDetail(options: KolDetailQuery): Promise<PublicKolDetail | null> {
  if (options.slug.length === 0 || options.slug.length > MAX_SLUG_LENGTH) return null;

  const at = options.now ?? new Date();
  const bounds = windowBounds(options.window, at);
  const from = utcDayString(bounds.from);
  const to = utcDayString(bounds.to);

  // An unrecognised month is the current one, not an error: it reaches here
  // from `?month=` and a stale link should still open the modal.
  const month = monthRange(options.month ?? "") === null ? utcMonthString(at) : options.month!;
  const monthSpan = monthRange(month)!;

  // ISO instants: the window is an interval, not a span of days. The calendar
  // card below is unaffected — it spans a month the reader chose, and
  // `monthSpan` is always whole days.
  const windowFrom = bounds.from.toISOString();
  const windowTo = bounds.to.toISOString();

  const [row] = await query<IdentityRow>(DETAIL_SQL, [
    options.slug,
    windowFrom,
    windowTo,
  ]);
  if (!row) return null;

  // Three reads over three different tables, none of which needs another's
  // result. In sequence they would be three Neon round trips on the way to
  // opening one modal.
  const [activity, trades, monthSeries, monthSells] = await Promise.all([
    query<ActivityRow>(ACTIVITY_SQL, [
      row.kol_id,
      bounds.from.toISOString(),
      bounds.to.toISOString(),
    ]),
    readKolTrades({
      kolId: row.kol_id,
      from: bounds.from,
      to: bounds.to,
      limit: KOL_TRADES_LIMIT,
    }),
    // The calendar's own month, which is not the window's span any more.
    query<SeriesRow>(SERIES_SQL, [row.kol_id, monthSpan.from, monthSpan.to]),
    query<SellsRow>(MONTH_SELLS_SQL, [
      row.kol_id,
      `${monthSpan.from}T00:00:00Z`,
      `${monthSpan.to}T00:00:00Z`,
    ]),
  ]);

  // The per-chain split, from its own statement for the reasons in
  // `chain-pnl.ts`. Attached after serialization rather than threaded through
  // it: `serializeKolDetail` is about what a public surface may carry, and this
  // is an addition to the shape rather than a change to that judgement.
  const chains = orderChains(
    (await readChainPnl([row.kol_id], bounds)).get(row.kol_id) ?? [],
  );

  const detail = serializeKolDetail({
    // `COUNT(*)` and `SUM` over an empty set give `0` and, with the COALESCE,
    // `'0'` -- so a KOL with no trades in the window is a real zero here, not a
    // missing row. What the *screen* does with that is a different rule: see
    // `kol-detail.tsx`.
    row: { ...row, trade_count: activity[0].trade_count, volume_sol: activity[0].volume_sol },
    window: options.window,
    from,
    to,
    /*
      **`series` is the calendar's month since 2026-09-03**, not the window's
      span — the same days `calendar.days` carries, with the running total
      `accumulate` adds.

      It read `pnl_daily` between the window's two bounds until then, and that
      stopped meaning anything when the windows became rolling: a rolling window
      starts and ends at an *instant*, so its edges are partial days, and a table
      keyed by `date` cannot answer for them. The field would have been neither
      the window nor a month — a range nobody could state.

      The alternative was removing it, which is the honest shape (nothing on
      screen has read it since the calendar became a month) and a breaking change
      to a published response. The owner chose to keep it and give it the meaning
      it can actually carry.
    */
    series: accumulate(monthSeries),
    trades,
    calendar: {
      month,
      days: monthSeries.map((point) => ({ day: point.day, dailySol: point.realized_sol })),
      sells: monthSells[0]?.sells ?? 0,
    },
  });

  // Attached after serialization rather than threaded through it:
  // `serializeKolDetail` decides what a public surface may carry, and this is an
  // addition to the shape rather than a change to that judgement.
  return { ...detail, chains };
}
