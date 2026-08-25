import { timingSafeEqual } from "node:crypto";
import { storeRawTxBatch, type RawTxInput } from "@/lib/raw-tx";
import { hitLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";

function authorized(header: string | null): boolean {
  const expected = process.env.HELIUS_WEBHOOK_SECRET;
  if (!expected || !header) return false;
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Authenticate, store, return. Helius allows one second for the whole
 * delivery, retries three times a second apart, and then drops it
 * permanently — so nothing is parsed here, the whole batch is stored in one
 * round trip (see `storeRawTxBatch`), and a malformed event never sinks the
 * rest of the batch.
 *
 * The rate limiter runs only on the failed-authentication path. It exists to
 * blunt an unauthenticated flood; the shared secret already gates real
 * traffic, so an authenticated Helius delivery must never receive a 429 — a
 * non-403 4xx triggers Helius's retry-then-permanently-drop behavior just
 * like any other failure, and this project's plan sends no alert for it.
 */
export async function POST(request: Request): Promise<Response> {
  if (!authorized(request.headers.get("authorization"))) {
    const ip = request.headers.get("x-forwarded-for")?.split(",")[0].trim() ?? "unknown";
    if (await hitLimit(ip, "helius-webhook", 600, 60)) {
      return new Response("rate limited", { status: 429 });
    }
    return new Response("unauthorized", { status: 401 });
  }

  let events: Array<{ signature: string; slot?: number; timestamp?: number }>;
  try {
    const body = await request.json();
    events = Array.isArray(body) ? body : [body];
  } catch {
    return new Response("bad request", { status: 400 });
  }

  const inputs: RawTxInput[] = [];
  for (const event of events) {
    if (!event?.signature) continue;
    inputs.push({
      signature: event.signature,
      slot: event.slot ?? null,
      blockTime: new Date((event.timestamp ?? Math.floor(Date.now() / 1000)) * 1000),
      payload: event,
      source: "webhook",
    });
  }

  if (inputs.length > 0) {
    await storeRawTxBatch(inputs);
  }

  return new Response("ok", { status: 200 });
}
