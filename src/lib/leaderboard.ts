/**
 * The leaderboard query, shared by the page's first render and by
 * `/api/leaderboard` so both apply the same filters — the same split
 * `feed.ts` makes, and for the same reason: a page that fetched its own HTTP
 * endpoint would pay a round trip to be told something it already knows, and
 * two copies of the filter would eventually disagree.
 *
 * **It reads `pnl_daily`, and derives nothing.** `pnl_daily` is already the
 * sum of `pnl_position_daily` over a KOL's mints for a day (spec §3), and
 * `pnl.ts` withholds the contribution of any position whose basis is unknown
 * before it ever reaches that table (spec §4.5). Re-deriving either here would
 * mean replaying every trade of every KOL on every page load, and would put a
 * second, drifting copy of §4.5's exclusion rule in a query.
 *
 * **What the USD column is worth.** Spec §4.1 fixes the USD value of a trade
 * at its block time and never re-prices, so USD is derived where SOL is
 * measured. A trade whose block was not covered by a `sol_price` row has a
 * NULL `usd_amount` and contributes nothing to the USD side — but a later,
 * priced sell of that same position still gives up its share of the cost. The
 * USD figure is therefore **overstated** for any KOL who traded through a gap
 * in `sol_price`, in a way the SOL figure is not. That is a property of the
 * data, not something this module can repair, so the page states it in words
 * whenever USD is the selected unit rather than printing the number bare.
 */
import { query } from "./db";
import { serializeLeaderboardEntry, type LeaderboardRow, type PublicLeaderboardEntry } from "./serialize";
import { orderChains, readChainPnl, type ChainPnl } from "./chain-pnl";
import { readPublicWallets, type PublicWallet } from "./public-wallets";
import { windowBounds, type LeaderboardWindow } from "./windows";

/**
 * The two currencies the parenthesised total can be printed in.
 *
 * **This used to be `["sol", "usd"]`, and it used to choose the ranked figure.**
 * Owner's clone decision, 2026-09-02 (`docs/clone-map.md` §2): the mould toggles
 * `USD · BRL` and the *chain* figure is always the ranked one, so ours toggles
 * `USD · ARS` and SOL is always what the ranking is sorted by. `docs/round-ars.md`
 * is the round behind the second currency.
 *
 * The consequence, stated because it is a real loss: **there is no longer a way
 * to rank by USD.** A KOL who realized their gains when SOL was expensive could
 * outrank on that measure and not on this one, and that ordering is gone from
 * the product. It went with the toggle that expressed it.
 *
 * SOL is the truth (spec §4.1) and USD is the default fiat: it is the one both
 * halves of this audience can price against.
 */
export const LEADERBOARD_FIATS = ["usd", "ars"] as const;

export type LeaderboardFiat = (typeof LEADERBOARD_FIATS)[number];

/**
 * DESIGN.md's thesis, as a number: ten leaderboard rows and eight feed rows
 * share one 900px viewport. This is how many the home page shows.
 */
export const LEADERBOARD_TOP = 10;

/**
 * `LEFT JOIN`, deliberately.
 *
 * Spec §2: *inactive approved KOLs stay in the list at zero — the roster is
 * part of the point*. An inner join would drop a curated KOL from the ranking
 * on any day they did not close a position, which reads as a KOL who was
 * removed rather than one who did not trade.
 *
 * `k.status = 'approved'` is the public-surface filter from spec §9, in the
 * query rather than after it: a suspended KOL must not be able to occupy a
 * rank or a `LIMIT` slot on the way to being filtered out.
 *
 * The day comparison is half-open — `>= from`, `< to` — against `date`
 * literals built by {@link utcDayString}. Passing a `Date` here instead would
 * have `pg` send a timestamp for Postgres to cast using the *session* time
 * zone, which is the local-time leak `windows.ts` exists to prevent, one layer
 * further down.
 */
/**
 * The wallet count is a **scalar subquery, not a join**, and that is load-bearing.
 *
 * This statement already `LEFT JOIN`s `pnl_daily` and sums it. Adding
 * `LEFT JOIN kol_wallet` would multiply every one of those rows by the number
 * of wallets the KOL has, so a KOL with three wallets would rank on three times
 * their realized PnL -- silently, with every figure still looking like a
 * figure. A correlated subquery on `k.id` produces one value per group and
 * cannot fan anything out.
 */
const PUBLIC_WALLETS = `
  (SELECT count(*)::int FROM kol_wallet w
    WHERE w.kol_id = k.id AND w.status = 'active' AND w.is_public)`;

