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
