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
 *
 * ## The modal is scanned in its **open** state
 *
 * `modal-kol` is a new surface and a new payload, and it is the one surface a
 * page render does not reach: the dialog ships closed and empty, and fills from
 * `/api/kol/<slug>` only after a click. So the scan below covers the union of
 * the two pages' HTML **and** `KolDetail` rendered with what `readKolDetail`
 * actually returns for both KOLs — the open modal, with a fixture that really
 * stored an address and really stored signatures.
 *
 * Both KOLs are rendered, because the two halves of the promise are different
 * code paths: the public one publishes a signature and must, the hidden one
 * must not and reads `PRIVADO` instead.
 */
import bs58 from "bs58";
import { createElement } from "react";
import { beforeAll, describe, expect, it } from "vitest";
import { aadFor, blindIndex, decrypt, encrypt } from "@/lib/crypto";
import { query } from "@/lib/db";
import { readFeedPage } from "@/lib/feed";
import { findDisallowedBase58 } from "@/lib/hygiene";
import { inventAddress, inventSignature } from "@/lib/ids";
import { readKolDetail } from "@/lib/kol";
import { readLeaderboard } from "@/lib/leaderboard";
import { addWallet, setWalletVisibility } from "@/lib/wallets";
import { utcDayString } from "@/lib/windows";
import { KolDetail } from "./kol-detail";
import HomePage from "./page";
import LeaderboardPage from "./leaderboard/page";

// Nothing here mounts, so `FeedLive`'s effects never run and its four-second
// poll is never installed -- which is what lets the real client component be
// rendered in a suite whose network guard throws on any fetch.
import { renderToStaticMarkup } from "react-dom/server";

type Kol = {
  id: string;
  slug: string;
  wallets: Wallet[];
};

/** One wallet of the fixture: its id, its real address, and whether it is published. */
type Wallet = { id: string; address: string; isPublic: boolean };