/**
 * The ranking's statement: it sums `trade.realized_sol` over an instant range.
 *
 * `migrations/015` and `docs/round-ventanas-moviles.md`: a day bucket cannot be
 * cut at an arbitrary hour, so `1D` sums the per-sell figures the replay now
 * records. The two statements are kept side by side rather than templated into
 * one, for the reason the unit's two statements are: the shape of the query is
 * the whitelist, and a template with a table name spliced into it is not.
 *
 * **`wins` and `losses` are zero here, and that is not an oversight.** Spec §4.8
 * counts a *closed position* on the day the closing sell landed, and that count
 * lives in `pnl_daily`; there is no per-sell equivalent, because "closed" is a
 * property of the position's whole episode rather than of one sell. The record
 * came off the card on 2026-09-02, so nothing on a public surface reads them —
 * and `serialize.ts` turns a zero-wins-zero-losses row into `winRate === null`,
 * which is what the empty-state rule keys on. A rolling window with rows
 * therefore says "nothing closed" only when nothing closed.
 *
 * The bounds are `timestamptz`, not `date`: that is the whole point.
 *
 * ## `closed_count`, and the bug that put it here
 *
 * `wins` and `losses` are zero on this path, so `serialize.ts` derives
 * `winRate === null` for every row — and the ranking's empty state was keyed on
 * exactly that. The consequence shipped for about an hour on 2026-09-03:
 * `?window=7d` rendered *"Nadie cerró operaciones..."* over thirteen KOLs
 * carrying real figures, because every row's `winRate` was null by
 * construction rather than by measurement. `seed-preview.test.ts` caught it —
 * it asserts the panel-level empty state is unreachable in **every** window.
 *
 * So the discriminator stopped being inferred from a rate and became a count of
 * the sells that contributed. It is not a win rate, and `serializeLeaderboardEntry`
 * does not publish it.
 */
const ROLLING_SELECT = `
  SELECT k.id AS kol_id, k.slug, k.display_name, k.x_handle, k.hide_wallets,
         (k.tweet_verified_at IS NOT NULL) AS verified, c.tag AS cabal_tag,
         ${PUBLIC_WALLETS} AS public_wallets,
         COALESCE(SUM(t.realized_sol), 0) AS realized_sol,
         COALESCE(SUM(t.realized_usd), 0) AS realized_usd,
         0::int AS wins,
         0::int AS losses,
         -- The sells that actually contributed. See the note above this
         -- statement: it is what the empty state reads, and it is not a rate.
         COUNT(t.id)::int AS closed_count
    FROM kol k
    LEFT JOIN cabal c ON c.id = k.cabal_id
    LEFT JOIN trade t
           ON t.kol_id = k.id
          AND t.realized_sol IS NOT NULL
          AND t.block_time >= $1::timestamptz AND t.block_time < $2::timestamptz
   WHERE k.status = 'approved'
   GROUP BY k.id, k.slug, k.display_name, k.x_handle, k.hide_wallets, k.tweet_verified_at, c.tag
   ORDER BY COALESCE(SUM(t.realized_usd), 0) DESC, k.slug ASC`;

/*
  **The ranking sorts by quoted USD** — the owner's decision of 2026-09-05, and
  the answer to the question `docs/round-columnas-chain.md` §3 deferred.

  It sorted by `SUM(t.realized_sol)` until then, which adds each chain's
  *native* amount together and therefore ranks people by a quantity with no unit
  the moment a second chain is indexed. USD is the one figure that can be summed
  across chains, which is why the mould's single total is fiat too.

  **A position that cannot be priced contributes nothing to the sort.** That is
  not a rounding decision, it is the decision: `COALESCE(..., 0)` means a KOL
  ranks on what quotes, and a KOL whose best trade is unquotable ranks below one
  whose worse trade is quotable. `DECISIONES.md` records it because it is
  visible to the person it affects and invisible in the number — the row shows
  the quoted total, and the modal says which position was left out of it.

  What follows is the note that stood while the question was open. Today it
  cannot happen — every trade in every database is on Solana, because no EVM chain has
  ingestion — and the row no longer *prints* the sum above one chain
  (`leaderboard-table.tsx` suppresses it and lets the per-chain columns and the
  fiat total carry the meaning, which is the mould's arrangement).

  The sort itself is still this expression, and it is deferred on purpose:
  `docs/round-columnas-chain.md` §3 argues that choosing between a per-chain
  sort and a consolidated fiat total is the one decision here that cannot be
  corrected later without moving people up and down the board, and
  `docs/multichain.md` §7 lists it as the owner's to make. It has to be answered
  before a second chain's ingestion is switched on, not after.

  A first attempt guarded this with a test asserting `trade` spans one chain.
  That was unsound: the test database legitimately holds multi-chain fixtures,
  so it failed on correct data and its answer depended on which tests had run.
  A guard that cries wolf is worse than a comment that does not.
*/

