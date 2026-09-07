/**
 * What `modal-kol` renders, asserted on emitted markup.
 *
 * `KolDetail` holds no state and reads no context precisely so this file can
 * exist: batch 1 shipped a check that matched the *source text* of a component
 * and was green over something wrong, and a test that greps a `.tsx` passes for
 * as long as the text survives, including after the text stops being what the
 * page shows.
 *
 * The security half of this surface lives in two other files and is not
 * repeated here: `api/kol/[slug]/route.test.ts` proves the payload carries no
 * address and no hidden signature, and `address-invariant.test.ts` scans this
 * component's rendered HTML in its **open** state, with a fixture that really
 * stored an address.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { PublicKolDetail } from "@/lib/serialize";
import { KolDetail } from "./kol-detail";


function detail(overrides: Partial<PublicKolDetail> = {}): PublicKolDetail {
  return {
    // Empty is the interesting default: it is what a KOL who closed nothing has,
    // and it is what makes the modal render no CHAIN PNL section at all.
    chains: [],
    window: "1d",
    kol: {
      slug: "kol-uno",
      name: "KOL Uno",
      xHandle: "ejemplo_uno",
      cabalTag: "ORB",
      avatarUrl: "/api/avatar/00000000-0000-4000-8000-000000000000",
      hideWallets: false,
      // Sin verificar: es el estado de casi todo el padrón, sembrado por admin.
      verified: false,
    },
    publicWallets: 1,
    privateWallets: 2,
    realizedSol: "12.35",
    realizedUsd: "2861.62",
    volumeSol: "28.65",
    tradeCount: 4,
    from: "2026-08-24",
    to: "2026-08-26",
    series: [
      { day: "2026-08-24", dailySol: "4.1", cumulativeSol: "4.1" },
      { day: "2026-08-25", dailySol: "8.25", cumulativeSol: "12.35" },
    ],
    /*
      The calendar's month, which the modal reads independently of the window
      since 2026-09-03. Two days that closed, both inside August 2026, so the
      grid, the month total and the summary row all have something real to say.
    */
    calendar: {
      month: "2026-08",
      days: [
        { day: "2026-08-24", dailySol: "4.1" },
        { day: "2026-08-25", dailySol: "8.25" },
      ],
      sells: 3,
    },
    ...overrides,
  };
}

function render(overrides: Partial<PublicKolDetail> = {}): string {
  return renderToStaticMarkup(createElement(KolDetail, { detail: detail(overrides) }));
}

