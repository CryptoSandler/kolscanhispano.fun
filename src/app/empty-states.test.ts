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
import type { PublicCabal } from "@/lib/cabals";
import type { PublicKolDetail, PublicLeaderboardEntry } from "@/lib/serialize";
import type { ChainPnl } from "@/lib/chain-pnl";
import type { PublicWallet } from "@/lib/public-wallets";
import type { LeaderboardWindow } from "@/lib/windows";
import { CabalsBoard } from "./cabals/board";
import { FeedLive } from "./feed-live";
import { KolDetail } from "./kol-detail";
import { LoadFailureState, loadFailure } from "./kol-modal-host";
import { LeaderboardTable } from "./leaderboard-table";

/**
 * A ranked row. `winRate === null` is `serialize.ts`'s "nothing closed in the
 * window"; a string is a real measurement over a real denominator.
 */
/**
 * The ranking's row type gained a per-chain split, so the fixture carries one.
 * Empty is the interesting default: it is what a KOL who closed nothing has,
 * and it is what makes the surface render no chain columns at all.
 */
type RankedEntry = PublicLeaderboardEntry & {
  chains: ChainPnl[];
  publicWalletList: PublicWallet[];
};

function entry(rank: number, overrides: Partial<RankedEntry> = {}): RankedEntry {
  /*
    El desglose por chain se deriva del total, como en los datos reales: la fila
    ya no imprime un total nativo —el molde no tiene uno— y los montos viven en
    los slots por unidad. Un KOL que no cerró nada **no tiene entrada de chain**,
    y por eso su fila muestra `---` en los tres slots en vez de `0,00 SOL`.
  */
  const realizedSol = overrides.realizedSol ?? "0";
  const chains =
    realizedSol === "0"
      ? []
      : [
          {
            chain: "solana" as const,
            realized: realizedSol,
            realizedUsd: overrides.realizedUsd ?? "0",
            unpriced: 0,
          },
        ];
  return {
    chains,
    // Nothing published: the fixture's KOLs render `Wallets ocultas`, which is
    // the state the empty-state cases are about.
    publicWalletList: [],
    rank,
    kol: {
      slug: `kol-${rank}`,
      name: `KOL ${rank}`,
      xHandle: `kol${rank}`,
      cabalTag: null,
      avatarUrl: `/api/avatar/${crypto.randomUUID()}`,
      hideWallets: false,
      // Sin verificar: es el estado de casi todo el padrón, sembrado por admin.
      verified: false,
    },
    realizedSol: "0",
    realizedUsd: "0",
    wins: 0,
    losses: 0,
    winRate: null,
    ...overrides,
  };
}

function leaderboardHtml(
  entries: RankedEntry[],
  window: LeaderboardWindow = "1d",
  fiat: "usd" | "ars" = "usd",
): string {
  /*
    `closed` is what the caller counted in the statement it ran, and this helper
    derives it the way the calendar path does — a row with a win or a loss is a
    row that closed something. Every test below that wants the empty state
    passes rows with `winRate: null`, which is what `entry()` builds.
  */
  const closed = entries.some((e) => e.wins + e.losses > 0);
  return renderToStaticMarkup(
    createElement(LeaderboardTable, { entries, fiat, rate: null, window, closed }),
  );
}

const DESIGN = readFileSync(join(import.meta.dirname, "..", "..", "DESIGN.md"), "utf8");

