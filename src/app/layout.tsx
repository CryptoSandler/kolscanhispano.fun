import type { Metadata } from "next";
import { Suspense } from "react";
import Link from "next/link";
import { LEADERBOARD_FIATS } from "@/lib/leaderboard";
import { LEADERBOARD_WINDOWS } from "@/lib/windows";
import { BrandHomeLink } from "./brand-home-link";
import { Inter, JetBrains_Mono } from "next/font/google";
import { AffiliateSlot } from "./affiliate-slot";
import { SiteNav } from "./site-nav";
import { activeChains } from "@/lib/chain";
import { ProfileChip } from "./profile-chip";
import { ConnectWalletProvider } from "./connect-wallet";
import "./globals.css";

/**
 * DESIGN.md, Typography: *"**Inter** for all text and **JetBrains Mono** for
 * all figures."* Two faces, not three — this direction dropped the separate
 * display face the previous one carried, so `Inter_Tight` is no longer loaded.
 * `next/font` self-hosts both, which is also what keeps them inside the
 * `font-src 'self' data:` policy in `next.config.ts` — a Google Fonts
 * stylesheet link would be blocked by it.
 */
const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});
const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-jetbrains-mono",
  display: "swap",
});

/**
 * The brand's contents, in one place because two things render them: the link
 * that carries the reader's window forward, and the `Suspense` fallback that
 * stands in for it while a prerendered route hydrates.
 *
 * The tile is at the mould's own measure — **40×40**, read from its DOM rather
 * than estimated from a picture. The brief of 2026-09-03 said "≈64px"; the
 * measurement is what that batch was told to follow, so it is 40 and this note
 * is here so the number can be overruled knowingly.
 *
 * The glyph is Unicode — nobody's asset, exception (c) — and it is
 * `aria-hidden`: the wordmark beside it says the name, and a screen reader
 * announcing "flag of Spain" would add a claim the text does not make.
 */
function BrandInner() {
  return (
    <>
      {/* Plain `<img>`, not `next/image`: it is a 19KB PNG rendered at a fixed
          40×40 in the header of every page, so there is no layout to reserve,
          no srcset worth generating and no lazy boundary to cross. The lint
          rule that prefers `next/image` is about content images that vary.

          `aria-hidden` for the same reason the glyph was: the wordmark beside
          it says the name, and an alt text announcing "flag of Spain" would
          add a claim the text does not make. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        className="brand-mark"
        src="/marca/espana.png"
        alt=""
        width={40}
        height={40}
        aria-hidden="true"
      />
      {/*
        **El brillo corre sobre el wordmark entero**, `KOLScan Hispano`, no sólo
        sobre la segunda palabra — corrección del dueño del 2026-09-05. En reposo
        las dos palabras son blancas (`#EDEDED`) y el degradado de banderas pasa
        por encima.

        `data-text` repite el texto visible: el `::before` del shimmer lo duplica
        con `content: attr(data-text)` y recorta el degradado contra esos glifos.
        Traído de `.text-shimmer-flag` de `survives.fun`, que funciona igual y por
        la misma razón — las letras de abajo quedan sólidas, así que el brillo
        nunca le cuesta el contraste al wordmark.

        Una sola palabra en el `data-text` y un solo nodo de texto: partirlo en
        dos spans daría dos cajas recortadas, cada una con su propio barrido, y
        el brillo se vería cortado en el medio.
      */}
      <span className="wordmark shimmer-flag" data-text="KOLScan Hispano">
        KOLScan Hispano
      </span>
      <p className="brand-subtitle">Clasificación de traders hispanos</p>
    </>
  );
}

/** The same block as a fixed link, for the `Suspense` fallback. */
function BrandBlock({ href }: { href: string }) {
  return (
    <Link className="brand" href={href}>
      <BrandInner />
    </Link>
  );
}

