/**
 * The single place that decides what leaves the server.
 *
 * Spec §7 states the hidden-wallet promise as a set of invariants rather than
 * a UI rule, because a rule every component has to remember is a rule that
 * one component eventually forgets. Two of those invariants live here:
 *
 * - **The address is never published, for any KOL, hidden or not.** It is not
 *   a field of {@link PublicTrade}, so no caller can add it back by passing a
 *   different row; the only way to leak it is to change this file.
 * - **For a KOL with `hide_wallets`, neither is the transaction signature.**
 *   A signature is not a weaker version of an address: paste it into any
 *   explorer and it names the signer. Publishing it while withholding the
 *   address publishes the address one click later.
 *
 * The avatar URL is keyed by `kol_id` for the same reason (spec §7):
 * kolscan.io serves `cdn.kolscan.io/profiles/<wallet>.png` and leaks the
 * address in an image URL that no API response ever mentions.
 *
 * Amounts stay **strings** all the way out. `pg` hands a `numeric` back as a
 * string and this module is on the path from there to JSON; converting to a
 * `number` anywhere along it would silently reintroduce the float that
 * `decimal.ts` exists to keep out of money.
 */

/**
 * Spec §10: one page of the feed.
 *
 * It lives in this module, not in `feed.ts`, because the browser needs it to
 * cap the list it holds and `feed.ts` imports the Postgres driver — importing
 * the constant from there would drag `pg` into the client bundle.
 */
export const FEED_PAGE_SIZE = 50;

/**
 * A trade joined to its KOL, cabal and token, as the feed query produces it.
 *
 * `address` is optional and the production query never selects it. It stays
 * in the type on purpose: it lets the invariant test hand this function a row
 * that really does carry an address, so "the output does not contain it"
 * asserts something, instead of asserting the absence of a string that was
 * never supplied.
 */
export type FeedRow = {
  id: string;
  slug: string;
  display_name: string;
  cabal_tag: string | null;
  kol_id: string;
  side: "buy" | "sell";
  mint: string;
  symbol: string | null;
  token_amount: string;
  sol_amount: string;
  price_usd: string | null;
  block_time: Date;
  signature: string | null;
  hide_wallets: boolean;
  address?: string | null;
};

/** Everything a public response may carry about a trade, and nothing more. */
export type PublicTrade = {
  id: string;
  kol: {
    slug: string;
    name: string;
    cabalTag: string | null;
    avatarUrl: string;
    /**
     * Whether this KOL's wallets are published — the fact the `Wallets
     * ocultas` chip states, carried explicitly.
     *
     * The screen used to infer it from `signature === null`, which is a
     * different question with the same answer almost always. `readFeed`
     * also returns a null signature when a stored ciphertext will not open,
     * so a KOL that publishes its wallets was labelled as hiding them the
     * moment a key rotation left one row unreadable — the safe direction to
     * err in, and still a false statement about the one promise this
     * product makes.
     */
    hideWallets: boolean;
  };
  side: "buy" | "sell";
  mint: string;
  symbol: string | null;
  tokenAmount: string;
  solAmount: string;
  priceUsd: string | null;
  blockTime: string;
  signature: string | null;
};

export function serializeTrade(row: FeedRow): PublicTrade {
  return {
    id: row.id,
    kol: {
      slug: row.slug,
      name: row.display_name,
      cabalTag: row.cabal_tag,
      // encodeURIComponent on an id that is always a UUID is belt and braces;
      // it costs nothing and stops a future non-UUID id from building a path.
      avatarUrl: `/api/avatar/${encodeURIComponent(row.kol_id)}`,
      hideWallets: row.hide_wallets,
    },
    side: row.side,
    mint: row.mint,
    symbol: row.symbol,
    tokenAmount: row.token_amount,
    solAmount: row.sol_amount,
    priceUsd: row.price_usd,
    blockTime: row.block_time.toISOString(),
    // The whole invariant, in one expression.
    signature: row.hide_wallets ? null : row.signature,
  };
}
