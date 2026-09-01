import { beforeEach, describe, expect, it } from "vitest";
import { query } from "./db";
import { inventAddress, inventEvmAddress } from "./ids";
import { consumeNonce, issueNonce, pruneNonces } from "./wallet-proof-store";

/**
 * The half of `docs/wallet-proof.md` §3 that cannot be tested purely: cases 5
 * and 6, single use and the race that makes "single" mean something.
 *
 * This is the one place this design is deliberately stricter than the
 * implementation it was modelled on — `nftraffle`'s binding documents a
 * client-chosen nonce and the replay it allows. The point of these tests is
 * that the stricter thing actually holds.
 */
beforeEach(async () => {
  await query("TRUNCATE wallet_proof_nonce");
});

describe("issueNonce", () => {
  it("issues a nonce the message format accepts", async () => {
    const { nonce, expiresAt } = await issueNonce(inventAddress(), "solana", "alta de perfil");
    // The shape `verifyProof` requires of a nonce, asserted here so the two
    // halves cannot drift apart into a nonce that is issued and never accepted.
    expect(nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(Date.parse(expiresAt)).toBeGreaterThan(Date.now());
  });

  it("never stores the address in plaintext", async () => {
    const address = inventAddress();
    await issueNonce(address, "solana", "alta de perfil");
    const rows = await query<{ address_hmac: Buffer }>(
      "SELECT address_hmac FROM wallet_proof_nonce",
    );
    expect(rows).toHaveLength(1);
    // SECURITY.md: an address reaches no table in plaintext. Asserted against
    // the bytes, not against a column name.
    expect(rows[0].address_hmac.toString("utf8")).not.toContain(address);
    expect(rows[0].address_hmac).toHaveLength(32);
  });

  it("gives two calls different nonces", async () => {
    const address = inventAddress();
    const first = await issueNonce(address, "solana", "alta de perfil");
    const second = await issueNonce(address, "solana", "alta de perfil");
    expect(first.nonce).not.toBe(second.nonce);
  });
});

describe("consumeNonce", () => {
  it("accepts a freshly issued nonce once", async () => {
    const address = inventAddress();
    const { nonce } = await issueNonce(address, "solana", "alta de perfil");
    const claim = await consumeNonce(nonce, address, "solana", "alta de perfil");
    expect(claim.ok).toBe(true);
  });

  it("5. refuses a nonce that was already spent", async () => {
    const address = inventAddress();
    const { nonce } = await issueNonce(address, "solana", "alta de perfil");
    expect((await consumeNonce(nonce, address, "solana", "alta de perfil")).ok).toBe(true);
    expect(await consumeNonce(nonce, address, "solana", "alta de perfil")).toEqual({
      ok: false,
      reason: "nonce_used",
    });
  });

  /**
   * Case 6, and the reason `consumeNonce` is one `UPDATE` rather than a
   * `SELECT` followed by one.
   *
   * With a read-then-write, both callers read the nonce unused, both proceed,
   * and the second proof is admitted on a nonce the first already spent. The
   * single statement takes the row lock and the decision together, so of two
   * racing callers exactly one comes back with a row.
   */
  it("6. admits exactly one of two concurrent claims on one nonce", async () => {
    const address = inventAddress();
    const { nonce } = await issueNonce(address, "solana", "alta de perfil");

    const claims = await Promise.all(
      Array.from({ length: 8 }, () => consumeNonce(nonce, address, "solana", "alta de perfil")),
    );

    expect(claims.filter((claim) => claim.ok)).toHaveLength(1);
    for (const claim of claims.filter((claim) => !claim.ok)) {
      expect(claim).toEqual({ ok: false, reason: "nonce_used" });
    }
  });

  it("refuses a nonce that was never issued", async () => {
    expect(await consumeNonce("f".repeat(32), inventAddress(), "solana", "alta de perfil")).toEqual(
      { ok: false, reason: "wrong_nonce" },
    );
  });

  it("refuses a real nonce presented by another wallet", async () => {
    const owner = inventAddress();
    const { nonce } = await issueNonce(owner, "solana", "alta de perfil");
    // Same answer as "never issued", deliberately: telling them apart would
    // confirm to a caller that some other wallet holds this nonce.
    expect(await consumeNonce(nonce, inventAddress(), "solana", "alta de perfil")).toEqual({
      ok: false,
      reason: "wrong_nonce",
    });
    // And it is still spendable by its owner, so a probe cannot burn it.
    expect((await consumeNonce(nonce, owner, "solana", "alta de perfil")).ok).toBe(true);
  });

  it("refuses a nonce presented for another chain or another action", async () => {
    const address = inventEvmAddress();
    const { nonce } = await issueNonce(address, "ethereum", "alta de perfil");
    expect(await consumeNonce(nonce, address, "bnb", "alta de perfil")).toEqual({
      ok: false,
      reason: "wrong_nonce",
    });
    expect(await consumeNonce(nonce, address, "ethereum", "agregar wallet")).toEqual({
      ok: false,
      reason: "wrong_nonce",
    });
    expect((await consumeNonce(nonce, address, "ethereum", "alta de perfil")).ok).toBe(true);
  });

  it("refuses an expired nonce, and tells that apart from a used one", async () => {
    const address = inventAddress();
    const { nonce } = await issueNonce(address, "solana", "alta de perfil");
    await query("UPDATE wallet_proof_nonce SET expires_at = now() - interval '1 second'");
    expect(await consumeNonce(nonce, address, "solana", "alta de perfil")).toEqual({
      ok: false,
      reason: "expired",
    });
  });
});

describe("pruneNonces", () => {
  it("removes what can no longer authorise anything, and keeps what can", async () => {
    const live = await issueNonce(inventAddress(), "solana", "alta de perfil");
    const stale = await issueNonce(inventAddress(), "solana", "alta de perfil");
    await query(
      "UPDATE wallet_proof_nonce SET expires_at = now() - interval '2 hours' WHERE nonce = $1",
      [stale.nonce],
    );

    expect(await pruneNonces()).toBe(1);
    const left = await query<{ nonce: string }>("SELECT nonce FROM wallet_proof_nonce");
    expect(left.map((row) => row.nonce)).toEqual([live.nonce]);
  });

  it("keeps a just-expired nonce, so a clock that disagrees cannot erase evidence", async () => {
    const address = inventAddress();
    await issueNonce(address, "solana", "alta de perfil");
    await query("UPDATE wallet_proof_nonce SET expires_at = now() - interval '1 minute'");
    expect(await pruneNonces()).toBe(0);
  });
});
