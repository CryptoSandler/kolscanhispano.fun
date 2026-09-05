import { randomBytes } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519.js";
import bs58 from "bs58";
import { beforeEach, describe, expect, it } from "vitest";
import {
  acceptRequest,
  appointCoLeader,
  claimCabal,
  createCabal,
  expel,
  readOwnRequest,
  readRequests,
  revokeCoLeader,
  rejectRequest,
  requestJoin,
  subjectForHandle,
  subjectForTag,
  transfer,
  type ActionRefusal,
  type SignedRequest,
} from "./cabal-actions";
import { verifyAuditChain } from "./audit";
import { checkSignature } from "./audit-signature";
import { blindIndex, encrypt, aadFor } from "./crypto";
import { query } from "./db";
import { resetAuditLog } from "./fixtures/audit";
import { issueNonce } from "./wallet-proof-store";
import { PROOF_DOMAIN, proofMessage, type ProofAction } from "./wallet-proof";

/**
 * The six signed actions a cabal leader has, and the refusals that matter more
 * than the successes.
 *
 * `docs/round-cabals.md` §4 is the design; `src/lib/cabal-actions.ts` is the
 * gate. What is asserted here is the gate's **order**, because that is where
 * this can be wrong while every individual query is right: a nonce checked
 * after the rule leaks the state to whoever replays a signature, and a rule
 * checked against the wrong cabal hands a group to a stranger.
 *
 * Every refusal is asserted **by value**, never by `ok === false`. The four ways
 * a proof can be bad answer one word on purpose, and a test that only checked
 * "it failed" would pass just as happily if they stopped being one word.
 */

const CHAIN = "solana" as const;

/** A Solana keypair. The signature has to be real: `verifyProof` does the curve. */
function wallet() {
  const secret = ed25519.utils.randomSecretKey();
  return {
    address: bs58.encode(ed25519.getPublicKey(secret)),
    sign: (message: string) =>
      bs58.encode(ed25519.sign(new TextEncoder().encode(message), secret)),
  };
}

type Wallet = ReturnType<typeof wallet>;
type Kol = { id: string; handle: string; wallet: Wallet };

/** An approved KOL with one active wallet — the only shape that can act. */
async function newKol(
  handle: string,
  options: { status?: string; walletStatus?: string; cabalId?: string | null } = {},
): Promise<Kol> {
  const id = crypto.randomUUID();
  const w = wallet();
  await query(
    `INSERT INTO kol (id, slug, display_name, x_handle, status, cabal_id, approved_at)
     VALUES ($1::uuid, $2, $3, $4::citext, $5, $6::uuid, now())`,
    [
      id,
      handle,
      handle.toUpperCase(),
      handle,
      options.status ?? "approved",
      options.cabalId ?? null,
    ],
  );
  await query(
    `INSERT INTO kol_wallet (id, kol_id, chain, address_hmac, address_enc, status, is_public)
     VALUES ($1::uuid, $2::uuid, 'solana', $3, $4, $5, FALSE)`,
    [
      crypto.randomUUID(),
      id,
      blindIndex(w.address, "address"),
      encrypt(w.address, aadFor("kol_wallet", "address", id)),
      options.walletStatus ?? "active",
    ],
  );
  return { id, handle, wallet: w };
}

/**
 * A real proof: a nonce this server issued, and a signature over exactly the
 * message the server would have asked for.
 *
 * `over` exists for the negative cases, and it deliberately changes the
 * *request* without changing what was issued — which is how a redirected proof
 * is built.
 */
async function prove(
  kol: Kol,
  action: ProofAction,
  subject: string | undefined,
  over: Partial<SignedRequest & { signWith: Wallet }> = {},
): Promise<SignedRequest> {
  const issued = await issueNonce(kol.wallet.address, CHAIN, action, subject);
  const signer = over.signWith ?? kol.wallet;
  const fields = {
    domain: PROOF_DOMAIN,
    address: over.address ?? signer.address,
    chain: over.chain ?? CHAIN,
    action: (over as { action?: ProofAction }).action ?? action,
    subject: "subject" in over ? over.subject : subject,
    nonce: over.nonce ?? issued.nonce,
    expiresAt: over.expiresAt ?? issued.expiresAt,
  };
  return {
    address: fields.address,
    chain: fields.chain,
    signature: over.signature ?? signer.sign(proofMessage(fields)),
    nonce: fields.nonce,
    expiresAt: fields.expiresAt,
    subject: fields.subject,
  };
}

async function makeCabal(leader: Kol, tag: string): Promise<string> {
  const result = await createCabal(await prove(leader, "crear cabal", subjectForTag(tag)), {
    name: `Cabal ${tag}`,
    color: "a",
  });
  expect(result).toEqual({ ok: true, value: { tag } });
  const [row] = await query<{ id: string }>("SELECT id FROM cabal WHERE tag = $1", [tag]);
  return row.id;
}

async function join(member: Kol, cabalId: string): Promise<void> {
  await query("UPDATE kol SET cabal_id = $1::uuid WHERE id = $2::uuid", [cabalId, member.id]);
}

/** A deputy, written the way `migrations/020` holds one: a row with a slot. */
async function makeCoLeader(deputy: Kol, cabalId: string, slot = 1): Promise<void> {
  await query(
    "INSERT INTO cabal_co_leader (cabal_id, kol_id, slot) VALUES ($1::uuid, $2::uuid, $3)",
    [cabalId, deputy.id, slot],
  );
}

/** The handles of a cabal's deputies, by slot. */
async function coLeaders(cabalId: string): Promise<string[]> {
  const rows = await query<{ x_handle: string }>(
    `SELECT k.x_handle FROM cabal_co_leader cl
       JOIN kol k ON k.id = cl.kol_id
      WHERE cl.cabal_id = $1::uuid ORDER BY cl.slot`,
    [cabalId],
  );
  return rows.map((row) => row.x_handle);
}

function refusal(reason: ActionRefusal) {
  return { ok: false, reason };
}

/** Every audit row for one action, newest last. */
async function entries(): Promise<{ actor: string; action: string; subject: string | null }[]> {
  return query("SELECT actor, action, subject FROM audit_log ORDER BY at ASC, id ASC");
}

