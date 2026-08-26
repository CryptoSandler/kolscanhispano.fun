import type { Metadata } from "next";
import Link from "next/link";
import { Inter, Inter_Tight, JetBrains_Mono } from "next/font/google";
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
};

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
            <Link className="wordmark" href="/">
              kolscanhispano<span className="tld">.fun</span>
            </Link>
            {/*
              Spec §1.9: the affiliate slot is configurable from the admin and
              empty at launch, where it renders nothing. The admin that
              configures it is a later task; an empty slot is the correct
              rendering of its launch state, not a placeholder.
            */}
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
