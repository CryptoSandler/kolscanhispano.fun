import { ed25519 } from "@noble/curves/ed25519.js";
import bs58 from "bs58";
import { beforeEach, describe, expect, it } from "vitest";
import { aadFor, blindIndex, encrypt } from "@/lib/crypto";
import { query } from "@/lib/db";
import { resetAuditLog } from "@/lib/fixtures/audit";
import { issueNonce } from "@/lib/wallet-proof-store";
import { PROOF_DOMAIN, proofMessage, type ProofAction } from "@/lib/wallet-proof";
import { POST } from "./route";

/**
 * **The refusals that must be indistinguishable, compared as bytes.**
 *
 * `SECURITY.md`: the four ways a proof can be wrong — never issued, wrong
 * wallet, wrong action, wrong subject — all answer `bad_proof`, because telling
 * them apart lets a caller map which wallet holds which nonce and which subject
 * has a proof outstanding.
 *
 * Asserting that in the library would prove the strings match. This asserts it
 * where an attacker actually stands: **the HTTP response**, status line and body
 * bytes together. A refusal that leaked the difference through a status code, a
 * key order or a stray field would pass a library test and fail here.
 */

const CHAIN = "solana" as const;

function wallet() {
  const secret = ed25519.utils.randomSecretKey();
  return {
    address: bs58.encode(ed25519.getPublicKey(secret)),
    sign: (m: string) => bs58.encode(ed25519.sign(new TextEncoder().encode(m), secret)),
  };
}

async function approvedKol(handle: string) {
  const id = crypto.randomUUID();
  const w = wallet();
  await query(
    `INSERT INTO kol (id, slug, display_name, x_handle, status, approved_at)
     VALUES ($1::uuid, $2, $2, $3::citext, 'approved', now())`,
    [id, handle, handle],
  );
  await query(
    `INSERT INTO kol_wallet (id, kol_id, chain, address_hmac, address_enc, status)
     VALUES (gen_random_uuid(), $1::uuid, 'solana', $2, $3, 'active')`,
    [id, blindIndex(w.address, "address"), encrypt(w.address, aadFor("kol_wallet", "address", id))],
  );
  return { id, handle, wallet: w };
}

function body(fields: {
  address: string;
  chain: typeof CHAIN;
  action: ProofAction;
  subject?: string;
  nonce: string;
  expiresAt: string;
  signature: string;
}) {
  return JSON.stringify({
    action: fields.action,
    // `crear cabal` validates its own input before touching the proof — a
    // caller's malformed request is their own business and leaks nothing — so
    // these have to be well-formed for the payload to reach the gate at all.
    // Finding that out is half of why this test exercises the route.
    name: "Cabal",
    color: "a",
    address: fields.address,
    chain: fields.chain,
    signature: fields.signature,
    nonce: fields.nonce,
    expiresAt: fields.expiresAt,
    subject: fields.subject,
  });
}

function post(payload: string) {
  return POST(
    new Request("https://kolscanhispano.fun/api/cabal", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.9" },
      body: payload,
    }),
  );
}

/** Status plus body bytes: the whole of what a caller can observe. */
async function observable(response: Response) {
  return `${response.status}\n${Buffer.from(await response.arrayBuffer()).toString("hex")}`;
}

beforeEach(async () => {
  await query("TRUNCATE wallet_proof_nonce, rate_limit");
  await query("UPDATE kol SET cabal_id = NULL");
  await query("TRUNCATE cabal_request, cabal_co_leader, cabal_nomination");
  await query("TRUNCATE kol, kol_wallet, cabal CASCADE");
  await resetAuditLog();
});