beforeEach(async () => {
  await query("TRUNCATE cabal_request, cabal_co_leader, cabal_nomination, wallet_proof_nonce");
  await query("UPDATE kol SET cabal_id = NULL");
  await query("TRUNCATE kol, kol_wallet, cabal CASCADE");
  await resetAuditLog();
});

describe("createCabal", () => {
  it("makes the signer the leader and records the entry", async () => {
    const leader = await newKol("ana");
    await makeCabal(leader, "ARG");

    const [cabal] = await query<{ leader_kol_id: string; created_by: string; color: string }>(
      "SELECT leader_kol_id, created_by, color FROM cabal WHERE tag = 'ARG'",
    );
    expect(cabal.leader_kol_id).toBe(leader.id);
    // The carve-out in `/admin` reads this column, so a leader-made cabal has to
    // be distinguishable from one the operator seeded.
    expect(cabal.created_by).toBe("leader");

    const [member] = await query<{ cabal_id: string }>(
      "SELECT cabal_id FROM kol WHERE id = $1::uuid",
      [leader.id],
    );
    expect(member.cabal_id).toBe(cabal.leader_kol_id === leader.id ? member.cabal_id : null);
    expect(await entries()).toEqual([
      { actor: "@ana", action: "crear cabal", subject: "ARG" },
    ]);
  });

  /**
   * The tag is the subject and nothing else. A caller who could pass it beside
   * the proof would sign for one tag in their wallet and claim another here,
   * which is the redirection `migrations/017` exists to close — so there is no
   * second field to pass.
   */
  it("claims the tag the signature covers", async () => {
    const leader = await newKol("ana");
    const request = await prove(leader, "crear cabal", subjectForTag("ARG"));
    expect(await createCabal({ ...request, subject: "MEX" }, { name: "x", color: "a" })).toEqual(
      refusal("bad_proof"),
    );
    expect(await query("SELECT id FROM cabal")).toHaveLength(0);
  });

  it("refuses a tag somebody still holds, and lets a released one through", async () => {
    const first = await newKol("ana");
    await makeCabal(first, "ARG");

    const second = await newKol("beto");
    expect(
      await createCabal(await prove(second, "crear cabal", subjectForTag("ARG")), {
        name: "otro",
        color: "b",
      }),
    ).toEqual(refusal("tag_taken"));

    // `scripts/release-cabal-tags.ts` nulls the tag thirty days after the group
    // dissolved; from the index's point of view that is all it takes.
    await query("UPDATE cabal SET tag = NULL, dissolved_at = now() WHERE tag = 'ARG'");
    expect(
      await createCabal(await prove(second, "crear cabal", subjectForTag("ARG")), {
        name: "otro",
        color: "b",
      }),
    ).toEqual({ ok: true, value: { tag: "ARG" } });
  });

  it("refuses a KOL who is already in a cabal", async () => {
    const leader = await newKol("ana");
    await makeCabal(leader, "ARG");
    expect(
      await createCabal(await prove(leader, "crear cabal", subjectForTag("MEX")), {
        name: "otro",
        color: "b",
      }),
    ).toEqual(refusal("already_in_cabal"));
  });

  it("refuses a colour outside the measured palette", async () => {
    const leader = await newKol("ana");
    // `DESIGN.md`'s contrast table is a claim about four tints. A fifth would be
    // an unmeasured colour on a public surface.
    expect(
      await createCabal(await prove(leader, "crear cabal", subjectForTag("ARG")), {
        name: "x",
        color: "e",
      }),
    ).toEqual(refusal("bad_input"));
  });
});

describe("requestJoin", () => {
  it("queues the ask without touching membership", async () => {
    const leader = await newKol("ana");
    const cabalId = await makeCabal(leader, "ARG");
    const applicant = await newKol("beto");

    expect(await requestJoin(await prove(applicant, "pedir entrar al cabal", "ARG"))).toEqual({
      ok: true,
      value: { tag: "ARG" },
    });

    const [row] = await query<{ cabal_id: string; kol_id: string; status: string }>(
      "SELECT cabal_id, kol_id, status FROM cabal_request",
    );
    expect(row).toEqual({ cabal_id: cabalId, kol_id: applicant.id, status: "pending" });
    // Asking is not joining.
    const [still] = await query<{ cabal_id: string | null }>(
      "SELECT cabal_id FROM kol WHERE id = $1::uuid",
      [applicant.id],
    );
    expect(still.cabal_id).toBeNull();
  });

  it("refuses a second live ask to the same cabal", async () => {
    const leader = await newKol("ana");
    await makeCabal(leader, "ARG");
    const applicant = await newKol("beto");

    await requestJoin(await prove(applicant, "pedir entrar al cabal", "ARG"));
    expect(await requestJoin(await prove(applicant, "pedir entrar al cabal", "ARG"))).toEqual(
      refusal("already_requested"),
    );
    expect(await query("SELECT id FROM cabal_request")).toHaveLength(1);
  });

  it("lets a rejected KOL ask again", async () => {
    const leader = await newKol("ana");
    await makeCabal(leader, "ARG");
    const applicant = await newKol("beto");
    await requestJoin(await prove(applicant, "pedir entrar al cabal", "ARG"));
    await rejectRequest(await prove(leader, "rechazar solicitud", subjectForHandle("beto")));

    // `cabal_request_one_pending` only constrains `pending`, so a rejection is
    // remembered and does not become a life sentence.
    expect(await requestJoin(await prove(applicant, "pedir entrar al cabal", "ARG"))).toEqual({
      ok: true,
      value: { tag: "ARG" },
    });
  });

  it("refuses a tag nobody holds, and a dissolved cabal", async () => {
    const applicant = await newKol("beto");
    expect(await requestJoin(await prove(applicant, "pedir entrar al cabal", "ZZZ"))).toEqual(
      refusal("not_found"),
    );

    const leader = await newKol("ana");
    await makeCabal(leader, "ARG");
    await query("UPDATE cabal SET dissolved_at = now() WHERE tag = 'ARG'");
    expect(await requestJoin(await prove(applicant, "pedir entrar al cabal", "ARG"))).toEqual(
      refusal("not_found"),
    );
  });
});

