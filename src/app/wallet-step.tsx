"use client";

import { useEffect, useState } from "react";
import type { Chain } from "@/lib/chain";
import { supportedChains } from "@/lib/wallet-support";
import { discoverChoices, groupChoices, type Choice, type WalletOption } from "./wallet-choice";

/**
 * Paso 1: elegir la wallet. Y paso 2, si esa wallet firma en más de una cadena.
 *
 * **Los dos pasos pasan en el mismo panel**, no en un diálogo encima del otro.
 * Un modal adentro de un modal fue lo que el dueño marcó en el gate, y el
 * estándar que se copió —RainbowKit, Reown AppKit— tampoco lo hace.
 *
 * La estructura es la de esas dos: `Instaladas` primero, con el ícono real que
 * la extensión publica por Wallet Standard o EIP-6963; `Otras` después, con el
 * logo del brand kit si está en `public/wallets/` y la inicial en un círculo si
 * todavía no llegó. **Nunca un logo inventado**: dibujar la marca de un tercero
 * es peor que no dibujarla.
 */

const CHAIN_LABEL: Record<string, string> = {
  solana: "Solana",
  robinhood: "Robinhood",
  bnb: "BNB",
  ethereum: "ETH",
};

/**
 * Las wallets que se ofrecen instalar, con su enlace oficial.
 *
 * El logo se lee de `public/wallets/<slug>.svg`. Si el archivo no está, la fila
 * sale con la inicial en un círculo — que es honesto — en vez de con un dibujo
 * nuestro que se parezca al logo, que no lo sería. Cowork los está trayendo.
 */
const INSTALLABLE: { name: string; slug: string; url: string; chains: Chain[] }[] = [
  { name: "MetaMask", slug: "metamask", url: "https://metamask.io/download/", chains: ["robinhood", "bnb", "ethereum"] },
  { name: "Phantom", slug: "phantom", url: "https://phantom.com/download", chains: ["solana", "ethereum"] },
  { name: "Rabby", slug: "rabby", url: "https://rabby.io/", chains: ["robinhood", "bnb", "ethereum"] },
  { name: "Backpack", slug: "backpack", url: "https://backpack.app/download", chains: ["solana", "ethereum"] },
  { name: "Solflare", slug: "solflare", url: "https://solflare.com/download", chains: ["solana"] },
];

function Chips({ chains }: { chains: readonly string[] }) {
  return (
    <span className="wallet-choice-chains">
      {chains.map((chain) => (
        <span key={chain} className="wallet-choice-chain">
          {CHAIN_LABEL[chain] ?? chain}
        </span>
      ))}
    </span>
  );
}

/** La inicial en un círculo, para cuando no hay logo. Nunca uno inventado. */
function Monogram({ name }: { name: string }) {
  return (
    <span aria-hidden="true" className="wallet-choice-icon is-monogram">
      {name.slice(0, 1)}
    </span>
  );
}

