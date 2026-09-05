import { activeChains, type Chain } from "@/lib/chain";
import { readAffiliateSlot } from "@/lib/settings";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Operar · kolscanhispano.fun",
  // No partner is promised here either. The page's subject is how to start
  // trading; the partner is a slot that may one day be filled.
  description: "Cómo empezar a operar on-chain, paso a paso.",
};

/**
 * `docs/clone-map.md` §7: their affiliate landing, rebuilt.
 *
 * **The page ships without a partner, and does not pretend otherwise.** They
 * link a specific terminal; we have chosen none, and spec §1.9 already fixes
 * how that is expressed — the affiliate slot is *"link and label configurable
 * from the admin, **empty at launch**"*. So this page reads the same
 * `setting` row `AffiliateSlot` reads, and the call to action is:
 *
 * - a real, `rel="sponsored"` link once a row exists, or
 * - **a plain label, not a disabled button**, while none does.
 *
 * The second half is DESIGN.md's last Don't — *"Don't show a control that does
 * not work. A window we cannot aggregate is not a disabled tab with a tooltip;
 * it is absent."* — and it is the same resolution `/registro`'s slot already
 * had in the header while that page did not exist: a muted, unfocusable label
 * standing where the control will be. `docs/clone-map.md` §7 asked for a
 * disabled button; a disabled button is the one shape that document's own
 * design rules forbid, and the label says the same thing without lying about
 * being pressable.
 *
 * Everything else is theirs, translated: the partner pill, the two-line display
 * headline, the bracketed dividers, and four numbered steps over a ghosted
 * numeral. **Their second headline line is green and ours is cyan**: green is
 * direction of money in this system and a headline is not a figure.
 */
export default async function TradePage() {
  const slot = await readAffiliateSlot();
  const steps = stepsFor(activeChains());

  return (
    <>
      <div className="page-head trade-head">
        <p className="pill-partner label">Socio · {slot === null ? "sin definir" : slot.label}</p>
        <h1 className="display-lg trade-title">
          Empieza a operar
          <span className="trade-title-accent">on-chain</span>
        </h1>
        {/*
          **The absence is stated once, in the chip, and nowhere else.**

          It used to be said four times: the chip, this subtitle, a label where
          the button goes, and a whole section under a second divider. Each was
          defensible on its own and together they made a page whose subject was
          a thing it does not have. One statement is the honest amount; the rest
          of the page is about how to start trading, which does not depend on a
          partner existing.
        */}
        <p className="page-subtitle">
          {slot === null
            ? "Cómo empezar a operar on-chain, paso a paso."
            : `Opera con ${slot.label}, el terminal socio de este sitio.`}
        </p>

        {slot !== null && (
          <a
            className="cta-partner"
            href={slot.url}
            target="_blank"
            rel="noreferrer noopener sponsored"
          >
            Ir a {slot.label}
          </a>
        )}
      </div>

      <Divider>Cómo empezar</Divider>

      <ol className="steps">
        {steps.map((step, index) => (
          <li key={step.title} className={index === steps.length - 1 ? "step is-last" : "step"}>
            {/*
              A small numeral in the corner, not the mould's huge ghosted one.
              Theirs sits behind the text at 44px and ours overlapped the title
              at every width the captures were read at — a decoration that eats
              the content it decorates. The step is still numbered, because it
              is a sequence; it is just not competing with the words.
            */}
            <span className="step-number" aria-hidden="true">
              {index + 1}
            </span>
            <h2 className="step-title">{step.title}</h2>
            <p className="step-body">{step.body}</p>
          </li>
        ))}
      </ol>

      {/*
        **The partner section exists only when there is a partner.**

        It used to render a second divider over an empty state saying, again,
        that no terminal is chosen — which was both the fourth copy of that
        sentence and the reason the page ran half a screen past its content at
        1440. A page with nothing to put there is shorter, not padded: the same
        Don\'t that forbids a control which does not work forbids a heading over
        a section that is not there.
      */}
      {slot !== null && (
        <>
          <Divider>El terminal socio</Divider>
          <p className="trade-partner">
            <strong>{slot.label}</strong> es el terminal socio de este sitio. El enlace de arriba
            lleva allí y está identificado como patrocinado.
          </p>
        </>
      )}

      {/*
        **One disclaimer, at the foot, at the footnote's size.**

        It was rendered as a `.label`, which is uppercase and letterspaced —
        legal prose in capitals is not a footnote at any size. `.footnote` is
        what the layout already uses for the site-wide line directly below this
        one, so the two now read as a single block at 11px instead of as two
        disclaimers in two different voices.

        The site-wide line covers "not financial advice"; this one covers
        custody and execution, which is the claim that matters on the page about
        how to start trading. They are different statements, not a repetition.
      */}
      <p className="footnote trade-note">
        Este sitio no custodia fondos, no firma transacciones y no ejecuta órdenes. Operar on-chain
        implica riesgo de pérdida total.
      </p>
    </>
  );
}