/**
 * The `| surface | populated | empty |` table in DESIGN.md, as
 * `{ surface: [line1, line2] }`.
 *
 * Only the two rows whose empty cell is a two-part `line / line` pair are
 * matched — the table's other single-cell states (`sin precio`, and the
 * modal's) are covered elsewhere. `sin cierres` was one of them until
 * 2026-09-02, when the record column left the card and its row left the
 * table.
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
    // Empty is the interesting default: it is what a KOL who closed nothing has,
    // and it is what makes the modal render no CHAIN PNL section at all.
    chains: [],
    window: "1d",
    kol: {
      slug: "kol-uno",
      name: "KOL Uno",
      xHandle: "ejemplo_uno",
      cabalTag: null,
      avatarUrl: `/api/avatar/${crypto.randomUUID()}`,
      hideWallets: false,
      // Sin verificar: es el estado de casi todo el padrón, sembrado por admin.
      verified: false,
    },
    publicWallets: 0,
    privateWallets: 0,
    realizedSol: "0",
    realizedUsd: "0",
    volumeSol: "0",
    tradeCount: 0,
    from: "2026-08-25",
    to: "2026-08-26",
    series: [],
    // A month with nothing in it, which is the state this fixture is about.
    calendar: { month: "2026-08", days: [], sells: 0 },
  };
}

describe("DESIGN.md's empty states are what the surfaces render", () => {
  it("names both surfaces in the document", () => {
    // If the table is reshaped so the parse above stops matching, every
    // assertion below would trivially pass on an empty object.
    expect(Object.keys(emptyStates()).sort()).toEqual(["cabals", "feed", "leaderboard"]);
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

  it("renders the leaderboard's two lines, and no card", () => {
    const [lead, note] = emptyStates().leaderboard;
    // Two approved KOLs, neither of whom closed anything: the discriminator is
    // "nothing closed", not "no rows", so this is the state under test.
    const html = leaderboardHtml([entry(1), entry(2)]);

    expect(html).toContain(`<p class="state-empty-lead">${lead}</p>`);
    expect(html).toContain(note);

    // No zeroed rows — DESIGN.md's measured case is kolscan.io's fifty rows of
    // `+0.00 Sol` off a stalled indexer.
    expect(html).not.toContain("row-leaderboard");
    expect(html).not.toContain("0,00");
    expect(html).not.toContain("Todavía no hay KOLs en la clasificación.");
  });

  /**
   * The three leads, the count and the links — DESIGN.md's paragraph under the
   * table, parsed rather than restated for the same reason the table is. The
   * document is what says `hoy`, `esta semana` and `este mes`; if it changes
   * its mind about one of them, this fails rather than drifting.
   */
  it("names the interval that closed nothing, in the document's three phrases", () => {
    const words = [...DESIGN.matchAll(/`(las últimas 24 horas|los últimos \d+ días)` on `(\w+)`/g)];
    expect(words.map(([, , window]) => window)).toEqual(["1d", "7d", "30d"]);

    for (const [, interval, window] of words) {
      const html = leaderboardHtml([entry(1)], window as LeaderboardWindow);
      // An **interval**, never a period: `docs/round-ventanas-moviles.md` §5.
      // There is no word for "the last 24 hours" a reader would not hear as
      // "today", and hearing it as today is what these windows removed.
      expect(html, `${window} names "${interval}"`).toContain(
        `Nadie cerró operaciones en ${interval}.`,
      );
    }
  });

  it("counts the roster, in the singular and the plural the document gives", () => {
    expect(leaderboardHtml([entry(1)])).toContain("Hay 1 KOL en el padrón");
    expect(leaderboardHtml([entry(1), entry(2), entry(3)])).toContain("Hay 3 KOLs en el padrón");

    // Both spellings are the document's, so neither can drift out of it.
    for (const spelling of ["Hay 1 KOL en el padrón", "Hay 12 KOLs en el padrón"]) {
      expect(DESIGN).toContain(spelling);
    }
  });

  it("links to the other two windows, carrying the chosen currency", () => {
    const html = leaderboardHtml([entry(1)], "1d", "ars");

    expect(html).toContain('href="/?window=7d&amp;unit=ars"');
    expect(html).toContain('href="/?window=30d&amp;unit=ars"');
    // Never a link back to the window the reader is already looking at.
    expect(html).not.toContain("window=1d");
  });

  it("says the roster is empty, and offers no link to a second empty page", () => {
    const html = leaderboardHtml([]);

    expect(html).toContain("El padrón todavía está vacío.");
    expect(DESIGN).toContain("El padrón todavía está vacío.");
    expect(html).not.toContain("state-empty-actions");
    expect(html).not.toContain("window=");
  });
});

/**
 * `/cabals`, the surface `docs/clone-map.md` §6 added on 2026-09-02.
 *
 * Same rule and same discriminator as the ranking, one level up: a board where
 * **nothing closed anywhere** measures nothing, and three podium cards reading
 * `0,00 SOL` would be kolscan.io's fifty zero rows with a medal on them. A
 * cabal that closed nothing beside one that did is a real comparison and stays.
 */