export function WalletStep({
  chains,
  busy,
  error,
  onPick,
}: {
  chains: readonly Chain[];
  busy: boolean;
  error: string | null;
  onPick: (choice: Choice) => void;
}) {
  const [installed, setInstalled] = useState<WalletOption[]>([]);
  const [chosen, setChosen] = useState<WalletOption | null>(null);
  const [missingLogos, setMissingLogos] = useState<Set<string>>(new Set());

  /*
    El descubrimiento corre al montar **y** deja un reintento: una wallet que se
    instala o se desbloquea con el panel abierto aparece al volver a mirar, sin
    recargar. `discoverChoices` habla los dos handshakes.
  */
  useEffect(() => {
    /*
      **Se busca más de una vez, y esa es la corrección.**

      La primera versión descubría una sola vez al montar. Una extensión que
      responde el `app-ready` unos milisegundos más tarde —porque se está
      desbloqueando, o porque el navegador la despertó recién— no aparecía
      nunca, y la lista se quedaba vacía sin nada que reintentar. Se vio en el
      gate: con dos wallets registradas, la sección `Instaladas` no salió.

      Tres pasadas cubren el arranque, y `focus` cubre el caso de instalarla en
      otra pestaña y volver. `discoverChoices` es idempotente y barato: vuelve a
      preguntar por los dos handshakes y no guarda nada.
    */
    let cancelled = false;
    const find = () => {
      if (cancelled) return;
      setInstalled(groupChoices(discoverChoices(chains)));
    };
    const timers = [setTimeout(find, 0), setTimeout(find, 250), setTimeout(find, 900)];
    window.addEventListener("focus", find);
    return () => {
      cancelled = true;
      for (const timer of timers) clearTimeout(timer);
      window.removeEventListener("focus", find);
    };
  }, [chains]);

  const installedNames = new Set(installed.map((option) => option.name));
  const others = INSTALLABLE.filter((wallet) => !installedNames.has(wallet.name)).filter((wallet) =>
    wallet.chains.some((chain) => chains.includes(chain)),
  );

  // Paso 2: la cadena, cuando la wallet elegida firma en más de una.
  if (chosen !== null) {
    const options = supportedChains(chosen.name, chosen.chains, chains);
    return (
      <div className="connect-step">
        <button type="button" className="connect-back" onClick={() => setChosen(null)}>
          ← Volver
        </button>
        <p className="connect-step-title">
          ¿En qué cadena firmas con {chosen.name}?
        </p>
        <div className="chain-choices">
          {options.map((chain) => (
            <button
              key={chain}
              type="button"
              className="chain-choice"
              disabled={busy}
              onClick={() => {
                const choice = chosen.choices.find((c) => c.chain === chain) ?? chosen.choices[0];
                onPick(choice);
              }}
            >
              {CHAIN_LABEL[chain] ?? chain}
            </button>
          ))}
        </div>
        {error !== null && (
          <p className="label state-error" role="alert">
            {error}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="connect-step">
      {busy && (
        // El estado va en el mismo panel: nada se abre encima.
        <p className="connect-working" role="status">
          <span className="spinner" aria-hidden="true" />
          Confirma en tu wallet…
        </p>
      )}

      {error !== null && !busy && (
        <p className="label state-error connect-error" role="alert">
          {error}
        </p>
      )}

      {installed.length > 0 && (
        <>
          <p className="connect-section">Instaladas</p>
          <ul className="wallet-choices">
            {installed.map((option) => {
              const shown = supportedChains(option.name, option.chains, chains);
              return (
                <li key={option.name}>
                  <button
                    type="button"
                    className="wallet-choice"
                    disabled={busy}
                    onClick={() => {
                      // Una sola cadena: no hay nada que preguntar.
                      if (shown.length <= 1) {
                        const choice =
                          option.choices.find((c) => c.chain === shown[0]) ?? option.choices[0];
                        onPick(choice);
                        return;
                      }
                      setChosen(option);
                    }}
                  >
                    {option.icon !== undefined ? (
                      // El ícono lo publica la extensión, como data URI.
                      // eslint-disable-next-line @next/next/no-img-element -- data URI
                      <img alt="" aria-hidden="true" className="wallet-choice-icon" src={option.icon} />
                    ) : (
                      <Monogram name={option.name} />
                    )}
                    <span className="wallet-choice-name">{option.name}</span>
                    <Chips chains={shown} />
                    <span className="wallet-badge">Detectada</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      )}

      {others.length > 0 && (
        <>
          <p className="connect-section">Otras</p>
          <ul className="wallet-choices">
            {others.map((wallet) => (
              <li key={wallet.name}>
                <a
                  className="wallet-choice is-install"
                  href={wallet.url}
                  target="_blank"
                  rel="noreferrer noopener"
                >
                  {missingLogos.has(wallet.slug) ? (
                    <Monogram name={wallet.name} />
                  ) : (
                    // eslint-disable-next-line @next/next/no-img-element -- asset propio del brand kit
                    <img
                      alt=""
                      aria-hidden="true"
                      className="wallet-choice-icon"
                      src={`/wallets/${wallet.slug}.svg`}
                      onError={() =>
                        setMissingLogos((current) => new Set(current).add(wallet.slug))
                      }
                    />
                  )}
                  <span className="wallet-choice-name">{wallet.name}</span>
                  <Chips chains={wallet.chains.filter((chain) => chains.includes(chain))} />
                  <span className="wallet-install">Instalar →</span>
                </a>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
