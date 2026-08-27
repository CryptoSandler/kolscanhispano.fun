/**
 * Spec §7 and §8, asserted on **what the pages actually render**.
 *
 * `serialize.ts` is the single place that decides what leaves the server and it
 * already omits the address; `serialize.test.ts` proves that about its return
 * value. What did not exist was a test that looks at the emitted HTML — the
 * surface a reader, a scraper and a search engine all see, and the one place
 * where an address can reappear without any serializer being changed: an
 * `href`, an `img src`, a `data-` attribute, a `title`, or a prop serialised
 * into the payload that hydrates the feed.
 *
 * `docs/references.md` §5 records this as the first of two places the genre
 * collides with our spec: both reference sites print a truncated wallet address
 * on every public row, and kolscan.io keys its avatar and account URLs by the
 * full address. **Truncated counts as published.** The spec wins, and this file
 * is what makes that enforceable rather than aspirational.
 *
 * The scan is `hygiene.ts`'s — the same `findDisallowedBase58` that guards the
 * tracked tree against real addresses entering the repository, reused rather
 * than reimplemented so the two cannot disagree about what an address looks
 * like.
 *
 * **What this file does *not* assert is that the HTML holds no base58 at all**,
 * because two base58 strings are published here on purpose and the spec says so
 * in as many words:
 *
 * - a **transaction signature**, for a KOL that does not hide its wallets. Spec
 *   §7: *"For hidden KOLs, neither the signature nor the link is exposed"* — so
 *   for a public one, both are, and §8.2 says public KOLs *"get their signature
 *   decrypted at serialization time so their Solscan links still work"*.
 * - a **mint**, in the props that hydrate the feed. Spec §3: *"Everything else
 *   — mints, amounts, timestamps, prices — stays in cleartext: it is not
 *   personal data"*, and §8.5 has DexScreener queried by mint.
 *
 * **So the assertion is set equality, not absence — do not "simplify" it back
 * to `expect(findDisallowedBase58(html)).toEqual([])`.** That form can only be
 * made to pass by weakening the fixture until nothing base58 is published at
 * all, and a fixture that publishes nothing proves nothing: it asserts the
 * absence of a string that was never supplied, which is the exact failure
 * `serialize.ts` carries an optional `address` field to avoid.
 *
 * Set equality against the base58 this fixture publishes **deliberately**,
 * enumerated here, is strictly stronger: it fails on an address, and it also
 * fails on base58 nobody predicted. Anything else — an address above all, but
 * equally a hidden KOL's signature, or a mint that starts being rendered into
 * the page — fails, and adding it to the expected set is a visible, reviewable
 * act. That is the same shape as `ALLOWED_BASE58` itself.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { aadFor, blindIndex, encrypt } from "@/lib/crypto";
import { query } from "@/lib/db";
import { readFeedPage } from "@/lib/feed";
import { findDisallowedBase58 } from "@/lib/hygiene";
import { inventAddress, inventSignature } from "@/lib/ids";
import { readLeaderboard } from "@/lib/leaderboard";
import { addWallet } from "@/lib/wallets";
import { utcDayString } from "@/lib/windows";
import HomePage from "./page";
import LeaderboardPage from "./leaderboard/page";

// Nothing here mounts, so `FeedLive`'s effects never run and its four-second
// poll is never installed -- which is what lets the real client component be
// rendered in a suite whose network guard throws on any fetch.
import { renderToStaticMarkup } from "react-dom/server";

type Kol = {
  id: string;
  slug: string;
  walletId: string;
  /** The real, encrypted-at-rest address this KOL's trades were signed by. */
  address: string;
};