describe("the cabal board's two states", () => {
  const [lead, note] = emptyStates().cabals;

  function cabal(rank: number, overrides: Partial<PublicCabal> = {}): PublicCabal {
    return {
      rank,
      tag: `C${rank}`,
      name: `Cabal ${rank}`,
      members: 3,
      reassignedAt: null,
      reassignedTo: null,
      dissolvedAt: null,
      realizedSol: "0",
      realizedUsd: "0",
      closed: 0,
      ...overrides,
    };
  }

  function html(entries: PublicCabal[]): string {
    return renderToStaticMarkup(createElement(CabalsBoard, { entries }));
  }

  it("says the empty period in the document's words, with no podium at all", () => {
    for (const entries of [[], [cabal(1), cabal(2), cabal(3)]]) {
      const rendered = html(entries);
      expect(rendered).toContain(`<p class="state-empty-lead">${lead}</p>`);
      expect(rendered).toContain(`<p class="state-empty-note">${note}</p>`);
      expect(rendered).not.toContain("podium-card");
      expect(rendered).not.toContain("0,00");
    }
  });

  it("prints every cabal, zeros included, as soon as one has closed something", () => {
    const entries = [
      cabal(1, { realizedSol: "42.5", realizedUsd: "4250", closed: 9 }),
      cabal(2),
      cabal(3),
      cabal(4),
    ];
    const rendered = html(entries);

    expect(rendered).not.toContain(lead);
    expect(rendered.match(/podium-card/g)).toHaveLength(3);
    expect(rendered).toContain("+42,50 SOL");
    // The fourth is in the list below the podium, not on it.
    expect(rendered.match(/row-cabal/g)).toHaveLength(1);
  });

  /**
   * The podium is read #2, #1, #3 — the shape a podium has — and the ranking
   * arrives in rank order. A card that rendered in the order it was given would
   * pass every other assertion here.
   */
  it("puts the winner in the middle", () => {
    const rendered = html([
      cabal(1, { name: "Primero", closed: 1 }),
      cabal(2, { name: "Segundo" }),
      cabal(3, { name: "Tercero" }),
    ]);
    const order = [...rendered.matchAll(/class="podium-name">([^<]+)</g)].map((m) => m[1]);

    expect(order).toEqual(["Segundo", "Primero", "Tercero"]);
  });

  it("renders one card, not a gap, when only one cabal exists", () => {
    const rendered = html([cabal(1, { closed: 4, realizedSol: "1" })]);
    expect(rendered.match(/podium-card/g)).toHaveLength(1);
    expect(rendered).not.toContain("section-label");
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
    expect(html).not.toContain("row-leaderboard");
    // The exact shape kolscan.io was captured in.
    expect(html).not.toContain("0,00");
  });

  it("prints every row, zeros included, as soon as one KOL has closed something", () => {
    const entries = [1, 2, 3, 4, 5].map((rank) => entry(rank));
    // One real figure over a real denominator. Spec §2's roster, from here on.
    entries[0] = entry(1, { realizedSol: "18.42", realizedUsd: "1802.40", wins: 7, losses: 2, winRate: "77.8" });

    const html = leaderboardHtml(entries);

    expect(html).not.toContain(lead);
    expect(html.match(/class="row-leaderboard/g)).toHaveLength(5);
    expect(html).toContain("+18,42 SOL");
    // The four that closed nothing are printed at zero rather than suppressed:
    // spec §2's roster, legible because one row beside them carries a figure.
    /*
      **`---`, no `0,00 SOL`.** Las cuatro filas que no cerraron nada se imprimen
      igual —ese es el punto de este caso, el padrón de spec §2 se ve entero—
      pero desde el 2026-09-05 lo que muestran en cada slot por chain es un
      guion. La regla es del molde y estaba en el pedido: una chain sin actividad
      queda vacía, nunca en cero, porque un cero es una medición y ahí no se
      midió nada. El total en fiat sí es un cero real: cerraron cero.

      Cinco filas por tres slots son quince; una sola lleva una cifra (la de
      arriba, en SOL), así que quedan **catorce** guiones — los dos vacíos de esa
      fila incluidos, que es lo que se me pasó al contar doce.
    */
    expect(html.match(/class="state-unpriced"/g)).toHaveLength(14);
    expect(html.match(/\(US\$0,00\)/g)).toHaveLength(4);
  });

  /**
   * **The no-roster case got its own sentence on 2026-09-03.** It rendered the
   * same daily lead as "nobody closed anything" until then, which said the
   * wrong thing twice: it named a period when the problem is not the period,
   * and the note under it would have offered a roster count of zero and two
   * links to windows that are just as empty. DESIGN.md now carries both
   * sentences, and this asserts the surface tells them apart.
   */
  it("says the roster is empty, in different words from a quiet period", () => {
    const html = leaderboardHtml([]);

    expect(html).toContain(emptyCell("`leaderboard` with no roster"));
    expect(html).not.toContain(lead);
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
describe("modal-kol's calendar says its empty period in words, not as an empty grid", () => {
  it("renders DESIGN.md's sentence, and no grid", () => {
    const lead = emptyCell("`modal-kol` calendar");
    const html = renderToStaticMarkup(createElement(KolDetail, { detail: quietDetail() }));

    expect(html).toContain(`<p class="state-empty-lead">${lead}</p>`);
    expect(html).not.toContain('class="calendar"');
    // No cell at all, zeroed or otherwise, standing in for a day that did not
    // happen: DESIGN.md, "Absence is rendered as absence, never as a zero."
    expect(html).not.toContain("calendar-cell");
    expect(html).not.toContain("skeleton");
    for (const apology of ["Ups", "Lo sentimos"]) expect(html).not.toContain(apology);
  });

  /**
   * `| `list-defi-trades` | the KOL's trades | `Sin operaciones en este
   * período.` |`, added to the table by `4a2f2df`. This batch shipped that
   * sentence before the document carried it and said so; now that it is
   * normative, it is parsed rather than restated, like every other one here.
   */
  /*
    El estado vacío de `list-defi-trades` se fue con la lista, el 2026-09-06.
    El modal de un período sin operaciones ahora muestra sus agregados en cero,
    que es lo que queda de ese período: no hay lista que pueda estar vacía.
  */
  it("renders no trade list at all, empty or otherwise", () => {
    const html = renderToStaticMarkup(createElement(KolDetail, { detail: quietDetail() }));
    expect(html).not.toContain("row-trade");
    expect(html).not.toContain("list-defi-trades");
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

/**
 * **La tilde de verificado dice que el handle se probó, y sólo eso.**
 *
 * `migrations/014` y `DECISIONES.md` 2026-08-31: `tweet_verified_at` se llena
 * cuando el KOL tuiteó el código y firmó por su wallet en `/registro`. Casi todo
 * el padrón **no** pasó por ahí — se sembró desde un cruce de trackers — y una
 * tilde en esas filas afirmaría algo que nadie comprobó.
 *
 * Es la clase de dato que se rompe en silencio: si el flag dejara de leerse, la
 * tilde desaparecería y nadie lo notaría; si se leyera al revés, aparecería en
 * todos y tampoco. Por eso hay un caso por cada lado.
 */
describe("la tilde de verificado", () => {
  it("no aparece para un KOL que el admin sembró sin tweet", () => {
    const html = renderToStaticMarkup(
      createElement(LeaderboardTable, {
        entries: [entry(1, { kol: { ...entry(1).kol, verified: false } })],
        window: "1d" as const,
        fiat: "usd" as const,
        // `closed: true` — la fila tiene que renderizarse para poder mirarle la
        // tilde; con `false` la tabla muestra su estado vacío y no hay fila.
        closed: true,
        rate: null,
      }),
    );
    expect(html).not.toContain("verified-tick");
    expect(html).not.toContain("Handle verificado");
  });

  it("aparece, con su explicación, para uno verificado por el flujo de /registro", () => {
    const html = renderToStaticMarkup(
      createElement(LeaderboardTable, {
        entries: [entry(1, { kol: { ...entry(1).kol, verified: true } })],
        window: "1d" as const,
        fiat: "usd" as const,
        // `closed: true` — la fila tiene que renderizarse para poder mirarle la
        // tilde; con `false` la tabla muestra su estado vacío y no hay fila.
        closed: true,
        rate: null,
      }),
    );
    expect(html).toContain("verified-tick");
    // El texto es la mitad del punto: una tilde sin explicación es una insignia.
    expect(html).toContain("Handle verificado por tweet firmado");
  });
});

/**
 * **La home en pesos cuando no hay cotización.**
 *
 * Decisión del dueño, 2026-09-06: una columna entera de `(—)` se lee como *"este
 * sitio no tiene datos"* y no como *"falta la cotización del peso"*. El total en
 * dólares está medido y es el que ordena el ranking, así que se muestra igual, y
 * la ausencia se nombra una vez arriba de la lista.
 */
describe("ARS sin cotización", () => {
  const rows = [entry(1), entry(2)];

  it("shows the dollar totals, not a column of dashes", () => {
    const html = renderToStaticMarkup(
      createElement(LeaderboardTable, {
        entries: rows,
        fiat: "ars",
        rate: null,
        window: "1d",
        closed: true,
      }),
    );

    expect(html).toContain("US$");
    expect(html).not.toContain("AR$");
    // Ni un guión donde hay una cifra medida.
    expect(html).not.toContain("(—)");
  });

  it("still shows a dash where nothing quotes at all, which is a different absence", () => {
    // Un KOL cuyo PnL no cotiza en ninguna cadena no tiene cifra de la que caer:
    // ahí el guión es correcto y tiene que sobrevivir a este cambio.
    const unquoted = entry(1, {
      chains: [{ chain: "solana", realized: "0.42", realizedUsd: null, unpriced: 1 }],
    });
    const html = renderToStaticMarkup(
      createElement(LeaderboardTable, {
        entries: [unquoted],
        fiat: "ars",
        rate: null,
        window: "1d",
        closed: true,
      }),
    );
    expect(html).toContain("(—)");
  });
});