async function insertKol(options: {
  slug: string;
  hideWallets: boolean;
  cabalTag?: string;
  /** One entry per wallet: `true` publishes it. Order is the fixture's own. */
  wallets: boolean[];
  /** Spec §9's public-surface gate. Defaults to the approved case. */
  status?: "pending" | "approved";
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
     VALUES ($1, $2, $3, $4, $5, $6, $7, CASE WHEN $7 = 'approved' THEN now() END)`,
    [
      id,
      options.slug,
      options.slug.toUpperCase(),
      options.slug,
      cabalId,
      options.hideWallets,
      options.status ?? "approved",
    ],
  );
  const wallets: Wallet[] = [];
  for (const isPublic of options.wallets) {
    const address = inventAddress();
    const walletId = await addWallet(id, address);
    // Through the real setter, not an UPDATE of our own: a fixture that wrote
    // `is_public` directly would still pass if `setWalletVisibility` were
    // broken, and that function is the only way a wallet is ever published.
    if (isPublic) expect(await setWalletVisibility(id, walletId, true)).toBe(true);
    wallets.push({ id: walletId, address, isPublic });
  }
  return { id, slug: options.slug, wallets };
}

type TradeSpec = {
  kol: Kol;
  /** Which of the KOL's wallets signed it. The signature follows this, not the KOL. */
  wallet: Wallet;
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
      rows.map((r) => r.wallet.id),
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

/**
 * Every encoding the wallet **blind index** could reach a payload in.
 *
 * `findDisallowedBase58` is base58-only, and that is the wrong shape for this
 * value. `kol_wallet.address_hmac` (spec §8.1) is 32 raw bytes, and the way a
 * query hands it to JavaScript is `encode(...,'hex')` — 64 characters over
 * `0-9a-f`, of which `0` is not base58. A leaked hex blind index therefore
 * splits into runs the base58 scan drops: the audit of `20040c7` measured it
 * caught in **378 of 1000** synthetic payloads. A guard that is a coin flip on
 * the value it exists to catch is not a guard, and this repo has twice been
 * green over a real defect for exactly that reason.
 *
 * So the needles are derived from the fixture's own address rather than
 * pattern-matched, and enumerated in every encoding a row could plausibly
 * carry the digest in: `hex` is what the query would produce, `\x`-prefixed
 * hex is what `pg` hands back for a raw `bytea` column, base64 and base64url
 * are what a `Buffer` becomes the moment anyone JSON-serialises it, and base58
 * is this codebase's own alphabet for 32-byte values (`ids.ts`).
 *
 * The address itself is in the set too. It is already covered by the
 * `not.toContain` case above; keeping it here means the scan below is a
 * superset of that one rather than a second, drifting opinion about what a
 * leak looks like.
 *
 * **Why the blind index and not only the address.** Spec §8.1 makes
 * `address_hmac` the equality-lookup key over addresses and the unique index
 * behind "one address belongs to one KOL". It is stable and globally unique,
 * so publishing it is enough to join two personas on a shared wallet without
 * ever recovering an address — the linkage SECURITY.md names as the asset,
 * disclosed without breaking any crypto.
 */
function needlesFor(address: string): Record<string, string> {
  const index = blindIndex(address, "address");
  const hex = index.toString("hex");
  return {
    "the address in base58": address,
    "the blind index in hex": hex,
    "the blind index in upper-case hex": hex.toUpperCase(),
    "the blind index in base64": index.toString("base64"),
    "the blind index in base64url": index.toString("base64url"),
    "the blind index as a Postgres bytea literal": `\\x${hex}`,
    "the blind index in base58": bs58.encode(index),
  };
}

/**
 * Which of {@link needlesFor}'s encodings appear in `text`, named rather than
 * quoted: a failure message must not print the leaked value into a terminal,
 * a CI log or a screenshot, which is the same rule `db.ts` follows about
 * connection strings.
 */
function findBlindIndex(text: string, forAddresses: string[]): string[] {
  const found: string[] = [];
  for (const address of forAddresses) {
    for (const [encoding, needle] of Object.entries(needlesFor(address))) {
      if (text.includes(needle)) found.push(encoding);
    }
  }
  return found;
}

/** Every KOL the fixture built, with its wallets and their persisted visibility. */
let kols: Kol[];
/** Every address the fixture put in the database. None may reach a page. */
let addresses: string[];
/** The mints the fixture traded. Cleartext by spec §3, and never rendered today. */
let mints: string[];
/** Signatures of the KOL that publishes its wallets: on the page, by design. */
let publicSignatures: string[];
/** Signatures of the KOL that hides them: never anywhere. */
let hiddenSignatures: string[];
/** Signatures of the KOL awaiting approval: never anywhere, published wallet or not. */
let pendingSignatures: string[];
/** The slug of that KOL, for the "not reachable by guessing it" case. */
const PENDING_SLUG = "kol-pendiente";

/** The union of both pages' emitted HTML. */
let html: string;
/** `modal-kol`, open, for both KOLs — the surface a page render never reaches. */
let modalHtml: string;
/**
 * Everything a browser is handed, HTML and payloads alike: the two pages, and
 * the modal in its open state. Every scan below runs over this rather than over
 * the pages alone.
 */
let surfaces: string;
/**
 * The props Next serialises into the flight payload beside that HTML, so the
 * browser can hydrate `FeedLive` and keep polling. `renderToStaticMarkup` does
 * not emit them — it is not the RSC renderer — so they are scanned from the
 * same reads the pages make, which is the payload's content exactly.
 *
 * `/api/kol/<slug>`'s body is in here too: it is a payload a browser receives,
 * and it is the only place the modal's figures ever exist.
 */
let props: string;

beforeAll(async () => {
  await query(
    "TRUNCATE kol, kol_wallet, cabal, token, trade, position, pnl_daily, pnl_position_daily CASCADE",
  );

  // Three KOLs, because the promise now has three shapes rather than two.
  //
  // `kol-mixto` is the one the old per-KOL rule could not express at all, and
  // it is the reason the decision moved (`DECISIONES.md`, 2026-08-31): one
  // person, one published wallet and one kept back. Its `hide_wallets` is
  // deliberately set to the value that would give the *wrong* answer under the
  // old code -- `false`, which used to mean "publish everything" -- so a
  // regression to reading the KOL flag publishes a private wallet's signature
  // and this file fails.
  const abierto = await insertKol({
    slug: "kol-abierto",
    hideWallets: false,
    cabalTag: "ABT",
    wallets: [true],
  });
  const oculto = await insertKol({ slug: "kol-oculto", hideWallets: true, wallets: [false] });
  const mixto = await insertKol({ slug: "kol-mixto", hideWallets: false, wallets: [true, false] });

  // `DECISIONES.md`, 2026-08-31: a KOL is `pending` until the tweet with the
  // code and the admin approval, and *"no aparece en ninguna superficie
  // pública hasta la aprobación"*.
  //
  // Given a **published** wallet on purpose, which is the combination that
  // matters: publication is per wallet now, so a gate that only consulted the
  // wallet would put this KOL's signatures on the feed. Both gates have to
  // hold, and only the status gate can stop this one.
  const pendiente = await insertKol({
    slug: "kol-pendiente",
    hideWallets: false,
    wallets: [true],
    status: "pending",
  });

  kols = [abierto, oculto, mixto];
  addresses = kols.flatMap((kol) => kol.wallets.map((wallet) => wallet.address));

  // Two mints: one with a symbol, one the token table has never heard of, so
  // both branches of the feed row's symbol and price rendering are exercised.
  const conSimbolo = inventAddress();
  const sinSimbolo = inventAddress();
  mints = [conSimbolo, sinSimbolo];
  await query("INSERT INTO token (mint, symbol, decimals) VALUES ($1, 'PRUEBA', 6)", [conSimbolo]);

  const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();

  publicSignatures = await insertTrades([
    { kol: abierto, wallet: abierto.wallets[0], mint: conSimbolo, side: "buy", sol: "12.5", tokens: "1000", priceUsd: "0.0125", at: at(6) },
    { kol: abierto, wallet: abierto.wallets[0], mint: sinSimbolo, side: "sell", sol: "3.25", tokens: "40", priceUsd: null, at: at(5) },
    // The published half of the mixed KOL: this signature must appear.
    { kol: mixto, wallet: mixto.wallets[0], mint: conSimbolo, side: "buy", sol: "5.5", tokens: "300", priceUsd: "0.018", at: at(4) },
  ]);
  // Not added to either list: these belong to a KOL that has no public
  // surface at all, so they are neither published nor "withheld from a page
  // that shows the KOL". They get their own assertion.
  pendingSignatures = await insertTrades([
    { kol: pendiente, wallet: pendiente.wallets[0], mint: conSimbolo, side: "buy", sol: "9.9", tokens: "500", priceUsd: "0.02", at: at(7) },
  ]);
  hiddenSignatures = await insertTrades([
    { kol: oculto, wallet: oculto.wallets[0], mint: conSimbolo, side: "sell", sol: "8.75", tokens: "600", priceUsd: "0.014", at: at(3) },
    { kol: oculto, wallet: oculto.wallets[0], mint: sinSimbolo, side: "buy", sol: "1.5", tokens: "90", priceUsd: null, at: at(2) },
    // The withheld half of the *same* KOL whose other wallet publishes. Under
    // the old rule this row's signature was published, because its KOL's
    // `hide_wallets` is false.
    { kol: mixto, wallet: mixto.wallets[1], mint: sinSimbolo, side: "sell", sol: "2.25", tokens: "70", priceUsd: null, at: at(1) },
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
      [abierto.id, abierto.id, oculto.id, oculto.id, mixto.id, mixto.id],
      [
        utcDayString(today), utcDayString(tomorrow),
        utcDayString(today), utcDayString(tomorrow),
        utcDayString(today), utcDayString(tomorrow),
      ],
      ["18.42", "18.42", "-4.10", "-4.10", "6.30", "6.30"],
      ["1802.40", "1802.40", "-401.30", "-401.30", "615.90", "615.90"],
      [3, 3, 1, 1, 2, 2],
      [1, 1, 2, 2, 1, 1],
    ],
  );

  html =
    renderToStaticMarkup(await HomePage()) +
    renderToStaticMarkup(await LeaderboardPage({ searchParams: Promise.resolve({}) }));

  const [feed, leaderboard] = await Promise.all([
    readFeedPage(),
    readLeaderboard({ window: "diario" }),
  ]);
  // Both modals, opened. `readKolDetail` is what the route calls, so this is
  // the payload the browser receives and `KolDetail` is what it renders from it.
  const details = await Promise.all([
    readKolDetail({ slug: "kol-abierto", window: "diario" }),
    readKolDetail({ slug: "kol-oculto", window: "diario" }),
    readKolDetail({ slug: "kol-mixto", window: "diario" }),
  ]);
  modalHtml = details
    .map((detail) => renderToStaticMarkup(createElement(KolDetail, { detail: detail! })))
    .join("");

  props = JSON.stringify({ trades: feed.trades, entries: leaderboard.entries, details });
  surfaces = html + modalHtml;
});

describe("the fixture is populated, so the assertions below are about a real page", () => {
  it("renders both KOLs, their rows and their figures", () => {
    expect(html).toContain("KOL-ABIERTO");
    expect(html).toContain("KOL-OCULTO");
    expect(html).toContain("KOL-MIXTO");
    // Six feed rows and three ranked rows: the empty states are not what is
    // being scanned.
    expect(html.match(/class="row-feed/g)).toHaveLength(6);
    expect(html.match(/class="row-leaderboard/g)?.length).toBeGreaterThanOrEqual(3);
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

  it("opens both modals with real figures in them", () => {
    // Without this the scans below could pass over an empty string, which is
    // the failure `serialize.ts` carries an optional `address` field to avoid:
    // asserting the absence of something that was never rendered.
    expect(modalHtml).toContain("KOL-ABIERTO");
    expect(modalHtml).toContain("KOL-OCULTO");
    expect(modalHtml).toContain("+18,42 SOL");
    expect(modalHtml).toContain("−4,10 SOL");
    // The hidden KOL's trade rows say so where a signature link would be.
    expect(modalHtml).toContain("PRIVADO");
  });
});

describe("no wallet address reaches the rendered page", () => {
  it("prints none of the addresses the fixture stored", () => {
    for (const address of addresses) {
      expect(surfaces, "a wallet address in the emitted HTML").not.toContain(address);
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
        expect(surfaces, `the first ${length} characters of an address`).not.toContain(
          address.slice(0, length),
        );
        expect(surfaces, `the last ${length} characters of an address`).not.toContain(
          address.slice(-length),
        );
      }
    }
  });

  it("prints no base58 run at all beyond the signatures the spec publishes", () => {
    // The whole invariant, as one set comparison over the emitted HTML: text,
    // attributes, `href`s, `img src`s and `data-` attributes alike, because the
    // scan does not know what an attribute is.
    expect(findDisallowedBase58(surfaces).sort()).toEqual([...publicSignatures].sort());
  });

  it("keeps a hidden KOL's signature off the page as well as its address", () => {
    for (const signature of hiddenSignatures) {
      expect(surfaces).not.toContain(signature);
      expect(props).not.toContain(signature);
    }
    // ...and says so in words, which is the only thing that stands where an
    // address would (spec §7) — `Wallets ocultas` in the identity block on both
    // surfaces, and `PRIVADO` where the modal's trade row would carry a link.
    expect(html).toContain("Wallets ocultas");
    expect(modalHtml).toContain("Wallets ocultas");
    expect(modalHtml).toContain("PRIVADO");
  });

  it("carries nothing base58 into the hydration props but mints and public signatures", () => {
    expect(findDisallowedBase58(props).sort()).toEqual(
      [...publicSignatures, ...mints].sort(),
    );
  });

  /**
   * `DECISIONES.md`, 2026-08-31 rewrote this invariant into three halves, and
   * the set comparison above is only the first of them. *"La segunda mitad es
   * la que importa: sin ella, un bug que publique todo pasaría el test mientras
   * exista un solo KOL que optó."*
   *
   * So publication is resolved **back to the row that authorised it**. It is
   * not enough that the render believed a wallet was public: every base58 run
   * that reached a surface is looked up by its blind index and the wallet that
   * signed it is read out of the database.
   */
  it("publishes a signature only for a wallet whose is_public is persisted", async () => {
    const published = findDisallowedBase58(surfaces);
    // A fixture that published nothing would pass the loop below vacuously,
    // which is the failure the whole file is built to avoid.
    expect(published.length).toBeGreaterThan(0);

    for (const signature of published) {
      const rows = await query<{ is_public: boolean }>(
        `SELECT w.is_public FROM trade t
           JOIN kol_wallet w ON w.id = t.wallet_id AND w.chain = t.chain
          WHERE t.signature_hmac = $1`,
        [blindIndex(signature, "signature")],
      );
      // Named, never quoted: a failure message must not print the value.
      expect(rows, "a published base58 run is not a known trade signature").toHaveLength(1);
      expect(rows[0].is_public, "a signature reached a surface from a private wallet").toBe(true);
    }
  });

  it("withholds every signature signed by a wallet that is not published", async () => {
    // Driven from the database rather than from the fixture's variables, so a
    // trade inserted by some future edit is covered without anyone remembering.
    const privateWalletIds = kols
      .flatMap((kol) => kol.wallets)
      .filter((wallet) => !wallet.isPublic)
      .map((wallet) => wallet.id);
    expect(privateWalletIds.length).toBeGreaterThan(0);

    const rows = await query<{ id: string; signature_enc: Buffer }>(
      `SELECT id, signature_enc FROM trade WHERE wallet_id = ANY ($1::uuid[])`,
      [privateWalletIds],
    );
    expect(rows.length).toBeGreaterThan(0);

    for (const row of rows) {
      const signature = decrypt(row.signature_enc, aadFor("trade", "signature", row.id));
      // `not.toContain` on a large haystack prints the haystack into the diff,
      // and the haystack here is a page that would be carrying the leak. The
      // boolean form says the same thing and prints neither: this file's own
      // rule about `needlesFor` -- name the leak, never quote it -- applies to
      // the assertion that finds one as much as to the message beside it.
      expect(surfaces.includes(signature), "a private wallet's signature is on a surface").toBe(
        false,
      );
      expect(props.includes(signature), "a private wallet's signature is in the props").toBe(false);
    }
  });

  /**
   * The third half, and the one neither of the other two can see: *"el detalle
   * del KOL muestra 'N wallets privadas' y esa N coincide con la base."*
   *
   * Checked against the **fixture's own intent** as well as against the
   * database. Comparing the detail only to a query would be two reads of one
   * table agreeing with each other; the fixture's array is what this test
   * asked for before any query ran.
   */
  it("counts public and private wallets exactly as the fixture built them", async () => {
    for (const kol of kols) {
      const detail = await readKolDetail({ slug: kol.slug, window: "diario" });
      expect(detail, `no detail for ${kol.slug}`).not.toBeNull();

      const intendedPublic = kol.wallets.filter((wallet) => wallet.isPublic).length;
      const intendedPrivate = kol.wallets.length - intendedPublic;
      expect(detail!.publicWallets, `${kol.slug}: public count`).toBe(intendedPublic);
      expect(detail!.privateWallets, `${kol.slug}: private count`).toBe(intendedPrivate);

      const [row] = await query<{ pub: string; priv: string }>(
        `SELECT count(*) FILTER (WHERE is_public) AS pub,
                count(*) FILTER (WHERE NOT is_public) AS priv
           FROM kol_wallet WHERE kol_id = $1 AND status = 'active'`,
        [kol.id],
      );
      expect(Number(row.pub)).toBe(detail!.publicWallets);
      expect(Number(row.priv)).toBe(detail!.privateWallets);
    }
  });

  /**
   * `DECISIONES.md`, 2026-08-31: *"Un KOL sin verificar no aparece en el
   * leaderboard."* The handle is not verified until the tweet with the code
   * (spec §6), so a KOL enters as `pending` and is on no public surface until
   * an admin approves them.
   *
   * The fixture gives this KOL a **published** wallet, which is the whole
   * point of the case: publication is per wallet now, so a surface that
   * consulted only `is_public` would carry these rows. Two gates have to hold
   * independently, and only `status` can stop this one.
   */
  it("keeps a pending KOL off every public surface, published wallet and all", async () => {
    expect(pendingSignatures).toHaveLength(1);

    expect(surfaces).not.toContain("KOL-PENDIENTE");
    expect(props).not.toContain(PENDING_SLUG);
    for (const signature of pendingSignatures) {
      expect(surfaces.includes(signature), "a pending KOL's signature is on a surface").toBe(false);
      expect(props.includes(signature), "a pending KOL's signature is in the props").toBe(false);
    }

    // And its slug is not reachable by guessing it: `readKolDetail` answers
    // `null`, which is the same answer a slug that never existed gets.
    expect(await readKolDetail({ slug: PENDING_SLUG, window: "diario" })).toBeNull();
  });

  it("renders the private count on the detail, as a count and never a list", () => {
    // `kol-mixto` has one of each, so its modal is the one that must show both.
    expect(modalHtml).toContain("Wallets");
    expect(modalHtml).toContain("Privadas");
    expect(modalHtml).toContain("Públicas");
  });

  /**
   * The half the base58 scan above cannot do. See {@link needlesFor}.
   *
   * `readKolDetail` spreads its identity row into `serializeKolDetail`, so the
   * only thing standing between a column that column-exists and a published
   * field is that the serializer names its fields one at a time. That is a
   * property of one function body, and one `return { ...row }` ends it — which
   * is why the assertion is on the payload rather than on the query.
   */
  it("publishes the wallet blind index in no encoding, on any surface", () => {
    expect(findBlindIndex(surfaces, addresses), "the emitted HTML").toEqual([]);
    expect(findBlindIndex(props, addresses), "the hydration props").toEqual([]);
  });

  /**
   * The spiked-body self-test. A scan that cannot be made to fail proves
   * nothing, and every encoding added above has to be shown to be *reachable*
   * by the scan rather than merely listed in it — the failure mode that let
   * the base58-only guard stand: the needle was real, the haystack was real,
   * and the shape in between was wrong.
   *
   * The plant goes in an attribute because that is the shape a real leak takes
   * (`serialize.ts`'s docstring: an `href`, an `img src`, a `data-`
   * attribute), and the scan does not know what an attribute is.
   */
  it("would flag a planted blind index in every encoding it scans for", () => {
    for (const address of addresses) {
      for (const [encoding, needle] of Object.entries(needlesFor(address))) {
        const spiked = `${surfaces}<span data-leak="${needle}"></span>`;
        expect(findBlindIndex(spiked, addresses), encoding).toContain(encoding);
      }
    }
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
    expect(surfaces).not.toMatch(/<img[^>]+src="https?:/);
    for (const host of ["pbs.twimg.com", "unavatar.io", "cdn.kolscan.io"]) {
      expect(surfaces).not.toContain(host);
    }
  });

  it("points every rendered `<img>` at this origin, keyed by the kol id", () => {
    // The props are one thing; what the browser is told to request is another,
    // and it is the `<img src>` that a third party would actually see. Every
    // row carries one now, so this is the assertion that would fail the day
    // someone keyed the path by a handle or by an address.
    const sources = [...surfaces.matchAll(/<img[^>]+src="([^"]*)"/g)].map(([, src]) => src);
    // Every feed row and every ranked row, plus the 64px avatar in each modal's
    // header.
    expect(sources.length, "an avatar on every row").toBeGreaterThanOrEqual(8);
    for (const src of sources) {
      expect(src).toMatch(/^\/api\/avatar\/[0-9a-f-]{36}$/);
    }
  });
});
