/**
 * The feed query, shared by the page's first render and by the polling route
 * so both apply the same filters. Nothing here decides what is published:
 * that is `serialize.ts`, and this module's only job is to hand it complete
 * rows.
 */
import { aadFor, decrypt } from "./crypto";
import { query } from "./db";
import { FEED_PAGE_SIZE, serializeTrade, type PublicTrade } from "./serialize";

/**
 * Spec §7: `(block_time, id)`, never an offset and never a row number. An
 * offset is enumerable — walk it and you get the whole table in order — and
 * it also skips or repeats rows whenever an insert lands between two polls.
 */
export type FeedCursor = { blockTime: Date; id: string };

/**
 * One page of the feed, newest first, with its validator.
 *
 * `hasMore` says the cursor has more rows behind it than one page holds, so
 * the client should ask again immediately instead of waiting for its next
 * tick. The `etag` is produced here rather than derived by the caller,
 * because it has to name the same row {@link readFeedValidator} would pick
 * and the two must not be able to drift.
 */
export type FeedPage = { trades: PublicTrade[]; hasMore: boolean; etag: string };

type FeedQueryRow = {
  id: string;
  kol_id: string;
  side: "buy" | "sell";
  mint: string;
  token_amount: string;
  sol_amount: string;
  price_usd: string | null;
  block_time: Date;
  signature_enc: Buffer;
  slug: string;
  display_name: string;
  hide_wallets: boolean;
  cabal_tag: string | null;
  symbol: string | null;
};

/**
 * `k.status = 'approved'` is the public-surface filter from spec §9: a
 * suspended KOL disappears from every public surface, and a pending one has
 * never been on any. It belongs in the query rather than in a filter after
 * it, so a suspended KOL cannot consume the page's slots and push approved
 * trades off the end.
 */
const APPROVED = "k.status = 'approved'";

/**
 * Row-value comparison is what makes the cursor exact across a tie: two
 * trades in the same block share an instant, and a cursor comparing the
 * timestamp alone would either replay one or drop it.
 */
const AFTER_CURSOR = "(t.block_time, t.id) > ($1::timestamptz, $2::uuid)";

const COLUMNS = `
  t.id, t.kol_id, t.side, t.mint, t.token_amount, t.sol_amount, t.price_usd,
  t.block_time, t.signature_enc,
  k.slug, k.display_name, k.hide_wallets,
  c.tag AS cabal_tag,
  tk.symbol
`;

const JOINS = `
  FROM trade t
  JOIN kol k ON k.id = t.kol_id
  LEFT JOIN cabal c ON c.id = k.cabal_id
  LEFT JOIN token tk ON tk.mint = t.mint
`;

/** The opening page: the newest rows there are. */
const LATEST_SQL = `SELECT ${COLUMNS} ${JOINS}
   WHERE ${APPROVED}
   ORDER BY t.block_time DESC, t.id DESC
   LIMIT $1`;

/**
 * A page **forward** from a cursor, oldest first.
 *
 * The direction is the whole point. Answering a cursor with the *newest* 50
 * rows after it looks identical until a burst larger than one page arrives
 * between two polls: the client receives rows 11–60, advances its cursor past
 * row 60, and rows 1–10 are gone — silently, with every response a 200 and
 * nothing anywhere recording a loss. Paging forward instead means the client
 * only ever advances to a row it has actually been handed, and `hasMore`
 * tells it to come back for the rest at once.
 *
 * Reversed to newest-first before it leaves {@link readFeedPage}, because
 * that is the order the feed reads in.
 */
const AFTER_SQL = `SELECT ${COLUMNS} ${JOINS}
   WHERE ${APPROVED} AND ${AFTER_CURSOR}
   ORDER BY t.block_time ASC, t.id ASC
   LIMIT $3`;

/**
 * The two probes behind {@link readFeedValidator}: one row, two tables, no
 * cabal, no token, and nothing to decrypt.
 */
const LATEST_ANCHOR_SQL = `
  SELECT t.id, t.block_time
    FROM trade t JOIN kol k ON k.id = t.kol_id
   WHERE ${APPROVED}
   ORDER BY t.block_time DESC, t.id DESC
   LIMIT 1`;