describe("the four ways a proof can be wrong are one response", () => {
  it("returns byte-identical answers for all four, and for a bad signature", async () => {
    const leader = await approvedKol("ana");
    const other = await approvedKol("beto");
    const subject = "ARG";

    /** A real proof, then the four ways to spoil it without spoiling the shape. */
    const good = await issueNonce(leader.wallet.address, CHAIN, "crear cabal", subject);
    const sign = (over: Partial<Parameters<typeof body>[0]>, w = leader.wallet) => {
      const fields = {
        domain: PROOF_DOMAIN,
        address: w.address,
        chain: CHAIN,
        action: "crear cabal" as ProofAction,
        subject,
        nonce: good.nonce,
        expiresAt: good.expiresAt,
        ...over,
      };
      return body({ ...fields, signature: w.sign(proofMessage(fields)) });
    };

    // 1. A nonce nobody issued.
    const neverIssued = sign({ nonce: "f".repeat(32) });
    // 2. A real nonce presented by another wallet.
    const wrongWallet = sign({ address: other.wallet.address }, other.wallet);
    // 3. A nonce issued for a different action.
    const forOther = await issueNonce(
      leader.wallet.address,
      CHAIN,
      "pedir entrar al cabal",
      subject,
    );
    const wrongAction = sign({ nonce: forOther.nonce, expiresAt: forOther.expiresAt });
    // 4. A nonce issued for a different subject.
    const forMex = await issueNonce(leader.wallet.address, CHAIN, "crear cabal", "MEX");
    const wrongSubject = sign({ nonce: forMex.nonce, expiresAt: forMex.expiresAt });
    // 5. Not a signature at all.
    const badSignature = JSON.parse(sign({})) as Record<string, unknown>;
    badSignature.signature = bs58.encode(Buffer.alloc(64, 7));

    const answers = await Promise.all(
      [neverIssued, wrongWallet, wrongAction, wrongSubject, JSON.stringify(badSignature)].map(
        async (payload) => observable(await post(payload)),
      ),
    );

    // Every one of the five, the same bytes. Not "all refused" — identical.
    expect(new Set(answers).size, `distinct answers: ${JSON.stringify(answers)}`).toBe(1);
    // And it is the refusal it should be, not an accidental agreement on 500.
    expect(answers[0].startsWith("401\n")).toBe(true);
    expect(Buffer.from(answers[0].split("\n")[1], "hex").toString("utf8")).toBe(
      '{"error":"bad_proof"}',
    );
  });

  /**
   * The other pair that must not be told apart: a handle nobody holds, and one
   * that exists but never asked. A leader who could tell them apart could
   * enumerate the roster.
   */
  it("answers the same for an unknown handle and one with no request", async () => {
    const leader = await approvedKol("ana");
    await approvedKol("beto");
    const [cabalId] = [crypto.randomUUID()];
    await query(
      `INSERT INTO cabal (id, tag, name, leader_kol_id, created_by)
       VALUES ($1::uuid, 'ARG', 'ARG', $2::uuid, 'leader')`,
      [cabalId, leader.id],
    );
    await query("UPDATE kol SET cabal_id = $1::uuid WHERE id = $2::uuid", [cabalId, leader.id]);

    const answers = [];
    for (const handle of ["@beto", "@nadie"]) {
      const issued = await issueNonce(
        leader.wallet.address,
        CHAIN,
        "aceptar solicitud",
        handle,
      );
      const fields = {
        domain: PROOF_DOMAIN,
        address: leader.wallet.address,
        chain: CHAIN,
        action: "aceptar solicitud" as ProofAction,
        subject: handle,
        nonce: issued.nonce,
        expiresAt: issued.expiresAt,
      };
      answers.push(
        await observable(
          await post(body({ ...fields, signature: leader.wallet.sign(proofMessage(fields)) })),
        ),
      );
    }
    expect(new Set(answers).size).toBe(1);
    expect(answers[0].startsWith("404\n")).toBe(true);
  });

  it("never puts an address, a signature or a nonce in any refusal", async () => {
    const leader = await approvedKol("ana");
    const issued = await issueNonce(leader.wallet.address, CHAIN, "crear cabal", "ZZZ");
    const fields = {
      domain: PROOF_DOMAIN,
      address: leader.wallet.address,
      chain: CHAIN,
      action: "pedir entrar al cabal" as ProofAction,
      subject: "ZZZ",
      nonce: issued.nonce,
      expiresAt: issued.expiresAt,
    };
    const payload = body({ ...fields, signature: leader.wallet.sign(proofMessage(fields)) });
    const text = await (await post(payload)).text();

    // SECURITY.md, asserted on the wire rather than on the handler's return.
    expect(text).not.toContain(leader.wallet.address);
    expect(text).not.toContain(issued.nonce);
    expect(text.length).toBeLessThan(64);
  });
});
