"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * Spec §2: the nav. Two destinations in v1 — the live feed and the
 * leaderboard — and the rest of the table's routes join it as they are built.
 *
 * A client component for one reason: marking the current page. `usePathname`
 * is the only thing here that needs the browser, and without it the nav gives
 * a reader no idea which of the two they are looking at. `aria-current` is the
 * part that matters; the colour is the sighted half of the same statement.
 */
const LINKS = [
  { href: "/", label: "En vivo" },
  { href: "/leaderboard", label: "Clasificación" },
] as const;

export function SiteNav() {
  const pathname = usePathname();

  return (
    <nav className="nav" aria-label="Principal">
      {LINKS.map((link) => {
        // `/` would otherwise prefix-match every route on the site.
        const current = link.href === "/" ? pathname === "/" : pathname.startsWith(link.href);
        return (
          <Link
            key={link.href}
            href={link.href}
            className={current ? "nav-link is-current" : "nav-link"}
            aria-current={current ? "page" : undefined}
          >
            {link.label}
          </Link>
        );
      })}
    </nav>
  );
}