const AFTER_ANCHOR_SQL = `
  SELECT t.id, t.block_time
    FROM trade t JOIN kol k ON k.id = t.kol_id
   WHERE ${APPROVED} AND ${AFTER_CURSOR}
   ORDER BY t.block_time ASC, t.id ASC
   LIMIT 1`;

type Anchor = { id: string; block_time: Date };

/**
 * The validator for a page: the row the page is anchored on — its newest for
 * the opening page, its oldest for a page read forward from a cursor. Either
 * way it is the first row of the order the page is selected in, which is what
 * lets one `LIMIT 1` probe produce it without running the page.
 *
 * Weak, because it marks semantic equivalence rather than a byte-for-byte
 * body. An empty page gets a constant, and a client whose cursor sits at the
 * newest trade sees exactly that on every quiet poll — which is what makes an
 * idle feed cost a `304`.
 */
function etagOf(anchor: Anchor | undefined): string {
  if (!anchor) return 'W/"empty"';
  return `W/"${anchor.block_time.getTime()}-${anchor.id}"`;
}

/**
 * Decrypts the stored signature for **every** row, including rows whose KOL
 * hides its wallets and whose signature `serializeTrade` is about to drop.
 *
 * That looks wasteful and it is deliberate. The alternative — skip the
 * decrypt when `hide_wallets` is true — puts a second copy of the publication
 * rule in this file, and a rule written down twice is a rule that can
 * disagree with itself. One AES-GCM decrypt per row, at most fifty rows on a
 * poll that returned something, buys the property the whole task exists for:
 * `serialize.ts` is the only place that decides.
 *
 * A row whose ciphertext will not open (a rotated key, a corrupt blob) yields
 * a null signature rather than failing the page. Losing one explorer link is
 * a smaller failure than a feed that will not load, and nothing about the
 * error is logged: the message could carry a fragment of what it failed to
 * decrypt. Because this null is indistinguishable from a hidden KOL's,
 * `PublicTrade.kol.hideWallets` states the promise separately instead of
 * being inferred from it.
 */
function revealSignature(row: FeedQueryRow): string | null {
  try {
    return decrypt(row.signature_enc, aadFor("trade", "signature", row.id));
  } catch {
    console.warn("readFeed: a trade signature could not be decrypted");
    return null;
  }
}

function toPublic(row: FeedQueryRow): PublicTrade {
  return serializeTrade({
    id: row.id,
    slug: row.slug,
    display_name: row.display_name,
    cabal_tag: row.cabal_tag,
    kol_id: row.kol_id,
    side: row.side,
    mint: row.mint,
    symbol: row.symbol,
    token_amount: row.token_amount,
    sol_amount: row.sol_amount,
    price_usd: row.price_usd,
    block_time: row.block_time,
    signature: revealSignature(row),
    hide_wallets: row.hide_wallets,
  });
}

/**
 * The cheap half of a poll: the page's validator, without the page.
 *
 * An idle feed is the common case, and computing the `ETag` from a finished
 * result meant every quiet poll ran the four-table join and fifty AES-GCM
 * decrypts before deciding it had nothing to say. That is the load the
 * `ETag` exists to avoid.
 */
export async function readFeedValidator(since: FeedCursor | null = null): Promise<string> {
  const rows = since
    ? await query<Anchor>(AFTER_ANCHOR_SQL, [since.blockTime, since.id])
    : await query<Anchor>(LATEST_ANCHOR_SQL);
  return etagOf(rows[0]);
}

export async function readFeedPage(since: FeedCursor | null = null): Promise<FeedPage> {
  if (!since) {
    const rows = await query<FeedQueryRow>(LATEST_SQL, [FEED_PAGE_SIZE]);
    // The opening page is the newest rows there are; anything older than its
    // last row is history no client asked for, so there is nothing to catch
    // up on.
    return { trades: rows.map(toPublic), hasMore: false, etag: etagOf(rows[0]) };
  }

  // One row past the page, purely to answer "is there more?" without a
  // second count query.
  const rows = await query<FeedQueryRow>(AFTER_SQL, [
    since.blockTime,
    since.id,
    FEED_PAGE_SIZE + 1,
  ]);
  const page = rows.slice(0, FEED_PAGE_SIZE);
  return {
    trades: page.map(toPublic).reverse(),
    hasMore: rows.length > FEED_PAGE_SIZE,
    etag: etagOf(page[0]),
  };
}