/**
 * `▣ CÓMO EMPEZAR ▣` — their divider, in the accent, letterspaced, with a
 * hairline running out to each side. The glyph is `U+25A3`, Unicode and
 * nobody's asset (exception c).
 */
function Divider({ children }: { children: string }) {
  return (
    <p className="divider-marked label">
      <span aria-hidden="true">▣</span> {children} <span aria-hidden="true">▣</span>
    </p>
  );
}

/**
 * The steps, per chain that actually has ingestion.
 *
 * **Theirs name one chain because they index one.** This page used to say "una
 * wallet de Solana" and "cárgala con SOL" regardless, which was true only while
 * Solana was the only chain and would have gone quietly wrong the first time a
 * reader arrived from an EVM chain the site indexes.
 *
 * `activeChains()` is the source, the same one `/registro` and the onboarding
 * modal read: a chain with no ingestion produces no trades, moves no rank and
 * appears nowhere, so telling somebody to fund a wallet on it would be
 * instructions for a thing that does not work — `DESIGN.md`'s last Don't, in
 * prose rather than in a control.
 *
 * The **sequence** is what is copied from the mould and it is the same for
 * anybody: get a wallet, fund it, find who to follow, trade with your own
 * judgement. Only the first two steps name chains; the last two are about
 * reading a ranking and about risk, and neither depends on which chain.
 */
const CHAIN_WALLET: Record<Chain, string> = {
  solana: "Solana",
  robinhood: "Robinhood Chain",
  ethereum: "Ethereum",
  bnb: "BNB Chain",
};

const CHAIN_UNIT: Record<Chain, string> = {
  solana: "SOL",
  robinhood: "ETH",
  ethereum: "ETH",
  bnb: "BNB",
};

/** `a`, `a y b`, `a, b y c` — the list Spanish actually uses. */
function listChains(names: string[]): string {
  return new Intl.ListFormat("es", { style: "long", type: "conjunction" }).format(names);
}

export function stepsFor(chains: readonly Chain[]): { title: string; body: string }[] {
  const networks = listChains(chains.map((chain) => CHAIN_WALLET[chain]));
  // Distinct units: two EVM chains both spend ETH, and saying so twice reads as
  // a mistake.
  const units = listChains([...new Set(chains.map((chain) => CHAIN_UNIT[chain]))]);

  return [
    {
      title: chains.length === 1 ? "Abre una wallet" : "Abre una wallet en la red que uses",
      body:
        `Una wallet en ${networks}, en el navegador o en el teléfono. Guarda la frase de ` +
        "recuperación fuera de línea: quien la tenga, tiene los fondos.",
    },
    {
      title: `Cárgala con ${units}`,
      body:
        `Transfiere ${units} desde donde ya lo tengas. Deja siempre un resto para las ` +
        "comisiones de red.",
    },
    {
      title: "Mira qué hacen los KOL",
      body:
        "La clasificación de este sitio ordena por PnL realizado del período. El feed muestra " +
        "cada compra y cada venta en cuanto la cadena las confirma.",
    },
    {
      title: "Opera con tu propio criterio",
      body:
        "Copiar una operación no copia el momento en que se abrió ni el tamaño con que se hizo. " +
        "Lo que ves aquí es un registro, no una recomendación.",
    },
  ];
}
