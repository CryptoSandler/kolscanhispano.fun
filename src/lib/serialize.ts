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
 * - **A signature is published only for a wallet whose owner published it.**
 *   A signature is not a weaker version of an address: paste it into any
 *   explorer and it names the signer. Publishing it while withholding the
 *   address publishes the address one click later. The decision follows the
 *   wallet the trade came from (`kol_wallet.is_public`), not a flag on the
 *   KOL -- one person can publish one wallet and keep another, and a per-KOL
 *   flag can only answer for both at once (`DECISIONES.md`, 2026-08-31).
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

import type { LeaderboardWindow } from "./windows";

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
  usd_amount: string | null;
  price_usd: string | null;
  block_time: Date;
  signature: string | null;
  /**
   * `kol_wallet.is_public` for the wallet **this trade came from**, joined in
   * by `feed.ts`. Not a property of the KOL: one person can publish one wallet
   * and keep another, and the signature follows the wallet that signed.
   */
  wallet_is_public: boolean;
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
  /**
   * What the SOL leg was worth in USD **at its block**, spec §4.1 — the trade's
   * `usd_amount`, `sol_amount x sol_usd`, not a re-pricing.
   *
   * `null` when no `sol_price` row covered the block: migration 005's *"looked,
   * no rate existed"*. Never `0`, which would be a claim that the trade was
   * worth nothing. DESIGN.md's `state-unpriced` is what renders it.
   *
   * It is read by `list-defi-trades` inside `modal-kol` — *"each with verb, SOL
   * amount by sign and **its USD equivalent**"* — and by nothing else. The feed
   * row states a *price* (`priceUsd`, per token) rather than a value, which is a
   * different figure and is why both are on this shape.
   */
  usdAmount: string | null;
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
  /**
   * How many closings this window counted for this KOL: closed positions on
   * the calendar path, contributing sells on the rolling one. It decides the
   * ranking's empty state and is **not** published — `serializeLeaderboardEntry`
   * does not carry it into the payload.
   */
  closed_count: number;
  kol_id: string;
  slug: string;
  display_name: string;
  x_handle: string;
  cabal_tag: string | null;
  hide_wallets: boolean;
  /** Active wallets this KOL has published. See {@link PublicLeaderboardEntry.hideWallets}. */
  public_wallets: number;
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
     * DESIGN.md `row-leaderboard` puts, under the name, the *"**`@handle`,
     * always**, linked to X, with `Wallets ocultas` in `hidden` **beside it**
     * where that KOL's wallets are hidden"*. The marker occupies *"the
     * **address** slot and nothing else"* — the slot both reference sites fill
     * with a truncated address — so `hideWallets` decides that slot and never
     * the handle. Nothing else on the row can answer the question: `x_handle`
     * is `NOT NULL`, so its presence cannot, which is why the flag is
     * serialized rather than inferred.
     *
     * (An earlier draft of that paragraph wrote the two as alternatives and
     * this comment followed it. `b0f2a43` corrected the document: `hide_wallets`
     * defaults to `TRUE`, so a handle switch would have erased the person from
     * almost every row.)
     *
     * **Derived from the wallets, not from `kol.hide_wallets`.** Since
     * `DECISIONES.md` 2026-08-31 the decision is per wallet, so the only
     * honest reading of "this KOL's wallets are hidden" is *none of them is
     * published*. Reading the KOL flag here while the signature read the
     * wallet would have let the row say `Wallets ocultas` above a trade
     * carrying a signature, which is a marker that lies about the thing
     * underneath it.
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
   * said in words instead of being invented. **Nothing renders it as a figure
 * since 2026-09-02** — the record column left the card with the clone decision
 * — but the field stays: `/api/leaderboard` publishes it, and the leaderboard's
 * empty state is keyed on it being `null` for every entry.
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
      hideWallets: row.public_wallets === 0,
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
      // The chip marks the row whose signature is withheld, so it reads the
      // same fact the signature does. Reading `hide_wallets` here while the
      // signature read the wallet would put `Wallets ocultas` on a row that
      // carries a Solscan link, and leave the mixed KOL's private row with no
      // marker at all beside its missing one.
      hideWallets: !row.wallet_is_public,
    },
    side: row.side,
    mint: row.mint,
    symbol: row.symbol,
    tokenAmount: row.token_amount,
    solAmount: row.sol_amount,
    usdAmount: row.usd_amount,
    priceUsd: row.price_usd,
    blockTime: row.block_time.toISOString(),
    // The whole invariant, in one expression -- and it reads the *wallet*, not
    // the KOL. `DECISIONES.md`, 2026-08-31: `hide_wallets` no longer governs
    // publication, because a KOL who separates their operation publishes one
    // wallet and keeps another, and a per-KOL flag can only answer for both.
    signature: row.wallet_is_public ? row.signature : null,
  };
}

