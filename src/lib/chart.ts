/**
 * The geometry behind DESIGN.md's `card-pnl-evolution`: *"a line chart in
 * `semantic-gain` (or `semantic-loss` when the period is negative) with point
 * markers, `1D · 7D · 30D` segments, and a time axis."*
 *
 * **No charting dependency.** One polyline and a handful of circles is a few
 * lines of arithmetic; a library would ship kilobytes, a second theming system
 * and its own idea of colour into a page whose whole colour policy is one
 * document. The house rule reaches for a native platform feature before a
 * dependency, and inline SVG is that feature.
 *
 * Everything here is pure and takes no React: the component draws what this
 * returns, and the four cases that are easy to get wrong — no points, one
 * point, two points, every value identical — are asserted directly rather than
 * inferred from a rendered chart.
 *
 * **The values arrive as `numeric` strings and are read with `decimal.ts`.**
 * Coordinates are pixels and are plain numbers, which is correct: a pixel is
 * not money. What must not happen is money passing *through* a double on its
 * way to becoming a pixel, so the domain — the minimum, the maximum and each
 * value's position between them — is computed in scaled `bigint` and only the
 * finished ratio becomes a number.
 */
import { parseDecimal } from "./decimal";

/** A marker's centre, in the box's own coordinate space. */
export type ChartPoint = { x: number; y: number };

export type ChartGeometry = {
  points: ChartPoint[];
  /** The polyline's `points` attribute: `x,y x,y ...`. Empty when there is nothing to draw. */
  polyline: string;
};

export type ChartBox = {
  width: number;
  height: number;
  /**
   * Inset on all four sides. A marker drawn at the extreme of the range sits on
   * the edge of the box, and half of it would be clipped by the `<svg>` without
   * this — so the pad is at least the marker's radius.
   */
  pad: number;
};

/** Resolution of the bigint ratio: four decimal places, far finer than a pixel. */
const RATIO_SCALE = 10_000n;

/** Two decimals of a pixel: enough for a retina screen, and stable markup. */
function px(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Where each value sits inside the box.
 *
 * - **No values**: no points and no polyline. The caller renders DESIGN.md's
 *   empty state (`Sin operaciones cerradas en este período.`) rather than an
 *   axis with nothing on it — *"An empty state says what will be here and does
 *   not apologise."*
 * - **One value**: one marker, centred. Not a line: a single measurement is a
 *   point, and stretching it into a horizontal rule would draw a trend across a
 *   period that has one observation in it. `Diario` produces exactly this,
 *   because `pnl_daily` has one row per UTC day.
 * - **Every value identical** (which includes two equal ones, and a series of
 *   zeros): a flat line at the vertical centre. The obvious formula divides by
 *   `max - min` and this is where it divides by zero; the centre is the honest
 *   answer, because the value did not move and there is no scale to place it on.
 * - **Otherwise**: the maximum touches the top inset and the minimum the
 *   bottom, `y` growing downward as SVG's does.
 *
 * The x axis is evenly spaced by *index*, not by date. The series is one point
 * per day that closed something, and days with nothing closed have no row at
 * all — see `kol.ts`. Spacing by date would draw a gap that says "flat here",
 * which is a measurement nobody made; spacing by index says only "then this
 * happened", which is what the data supports. The axis is labelled with the
 * real dates so the reader is not told otherwise.
 */
export function chartGeometry(values: string[], box: ChartBox): ChartGeometry {
  if (values.length === 0) return { points: [], polyline: "" };

  const scaled = values.map(parseDecimal);
  const min = scaled.reduce((a, b) => (b < a ? b : a));
  const max = scaled.reduce((a, b) => (b > a ? b : a));
  const span = max - min;

  const left = box.pad;
  const right = box.width - box.pad;
  const top = box.pad;
  const bottom = box.height - box.pad;
  const middle = (top + bottom) / 2;

  const points = scaled.map((value, index) => {
    const x =
      scaled.length === 1 ? (left + right) / 2 : left + (index * (right - left)) / (scaled.length - 1);
    // `span === 0n` is the divide-by-zero, and it is reached by more than the
    // obvious case: a KOL who closed one position, and a KOL whose every day
    // came out to the same figure, both land here.
    const ratio = span === 0n ? 0.5 : Number(((value - min) * RATIO_SCALE) / span) / Number(RATIO_SCALE);
    const y = span === 0n ? middle : bottom - ratio * (bottom - top);
    return { x: px(x), y: px(y) };
  });

  return { points, polyline: points.map((p) => `${p.x},${p.y}`).join(" ") };
}
