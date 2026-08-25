import { timingSafeEqual } from "node:crypto";
import { storeRawTx } from "@/lib/raw-tx";
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
 * Authenticate, store, return. Helius allows one second, retries three times a
 * second apart, and then drops the event permanently — so nothing is parsed
 * here. The parser reads raw_tx afterwards.
 */
export async function POST(request: Request): Promise<Response> {
  if (!authorized(request.headers.get("authorization"))) {
    return new Response("unauthorized", { status: 401 });
  }

  const ip = request.headers.get("x-forwarded-for")?.split(",")[0].trim() ?? "unknown";
  if (await hitLimit(ip, "helius-webhook", 600, 60)) {
    return new Response("rate limited", { status: 429 });
  }

  let events: Array<{ signature: string; slot?: number; timestamp?: number }>;
  try {
    const body = await request.json();
    events = Array.isArray(body) ? body : [body];
  } catch {
    return new Response("bad request", { status: 400 });
  }

  for (const event of events) {
    if (!event?.signature) continue;
    await storeRawTx({
      signature: event.signature,
      slot: event.slot ?? null,
      blockTime: new Date((event.timestamp ?? Math.floor(Date.now() / 1000)) * 1000),
      payload: event,
      source: "webhook",
    });
  }

  return new Response("ok", { status: 200 });
}
