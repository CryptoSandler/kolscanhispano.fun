import { afterEach, describe, expect, it } from "vitest";
import { parseWindow, utcDayString, windowBounds, type LeaderboardWindow } from "./windows";

const now = new Date("2026-08-25T03:30:00Z"); // Tuesday

/**
 * Every `Date` member that reads or writes the *local* calendar. `getTime`,
 * `valueOf`, `toISOString` and the `getUTC*` family are deliberately absent:
 * those are the ones spec §4.9's arithmetic is allowed to use.
 */
const LOCAL_CALENDAR_MEMBERS = [
  "getFullYear",
  "getMonth",
  "getDate",
  "getDay",
  "getHours",
  "getMinutes",
  "getSeconds",
  "getMilliseconds",
  "getTimezoneOffset",
  "setFullYear",
  "setMonth",
  "setDate",
  "setHours",
  "setMinutes",
  "toString",
  "toDateString",
  "toTimeString",
  "toLocaleString",
  "toLocaleDateString",
  "toLocaleTimeString",
] as const;

type Restore = () => void;
let restore: Restore | null = null;

/**
 * Runs `fn` in a world where reading the local calendar is impossible.
 *
 * **Why not `process.env.TZ`.** Node reads `TZ` when the process starts and
 * caches the resolved zone; assigning it mid-run does not reliably change what
 * `Date` does, so a test that sets it and then asserts `2026-08-25T00:00:00Z`
 * is asserting exactly what the plain daily test above already asserts. It
 * passes against a `new Date(y, m, d)` implementation just as happily as
 * against a `Date.UTC` one, which is the definition of passing vacuously.
 *
 * Asserting ISO boundaries under a different zone has the same hole from the
 * other side: on a machine already running at UTC — every default CI runner —
 * local time *is* UTC, so a local-time implementation produces the right
 * answer and the test proves nothing about the machine it was written to
 * protect against.
 *
 * This closes both. Every local-calendar accessor throws for the duration of
 * the call, so `windowBounds` can only return at all if it never consulted
 * one, in any timezone, including UTC. The guard is restored in a `finally`
 * and again in `afterEach`, so a throw inside `fn` cannot leak it into the
 * rest of the file.
 */
function withoutLocalTime<T>(fn: () => T): T {
  const prototype = Date.prototype as unknown as Record<string, unknown>;
  const originals = LOCAL_CALENDAR_MEMBERS.map((name) => [name, prototype[name]] as const);
  for (const [name] of originals) {
    prototype[name] = function forbidden(): never {
      throw new Error(`read local time through Date.prototype.${name}`);
    };
  }

  const RealDate = globalThis.Date;
  // `new Date(2026, 7, 25)` is the local-calendar constructor. `new Date(ms)`
  // and `new Date(iso)` are not, and stay allowed — the module builds its
  // bounds from epoch milliseconds. A proxy rather than a subclass so
  // `Date.UTC`, `Date.now` and `instanceof` keep working untouched.
  globalThis.Date = new Proxy(RealDate, {
    construct(target, args: unknown[]) {
      if (args.length > 1) throw new Error("built a Date from local calendar fields");
      return Reflect.construct(target, args) as object;
    },
  });

  restore = () => {
    globalThis.Date = RealDate;
    for (const [name, original] of originals) prototype[name] = original;
    restore = null;
  };

  try {
    return fn();
  } finally {
    restore?.();
  }
}

afterEach(() => restore?.());

/** Both bounds as ISO strings, so a failure prints the interval it got. */
function isoBounds(window: LeaderboardWindow, at: string): [string, string] {
  const bounds = windowBounds(window, new Date(at));
  return [bounds.from.toISOString(), bounds.to.toISOString()];
}

