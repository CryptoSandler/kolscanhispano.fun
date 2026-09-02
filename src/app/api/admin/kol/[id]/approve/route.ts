import { audit, isAdmin } from "@/lib/admin";
import { syncWebhookAfterRosterChange } from "@/lib/helius-webhook";
import { query } from "@/lib/db";
import { approveKol } from "@/lib/roster";

export const runtime = "nodejs";

/**
 * `POST /api/admin/kol/<id>/approve` — the gate `DECISIONES.md` promises.
 *
 * A registration leaves a KOL `pending` and on no public surface. This is the
 * only thing that moves them, and it is a person's decision: the tweet check is
 * evidence the admin looks at, never the approval itself.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  if (!isAdmin(request.headers.get("authorization"))) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const { id } = await context.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    return Response.json({ error: "not_pending" }, { status: 404 });
  }

  const [before] = await query<{ status: string; tweet_verified_at: Date | null }>(
    "SELECT status, tweet_verified_at FROM kol WHERE id = $1::uuid",
    [id],
  );
  if (!before || before.status !== "pending") {
    return Response.json({ error: "not_pending" }, { status: 404 });
  }

  const approved = await approveKol(id);
  if (!approved) return Response.json({ error: "not_pending" }, { status: 404 });

  // Spec §9: before and after. The tweet's verification state is in `before`
  // because it is the thing that makes an approval reviewable afterwards --
  // approving an unverified handle is allowed, and the trail should say so.
  await audit({
    actor: "admin",
    action: "kol.approve",
    targetType: "kol",
    targetId: id,
    before: { status: before.status, tweetVerified: before.tweet_verified_at !== null },
    after: { status: "approved" },
    request,
  });

  /*
    Spec §5.4: approving changes the desired address set, so the webhook is
    reconciled here. It runs **after** the audit and cannot fail this response —
    the approval already happened, and a Helius outage must not report it as
    refused. A sync that could not run leaves the stored hash alone, so the next
    one repairs the difference.

    Awaited rather than floated: this route runs on `nodejs`, and a promise left
    dangling at the end of a serverless invocation is a promise that may never
    resolve. One HTTP call is worth the wait; an approval that silently did not
    reach Helius is the defect this whole module exists for.
  */
  await syncWebhookAfterRosterChange("kol.approve");

  return Response.json({ kolId: id, status: "approved" });
}
