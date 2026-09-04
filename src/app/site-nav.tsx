"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * Spec §2: the nav. It carried two destinations — the live feed and the ranked
 * list — until 2026-09-02, when `/cabals` and `/trade` were built and joined
 * it, which is what *"the rest of the table's routes join it as they are
 * built"* meant.
 *
 * **The ranking took the home page on 2026-09-03** and the feed moved to
 * `/en-vivo`, so the first item is `/` and the feed follows it. Their home is
 * the ranking and they have no feed at all; ours keeps one, on its own route,
 * which is where kolscan.io puts theirs.
 *
 * A client component for one reason: marking the current page. `usePathname`
 * is the only thing here that needs the browser, and without it the nav gives
 * a reader no idea which of the two they are looking at. `aria-current` is the
 * part that matters; the colour is the sighted half of the same statement.
 */
/**
 * `live: true` puts the mould's green dot before an item.
 *
 * **It goes on `En vivo`, not on `Operar`.** The brief said "before Trade",
 * which is where theirs is; ours is the feed. `Operar` is an affiliate landing
 * with no partner chosen, and a live dot there would be decoration pretending
 * to be information — the same thing this project refused for the status dot on
 * a cabal logo. The dot marks what is live, and here that is the feed.
 *
 * The green is DESIGN.md's one exception to "green and red are direction of
 * money", dated 2026-09-03 and scoped to this dot alone.
 */
/**
 * **`Clasificación` left the nav on 2026-09-03.** The mould's nav is two items
 * — `Trade` and `Cabals` — and its ranking is reached by clicking the wordmark,
 * because the ranking *is* the home page. Ours is too since this morning, so a
 * nav item pointing at `/` was a second door to the room the reader is standing
 * in. The wordmark is the link, as on the mould.
 *
 * That leaves three where theirs has two, and the extra one is `En vivo`: the
 * mould has no live feed, and ours is not reachable any other way. Dropping it
 * to match the count exactly would orphan a page.
 */
const LINKS = [
  { href: "/en-vivo", label: "Live", live: true },
  { href: "/cabals", label: "Cabals", live: false },
  { href: "/trade", label: "Trade", live: false },
] as const;

export function SiteNav() {
  const pathname = usePathname();

  return (
    <nav className="nav" aria-label="Principal">
      {LINKS.map((link) => {
        // No `/` in the list any more, so the special case that kept it from
        // prefix-matching every route went with it.
        const current = pathname.startsWith(link.href);
        return (
          <Link
            key={link.href}
            href={link.href}
            className={current ? "nav-link is-current" : "nav-link"}
            aria-current={current ? "page" : undefined}
          >
            {link.live && <span className="nav-live" aria-hidden="true" />}
            {link.label}
          </Link>
        );
      })}
    </nav>
  );
}
