import { timingSafeEqual } from "node:crypto";
import { after } from "next/server";
import { withLock } from "@/lib/lock";
import { parsePending } from "@/lib/parse-swap";
import { storeRawTxBatch, type RawTxInput } from "@/lib/raw-tx";
import { clientIp, hitLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";

/**
 * The response is sent inside Helius's one-second budget; this is the ceiling
 * on the drain that runs **after** it, and it has to be a ceiling the platform
 * will actually give us.
 *
 * A drain that is killed mid-way costs nothing: `parsePending` marks each row
 * as it finishes it, so partial progress persists, and `withLock` holds its
 * advisory lock on a dedicated connection that the platform closes when it
 * kills the function — which releases the lock. The next delivery, or the
 * cron, picks up where this stopped.
 */
export const maxDuration = 60;

/**
 * How many rows one delivery drains.
 *
 * Measured 2026-08-31: ~1.8 s a row in CI and ~3.7 s locally. Ten is a batch
 * that fits comfortably inside {@link maxDuration} at either rate, and ingest
 * on 2026-09-02 ran 30–60 rows an hour — so a delivery that drains ten keeps
 * the queue at zero on any ordinary hour, and a burst is absorbed by the next
 * delivery rather than by one long function.
 */
const DELIVERY_DRAIN_BATCH = 10;

function authorized(header: string | null): boolean {
  const expected = process.env.HELIUS_WEBHOOK_SECRET;
  if (!expected || !header) return false;
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * A ceiling on one delivery, in bytes.
 *
 * Measured 2026-08-28 over the 2,397 real Helius payloads in
 * `fixtures/helius`: the largest single event is 39,371 bytes, and a Helius
 * webhook delivers at most 100 events, so the worst realistic delivery is
 * under 4 MB. 8 MiB is twice that, deliberately: refusing a real delivery
 * costs more than accepting a large one, because a 413 is a non-403 4xx and
 * Helius retries three times and then drops the delivery permanently.
 *
 * Only a secret-holder ever reaches the read, since authentication is checked
 * first. So this bounds an accident and a leaked secret, not the anonymous
 * internet — which is why it is generous rather than tight.
 */
const MAX_BODY_BYTES = 8 * 1024 * 1024;

/**
 * The request body as text, or `null` when it is over {@link MAX_BODY_BYTES}.
 *
 * `content-length` is only the cheap refusal: it is a claim the caller makes,
 * and a caller sending `transfer-encoding: chunked` makes no claim at all. The
 * counted read below is the actual bound — it stops at the ceiling rather than
 * buffering whatever arrives and measuring it afterwards, which is the whole
 * difference between a limit and a report.
 *
 * ponytail: `await request.text()` and a length check would be two lines, and
 * it would have already buffered the thing it is meant to refuse.
 */
async function readBody(request: Request): Promise<string | null> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return null;

  const body = request.body;
  if (!body) return "";

  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    bytes += chunk.byteLength;
    if (bytes > MAX_BODY_BYTES) {
      await body.cancel().catch(() => {});
      return null;
    }
    text += decoder.decode(chunk, { stream: true });
  }
  return text + decoder.decode();
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
 *
 * **What the limiter's key is and is not.** `clientIp` reads the first hop of
 * `x-forwarded-for`, which is the client only if something in front of this
 * handler sets that header rather than passing the caller's through. Whether
 * Vercel does was *not* measured for this change — measuring it needs a
 * deployment answering from Vercel's edge, and the constraint on this batch is
 * that nothing touches production or preview. So treat the key as a counter,
 * not as an identity: a caller willing to vary the header occupies a fresh
 * bucket per request and is not slowed by this. See the S2 report; the durable
 * answer is a platform rule (Vercel's firewall), not a database write.
 */
export async function POST(request: Request): Promise<Response> {
  if (!authorized(request.headers.get("authorization"))) {
    if (await hitLimit(clientIp(request), "helius-webhook", 600, 60)) {
      return new Response("rate limited", { status: 429 });
    }
    return new Response("unauthorized", { status: 401 });
  }

  const raw = await readBody(request);
  if (raw === null) return new Response("payload too large", { status: 413 });

  let events: Array<{ signature: string; slot?: number; timestamp?: number }>;
  try {
    const body: unknown = JSON.parse(raw);
    // A delivery is an array of events or one event. Anything else is a body
    // shape this handler has never been able to read, and saying so is the
    // point: probed on 20040c7, `null`, `7` and `"hello"` all returned 200,
    // because `Array.isArray(body) ? body : [body]` wraps whatever it is
    // handed and the loop below then finds no `.signature` on it and skips. An
    // envelope change at Helius, or a proxy rewriting the payload, was
    // therefore indistinguishable from a quiet hour.
    //
    // `[]` and `[{}]` stay 200 on purpose: an array *is* the delivery shape,
    // and an empty one is a real thing Helius can send. What is rejected is a
    // body that could not be a delivery at all.
    if (Array.isArray(body)) {
      events = body;
    } else if (typeof body === "object" && body !== null) {
      events = [body as { signature: string }];
    } else {
      return new Response("bad request", { status: 400 });
    }
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
    drainAfterResponse();
  }

  return new Response("ok", { status: 200 });
}

/**
 * Parses a small batch **after** this response has been sent.
 *
 * `docs/operations.md`: the trade→row latency was hours, because the parse cron
 * is scheduled every five minutes and GitHub actually ran it about every three
 * hours (13:36, 09:04, 04:37, 00:09 on 2026-09-02). For a live tracker the
 * expectation is minutes, and the delivery itself is the only event that
 * happens at the right moment.
 *
 * **It cannot run before the response.** Spec §5.1: Helius allows one second
 * end to end and retries three times before losing the event permanently, so
 * anything on the request path is a dropped trade. `after` is Next's own
 * primitive for exactly this — the response is finished, then the callback
 * runs, inside the route's `maxDuration`.
 *
 * **The lock is the cron's, not a new one.** A delivery that arrives while the
 * cron is parsing, or while another delivery is, finds the lock held and does
 * nothing — which is the correct answer, because the holder is already draining
 * the same queue. The cron stays exactly as it is and becomes the net: it
 * catches whatever a killed function, a quiet hour or a Helius outage left.
 *
 * Nothing here can fail the delivery. It runs after the `200`, and every error
 * is swallowed into a log line without a payload in it.
 */
function drainAfterResponse(): void {
  try {
    after(async () => {
      try {
        const parsed = await withLock("parse-pending", () => parsePending(DELIVERY_DRAIN_BATCH));
        if (parsed === null) return; // another run holds it; it is draining the same queue
        if (parsed > 0) console.log(`webhook drain: parsed ${parsed} row(s)`);
      } catch {
        // Never the thrown message: it can carry a payload fragment.
        console.warn("webhook drain: failed");
      }
    });
  } catch {
    // `after` throws outside a request scope — a unit test calling `POST`
    // directly, for instance. The delivery is already stored and the cron is
    // the net, so this is a no-op rather than a failure.
  }
}
