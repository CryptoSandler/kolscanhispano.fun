import { verifyAlchemySignature } from "@/lib/alchemy-webhook";
import { decodeSwap, type SwapLog } from "@/lib/bnb-swap";

export const runtime = "nodejs";

/**
 * `POST /api/webhooks/alchemy` — BNB Address Activity deliveries.
 *
 * **The signature is checked against the raw body, before anything is parsed.**
 * `request.text()` once, verify, then parse that same string: a verifier that
 * parsed first and re-serialised would compute the HMAC over a different byte
 * sequence — key order and whitespace both change — and would fail on correct
 * deliveries, which is the kind of failure somebody fixes by weakening the
 * check.
 *
 * A bad or missing signature answers **401 and reads no further**. There is no
 * body-shape error to distinguish it from, because the body has not been looked
 * at yet.
 *
 * The swap decoding is `bnb-swap.ts`: pool-level, attributed to `topics[2]`,
 * never by router allowlist — `docs/multichain.md` §4 has the measurement that
 * forced that rule.
 */
export async function POST(request: Request): Promise<Response> {
  const raw = await request.text();

  if (
    !verifyAlchemySignature(
      raw,
      request.headers.get("x-alchemy-signature"),
      process.env.ALCHEMY_WEBHOOK_SECRET,
    )
  ) {
    // One word, and no hint about which half was wrong.
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  let payload: { event?: { data?: { block?: { logs?: SwapLog[] } } } };
  try {
    payload = JSON.parse(raw) as typeof payload;
  } catch {
    return Response.json({ error: "bad_json" }, { status: 400 });
  }

  const logs = payload.event?.data?.block?.logs ?? [];
  // Decoded here and counted; persisting them is the ingestion half, which
  // waits on the webhook actually being registered — see
  // `scripts/sync-bnb-webhook.mts`. A delivery that decodes to nothing is a
  // delivery we accepted and had no use for, which is not an error.
  const swaps = logs.map(decodeSwap).filter((swap) => swap !== null);

  return Response.json({ received: logs.length, decoded: swaps.length }, { status: 200 });
}
