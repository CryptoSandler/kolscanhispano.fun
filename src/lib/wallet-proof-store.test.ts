import { beforeEach, describe, expect, it } from "vitest";
import { query } from "./db";
import { inventAddress, inventEvmAddress } from "./ids";
import { consumeNonce, issueNonce, pruneNonces } from "./wallet-proof-store";
import { PROOF_ACTIONS } from "./wallet-proof";

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


/**
 * The subject binding — `migrations/017`, and the hole it closes.
 *
 * A leader signing `aceptar solicitud` authorises *an* acceptance. Without a
 * subject on the nonce, the same proof satisfies the verifier for every pending
 * request in the cabal: one handler bug or one race between two open tabs and
 * the signature meant for Ana admits Beto, recorded in `audit_log` as the
 * leader's own decision, because cryptographically it is.
 *
 * These are the negative cases that make that impossible, written the way
 * `docs/wallet-proof.md` §3 asks — named before the handlers exist.
 */
describe("the subject a nonce is bound to", () => {
  it("refuses a nonce claimed for a different subject", async () => {
    const address = inventAddress();
    const { nonce } = await issueNonce(address, "solana", "aceptar solicitud", "@ana");

    // The same wallet, the same action, the same live nonce — another target.
    const wrong = await consumeNonce(nonce, address, "solana", "aceptar solicitud", "@beto");
    expect(wrong).toEqual({ ok: false, reason: "wrong_nonce" });

    // And it is still spendable for the subject it was issued for: a refused
    // claim must not burn somebody else's nonce.
    const right = await consumeNonce(nonce, address, "solana", "aceptar solicitud", "@ana");
    expect(right.ok).toBe(true);
  });

  /**
   * `wrong_nonce` and not a distinct reason: a caller must not be able to probe
   * which subject a nonce belongs to by reading the refusal. Same rule the
   * wrong-wallet and wrong-action cases already follow.
   */
  it("says the same thing for a wrong subject as for a nonce that never existed", async () => {
    const address = inventAddress();
    const { nonce } = await issueNonce(address, "solana", "expulsar del cabal", "@ana");

    const wrongSubject = await consumeNonce(nonce, address, "solana", "expulsar del cabal", "@beto");
    const neverIssued = await consumeNonce(
      "00000000000000000000000000000000",
      address,
      "solana",
      "expulsar del cabal",
      "@ana",
    );
    expect(wrongSubject).toEqual(neverIssued);
  });

  it("refuses a subjectless claim on a nonce issued with one, and the reverse", async () => {
    const address = inventAddress();
    const conSujeto = await issueNonce(address, "solana", "aceptar solicitud", "@ana");
    expect(await consumeNonce(conSujeto.nonce, address, "solana", "aceptar solicitud")).toEqual({
      ok: false,
      reason: "wrong_nonce",
    });

    const sinSujeto = await issueNonce(address, "solana", "aceptar solicitud");
    expect(
      await consumeNonce(sinSujeto.nonce, address, "solana", "aceptar solicitud", "@ana"),
    ).toEqual({ ok: false, reason: "wrong_nonce" });
  });

  /**
   * The compatibility half: `/registro`'s two actions carry no subject on
   * either side, and `IS NOT DISTINCT FROM` is what keeps `NULL = NULL` from
   * failing every proof the moment this column existed.
   */
  it("still accepts the registration actions, which have no subject", async () => {
    const address = inventAddress();
    const { nonce } = await issueNonce(address, "solana", "alta de perfil");
    expect((await consumeNonce(nonce, address, "solana", "alta de perfil")).ok).toBe(true);
  });
});


/**
 * **The union and the CHECK are one rule written twice, and this is the test
 * that notices when they stop agreeing.**
 *
 * Adding an action is **two changes**: the list in `wallet-proof.ts` and the
 * constraint in a migration. Doing only the first was tried on 2026-09-04 and
 * Postgres refused the insert — the right failure, but at the first *issue* of
 * a cabal nonce rather than at the change. Doing only the second is worse and
 * silent: the column would accept a value nothing in the code can produce or
 * compare, and the drift would sit there until somebody read the schema.
 *
 * So the comparison runs **both ways**, against the catalogue rather than
 * against a literal in this file — a literal would be a third copy of the same
 * list, which is the thing being guarded against. `DECISIONES.md` carries the
 * two-changes rule and points here.
 */
describe("the action list in the code and the one in the schema", () => {
  /** The values inside `CHECK (action IN ('a','b',...))`, from `pg_constraint`. */
  async function schemaActions(): Promise<string[]> {
    const [row] = await query<{ def: string }>(
      `SELECT pg_get_constraintdef(c.oid) AS def
         FROM pg_constraint c
         JOIN pg_class t ON t.oid = c.conrelid
        WHERE t.relname = 'wallet_proof_nonce'
          AND c.conname = 'wallet_proof_nonce_action_check'`,
    );
    if (!row) throw new Error("the action CHECK is not in the catalogue at all");
    return [...row.def.matchAll(/'((?:[^']|'')*)'/g)].map((m) => m[1].replace(/''/g, "'"));
  }

  it("is the same set, with nothing extra on either side", async () => {
    const schema = (await schemaActions()).sort();
    const code: string[] = [...PROOF_ACTIONS].sort();

    // Both directions, named separately so a failure says which way it drifted.
    expect(
      code.filter((a) => !schema.includes(a)),
      "in wallet-proof.ts but not in the CHECK — the migration is missing",
    ).toEqual([]);
    expect(
      schema.filter((a) => !code.includes(a)),
      "in the CHECK but not in wallet-proof.ts — a value nothing can verify",
    ).toEqual([]);
    expect(schema).toEqual(code);
  });

  /**
   * Proof the parse above is reading something real: if the regex stopped
   * matching, both filters would be empty against an empty list and the case
   * would pass for the wrong reason.
   */
  it("reads a non-trivial list out of the catalogue", async () => {
    const schema = await schemaActions();
    expect(schema.length).toBeGreaterThanOrEqual(8);
    expect(schema).toContain("alta de perfil");
  });
});
