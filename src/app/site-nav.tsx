"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * Spec §2: the nav. It carried two destinations — the live feed and the ranked
 * list — until 2026-09-02, when `/cabals` and `/trade` were built and joined
 * it, which is what *"the rest of the table's routes join it as they are
 * built"* meant.
 *
 * The order is the mould's, with ours in front of it: what this site is for
 * comes first, and the two surfaces cloned from `kolscanbrasil.io` follow in
 * the order that site lists them.
 *
 * A client component for one reason: marking the current page. `usePathname`
 * is the only thing here that needs the browser, and without it the nav gives
 * a reader no idea which of the two they are looking at. `aria-current` is the
 * part that matters; the colour is the sighted half of the same statement.
 */
const LINKS = [
  { href: "/", label: "En vivo" },
  { href: "/leaderboard", label: "Clasificación" },
  { href: "/cabals", label: "Cabals" },
  { href: "/trade", label: "Operar" },
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
