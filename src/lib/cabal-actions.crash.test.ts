import { ed25519 } from "@noble/curves/ed25519.js";
import bs58 from "bs58";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * What happens when the process dies **between burning the nonce and doing the
 * work** — the one window the gate's ordering creates on purpose.
 *
 * `appendAudit` is made to throw, which stands in for any failure after the
 * proof is spent: a crash, a lost connection, a statement timeout. The
 * transaction rolls back, so nothing happened; the burn was committed on its
 * own connection, so the proof is gone.
 *
 * **The caller asks for another nonce and signs again.** That is the cost, and
 * it is one round trip. The alternative — a nonce that survives a failure
 * nobody has diagnosed — is a signature that stays replayable, and it would be
 * bought at the price of making every refused rule a free question (see the
 * probing case in `cabal-actions.test.ts`). `DECISIONES.md` records the choice.
 *
 * Its own file because `vi.mock` is hoisted per module: mocking `./audit` here
 * keeps the real one in every other test.
 */
vi.mock("./audit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./audit")>();
  return {
    ...actual,
    appendAudit: vi.fn(async () => {
      throw new Error("the process died here");
    }),
  };
});

const { createCabal, subjectForTag } = await import("./cabal-actions");
const { query } = await import("./db");
const { issueNonce } = await import("./wallet-proof-store");
const { PROOF_DOMAIN, proofMessage } = await import("./wallet-proof");
const { blindIndex, encrypt, aadFor } = await import("./crypto");
const { resetAuditLog } = await import("./fixtures/audit");

beforeEach(async () => {
  await query("TRUNCATE cabal_request, wallet_proof_nonce");
  await query("UPDATE kol SET cabal_id = NULL");
  await query("TRUNCATE kol, kol_wallet, cabal CASCADE");
  await resetAuditLog();
});

describe("a failure after the nonce is spent", () => {
  it("rolls the action back and does not give the proof back", async () => {
    const secret = ed25519.utils.randomSecretKey();
    const address = bs58.encode(ed25519.getPublicKey(secret));
    const kolId = crypto.randomUUID();
    await query(
      `INSERT INTO kol (id, slug, display_name, x_handle, status, approved_at)
       VALUES ($1::uuid, 'ana', 'ANA', 'ana', 'approved', now())`,
      [kolId],
    );
    await query(
      `INSERT INTO kol_wallet (id, kol_id, chain, address_hmac, address_enc, status, is_public)
       VALUES ($1::uuid, $2::uuid, 'solana', $3, $4, 'active', FALSE)`,
      [
        crypto.randomUUID(),
        kolId,
        blindIndex(address, "address"),
        encrypt(address, aadFor("kol_wallet", "address", kolId)),
      ],
    );

    const subject = subjectForTag("ARG");
    const issued = await issueNonce(address, "solana", "crear cabal", subject);
    const fields = {
      domain: PROOF_DOMAIN,
      address,
      chain: "solana" as const,
      action: "crear cabal" as const,
      subject,
      nonce: issued.nonce,
      expiresAt: issued.expiresAt,
    };
    const request = {
      address,
      chain: "solana" as const,
      signature: bs58.encode(ed25519.sign(new TextEncoder().encode(proofMessage(fields)), secret)),
      nonce: issued.nonce,
      expiresAt: issued.expiresAt,
      subject,
    };

    await expect(createCabal(request, { name: "Cabal", color: "a" })).rejects.toThrow(
      "the process died here",
    );

    // Nothing happened: the cabal, the membership and the entry all rolled back
    // together, which is why they are one transaction.
    expect(await query("SELECT id FROM cabal")).toHaveLength(0);
    expect(await query("SELECT cabal_id FROM kol WHERE cabal_id IS NOT NULL")).toHaveLength(0);
    expect(await query("SELECT id FROM audit_log")).toHaveLength(0);

    // And the proof is spent all the same. Another nonce, another signature.
    const [row] = await query<{ used_at: Date | null }>(
      "SELECT used_at FROM wallet_proof_nonce WHERE nonce = $1",
      [issued.nonce],
    );
    expect(row.used_at).not.toBeNull();
    await expect(createCabal(request, { name: "Cabal", color: "a" })).resolves.toEqual({
      ok: false,
      reason: "bad_proof",
    });
  });
});
