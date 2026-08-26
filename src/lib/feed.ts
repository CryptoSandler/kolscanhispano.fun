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
 * it, so a suspended KOL cannot consume the page's 50 slots and push approved
 * trades off the end.
 *
 * Row-value comparison `(block_time, id) > (…)` is what makes the cursor
 * exact across a tie: two trades in the same block share an instant, and a
 * cursor comparing the timestamp alone would either replay one or drop it.
 * It also matches `trade_feed_idx (block_time DESC, id DESC)` directly.
 */
const FEED_SQL = `
  SELECT t.id, t.kol_id, t.side, t.mint, t.token_amount, t.sol_amount, t.price_usd,
         t.block_time, t.signature_enc,
         k.slug, k.display_name, k.hide_wallets,
         c.tag AS cabal_tag,
         tk.symbol
    FROM trade t
    JOIN kol k ON k.id = t.kol_id
    LEFT JOIN cabal c ON c.id = k.cabal_id
    LEFT JOIN token tk ON tk.mint = t.mint
   WHERE k.status = 'approved'
     AND ($1::timestamptz IS NULL OR (t.block_time, t.id) > ($1::timestamptz, $2::uuid))
   ORDER BY t.block_time DESC, t.id DESC
   LIMIT $3
`;

/**
 * Decrypts the stored signature for **every** row, including rows whose KOL
 * hides its wallets and whose signature `serializeTrade` is about to drop.
 *
 * That looks wasteful and it is deliberate. The alternative — skip the
 * decrypt when `hide_wallets` is true — puts a second copy of the publication
 * rule in this file, and a rule written down twice is a rule that can
 * disagree with itself. One AES-GCM decrypt per row, at most fifty rows a
 * poll, buys the property the whole task exists for: `serialize.ts` is the
 * only place that decides.
 *
 * A row whose ciphertext will not open (a rotated key, a corrupt blob) yields
 * a null signature rather than failing the page. Losing one explorer link is
 * a smaller failure than a feed that will not load, and nothing about the
 * error is logged: the message could carry a fragment of what it failed to
 * decrypt.
 */
function revealSignature(row: FeedQueryRow): string | null {
  try {
    return decrypt(row.signature_enc, aadFor("trade", "signature", row.id));
  } catch {
    console.warn("readFeed: a trade signature could not be decrypted");
    return null;
  }
}

export async function readFeed(since: FeedCursor | null = null): Promise<PublicTrade[]> {
  const rows = await query<FeedQueryRow>(FEED_SQL, [
    since?.blockTime ?? null,
    since?.id ?? null,
    FEED_PAGE_SIZE,
  ]);

  return rows.map((row) =>
    serializeTrade({
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
    }),
  );
}

/**
 * The validator for a feed page: the newest `(block_time, id)` it contains.
 * Weak, because it marks semantic equivalence rather than a byte-for-byte
 * body — two renders of the same newest trade are interchangeable to a
 * client.
 *
 * An empty page gets a constant. A client polling with a cursor at the newest
 * trade sees exactly that page on every quiet poll, which is what makes an
 * idle feed cost a `304` instead of a body.
 */
export function feedEtag(trades: PublicTrade[]): string {
  const newest = trades[0];
  if (!newest) return 'W/"empty"';
  return `W/"${Date.parse(newest.blockTime)}-${newest.id}"`;
}
