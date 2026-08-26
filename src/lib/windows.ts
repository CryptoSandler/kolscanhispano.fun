/**
 * The leaderboard's three windows, spec §4.9: **calendar-aligned UTC**, never
 * rolling. `Diario` is the current UTC day, `Semanal` the current ISO week
 * (Monday-based), `Mensual` the current calendar month.
 *
 * Why UTC and not a local zone: the audience spans UTC−6 to UTC+1 and there is
 * no "Hispanic" timezone, so any local choice hands the day boundary to one
 * country. The UI says `día UTC` for exactly this reason.
 *
 * **Nothing here may read local time.** Every bound is built from
 * `Date.UTC` and the UTC accessors, and the arithmetic below adds whole days
 * as milliseconds because a UTC day is always exactly 86,400,000 ms — UTC has
 * no daylight saving, and leap seconds do not exist on the JavaScript time
 * scale. The same arithmetic in local time is wrong twice a year in half the
 * world: `new Date(y, m, d)` on the morning a zone springs forward produces a
 * day that is 23 hours long, and the boundary silently moves.
 *
 * A `getFullYear`, a `getDate`, a `toLocaleDateString` or a
 * `new Date(y, m, d)` anywhere in this file would make the window depend on
 * the machine the server happens to run on. `windows.test.ts` runs
 * {@link windowBounds} with every local-calendar accessor on `Date.prototype`
 * replaced by a throwing stub, so that is a test failure rather than a
 * convention.
 */

/** The three windows spec §4.9 defines, spelled the way the URL spells them. */
export const LEADERBOARD_WINDOWS = ["diario", "semanal", "mensual"] as const;

export type LeaderboardWindow = (typeof LEADERBOARD_WINDOWS)[number];

/** `from` inclusive, `to` exclusive — the half-open interval a `day` column filters on. */
export type WindowBounds = { from: Date; to: Date };

/** A UTC day, in milliseconds. Constant, unlike a local one. */
const DAY_MS = 86_400_000;

/** Midnight UTC of the day `now` falls in, as epoch milliseconds. */
function startOfUtcDay(now: Date): number {
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
}

/**
 * `0` for Monday through `6` for Sunday.
 *
 * `getUTCDay` counts from Sunday, and ISO 8601 — which is what spec §4.9's
 * "current ISO week" means — counts from Monday. Getting this wrong moves the
 * weekly window by a day for one seventh of the week and by six for another,
 * which looks like missing data rather than like an off-by-one.
 */
function isoWeekday(now: Date): number {
  return (now.getUTCDay() + 6) % 7;
}

export function windowBounds(window: LeaderboardWindow, now: Date): WindowBounds {
  const instant = now.getTime();
  // An invalid Date would otherwise produce `Invalid Date` bounds and a query
  // that silently matches nothing.
  if (Number.isNaN(instant)) throw new Error("windowBounds needs a valid instant");

  switch (window) {
    case "diario": {
      const from = startOfUtcDay(now);
      return { from: new Date(from), to: new Date(from + DAY_MS) };
    }
    case "semanal": {
      const from = startOfUtcDay(now) - isoWeekday(now) * DAY_MS;
      return { from: new Date(from), to: new Date(from + 7 * DAY_MS) };
    }
    case "mensual": {
      const year = now.getUTCFullYear();
      const month = now.getUTCMonth();
      // Month 12 rolls into January of the next year, which `Date.UTC`
      // normalises; there is no year-end special case to forget.
      return { from: new Date(Date.UTC(year, month, 1)), to: new Date(Date.UTC(year, month + 1, 1)) };
    }
  }
}

/**
 * `YYYY-MM-DD`, for a `date` query parameter.
 *
 * `pnl_daily.day` is a `date`, and handing `pg` a `Date` for it would send a
 * timestamp that Postgres casts using the *session* time zone — the same
 * local-time leak this module exists to avoid, one layer down. A day string
 * has no zone to interpret.
 */
export function utcDayString(instant: Date): string {
  return instant.toISOString().slice(0, 10);
}

/**
 * The `window` query parameter. An absent parameter takes the default;
 * anything that is not one of the three is `null` — *reject* — rather than
 * quietly falling back, so an API caller with a typo learns about it instead
 * of reading a ranking it did not ask for.
 */
export function parseWindow(raw: string | null): LeaderboardWindow | null {
  if (raw === null) return "diario";
  return (LEADERBOARD_WINDOWS as readonly string[]).includes(raw)
    ? (raw as LeaderboardWindow)
    : null;
}
