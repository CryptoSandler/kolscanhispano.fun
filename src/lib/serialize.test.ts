import { describe, expect, it } from "vitest";
import { inventAddress, inventSignature } from "./ids";
import { serializeTrade } from "./serialize";

const base = {
  id: "t-1",
  slug: "ejemplo",
  display_name: "Ejemplo",
  cabal_tag: "EJE",
  kol_id: "k-1",
  side: "buy" as const,
  mint: inventAddress(),
  symbol: "EJE",
  token_amount: "100",
  sol_amount: "1.5",
  usd_amount: "225",
  price_usd: "0.01",
  block_time: new Date("2026-08-25T12:00:00Z"),
  signature: inventSignature(),
  hide_wallets: true,
  wallet_is_public: false,
  address: inventAddress(),
};

describe("serializeTrade", () => {
  it("omits the signature and the address for a trade from a private wallet", () => {
    const out = serializeTrade(base);
    expect(out.signature).toBeNull();
    expect(JSON.stringify(out)).not.toContain(base.signature);
    expect(JSON.stringify(out)).not.toContain(base.address);
  });

  it("includes the signature for a trade from a published wallet", () => {
    const out = serializeTrade({ ...base, wallet_is_public: true });
    expect(out.signature).toBe(base.signature);
  });

  /**
   * The two directions that separate "per wallet" from "per KOL", and the pair
   * the old rule would have got wrong in both directions.
   *
   * `DECISIONES.md`, 2026-08-31: publication follows the wallet a trade came
   * from. A KOL who publishes one wallet and keeps another is the whole reason
   * the decision moved, so `hide_wallets` must not be able to override either
   * answer -- and the old code, which read only `hide_wallets`, passes neither.
   */
  it("publishes on the wallet even when the KOL flag says hidden", () => {
    const out = serializeTrade({ ...base, hide_wallets: true, wallet_is_public: true });
    expect(out.signature).toBe(base.signature);
  });

  it("withholds on the wallet even when the KOL flag says published", () => {
    const out = serializeTrade({ ...base, hide_wallets: false, wallet_is_public: false });
    expect(out.signature).toBeNull();
  });

  it("never includes the wallet address, published or not", () => {
    expect(JSON.stringify(serializeTrade({ ...base, wallet_is_public: true }))).not.toContain(
      base.address,
    );
  });

  it("keys the avatar by KOL id, never by wallet", () => {
    const out = serializeTrade(base);
    expect(out.kol.avatarUrl).toBe("/api/avatar/k-1");
  });

  it("carries the cabal tag", () => {
    expect(serializeTrade(base).kol.cabalTag).toBe("EJE");
  });

  // The three above assert on `out.signature` and on the serialised string.
  // Neither notices a serializer that copies the address into some *other*
  // field — `mint`, `slug`, a stray `wallet` — for a KOL whose wallets are
  // published. Enumerating the keys is what closes that: the output shape is
  // fixed, so a new field carrying anything at all has to be added here
  // deliberately.
  it("emits exactly the public shape and nothing else", () => {
    const out = serializeTrade({ ...base, wallet_is_public: true });
    expect(Object.keys(out).sort()).toEqual(
      [
        "blockTime",
        "id",
        "kol",
        "mint",
        "priceUsd",
        "side",
        "signature",
        "solAmount",
        "symbol",
        "tokenAmount",
        // `modal-kol`'s `list-defi-trades` needs "its USD equivalent" beside
        // the SOL amount, which is the trade's `usd_amount` (spec §4.1, fixed
        // at its block) and not the per-token `priceUsd` the feed row prints.
        // It is on this shape rather than on a second one because
        // `serialize.ts` is the single place that decides what leaves the
        // server, and a second trade serializer would be a second place.
        "usdAmount",
      ].sort(),
    );
    expect(Object.keys(out.kol).sort()).toEqual(
      // `verified` desde el 2026-09-05: la tilde de handle verificado por tweet
      // firmado viaja con cada fila del feed, igual que con las de la
      // clasificación.
      ["avatarUrl", "cabalTag", "hideWallets", "name", "slug", "verified"].sort(),
    );
  });

  // A serializer that returned the row it was handed, or spread it, would pass
  // every "field X is present and correct" assertion above while shipping
  // `hide_wallets`, `address` and `display_name` to the browser.
  it("does not leak the input row's own keys", () => {
    const out = serializeTrade(base) as Record<string, unknown>;
    for (const key of ["address", "hide_wallets", "display_name", "cabal_tag", "kol_id"]) {
      expect(out).not.toHaveProperty(key);
    }
  });

  it("carries the amounts through as strings, never as numbers", () => {
    const out = serializeTrade(base);
    expect(out.tokenAmount).toBe("100");
    expect(out.solAmount).toBe("1.5");
    expect(out.priceUsd).toBe("0.01");
    expect(typeof out.solAmount).toBe("string");
  });

  it("renders an unpriced trade as null rather than zero", () => {
    expect(serializeTrade({ ...base, price_usd: null }).priceUsd).toBeNull();
  });

  it("renders the block time as an ISO instant", () => {
    expect(serializeTrade(base).blockTime).toBe("2026-08-25T12:00:00.000Z");
  });

  it("carries a null cabal tag through", () => {
    expect(serializeTrade({ ...base, cabal_tag: null }).kol.cabalTag).toBeNull();
  });

  // `hide_wallets` is a promise about publication, and the screen states it in
  // words. Inferring it from `signature === null` collapses two different
  // questions: `readFeed` also returns a null signature when a ciphertext will
  // not open, so a KOL that publishes its wallets would be labelled as hiding
  // them by a key rotation. The chip is driven by this field, so this field
  // must not be derived from the signature.
  it("states the wallet promise separately from whether a signature came through", () => {
    expect(serializeTrade(base).kol.hideWallets).toBe(true);
    expect(serializeTrade({ ...base, wallet_is_public: true }).kol.hideWallets).toBe(false);
    expect(
      serializeTrade({ ...base, wallet_is_public: true, signature: null }).kol.hideWallets,
    ).toBe(false);
  });

  // The hidden case must win even when the caller has no signature to give:
  // a `hide_wallets` check written as `row.signature ?? null` would pass every
  // other test here.
  it("is null-signature for a hidden KOL even when the row carries no signature", () => {
    expect(serializeTrade({ ...base, signature: null }).signature).toBeNull();
    expect(serializeTrade({ ...base, hide_wallets: false, signature: null }).signature).toBeNull();
  });
});