describe("acceptRequest and rejectRequest", () => {
  it("admits the applicant and closes the row", async () => {
    const leader = await newKol("ana");
    const cabalId = await makeCabal(leader, "ARG");
    const applicant = await newKol("beto");
    await requestJoin(await prove(applicant, "pedir entrar al cabal", "ARG"));

    expect(
      await acceptRequest(await prove(leader, "aceptar solicitud", subjectForHandle("beto"))),
    ).toEqual({ ok: true, value: { handle: "beto" } });

    const [row] = await query<{ status: string; decided_by_kol_id: string }>(
      "SELECT status, decided_by_kol_id FROM cabal_request",
    );
    expect(row).toEqual({ status: "accepted", decided_by_kol_id: leader.id });
    const [member] = await query<{ cabal_id: string }>(
      "SELECT cabal_id FROM kol WHERE id = $1::uuid",
      [applicant.id],
    );
    expect(member.cabal_id).toBe(cabalId);
  });

  it("rejects without moving anybody", async () => {
    const leader = await newKol("ana");
    await makeCabal(leader, "ARG");
    const applicant = await newKol("beto");
    await requestJoin(await prove(applicant, "pedir entrar al cabal", "ARG"));

    expect(
      await rejectRequest(await prove(leader, "rechazar solicitud", subjectForHandle("beto"))),
    ).toEqual({ ok: true, value: { handle: "beto" } });
    const [row] = await query<{ status: string }>("SELECT status FROM cabal_request");
    expect(row.status).toBe("rejected");
    const [applicantRow] = await query<{ cabal_id: string | null }>(
      "SELECT cabal_id FROM kol WHERE id = $1::uuid",
      [applicant.id],
    );
    expect(applicantRow.cabal_id).toBeNull();
  });

  it("lets a co-leader answer", async () => {
    const leader = await newKol("ana");
    const cabalId = await makeCabal(leader, "ARG");
    const deputy = await newKol("caro");
    await join(deputy, cabalId);
    await makeCoLeader(deputy, cabalId);
    const applicant = await newKol("beto");
    await requestJoin(await prove(applicant, "pedir entrar al cabal", "ARG"));

    expect(
      await acceptRequest(await prove(deputy, "aceptar solicitud", subjectForHandle("beto"))),
    ).toEqual({ ok: true, value: { handle: "beto" } });
    const [row] = await query<{ decided_by_kol_id: string }>(
      "SELECT decided_by_kol_id FROM cabal_request",
    );
    // Which of the two answered is a fact the trail should not have to guess.
    expect(row.decided_by_kol_id).toBe(deputy.id);
  });

  it("refuses a KOL who leads nothing", async () => {
    const leader = await newKol("ana");
    await makeCabal(leader, "ARG");
    const applicant = await newKol("beto");
    await requestJoin(await prove(applicant, "pedir entrar al cabal", "ARG"));

    const outsider = await newKol("dani");
    expect(
      await acceptRequest(await prove(outsider, "aceptar solicitud", subjectForHandle("beto"))),
    ).toEqual(refusal("not_leader"));
  });

  it("answers the same way for a handle nobody holds and one with no request", async () => {
    const leader = await newKol("ana");
    await makeCabal(leader, "ARG");
    await newKol("beto");

    // A leader learns nothing about who exists and never asked.
    expect(
      await acceptRequest(await prove(leader, "aceptar solicitud", subjectForHandle("beto"))),
    ).toEqual(refusal("not_found"));
    expect(
      await acceptRequest(await prove(leader, "aceptar solicitud", subjectForHandle("nadie"))),
    ).toEqual(refusal("not_found"));
  });

  it("refuses an applicant who joined somewhere else while the ask waited", async () => {
    const leader = await newKol("ana");
    await makeCabal(leader, "ARG");
    const applicant = await newKol("beto");
    await requestJoin(await prove(applicant, "pedir entrar al cabal", "ARG"));

    const other = await newKol("eli");
    const otherCabal = await makeCabal(other, "MEX");
    await join(applicant, otherCabal);

    // The queue is not a claim on somebody. Accepting here would silently move
    // a KOL out of a cabal they are already in.
    expect(
      await acceptRequest(await prove(leader, "aceptar solicitud", subjectForHandle("beto"))),
    ).toEqual(refusal("already_in_cabal"));
  });
});

describe("expel", () => {
  it("removes the member and leaves the cabal standing", async () => {
    const leader = await newKol("ana");
    const cabalId = await makeCabal(leader, "ARG");
    const member = await newKol("beto");
    await join(member, cabalId);

    expect(await expel(await prove(leader, "expulsar del cabal", subjectForHandle("beto")))).toEqual(
      { ok: true, value: { handle: "beto" } },
    );
    const [row] = await query<{ cabal_id: string | null }>(
      "SELECT cabal_id FROM kol WHERE id = $1::uuid",
      [member.id],
    );
    expect(row.cabal_id).toBeNull();
  });

  it("empties the co-leader seat when the co-leader is the one expelled", async () => {
    const leader = await newKol("ana");
    const cabalId = await makeCabal(leader, "ARG");
    const deputy = await newKol("caro");
    await join(deputy, cabalId);
    await makeCoLeader(deputy, cabalId);

    await expel(await prove(leader, "expulsar del cabal", subjectForHandle("caro")));
    // A deputy outside the group is a pointer at a stranger — and the slot has
    // to come free, or the cap silently becomes one.
    expect(await coLeaders(cabalId)).toEqual([]);
  });

  it("refuses to expel the leader, including by a co-leader", async () => {
    const leader = await newKol("ana");
    const cabalId = await makeCabal(leader, "ARG");
    const deputy = await newKol("caro");
    await join(deputy, cabalId);
    await makeCoLeader(deputy, cabalId);

    expect(
      await expel(await prove(deputy, "expulsar del cabal", subjectForHandle("ana"))),
    ).toEqual(refusal("cannot_expel_leader"));
    expect(
      await expel(await prove(leader, "expulsar del cabal", subjectForHandle("ana"))),
    ).toEqual(refusal("cannot_expel_leader"));
  });

  it("refuses somebody who is not in this cabal", async () => {
    const leader = await newKol("ana");
    await makeCabal(leader, "ARG");
    const other = await newKol("eli");
    const otherCabal = await makeCabal(other, "MEX");
    const stranger = await newKol("beto");
    await join(stranger, otherCabal);

    expect(
      await expel(await prove(leader, "expulsar del cabal", subjectForHandle("beto"))),
    ).toEqual(refusal("not_a_member"));
  });
});