export const metadata: Metadata = {
  /*
    **La pestaña: bandera y nombre, como el molde.**

    `template` es lo que hace que cada página herede el nombre del sitio sin
    repetirlo a mano: la home usa `default` y las demás ponen sólo lo suyo —
    `Cabals` se vuelve `KOLScan Hispano – Cabals`. Un título que cada página
    escribe entero es un título que en alguna página va a decir otra cosa.
  */
  title: {
    default: "KOLScan Hispano – Clasificación de traders hispanos",
    template: "KOLScan Hispano – %s",
  },
  description: "Clasificación de traders hispanohablantes por PnL realizado.",
  metadataBase: new URL("https://kolscanhispano.fun"),

  /*
    **El ícono es la bandera, la misma imagen que el wordmark.**

    Así la pestaña y el encabezado son lo mismo y no dos representaciones de la
    misma idea, pero **no la misma imagen**, y la diferencia es el tamaño al que
    se mira cada una.

    El encabezado lleva la foto (`public/marca/espana.png`), que a 40 px se ve
    como lo que es. La pestaña lleva un dibujo: `public/brand/flag.svg`, tres
    franjas —rojo un cuarto, amarillo la mitad, rojo un cuarto— **sin escudo**.
    A 16 px el escudo es una mancha marrón de tres píxeles sobre la franja
    amarilla, y una foto redimensionada a 16 es una papilla de la que no se lee
    ninguna franja. Lo que tiene que leerse a ese tamaño son tres franjas
    limpias, y para eso hay que dibujarlas.

    Los PNG se rasterizan del SVG con Chromium —el mismo motor que va a pintar
    el favicon— porque `sips` no lee SVG. El radio se escala desde 3 px sobre
    32, que es la medida canónica de un favicon.

    **Origen y licencia: sin documentar.** `survives.fun` no dice de dónde salió
    ese archivo ni bajo qué licencia; lo verifiqué buscando en sus documentos y
    lo único que menciona "flags" son banderas booleanas del torneo. El diseño
    de la bandera española es un símbolo oficial y no una obra con autor, pero
    **este archivo concreto** tiene procedencia desconocida y conviene decirlo
    antes de que alguien lo tome por verificado.
  */
  icons: {
    icon: [
      { url: "/brand/flag-48.png", sizes: "48x48", type: "image/png" },
      { url: "/brand/flag-32.png", sizes: "32x32", type: "image/png" },
      { url: "/brand/flag-16.png", sizes: "16x16", type: "image/png" },
      { url: "/brand/flag.svg", type: "image/svg+xml" },
    ],
    apple: [{ url: "/brand/flag-180.png", sizes: "180x180", type: "image/png" }],
  },
  manifest: "/manifest.webmanifest",

  openGraph: {
    title: "KOLScan Hispano – Clasificación de traders hispanos",
    description: "Clasificación de traders hispanohablantes por PnL realizado.",
    siteName: "KOLScan Hispano",
    locale: "es_ES",
    type: "website",
  },

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

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
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
        {/*
          El provider envuelve todo el body porque el botón que lo abre vive en
          el header y el diálogo se dibuja sobre `main`. Las cadenas se resuelven
          acá, en el servidor: `activeChains()` lee `process.env`, y un
          componente cliente que la llame recibe `["solana"]` diga lo que diga
          el flag — el error que `registro/page.tsx` documenta y que costó
          manejar la página con una wallet falsa para verlo.
        */}
        <ConnectWalletProvider chains={activeChains()}>
          <div className="topbar-rule">
            <div className="shell shell-topbar">
              {/*
            DESIGN.md, Layout: "Header: wordmark and subtitle left, nav centre,
            unit and window controls plus the wallet action right."
          */}
              <header className="topbar">
                {/*
                **The `Suspense` is required, not defensive.** Next 16:
                *"During production builds, a static page that calls
                `useSearchParams` from a Client Component must be wrapped in a
                `Suspense` boundary, otherwise the build fails"*
                (`node_modules/next/dist/docs/01-app/03-api-reference/04-functions/use-search-params.md`).
                This is the root layout, so it wraps prerendered routes too.

                The fallback is the same block as a plain `/` — the brand
                renders identically and the link is simply the default window,
                which is what it did before this component existed.
              */}
                <Suspense fallback={<BrandBlock href="/" />}>
                  <BrandHomeLink
                    windows={LEADERBOARD_WINDOWS}
                    fiats={LEADERBOARD_FIATS}
                  >
                    <BrandInner />
                  </BrandHomeLink>
                </Suspense>

                <SiteNav />

                <div className="topbar-right">
                  {/*
                The wallet action's slot. Spec §6 makes `/registro` the only
                page that ever connects a wallet, and it now exists — so this is
                a real link, which is what the note that stood here promised
                would happen when it shipped.

                It held a muted, unfocusable label until then, because
                DESIGN.md's last Don't is "**Don't** show a control that does
                not work." A label saying `próximamente` over a page that works
                is the same Don't read backwards.
              */}
                  {/* The user pill, at the mould's measure: `brand-hispano` at 20 %,
                  `radius-md`, 16px.

                  **It shows the connect action, not a session.** The brief
                  described theirs with an avatar, a handle and a sign-out
                  icon — that is their own logged-in state. Spec §6 gives this
                  product no accounts and `/registro` is the only page that
                  connects anything, so a pill with somebody's avatar in it
                  would be a session this site cannot have and a control that
                  does not work. Same shape, honest content. */}
                  {/*
                    **El slot del usuario, con sesión desde el 2026-09-06.**

                    `ProfileChip` decide qué va acá: con sesión, avatar +
                    `@handle` + `Salir`, como el molde; sin sesión, el botón
                    `Connect Wallet` que abre el modal — y que sigue siendo un
                    enlace a `/registro` para quien lo copie o lo abra en otra
                    pestaña.

                    El comentario de arriba decía que un chip con avatar y handle
                    sería "una sesión que este sitio no puede tener". Era cierto
                    hasta que spec §6 quedó superseded (`DECISIONES.md`).
                  */}
                  <ProfileChip />
                  {/*
                Spec §1.9: the affiliate slot is configurable from the admin and
                empty at launch, where it renders nothing. The admin that
                configures it is a later task; an empty slot is the correct
                rendering of its launch state, not a placeholder.
              */}
                  <AffiliateSlot />
                </div>
              </header>
            </div>
          </div>
          <div className="shell">
            <main>{children}</main>
            {/*
            **El crédito de siempre**, copiado de `milliondollarpage`
            (`BoardView.tsx`) para que sea el mismo en los dos: mismo glifo
            dibujado a mano, mismo `Built by`, mismo handle, mismo `rel`.

            **El glifo se dibuja acá.** Un avatar traído de x.com sería una
            petición que sale de esta página al servidor de otro en cada carga, y
            este sitio dibuja sus propias imágenes — la misma razón por la que los
            avatares de los KOL pasan por `unavatar` proxeado y nunca por un
            hotlink (`docs/references.md` §5, segunda colisión).

            A diferencia de `milliondollarpage`, acá **no se esconde a ningún
            ancho**: allá el crédito vive en una franja que a menos de 1400px se
            apila y desaparece; este pie es el mismo en 1440 y en 390, que es lo
            que se pidió.
          */}
            <a
              href="https://x.com/CryptoSandlerr"
              target="_blank"
              rel="noreferrer noopener"
              className="built-by"
            >
              <svg
                viewBox="0 0 24 24"
                aria-hidden="true"
                className="built-by__mark"
              >
                <path
                  fill="currentColor"
                  d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"
                />
              </svg>
              <span className="built-by__label">Built by </span>
              <span className="built-by__handle">@CryptoSandlerr</span>
            </a>
            {/*
              El enlace a `/privacidad`, que es donde alguien lo busca: al pie,
              en una línea, sin competir con nada. La página misma se mudó de
              `/trade` cuando esa ruta se eliminó (`DECISIONES.md`).
            */}
            {/*
              **Un enlace del pie, no un rótulo.**

              Heredaba `.panel-link`, que va en versalitas, y en `/privacidad`
              quedaba un `PRIVACIDAD` suelto abajo a la izquierda que parecía un
              encabezado roto — se vio en el gate. Es un enlace y se ve como uno.
            */}
            <p className="footnote footnote-links">
              <Link href="/privacidad">Privacidad</Link>
            </p>

            {/*
              **El disclaimer no vive acá desde el 2026-09-06.**

              Estaba en el layout, o sea en todas las páginas, y debajo de un
              ranking era mobiliario. Se mudó a `/trade`; cuando `/trade` se
              eliminó, al pie de `/cabals`, que es el único lugar donde queda.
            */}
          </div>
        </ConnectWalletProvider>
      </body>
    </html>
  );
}
