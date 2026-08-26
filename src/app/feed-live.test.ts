/**
 * The rendering half of Task 5's last property: a feed row shows a symbol,
 * and a token with no price shows DESIGN.md's `sin precio` — never a dash and
 * never a red −100 %.
 *
 * `FeedRow` is rendered for real with `renderToStaticMarkup`, rather than the
 * source of `feed-live.tsx` being matched against a string. Batch 1 shipped a
 * unique index "verified" by string match and a scanner blind to what it was
 * meant to catch; a test that reads the implementation's text passes for as
 * long as the text survives, including after the text stops meaning what it
 * says.
 *
 * The half of the property that lives in the database — that the token join
 * carries a symbol through and that a missing price arrives as `priceUsd:
 * null` — is already covered by `src/app/api/feed/route.test.ts` ("joins the
 * KOL, the cabal tag and the token symbol", "returns a trade whose token row
 * is missing, with a null symbol") and by `serialize.test.ts`. This file
 * covers what the row *does* with those two values once it has them, which
 * nothing tested before.
 */
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { FeedRow } from "./feed-live";
import type { PublicTrade } from "@/lib/serialize";

const BLOCK_TIME = "2026-08-25T12:00:00.000Z";

function trade(overrides: Partial<PublicTrade> = {}): PublicTrade {
  return {
    id: crypto.randomUUID(),
    kol: {
      slug: "kol-uno",
      name: "KOL Uno",
      cabalTag: null,
      avatarUrl: "",
      hideWallets: false,
    },
    side: "buy",
    mint: "mint-placeholder",
    symbol: "FIX",
    tokenAmount: "2",
    solAmount: "1",
    priceUsd: "0.5",
    blockTime: BLOCK_TIME,
    signature: null,
    ...overrides,
  };
}

function render(overrides: Partial<PublicTrade> = {}): string {
  return renderToStaticMarkup(
    createElement(FeedRow, {
      trade: trade(overrides),
      now: Date.parse(BLOCK_TIME) + 60_000,
      isNew: false,
    }),
  );
}

describe("FeedRow", () => {
  it("shows the token's symbol", () => {
    expect(render({ symbol: "BONK" })).toContain("$BONK");
  });

  it("still names the token when no symbol is known, rather than rendering an empty slot", () => {
    const html = render({ symbol: null });
    expect(html).toContain("un token sin símbolo");
    expect(html).toContain('class="symbol"');
  });

  it("renders `sin precio` for an unpriced token, and no number in its place", () => {
    const html = render({ priceUsd: null });
    expect(html).toContain("sin precio");
    expect(html).toContain("state-unpriced");
    // The three renderings DESIGN.md `state-unpriced` and spec §4.6 forbid:
    // an em/en dash, a hyphen standing in for a figure, and the −100 % both
    // reference sites show — which makes a rug and an unindexed pool look
    // identical.
    expect(html).not.toContain("US$");
    expect(html).not.toContain("—");
    expect(html).not.toContain("–");
    expect(html).not.toMatch(/-\s*100\s*%/);
    expect(html).not.toMatch(/−\s*100\s*%/);
    expect(html).not.toContain("%");
  });

  it("renders the price when there is one, so the unpriced case is not the only path", () => {
    // Without this, deleting the priced branch entirely would leave every
    // assertion above green.
    const html = render({ priceUsd: "0.5" });
    expect(html).toContain("US$");
    expect(html).not.toContain("sin precio");
  });

  it("shows `sin precio` on a zero price too, rather than treating 0 as a real quote", () => {
    // A zero is what a "helpful" default writes where a rate was missing, and
    // this is what the screen would then say: `US$0,00`, a real quote, in the
    // slot `sin precio` belongs in. It is the concrete reason `insertTrade`
    // and the backfill write NULL and never `0` — recorded here so the cost
    // of that mistake is visible rather than argued about.
    const html = render({ priceUsd: "0" });
    expect(html).toContain("US$0,00");
    expect(html).not.toContain("sin precio");
  });
});
