import type { NextConfig } from "next";

/**
 * Security headers.
 *
 * There were none at all before this, which the audit flagged as a deploy
 * blocker: the site has no policy bounding what a page could reach, so any
 * future injection had nothing standing between it and an attacker's server.
 *
 * Written for Vercel, where `headers()` is applied at the edge to every matching
 * response.
 */

const CSP = [
  "default-src 'self'",

  // Next injects inline bootstrap scripts and, in development, uses eval for
  // hot reload. 'unsafe-inline' here is a real weakening and the honest reason
  // is that removing it needs per-request nonces, which is its own change; it
  // is recorded in DECISIONES rather than hidden behind a comment saying it is
  // fine.
  process.env.NODE_ENV === "development"
    ? "script-src 'self' 'unsafe-inline' 'unsafe-eval'"
    : "script-src 'self' 'unsafe-inline'",

  // Tailwind and next/font emit inline styles.
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",

  // No external image host is in use yet. Tighten or extend this allowlist
  // when one is added rather than widening it to a wildcard.
  "img-src 'self' data:",

  // The browser talks to us; any Solana RPC or third-party API is called from
  // the server, so it does not belong here.
  "connect-src 'self'",

  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "upgrade-insecure-requests",
].join("; ");

const SECURITY_HEADERS = [
  { key: "Content-Security-Policy", value: CSP },

  // Two years, subdomains included, preload-eligible. Safe here because the site
  // is https-only in production; a deployment that still serves plain HTTP
  // should not set this.
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains; preload",
  },

  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },

  // Outbound clicks already send no referrer explicitly; this is the floor for
  // everything else.
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },

  // Nothing here needs a camera, a microphone, a location or a payment handler.
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()",
  },

  { key: "X-DNS-Prefetch-Control", value: "off" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },

  // Closed to search engines until launch. The `<meta name="robots">` tag in
  // `src/app/layout.tsx` covers HTML pages; this covers every response that has
  // no <head> to carry a tag — the API routes, and any file served from the
  // build output. The `NO_STORE_AND_NOINDEX` entries below already set this for
  // the admin and the API routes, and the avatar path carries its own copy, so
  // all of them keep it once this line is removed. That is the point of leaving
  // it duplicated rather than folding it in here: those must stay noindex
  // forever, and this one is temporary.
  //
  // **Removing this is a three-file change** — this entry, `metadata.robots` in
  // `src/app/layout.tsx`, and `src/app/robots.ts`. All three, or none.
  { key: "X-Robots-Tag", value: "noindex, nofollow" },
];

/**
 * What the admin console and the API routes (bar one) must carry: never held
 * by a shared cache, never indexed. The `X-Robots-Tag` here is the permanent
 * one; the entry of the same name in `SECURITY_HEADERS` is temporary and says
 * so.
 */
const NO_STORE_AND_NOINDEX = [
  { key: "Cache-Control", value: "no-store, no-cache, must-revalidate, private" },
  { key: "X-Robots-Tag", value: "noindex, nofollow" },
];

const nextConfig: NextConfig = {
  poweredByHeader: false,

  // `next dev` otherwise appends a block about this Next version to the
  // repository's CLAUDE.md and re-appends it on every run, so a tracked,
  // hand-written instructions file is edited by a build tool and the working
  // tree is dirty before anyone has typed anything. The guidance it adds is
  // real — read `node_modules/next/dist/docs/` for this version's APIs — but
  // it belongs in a file a person owns.
  agentRules: false,

  async headers() {
    return [
      { source: "/:path*", headers: SECURITY_HEADERS },

      // The admin console and every API route must never be cached by a shared
      // cache. The board is dynamic too, but this is the set where a stale or
      // shared response would be a security problem rather than a stale number.
      //
      // `/api/avatar/*` is **excluded** rather than overridden. The two used to
      // be written as this blanket plus a later entry that replaced
      // `Cache-Control` for that one path, on the documented rule that the last
      // matching entry wins — and it does win, which was the problem: it won
      // over the *route* as well. The audit of `20040c7` measured a real
      // `next start` serving `public, max-age=60, s-maxage=300` where the route
      // had set `public, max-age=60, s-maxage=300, stale-while-revalidate=3600`.
      // The route's `CACHE_IMAGE` (`s-maxage=86400`) was dead code and every
      // avatar was cached for five minutes instead of a day: roughly 288x the
      // unavatar fetches it was designed for.
      //
      // Only the route can tell a relayed picture from the monogram an outage
      // produces, and those two are worth remembering for very different
      // lengths of time, so the route owns the header and this file sets none
      // for that path. The negative lookahead is Next's documented regex path
      // matching (`:param(regex)`); it is what keeps `X-Robots-Tag` and the
      // `no-store` on every *other* API route exactly as they were.
      { source: "/api/:path((?!avatar/).*)", headers: NO_STORE_AND_NOINDEX },

      // What the avatar path still takes from this file. `Cache-Control` is
      // deliberately absent — see above.
      {
        source: "/api/avatar/:kolId",
        headers: [{ key: "X-Robots-Tag", value: "noindex, nofollow" }],
      },

      { source: "/admin", headers: NO_STORE_AND_NOINDEX },
      { source: "/admin/:path*", headers: NO_STORE_AND_NOINDEX },
    ];
  },
};

export default nextConfig;
