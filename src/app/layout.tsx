import type { Metadata } from "next";
import Link from "next/link";
import { Inter, JetBrains_Mono } from "next/font/google";
import { LEADERBOARD_UNITS } from "@/lib/leaderboard";
import { LEADERBOARD_WINDOWS } from "@/lib/windows";
import { AffiliateSlot } from "./affiliate-slot";
import { LeaderboardControls } from "./leaderboard-controls";
import { SiteNav } from "./site-nav";
import "./globals.css";

/**
 * DESIGN.md, Typography: *"**Inter** for all text and **JetBrains Mono** for
 * all figures."* Two faces, not three — this direction dropped the separate
 * display face the previous one carried, so `Inter_Tight` is no longer loaded.
 * `next/font` self-hosts both, which is also what keeps them inside the
 * `font-src 'self' data:` policy in `next.config.ts` — a Google Fonts
 * stylesheet link would be blocked by it.
 */
const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });
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
    <html lang="es" className={`${inter.variable} ${jetbrainsMono.variable}`}>
      <body>
        <div className="shell">
          {/*
            DESIGN.md, Layout: "Header: wordmark and subtitle left, nav centre,
            unit and window controls plus the wallet action right."
          */}
          <header className="topbar">
            <div className="brand">
              {/* DESIGN.md, Identity: "The wordmark is the domain in Inter 700,
                  with **`.fun` in the accent** — the dot alone is invisible at
                  20px, measured rather than assumed." Corrected in `b0f2a43`;
                  this used to accent the `.` and nothing else. */}
              <Link className="wordmark" href="/">
                kolscanhispano<span className="wordmark-accent">.fun</span>
              </Link>
              <p className="brand-subtitle">Ranking de traders hispanos</p>
            </div>

            <SiteNav />

            <div className="topbar-right">
              <LeaderboardControls windows={LEADERBOARD_WINDOWS} units={LEADERBOARD_UNITS} />
              {/*
                The wallet action's slot, as a label rather than a control.
                Spec §6 makes `/registro` the only page that ever connects a
                wallet, and that page does not exist yet; DESIGN.md's last
                Don't is "**Don't** show a control that does not work." So this
                is muted, unclickable and not focusable — it holds the slot the
                genre puts here without pretending to be a flow.

                **When `/registro` ships this becomes a real link.**
              */}
              <span className="registro" aria-disabled="true">
                Registro — próximamente
              </span>
              {/*
                Spec §1.9: the affiliate slot is configurable from the admin and
                empty at launch, where it renders nothing. The admin that
                configures it is a later task; an empty slot is the correct
                rendering of its launch state, not a placeholder.
              */}
              <AffiliateSlot />
            </div>
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
