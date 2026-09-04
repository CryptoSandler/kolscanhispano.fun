import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { rateLimited } from "@/lib/rate-limit";

/**
 * Spec §10's `ip_hash` rate limiting, for the two surfaces that are not routes.
 *
 * `/` and `/leaderboard` are both `force-dynamic` and both read Neon on every
 * request — the home page runs the feed read and the leaderboard read together
 * — so they are as expensive per request as the API routes the audit measured,
 * and until this file existed they were the only public surfaces with no limit
 * of any kind. A limiter that covered `/api/feed` while `/` served the same
 * rows unmetered would be a control with a documented way around it.
 *
 * This is the one hook that can answer before a Server Component renders. A
 * page cannot: it has no way to set a status short of `notFound()`, and by the
 * time it could decide anything it has already done the work being limited.
 *
 * ## Node.js, and why that is not an assumption
 *
 * `hitLimit` talks to Postgres through `pg`, which the edge runtime cannot
 * load. Next 16 runs Proxy on the **Node.js runtime by default** and rejects a
 * `runtime` export here outright
 * (`node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/proxy.md`:
 * *"Proxy defaults to using the Node.js runtime. The `runtime` config option is
 * not available in Proxy files"*, and the version table's
 * *"v16.0.0 | ... Proxy defaults to the Node.js runtime"*). On Next 15 this
 * file would need `runtime: "nodejs"` and on Next 14 it could not exist at all.
 *
 * ## It fails open, and the routes do not
 *
 * Every rate-limited API route needs the same database on its next line, so a
 * limiter that swallowed its own errors there would move the failure one
 * statement along while removing the control. Here the calculus is reversed:
 * this file is in front of every page view and has no other reason to exist, so
 * a transient Neon error turning the whole site into a 500 would be an
 * availability regression introduced by a security control. It logs and steps
 * aside. Nothing about the message is interpolated: `db.ts` keeps connection
 * detail out of logs and this is the same log.
 *
 * ponytail: the lazier alternative is Vercel's own firewall rate limiting,
 * which is a platform rule rather than a database write in front of every page
 * view. It is not in this repository and cannot be reviewed from it, which is
 * why the control lives here; if it is ever configured, this file is what it
 * replaces.
 */
export const config = {
  // Exactly the dynamic pages a reader lands on. Everything else —
  // `_next/static`, the public folder, the API routes that limit themselves —
  // is deliberately outside, because a matcher-less Proxy runs on every asset
  // request and would put a Postgres write in front of the CSS.
  //
  // `/leaderboard` is still here: it redirects to `/` since 2026-09-03, and a
  // redirect is a request like any other. `/en-vivo` joined when the feed moved
  // there.
  matcher: ["/", "/en-vivo", "/leaderboard"],
};

export async function proxy(request: NextRequest): Promise<Response> {
  try {
    const limited = await rateLimited(request, "page");
    if (limited) return limited;
  } catch {
    console.error("proxy: the rate limiter could not be consulted; allowing the request");
  }
  return NextResponse.next();
}