/**
 * One KOL as the detail query produces it: identity, plus the window's totals.
 *
 * `address` is optional and the query never selects it, for the same reason
 * {@link FeedRow} and {@link LeaderboardRow} carry one — it lets the invariant
 * test hand this function a row that really does contain an address, so
 * "the output does not contain it" asserts something.
 */
export type KolDetailRow = {
  kol_id: string;
  slug: string;
  display_name: string;
  x_handle: string;
  cabal_tag: string | null;
  hide_wallets: boolean;
  /** Active wallets this KOL has published. */
  public_wallets: number;
  /** Active wallets this KOL has kept private. Rendered as a count and a padlock. */
  private_wallets: number;
  realized_sol: string;
  realized_usd: string;
  /** Trades executed inside the window, both sides. */
  trade_count: number;
  /** SOL turned over inside the window: the sum of both sides' `sol_amount`. */
  volume_sol: string;
  address?: string | null;
};

/**
 * One day of `card-calendario-pnl`: a UTC day, and realized PnL
 * **accumulated** from the start of the window to the end of that day.
 *
 * Cumulative rather than per-day because DESIGN.md calls the card an
 * *evolution*, and because it makes the last point equal the figure the modal's
 * header prints — one number said twice cannot disagree with itself.
 *
 * The day is a `YYYY-MM-DD` string built by Postgres' `to_char`, never a
 * `Date`: `pnl_daily.day` is a `date`, and `pg` would parse one into a
 * `Date` at the *runner's* local midnight — the local-time leak `windows.ts`
 * exists to keep out, one layer up.
 */
export type KolSeriesPoint = {
  day: string;
  /**
   * That day's own realized PnL, which is what the calendar paints.
   *
   * It arrives beside the running total rather than being recovered from it:
   * a calendar built by differencing a cumulative series is a calendar that
   * cannot tell a quiet day from a missing one, and the difference between
   * those two is the whole of DESIGN.md's *"Absence is rendered as absence."*
   */
  dailySol: string;
  cumulativeSol: string;
};

