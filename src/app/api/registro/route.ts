import { randomBytes } from "node:crypto";
import { isChain, type Chain } from "@/lib/chain";
import { query } from "@/lib/db";
import { rateLimited } from "@/lib/rate-limit";
import { createKol, type WalletInput } from "@/lib/roster";
import { PROOF_DOMAIN, verifyProof, type ProofFields } from "@/lib/wallet-proof";
import { consumeNonce } from "@/lib/wallet-proof-store";
import { normalizeXHandle } from "@/lib/x-handle";
import { canonicalAddress } from "@/lib/chain";

export const runtime = "nodejs";

const MAX_BODY_BYTES = 32 * 1024;
const ACTION = "alta de perfil" as const;

/**
 * `POST /api/registro` — one submit, carrying a proof per wallet.
 *
 * **There is no session, deliberately.** Proving wallets across several
 * requests would need somewhere to remember which ones were proven — a cookie
 * or a `claim` table — and `docs/padron.md` §2 already argues against building
 * a second roster table. Each wallet carries its own signature in the one
 * request that creates the KOL, so "which wallets are proven" is never a
 * question anything has to store an answer to.
 *
 * **Nonces are consumed before the KOL is created, and are not returned on
 * failure.** A submit that fails after burning them costs the person a fresh
 * round of signatures; the alternative — creating the KOL first and burning
 * after — would admit a KOL on a nonce somebody else could still spend.
 */
type WalletProof = {
  address?: unknown;
  chain?: unknown;
  isPublic?: unknown;
  signature?: unknown;
  nonce?: unknown;
  expiresAt?: unknown;
};

function refuse(reason: string, status = 400): Response {
  return Response.json({ error: reason }, { status });
}

/** `KH-` and eight of Crockford's alphabet: no `I`, `L`, `O` or `U`. */
function verificationCode(): string {
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  const bytes = randomBytes(8);
  return `KH-${[...bytes].map((b) => alphabet[b % alphabet.length]).join("")}`;
}

export async function POST(request: Request): Promise<Response> {
  const limited = await rateLimited(request, "registro");
  if (limited) return limited;

  let payload: { handle?: unknown; wallets?: unknown };
  try {
    const text = await request.text();
    if (text.length > MAX_BODY_BYTES) return refuse("body_too_large", 413);
    payload = JSON.parse(text) as typeof payload;
  } catch {
    return refuse("bad_json");
  }

  const handle = typeof payload.handle === "string" ? normalizeXHandle(payload.handle) : null;
  if (handle === null) return refuse("bad_handle");
  if (!Array.isArray(payload.wallets) || payload.wallets.length === 0) return refuse("no_wallets");

  // Shape first, so nothing is consumed for a request that cannot succeed.
  const proofs: { fields: ProofFields; signature: string; isPublic: boolean }[] = [];
  for (const entry of payload.wallets as WalletProof[]) {
    if (typeof entry !== "object" || entry === null) return refuse("bad_wallet");
    const { address, chain, signature, nonce, expiresAt, isPublic } = entry;
    if (typeof chain !== "string" || !isChain(chain)) return refuse("bad_chain");
    if (typeof address !== "string" || typeof signature !== "string") return refuse("bad_wallet");
    if (typeof nonce !== "string" || typeof expiresAt !== "string") return refuse("bad_wallet");
    if (isPublic !== undefined && typeof isPublic !== "boolean") return refuse("bad_wallet");

    let canonical: string;
    try {
      canonical = canonicalAddress(address, chain as Chain);
    } catch {
      return refuse("bad_address");
    }
    proofs.push({
      fields: {
        domain: PROOF_DOMAIN,
        address: canonical,
        chain: chain as Chain,
        action: ACTION,
        nonce,
        expiresAt,
      },
      signature,
      isPublic: isPublic === true,
    });
  }

  // The signature is checked before the nonce is burnt: a bad signature should
  // not cost the person their nonce, and the nonce is what stops the *replay*
  // of a good one.
  const now = Date.now();
  for (const proof of proofs) {
    const verified = verifyProof({
      signature: proof.signature,
      fields: proof.fields,
      expected: {
        domain: PROOF_DOMAIN,
        chain: proof.fields.chain,
        action: ACTION,
        nonce: proof.fields.nonce,
      },
      nowMs: now,
    });
    if (!verified.ok) return refuse(`proof_${verified.reason}`, 400);
  }

  for (const proof of proofs) {
    const claim = await consumeNonce(
      proof.fields.nonce,
      proof.fields.address,
      proof.fields.chain,
      ACTION,
    );
    if (!claim.ok) return refuse(`nonce_${claim.reason}`, 400);
  }

  const wallets: WalletInput[] = proofs.map((p) => ({
    address: p.fields.address,
    chain: p.fields.chain,
    isPublic: p.isPublic,
  }));

  const created = await createKol({ handle, wallets, status: "pending" });
  if (!created.ok) return refuse(created.reason, created.reason === "address_taken" ? 409 : 400);

  const code = verificationCode();
  await query("UPDATE kol SET verification_code = $2 WHERE id = $1", [created.kolId, code]);

  // The code is returned once, here. It is not secret -- it goes in a public
  // tweet -- but it identifies this registration, so it is not put anywhere a
  // later GET could hand it to somebody else.
  return Response.json(
    {
      kolId: created.kolId,
      handle,
      status: "pending",
      verificationCode: code,
      wallets: created.wallets.map((w) => ({ id: w.id, chain: w.chain, isPublic: w.isPublic })),
    },
    { status: 201 },
  );
}
