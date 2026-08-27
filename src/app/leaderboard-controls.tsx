"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { WINDOW_LABELS } from "@/lib/windows";

/**
 * DESIGN.md, Layout: *"Header: wordmark and subtitle left, nav centre, unit and
 * window controls plus the wallet action right."* So the two `segmented`
 * controls live in the site header, not on the leaderboard page — one place,
 * every route.
 *
 * DESIGN.md `segmented`: *"`Diario · Semanal · Mensual` and `SOL · USD` as pill
 * segments; selected segment `surface-3` with cyan text. **All three windows
 * are real aggregations; none is a disabled stub.**"* `LEADERBOARD_WINDOWS` is
 * `["diario","semanal","mensual"]` and `readLeaderboard` aggregates each of
 * them, so all three are links to a page that answers.
 *
 * **`SOL · USD`, not a national currency.** `docs/references.md` §6: the
 * reference toggles `USD / BRL` because it serves one country; we serve Spain
 * and Latin America, CLAUDE.md fixes the copy as neutral Spanish for that
 * reason, and `ARS` "would be as arbitrary for a reader in Madrid or Bogotá as
 * `BRL` would". There is also no rate source in this codebase to invent one
 * from.
 *
 * Links, not buttons: every combination is a real URL, so the state survives a
 * reload, a share and a back button, and the control ships no script for
 * itself. The one thing it needs the browser for is which segment is selected,
 * which is why this is a client component — a layout is not handed
 * `searchParams`, and reading them here is what keeps the control in step with
 * the page below it.
 *
 * Off `/leaderboard` the parameters are absent and the defaults show, which are
 * exactly what the home page's top ten is: the daily window in SOL. Choosing a
 * segment from there navigates to the full ranking with that choice applied.
 *
 * The option lists arrive as props rather than being imported: `LEADERBOARD_UNITS`
 * lives in `@/lib/leaderboard`, which imports the Postgres driver, and a client
 * component importing it would pull `pg` into the browser bundle.
 */
const UNIT_LABELS: Record<string, string> = { sol: "SOL", usd: "USD" };

export function LeaderboardControls({
  windows,
  units,
}: {
  windows: readonly string[];
  units: readonly string[];
}) {
  const params = useSearchParams();
  // The same fallbacks `/leaderboard` applies to an unreadable parameter, so
  // the control and the page cannot disagree about what is selected.
  const window = windows.includes(params.get("window") ?? "") ? params.get("window")! : windows[0];
  const unit = units.includes(params.get("unit") ?? "") ? params.get("unit")! : units[0];

  const href = (next: { window?: string; unit?: string }) =>
    `/leaderboard?window=${next.window ?? window}&unit=${next.unit ?? unit}`;

  return (
    <div className="controls">
      <div className="segmented" role="group" aria-label="Ventana">
        {windows.map((option) => (
          <Link
            key={option}
            className={option === window ? "segment is-selected" : "segment"}
            aria-current={option === window ? "true" : undefined}
            href={href({ window: option })}
          >
            {WINDOW_LABELS[option as keyof typeof WINDOW_LABELS] ?? option}
          </Link>
        ))}
      </div>

      <div className="segmented" role="group" aria-label="Unidad">
        {units.map((option) => (
          <Link
            key={option}
            className={option === unit ? "segment is-selected" : "segment"}
            aria-current={option === unit ? "true" : undefined}
            href={href({ unit: option })}
          >
            {UNIT_LABELS[option] ?? option}
          </Link>
        ))}
      </div>
    </div>
  );
}
