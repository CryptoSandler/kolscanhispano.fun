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

/**
 * The windows, spelled the way the URL spells them.
 *
 * **Six since 2026-09-03, and the split matters more than the count.** The
 * first three are spec §4.9's calendar-aligned UTC periods; the last three are
 * rolling intervals ending now. `docs/round-ventanas-moviles.md` is the round
 * `CLAUDE.md` requires before changing what a number means, and §4 is the
 * owner's decision: the rolling windows are **added**, never a relabelling —
 * *"`Diario` is a calendar day UTC and `1D` is the last 24 hours; a reader who
 * does not open a tooltip must still not be misled, so the labels stay
 * distinct rather than one set being relabelled."*
 *
 * Order is the order the toggle renders, calendar first: the product's answer
 * to "who won today" is still the calendar day, because that is the only one
 * where two KOLs are compared over an interval every reader shares.
 */
export const LEADERBOARD_WINDOWS = ["1d", "7d", "30d"] as const;

/**
 * The calendar names this product used to rank by, and what each becomes.
 *
 * They are **not** windows any more — they do not appear in
 * {@link LEADERBOARD_WINDOWS}, no surface offers them and nothing sums them —
 * but they were published URLs for weeks, so `/` and `/cabals` answer one with
 * a **308** to its rolling equivalent rather than with a default. A permanent
 * redirect and not a temporary one: the old value is not coming back, and a
 * `308` is what tells a crawler, a bookmark and a shared link the same thing.
 *
 * The mapping is by *span*, which is the only honest correspondence available:
 * a month is closer to 30 days than to anything else on offer. It is not an
 * equivalence — `Mensual` was the calendar month and `30D` is the last 30 days
 * — and that is exactly why the labels never shared a name.
 */
export const LEGACY_WINDOWS: Record<string, LeaderboardWindow> = {
  diario: "1d",
  semanal: "7d",
  mensual: "30d",
};

/**
 * Which windows are rolling. `windowBounds` answers for both kinds, but the
 * **query** differs: a calendar window sums `pnl_daily` between two `date`s and
 * a rolling one sums `trade.realized_sol` between two instants, because a day
 * bucket cannot be cut at an arbitrary hour (`migrations/015`).
 */
const ROLLING: Record<LeaderboardWindow, number> = { "1d": 1, "7d": 7, "30d": 30 };


/**
 * The three calendar windows alone, for a surface that has no rolling read.
 *
 * `/cabals` is the one: `cabals.ts` sums `pnl_daily` and there is no per-sell
 * cabal total, because a cabal's figure is the sum of its members' days. Adding
 * `1D` to that control would offer a value the query rounds back to a whole day
 * — *"a different number wearing the label"*, which is the exact failure
 * `docs/round-ventanas-moviles.md` §1 argued against. A control that does not
 * work is worse than a control that is not there (DESIGN.md), so the board
 * offers the three it can actually answer.
 *
 * ponytail: the rolling three reach `/cabals` by giving `cabals.ts` the same
 * `trade`-summing statement `leaderboard.ts` now has. It is not done because
 * nothing has asked for a rolling cabal board, and the upgrade is one statement
 * and one branch, in the file that already carries the pair beside it.
 */
export const CALENDAR_WINDOWS = ["diario", "semanal", "mensual"] as const;

export type LeaderboardWindow = (typeof LEADERBOARD_WINDOWS)[number];

/**
 * How each window is named on screen, in neutral Spanish.
 *
 * DESIGN.md `segmented`: *"`Diario · Semanal · Mensual` ... as pill segments"*.
 * It lives beside the windows themselves because three surfaces name them now —
 * the header's control, `/leaderboard`'s subtitle and `modal-kol`'s segments —
 * and three copies of a label table is how one of them ends up saying
 * `Mensual` for `semanal`.
 *
 * This module imports nothing but itself, so a client component can reach it
 * without dragging the Postgres driver into the browser bundle, which is why
 * the labels are here rather than in `leaderboard.ts`.
 */
export const WINDOW_LABELS: Record<LeaderboardWindow, string> = {
  "1d": "1D",
  "7d": "7D",
  "30d": "30D",
};

/**
 * What each window actually measures, in one sentence, for the control's
 * tooltip.
 *
 * The round's condition for adding the rolling three: the labels stay distinct
 * *and* say which is which, because `Diario` and `1D` are two different numbers
 * that a reader would otherwise reasonably expect to agree. A tooltip is not
 * enough on its own — that is why the two sets are not renamed into each other
 * — but it is where the exact statement goes.
 */
export const WINDOW_MEANINGS: Record<LeaderboardWindow, string> = {
  "1d": "Las últimas 24 horas, hasta ahora.",
  "7d": "Los últimos 7 días, hasta ahora.",
  "30d": "Los últimos 30 días, hasta ahora.",
};

/**
 * The window a request asked for, or the redirect it earns.
 *
 * Three answers, and the caller has to handle all three:
 *   - a `LeaderboardWindow` — it asked for one of the three that exist;
 *   - a `{ redirectTo }` — it asked for `diario`, `semanal` or `mensual`, which
 *     were published URLs until 2026-09-03 and now earn a **308** to their
 *     rolling equivalent;
 *   - `null` — it asked for nothing, or for something that was never a window,
 *     and gets the default.
 *
 * The redirect is `308` and not `302` because the old value is not coming back:
 * a permanent redirect is what tells a crawler, a bookmark and a shared link the
 * same thing. It is not a `400` for the same reason — those URLs were correct
 * when they were made.
 */
export function resolveWindow(
  raw: string | null,
): LeaderboardWindow | { redirectTo: LeaderboardWindow } | null {
  const window = parseWindow(raw);
  if (window !== null) return window;
  const legacy = raw === null ? undefined : LEGACY_WINDOWS[raw];
  return legacy === undefined ? null : { redirectTo: legacy };
}

/** `from` inclusive, `to` exclusive — the half-open interval a `day` column filters on. */
export type WindowBounds = { from: Date; to: Date };

/** A UTC day, in milliseconds. Constant, unlike a local one. */
const DAY_MS = 86_400_000;



export function windowBounds(window: LeaderboardWindow, now: Date): WindowBounds {
  const instant = now.getTime();
  // An invalid Date would otherwise produce `Invalid Date` bounds and a query
  // that silently matches nothing.
  if (Number.isNaN(instant)) throw new Error("windowBounds needs a valid instant");

  /*
    **Every window ends now, to the millisecond, and starts N days earlier.**

    No `startOfUtcDay` anywhere near this: rounding a rolling window to a day
    boundary is precisely the *"different number wearing the label"* that
    `docs/round-ventanas-moviles.md` §1 argued against, and it is the single
    thing that separates `1D` from the `Diario` it replaced.

    The three calendar arms this function carried until 2026-09-03 are gone with
    the windows themselves. `LEGACY_WINDOWS` maps their old URLs onto these, and
    the month calendar in `modal-kol` builds its own bounds from a `YYYY-MM` —
    it never asked this function for them.
  */
  const days = ROLLING[window];
  if (days === undefined) {
    // A window the type says cannot exist. Louder than an `Invalid Date` pair,
    // which is a query that silently matches nothing.
    throw new Error(`windowBounds does not know the window ${window}`);
  }
  return { from: new Date(instant - days * DAY_MS), to: new Date(instant) };
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
  // The default moved from `diario` to `1d` on 2026-09-03 with the windows
  // themselves. It is the shortest one, as it was before.
  if (raw === null) return "1d";
  return (LEADERBOARD_WINDOWS as readonly string[]).includes(raw)
    ? (raw as LeaderboardWindow)
    : null;
}
