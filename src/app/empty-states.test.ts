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
import type { PublicLeaderboardEntry } from "@/lib/serialize";
import { FeedLive } from "./feed-live";
import { LeaderboardTable } from "./leaderboard-table";

/**
 * A ranked row. `winRate === null` is `serialize.ts`'s "nothing closed in the
 * window"; a string is a real measurement over a real denominator.
 */
function entry(rank: number, overrides: Partial<PublicLeaderboardEntry> = {}): PublicLeaderboardEntry {
  return {
    rank,
    kol: {
      slug: `kol-${rank}`,
      name: `KOL ${rank}`,
      xHandle: `kol${rank}`,
      cabalTag: null,
      avatarUrl: `/api/avatar/${crypto.randomUUID()}`,
      hideWallets: false,
    },
    realizedSol: "0",
    realizedUsd: "0",
    wins: 0,
    losses: 0,
    winRate: null,
    ...overrides,
  };
}

function leaderboardHtml(entries: PublicLeaderboardEntry[]): string {
  return renderToStaticMarkup(
    createElement(LeaderboardTable, { entries, unit: "sol" as const }),
  );
}

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
    const html = leaderboardHtml([]);

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

/**
 * The condition on the leaderboard's empty state, pinned from both sides.
 *
 * Spec §2 and DESIGN.md look like they contradict each other here and do not:
 * spec §2's *"inactive approved KOLs stay in the list at zero"* is about a
 * roster that exists, where a zero is legible next to a real figure, while
 * DESIGN.md's ban on *"no zeroed rows"* is about a surface with no data at all,
 * whose every row is zero. The discriminator is whether anything closed in the
 * window, which is exactly `winRate === null`.
 *
 * Both directions are asserted, because only one of them was ever obvious: a
 * table of pure zeros must say so in words, and the *same* table plus one real
 * figure must print every row it was hiding a moment earlier.
 */
describe("the leaderboard's empty state is keyed on closed episodes, not on row count", () => {
  const [lead] = emptyStates().leaderboard;

  it("says so in words when a full roster closed nothing: DESIGN.md's fifty zero rows", () => {
    const html = leaderboardHtml([1, 2, 3, 4, 5].map((rank) => entry(rank)));

    expect(html).toContain(lead);
    expect(html).not.toContain("<table");
    // The exact shape kolscan.io was captured in.
    expect(html).not.toContain("0,00");
    expect(html).not.toContain("sin cierres");
  });

  it("prints every row, zeros included, as soon as one KOL has closed something", () => {
    const entries = [1, 2, 3, 4, 5].map((rank) => entry(rank));
    // One real figure over a real denominator. Spec §2's roster, from here on.
    entries[0] = entry(1, { realizedSol: "18.42", realizedUsd: "1802.40", wins: 7, losses: 2, winRate: "77.8" });

    const html = leaderboardHtml(entries);

    expect(html).not.toContain(lead);
    expect(html).toContain("<table");
    expect(html.match(/class="row-leaderboard/g)).toHaveLength(5);
    // The four that closed nothing keep their own cell-level state rather than
    // being suppressed or rounded to `0 %`.
    expect(html.match(/sin cierres/g)).toHaveLength(4);
    expect(html).toContain("+18,42 SOL");
    expect(html).toContain("77,8 %");
  });

  it("still says so in words when there is no roster at all", () => {
    expect(leaderboardHtml([])).toContain(lead);
  });
});
