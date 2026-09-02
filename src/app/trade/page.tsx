import { readAffiliateSlot } from "@/lib/settings";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Operar · kolscanhispano.fun",
  description: "Cómo empezar a operar on-chain, con el terminal socio del sitio.",
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

  return (
    <>
      <div className="page-head trade-head">
        <p className="pill-partner label">Socio · {slot === null ? "sin definir" : slot.label}</p>
        <h1 className="display-lg trade-title">
          Empieza a operar
          <span className="trade-title-accent">on-chain</span>
        </h1>
        <p className="page-subtitle">
          {slot === null
            ? "Todavía no elegimos un terminal socio. Cuando haya uno, el enlace aparece aquí."
            : `Opera con ${slot.label}, el terminal socio de este sitio.`}
        </p>

        {slot === null ? (
          // Not a button, and not disabled: see the note above.
          <p className="cta-slot label">Sin terminal socio por ahora</p>
        ) : (
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
        {STEPS.map((step, index) => (
          <li key={step.title} className={index === STEPS.length - 1 ? "step is-last" : "step"}>
            <span className="step-number" aria-hidden="true">
              {String(index + 1).padStart(2, "0")}
            </span>
            <h2 className="step-title">{step.title}</h2>
            <p className="step-body">{step.body}</p>
          </li>
        ))}
      </ol>

      <Divider>El terminal socio</Divider>

      {/*
        **A divider must not head an empty section**, which is what this one did
        when it first shipped — caught by reading the capture, not by a test. It
        is DESIGN.md's last Don't one level up: a heading that announces
        something the page does not have. So the section says what is there,
        and while no partner is chosen what is there is the fact that none is.
      */}
      {slot === null ? (
        <div className="state-empty">
          <p className="state-empty-lead">Todavía no hay un terminal socio.</p>
          <p className="state-empty-note">
            Cuando elijamos uno, su nombre y el enlace aparecen en esta sección y en el botón de
            arriba. Hasta entonces no hay nada que recomendar.
          </p>
        </div>
      ) : (
        <p className="trade-partner">
          <strong>{slot.label}</strong> es el terminal socio de este sitio. El enlace de arriba
          lleva allí y está identificado como patrocinado.
        </p>
      )}

      <p className="label control-note trade-note">
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
 * The four steps, translated into neutral Spanish rather than transcribed:
 * theirs name their own partner in two of the four, and ours cannot name one
 * yet. What survives is the sequence, which is the part that is the same for
 * anybody: get a wallet, fund it, find who to follow, trade.
 *
 * The last card carries the accent border on the mould, so it does here.
 */
const STEPS = [
  {
    title: "Abre una wallet",
    body: "Una wallet de Solana en el navegador o en el teléfono. Guarda la frase de recuperación fuera de línea: quien la tenga, tiene los fondos.",
  },
  {
    title: "Cárgala con SOL",
    body: "Transfiere SOL desde donde ya lo tengas. Deja siempre un resto para las comisiones de red.",
  },
  {
    title: "Mira qué hacen los KOL",
    body: "La clasificación de este sitio ordena por PnL realizado del período. El feed muestra cada compra y cada venta en cuanto la cadena las confirma.",
  },
  {
    title: "Opera con tu propio criterio",
    body: "Copiar una operación no copia el momento en que se abrió ni el tamaño con que se hizo. Lo que ves aquí es un registro, no una recomendación.",
  },
] as const;
