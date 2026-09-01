import { isChain, isChainActive } from "@/lib/chain";
import { canonicalAddress } from "@/lib/chain";
import { rateLimited } from "@/lib/rate-limit";
import { issueNonce } from "@/lib/wallet-proof-store";
import type { ProofAction } from "@/lib/wallet-proof";

export const runtime = "nodejs";

const ACTIONS: ProofAction[] = ["alta de perfil", "agregar wallet"];

/**
 * `POST /api/registro/nonce` — a nonce to sign, bound to one address.
 *
 * The nonce is issued **here** rather than chosen by the client, which is the
 * one place this design is deliberately stricter than the implementation it was
 * modelled on (`docs/wallet-proof.md` §1). A client-chosen nonce lets a
 * captured message-and-signature pair be replayed inside its window.
 *
 * The address is validated for its chain before a row is written, so a typo
 * does not leave a nonce nobody can ever spend.
 */
export async function POST(request: Request): Promise<Response> {
  const limited = await rateLimited(request, "registro-nonce");
  if (limited) return limited;

  let body: { address?: unknown; chain?: unknown; action?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ error: "bad_json" }, { status: 400 });
  }

  if (typeof body.chain !== "string" || !isChain(body.chain)) {
    return Response.json({ error: "bad_chain" }, { status: 400 });
  }
  if (!isChainActive(body.chain)) {
    return Response.json({ error: "chain_not_active" }, { status: 400 });
  }
  if (typeof body.address !== "string") {
    return Response.json({ error: "bad_address" }, { status: 400 });
  }
  const action = ACTIONS.find((a) => a === body.action) ?? "alta de perfil";

  let canonical: string;
  try {
    canonical = canonicalAddress(body.address, body.chain);
  } catch {
    return Response.json({ error: "bad_address" }, { status: 400 });
  }

  const issued = await issueNonce(canonical, body.chain, action);
  // The domain and the action come back too, so the client builds the exact
  // message the server will rebuild rather than keeping its own copy of the
  // format -- `verifyProof` rebuilds and never parses, so a client that got
  // this wrong would simply fail to verify.
  return Response.json({ ...issued, action }, { status: 201 });
}