describe("transfer", () => {
  it("hands the cabal on and keeps the old leader as a member", async () => {
    const leader = await newKol("ana");
    const cabalId = await makeCabal(leader, "ARG");
    const heir = await newKol("beto");
    await join(heir, cabalId);

    expect(
      await transfer(await prove(leader, "transferir el cabal", subjectForHandle("beto"))),
    ).toEqual({ ok: true, value: { handle: "beto" } });

    const [cabal] = await query<{ leader_kol_id: string }>(
      "SELECT leader_kol_id FROM cabal WHERE id = $1::uuid",
      [cabalId],
    );
    expect(cabal.leader_kol_id).toBe(heir.id);
    // Losing the title is not losing the cabal.
    const [old] = await query<{ cabal_id: string }>("SELECT cabal_id FROM kol WHERE id = $1::uuid", [
      leader.id,
    ]);
    expect(old.cabal_id).toBe(cabalId);
  });

  /**
   * The decision in `docs/round-cabals.md` §4 only survives if this refuses. A
   * co-leader who could promote themselves would make "orphan unless there is a
   * co-leader, and only the admin reassigns" mean nothing: there is nothing in
   * the database that tells "the leader is gone" from "the deputy would like
   * the group".
   */
  it("refuses a co-leader", async () => {
    const leader = await newKol("ana");
    const cabalId = await makeCabal(leader, "ARG");
    const deputy = await newKol("caro");
    await join(deputy, cabalId);
    await makeCoLeader(deputy, cabalId);

    expect(
      await transfer(await prove(deputy, "transferir el cabal", subjectForHandle("caro"))),
    ).toEqual(refusal("not_leader"));
    expect(
      await transfer(await prove(deputy, "transferir el cabal", subjectForHandle("ana"))),
    ).toEqual(refusal("not_leader"));
  });

  it("empties the co-leader seat when the heir was the deputy", async () => {
    const leader = await newKol("ana");
    const cabalId = await makeCabal(leader, "ARG");
    const deputy = await newKol("caro");
    await join(deputy, cabalId);
    await makeCoLeader(deputy, cabalId);

    expect(
      await transfer(await prove(leader, "transferir el cabal", subjectForHandle("caro"))),
    ).toEqual({ ok: true, value: { handle: "caro" } });
    const [cabal] = await query<{ leader_kol_id: string }>(
      "SELECT leader_kol_id FROM cabal WHERE id = $1::uuid",
      [cabalId],
    );
    // `cabal_co_leader_distinct_trg` would refuse the row otherwise, and it is
    // right to: the deputy of oneself is not a second person.
    expect(cabal.leader_kol_id).toBe(deputy.id);
    expect(await coLeaders(cabalId)).toEqual([]);
  });

  it("refuses an heir who is not a member, and refuses the signer themselves", async () => {
    const leader = await newKol("ana");
    await makeCabal(leader, "ARG");
    await newKol("beto");

    expect(
      await transfer(await prove(leader, "transferir el cabal", subjectForHandle("beto"))),
    ).toEqual(refusal("not_a_member"));
    expect(
      await transfer(await prove(leader, "transferir el cabal", subjectForHandle("ana"))),
    ).toEqual(refusal("bad_input"));
  });
});

/**
 * The gate itself, asserted once rather than in each of the six.
 *
 * `createCabal` is the vehicle because it needs the least state around it. What
 * is being tested is `authorise`, which every action shares.
 */
