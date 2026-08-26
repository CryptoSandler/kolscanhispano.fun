import { feedEtag, readFeed, type FeedCursor } from "@/lib/feed";

export const runtime = "nodejs";
// Every response depends on the cursor and on rows written seconds ago; there
// is nothing here to prerender.
export const dynamic = "force-dynamic";

// `<iso instant>,<uuid>`. The instant is whatever `Date.parse` accepts, which
// is what the client echoes back from `blockTime`; the id half is pinned to
// the UUID shape so a malformed cursor is refused here rather than reaching
// Postgres as a cast error.
const CURSOR_PATTERN =
  /^(.+),([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

function parseCursor(raw: string): FeedCursor | null {
  const match = CURSOR_PATTERN.exec(raw);
  if (!match) return null;
  const blockTime = new Date(match[1]);
  if (Number.isNaN(blockTime.getTime())) return null;
  return { blockTime, id: match[2] };
}

/**
 * Spec §10: polling, no WebSockets. The client sends the newest
 * `(block_time, id)` it holds as `since` and its last `ETag` as
 * `If-None-Match`; a quiet feed answers `304` with no body.
 *
 * The client tracks the `ETag` itself rather than leaning on the browser's
 * HTTP cache, because `next.config.ts` marks every `/api/*` response
 * `no-store` — a shared cache must never hold one of these — and `no-store`
 * means the browser has nothing to revalidate from. Carrying the validator in
 * application state is what keeps the `304` while that header stays right.
 *
 * A malformed cursor is a `400`, not a silently ignored parameter: answering
 * a bad cursor with the newest 50 trades would look like a working poll while
 * quietly replaying the whole page on every request.
 */
export async function GET(request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const raw = params.get("since");

  let since: FeedCursor | null = null;
  if (raw !== null) {
    since = parseCursor(raw);
    // Never echo the parameter back: it reaches logs and error pages, and the
    // shape of what a caller sent is not information this endpoint owes them.
    if (since === null) return new Response("bad request", { status: 400 });
  }

  const trades = await readFeed(since);
  const etag = feedEtag(trades);

  if (request.headers.get("if-none-match") === etag) {
    return new Response(null, { status: 304, headers: { ETag: etag } });
  }

  return new Response(JSON.stringify({ trades }), {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8", ETag: etag },
  });
}
