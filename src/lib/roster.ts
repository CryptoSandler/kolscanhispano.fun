/**
 * Creating a KOL and its wallets, in one transaction.
 *
 * The one place a roster row is written, reached by two callers with two
 * different answers to one question: the admin creates an **approved** KOL,
 * `/registro` creates a **pending** one. Everything else — the shape checks,
 * the encryption, the blind index, the duplicate refusal — is identical, and
 * that is why it lives here rather than twice.
 *
 * `docs/padron.md` §2 records the deviation this rests on: a pending
 * registration is a `kol` row with `status = 'pending'`, not a `claim` row.
 * Spec §6.1 routes it through `claim` and `claim_wallet`; the argument for and
 * against is in that document, and the deciding point is that
 * `UNIQUE (chain, address_hmac)` is enforced by the database on every insert
 * while "uniqueness checked across both tables" is enforced by whoever
 * remembers to write it.
 */

import { randomUUID } from "node:crypto";
import { canonicalAddress, isChainActive, type Chain } from "./chain";
import { aadFor, blindIndex, encrypt } from "./crypto";
import { query, withTransaction } from "./db";

export type WalletInput = {
  address: string;
  chain: Chain;
  /** Migration 012's default is `false`; a caller has to ask for publication. */
  isPublic?: boolean;
};

export type CreateKolInput = {
  /** Already normalised by `normalizeXHandle`. Becomes `slug` and `x_handle`. */
  handle: string;
  displayName?: string;
  wallets: WalletInput[];
  status: "approved" | "pending";
};

export type CreateKolFailure =
  | "no_wallets"
  | "chain_not_active"
  | "bad_address"
  | "duplicate_in_request"
  | "address_taken"
  | "handle_taken";

export type CreateKolResult =
  | { ok: true; kolId: string; wallets: { id: string; chain: Chain; isPublic: boolean }[] }
  | { ok: false; reason: CreateKolFailure };

/**
 * At least one wallet, and a ceiling.
 *
 * A KOL with no wallet is a row that can never earn a figure, so it is refused
 * rather than created and left to look broken. The ceiling is not about abuse —
 * the admin route is behind a token and `/registro` is rate-limited — it is
 * about one request not writing an unbounded number of rows inside one
 * transaction.
 */
const MAX_WALLETS = 20;

/**
 * Creates the KOL and its wallets, or refuses without writing anything.
 *
 * **One transaction, and the duplicate check is inside it.** Checking for a
 * taken address and then inserting would be two statements a concurrent request
 * can interleave with, so the check is a belt and `UNIQUE (chain,
 * address_hmac)` is the braces: the insert is what actually decides, and a
 * unique violation is translated back into `address_taken` rather than
 * escaping as a 500.
 *
 * **A refusal never says who holds an address.** `address_taken` is the whole
 * answer. Naming the holder would turn this route into a lookup oracle: submit
 * an address, learn which KOL owns it — the linkage `SECURITY.md` calls the
 * asset, handed over by the error message rather than by the data.
 */
export async function createKol(input: CreateKolInput): Promise<CreateKolResult> {
  if (input.wallets.length === 0) return { ok: false, reason: "no_wallets" };
  if (input.wallets.length > MAX_WALLETS) return { ok: false, reason: "no_wallets" };

  // Shape and activation first, before any row is touched: these are decisions
  // about the request, and a request that cannot succeed should not open a
  // transaction.
  const prepared: { id: string; chain: Chain; canonical: string; isPublic: boolean }[] = [];
  const seen = new Set<string>();
  for (const wallet of input.wallets) {
    if (!isChainActive(wallet.chain)) return { ok: false, reason: "chain_not_active" };
    let canonical: string;
    try {
      canonical = canonicalAddress(wallet.address, wallet.chain);
    } catch {
      // The message from `canonicalAddress` names the chain and never the
      // address; this drops it entirely and answers with a reason code.
      return { ok: false, reason: "bad_address" };
    }
    // Two spellings of one address in one request are one address. Caught here
    // rather than by the unique index, so the caller is told which mistake they
    // made instead of being told the address is taken -- by themselves.
    const fingerprint = `${wallet.chain}:${canonical}`;
    if (seen.has(fingerprint)) return { ok: false, reason: "duplicate_in_request" };
    seen.add(fingerprint);
    prepared.push({
      id: randomUUID(),
      chain: wallet.chain,
      canonical,
      isPublic: wallet.isPublic ?? false,
    });
  }

  try {
    return await withTransaction(async (tx) => {
      const kolId = randomUUID();
      const inserted = await tx<{ id: string }>(
        `INSERT INTO kol (id, slug, display_name, x_handle, status, approved_at)
         VALUES ($1, $2, $3, $4, $5, CASE WHEN $5 = 'approved' THEN now() END)
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [kolId, input.handle.toLowerCase(), input.displayName ?? input.handle, input.handle,
         input.status],
      );
      // `slug` and `x_handle` are both unique; `DO NOTHING` turns either
      // collision into an empty result rather than an exception, and the caller
      // gets one reason for both because both mean "this account is already on
      // the roster".
      if (inserted.length === 0) return { ok: false as const, reason: "handle_taken" as const };

      for (const wallet of prepared) {
        await tx(
          `INSERT INTO kol_wallet (id, kol_id, chain, address_enc, address_hmac, is_public)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            wallet.id,
            kolId,
            wallet.chain,
            encrypt(wallet.canonical, aadFor("kol_wallet", "address", wallet.id)),
            blindIndex(wallet.canonical, "address"),
            wallet.isPublic,
          ],
        );
      }

      return {
        ok: true as const,
        kolId,
        wallets: prepared.map((w) => ({ id: w.id, chain: w.chain, isPublic: w.isPublic })),
      };
    });
  } catch (error) {
    // 23505 on `kol_wallet_chain_address_idx`: the address belongs to somebody.
    // Translated rather than propagated, because a 500 here would tell a caller
    // less than the truth and would also log a stack trace on a path that
    // handles addresses.
    if ((error as { code?: string }).code === "23505") {
      return { ok: false, reason: "address_taken" };
    }
    throw error;
  }
}

/**
 * Moves a pending KOL to approved.
 *
 * `WHERE status = 'pending'` rather than an unconditional update, so approving
 * twice is not an approval of a suspended KOL that somebody re-approved by
 * accident. Returns `false` when no row moved, which the caller answers as
 * "no such pending KOL" — the same answer for a slug that never existed.
 */
export async function approveKol(kolId: string): Promise<boolean> {
  const rows = await query<{ id: string }>(
    `UPDATE kol SET status = 'approved', approved_at = now()
      WHERE id = $1 AND status = 'pending'
      RETURNING id`,
    [kolId],
  );
  return rows.length === 1;
}
