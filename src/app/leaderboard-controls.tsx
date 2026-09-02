"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { WINDOW_LABELS } from "@/lib/windows";

/**
 * **The controls live on the page, beside its title, and not in the chrome.**
 * They were in the site header until 2026-09-02, on DESIGN.md's *"Header:
 * wordmark and subtitle left, nav centre, unit and window controls plus the
 * wallet action right"* — the mould puts them on the ranking itself, to the
 * right of `KOL Leaderboard`, and `docs/clone-map.md` §2 is the decision that
 * moved them. That paragraph of DESIGN.md moved with them.
 *
 * It costs something and the something is worth naming: off `/leaderboard`
 * there is no longer a window toggle in reach. That is the mould's arrangement
 * — their home *is* the ranking — and here the home page's top ten is
 * explicitly the daily window with the USD total, with `Ver todo` beside it for
 * anything else.
 *
 * DESIGN.md `segmented`: *"`Diario · Semanal · Mensual` and `USD · ARS` as pill
 * segments; selected segment `surface-3` with cyan text. **All three windows
 * are real aggregations; none is a disabled stub.**"* `LEADERBOARD_WINDOWS` is
 * `["diario","semanal","mensual"]` and `readLeaderboard` aggregates each of
 * them, so all three are links to a page that answers.
 *
 * **`USD · ARS`, and it chooses the fiat rather than the ranked figure.** It
 * read `SOL · USD` until 2026-09-02, when the owner's clone decision replaced
 * it: the mould toggles `USD · BRL` beside a ranking that is always sorted by
 * the chain figure, so ours does the same. `docs/round-ars.md` is the round the
 * peso required, and it is where the choice of rate is recorded as open.
 *
 * **Both segments always show, including when there is no rate.** The peso
 * page still answers — its figures render `sin precio` and the qualifier line
 * says why — so this is not DESIGN.md's *"control that does not work"*; it is
 * absence rendered as absence, one layer further in. The alternative was a
 * second database read in the root layout to decide whether to draw a pill.
 *
 * Links, not buttons: every combination is a real URL, so the state survives a
 * reload, a share and a back button, and the control ships no script for
 * itself. The one thing it needs the browser for is which segment is selected,
 * which is why this is a client component — a layout is not handed
 * `searchParams`, and reading them here is what keeps the control in step with
 * the page below it.
 *
 * Off `/leaderboard` the parameters are absent and the defaults show, which are
 * exactly what the home page's top ten is: the daily window with the USD total.
 * Choosing a segment from there navigates to the full ranking with that choice
 * applied.
 *
 * The option lists arrive as props rather than being imported:
 * `LEADERBOARD_FIATS` lives in `@/lib/leaderboard`, which imports the Postgres
 * driver, and a client component importing it would pull `pg` into the browser
 * bundle.
 *
 * The query parameter is still called `unit`, which is what it was published
 * as; `leaderboard.ts` carries the reasoning.
 */
const FIAT_LABELS: Record<string, string> = { usd: "USD", ars: "ARS" };

export function LeaderboardControls({
  windows,
  fiats,
  basePath = "/leaderboard",
}: {
  windows: readonly string[];
  /**
   * Empty renders no currency group at all, which is what `/cabals` passes: no
   * figure on that page is in a fiat the reader chose, so a toggle over one
   * would be a control that changes nothing.
   */
  fiats: readonly string[];
  /** Where a segment navigates. `/cabals` keeps its own route. */
  basePath?: string;
}) {
  /*
    `useSearchParams` is typed non-null and **is** null when this renders
    outside a request — `renderToStaticMarkup` on the page, which is exactly how
    `address-invariant.test.ts` reads every public surface for an address. It
    was unreachable from that test while this lived in the layout; moving it
    onto the page made it reachable and it threw.

    So the query string is read defensively and its absence means the defaults,
    which is the same answer this control already gives on a URL that carries no
    parameters. A control that cannot render without a router is a control that
    cannot be swept for an address.
  */
  const params = useSearchParams();
  const selected = (name: string): string | null => params?.get(name) ?? null;

  // The same fallbacks the page applies to an unreadable parameter, so the
  // control and the page cannot disagree about what is selected.
  const window = windows.includes(selected("window") ?? "") ? selected("window")! : windows[0];
  const unit = fiats.includes(selected("unit") ?? "") ? selected("unit")! : fiats[0];

  const href = (next: { window?: string; unit?: string }) =>
    fiats.length === 0
      ? `${basePath}?window=${next.window ?? window}`
      : `${basePath}?window=${next.window ?? window}&unit=${next.unit ?? unit}`;

  return (
    <div className="controls">
      {/* **Currency first, then the window** — the mould's order
          (`docs/parecido-2026-09-02.md` §2), which puts the smaller group
          nearer the title. */}
      {fiats.length > 0 && (
        <div className="segmented" role="group" aria-label="Moneda">
          {fiats.map((option) => (
            <Link
              key={option}
              className={option === unit ? "segment is-selected" : "segment"}
              aria-current={option === unit ? "true" : undefined}
              href={href({ unit: option })}
            >
              {FIAT_LABELS[option] ?? option}
            </Link>
          ))}
        </div>
      )}

      <div className="segmented is-windows" role="group" aria-label="Ventana">
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
    </div>
  );
}