async function insertKol(options: {
  slug: string;
  hideWallets: boolean;
  cabalTag?: string;
}): Promise<Kol> {
  let cabalId: string | null = null;
  if (options.cabalTag) {
    cabalId = crypto.randomUUID();
    await query("INSERT INTO cabal (id, tag, name) VALUES ($1, $2, $3)", [
      cabalId,
      options.cabalTag,
      options.cabalTag,
    ]);
  }
  const id = crypto.randomUUID();
  await query(
    `INSERT INTO kol (id, slug, display_name, x_handle, cabal_id, hide_wallets, status, approved_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'approved', now())`,
    [id, options.slug, options.slug.toUpperCase(), options.slug, cabalId, options.hideWallets],
  );
  const address = inventAddress();
  const walletId = await addWallet(id, address);
  return { id, slug: options.slug, walletId, address };
}

type TradeSpec = {
  kol: Kol;
  mint: string;
  side: "buy" | "sell";
  sol: string;
  tokens: string;
  priceUsd: string | null;
  at: string;
};

/**
 * Inserts trades the way the parser does — one encrypted signature per row,
 * bound to that row's id through the AAD — so the feed has to decrypt exactly
 * what production stores. Returns the plaintext signatures, which is what makes
 * "the public KOL's signature is on the page and the hidden one's is not"
 * something this file can state rather than assume.
 */
async function insertTrades(specs: TradeSpec[]): Promise<string[]> {
  const rows = specs.map((spec) => ({
    ...spec,
    id: crypto.randomUUID(),
    signature: inventSignature(),
  }));

  await query(
    `INSERT INTO trade (id, signature_hmac, signature_enc, instruction_index, kol_id, wallet_id,
                        mint, side, token_amount, sol_amount, price_usd, fee_sol, block_time)
     SELECT e.id::uuid, decode(e.hmac, 'hex'), decode(e.enc, 'hex'), 0, e.kol_id::uuid,
            e.wallet_id::uuid, e.mint, e.side, e.tokens::numeric, e.sol::numeric,
            e.price_usd::numeric, 0, e.at::timestamptz
       FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[],
                   $7::text[], $8::text[], $9::text[], $10::text[], $11::text[])
            AS e(id, hmac, enc, kol_id, wallet_id, mint, side, tokens, sol, price_usd, at)`,
    [
      rows.map((r) => r.id),
      rows.map((r) => blindIndex(r.signature, "signature").toString("hex")),
      rows.map((r) => encrypt(r.signature, aadFor("trade", "signature", r.id)).toString("hex")),
      rows.map((r) => r.kol.id),
      rows.map((r) => r.kol.walletId),
      rows.map((r) => r.mint),
      rows.map((r) => r.side),
      rows.map((r) => r.tokens),
      rows.map((r) => r.sol),
      rows.map((r) => r.priceUsd),
      rows.map((r) => r.at),
    ],
  );

  return rows.map((r) => r.signature);
}

/** Every address the fixture put in the database. None may reach a page. */
let addresses: string[];
/** The mints the fixture traded. Cleartext by spec §3, and never rendered today. */
let mints: string[];
/** Signatures of the KOL that publishes its wallets: on the page, by design. */
let publicSignatures: string[];
/** Signatures of the KOL that hides them: never anywhere. */
let hiddenSignatures: string[];

/** The union of both pages' emitted HTML. */
let html: string;
/**
 * The props Next serialises into the flight payload beside that HTML, so the
 * browser can hydrate `FeedLive` and keep polling. `renderToStaticMarkup` does
 * not emit them — it is not the RSC renderer — so they are scanned from the
 * same reads the pages make, which is the payload's content exactly.
 */
let props: string;

