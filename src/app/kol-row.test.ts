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
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { GoneKolsContext, KolModalContext } from "./kol-modal";
import { KolRow } from "./kol-row";

/** A row, wrapped in the table markup React expects a `<tr>` to live in. */
function render(open?: (slug: string) => void, gone?: ReadonlySet<string>): string {
  const row = createElement(
    KolRow,
    { name: "KOL Uno", slug: "kol-uno", podium: 1 as const },
    createElement("td", null, "celda"),
  );
  let tree: ReactElement = createElement("table", null, createElement("tbody", null, row));
  if (open !== undefined) {
    tree = createElement(KolModalContext.Provider, { value: open }, tree);
  }
  if (gone !== undefined) {
    tree = createElement(GoneKolsContext.Provider, { value: gone }, tree);
  }
  return renderToStaticMarkup(tree);
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

/**
 * The other half of DESIGN.md's gone state, on the surface it actually happens
 * on.
 *
 * *"`Este KOL ya no está en el padrón.` — **no retry**, and the row leaves the
 * list when the modal closes"*, and the paragraph beneath: *"the stale row is
 * removed on close rather than left to invite a second click."*
 *
 * The modal decides *when* a slug is gone; this file pins what the row does
 * about it, which is the composition half — `KolModalHost` puts the set on
 * `GoneKolsContext` and nothing else reads it, so a set that grew and changed
 * nothing on the page would be exactly the defect this repository keeps
 * shipping.
 */
describe("KolRow when its KOL is gone", () => {
  it("renders nothing at all, rather than a row that cannot be opened", () => {
    const html = render(() => {}, new Set(["kol-uno"]));

    expect(html).toBe("<table><tbody></tbody></table>");
    // Not disabled, not greyed, not `aria-disabled` — DESIGN.md's last Don't is
    // about the control existing at all.
    expect(html).not.toContain("row-leaderboard");
    expect(html).not.toContain("disabled");
  });

  it("leaves every other row exactly as it was", () => {
    // The set is a filter, not a mode: a row that is not in it must be
    // byte-identical to the same row rendered with no set at all.
    expect(render(() => {}, new Set(["otro-kol"]))).toBe(render(() => {}));
  });

  it("is a no-op with no provider, so the plain table is unaffected", () => {
    expect(render()).toContain("row-leaderboard");
  });
});
