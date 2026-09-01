/**
 * Reading a tweet well enough to believe it.
 *
 * `docs/padron.md` §1 has the measurement this rests on, and it overruled the
 * obvious design: **an unauthenticated fetch of `x.com/<handle>/status/<id>`
 * returns a 164KB application shell** with neither the tweet text nor the `og:`
 * tags that used to make this trivial. A check built on that fetch either
 * always fails or — the likelier bug — gets written as *"pass when the fetch
 * succeeds"*, which approves everybody.
 *
 * `publish.twitter.com/oembed` is X's own endpoint, needs no credentials, and
 * returns the author and the text. A third-party mirror also returns them and
 * is the wrong answer: asked *who wrote this tweet*, it becomes the root of
 * trust for who owns a handle, and identity is the one question not to
 * outsource.
 *
 * **The handle comes from `author_url`, never `author_name`.** `author_name` is
 * the display name: user-settable, not unique, and two accounts can share one.
 * An impostor who set their display name to their target's would pass a check
 * that compared it, which is the cheapest attack this flow has and the reason
 * that comparison is a named mutation in the round.
 */

import { normalizeXHandle } from "./x-handle";

/** X's own oEmbed endpoint. First-party, unauthenticated, documented. */
const OEMBED = "https://publish.twitter.com/oembed";

/**
 * How long the whole check may take.
 *
 * A registration request is waiting on this, and an endpoint that hangs turns
 * into a request that hangs. Short, and a timeout is a refusal like any other.
 */
const TIMEOUT_MS = 8_000;

/** The most bytes an oEmbed response may be before it is refused unread. */
const MAX_BYTES = 64 * 1024;

/** `https://x.com/<handle>/status/<id>`, on either domain, with or without `www.`. */
const STATUS_URL =
  /^https?:\/\/(?:www\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})\/status(?:es)?\/(\d{1,25})(?:[/?#].*)?$/;

export type TweetRefusal =
  | "bad_url"
  | "unreachable"
  | "not_found"
  | "wrong_author"
  | "code_missing";

export type TweetCheck =
  | { ok: true; handle: string; tweetUrl: string }
  | { ok: false; reason: TweetRefusal };

/** The canonical form of a status URL, and the handle its path claims. */
export function parseStatusUrl(input: string): { handle: string; id: string } | null {
  const match = STATUS_URL.exec(input.trim());
  if (!match) return null;
  return { handle: match[1], id: match[2] };
}

/**
 * Strips the HTML oEmbed returns down to its text.
 *
 * The tweet body arrives inside a `<blockquote>` as escaped HTML. The code
 * being looked for is `[A-Z0-9]`, so this only has to be good enough not to
 * hide it: tags are removed and the five XML entities are decoded. It is
 * deliberately not a parser — nothing here is rendered, and the result is only
 * ever searched for a known string.
 */
export function tweetText(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

type OEmbed = { author_url?: unknown; html?: unknown };

/**
 * Whether `url` is a tweet by `expectedHandle` containing `code`.
 *
 * **Every failure is a refusal.** A protected account, a deleted tweet, a rate
 * limit, a timeout and a malformed body all answer "not verified". The single
 * bug this function can have is being written so that an unreachable oEmbed
 * means "fine", so the shape below has no path that returns `ok: true` without
 * having read both the author and the text.
 *
 * `fetchImpl` is injected so the tests can state each of those failures without
 * touching the network — the suite's guard throws on any real `fetch`, which is
 * what makes that non-negotiable rather than a convenience.
 */
export async function verifyTweet(options: {
  url: string;
  expectedHandle: string;
  code: string;
  fetchImpl?: typeof fetch;
}): Promise<TweetCheck> {
  const parsed = parseStatusUrl(options.url);
  if (!parsed) return { ok: false, reason: "bad_url" };

  // The path's handle is checked first, so an obviously-someone-else's link is
  // refused without spending a request. It is *not* the check that decides:
  // a URL is whatever the caller typed, and `author_url` below is X's answer.
  if (parsed.handle.toLowerCase() !== options.expectedHandle.toLowerCase()) {
    return { ok: false, reason: "wrong_author" };
  }

  const canonical = `https://x.com/${parsed.handle}/status/${parsed.id}`;
  const endpoint = `${OEMBED}?url=${encodeURIComponent(canonical)}&omit_script=1`;

  let body: OEmbed;
  try {
    const response = await (options.fetchImpl ?? fetch)(endpoint, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: "follow",
    });
    // 404 is X saying the tweet is not publicly readable -- deleted, or a
    // protected account. Told apart from a network failure because they mean
    // different things to the person waiting.
    if (response.status === 404) return { ok: false, reason: "not_found" };
    if (!response.ok) return { ok: false, reason: "unreachable" };

    const text = await response.text();
    if (text.length > MAX_BYTES) return { ok: false, reason: "unreachable" };
    body = JSON.parse(text) as OEmbed;
  } catch {
    // Never the caught error: it can carry the URL, and this path is reached
    // by anyone who can submit a link.
    return { ok: false, reason: "unreachable" };
  }

  if (typeof body.author_url !== "string" || typeof body.html !== "string") {
    return { ok: false, reason: "unreachable" };
  }

  // The author, from `author_url` and through the same normaliser everything
  // else in this system reads a handle with -- so `https://x.com/Ejemplo` and
  // the stored `ejemplo` are one account.
  const author = normalizeXHandle(body.author_url);
  if (author === null) return { ok: false, reason: "unreachable" };
  if (author.toLowerCase() !== options.expectedHandle.toLowerCase()) {
    return { ok: false, reason: "wrong_author" };
  }

  if (!tweetText(body.html).includes(options.code)) {
    return { ok: false, reason: "code_missing" };
  }

  return { ok: true, handle: author, tweetUrl: canonical };
}
