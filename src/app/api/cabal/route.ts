import { canonicalAddress, isChain, type Chain } from "@/lib/chain";
import {
  acceptRequest,
  appointCoLeader,
  claimCabal,
  dissolveCabal,
  createCabal,
  expel,
  isCabalAction,
  readOwnRequest,
  readRequests,
  rejectRequest,
  requestJoin,
  revokeCoLeader,
  transfer,
  type ActionRefusal,
  type ActionResult,
  type CabalAction,
  type SignedRequest,
} from "@/lib/cabal-actions";
import { rateLimited } from "@/lib/rate-limit";

export const runtime = "nodejs";

const MAX_BODY_BYTES = 8 * 1024;

/**
 * `POST /api/cabal` — the six signed actions, behind one door.
 *
 * **One route rather than six.** They take the same payload — a proof and a
 * subject — differ only in which handler reads it, and share every guard worth
 * having: the size cap, the rate limit, the shape check and the refusal
 * mapping. Six routes would be six copies of that, and the fifth copy is where
 * a guard goes missing.
 *
 * **There is no session.** `docs/round-cabals.md` §4: authority is proved per
 * request over a nonce this server issued. Nothing here reads a cookie, so
 * there is no CSRF surface and no logout to get wrong.
 *
 * The refusals come back as words, not sentences, and the four ways a proof can
 * be wrong are one word (`SECURITY.md`). The status codes are a translation of
 * that vocabulary and add nothing to it — in particular `bad_proof` and
 * `unknown_wallet` are both `401`, so the status alone tells a caller no more
 * than the body does.
 */
const STATUS: Record<ActionRefusal, number> = {
  bad_proof: 401,
  unknown_wallet: 401,
  not_leader: 403,
  cannot_expel_leader: 403,
  not_found: 404,
  already_in_cabal: 409,
  already_requested: 409,
  expired: 410,
  already_dissolved: 409,
  not_orphaned: 409,
  already_co_leader: 409,
  no_slot: 409,
  not_a_co_leader: 409,
  not_a_member: 409,
  tag_taken: 409,
  bad_input: 400,
};

function refuse(reason: string, status = 400): Response {
  return Response.json({ error: reason }, { status });
}

export async function POST(request: Request): Promise<Response> {
  const limited = await rateLimited(request, "cabal-action");
  if (limited) return limited;

  let body: Record<string, unknown>;
  try {
    const text = await request.text();
    if (text.length > MAX_BODY_BYTES) return refuse("body_too_large", 413);
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return refuse("bad_json");
  }

  if (!isCabalAction(body.action)) return refuse("bad_action");
  if (typeof body.chain !== "string" || !isChain(body.chain)) return refuse("bad_chain");

  const { address, signature, nonce, expiresAt, subject } = body;
  if (typeof address !== "string" || typeof signature !== "string") return refuse("bad_request");
  if (typeof nonce !== "string" || typeof expiresAt !== "string") return refuse("bad_request");
  if (typeof subject !== "string") return refuse("bad_request");

  let canonical: string;
  try {
    canonical = canonicalAddress(address, body.chain as Chain);
  } catch {
    return refuse("bad_address");
  }

  const proof: SignedRequest = {
    address: canonical,
    chain: body.chain as Chain,
    signature,
    nonce,
    expiresAt,
    subject,
  };

  // A table, not a chain of ternaries. Ten actions is where the conditional
  // stopped being readable, and a lookup also makes "every action has exactly
  // one handler" something the type checker states rather than something a
  // reader counts.
  //
  // `crear cabal` is the only one carrying anything besides the proof, and the
  // tag is **not** among it: the tag is the subject, so there is no second
  // field a caller could sign one value in and claim another with.
  const handlers: Record<CabalAction, () => Promise<ActionResult<unknown>>> = {
    "crear cabal": () =>
      createCabal(proof, {
        name: typeof body.name === "string" ? body.name : "",
        color: typeof body.color === "string" ? body.color : "",
        xHandle: typeof body.xHandle === "string" ? body.xHandle : undefined,
      }),
    "pedir entrar al cabal": () => requestJoin(proof),
    "aceptar solicitud": () => acceptRequest(proof),
    "rechazar solicitud": () => rejectRequest(proof),
    "expulsar del cabal": () => expel(proof),
    "transferir el cabal": () => transfer(proof),
    "nombrar co-líder": () => appointCoLeader(proof),
    "revocar co-líder": () => revokeCoLeader(proof),
    "ver solicitudes": () => readRequests(proof),
    "ver mi solicitud": () => readOwnRequest(proof),
    "reclamar cabal": () => claimCabal(proof),
    "disolver cabal": () => dissolveCabal(proof),
  };

  const result = await handlers[body.action]();

  return result.ok
    ? Response.json(result.value, { status: 200 })
    : refuse(result.reason, STATUS[result.reason]);
}