describe("the gate", () => {
  async function attempt(request: SignedRequest) {
    return createCabal(request, { name: "Cabal", color: "a" });
  }

  /**
   * The four ways a proof can be wrong, and the point is that they are **one
   * answer**. Telling them apart lets a caller map which wallet holds a nonce,
   * which action it was issued for, and which subject it names — three
   * questions nobody outside the signer should be able to ask.
   */
  it("answers bad_proof to all four ways a proof can be wrong", async () => {
    const leader = await newKol("ana");
    const other = await newKol("beto");
    const subject = subjectForTag("ARG");

    const neverIssued = await prove(leader, "crear cabal", subject, { nonce: "f".repeat(32) });
    // A real nonce, a real signature, the wrong wallet holding it.
    const wrongWallet = await prove(leader, "crear cabal", subject, { signWith: other.wallet });
    // Issued to join a cabal, spent to create one.
    const issuedForAnother = await issueNonce(
      leader.wallet.address,
      CHAIN,
      "pedir entrar al cabal",
      subject,
    );
    const wrongAction = await prove(leader, "crear cabal", subject, {
      nonce: issuedForAnother.nonce,
      expiresAt: issuedForAnother.expiresAt,
    });
    // Issued for MEX, signed and presented for ARG. The signature is perfectly
    // good; the nonce is bound to another target, which is the whole of
    // `migrations/017`.
    const wrongSubject = await prove(leader, "crear cabal", subjectForTag("MEX"), { subject });

    for (const request of [neverIssued, wrongWallet, wrongAction, wrongSubject]) {
      expect(await attempt(request)).toEqual(refusal("bad_proof"));
    }
    // And a signature that is simply not one.
    const tampered = await prove(leader, "crear cabal", subject);
    expect(
      await attempt({ ...tampered, signature: bs58.encode(randomBytes(64)) }),
    ).toEqual(refusal("bad_proof"));

    expect(await query("SELECT id FROM cabal")).toHaveLength(0);
    expect(await entries()).toEqual([]);
  });

  /**
   * A wallet a KOL removed stops authorising anything. Otherwise the answer to
   * "somebody took my wallet" would be a support ticket rather than a button.
   */
  it("refuses a wallet that is no longer active", async () => {
    const leader = await newKol("ana", { walletStatus: "withdrawn" });
    expect(await attempt(await prove(leader, "crear cabal", subjectForTag("ARG")))).toEqual(
      refusal("unknown_wallet"),
    );
  });

  /** Spec §9: a suspended KOL is not acting on anything, the same rule the ranking applies. */
  it("refuses a KOL who is not approved", async () => {
    for (const status of ["pending", "suspended", "rejected"]) {
      const kol = await newKol(`k${status}`, { status });
      expect(await attempt(await prove(kol, "crear cabal", subjectForTag("ARG")))).toEqual(
        refusal("unknown_wallet"),
      );
    }
  });

  /** A valid signature from a wallet no KOL has registered. Same word, different cause. */
  it("refuses a wallet no KOL holds", async () => {
    const stranger = wallet();
    const issued = await issueNonce(stranger.address, CHAIN, "crear cabal", "ARG");
    const fields = {
      domain: PROOF_DOMAIN,
      address: stranger.address,
      chain: CHAIN,
      action: "crear cabal" as const,
      subject: "ARG",
      nonce: issued.nonce,
      expiresAt: issued.expiresAt,
    };
    expect(
      await attempt({
        address: stranger.address,
        chain: CHAIN,
        signature: stranger.sign(proofMessage(fields)),
        nonce: issued.nonce,
        expiresAt: issued.expiresAt,
        subject: "ARG",
      }),
    ).toEqual(refusal("unknown_wallet"));
  });

  /**
   * **The nonce is burnt before the rule runs**, so a proof that fails the rule
   * is spent all the same.
   *
   * This is the case the ordering exists for. If the rule ran first, one
   * signature could be replayed against subject after subject until one was
   * accepted — "is @beto in this cabal?", "does MEX exist?" — at no cost per
   * question. Spending the nonce makes every question cost a signature the
   * person has to approve in their wallet.
   */
  it("spends the nonce even when the rule refuses", async () => {
    const applicant = await newKol("beto");
    const request = await prove(applicant, "pedir entrar al cabal", subjectForTag("ZZZ"));

    expect(await requestJoin(request)).toEqual(refusal("not_found"));
    // The same proof, replayed. It cannot be used to ask again.
    expect(await requestJoin(request)).toEqual(refusal("bad_proof"));

    const [row] = await query<{ used_at: Date | null }>(
      "SELECT used_at FROM wallet_proof_nonce WHERE nonce = $1",
      [request.nonce],
    );
    expect(row.used_at).not.toBeNull();
  });

  it("spends the nonce when the signer is not the leader", async () => {
    const leader = await newKol("ana");
    await makeCabal(leader, "ARG");
    const outsider = await newKol("dani");
    const request = await prove(outsider, "expulsar del cabal", subjectForHandle("ana"));

    expect(await expel(request)).toEqual(refusal("not_leader"));
    expect(await expel(request)).toEqual(refusal("bad_proof"));
  });
});

describe("the account it leaves", () => {
  it("records one entry per accepted action and none per refusal", async () => {
    const leader = await newKol("ana");
    const cabalId = await makeCabal(leader, "ARG");
    const applicant = await newKol("beto");
    await requestJoin(await prove(applicant, "pedir entrar al cabal", "ARG"));
    await acceptRequest(await prove(leader, "aceptar solicitud", subjectForHandle("beto")));
    await expel(await prove(leader, "expulsar del cabal", subjectForHandle("beto")));
    // Refused: no entry.
    await expel(await prove(leader, "expulsar del cabal", subjectForHandle("beto")));

    expect(await entries()).toEqual([
      { actor: "@ana", action: "crear cabal", subject: "ARG" },
      { actor: "@beto", action: "pedir entrar al cabal", subject: "ARG" },
      { actor: "@ana", action: "aceptar solicitud", subject: "@beto" },
      { actor: "@ana", action: "expulsar del cabal", subject: "@beto" },
    ]);
    expect(cabalId).toBeTruthy();
    expect(await verifyAuditChain()).toEqual([]);
  });

  /**
   * `migrations/019`'s whole claim: the signature is rebuilt from the **entry**,
   * so it attests to this actor doing this action under this nonce, and an
   * edited entry stops verifying.
   */
  it("keeps a signature that reconstructs actor, action and nonce from the row", async () => {
    const leader = await newKol("ana");
    const request = await prove(leader, "crear cabal", subjectForTag("ARG"));
    await createCabal(request, { name: "Cabal", color: "a" });

    const [entry] = await query<{ id: string }>("SELECT id FROM audit_log");
    expect(await checkSignature(entry.id)).toEqual({
      ok: true,
      actor: "@ana",
      action: "crear cabal",
      nonce: request.nonce,
    });
  });

  it("stores no address in plaintext beside the signature", async () => {
    const leader = await newKol("ana");
    const request = await prove(leader, "crear cabal", subjectForTag("ARG"));
    await createCabal(request, { name: "Cabal", color: "a" });

    const [row] = await query<{ address_enc: Buffer; address_hmac: Buffer }>(
      "SELECT address_enc, address_hmac FROM audit_signature",
    );
    // SECURITY.md: an address reaches no table in plaintext. Asserted on bytes.
    expect(row.address_enc.toString("utf8")).not.toContain(leader.wallet.address);
    expect(row.address_hmac.toString("utf8")).not.toContain(leader.wallet.address);
  });

  it("refuses to let anything update or delete what it wrote", async () => {
    const leader = await newKol("ana");
    await makeCabal(leader, "ARG");

    // From the application's own connection and role, which is the one that
    // matters: `REVOKE` would not have bound it, because it owns the table.
    await expect(query("UPDATE audit_log SET actor = '@nadie'")).rejects.toThrow(/append-only/);
    await expect(query("DELETE FROM audit_log")).rejects.toThrow(/append-only/);
    // Both together: `audit_signature` has a foreign key into this table, so
    // `TRUNCATE audit_log` alone is refused by the key before the trigger is
    // reached — a different refusal, and not the one being asserted.
    await expect(query("TRUNCATE audit_log, audit_signature")).rejects.toThrow(/append-only/);
    await expect(query("UPDATE audit_signature SET signature = 'x'")).rejects.toThrow(
      /append-only/,
    );
  });
});

