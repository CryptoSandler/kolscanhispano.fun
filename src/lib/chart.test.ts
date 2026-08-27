import { describe, expect, it } from "vitest";
import { chartGeometry, type ChartBox } from "./chart";

/** A box with round numbers, so every expectation below can be read by eye. */
const BOX: ChartBox = { width: 100, height: 40, pad: 4 };

describe("chartGeometry", () => {
  it("draws nothing at all for an empty period", () => {
    // The caller renders DESIGN.md's `Sin operaciones cerradas en este período.`
    // instead. An axis with nothing on it is the shrug this document forbids.
    expect(chartGeometry([], BOX)).toEqual({ points: [], polyline: "" });
  });

  it("centres a single point rather than stretching it into a line", () => {
    // `Diario` produces exactly one point, because `pnl_daily` is keyed by day.
    // A horizontal rule across the card would draw a trend through one
    // observation.
    const { points, polyline } = chartGeometry(["18.42"], BOX);
    expect(points).toEqual([{ x: 50, y: 20 }]);
    expect(polyline).toBe("50,20");
  });

  it("puts two points at the two ends, high value up", () => {
    const { points } = chartGeometry(["1", "3"], BOX);
    expect(points).toEqual([
      { x: 4, y: 36 },
      { x: 96, y: 4 },
    ]);
  });

  it("draws a flat line when every value is equal, instead of dividing by zero", () => {
    // The obvious formula divides by `max - min`. Two identical days, or a
    // series of zeros, reaches it.
    const { points } = chartGeometry(["2.5", "2.5", "2.5"], BOX);
    expect(points.map((p) => p.y)).toEqual([20, 20, 20]);
    expect(points.map((p) => p.x)).toEqual([4, 50, 96]);
  });

  it("survives a series of zeros", () => {
    const { points } = chartGeometry(["0", "0"], BOX);
    expect(points.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))).toBe(true);
    expect(points.map((p) => p.y)).toEqual([20, 20]);
  });

  it("spans the box between the minimum and the maximum, and inverts y", () => {
    // SVG's y grows downward, so the largest value must have the smallest y.
    const { points } = chartGeometry(["0", "-5", "10", "2.5"], BOX);
    expect(points[1].y).toBe(36); // the minimum, on the bottom inset
    expect(points[2].y).toBe(4); // the maximum, on the top inset
    expect(points[0].y).toBeGreaterThan(points[3].y);
  });

  it("keeps every marker inside the box, so nothing is clipped", () => {
    const { points } = chartGeometry(["-120.5", "0", "7", "0.0001", "3"], BOX);
    for (const point of points) {
      expect(point.x).toBeGreaterThanOrEqual(BOX.pad);
      expect(point.x).toBeLessThanOrEqual(BOX.width - BOX.pad);
      expect(point.y).toBeGreaterThanOrEqual(BOX.pad);
      expect(point.y).toBeLessThanOrEqual(BOX.height - BOX.pad);
    }
  });

  it("spaces points evenly by index, whatever the dates behind them were", () => {
    // The series has one point per day that closed something; days with nothing
    // closed have no row. Spacing by date would draw a flat run across them,
    // which is a measurement nobody made. The axis labels carry the real dates.
    const { points } = chartGeometry(["1", "2", "3", "4", "5"], BOX);
    const gaps = points.slice(1).map((p, i) => p.x - points[i].x);
    expect(new Set(gaps).size).toBe(1);
  });

  it("reads the values as decimals, not as doubles", () => {
    // Eighteen fractional digits is past what a double resolves. If these went
    // through `Number()` the two would collapse onto one another and the chart
    // would be flat; read through `decimal.ts` they are two distinct values and
    // the second is the maximum.
    const { points } = chartGeometry(["1.000000000000000001", "1.000000000000000002"], BOX);
    expect(points[0].y).toBe(36);
    expect(points[1].y).toBe(4);
  });

  it("writes the polyline as the SVG attribute expects it", () => {
    expect(chartGeometry(["1", "2"], BOX).polyline).toBe("4,36 96,4");
  });
});