describe("the header", () => {
  it("names the KOL, links the handle and shows the period's PnL by sign", () => {
    // DESIGN.md `modal-kol`: "64px avatar, `name`, cabal chip, `@handle` ... and
    // the period's total PnL in `numeric-lg` by sign."
    const html = render();
    expect(html).toContain("KOL Uno");
    expect(html).toContain('href="https://x.com/ejemplo_uno"');
    expect(html).toContain("@ejemplo_uno");
    // The PnL moved into the second line of the header on 2026-09-03, beside
    // the handle, which is where the mould puts it. Same figure, same sign
    // colouring, one class less of its own.
    expect(html).toContain('class="num modal-pnl gain">+12,35 SOL');
    expect(html).toContain("(+US$2.861,62)");
  });

  it("colours a losing period loss, and a period that realized nothing neither", () => {
    expect(render({ realizedSol: "-4.1", realizedUsd: "-950.01" })).toContain(
      'class="num modal-pnl loss">−4,10 SOL',
    );
    // "Green and red are direction of money and nothing else." A window in
    // which nothing was realized is neither, so the figure stays ink.
    expect(render({ realizedSol: "0", realizedUsd: "0" })).toContain('class="num modal-pnl ">0,00 SOL');
  });

  it("shows the handle and Wallets ocultas together, never one instead of the other", () => {
    // `b0f2a43`: "The handle and the hidden marker are **not alternatives** ...
    // the handle is public identity, the wallet is the secret." The `modal-kol`
    // paragraph still carries the older "or"; it is one identity block with the
    // row's and the correction governs both. See the batch report.
    const html = render({ kol: { ...detail().kol, hideWallets: true } });
    expect(html).toContain("@ejemplo_uno");
    expect(html).toContain('class="hidden-wallets">Wallets ocultas');
  });

  it("serves the avatar from our own origin, keyed by kol id", () => {
    // DESIGN.md's second Don't. **56px** since 2026-09-03, read off the
    // mould's own `<img>` rather than taken from a picture.
    const html = render();
    expect(html).toMatch(/<img[^>]+src="\/api\/avatar\/[0-9a-f-]{36}"/);
    expect(html).toContain('width="56"');
    expect(html).not.toMatch(/<img[^>]+src="https?:/);
  });

  // La clase sigue diciendo `cabal` a propósito: el rótulo público pasó a "DAO"
  // el 2026-09-06, los identificadores no. Ver docs/copy.md.
  it("tints the cabal chip from the tag", () => {
    expect(render()).toMatch(/class="chip-cabal chip-cabal-[abcd]">DAO: ORB/);
  });
});

/**
 * `card-calendario-pnl`, which replaced `card-pnl-evolution` on 2026-09-02.
 *
 * The grid itself is `calendar.ts` and is tested there; what belongs here is
 * what the *card* does with it — the span it is given, the two states, and the
 * text a reader who cannot see the colours is left with.
 */
describe("card-calendario-pnl", () => {
  it("draws one cell per day of the window, painted by sign", () => {
    const html = render();

    expect(html).toContain('class="calendar"');
    // Two days in the window, both with a figure. Counted as painted cells
    // rather than as `<time>` elements: the trade list below carries one too.
    expect((html.match(/<time class="calendar-cell/g) ?? []).length).toBe(2);
    expect(html).toContain('class="calendar-cell gain level-3"');
  });

  /**
   * The colours are the whole card, so the text under them has to carry the
   * same information: every painted cell says its date and its amount.
   */
  it("labels every painted cell with its day and its figure", () => {
    const html = render();

    expect(html).toContain('aria-label="24/08: +4,10 SOL"');
    expect(html).toContain('aria-label="25/08: +8,25 SOL"');
  });

  /**
   * `Diario` is one day, because `pnl_daily` is keyed by day and spec §4.9
   * makes the window a calendar day. A one-cell calendar is the honest render
   * of that, not a bug to pad out to five weeks — the mould's rolling `1D` is a
   * different measurement and has its own round (`docs/clone-map.md` §8).
   */
  it("draws the whole month, and paints only the days that closed something", () => {
    const html = render({
      calendar: { month: "2026-08", days: [{ day: "2026-08-25", dailySol: "12.35" }], sells: 1 },
    });

    // August has 31 days and every one of them is a cell: the card spans a
    // calendar month since 2026-09-03, not the window.
    expect((html.match(/class="calendar-cell/g) ?? []).length).toBe(31);
    // Exactly one of them carries a figure.
    expect((html.match(/<time class="calendar-cell/g) ?? []).length).toBe(1);
    expect(html).toContain('class="calendar-cell gain level-3"');
    expect(html).toContain("+12,35 SOL");
  });

  /**
   * A day the month covers with no `pnl_daily` row behind it: a cell with its
   * number and no figure, and never a zero. DESIGN.md, "Absence is rendered as
   * absence, never as a zero."
   */
  it("leaves an untraded day without a figure rather than printing it at zero", () => {
    const html = render({
      calendar: { month: "2026-08", days: [{ day: "2026-08-25", dailySol: "1" }], sells: 1 },
    });

    expect((html.match(/<time class="calendar-cell/g) ?? []).length).toBe(1);
    expect((html.match(/<span class="calendar-cell"/g) ?? []).length).toBe(30);
    // And no cell claims a figure for a day that has none.
    expect(html).not.toContain('aria-label="24/08');
    expect(html).not.toContain('aria-label="26/08');
  });

  /**
   * The month's own total and the row under the grid, which are what keep the
   * card honest once it stops spanning the window: a grid of days under a
   * header that sums something else, with no statement of what the days come
   * to, invites the reader to add the two.
   */
  it("prints the month's own total and the summary row", () => {
    const html = render({
      calendar: {
        month: "2026-08",
        days: [
          { day: "2026-08-24", dailySol: "4.1" },
          { day: "2026-08-25", dailySol: "8.25" },
          { day: "2026-08-27", dailySol: "-1.5" },
        ],
        sells: 7,
      },
    });

    // 4.1 + 8.25 - 1.5, which is not the header's window figure.
    expect(html).toContain('class="calendar-total gain">+10,85 SOL');
    expect(html).toContain("2 en verde");
    expect(html).toContain("1 en rojo");
    expect(html).toContain("mejor +8,25 SOL");
    // The 24th and the 25th are consecutive; the 27th is not.
    expect(html).toContain("racha 2 días");
    expect(html).toContain("7 ventas");
  });

  it("says an empty period in words, and draws no grid at all", () => {
    const html = render({ calendar: { month: "2026-08", days: [], sells: 0 } });

    expect(html).toContain("Sin operaciones cerradas en este período.");
    expect(html).not.toContain('class="calendar"');
    expect(html).not.toContain("calendar-cell");
    // And no summary row of five zeros over an empty grid.
    expect(html).not.toContain("calendar-summary");
  });
});

describe("card-stats and card-chain-pnl", () => {
  it("prints PnL total, trades and volume", () => {
    const html = render();
    expect(html).toContain("PnL total");
    // `Trades`, not `Operaciones`: `docs/copy.md`, the term stays English.
    expect(html).toContain("Trades</span><span class=\"num\">4</span>");
    expect(html).toContain("28,65 SOL");
  });

  it("names one chain and implies no others", () => {
    // DESIGN.md `card-chain-pnl`: "one line, SOL, because that is every chain we
    // index." A second chain here would be a claim we index it.
    const html = render();
    expect(html).toContain('<span class="symbol">SOL</span>');
    for (const chain of ["ETH", "BSC", "Base", "Ethereum", "Solana y"]) {
      expect(html).not.toContain(chain);
    }
  });
});

/*
  **`list-defi-trades` se eliminó el 2026-09-06, y con él este bloque.**

  Los casos que vivían acá medían la lista de operaciones del modal: el verbo,
  el monto en SOL con su signo, el equivalente en dólares, el enlace al
  explorador, y `PRIVADO` con candado donde la wallet estaba oculta. Todos
  pasaban.

  El problema no era ninguno de ellos: era la superficie. Una fila con token,
  monto exacto y hora alcanza para encontrar la transacción en un explorador y,
  con ella, la wallet — aunque la firma dijera `PRIVADO`, porque el monto y el
  minuto la identifican igual. `DECISIONES.md`, 2026-09-06.

  Lo que queda medido es lo contrario, y está abajo: que el modal **no** dibuje
  ninguna fila de operación. `public-surfaces.test.ts` lo afirma para el payload
  de todas las rutas públicas.
*/
describe("el modal no publica operaciones individuales", () => {
  it("renders no trade rows, no explorer link and no timestamp", () => {
    const html = render();
    expect(html).not.toContain("row-trade");
    expect(html).not.toContain("solscan.io");
    expect(html).not.toContain("PRIVADO");
    // Ni la hora de una operación: el calendario da días, no minutos.
    expect(html).not.toMatch(/\d{2}\/\d{2} \d{2}:\d{2} UTC/);
  });

  it("still renders the period's aggregates, which are what replaced it", () => {
    const html = render();
    expect(html).toContain("Chain PnL");
    expect(html).toContain("modal-pnl");
  });
});
