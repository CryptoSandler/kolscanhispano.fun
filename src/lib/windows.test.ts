import { afterEach, describe, expect, it } from "vitest";
import {
  LEADERBOARD_WINDOWS,
  parseWindow,
  resolveWindow,
  utcDayString,
  windowBounds,
  type LeaderboardWindow,
} from "./windows";


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
  /*
    **These pinned the calendar boundaries until 2026-09-03**, and the reason
    they were the sharpest tests in this file — Sunday, the year boundary, the
    leap February — is that a calendar window has boundaries to get wrong. A
    rolling window has none: it ends now and starts N days earlier, and the
    whole class of off-by-one this file existed to catch cannot occur.

    So they are replaced rather than deleted, by the properties that *can* now
    be wrong: that the window ends at the caller's instant to the millisecond
    and not at a rounded one, that a day is exactly 86,400,000 ms of arithmetic,
    and that no local-time accessor is touched — which is the one guard that
    survives unchanged, and is asserted below with every one of them stubbed.
  */
  it("ends at the caller's instant, to the millisecond", () => {
    for (const window of LEADERBOARD_WINDOWS) {
      expect(isoBounds(window, "2026-08-25T03:30:12.345Z")[1]).toBe("2026-08-25T03:30:12.345Z");
    }
  });

  it("starts exactly N days earlier", () => {
    expect(isoBounds("1d", "2026-08-25T03:30:00Z")).toEqual([
      "2026-08-24T03:30:00.000Z",
      "2026-08-25T03:30:00.000Z",
    ]);
    expect(isoBounds("7d", "2026-08-25T03:30:00Z")).toEqual([
      "2026-08-18T03:30:00.000Z",
      "2026-08-25T03:30:00.000Z",
    ]);
    expect(isoBounds("30d", "2026-08-25T03:30:00Z")).toEqual([
      "2026-07-26T03:30:00.000Z",
      "2026-08-25T03:30:00.000Z",
    ]);
  });

  /**
   * **No rounding to a day boundary, ever.** This is the property that
   * separates `1D` from the `Diario` it replaced: a rolling window that started
   * at midnight would be the calendar window under a new label, which is what
   * `docs/round-ventanas-moviles.md` §1 called "a different number wearing the
   * label". An instant three and a half hours into a day must produce bounds
   * three and a half hours into two other days.
   */
  it("never snaps to midnight", () => {
    for (const window of LEADERBOARD_WINDOWS) {
      const [from, to] = isoBounds(window, "2026-08-25T03:30:00Z");
      expect(from.endsWith("T00:00:00.000Z"), `${window} from`).toBe(false);
      expect(to.endsWith("T00:00:00.000Z"), `${window} to`).toBe(false);
    }
  });

  /**
   * A rolling window crosses a month, a year and a leap day with no special
   * case, because it is subtraction rather than calendar arithmetic. These are
   * the same dates the calendar tests used, kept so the file still says what
   * happens there.
   */
  it("crosses a year and a leap day without a special case", () => {
    expect(isoBounds("7d", "2027-01-01T00:00:00.000Z")[0]).toBe("2026-12-25T00:00:00.000Z");
    expect(isoBounds("30d", "2028-03-01T12:00:00Z")[0]).toBe("2028-01-31T12:00:00.000Z");
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
      un: isoBounds("1d", "2026-08-25T03:30:00Z"),
      siete: isoBounds("7d", "2026-08-25T03:30:00Z"),
      treinta: isoBounds("30d", "2026-08-25T03:30:00Z"),
      // A month boundary and a year boundary too: subtraction crosses both with
      // no special case, and this is where a calendar implementation would
      // reach for one.
      diciembre: isoBounds("30d", "2026-12-31T23:59:59.999Z"),
      bisiesto: isoBounds("30d", "2028-03-01T12:00:00.000Z"),
    }));

    expect(computed.un).toEqual(["2026-08-24T03:30:00.000Z", "2026-08-25T03:30:00.000Z"]);
    expect(computed.siete).toEqual(["2026-08-18T03:30:00.000Z", "2026-08-25T03:30:00.000Z"]);
    expect(computed.treinta).toEqual(["2026-07-26T03:30:00.000Z", "2026-08-25T03:30:00.000Z"]);
    expect(computed.diciembre).toEqual([
      "2026-12-01T23:59:59.999Z",
      "2026-12-31T23:59:59.999Z",
    ]);
    expect(computed.bisiesto).toEqual([
      "2028-01-31T12:00:00.000Z",
      "2028-03-01T12:00:00.000Z",
    ]);
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
      // A rolling window is exactly N days of milliseconds across every one of
      // these, which is the property a local-calendar implementation loses:
      // `new Date(y, m, d)` on the morning a zone springs forward produces a
      // day 23 hours long.
      const day = windowBounds("1d", new Date(at));
      expect(day.to.getTime() - day.from.getTime(), at).toBe(86_400_000);
      expect(day.to.toISOString(), at).toBe(new Date(at).toISOString());

      const week = windowBounds("7d", new Date(at));
      expect(week.to.getTime() - week.from.getTime(), at).toBe(7 * 86_400_000);

      const month = windowBounds("30d", new Date(at));
      expect(month.to.getTime() - month.from.getTime(), at).toBe(30 * 86_400_000);
    }
  });

  it("refuses an invalid instant rather than producing an unmatchable window", () => {
    expect(() => windowBounds("1d", new Date("not a date"))).toThrow();
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
  it("defaults an absent parameter to the shortest window", () => {
    expect(parseWindow(null)).toBe("1d");
  });

  it("accepts the three rolling windows and nothing else", () => {
    expect(parseWindow("1d")).toBe("1d");
    expect(parseWindow("7d")).toBe("7d");
    expect(parseWindow("30d")).toBe("30d");
  });

  /**
   * **The three calendar names are not windows any more, and are not errors
   * either.** They were published URLs for weeks (`docs/round-ventanas-moviles.md`
   * §5), so `parseWindow` refuses them — they name nothing this product sums —
   * and `resolveWindow` turns each into the 308 the pages and both API routes
   * answer with. A value that was never a window stays `null` in both.
   */
  it("sends a published calendar name to its rolling equivalent, not to an error", () => {
    expect(parseWindow("diario")).toBeNull();
    expect(resolveWindow("diario")).toEqual({ redirectTo: "1d" });
    expect(resolveWindow("semanal")).toEqual({ redirectTo: "7d" });
    expect(resolveWindow("mensual")).toEqual({ redirectTo: "30d" });

    // Never a window, so never a redirect: a caller asking for `anual` should
    // learn it does not exist rather than read a figure under a label it chose.
    expect(resolveWindow("anual")).toBeNull();
    expect(resolveWindow("DIARIO")).toBeNull();
    // Absent is the default, not a redirect.
    expect(resolveWindow(null)).toBe("1d");
  });

  it("rejects anything else rather than falling back", () => {
    for (const bad of ["daily", "DIARIO", "", "anual", "diario "]) {
      expect(parseWindow(bad)).toBeNull();
    }
  });
});
