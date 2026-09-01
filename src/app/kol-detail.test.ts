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
import type { PublicKolDetail, PublicTrade } from "@/lib/serialize";
import { KolDetail } from "./kol-detail";

function trade(overrides: Partial<PublicTrade> = {}): PublicTrade {
  return {
    id: crypto.randomUUID(),
    kol: {
      slug: "kol-uno",
      name: "KOL Uno",
      cabalTag: null,
      avatarUrl: "/api/avatar/00000000-0000-4000-8000-000000000000",
      hideWallets: false,
    },
    side: "buy",
    mint: "mint-placeholder",
    symbol: "NUBE",
    tokenAmount: "1000",
    solAmount: "8.15",
    usdAmount: "1888.44",
    priceUsd: "0.00042",
    blockTime: "2026-08-25T14:32:00.000Z",
    signature: "signature-placeholder",
    ...overrides,
  };
}

function detail(overrides: Partial<PublicKolDetail> = {}): PublicKolDetail {
  return {
    window: "diario",
    kol: {
      slug: "kol-uno",
      name: "KOL Uno",
      xHandle: "ejemplo_uno",
      cabalTag: "ORB",
      avatarUrl: "/api/avatar/00000000-0000-4000-8000-000000000000",
      hideWallets: false,
    },
    publicWallets: 1,
    privateWallets: 2,
    realizedSol: "12.35",
    realizedUsd: "2861.62",
    volumeSol: "28.65",
    tradeCount: 4,
    series: [
      { day: "2026-08-24", cumulativeSol: "4.1" },
      { day: "2026-08-25", cumulativeSol: "12.35" },
    ],
    trades: [trade()],
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
    expect(html).toContain('class="num-lg gain">+12,35 SOL');
    expect(html).toContain("(+US$2.861,62)");
  });

  it("colours a losing period loss, and a period that realized nothing neither", () => {
    expect(render({ realizedSol: "-4.1", realizedUsd: "-950.01" })).toContain(
      'class="num-lg loss">−4,10 SOL',
    );
    // "Green and red are direction of money and nothing else." A window in
    // which nothing was realized is neither, so the figure stays ink.
    expect(render({ realizedSol: "0", realizedUsd: "0" })).toContain('class="num-lg ">0,00 SOL');
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
    // DESIGN.md's second Don't. 64px, per `modal-kol`.
    const html = render();
    expect(html).toMatch(/<img[^>]+src="\/api\/avatar\/[0-9a-f-]{36}"/);
    expect(html).toContain('width="64"');
    expect(html).not.toMatch(/<img[^>]+src="https?:/);
  });

  it("tints the cabal chip from the tag", () => {
    expect(render()).toMatch(/class="chip-cabal chip-cabal-[abcd]">ORB/);
  });
});

describe("card-pnl-evolution", () => {
  it("draws a line with a marker per point, in the period's sign colour", () => {
    const html = render();
    expect(html).toContain('class="chart gain"');
    expect(html).toContain('class="chart-line"');
    expect((html.match(/<circle /g) ?? []).length).toBe(2);
  });

  it("draws a marker and no line for a period with one point", () => {
    // `Diario` produces exactly one, because `pnl_daily` is keyed by day.
    const html = render({ series: [{ day: "2026-08-25", cumulativeSol: "12.35" }] });
    expect((html.match(/<circle /g) ?? []).length).toBe(1);
    expect(html).not.toContain("chart-line");
  });

  it("survives a period whose every day came out to the same figure", () => {
    const html = render({
      series: [
        { day: "2026-08-24", cumulativeSol: "3" },
        { day: "2026-08-25", cumulativeSol: "3" },
      ],
    });
    expect(html).toContain("chart-line");
    expect(html).not.toContain("NaN");
    expect(html).not.toContain("Infinity");
  });

  it("labels the axis with the first and last day it actually carries", () => {
    expect(render()).toContain(
      '<div class="chart-axis label"><span>2026-08-24</span><span>2026-08-25</span></div>',
    );
  });

  it("names a single day once rather than printing it as both ends of a range", () => {
    const html = render({ series: [{ day: "2026-08-25", cumulativeSol: "1" }] });
    expect(html).toContain('<div class="chart-axis label"><span>2026-08-25</span></div>');
  });

  it("draws no axis and no chart at all for an empty period", () => {
    const html = render({ series: [] });
    expect(html).not.toContain("<svg class=\"chart");
    expect(html).not.toContain("chart-axis");
  });
});

describe("card-stats and card-chain-pnl", () => {
  it("prints PnL total, trades and volume", () => {
    const html = render();
    expect(html).toContain("PnL total");
    expect(html).toContain("Operaciones</span><span class=\"num\">4</span>");
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

describe("list-defi-trades", () => {
  it("gives each trade a verb, a signed-by-direction SOL amount and its USD equivalent", () => {
    const html = render();
    expect(html).toContain('class="gain">compró');
    expect(html).toContain('class="num gain">8,15 SOL');
    expect(html).toContain("US$1.888");
    expect(html).toContain("$NUBE");
  });

  it("colours a sell the other way, as the feed row does", () => {
    const html = render({ trades: [trade({ side: "sell" })] });
    expect(html).toContain('class="loss">vendió');
    expect(html).toContain('class="num loss">8,15 SOL');
  });

  it("says sin precio for a trade no rate covered, never a dash and never a zero", () => {
    // DESIGN.md `state-unpriced`, and migration 005's "looked, no rate existed".
    const html = render({ trades: [trade({ usdAmount: null })] });
    expect(html).toContain('class="state-unpriced">sin precio');
    expect(html).not.toContain("US$0,00");
  });

  it("links a public KOL's trade to the explorer, anchored on its block time", () => {
    const html = render({ trades: [trade({ signature: "SIGNATURE" })] });
    expect(html).toContain('href="https://solscan.io/tx/SIGNATURE"');
    expect(html).toContain("25/08 14:32 UTC");
  });

  it("reads PRIVADO with a padlock where the wallets are hidden", () => {
    // DESIGN.md `list-defi-trades`: "where the wallet is hidden the row reads
    // `PRIVADO` with a padlock instead of a signature link."
    const html = render({
      kol: { ...detail().kol, hideWallets: true },
      trades: [trade({ signature: null })],
    });
    expect(html).toContain('class="privado"');
    expect(html).toContain("PRIVADO");
    expect(html).not.toContain("solscan.io");
    // Drawn, not typed: an emoji padlock carries its own colour and could be
    // neither tinted with the text nor kept out of the green and red this
    // document reserves for money — the objection that ruled out an emoji medal.
    expect(html).toContain("<svg");
    expect(html).not.toContain("🔒");
  });

  it("labels PRIVADO from hideWallets, not from a signature that failed to decrypt", () => {
    // `feed.ts` returns a null signature when a stored ciphertext will not open.
    // A KOL that publishes its wallets must not be relabelled by a key rotation.
    const html = render({ trades: [trade({ signature: null })] });
    expect(html).not.toContain("PRIVADO");
    expect(html).toContain("25/08 14:32 UTC");
  });
});
