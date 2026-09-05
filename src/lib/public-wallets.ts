import { aadFor, decrypt } from "./crypto";
import { query } from "./db";
import { isEvm, type Chain } from "./chain";

/**
 * The wallets a KOL chose to publish, and only those.
 *
 * ## What changed, and who changed it
 *
 * Until 2026-09-05 **no address was published for anybody**. `serialize.ts` said
 * so in as many words and `docs/references.md` §5 recorded the collision: both
 * reference sites print a truncated address on every public row, and the verdict
 * was *"truncated counts as published; the spec wins"*.
 *
 * The owner reversed that on 2026-09-05, narrowly: an address may be published
 * **when the KOL opted that wallet in** — `kol_wallet.is_public`, the flag added
 * on 2026-08-31 for exactly this choice. The invariant did not go away, it got
 * an exact edge: *no non-public address reaches any surface*.
 * `address-invariant.test.ts` now asserts that edge against a KOL holding one of
 * each, which is stricter than the old "no address anywhere" was in the only way
 * that matters — it can distinguish a leak from a publication.
 *
 * ## Why the decryption lives here
 *
 * `is_public` is the whole authorisation. This module is the only thing that
 * decrypts an address for a public surface, so there is one place to read when
 * asking "how could an address get onto a page", and the `WHERE` clause is the
 * answer. Nothing takes a flag or an override: a caller cannot ask for a
 * private wallet, because there is no argument that would express it.
 */

export type PublicWallet = {
  chain: Chain;
  /** `AbCdEf` — the leading characters only, for the chip on the row itself. */
  short: string;
  /**
   * `AbCdEf...wXyZ` — six leading and four trailing, for the panel the chip
   * opens. The mould's `4PsfXF...bAhW`.
   *
   * **Ten characters of an address, and never more.** The middle is what makes
   * an address findable, and it is never published in any form;
   * `address-invariant.test.ts` asserts the whole address and a 16-character
   * prefix are both absent from the HTML while this form is present.
   */
  display: string;
  /** `SOL` or `EVM`, the badge the mould puts beside it. */
  family: "SOL" | "EVM";
};

/**
 * Six leading characters.
 *
 * `address-invariant.test.ts` measured six as the point where a base58 slice
 * stops colliding with Spanish prose by accident, and it is what the reference
 * sites print — a length people can compare against their own wallet at a
 * glance. EVM addresses keep their `0x`, which is how they are always written.
 */
export function truncateAddress(address: string): string {
  return address.slice(0, 6);
}

/**
 * `AbCdEf...wXyZ`, the mould's form inside the disclosure panel.
 *
 * Six and four, with the middle dropped. An address is recognisable from its
 * ends — which is why every explorer prints it this way — and unfindable
 * without its middle, which is why the middle is never published.
 */
export function truncateAddressLong(address: string): string {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

/**
 * Public wallets for a set of KOLs, keyed by KOL id.
 *
 * A KOL with none is **absent from the map**, which is what renders
 * `Wallets ocultas` — the same shape `readChainPnl` uses, and for the same
 * reason: absence is a state, not a zero.
 */
export async function readPublicWallets(kolIds: string[]): Promise<Map<string, PublicWallet[]>> {
  if (kolIds.length === 0) return new Map();

  const rows = await query<{
    kol_id: string;
    id: string;
    chain: Chain;
    address_enc: Buffer;
  }>(
    `SELECT kol_id, id, chain, address_enc
       FROM kol_wallet
      -- The authorisation, and the only one. is_public is the KOL opt-in;
      -- status keeps a withdrawn wallet off a page it used to be on.
      WHERE kol_id = ANY($1::uuid[]) AND status = 'active' AND is_public
      ORDER BY kol_id, chain, id`,
    [kolIds],
  );

  const byKol = new Map<string, PublicWallet[]>();
  for (const row of rows) {
    let address: string;
    try {
      // **The wallet's own id, not the KOL's.** `wallets.ts` binds the AAD to
      // `kol_wallet.id`, and the first version of this used `kol_id` — so every
      // decrypt threw, the catch below swallowed it, and every row fell back to
      // `Wallets ocultas`. It looked like a working empty state.
      address = decrypt(row.address_enc, aadFor("kol_wallet", "address", row.id));
    } catch {
      // A ciphertext that will not open is skipped rather than surfaced: the
      // KOL shows one fewer published wallet, which is the safe direction for a
      // reader — the alternative is a broken string on a public row.
      //
      // **It is also what hid the bug above**, so the guard against that is not
      // here but in `address-invariant.test.ts`, which asserts a published
      // wallet's chip *is* on the page. A catch that turns a defect into a
      // plausible state needs a test that knows what the state should be.
      continue;
    }
    const list = byKol.get(row.kol_id) ?? [];
    list.push({
      chain: row.chain,
      short: truncateAddress(address),
      display: truncateAddressLong(address),
      family: isEvm(row.chain) ? "EVM" : "SOL",
    });
    byKol.set(row.kol_id, list);
  }
  return byKol;
}
