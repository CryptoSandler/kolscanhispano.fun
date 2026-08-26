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
      {
        source: "/(admin|api)/:path*",
        headers: [
          { key: "Cache-Control", value: "no-store, no-cache, must-revalidate, private" },
          { key: "X-Robots-Tag", value: "noindex, nofollow" },
        ],
      },
      {
        source: "/admin",
        headers: [
          { key: "Cache-Control", value: "no-store, no-cache, must-revalidate, private" },
          { key: "X-Robots-Tag", value: "noindex, nofollow" },
        ],
      },
    ];
  },
};

export default nextConfig;