/**
 * `docs/round-cabals.md` §5, decided by the owner on 2026-09-05: the leader
 * appoints deputies, **at most two**, and the cap is a constraint rather than a
 * count.
 */
describe("nombrar and revocar co-líder", () => {
  it("names a deputy, who can then answer requests", async () => {
    const leader = await newKol("ana");
    const cabalId = await makeCabal(leader, "ARG");
    const deputy = await newKol("caro");
    await join(deputy, cabalId);

    expect(
      await appointCoLeader(await prove(leader, "nombrar co-líder", subjectForHandle("caro"))),
    ).toEqual({ ok: true, value: { handle: "caro", slot: 1 } });

    // The point of a deputy: `ledCabal(…, "either")` now finds them.
    const applicant = await newKol("beto");
    await requestJoin(await prove(applicant, "pedir entrar al cabal", "ARG"));
    expect(
      await acceptRequest(await prove(deputy, "aceptar solicitud", subjectForHandle("beto"))),
    ).toEqual({ ok: true, value: { handle: "beto" } });
  });

  it("records who named them, which the trail should not have to infer", async () => {
    const leader = await newKol("ana");
    const cabalId = await makeCabal(leader, "ARG");
    const deputy = await newKol("caro");
    await join(deputy, cabalId);
    await appointCoLeader(await prove(leader, "nombrar co-líder", subjectForHandle("caro")));

    const [row] = await query<{ named_by_kol_id: string }>(
      "SELECT named_by_kol_id FROM cabal_co_leader WHERE cabal_id = $1::uuid",
      [cabalId],
    );
    expect(row.named_by_kol_id).toBe(leader.id);
  });

  /** The cap, and the reason it is an index and not arithmetic in a handler. */
  it("takes two and refuses the third", async () => {
    const leader = await newKol("ana");
    const cabalId = await makeCabal(leader, "ARG");
    for (const handle of ["caro", "dani", "eli"]) {
      await join(await newKol(handle), cabalId);
    }

    expect(
      await appointCoLeader(await prove(leader, "nombrar co-líder", subjectForHandle("caro"))),
    ).toEqual({ ok: true, value: { handle: "caro", slot: 1 } });
    expect(
      await appointCoLeader(await prove(leader, "nombrar co-líder", subjectForHandle("dani"))),
    ).toEqual({ ok: true, value: { handle: "dani", slot: 2 } });
    expect(
      await appointCoLeader(await prove(leader, "nombrar co-líder", subjectForHandle("eli"))),
    ).toEqual(refusal("no_slot"));
    expect(await coLeaders(cabalId)).toEqual(["caro", "dani"]);
  });

  it("reuses a freed slot rather than leaving a hole", async () => {
    const leader = await newKol("ana");
    const cabalId = await makeCabal(leader, "ARG");
    for (const handle of ["caro", "dani", "eli"]) {
      await join(await newKol(handle), cabalId);
    }
    await appointCoLeader(await prove(leader, "nombrar co-líder", subjectForHandle("caro")));
    await appointCoLeader(await prove(leader, "nombrar co-líder", subjectForHandle("dani")));

    expect(
      await revokeCoLeader(await prove(leader, "revocar co-líder", subjectForHandle("caro"))),
    ).toEqual({ ok: true, value: { handle: "caro" } });
    // Slot 1 is free again. A handler that only ever counted upwards would
    // refuse here and the cap would quietly have become one.
    expect(
      await appointCoLeader(await prove(leader, "nombrar co-líder", subjectForHandle("eli"))),
    ).toEqual({ ok: true, value: { handle: "eli", slot: 1 } });
  });

  it("leaves a revoked deputy in the cabal", async () => {
    const leader = await newKol("ana");
    const cabalId = await makeCabal(leader, "ARG");
    const deputy = await newKol("caro");
    await join(deputy, cabalId);
    await appointCoLeader(await prove(leader, "nombrar co-líder", subjectForHandle("caro")));
    await revokeCoLeader(await prove(leader, "revocar co-líder", subjectForHandle("caro")));

    // Losing the delegation is not losing the cabal, the same distinction a
    // transfer draws for the leader.
    const [row] = await query<{ cabal_id: string }>(
      "SELECT cabal_id FROM kol WHERE id = $1::uuid",
      [deputy.id],
    );
    expect(row.cabal_id).toBe(cabalId);
  });

  /**
   * A deputy who could name deputies makes the cap a formality — two of them
   * could keep naming each other's replacements — and makes "who delegated this"
   * unanswerable.
   */
  it("refuses a deputy trying to name or revoke one", async () => {
    const leader = await newKol("ana");
    const cabalId = await makeCabal(leader, "ARG");
    const deputy = await newKol("caro");
    const member = await newKol("beto");
    await join(deputy, cabalId);
    await join(member, cabalId);
    await makeCoLeader(deputy, cabalId);

    expect(
      await appointCoLeader(await prove(deputy, "nombrar co-líder", subjectForHandle("beto"))),
    ).toEqual(refusal("not_leader"));
    expect(
      await revokeCoLeader(await prove(deputy, "revocar co-líder", subjectForHandle("caro"))),
    ).toEqual(refusal("not_leader"));
  });

  it("refuses a non-member, the leader themselves, and a second appointment", async () => {
    const leader = await newKol("ana");
    const cabalId = await makeCabal(leader, "ARG");
    const outsider = await newKol("beto");
    const member = await newKol("caro");
    await join(member, cabalId);

    expect(
      await appointCoLeader(await prove(leader, "nombrar co-líder", subjectForHandle("beto"))),
    ).toEqual(refusal("not_a_member"));
    expect(
      await appointCoLeader(await prove(leader, "nombrar co-líder", subjectForHandle("ana"))),
    ).toEqual(refusal("bad_input"));
    await appointCoLeader(await prove(leader, "nombrar co-líder", subjectForHandle("caro")));
    expect(
      await appointCoLeader(await prove(leader, "nombrar co-líder", subjectForHandle("caro"))),
    ).toEqual(refusal("already_co_leader"));
    expect(outsider.handle).toBe("beto");
  });

  it("refuses to revoke somebody who is not a deputy", async () => {
    const leader = await newKol("ana");
    const cabalId = await makeCabal(leader, "ARG");
    const member = await newKol("caro");
    await join(member, cabalId);
    expect(
      await revokeCoLeader(await prove(leader, "revocar co-líder", subjectForHandle("caro"))),
    ).toEqual(refusal("not_a_co_leader"));
  });

  /** The database's own backstop, independent of every handler above. */
  it("refuses a row making the leader their own deputy, at the schema", async () => {
    const leader = await newKol("ana");
    const cabalId = await makeCabal(leader, "ARG");
    await expect(makeCoLeader(leader, cabalId)).rejects.toThrow(/cannot also be its co-leader/);
  });

  it("spends the nonce when the rule refuses", async () => {
    const leader = await newKol("ana");
    await makeCabal(leader, "ARG");
    await newKol("beto");
    const request = await prove(leader, "nombrar co-líder", subjectForHandle("beto"));
    expect(await appointCoLeader(request)).toEqual(refusal("not_a_member"));
    expect(await appointCoLeader(request)).toEqual(refusal("bad_proof"));
  });
});

