import { query } from "@/lib/db";
import { rateLimited } from "@/lib/rate-limit";
import { verifyTweet } from "@/lib/tweet";

export const runtime = "nodejs";

/**
 * `POST /api/registro/tweet` — the handle's half of the proof.
 *
 * The wallet proves control of an address; this proves control of the X
 * account, which is the other half and the one the roster is actually named
 * after. `docs/padron.md` §1 has why it reads X's own oEmbed rather than the
 * tweet page or a third-party mirror.
 *
 * **A verified tweet is not an approval.** `DECISIONES.md`, 2026-08-31 keeps a
 * KOL off every public surface until an admin approves them, and this route
 * writes `tweet_verified_at` and nothing else. Collapsing the two would make a
 * successful HTTP call into a publication decision.
 */
export async function POST(request: Request): Promise<Response> {
  const limited = await rateLimited(request, "registro-tweet");
  if (limited) return limited;

  let body: { kolId?: unknown; url?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ error: "bad_json" }, { status: 400 });
  }
  if (typeof body.kolId !== "string" || typeof body.url !== "string") {
    return Response.json({ error: "bad_request" }, { status: 400 });
  }
  // A UUID, checked before it reaches Postgres: `kol.id` is one, and an
  // arbitrary string would be a cast error rather than a "no such KOL".
  if (!/^[0-9a-f-]{36}$/i.test(body.kolId)) {
    return Response.json({ error: "not_pending" }, { status: 404 });
  }

  const [kol] = await query<{ x_handle: string; verification_code: string | null }>(
    `SELECT x_handle, verification_code FROM kol
      WHERE id = $1::uuid AND status = 'pending' AND verification_code IS NOT NULL`,
    [body.kolId],
  );
  // One answer for "no such KOL", "already approved" and "created by the admin
  // with no code": none of them is information this route owes an anonymous
  // caller, and telling them apart would enumerate the pending queue.
  if (!kol) return Response.json({ error: "not_pending" }, { status: 404 });

  const checked = await verifyTweet({
    url: body.url,
    expectedHandle: kol.x_handle,
    code: kol.verification_code!,
  });
  if (!checked.ok) return Response.json({ error: checked.reason }, { status: 400 });

  await query(
    "UPDATE kol SET tweet_url = $2, tweet_verified_at = now() WHERE id = $1::uuid",
    [body.kolId, checked.tweetUrl],
  );

  return Response.json({
    status: "pending",
    tweetVerified: true,
    // Said plainly, because the person has just done the last thing they can do
    // and the screen has to explain why nothing appears yet.
    message: "Tu tweet quedó verificado. Un administrador tiene que aprobarte para que aparezcas en la clasificación.",
  });
}
