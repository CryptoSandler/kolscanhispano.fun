/**
 * Spec §6.3: the avatar is derived from the verified X handle via
 * `unavatar.io/x/<handle>`, **fetched by us, cached, and keyed by `kol_id`** —
 * so the public URL leaks nothing (spec §7) and the browser never talks to a
 * third party.
 *
 * `docs/references.md` §5 records this as the second place the genre collides
 * with our spec, and the spec wins: kolscanbrasil.io hotlinks `pbs.twimg.com`,
 * so X sees every visitor's request and a broken upstream is a broken row;
 * kolscan.io serves `cdn.kolscan.io/profiles/<wallet>.png` and leaks the address
 * in an image URL no API response ever mentions. Same visual result here, with
 * no third party in the page's request path and no address anywhere in the URL.
 *
 * ## Everything that can go wrong resolves to the monogram
 *
 * A KOL with no handle, an upstream 404, an upstream timeout, a body that is not
 * an image, a body that is implausibly large: all of them return
 * {@link monogramSvg}. The route never answers a page with a failure it could
 * paint instead, because a broken-image glyph in a 22px box is worse than a
 * letter and moves nothing on the row either way.
 *
 * ## The fetch is injectable
 *
 * `fetchImpl` defaults to the global, and `vitest.env.ts` replaces that global
 * with one that throws naming the host. So a test that forgets to inject fails
 * loudly instead of quietly spending someone else's rate limit — the same
 * pattern, and the same reason, as `prices.ts`.
 */
import { query } from "./db";
import { monogramSvg } from "./monogram";

/** unavatar's X provider. Spec §8.5: it is given a handle and never an address. */
const UNAVATAR = "https://unavatar.io/x/";

/**
 * How long we wait on the upstream before drawing the letter instead.
 *
 * Short on purpose: this request is in the critical path of a paint that has
 * already happened, and a row holding an empty circle for ten seconds is worse
 * than a row that settles on a monogram in two.
 */
const UPSTREAM_TIMEOUT_MS = 2_500;

/**
 * A ceiling on what we will relay. An avatar is a 22px circle; anything past
 * half a megabyte is not one, and streaming an unbounded third-party body
 * through a serverless function is how a cheap route becomes an expensive one.
 */
const MAX_BYTES = 512 * 1024;

/**
 * The image types we will pass through. An allowlist rather than "anything
 * starting with `image/`": `image/svg+xml` is a script-bearing document, and
 * relaying one from a third party under our own origin is a stored-XSS
 * primitive the moment anything renders it outside an `<img>`. Our *own*
 * monogram is SVG and never goes through this check.
 */
const RELAYABLE = new Set(["image/png", "image/jpeg", "image/webp", "image/gif", "image/avif"]);

export type AvatarImage = {
  body: Uint8Array | string;
  contentType: string;
  /** Which branch produced it. The route turns this into a cache lifetime. */
  source: "override" | "unavatar" | "monogram";
};

/** UUIDs only. Anything else never reaches Postgres, which would throw `22P02` on it. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type KolRow = { display_name: string; x_handle: string; avatar_override_url: string | null };

/**
 * The image for one `kol_id`, or `null` if there is no such KOL on a public
 * surface.
 *
 * `status = 'approved'` is spec §9's public-surface filter, applied here for the
 * same reason `feed.ts` and `leaderboard.ts` apply it in their queries: a
 * suspended KOL disappears from every public surface, and an avatar endpoint
 * that still served their picture would be a public surface that did not.
 */
export async function readAvatar(
  kolId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<AvatarImage | null> {
  if (!UUID.test(kolId)) return null;

  const rows = await query<KolRow>(
    "SELECT display_name, x_handle, avatar_override_url FROM kol WHERE id = $1 AND status = 'approved'",
    [kolId],
  );
  const kol = rows[0];
  if (!kol) return null;

  const monogram: AvatarImage = {
    body: monogramSvg(kol.display_name),
    contentType: "image/svg+xml; charset=utf-8",
    source: "monogram",
  };

  const upstream = upstreamFor(kol);
  if (!upstream) return monogram;

  const fetched = await fetchImage(upstream.url, fetchImpl);
  return fetched ? { ...fetched, source: upstream.source } : monogram;
}

/**
 * Where the image comes from, or `null` for "nowhere, draw the letter".
 *
 * `avatar_override_url` is the admin escape hatch spec §6.3 describes for when
 * the derived image is wrong or missing. It is admin-set, not user-set, and it
 * is still validated: `https:` only. That does not make it SSRF-proof — a
 * hostname resolving to a private address would still be fetched — but it keeps
 * `file:`, `data:` and plaintext `http:` out with one check, and an override
 * that fails validation falls back to the handle rather than failing the row.
 */
function upstreamFor(kol: KolRow): { url: string; source: "override" | "unavatar" } | null {
  const override = kol.avatar_override_url?.trim();
  if (override) {
    let parsed: URL | null = null;
    try {
      parsed = new URL(override);
    } catch {
      parsed = null;
    }
    if (parsed?.protocol === "https:") return { url: parsed.toString(), source: "override" };
    console.warn("readAvatar: ignoring an avatar_override_url that is not an https URL");
  }

  const handle = kol.x_handle.trim();
  if (!handle) return null;

  // `fallback=false` makes unavatar answer 404 rather than serving its own
  // generic silhouette. We would rather draw our own letter than relay someone
  // else's placeholder: the monogram is the same in both cases, and this way a
  // KOL whose handle has no picture is indistinguishable from one whose handle
  // has none *yet*, instead of being frozen behind a third party's default.
  return { url: `${UNAVATAR}${encodeURIComponent(handle)}?fallback=false`, source: "unavatar" };
}

/**
 * One upstream request, bounded in time and in size, returning `null` on every
 * failure rather than throwing.
 *
 * Nothing about a failure is logged beyond its shape. A `fetch` rejection's
 * message can carry the full URL, and an override URL is admin-supplied data we
 * have no reason to copy into a log line.
 */
async function fetchImage(
  url: string,
  fetchImpl: typeof fetch,
): Promise<{ body: Uint8Array; contentType: string } | null> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      redirect: "follow",
    });
  } catch {
    console.warn("readAvatar: the upstream request failed or timed out");
    return null;
  }

  if (!response.ok) return null;

  const contentType = (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (!RELAYABLE.has(contentType)) {
    console.warn("readAvatar: the upstream body was not a relayable image type");
    return null;
  }

  // Checked before reading and again after: `content-length` is a claim, and a
  // chunked response has none at all.
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BYTES) return null;

  let body: Uint8Array;
  try {
    body = new Uint8Array(await response.arrayBuffer());
  } catch {
    return null;
  }
  if (body.byteLength === 0 || body.byteLength > MAX_BYTES) return null;

  return { body, contentType };
}