export type LeaderboardQuery = {
  window: LeaderboardWindow;
  /** Ranks are assigned before the cut, so the top ten are the top ten. */
  limit?: number;
  /** Injectable so a caller can pin the window; defaults to the current instant. */
  now?: Date;
};

export type Leaderboard = {
  window: LeaderboardWindow;
  /** See the note beside where this is computed. `false` renders the empty state. */
  closed: boolean;
  /** The window actually applied, so the page and the API agree on what was summed. */
  from: string;
  to: string;
  entries: (PublicLeaderboardEntry & {
    chains: ChainPnl[];
    publicWalletList: PublicWallet[];
  })[];
};

export async function readLeaderboard(options: LeaderboardQuery): Promise<Leaderboard> {
  const bounds = windowBounds(options.window, options.now ?? new Date());

  /*
    **ISO instants, never day strings.** A day string would round the window to
    a boundary and turn `1D` back into the `Diario` it replaced — the exact
    substitution `docs/round-ventanas-moviles.md` exists to prevent.

    The `pnl_daily` statement that stood beside this one until 2026-09-03 is
    gone with the calendar windows: with nothing left to select it, a second
    query would have read as a path that could still run.
  */
  const from = bounds.from.toISOString();
  const to = bounds.to.toISOString();

  const limit = options.limit;
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 0)) {
    throw new Error("limit must be a non-negative integer");
  }

  const sql = limit === undefined ? ROLLING_SELECT : `${ROLLING_SELECT} LIMIT $3`;
  const rows = await query<LeaderboardRow>(
    sql,
    limit === undefined ? [from, to] : [from, to, limit],
  );

  const entries = rows.map((row, index) => serializeLeaderboardEntry(row, index + 1));
  // One extra statement for the whole page, after the cut: only the rows that
  // survived `LIMIT` need a breakdown.
  const kolIds = rows.map((row) => row.kol_id);
  const [byKol, walletsByKol] = await Promise.all([
    readChainPnl(kolIds, bounds),
    // Only `is_public` wallets ever come back — see `public-wallets.ts`, which
    // is the one place an address is decrypted for a public surface.
    readPublicWallets(kolIds),
  ]);

  return {
    window: options.window,
    from: bounds.from.toISOString(),
    to: bounds.to.toISOString(),
    /*
      **Whether anything closed in this window, answered by the query.**

      The ranking's empty state used to infer this from `winRate === null` on
      every row, which is true by construction on a rolling window and made the
      empty state unreachable-by-accident there. `closed_count` is what each
      statement actually counted — closed positions on the calendar path,
      contributing sells on the rolling one — and the two are the same question
      even though they are not the same number.
    */
    closed: rows.some((row) => row.closed_count > 0),
    entries: entries.map((entry, index) => ({
      ...entry,
      // `docs/round-columnas-chain.md` §3: attached from its own statement, so
      // the ranking's sort is untouched. A KOL with no rows keeps an empty list
      // and the surface renders no columns at all — never a zero, which would be
      // a measurement nobody made.
      // By position, not by id: `serializeLeaderboardEntry` deliberately drops
      // the KOL's id — a public surface has no business carrying one — and both
      // lists come from the same `rows` in the same order.
      chains: orderChains(byKol.get(rows[index].kol_id) ?? []),
      publicWalletList: walletsByKol.get(rows[index].kol_id) ?? [],
    })),
  };
}

/**
 * The `unit` query parameter, which now names a **fiat** currency.
 *
 * The parameter keeps the name it was published under: `?unit=usd` is a link
 * people already have, and changing a query string costs more than the
 * imprecision it removes — the same reason `/leaderboard` kept its route when
 * the surface was renamed `Clasificación`. `?unit=sol` stops being a value:
 * the page falls back to the default for anything it cannot read, and the API
 * answers `400`.
 *
 * Absent takes the default; anything else is rejected rather than silently
 * treated as USD, so a caller asking for `?unit=eur` learns that it does not
 * exist.
 */
export function parseFiat(raw: string | null): LeaderboardFiat | null {
  if (raw === null) return "usd";
  return (LEADERBOARD_FIATS as readonly string[]).includes(raw) ? (raw as LeaderboardFiat) : null;
}
