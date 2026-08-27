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

/**
 * One ranked KOL, as the leaderboard query produces it.
 *
 * `address` is optional and the query never selects it, for the same reason
 * {@link FeedRow} carries one: it lets the invariant test hand this function a
 * row that really does contain an address.
 */
export type LeaderboardRow = {
  kol_id: string;
  slug: string;
  display_name: string;
  x_handle: string;
  cabal_tag: string | null;
  hide_wallets: boolean;
  realized_sol: string;
  realized_usd: string;
  wins: number;
  losses: number;
  address?: string | null;
};

/** Everything a public response may carry about a ranked KOL, and nothing more. */
export type PublicLeaderboardEntry = {
  rank: number;
  kol: {
    slug: string;
    name: string;
    /** The public persona spec §2 puts the `𝕏` link on. Not a wallet. */
    xHandle: string;
    cabalTag: string | null;
    avatarUrl: string;
    /**
     * Whether this KOL's wallets are published — the same fact
     * {@link PublicTrade} already carries, now on the ranked row too.
     *
     * DESIGN.md `row-leaderboard` puts, under the name, *"the `@handle`
     * linked to X **or** `Wallets ocultas` in `hidden`"*. That slot is the one
     * both reference sites fill with a truncated address, so what decides
     * between the two is the same thing that decides it there: whether the KOL
     * publishes its wallets. Nothing else on the row can answer that question
     * — `x_handle` is `NOT NULL`, so its presence cannot — which is why the
     * flag is serialized rather than inferred.
     */
    hideWallets: boolean;
  };
  realizedSol: string;
  realizedUsd: string;
  wins: number;
  losses: number;
  /**
   * Spec §4.8's figure, as a plain decimal string with at most one fractional
   * digit: *closed positions won / closed positions*, never per sell.
   *
   * **`null` when nothing closed in the window**, because a percentage over an
   * empty denominator is not zero — it is undefined, and `0 %` is the shape of
   * a real result. A KOL who closed nothing would read exactly like a KOL who
   * closed nine positions and lost all nine. That is the same failure this
   * project refuses elsewhere: spec §4.6 forbids rendering an unpriceable bag
   * as −100 %, and DESIGN.md's `state-unpriced` exists so a missing number is
   * said in words instead of being invented. The screen says `sin cierres`.
   */
  winRate: string | null;
};

/**
 * `wins / (wins + losses)` as a percentage with one decimal, in integer
 * arithmetic — or `null` when the denominator is empty.
 *
 * A count is not money, so a float here would not be the sin `decimal.ts`
 * exists to prevent — but `wins * 100 / closed` in doubles gives
 * `33.33333333333333` and then rounds through another float, and there is no
 * reason to accept that when `bigint` states the rounding rule outright.
 * Half away from zero, matching every other figure this product rounds.
 */
function winRateOf(wins: number, losses: number): string | null {
  const closed = BigInt(wins) + BigInt(losses);
  if (closed <= 0n) return null;
  const tenths = (BigInt(wins) * 2000n + closed) / (closed * 2n);
  return `${tenths / 10n}.${tenths % 10n}`;
}

export function serializeLeaderboardEntry(row: LeaderboardRow, rank: number): PublicLeaderboardEntry {
  return {
    rank,
    kol: {
      slug: row.slug,
      name: row.display_name,
      xHandle: row.x_handle,
      cabalTag: row.cabal_tag,
      avatarUrl: `/api/avatar/${encodeURIComponent(row.kol_id)}`,
      hideWallets: row.hide_wallets,
    },
    realizedSol: row.realized_sol,
    realizedUsd: row.realized_usd,
    wins: row.wins,
    losses: row.losses,
    winRate: winRateOf(row.wins, row.losses),
  };
}

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