beforeAll(async () => {
  await query(
    "TRUNCATE kol, kol_wallet, cabal, token, trade, position, pnl_daily, pnl_position_daily CASCADE",
  );

  const abierto = await insertKol({ slug: "kol-abierto", hideWallets: false, cabalTag: "ABT" });
  const oculto = await insertKol({ slug: "kol-oculto", hideWallets: true });
  addresses = [abierto.address, oculto.address];

  // Two mints: one with a symbol, one the token table has never heard of, so
  // both branches of the feed row's symbol and price rendering are exercised.
  const conSimbolo = inventAddress();
  const sinSimbolo = inventAddress();
  mints = [conSimbolo, sinSimbolo];
  await query("INSERT INTO token (mint, symbol, decimals) VALUES ($1, 'PRUEBA', 6)", [conSimbolo]);

  const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();

  publicSignatures = await insertTrades([
    { kol: abierto, mint: conSimbolo, side: "buy", sol: "12.5", tokens: "1000", priceUsd: "0.0125", at: at(4) },
    { kol: abierto, mint: sinSimbolo, side: "sell", sol: "3.25", tokens: "40", priceUsd: null, at: at(3) },
  ]);
  hiddenSignatures = await insertTrades([
    { kol: oculto, mint: conSimbolo, side: "sell", sol: "8.75", tokens: "600", priceUsd: "0.014", at: at(2) },
    { kol: oculto, mint: sinSimbolo, side: "buy", sol: "1.5", tokens: "90", priceUsd: null, at: at(1) },
  ]);

  // The leaderboard's window is `now`-relative and the pages take no injectable
  // clock, so the fixture writes today's UTC day *and* tomorrow's: a run that
  // crosses UTC midnight between this hook and the render then still has a
  // ranked row rather than silently falling back to the empty state.
  const today = new Date();
  const tomorrow = new Date(today.getTime() + 24 * 60 * 60 * 1000);
  await query(
    `INSERT INTO pnl_daily (kol_id, day, realized_sol, realized_usd, wins, losses)
     SELECT e.kol_id::uuid, e.day::date, e.sol::numeric, e.usd::numeric, e.wins::int, e.losses::int
       FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::int[], $6::int[])
            AS e(kol_id, day, sol, usd, wins, losses)`,
    [
      [abierto.id, abierto.id, oculto.id, oculto.id],
      [utcDayString(today), utcDayString(tomorrow), utcDayString(today), utcDayString(tomorrow)],
      ["18.42", "18.42", "-4.10", "-4.10"],
      ["1802.40", "1802.40", "-401.30", "-401.30"],
      [3, 3, 1, 1],
      [1, 1, 2, 2],
    ],
  );

  html =
    renderToStaticMarkup(await HomePage()) +
    renderToStaticMarkup(await LeaderboardPage({ searchParams: Promise.resolve({}) }));

  const [feed, leaderboard] = await Promise.all([
    readFeedPage(),
    readLeaderboard({ window: "diario", unit: "sol" }),
  ]);
  props = JSON.stringify({ trades: feed.trades, entries: leaderboard.entries });
});

