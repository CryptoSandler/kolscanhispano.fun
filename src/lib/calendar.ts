/**
 * The PnL calendar's grid: one cell per UTC day of the window, painted by that
 * day's realized figure.
 *
 * `docs/clone-map.md` §5, Block 1. It replaced a line chart on 2026-09-02 —
 * `chart.ts` and its geometry went with it — because the mould's first block is
 * a calendar heatmap and this document is now a clone of that site.
 *
 * **Their calendar is broken and ours is not, and that is deliberate.** The
 * reconnaissance found theirs rendering `--` over a 7×5 grid of empty cells
 * across two viewports and three windows (`docs/clone-map.md` §0). The layout
 * and the labels are the mould; the emptiness is a defect, and a defect is not
 * a design.
 *
 * **The span is the window's, not a rolling 35 days.** `Diario` is one cell,
 * `Semanal` is the ISO week, `Mensual` is the month — because spec §4.9 makes
 * every window calendar-aligned UTC, and a grid that showed five weeks beside a
 * header summing one day would be two different periods on one card. The
 * mould's `1D · 7D · 30D` are rolling windows, which is a change to what every
 * figure in this product means and has its own round
 * (`docs/clone-map.md` §8); it is not a rendering decision to make here.
 *
 * Pure, and dateless in the sense that matters: everything is a `YYYY-MM-DD`
 * string and `Date.UTC` arithmetic, so no cell can land on the runner's local
 * midnight — the leak `windows.ts` exists to prevent, one layer up.
 */

/** One day of the window. `dailySol` is `null` for a day that closed nothing. */
export type CalendarCell = {
  day: string;
  dailySol: string | null;
  /** `gain`, `loss`, or `""` for a day with nothing to say. */
  direction: "gain" | "loss" | "";
  /**
   * How strongly to paint it: `0` for absent or flat, `1`–`3` by magnitude
   * against the window's own biggest day.
   *
   * Relative rather than absolute, because a KOL whose whole month is a few
   * tenths of a SOL and one whose day is forty have the same question — which
   * of *their* days was the big one — and an absolute scale answers it for only
   * one of them.
   */
  level: 0 | 1 | 2 | 3;
};

export type CalendarGrid = {
  cells: CalendarCell[];
  /**
   * Empty columns before the first cell, so the grid's columns are weekdays.
   * Monday is column one, which is what ISO weeks make of `Semanal`.
   */
  leading: number;
};

import { parseDecimal } from "./decimal";

const DAY_MS = 86_400_000;

