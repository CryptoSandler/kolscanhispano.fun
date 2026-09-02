"use client";

import { useContext, type ReactNode } from "react";
import { GoneKolsContext, KolModalContext, NO_MODAL } from "./kol-modal";

/**
 * The `<li>` of DESIGN.md's `row-leaderboard`, and the only client code the
 * leaderboard ships.
 *
 * *"56px, `surface-2` on hover, whole row clickable and focusable (it opens the
 * modal)."* The cells stay server-rendered — they are passed in as `children`,
 * so every figure is still formatted on the server and `leaderboard-table.tsx`
 * remains a server component.
 *
 * **It was a `<tr>` until 2026-09-02**, when the ranking became a list of cards
 * so it could wrap at 390 instead of hiding the PnL behind a horizontal scroll
 * (`docs/clone-map.md` §4, and the reasoning in `globals.css`).
 *
 * **Interactivity is conditional on the modal existing** (see `kol-modal.tsx`).
 * Without a provider this is a plain list item, which is what DESIGN.md's
 * *"Don't show a control that does not work"* requires while `modal-kol` is
 * unbuilt.
 *
 * `role="button"` is deliberately **not** set, for the reason it was not set on
 * the `<tr>`: it would replace the structural role a screen reader navigates
 * the ranking by — twelve buttons in a row announce their count and nothing
 * about their order. `tabindex` plus an `aria-label` naming the action gives
 * the keyboard the same reach without that cost, and it keeps the `@handle`
 * link legal, which it would not be inside a button.
 *
 * The `closest("a")` guard is what keeps that link going to X rather than
 * opening the modal — the whole card is the target, so the one real link on it
 * has to be excluded explicitly.
 */
export function KolRow({
  name,
  slug,
  podium,
  children,
}: {
  name: string;
  slug: string;
  /** 1, 2 or 3 for the podium; `null` for every other rank. */
  podium: 1 | 2 | 3 | null;
  /**
   * The card's cells, rendered by the caller. Optional only so `createElement`
   * can pass them positionally, which is how `kol-row.test.ts` builds a row
   * without tripping `react/no-children-prop`.
   */
  children?: ReactNode;
}) {
  const open = useContext(KolModalContext);
  const gone = useContext(GoneKolsContext);

  /*
    DESIGN.md, on the gone state: "the row leaves the list when the modal
    closes", and "the stale row is removed on close rather than left to invite a
    second click."

    The row is removed rather than disabled or greyed, because a disabled row is
    the very thing the last Don't rules out — "Don't show a control that does not
    work" — and because the KOL is not withheld from the reader, it is *not on
    the padrón any more*, which is the same absence spec §9 keeps off every
    public surface.

    **The ranks left behind are not renumbered**, and that is deliberate: the
    ranking was measured with this KOL in it, and shifting `004` up to `003`
    would restate a measurement rather than remove a row. A gap is honest; the
    next page load is ranked without it.
  */
  if (gone.has(slug)) return null;

  // DESIGN.md: "Ranks 1-3 additionally carry their `podium-N-wash` background."
  const className = podium === null ? "row-leaderboard" : `row-leaderboard is-podium-${podium}`;

  if (open === NO_MODAL) return <li className={className}>{children}</li>;

  return (
    <li
      className={`${className} is-clickable`}
      tabIndex={0}
      aria-label={`Ver el detalle de ${name}`}
      onClick={(event) => {
        if ((event.target as HTMLElement).closest("a")) return;
        open(slug);
      }}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        if ((event.target as HTMLElement).closest("a")) return;
        // Space scrolls the page otherwise, and Enter inside a focused row
        // would do nothing at all.
        event.preventDefault();
        open(slug);
      }}
    >
      {children}
    </li>
  );
}
