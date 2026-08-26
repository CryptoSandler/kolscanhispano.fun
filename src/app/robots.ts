import type { MetadataRoute } from "next";

/**
 * The whole site is closed to crawlers until launch.
 *
 * This is one of three locks that have to be lifted together, because each
 * covers what the others miss:
 *
 * - this file, which a crawler reads *before* fetching anything;
 * - `robots` in the root layout's `metadata` (`layout.tsx`), the `<meta>` tag
 *   that governs a page already fetched — a URL linked from elsewhere gets
 *   crawled regardless of what robots.txt says, and only the tag keeps it out
 *   of an index;
 * - `X-Robots-Tag` in `next.config.ts`, which is the same instruction for
 *   responses that have no `<head>` to put a tag in (the API routes, JSON,
 *   anything not HTML).
 *
 * `Disallow: /` is deliberately blunt: there is no page here that should be
 * indexed yet, and a partial rule would be a claim about which ones are ready.
 * Removing it is a manual, deliberate act — see the note in `layout.tsx`.
 */
export default function robots(): MetadataRoute.Robots {
  return { rules: { userAgent: "*", disallow: "/" } };
}
