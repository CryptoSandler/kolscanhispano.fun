/**
 * `/privacidad` — qué pasa con las wallets de un KOL, para quien no escribe
 * código.
 *
 * **Estaba escrita para nosotros.** Decía `is_public`, "índice ciego" e
 * "importar una API que arme o envíe una transacción": tres cosas ciertas que
 * un lector no puede evaluar, en la única página del sitio cuyo trabajo es que
 * confíe. Un lector que no entiende la garantía no la recibe, por precisa que
 * sea.
 *
 * Ahora son cuatro tarjetas de dos líneas, y **el texto técnico no se tiró**:
 * está entero, palabra por palabra, en el desplegable del final. La versión
 * larga sigue siendo la que un revisor puede verificar; la corta es la que
 * alguien lee.
 */
export const metadata = {
  title: "Privacidad",
  description: "Qué hacemos con tus wallets, en cuatro puntos.",
};

/** Íconos de trazo, dibujados acá: son cuatro formas y no justifican un paquete. */
function Icon({ name }: { name: "ojo" | "recorte" | "candado" | "firma" }) {
  const common = {
    viewBox: "0 0 24 24",
    width: 28,
    height: 28,
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.6,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
    focusable: "false" as const,
  };
  if (name === "ojo") {
    return (
      <svg {...common}>
        <path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12z" />
        <circle cx="12" cy="12" r="2.5" />
        <path d="M4 20L20 4" />
      </svg>
    );
  }
  if (name === "recorte") {
    return (
      <svg {...common}>
        <path d="M4 8h6M14 8h6M4 16h3M11 16h9" />
        <path d="M12 3v18" strokeDasharray="2 3" />
      </svg>
    );
  }
  if (name === "candado") {
    return (
      <svg {...common}>
        <rect x="4" y="10" width="16" height="10" rx="2" />
        <path d="M8 10V7a4 4 0 0 1 8 0v3" />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <path d="M3 17c3-1 5-9 8-9s2 6 4 6 3-2 6-3" />
      <path d="M3 21h18" />
    </svg>
  );
}

const CARDS = [
  {
    icon: "ojo" as const,
    title: "Nadie ve tus wallets",
    body: "Salvo que elijas mostrar alguna. Por defecto están ocultas.",
  },
  {
    icon: "recorte" as const,
    title: "Ni un pedacito",
    body: "No aparecen ni recortadas ni escondidas en la página.",
  },
  {
    icon: "candado" as const,
    title: "Guardadas cifradas",
    body: "En nuestra base no están en texto claro.",
  },
  {
    icon: "firma" as const,
    title: "Solo firmas, nunca pagas",
    body: "El sitio no mueve fondos ni arma transacciones.",
  },
];

export default function PrivacidadPage() {
  return (
    <div className="prose-page">
      <h1 className="display-lg">Cómo protegemos tus wallets</h1>

      <ul className="privacy-cards">
        {CARDS.map((card) => (
          <li key={card.title} className="privacy-card">
            <span className="privacy-card__icon">
              <Icon name={card.icon} />
            </span>
            <h2 className="privacy-card__title">{card.title}</h2>
            <p className="privacy-card__body">{card.body}</p>
          </li>
        ))}
      </ul>

      <p className="privacy-close">
        Si quieres saber qué hacemos con tus datos: nada más que esto.
      </p>
    </div>
  );
}
