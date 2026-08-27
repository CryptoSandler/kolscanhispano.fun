/**
 * DESIGN.md's *"Every surface has two states"* rule, asserted on rendered
 * markup rather than on the source of the components.
 *
 * The two strings per surface are **parsed out of DESIGN.md at run time**, the
 * way `design-tokens.test.ts` parses the palette: the document is normative, so
 * a test carrying its own copy of the copy would be a second source of truth
 * and would keep passing after the document changed. Editing either sentence in
 * `DESIGN.md` fails this file until the component says the same thing.
 *
 * Both surfaces are rendered for real — `FeedLive` with no trades, and
 * `LeaderboardTable` with no entries — because this project has shipped tests
 * that were green over something wrong before, and a test that greps a `.tsx`
 * file passes for exactly as long as the text survives, including after the
 * text stops being what the page shows.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FeedLive } from "./feed-live";
import { LeaderboardTable } from "./leaderboard-table";

const DESIGN = readFileSync(join(import.meta.dirname, "..", "..", "DESIGN.md"), "utf8");

/**
 * The `| surface | populated | empty |` table in DESIGN.md, as
 * `{ surface: [line1, line2] }`.
 *
 * Only the two rows whose empty cell is a two-part `line / line` pair are
 * matched — the table's other two rows are single-cell states (`sin cierres`,
 * `sin precio`), which `feed-live.test.ts` and `leaderboard-table` cover
 * elsewhere.
 */
function emptyStates(): Record<string, [string, string]> {
  const out: Record<string, [string, string]> = {};
  for (const [, surface, lead, note] of DESIGN.matchAll(
    /^\| `([a-z]+)` \| [^|]+ \| `([^`]+)` \/ `([^`]+)` \|$/gm,
  )) {
    out[surface] = [lead, note];
  }
  return out;
}

describe("DESIGN.md's empty states are what the surfaces render", () => {
  it("names both surfaces in the document", () => {
    // If the table is reshaped so the parse above stops matching, every
    // assertion below would trivially pass on an empty object.
    expect(Object.keys(emptyStates()).sort()).toEqual(["feed", "leaderboard"]);
  });

  it("renders the feed's two lines, and no row", () => {
    const [lead, note] = emptyStates().feed;
    const html = renderToStaticMarkup(createElement(FeedLive, { initialTrades: [] }));

    expect(html).toContain(lead);
    expect(html).toContain(note);
    // The fact in `ink`, what will occupy the space in `ink-muted`.
    expect(html).toContain(`<p class="state-empty-lead">${lead}</p>`);
    expect(html).toContain(`<p class="state-empty-note">${note}</p>`);

    // It is inside the same list the rows occupy, so the panel keeps its
    // shape — and it fabricates nothing: no row, no zero, no skeleton.
    expect(html).toContain('<ul class="feed-list">');
    expect(html).not.toContain("row-feed");
    expect(html).not.toContain("skeleton");

    // "It does not apologise." The three shapes DESIGN.md names.
    for (const apology of ["Ups", "Lo sentimos", "Todavía no hay operaciones registradas."]) {
      expect(html).not.toContain(apology);
    }
  });

  it("renders the leaderboard's two lines, and no table", () => {
    const [lead, note] = emptyStates().leaderboard;
    const html = renderToStaticMarkup(
      createElement(LeaderboardTable, { entries: [], unit: "sol" as const }),
    );

    expect(html).toContain(`<p class="state-empty-lead">${lead}</p>`);
    expect(html).toContain(`<p class="state-empty-note">${note}</p>`);

    // No zeroed rows and no header row standing over records that do not
    // exist — DESIGN.md's measured case is kolscan.io's fifty rows of
    // `+0.00 Sol` off a stalled indexer.
    expect(html).not.toContain("<table");
    expect(html).not.toContain("row-leaderboard");
    expect(html).not.toContain("0,00");
    expect(html).not.toContain("Todavía no hay KOLs en la clasificación.");
  });
});