/** Everything a public response may carry about one KOL's period, and nothing more. */
export type PublicKolDetail = {
  /**
   * The window that was actually summed.
   *
   * Read by the modal, which refetches when its segment changes: a response
   * that arrives after the reader has moved on is discarded by comparing this
   * against the segment now selected, rather than by cancelling a request the
   * browser may already have delivered.
   */
  window: LeaderboardWindow;
  kol: {
    slug: string;
    name: string;
    /** The public persona spec §2 puts the `𝕏` link on. Not a wallet. */
    xHandle: string;
    cabalTag: string | null;
    avatarUrl: string;
    /** See {@link PublicLeaderboardEntry}: it decides the address slot, never the handle. */
    hideWallets: boolean;
  };
  /**
   * How many active wallets this KOL has published, and how many they have
   * kept private.
   *
   * **Counts, and never a list.** `DECISIONES.md` 2026-08-31 puts *"Wallets
   * públicas"* and *"Wallets privadas"* on the detail as a quantity and a
   * padlock, because the number is the honest thing to publish: it says how
   * much of this KOL's operation is on show without naming any of it. A list
   * of public addresses would be a different decision and would need its own.
   *
   * The private count is the one that has to be *right* rather than merely
   * present: it is the third half of the public invariant, and a count that
   * drifts from the database is a bug neither of the other two halves can see.
   */
  publicWallets: number;
  privateWallets: number;
  realizedSol: string;
  realizedUsd: string;
  /** `card-stats`: volume, in SOL. */
  volumeSol: string;
  /** `card-stats`: trades. */
  tradeCount: number;
  /**
   * The window that was summed, as `YYYY-MM-DD` UTC days — `from` inclusive,
   * `to` exclusive.
   *
   * The calendar needs the whole span and not only the days that closed
   * something: a month in which two days traded is a month-shaped grid with two
   * painted cells, not a grid of two.
   */
  from: string;
  to: string;
  /**
   * **The PnL calendar's month, with a running total** — the same days
   * `calendar.days` carries, plus `cumulativeSol`.
   *
   * **Changed meaning on 2026-09-03, deliberately and by the owner's decision.**
   * It was the *window's* daily series, and that stopped being a statable range
   * when every window became rolling (`docs/round-ventanas-moviles.md` §5): a
   * rolling window starts and ends at an **instant**, so its edges are partial
   * days, and `pnl_daily` is keyed by `date` and cannot answer for a partial
   * one. The field would have been neither the window nor a month.
   *
   * Removing it was the other option and the cleaner shape — nothing on screen
   * has read it since the calendar card became a navigable month — but this is
   * a published response and dropping a field breaks whoever holds it. Keeping
   * it with a meaning it can carry costs nothing and breaks nobody.
   */
  series: KolSeriesPoint[];
  /** `list-defi-trades`, newest first, capped by the caller. */
  trades: PublicTrade[];
  /**
   * **The PnL calendar's own month**, which since 2026-09-03 is not the
   * window's span: the card shows a calendar month the reader pages through
   * while the window governs every figure under it. `days` carries only the
   * days that closed something — absence stays absence and `calendar.ts` fills
   * the grid — and `sells` is the one figure in the summary row that a series
   * of daily totals cannot produce.
   */
  calendar: KolCalendar;
};

/** See `PublicKolDetail.calendar`. */
export type KolCalendar = {
  /** `YYYY-MM`, always a month the server resolved — never the raw parameter. */
  month: string;
  days: { day: string; dailySol: string }[];
  sells: number;
};

/**
 * The detail response.
 *
 * Every field is consumed by `modal-kol` and nothing is carried "in case":
 * `window` discards a stale segment's response, `kol` is the header, the two
 * realized figures are the header's PnL and `card-chain-pnl`'s one line,
 * `volumeSol` and `tradeCount` are `card-stats`, `series` is the chart and
 * `trades` is `list-defi-trades`.
 *
 * Spec §7 holds here exactly as it does on the feed: no address is a field of
 * this shape, and each trade's signature has already passed through
 * {@link serializeTrade}, which drops it for a hidden KOL. There is no second
 * decision about publication anywhere in this file.
 */
export function serializeKolDetail(options: {
  row: KolDetailRow;
  window: LeaderboardWindow;
  from: string;
  to: string;
  series: KolSeriesPoint[];
  trades: PublicTrade[];
  calendar: KolCalendar;
}): PublicKolDetail {
  const { row } = options;
  return {
    window: options.window,
    from: options.from,
    to: options.to,
    kol: {
      slug: row.slug,
      name: row.display_name,
      xHandle: row.x_handle,
      cabalTag: row.cabal_tag,
      avatarUrl: `/api/avatar/${encodeURIComponent(row.kol_id)}`,
      hideWallets: row.public_wallets === 0,
    },
    publicWallets: row.public_wallets,
    privateWallets: row.private_wallets,
    realizedSol: row.realized_sol,
    realizedUsd: row.realized_usd,
    volumeSol: row.volume_sol,
    tradeCount: row.trade_count,
    series: options.series,
    trades: options.trades,
    calendar: options.calendar,
  };
}
