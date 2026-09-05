import { canonicalAddress, isChain, type Chain } from "@/lib/chain";
import { rateLimited } from "@/lib/rate-limit";
import { withdrawWallet } from "@/lib/wallet-actions";

export const runtime = "nodejs";

/**
 * `POST /api/wallet/retirar` — a KOL withdraws the wallet they sign with.
 *
 * **There is no admin equivalent, deliberately.** `migrations/023`: the orphan
 * condition the cabal-reassignment path repairs used to be a value only the
 * operator could write, which made it one they could manufacture. This is the
 * only route in the product that writes it, and `wallet-actions.test.ts` fails
 * if a second writer appears anywhere in tracked source.
 */
export async function POST(request: Request): Promise<Response> {
  const limited = await rateLimited(request, "cabal-action");
  if (limited) return limited;

  let body: { address?: unknown; chain?: unknown; signature?: unknown; nonce?: unknown;
              expiresAt?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ error: "bad_json" }, { status: 400 });
  }
  if (typeof body.chain !== "string" || !isChain(body.chain)) {
    return Response.json({ error: "bad_chain" }, { status: 400 });
  }
  if (typeof body.address !== "string" || typeof body.signature !== "string") {
    return Response.json({ error: "bad_request" }, { status: 400 });
  }
  if (typeof body.nonce !== "string" || typeof body.expiresAt !== "string") {
    return Response.json({ error: "bad_request" }, { status: 400 });
  }

  let canonical: string;
  try {
    canonical = canonicalAddress(body.address, body.chain as Chain);
  } catch {
    return Response.json({ error: "bad_address" }, { status: 400 });
  }

  const result = await withdrawWallet({
    address: canonical,
    chain: body.chain as Chain,
    signature: body.signature,
    nonce: body.nonce,
    expiresAt: body.expiresAt,
    // No subject: the wallet that signs is the wallet withdrawn.
  });

  return result.ok
    ? Response.json(result.value, { status: 200 })
    : Response.json({ error: result.reason }, { status: result.reason === "bad_proof" ? 401 : 400 });
}
