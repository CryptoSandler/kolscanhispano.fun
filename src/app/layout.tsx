import type { Metadata } from "next";
import Link from "next/link";
import { Inter, Inter_Tight, JetBrains_Mono } from "next/font/google";
import { AffiliateSlot } from "./affiliate-slot";
import { SiteNav } from "./site-nav";
import "./globals.css";

/**
 * DESIGN.md: Inter Tight for display, Inter for body, JetBrains Mono with
 * tabular figures for every number. `next/font` self-hosts all three, which is
 * also what keeps them inside the `font-src 'self' data:` policy in
 * `next.config.ts` — a Google Fonts stylesheet link would be blocked by it.
 */
const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });
const interTight = Inter_Tight({
  subsets: ["latin"],
  variable: "--font-inter-tight",
  display: "swap",
});
const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-jetbrains-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "kolscanhispano.fun",
  description: "Operaciones en vivo de KOLs hispanohablantes en Solana.",

  /**
   * Closed to search engines until launch, on purpose and by hand.
   *
   * `robots.ts` asks crawlers not to fetch; this is what keeps a page *already*
   * fetched out of an index, which is the case robots.txt cannot cover — a URL
   * linked from anywhere gets crawled whatever robots.txt said. `googleBot` is
   * set explicitly rather than left to inherit, because Google reads its own
   * directive in preference to the generic one when both are present, and the
   * generic tag alone is the weaker of the two claims.
   *
   * **Lifting this is a three-file change, and all three must go together:**
   * here, `src/app/robots.ts`, and the `X-Robots-Tag` entry in
   * `next.config.ts`. Removing one leaves the site indexed through a door the
   * other two do not guard, or (worse) half-indexed in a way that is slow to
   * notice and slower to undo — a de-indexing takes weeks that an indexing
   * takes hours.
   *
   * Metadata merges shallowly and per key, so a page that exports its own
   * `robots` replaces this wholesale. No page does today; `/leaderboard` only
   * sets `title` and `description` and so still inherits this.
   */
  robots: {
    index: false,
    follow: false,
    googleBot: { index: false, follow: false },
  },
};

/**
 * The affiliate slot reads a `setting` row, so the shell is rendered per
 * request. Every route under it is `force-dynamic` already; saying so here
 * keeps a future statically-rendered page from trying to reach Postgres at
 * build time.
 */
export const dynamic = "force-dynamic";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    /*
      The font classes go on <html>, not on <body>. `next/font` declares
      `--font-inter` and friends on whatever element carries the class, and
      `globals.css` composes them into `--font-body` on `:root`. A custom
      property is substituted where it is *declared*, so with the classes on
      <body> the `var(--font-inter)` inside `--font-body` resolved against
      `:root`, found nothing, and made the whole declaration invalid — every
      face silently fell back to the browser's default serif.
    */
    <html lang="es" className={`${inter.variable} ${interTight.variable} ${jetbrainsMono.variable}`}>
      <body>
        <div className="shell">
          <header className="topbar">
            <div className="brand">
              <Link className="wordmark" href="/">
                kolscanhispano<span className="tld">.fun</span>
              </Link>
              <SiteNav />
            </div>
            {/*
              Spec §1.9: the affiliate slot is configurable from the admin and
              empty at launch, where it renders nothing. The admin that
              configures it is a later task; an empty slot is the correct
              rendering of its launch state, not a placeholder.
            */}
            <AffiliateSlot />
          </header>
          <main>{children}</main>
          <p className="footnote">
            Datos on-chain públicos. Esto no es asesoramiento financiero y los resultados
            pasados no garantizan nada.
          </p>
        </div>
      </body>
    </html>
  );
}
