import { activeChains, isChain } from "@/lib/chain";
import { audit, isAdmin } from "@/lib/admin";
import { query } from "@/lib/db";
import { createKol, type WalletInput } from "@/lib/roster";
import { normalizeXHandle } from "@/lib/x-handle";

export const runtime = "nodejs";

/**
 * `POST /api/admin/kol` — put a KOL on the roster, approved.
 *
 * Spec §9's approval queue is not built; this is the one mutation it needs to
 * exist at all, and `docs/padron.md` §4 says plainly what is left unbuilt
 * rather than implying a fuller admin than there is.
 *
 * **The gate is checked before the body is read.** An unauthenticated caller
 * gets `401` without this route parsing a byte of what they sent, so the
 * parser is not reachable surface and the failure cannot depend on the shape of
 * an attacker's payload.
 */
const MAX_BODY_BYTES = 64 * 1024;

type Payload = {
  handle?: unknown;
  displayName?: unknown;
  wallets?: unknown;
  status?: unknown;
};

/**
 * The two states this route may create, and why `approved` stays the default.
 *
 * `docs/padron.md` §4 built this route as "create an approved KOL": the admin
 * types a handle they are vouching for, and vouching is what the button means.
 * That stays the default so the screen and every existing caller behave as they
 * did.
 *
 * **`pending` exists for a different act: staging a candidate for review.** A
 * roster assembled from a public tracker is a list of people who have not asked
 * to be here and whom nobody has vouched for yet, and creating those as
 * `approved` would publish them on the strength of a third party's attribution.
 * `kol.status` already has both values in its `CHECK`, `roster.ts` already takes
 * either, and `approveKol` is already the one thing that moves a row between
 * them — this route was the only place pinning the choice shut.
 *
 * A pending KOL is on no public surface: `address-invariant.test.ts` proves it,
 * and `status = 'approved'` gates the feed, the ranking and the detail.
 */
const CREATABLE = ["approved", "pending"] as const;

/**
 * Reason codes, never prose, and never the value that failed.
 *
 * A message naming the address would put one in a browser's network tab, a
 * proxy log and whatever the operator pasted it into — the places
 * `SECURITY.md` spends the rest of the system keeping addresses out of.
 */
function refuse(reason: string, status = 400): Response {
  return Response.json({ error: reason }, { status });
}

/**
 * `GET /api/admin/kol` — the approval queue, and enough to decide from.
 *
 * Pending first and newest first, because that is the working order. It carries
 * **no address**: the decision an admin makes here is about a handle and a
 * tweet, and the wallet is a count -- spec §9's reveal path is a different
 * operation that audits itself, and this list is not it.
 */
export async function GET(request: Request): Promise<Response> {
  if (!isAdmin(request.headers.get("authorization"))) {
    return refuse("unauthorized", 401);
  }

  const rows = await query<{
    id: string;
    slug: string;
    x_handle: string;
    status: string;
    tweet_url: string | null;
    tweet_verified_at: Date | null;
    created_at: Date;
    wallets: number;
    public_wallets: number;
  }>(
    `SELECT k.id, k.slug, k.x_handle, k.status, k.tweet_url, k.tweet_verified_at, k.created_at,
            (SELECT count(*)::int FROM kol_wallet w
              WHERE w.kol_id = k.id AND w.status = 'active') AS wallets,
            (SELECT count(*)::int FROM kol_wallet w
              WHERE w.kol_id = k.id AND w.status = 'active' AND w.is_public) AS public_wallets
       FROM kol k
      ORDER BY (k.status = 'pending') DESC, k.created_at DESC
      LIMIT 100`,
  );

  return Response.json({
    kols: rows.map((row) => ({
      id: row.id,
      slug: row.slug,
      handle: row.x_handle,
      status: row.status,
      tweetUrl: row.tweet_url,
      tweetVerified: row.tweet_verified_at !== null,
      wallets: row.wallets,
      publicWallets: row.public_wallets,
    })),
  });
}

export async function POST(request: Request): Promise<Response> {
  if (!isAdmin(request.headers.get("authorization"))) {
    return refuse("unauthorized", 401);
  }

  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return refuse("body_too_large", 413);

  let payload: Payload;
  try {
    const text = await request.text();
    if (text.length > MAX_BODY_BYTES) return refuse("body_too_large", 413);
    payload = JSON.parse(text) as Payload;
  } catch {
    return refuse("bad_json");
  }

  // The handle goes through the same normaliser the modal uses, so `@ejemplo`,
  // `ejemplo` and a pasted profile URL land on one stored value — which is what
  // makes `x_handle`'s UNIQUE constraint able to fire at all.
  const handle = typeof payload.handle === "string" ? normalizeXHandle(payload.handle) : null;
  if (handle === null) return refuse("bad_handle");

  if (!Array.isArray(payload.wallets) || payload.wallets.length === 0) {
    return refuse("no_wallets");
  }

  // Absent means `approved`, which is what the admin screen sends and what this
  // route has always done. Anything present and not one of the two is refused
  // rather than coerced: a typo that silently became `approved` would publish
  // somebody the caller meant to stage.
  const status = payload.status === undefined ? "approved" : payload.status;
  if (typeof status !== "string" || !(CREATABLE as readonly string[]).includes(status)) {
    return refuse("bad_status");
  }

  const wallets: WalletInput[] = [];
  for (const entry of payload.wallets) {
    if (typeof entry !== "object" || entry === null) return refuse("bad_wallet");
    const { address, chain, isPublic } = entry as Record<string, unknown>;
    if (typeof address !== "string") return refuse("bad_wallet");
    // `isChain` before `isChainActive`: an unknown name and an inactive chain
    // are different mistakes, and telling them apart is the difference between
    // "you typed it wrong" and "we do not index that yet".
    if (typeof chain !== "string" || !isChain(chain)) return refuse("bad_chain");
    if (isPublic !== undefined && typeof isPublic !== "boolean") return refuse("bad_wallet");
    wallets.push({ address, chain, isPublic: isPublic === true });
  }

  const created = await createKol({
    handle,
    displayName: typeof payload.displayName === "string" ? payload.displayName : undefined,
    wallets,
    status: status as (typeof CREATABLE)[number],
  });

  if (!created.ok) {
    // `chain_not_active` carries the list, because it is the one refusal the
    // caller can act on immediately and the list is not a secret.
    if (created.reason === "chain_not_active") {
      return Response.json({ error: created.reason, active: activeChains() }, { status: 400 });
    }
    return refuse(created.reason, created.reason === "address_taken" ? 409 : 400);
  }

  // Spec §9: every mutation in `audit_log`. Counts and ids only -- no address
  // reaches `after`, which is the easiest place in this system to persist one
  // by accident.
  await audit({
    actor: "admin",
    action: "kol.create",
    targetType: "kol",
    targetId: created.kolId,
    after: {
      handle,
      status,
      wallets: created.wallets.map((w) => ({ chain: w.chain, isPublic: w.isPublic })),
    },
    request,
  });

  return Response.json(
    {
      kolId: created.kolId,
      handle,
      status,
      wallets: created.wallets.map((w) => ({ id: w.id, chain: w.chain, isPublic: w.isPublic })),
    },
    { status: 201 },
  );
}