describe("windowBounds", () => {
  it("daily starts at midnight UTC of the same day", () => {
    expect(windowBounds("diario", now).from.toISOString()).toBe("2026-08-25T00:00:00.000Z");
  });

  it("weekly starts on Monday, ISO week", () => {
    expect(windowBounds("semanal", now).from.toISOString()).toBe("2026-08-24T00:00:00.000Z");
  });

  it("monthly starts on the first of the month", () => {
    expect(windowBounds("mensual", now).from.toISOString()).toBe("2026-08-01T00:00:00.000Z");
  });

  it("ends at the start of the next window, exclusive", () => {
    expect(isoBounds("diario", "2026-08-25T03:30:00Z")).toEqual([
      "2026-08-25T00:00:00.000Z",
      "2026-08-26T00:00:00.000Z",
    ]);
    expect(isoBounds("semanal", "2026-08-25T03:30:00Z")).toEqual([
      "2026-08-24T00:00:00.000Z",
      "2026-08-31T00:00:00.000Z",
    ]);
    expect(isoBounds("mensual", "2026-08-25T03:30:00Z")).toEqual([
      "2026-08-01T00:00:00.000Z",
      "2026-09-01T00:00:00.000Z",
    ]);
  });

  // `getUTCDay` counts from Sunday and ISO 8601 counts from Monday, so Sunday
  // is the day an off-by-one hides on: it is the only weekday where the naive
  // formula lands six days out rather than one.
  it("puts Sunday at the end of its ISO week, not at the start of the next", () => {
    expect(isoBounds("semanal", "2026-08-30T23:59:59.999Z")).toEqual([
      "2026-08-24T00:00:00.000Z",
      "2026-08-31T00:00:00.000Z",
    ]);
    expect(isoBounds("semanal", "2026-08-31T00:00:00.000Z")).toEqual([
      "2026-08-31T00:00:00.000Z",
      "2026-09-07T00:00:00.000Z",
    ]);
  });

  it("holds the ISO week across a year boundary", () => {
    // Thursday 2026-12-31 is in the week that starts Monday 2026-12-28.
    expect(isoBounds("semanal", "2026-12-31T12:00:00Z")).toEqual([
      "2026-12-28T00:00:00.000Z",
      "2027-01-04T00:00:00.000Z",
    ]);
    // And Friday 2027-01-01 is still in it.
    expect(isoBounds("semanal", "2027-01-01T00:00:00.000Z")).toEqual([
      "2026-12-28T00:00:00.000Z",
      "2027-01-04T00:00:00.000Z",
    ]);
  });

  it("rolls the month into the next year in December", () => {
    expect(isoBounds("mensual", "2026-12-31T23:59:59.999Z")).toEqual([
      "2026-12-01T00:00:00.000Z",
      "2027-01-01T00:00:00.000Z",
    ]);
  });

  it("holds the month across February in a leap year", () => {
    expect(isoBounds("mensual", "2028-02-29T18:00:00Z")).toEqual([
      "2028-02-01T00:00:00.000Z",
      "2028-03-01T00:00:00.000Z",
    ]);
  });

  it("includes the first instant of the window and excludes the last", () => {
    expect(isoBounds("diario", "2026-08-25T00:00:00.000Z")[0]).toBe("2026-08-25T00:00:00.000Z");
    expect(isoBounds("diario", "2026-08-25T23:59:59.999Z")[1]).toBe("2026-08-26T00:00:00.000Z");
  });

  /**
   * The property the brief asks for, stated so it cannot pass vacuously: the
   * bounds are derived from `Date.UTC` arithmetic *only*. Under the guard,
   * touching the local calendar throws, so an implementation that used
   * `getDate()` or `new Date(y, m, d)` fails here on every machine — a UTC
   * runner included, where a value-comparison test cannot tell the two apart.
   */
  it("derives every bound without reading the local calendar", () => {
    // Computed under the guard, asserted outside it: `expect` is not part of
    // what is being proved, and it should not be running with a crippled
    // `Date` while it formats a failure.
    const computed = withoutLocalTime(() => ({
      diario: isoBounds("diario", "2026-08-25T03:30:00Z"),
      semanal: isoBounds("semanal", "2026-08-25T03:30:00Z"),
      mensual: isoBounds("mensual", "2026-08-25T03:30:00Z"),
      // A month boundary and a week boundary too: `Date.UTC(year, month + 1, 1)`
      // is the one call in the module that could plausibly be reached for.
      diciembre: isoBounds("mensual", "2026-12-31T23:59:59.999Z"),
      domingo: isoBounds("semanal", "2026-08-30T23:59:59.999Z"),
    }));

    expect(computed.diario).toEqual(["2026-08-25T00:00:00.000Z", "2026-08-26T00:00:00.000Z"]);
    expect(computed.semanal).toEqual(["2026-08-24T00:00:00.000Z", "2026-08-31T00:00:00.000Z"]);
    expect(computed.mensual).toEqual(["2026-08-01T00:00:00.000Z", "2026-09-01T00:00:00.000Z"]);
    expect(computed.diciembre).toEqual(["2026-12-01T00:00:00.000Z", "2027-01-01T00:00:00.000Z"]);
    expect(computed.domingo).toEqual(["2026-08-24T00:00:00.000Z", "2026-08-31T00:00:00.000Z"]);
  });

  // Proof the guard itself bites: if the stubs were not installed, or were
  // installed on the wrong object, the assertions above would pass for the
  // wrong reason.
  it("the local-time guard rejects a local-calendar implementation", () => {
    expect(() =>
      withoutLocalTime(() => Date.UTC(new Date().getFullYear(), 0, 1)),
    ).toThrow(/local time/);
    expect(() => withoutLocalTime(() => new Date(2026, 7, 25))).toThrow(/local calendar/);
  });

  /**
   * Both hemispheres, on the exact days their clocks move. A UTC window is
   * 24 hours long on all of them; a local one is 23 or 25, and its start
   * drifts by an hour for half the year.
   *
   * `Europe/Madrid` springs forward at 2026-03-29T01:00Z and `America/Santiago`
   * falls back at 2026-04-05T03:00Z (`Australia/Sydney` at 2026-04-04T16:00Z);
   * the instants below sit either side of each transition.
   */
  it("keeps every window exactly 24 hours across a DST transition, north and south", () => {
    const transitions = [
      "2026-03-29T00:30:00Z", // Madrid, minutes before it springs forward
      "2026-03-29T01:30:00Z", // Madrid, minutes after — same UTC day
      "2026-04-05T02:30:00Z", // Santiago, minutes before it falls back
      "2026-04-05T03:30:00Z", // Santiago, minutes after
      "2026-04-04T15:30:00Z", // Sydney, minutes before it falls back
      "2026-04-04T16:30:00Z", // Sydney, minutes after — the next UTC day has not started
    ];
    for (const at of transitions) {
      const bounds = windowBounds("diario", new Date(at));
      expect(bounds.to.getTime() - bounds.from.getTime()).toBe(86_400_000);
      expect(bounds.from.toISOString()).toBe(`${at.slice(0, 10)}T00:00:00.000Z`);
      const week = windowBounds("semanal", new Date(at));
      expect(week.to.getTime() - week.from.getTime()).toBe(7 * 86_400_000);
    }
  });

  it("refuses an invalid instant rather than producing an unmatchable window", () => {
    expect(() => windowBounds("diario", new Date("not a date"))).toThrow();
  });
});

describe("utcDayString", () => {
  it("names the UTC day, not the local one", () => {
    // 03:30Z on the 25th is still the 24th anywhere west of UTC−4.
    expect(utcDayString(new Date("2026-08-25T03:30:00Z"))).toBe("2026-08-25");
    // And 23:30Z on the 25th is already the 26th anywhere east of UTC+1.
    expect(utcDayString(new Date("2026-08-25T23:30:00Z"))).toBe("2026-08-25");
  });
});

describe("parseWindow", () => {
  it("defaults an absent parameter to the daily window", () => {
    expect(parseWindow(null)).toBe("diario");
  });

  it("accepts the three windows spec §4.9 names", () => {
    expect(parseWindow("diario")).toBe("diario");
    expect(parseWindow("semanal")).toBe("semanal");
    expect(parseWindow("mensual")).toBe("mensual");
  });

  it("rejects anything else rather than falling back", () => {
    for (const bad of ["daily", "DIARIO", "", "anual", "diario "]) {
      expect(parseWindow(bad)).toBeNull();
    }
  });
});