/**
 * §5's other decision: **the queue is never public.** The leader and the
 * deputies read it; an applicant reads the status of their own and nothing else.
 */
describe("ver solicitudes and ver mi solicitud", () => {
  async function withQueue() {
    const leader = await newKol("ana");
    const cabalId = await makeCabal(leader, "ARG");
    const first = await newKol("beto");
    const second = await newKol("dani");
    await requestJoin(await prove(first, "pedir entrar al cabal", "ARG"));
    await requestJoin(await prove(second, "pedir entrar al cabal", "ARG"));
    return { leader, cabalId, first, second };
  }

  it("gives the leader the queue, oldest first", async () => {
    const { leader } = await withQueue();
    const result = await readRequests(await prove(leader, "ver solicitudes", "ARG"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.tag).toBe("ARG");
    expect(result.value.pending.map((row) => row.handle)).toEqual(["beto", "dani"]);
  });

  it("gives a deputy the same queue", async () => {
    const { leader, cabalId } = await withQueue();
    const deputy = await newKol("caro");
    await join(deputy, cabalId);
    await appointCoLeader(await prove(leader, "nombrar co-líder", subjectForHandle("caro")));

    const result = await readRequests(await prove(deputy, "ver solicitudes", "ARG"));
    expect(result.ok && result.value.pending.map((r) => r.handle)).toEqual(["beto", "dani"]);
  });

  it("refuses an ordinary member, an applicant and a stranger", async () => {
    const { cabalId, first } = await withQueue();
    const member = await newKol("eli");
    await join(member, cabalId);
    const stranger = await newKol("zoe");

    // Never public: being in the cabal is not being able to read who wants in.
    for (const kol of [member, first, stranger]) {
      expect(await readRequests(await prove(kol, "ver solicitudes", "ARG"))).toEqual(
        refusal("not_leader"),
      );
    }
  });

  /**
   * A leader may not read another cabal's queue by naming its tag. The subject
   * is what they signed, so it is compared against the cabal they actually lead
   * rather than used to look one up.
   */
  it("refuses a leader asking about somebody else's cabal", async () => {
    await withQueue();
    const other = await newKol("zoe");
    await makeCabal(other, "MEX");
    expect(await readRequests(await prove(other, "ver solicitudes", "ARG"))).toEqual(
      refusal("not_leader"),
    );
  });

  it("records the count and never the handles", async () => {
    const { leader } = await withQueue();
    await readRequests(await prove(leader, "ver solicitudes", "ARG"));

    const [entry] = await query<{ action: string; after: { pending: number } }>(
      "SELECT action, after FROM audit_log WHERE action = 'ver solicitudes'",
    );
    expect(entry.after).toEqual({ pending: 2 });
    // Listing who had asked would republish, inside `audit_log`, the thing this
    // read exists to keep narrow.
    const [raw] = await query<{ dump: string }>(
      "SELECT after::text AS dump FROM audit_log WHERE action = 'ver solicitudes'",
    );
    expect(raw.dump).not.toContain("beto");
  });

  it("tells an applicant the status of their own, and only that", async () => {
    const { leader, first } = await withQueue();

    const pending = await readOwnRequest(await prove(first, "ver mi solicitud", "ARG"));
    expect(pending.ok && pending.value).toEqual({
      tag: "ARG",
      status: "pending",
      decidedAt: null,
    });

    await rejectRequest(await prove(leader, "rechazar solicitud", subjectForHandle("beto")));
    const decided = await readOwnRequest(await prove(first, "ver mi solicitud", "ARG"));
    expect(decided.ok && decided.value.status).toBe("rejected");
    expect(decided.ok && decided.value.decidedAt).not.toBeNull();
  });

  it("answers the same for a cabal that does not exist and one never asked", async () => {
    await withQueue();
    const stranger = await newKol("zoe");
    // Telling them apart would let anybody enumerate cabals.
    expect(await readOwnRequest(await prove(stranger, "ver mi solicitud", "ARG"))).toEqual(
      refusal("not_found"),
    );
    expect(await readOwnRequest(await prove(stranger, "ver mi solicitud", "ZZZ"))).toEqual(
      refusal("not_found"),
    );
  });

  it("writes no audit entry for an applicant reading their own row", async () => {
    const { first } = await withQueue();
    await readOwnRequest(await prove(first, "ver mi solicitud", "ARG"));
    expect(
      await query("SELECT id FROM audit_log WHERE action = 'ver mi solicitud'"),
    ).toHaveLength(0);
  });
});

/**
 * The eleventh action, and the one that **removed** an unsigned write rather
 * than adding a signed one.
 *
 * `docs/round-reasignacion.md`: the operator used to hand an orphaned cabal over
 * directly, the only cabal mutation no party signed. Now they nominate, and the
 * nominee claims it here — so the beneficiary's own signature is what moves the
 * group.
 */
describe("reclamar cabal", () => {
  /** An orphan whose leader cannot sign, plus a nominated heir. */
  async function orphanWithNomination(handle = "beto") {
    const gone = await newKol("ana");
    const cabalId = await makeCabal(gone, "ARG");
    // Every wallet withdrawn: the leader can no longer pass the gate.
    await query("UPDATE kol_wallet SET status = 'withdrawn' WHERE kol_id = $1::uuid", [gone.id]);
    const heir = await newKol(handle);
    const nomination = crypto.randomUUID();
    await query(
      `INSERT INTO cabal_nomination (id, cabal_id, kol_id, reason, expires_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'El líder perdió la wallet.',
               now() + interval '7 days')`,
      [nomination, cabalId, heir.id],
    );
    return { gone, cabalId, heir, nomination };
  }

  it("moves the cabal, dates it, and closes the nomination", async () => {
    const { cabalId, heir } = await orphanWithNomination();

    const result = await claimCabal(await prove(heir, "reclamar cabal", "ARG"));
    expect(result.ok && result.value.tag).toBe("ARG");

    const [cabal] = await query<{
      leader_kol_id: string;
      reassigned_to_kol_id: string;
      reassigned_at: Date | null;
    }>(
      `SELECT leader_kol_id, reassigned_to_kol_id, reassigned_at
         FROM cabal WHERE id = $1::uuid`,
      [cabalId],
    );
    expect(cabal.leader_kol_id).toBe(heir.id);
    // Kept separately from the leader, so a later transfer cannot rewrite who
    // the public notice says claimed it.
    expect(cabal.reassigned_to_kol_id).toBe(heir.id);
    expect(cabal.reassigned_at).not.toBeNull();

    const [nomination] = await query<{ status: string; claimed_at: Date | null }>(
      "SELECT status, claimed_at FROM cabal_nomination",
    );
    expect(nomination.status).toBe("claimed");
    expect(nomination.claimed_at).not.toBeNull();
  });

  /** The whole point: this entry has a signature, which the direct version never could. */
  it("carries a signature that reconstructs the actor, action and nonce", async () => {
    const { heir } = await orphanWithNomination();
    const request = await prove(heir, "reclamar cabal", "ARG");
    await claimCabal(request);

    const [entry] = await query<{ id: string }>(
      "SELECT id FROM audit_log WHERE action = 'reclamar cabal'",
    );
    expect(await checkSignature(entry.id)).toEqual({
      ok: true,
      actor: "@beto",
      action: "reclamar cabal",
      nonce: request.nonce,
    });
    expect(await verifyAuditChain()).toEqual([]);
  });

  /** Negative: a proof issued for a different action. */
  it("refuses a claim carrying a nonce for another action", async () => {
    const { heir } = await orphanWithNomination();
    const issued = await issueNonce(heir.wallet.address, CHAIN, "pedir entrar al cabal", "ARG");
    const request = await prove(heir, "reclamar cabal", "ARG", {
      nonce: issued.nonce,
      expiresAt: issued.expiresAt,
    });
    expect(await claimCabal(request)).toEqual(refusal("bad_proof"));
    const [cabal] = await query<{ reassigned_at: Date | null }>(
      "SELECT reassigned_at FROM cabal WHERE tag = 'ARG'",
    );
    expect(cabal.reassigned_at).toBeNull();
  });

  /** Negative: the seven days ran out. */
  it("refuses an expired nomination and frees the slot", async () => {
    const { heir } = await orphanWithNomination();
    await query("UPDATE cabal_nomination SET expires_at = now() - interval '1 hour'");

    expect(await claimCabal(await prove(heir, "reclamar cabal", "ARG"))).toEqual(
      refusal("expired"),
    );
    const [row] = await query<{ status: string }>("SELECT status FROM cabal_nomination");
    // Cancelled on the way out, so the admin can nominate again without first
    // clearing it by hand.
    expect(row.status).toBe("cancelled");
  });

  /** Negative: claiming twice. */
  it("refuses a second claim", async () => {
    const { heir } = await orphanWithNomination();
    expect((await claimCabal(await prove(heir, "reclamar cabal", "ARG"))).ok).toBe(true);
    // The first claim closed the nomination, so there is no pending offer left:
    // the same answer as never having been nominated.
    expect(await claimCabal(await prove(heir, "reclamar cabal", "ARG"))).toEqual(
      refusal("not_found"),
    );
    expect(await query("SELECT id FROM cabal_nomination WHERE status = 'claimed'")).toHaveLength(1);
  });

  /** Negative: somebody else's nomination, and no nomination at all. */
  it("refuses a KOL the nomination does not name", async () => {
    await orphanWithNomination();
    const stranger = await newKol("zoe");
    // Same answer as no nomination, so nobody can probe who was offered a cabal.
    expect(await claimCabal(await prove(stranger, "reclamar cabal", "ARG"))).toEqual(
      refusal("not_found"),
    );
  });

  /**
   * Seven days is long enough for the cabal to heal itself. A repair applied to
   * something that is no longer broken is a seizure.
   */
  it("refuses when the cabal stopped being an orphan in the meantime", async () => {
    const { gone, cabalId, heir } = await orphanWithNomination();
    // The old leader registers a wallet again.
    await query("UPDATE kol_wallet SET status = 'active' WHERE kol_id = $1::uuid", [gone.id]);

    expect(await claimCabal(await prove(heir, "reclamar cabal", "ARG"))).toEqual(
      refusal("not_orphaned"),
    );
    const [cabal] = await query<{ leader_kol_id: string }>(
      "SELECT leader_kol_id FROM cabal WHERE id = $1::uuid",
      [cabalId],
    );
    expect(cabal.leader_kol_id).toBe(gone.id);
  });

  it("spends the nonce when the rule refuses", async () => {
    const { heir } = await orphanWithNomination();
    await query("UPDATE cabal_nomination SET expires_at = now() - interval '1 hour'");
    const request = await prove(heir, "reclamar cabal", "ARG");
    expect(await claimCabal(request)).toEqual(refusal("expired"));
    expect(await claimCabal(request)).toEqual(refusal("bad_proof"));
  });
});
