/**
 * The PnL calendar's grid, without a database and without a clock.
 *
 * Three properties are worth pinning and nothing else here is: the span is the
 * window's whole span rather than the days that happen to have data, a day with
 * no row is **absent** rather than zero, and the shades are computed from the
 * window's own biggest day.
 */
import { describe, expect, it } from "vitest";
import { calendarGrid } from "./calendar";

describe("calendarGrid", () => {
  it("covers every day of the window, painted or not", () => {
    const { cells } = calendarGrid("2026-08-24", "2026-08-31", [
      { day: "2026-08-25", dailySol: "3" },
      { day: "2026-08-28", dailySol: "-1" },
    ]);

    expect(cells.map((cell) => cell.day)).toEqual([
      "2026-08-24", "2026-08-25", "2026-08-26", "2026-08-27",
      "2026-08-28", "2026-08-29", "2026-08-30",
    ]);
    expect(cells[1]).toMatchObject({ dailySol: "3", direction: "gain" });
    expect(cells[4]).toMatchObject({ dailySol: "-1", direction: "loss" });
  });

  /**
   * DESIGN.md: *"Absence is rendered as absence, never as a zero."* A day that
   * closed nothing has no `pnl_daily` row at all (`kol.ts`), and it must not
   * arrive here as `0` — a flat day and a day that did not happen are different
   * statements, and only one of them is a measurement.
   */
  it("keeps a day with no row absent, and a real zero distinct from it", () => {
    const { cells } = calendarGrid("2026-08-24", "2026-08-26", [
      { day: "2026-08-25", dailySol: "0" },
    ]);

    expect(cells[0]).toMatchObject({ dailySol: null, direction: "", level: 0 });
    expect(cells[1]).toMatchObject({ dailySol: "0", direction: "", level: 0 });
  });

  it("starts the grid on the right weekday", () => {
    // 2026-08-24 is a Monday; 2026-08-30 is a Sunday.
    expect(calendarGrid("2026-08-24", "2026-08-25", []).leading).toBe(0);
    expect(calendarGrid("2026-08-30", "2026-08-31", []).leading).toBe(6);
  });

  /**
   * The shades are relative to the window, so a KOL whose whole month is
   * tenths of a SOL and one whose day is forty both get the same answer to
   * "which of *my* days was the big one".
   */
  it("shades by thirds of the window's own biggest day", () => {
    const { cells } = calendarGrid("2026-08-24", "2026-08-29", [
      { day: "2026-08-24", dailySol: "30" },
      { day: "2026-08-25", dailySol: "10" },
      { day: "2026-08-26", dailySol: "-20" },
      { day: "2026-08-27", dailySol: "0.03" },
    ]);

    expect(cells.map((cell) => cell.level)).toEqual([3, 1, 2, 1, 0]);
    // The sign decides the colour and the magnitude decides the shade, never
    // the other way round: the biggest loss is as dark as a big gain.
    expect(cells[2].direction).toBe("loss");
  });

  it("shades a single day as the peak it is", () => {
    const { cells } = calendarGrid("2026-08-25", "2026-08-26", [
      { day: "2026-08-25", dailySol: "0.01" },
    ]);
    expect(cells[0].level).toBe(3);
  });

  /**
   * `from` and `to` come from `windowBounds`; anything else is a caller that
   * has already gone wrong, and a calendar is not where that should be found
   * out — least of all by looping.
   */
  it("draws nothing for a span it cannot believe", () => {
    for (const [from, to] of [
      ["2026-08-31", "2026-08-24"],
      ["ayer", "2026-08-24"],
      ["2026-01-01", "2027-01-01"],
      ["2026-08-24", "2026-08-24"],
    ]) {
      expect(calendarGrid(from, to, []).cells).toEqual([]);
    }
  });
});