/** `YYYY-MM-DD` to a UTC instant. `NaN` for anything that is not that shape. */
function utcDay(text: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (match === null) return Number.NaN;
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

function isoDay(instant: number): string {
  return new Date(instant).toISOString().slice(0, 10);
}

/** Monday 0 … Sunday 6, from a UTC instant. */
function isoWeekdayIndex(instant: number): number {
  return (new Date(instant).getUTCDay() + 6) % 7;
}

/** `|value|`, in `decimal.ts`'s scaled `bigint`. */
function magnitude(text: string): bigint {
  const value = parseDecimal(text);
  return value < 0n ? -value : value;
}

/**
 * Every day from `from` (inclusive) to `to` (exclusive), with the series' own
 * days painted and the rest left absent.
 *
 * A span that does not parse, runs backwards, or is longer than a month
 * produces an empty grid rather than a loop: `from` and `to` come from
 * `windowBounds`, so anything else is a caller that has already gone wrong, and
 * a calendar is not the place to find out.
 */
export function calendarGrid(
  from: string,
  to: string,
  series: readonly { day: string; dailySol: string }[],
): CalendarGrid {
  const start = utcDay(from);
  const end = utcDay(to);
  if (Number.isNaN(start) || Number.isNaN(end) || end <= start || end - start > 31 * DAY_MS) {
    return { cells: [], leading: 0 };
  }

  const byDay = new Map(series.map((point) => [point.day, point.dailySol]));
  const peak = series.reduce(
    (biggest, point) => (magnitude(point.dailySol) > biggest ? magnitude(point.dailySol) : biggest),
    0n,
  );

  const cells: CalendarCell[] = [];
  for (let instant = start; instant < end; instant += DAY_MS) {
    const day = isoDay(instant);
    const dailySol = byDay.get(day) ?? null;
    cells.push({
      day,
      dailySol,
      direction:
        dailySol === null || magnitude(dailySol) === 0n
          ? ""
          : parseDecimal(dailySol) < 0n
            ? "loss"
            : "gain",
      level: dailySol === null ? 0 : levelOf(magnitude(dailySol), peak),
    });
  }

  return { cells, leading: isoWeekdayIndex(start) };
}

/**
 * Three shades, by magnitude against the window's biggest day.
 *
 * Thirds rather than a continuous ramp: DESIGN.md's contrast table is a claim
 * about a fixed set of colours, and a gradient of arbitrary alphas is a claim
 * nobody measured. Three steps are also all a reader can tell apart in a 14px
 * square.
 *
 * The comparison is exact `bigint` arithmetic on `decimal.ts`'s scaled values,
 * with the division turned into a multiplication so nothing is rounded: a day
 * is faint if three of it would not reach the peak, middle if three of it would
 * not reach two peaks, and dark otherwise.
 */
function levelOf(value: bigint, peak: bigint): 0 | 1 | 2 | 3 {
  if (value === 0n || peak === 0n) return 0;
  if (value * 3n <= peak) return 1;
  if (value * 3n <= peak * 2n) return 2;
  return 3;
}


/**
 * # The month grid
 *
 * `docs/parecido-2026-09-02.md` §7 and the owner's brief of 2026-09-03: the
 * mould's calendar is **a calendar month with month navigation**, not the
 * window's span. Measured on its own DOM the same day: a 7-column grid of
 * 95.4px cells with a 4px gap, the month's own total in large type above it,
 * and a summary row beneath.
 *
 * **This is a change to what the block measures, and it is the owner's, not
 * mine.** `docs/round-ventanas-moviles.md` §3.4 closed with *"Nothing on the
 * calendar card changes. It spans a calendar window."* The brief overrules that
 * line: the card now spans a month the reader can page through, independent of
 * the window that governs everything below it. The two are no longer the same
 * period, which is exactly why the month's own total is printed on the card —
 * without it the grid would be a set of days with no statement of what they add
 * up to, sitting under a header that sums something else.
 *
 * **Monday-first, and that is the one thing not copied.** Their header reads
 * `D S T Q Q S S` — Sunday-first, which is the Brazilian convention. Ours is
 * `L M X J V S D`, because Spain and Latin America start the week on Monday and
 * because `Semanal` here is an **ISO** week, which is Monday-based by
 * definition (`windows.ts`). A Sunday-first grid beside a Monday-based window
 * would put the same seven days in two different orders on one screen.
 */
export type MonthSummary = {
  /** Days that closed up, and days that closed down. */
  gainDays: number;
  lossDays: number;
  /** The month's best day, as a signed decimal, or `null` if nothing closed. */
  best: string | null;
  /** The longest run of consecutive days that closed up. */
  streak: number;
};

/**
 * `YYYY-MM` to the half-open `[from, to)` pair of `YYYY-MM-DD` strings the
 * series query wants. `null` if the month is not one.
 *
 * Strings, not `Date`s, for the reason `SERIES_SQL` gives: `pg` turns a `date`
 * into a `Date` at the runner's local midnight, so a UTC day would arrive as
 * the previous one for this product's whole audience.
 */
export function monthRange(month: string): { from: string; to: string } | null {
  const bounds = monthBounds(month);
  return bounds === null ? null : { from: isoDay(bounds.start), to: isoDay(bounds.end) };
}

/** The UTC month an instant falls in. Never the local one — see `windows.ts`. */
export function utcMonthString(at: Date): string {
  return at.toISOString().slice(0, 7);
}

/** `YYYY-MM` to the first and last instants of that month. `null` if malformed. */
function monthBounds(month: string): { start: number; end: number } | null {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  if (match === null) return null;
  const year = Number(match[1]);
  const index = Number(match[2]) - 1;
  if (index < 0 || index > 11) return null;
  return { start: Date.UTC(year, index, 1), end: Date.UTC(year, index + 1, 1) };
}

/**
 * One cell per day of `month`, painted from `series` exactly as
 * {@link calendarGrid} paints a window: absent days stay absent, and the three
 * shades are relative to the month's own biggest day.
 *
 * A malformed month gives an empty grid rather than a loop, for the same reason
 * the window version does — the caller has already gone wrong and a calendar is
 * not where that gets discovered.
 */
export function monthGrid(
  month: string,
  series: readonly { day: string; dailySol: string }[],
): CalendarGrid {
  const bounds = monthBounds(month);
  if (bounds === null) return { cells: [], leading: 0 };
  return calendarGrid(isoDay(bounds.start), isoDay(bounds.end), series);
}

/**
 * The row under the grid: `12 · 3`, the best day, the streak and the number of
 * sells — the four things the mould prints there, minus the sell count, which
 * is not derivable from a series of daily totals and comes from the query.
 *
 * The streak counts **calendar-consecutive** days, so a gap day breaks it even
 * if the next day is also a gain: two wins either side of a quiet Wednesday are
 * two runs of one, not a run of two. That is what makes it a statement about
 * days rather than about trades.
 */
export function monthSummary(
  month: string,
  series: readonly { day: string; dailySol: string }[],
): MonthSummary {
  const bounds = monthBounds(month);
  if (bounds === null) return { gainDays: 0, lossDays: 0, best: null, streak: 0 };

  const byDay = new Map(series.map((point) => [point.day, point.dailySol]));
  let gainDays = 0;
  let lossDays = 0;
  let best: string | null = null;
  let bestValue = 0n;
  let streak = 0;
  let run = 0;

  for (let instant = bounds.start; instant < bounds.end; instant += DAY_MS) {
    const value = byDay.get(isoDay(instant));
    if (value === undefined) {
      run = 0;
      continue;
    }
    const parsed = parseDecimal(value);
    if (parsed > 0n) {
      gainDays += 1;
      run += 1;
      if (run > streak) streak = run;
    } else if (parsed < 0n) {
      lossDays += 1;
      run = 0;
    } else {
      run = 0;
    }
    if (best === null || parsed > bestValue) {
      best = value;
      bestValue = parsed;
    }
  }

  return { gainDays, lossDays, best, streak };
}
