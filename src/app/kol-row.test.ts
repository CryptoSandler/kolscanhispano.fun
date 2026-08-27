/**
 * The seam left for task B's `modal-kol`, asserted from both sides.
 *
 * DESIGN.md says two things about this row that pull against each other while
 * the modal does not exist:
 *
 * - `row-leaderboard`: *"whole row clickable and focusable (it opens the
 *   modal)"*.
 * - Don'ts: *"**Don't** show a control that does not work."*
 *
 * `kol-modal.tsx` resolves them by making the affordance conditional on a
 * provider being mounted. That is only worth anything if both halves are real,
 * and a seam nobody has ever rendered through is the shape this repository has
 * shipped before — `fee_sol`, `tokenMetadata`, `avatarUrl` were all values
 * nothing read. So: with no provider the row must carry no interactive
 * attribute at all, and with one it must carry the whole set.
 *
 * `renderToStaticMarkup` cannot fire a click, so what is asserted is the markup
 * the browser would attach the handler to — `tabindex`, the accessible name,
 * and the class the pointer cursor hangs off. The handler itself is one
 * `useContext` away from those in the same branch.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { KolModalContext } from "./kol-modal";
import { KolRow } from "./kol-row";

/** A row, wrapped in the table markup React expects a `<tr>` to live in. */
function render(open?: (slug: string) => void): string {
  const row = createElement(
    KolRow,
    { name: "KOL Uno", slug: "kol-uno", podium: 1 as const },
    createElement("td", null, "celda"),
  );
  const table = createElement("table", null, createElement("tbody", null, row));
  return renderToStaticMarkup(
    open === undefined
      ? table
      : createElement(KolModalContext.Provider, { value: open }, table),
  );
}

describe("KolRow while `modal-kol` is unbuilt", () => {
  it("renders a plain row: nothing to click, nothing to focus", () => {
    const html = render();

    expect(html).toContain('class="row-leaderboard is-podium-1"');
    expect(html).not.toContain("tabindex");
    expect(html).not.toContain("is-clickable");
    expect(html).not.toContain("aria-label");
  });
});

describe("KolRow once a modal is provided", () => {
  it("becomes clickable and keyboard-focusable, named by the KOL it opens", () => {
    const html = render(() => {});

    expect(html).toContain('tabindex="0"');
    expect(html).toContain("is-clickable");
    expect(html).toContain('aria-label="Ver el detalle de KOL Uno"');
  });

  it("keeps the row semantics a screen reader reads the table with", () => {
    // `role="button"` on a `<tr>` would replace those semantics, so the
    // keyboard reach is bought with `tabindex` and an accessible name instead.
    expect(render(() => {})).not.toContain("role=");
  });

  it("still marks the podium, so the affordance does not displace the rank tint", () => {
    expect(render(() => {})).toContain("is-podium-1");
  });
});
