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
import type { PublicKolDetail, PublicLeaderboardEntry } from "@/lib/serialize";
import { FeedLive } from "./feed-live";
import { KolDetail } from "./kol-detail";
import { LoadFailureState, loadFailure } from "./kol-modal-host";
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

/**
 * The rows of the same table whose empty cell is one sentence rather than a
 * pair — `modal-kol`'s chart, `list-defi-trades`, and `modal-kol` on a failed
 * load, the last two added by `4a2f2df` after this batch reported having to
 * invent copy the document did not carry.
 *
 * They are parsed separately because their surface cells are not a single
 * backticked word and {@link emptyStates}'s pattern deliberately does not reach
 * them. Same rule, though: the sentence comes out of the document, never out of
 * this file. The first backticked run in the empty cell is the copy — the
 * failed-load row continues "with a retry" after it, which is a requirement on
 * the surface rather than words to render.
 */
function emptyCell(surface: string): string {
  const row = DESIGN.split("\n").find((line) => line.startsWith(`| ${surface} |`));
  if (!row) throw new Error(`DESIGN.md has no two-states row for ${surface}`);
  const copy = row.split("|")[3]?.match(/`([^`]+)`/)?.[1];
  if (!copy) throw new Error(`DESIGN.md's ${surface} row states no empty copy`);
  return copy;
}

/** A KOL's period with nothing in it — the state the chart has to say in words. */
function quietDetail(): PublicKolDetail {
  return {
    window: "diario",
    kol: {
      slug: "kol-uno",
      name: "KOL Uno",
      xHandle: "ejemplo_uno",
      cabalTag: null,
      avatarUrl: `/api/avatar/${crypto.randomUUID()}`,
      hideWallets: false,
    },
    publicWallets: 0,
    privateWallets: 0,
    realizedSol: "0",
    realizedUsd: "0",
    volumeSol: "0",
    tradeCount: 0,
    series: [],
    trades: [],
  };
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

/**
 * `modal-kol`'s chart, which is the third surface the two-states table names.
 *
 * A period with no closed episodes has no `pnl_daily` row at all — see
 * `kol.ts` — so the series arrives empty, and the failure to guard against is
 * *"an axis with nothing on it"*: an empty chart frame reads as a measurement
 * that came out flat.
 */
describe("modal-kol's chart says its empty period in words, not as an empty axis", () => {
  it("renders DESIGN.md's sentence, and no chart", () => {
    const lead = emptyCell("`modal-kol` chart");
    const html = renderToStaticMarkup(createElement(KolDetail, { detail: quietDetail() }));

    expect(html).toContain(`<p class="state-empty-lead">${lead}</p>`);
    expect(html).not.toContain("<svg class=\"chart");
    expect(html).not.toContain("chart-axis");
    // No zeroed point standing in for a day that did not happen: DESIGN.md,
    // "Absence is rendered as absence, never as a zero."
    expect(html).not.toContain("<circle");
    expect(html).not.toContain("skeleton");
    for (const apology of ["Ups", "Lo sentimos"]) expect(html).not.toContain(apology);
  });

  /**
   * `| `list-defi-trades` | the KOL's trades | `Sin operaciones en este
   * período.` |`, added to the table by `4a2f2df`. This batch shipped that
   * sentence before the document carried it and said so; now that it is
   * normative, it is parsed rather than restated, like every other one here.
   */
  it("says the trade list's empty period in the document's words", () => {
    const lead = emptyCell("`list-defi-trades`");
    const html = renderToStaticMarkup(createElement(KolDetail, { detail: quietDetail() }));

    expect(html).toContain(`<p class="state-empty-lead">${lead}</p>`);
    expect(html).not.toContain("row-trade");
  });

});

/**
 * The two rows `46b9c47` split apart, which are the only two states in this
 * table where the copy is not the whole requirement — one of them also states
 * that a **control must not be there**.
 *
 * They used to be one row and were not asserted here at all, because the state
 * only exists after a fetch has failed and `renderToStaticMarkup` does not run
 * effects. `LoadFailureState` is now a component of its own for exactly that
 * reason: the *decision* (`loadFailure`) and the *rendering* are both reachable
 * without a browser, and the composition that joins them to a real 404 over the
 * wire is `e2e/modal-kol.spec.ts`. Neither test replaces the other — this one
 * cannot see a network, and that one cannot enumerate statuses.
 */
describe("modal-kol tells a KOL that is gone from a KOL that is unreachable", () => {
  const TRANSIENT = "`modal-kol` on a **transient** failure (network, 5xx)";
  const GONE = "`modal-kol` when the KOL is **gone** (404)";

  function failureHtml(failure: "transient" | "gone"): string {
    return renderToStaticMarkup(
      createElement(LoadFailureState, { failure, onRetry: () => {} }),
    );
  }

  it("names both rows in the document, so neither assertion below is vacuous", () => {
    // If the table is reshaped so these two cells stop being found, every
    // expectation here would be comparing markup against `undefined`.
    expect(emptyCell(TRANSIENT)).toBe("No se pudo cargar este KOL.");
    expect(emptyCell(GONE)).toBe("Este KOL ya no está en el padrón.");
  });

  it("decides by the response and never by a guess", () => {
    // DESIGN.md: "`404` is gone, everything else is transient."
    expect(loadFailure(404)).toBe("gone");
    for (const status of [500, 502, 503, 504, 429, 400, 408, 410]) {
      expect(loadFailure(status), String(status)).toBe("transient");
    }
  });

  it("offers a retry on a transient failure, in the document's words", () => {
    const html = failureHtml("transient");

    expect(html).toContain(`<p class="state-empty-lead">${emptyCell(TRANSIENT)}</p>`);
    expect(html).toContain("Reintentar");
    expect(html).toContain('class="retry"');
    // "`Cargando…` is a spinner in words, and this system does not ship
    // spinners" — not here either, where a retry is pending.
    expect(html).not.toContain("Cargando");
  });

  it("offers no retry at all when the KOL is gone, and does not apologise", () => {
    const html = failureHtml("gone");

    expect(html).toContain(`<p class="state-empty-lead">${emptyCell(GONE)}</p>`);

    // The requirement the copy alone does not carry: DESIGN.md's "**no
    // retry**", and its last Don't — "Don't show a control that does not work."
    // Absent, not disabled: a greyed `Reintentar` is still that control.
    expect(html).not.toContain("Reintentar");
    expect(html).not.toContain("<button");
    expect(html).not.toContain("disabled");

    // ...and it is not the other sentence, which is the mistake this row exists
    // to prevent.
    expect(html).not.toContain(emptyCell(TRANSIENT));
    for (const apology of ["Ups", "Lo sentimos"]) expect(html).not.toContain(apology);
  });
});
