/**
 * The PnL calendar's grid, without a database and without a clock.
 *
 * Three properties are worth pinning and nothing else here is: the span is the
 * window's whole span rather than the days that happen to have data, a day with
 * no row is **absent** rather than zero, and the shades are computed from the
 * window's own biggest day.
 */
import { describe, expect, it } from "vitest";
import { calendarGrid, monthGrid, monthSummary } from "./calendar";

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


/**
 * The month grid and its summary row, added 2026-09-03 with the modal's clone.
 * September 2026 starts on a Tuesday, which is what makes `leading` worth
 * asserting: a Monday-first grid has to skip exactly one cell before day one.
 */
describe("monthGrid", () => {
  it("spans the whole month and leads with the right weekday offset", () => {
    const grid = monthGrid("2026-09", []);

    expect(grid.cells).toHaveLength(30);
    expect(grid.cells[0].day).toBe("2026-09-01");
    expect(grid.cells[29].day).toBe("2026-09-30");
    // 2026-09-01 is a Tuesday, so Monday's column is empty.
    expect(grid.leading).toBe(1);
  });

  it("paints only the days the series carries", () => {
    const grid = monthGrid("2026-09", [
      { day: "2026-09-02", dailySol: "3.5" },
      { day: "2026-09-04", dailySol: "-1.25" },
    ]);

    expect(grid.cells[1]).toMatchObject({ day: "2026-09-02", direction: "gain" });
    expect(grid.cells[3]).toMatchObject({ day: "2026-09-04", direction: "loss" });
    // Absent, not zero: DESIGN.md, "Absence is rendered as absence."
    expect(grid.cells[2].dailySol).toBeNull();
    expect(grid.cells[2].direction).toBe("");
  });

  it("gives an empty grid for a month that is not one", () => {
    for (const bad of ["2026-13", "2026", "septiembre", "2026-00"]) {
      expect(monthGrid(bad, []).cells).toEqual([]);
    }
  });
});

describe("monthSummary", () => {
  const series = [
    { day: "2026-09-01", dailySol: "2" },
    { day: "2026-09-02", dailySol: "5" },
    { day: "2026-09-03", dailySol: "-1" },
    { day: "2026-09-05", dailySol: "1" },
    { day: "2026-09-06", dailySol: "4" },
    { day: "2026-09-07", dailySol: "3" },
  ];

  it("counts the days each way and names the best one", () => {
    const summary = monthSummary("2026-09", series);

    expect(summary.gainDays).toBe(5);
    expect(summary.lossDays).toBe(1);
    expect(summary.best).toBe("5");
  });

  it("breaks the streak on a quiet day, not only on a losing one", () => {
    // 5, 6 and 7 are three consecutive gains; 1 and 2 are two, and the 4th is
    // absent, so the run cannot reach across it.
    expect(monthSummary("2026-09", series).streak).toBe(3);

    // With the 4th filled in as a gain the days read +,+,-,+,+,+,+ : the loss
    // on the 3rd still cuts it, so the longest run is the four days after it.
    expect(
      monthSummary("2026-09", [...series, { day: "2026-09-04", dailySol: "0.5" }]).streak,
    ).toBe(4);
  });

  it("says nothing rather than zero when the month closed nothing", () => {
    expect(monthSummary("2026-09", [])).toEqual({
      gainDays: 0,
      lossDays: 0,
      best: null,
      streak: 0,
    });
  });
});
