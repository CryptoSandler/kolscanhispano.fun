import { canonicalAddress, isChain, isChainActive } from "@/lib/chain";
import { isCabalAction, subjectFor } from "@/lib/cabal-actions";
import { rateLimited } from "@/lib/rate-limit";
import { issueNonce } from "@/lib/wallet-proof-store";

export const runtime = "nodejs";

/**
 * `POST /api/cabal/nonce` — a nonce to sign for one cabal action, bound to one
 * address **and one subject**.
 *
 * The subject is normalised **here**, by the same `subjectFor` the handler
 * calls, and stored on the row. That is what makes a signature un-redirectable:
 * the server never asks the client what the target was, it compares
 * (`migrations/017`). A subject built twice, in two places, is a subject that
 * eventually differs by a `@`.
 *
 * A subject that cannot be a target at all is refused before a row exists —
 * otherwise a typo leaves a nonce nobody can ever spend.
 */
export async function POST(request: Request): Promise<Response> {
  const limited = await rateLimited(request, "cabal-nonce");
  if (limited) return limited;

  let body: { address?: unknown; chain?: unknown; action?: unknown; subject?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ error: "bad_json" }, { status: 400 });
  }

  if (!isCabalAction(body.action)) return Response.json({ error: "bad_action" }, { status: 400 });
  if (typeof body.chain !== "string" || !isChain(body.chain)) {
    return Response.json({ error: "bad_chain" }, { status: 400 });
  }
  if (!isChainActive(body.chain)) {
    return Response.json({ error: "chain_not_active" }, { status: 400 });
  }
  if (typeof body.address !== "string" || typeof body.subject !== "string") {
    return Response.json({ error: "bad_request" }, { status: 400 });
  }

  const subject = subjectFor(body.action, body.subject);
  if (subject === null) return Response.json({ error: "bad_subject" }, { status: 400 });

  let canonical: string;
  try {
    canonical = canonicalAddress(body.address, body.chain);
  } catch {
    return Response.json({ error: "bad_address" }, { status: 400 });
  }

  const issued = await issueNonce(canonical, body.chain, body.action, subject);
  // The action and the subject come back so the client builds exactly the text
  // the server will rebuild. `verifyProof` rebuilds and never parses, so a
  // client that got this wrong simply fails to verify -- it cannot smuggle a
  // different sentence past it.
  return Response.json({ ...issued, action: body.action, subject }, { status: 201 });
}