describe("the fixture is populated, so the assertions below are about a real page", () => {
  it("renders both KOLs, their rows and their figures", () => {
    expect(html).toContain("KOL-ABIERTO");
    expect(html).toContain("KOL-OCULTO");
    // Four feed rows and two ranked rows: the empty states are not what is
    // being scanned.
    expect(html.match(/class="row-feed/g)).toHaveLength(4);
    expect(html.match(/class="row-leaderboard/g)?.length).toBeGreaterThanOrEqual(2);
    expect(html).not.toContain("state-empty");
  });

  /**
   * DESIGN.md `row-leaderboard`, as corrected in `b0f2a43`: *"beneath it the
   * **`@handle`, always**, linked to X, with `Wallets ocultas` in `hidden`
   * **beside it** where that KOL's wallets are hidden"* — and, in the
   * paragraph below it, *"the handle is public identity, the wallet is the
   * secret."*
   *
   * This is here rather than in a component test because it is the same
   * property spec §7 is about, read from the other end: what `hide_wallets`
   * withholds is the address slot, and it must not also withhold the person.
   * The row was built against an earlier draft that wrote the two as
   * alternatives, and the result was a preview where nine of thirteen rows
   * carried no link to a human being at all.
   */
  it("links both KOLs' handles to X, the hidden one included", () => {
    for (const slug of ["kol-abierto", "kol-oculto"]) {
      expect(html, `an X link for ${slug}`).toContain(`https://x.com/${slug}`);
    }
  });
});

describe("no wallet address reaches the rendered page", () => {
  it("prints none of the addresses the fixture stored", () => {
    for (const address of addresses) {
      expect(html, "a wallet address in the emitted HTML").not.toContain(address);
      expect(props, "a wallet address in the hydration props").not.toContain(address);
      // Truncated counts as published: `docs/references.md` §5 records both
      // reference sites printing a `HFx9E1`-style chip on every public row.
      // Neither end of the address may appear, at the lengths such a chip uses.
      //
      // Six is the floor, and it is a floor for a measured reason rather than a
      // taste: `inventAddress` draws uniformly over base58, so a four-character
      // slice can come out all-lowercase — `cada`, `esta`, `cier` — and this
      // page is a page of Spanish prose. At six, the chance of a run colliding
      // with the markup is about 2·10⁴ / 58⁶ ≈ 5·10⁻⁷ per check; at four it is
      // ~2·10⁻³, which over a suite run every day is a flake, not a guard. Six
      // is also what kolscan.io actually prints (`HFx9E1`).
      for (const length of [6, 8]) {
        expect(html, `the first ${length} characters of an address`).not.toContain(
          address.slice(0, length),
        );
        expect(html, `the last ${length} characters of an address`).not.toContain(
          address.slice(-length),
        );
      }
    }
  });

  it("prints no base58 run at all beyond the signatures the spec publishes", () => {
    // The whole invariant, as one set comparison over the emitted HTML: text,
    // attributes, `href`s, `img src`s and `data-` attributes alike, because the
    // scan does not know what an attribute is.
    expect(findDisallowedBase58(html).sort()).toEqual([...publicSignatures].sort());
  });

  it("keeps a hidden KOL's signature off the page as well as its address", () => {
    for (const signature of hiddenSignatures) {
      expect(html).not.toContain(signature);
      expect(props).not.toContain(signature);
    }
    // ...and says so in words, which is the only thing that stands where an
    // address would (spec §7).
    expect(html).toContain("Wallets ocultas");
  });

  it("carries nothing base58 into the hydration props but mints and public signatures", () => {
    expect(findDisallowedBase58(props).sort()).toEqual(
      [...publicSignatures, ...mints].sort(),
    );
  });
});

describe("avatars are keyed by kol_id and served from this origin", () => {
  it("builds every avatar URL from the KOL id, never from an address", () => {
    const urls = [...props.matchAll(/"avatarUrl":"([^"]*)"/g)].map(([, url]) => url);
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) {
      expect(url).toMatch(/^\/api\/avatar\/[0-9a-f-]{36}$/);
    }
  });

  it("hotlinks no third party for an image", () => {
    // `docs/references.md` §5, collision 2: kolscanbrasil.io hotlinks
    // `pbs.twimg.com`, so X sees every visitor's request. Spec §6.3 proxies
    // through `/api/avatar/<kol_id>` instead.
    expect(html).not.toMatch(/<img[^>]+src="https?:/);
    for (const host of ["pbs.twimg.com", "unavatar.io", "cdn.kolscan.io"]) {
      expect(html).not.toContain(host);
    }
  });

  it("points every rendered `<img>` at this origin, keyed by the kol id", () => {
    // The props are one thing; what the browser is told to request is another,
    // and it is the `<img src>` that a third party would actually see. Every
    // row carries one now, so this is the assertion that would fail the day
    // someone keyed the path by a handle or by an address.
    const sources = [...html.matchAll(/<img[^>]+src="([^"]*)"/g)].map(([, src]) => src);
    expect(sources.length, "an avatar on every row").toBeGreaterThanOrEqual(6);
    for (const src of sources) {
      expect(src).toMatch(/^\/api\/avatar\/[0-9a-f-]{36}$/);
    }
  });
});
