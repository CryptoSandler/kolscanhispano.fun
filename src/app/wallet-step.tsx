"use client";

import { useEffect, useState } from "react";
import type { Chain } from "@/lib/chain";
import { CONNECT_LEAD } from "./connect-wallet";
import { supportedChains } from "@/lib/wallet-support";
import {
  discoverChoices,
  groupChoices,
  type Choice,
  type WalletOption,
} from "./wallet-choice";

/**
 * El selector de wallets: una lista fija, con logo y nombre, y nada más.
 *
 * **Versión final del dueño, 2026-09-06.** Las anteriores mostraban lo que el
 * navegador había encontrado —secciones `Instaladas` y `Otras`, chips de cadena,
 * badges `Detectada`, enlaces `Instalar →`— y eso convertía una lista de tres
 * marcas en un informe sobre el estado de las extensiones. Ahora:
 *
 * - **Siempre las mismas tres, en el mismo orden**: Phantom, MetaMask, Rabby.
 *   Un lector que abre esto dos veces ve lo mismo las dos veces.
 * - **Sólo logo y nombre.** Nada anuncia antes del clic si está instalada o no,
 *   ni en qué cadenas firma: son cosas que importan *después* de elegir.
 * - **`Mostrar más`** despliega Backpack, Solflare y Trust Wallet.
 *
 * Lo que pasa al hacer clic depende de lo que haya, y recién ahí: si está
 * instalada, conecta —y si firma en más de una cadena, la pregunta viene
 * después, en este mismo panel—; si no está, se abre su página oficial y queda
 * una línea debajo de la fila.
 */

const CHAIN_LABEL: Record<string, string> = {
  solana: "Solana",
  robinhood: "Robinhood",
  bnb: "BNB",
  ethereum: "ETH",
};

type Listed = { name: string; slug: string; url: string };

/** Las tres de siempre, en este orden. */
const PRIMARY: Listed[] = [
  { name: "Phantom", slug: "phantom", url: "https://phantom.com/download" },
  { name: "MetaMask", slug: "metamask", url: "https://metamask.io/download/" },
  { name: "Rabby", slug: "rabby", url: "https://rabby.io/" },
];

/** Las que aparecen al tocar `Mostrar más`. */
const SECONDARY: Listed[] = [
  { name: "Backpack", slug: "backpack", url: "https://backpack.app/download" },
  { name: "Solflare", slug: "solflare", url: "https://solflare.com/download" },
  {
    name: "Trust Wallet",
    slug: "trust",
    url: "https://trustwallet.com/download",
  },
];

/**
 * `Rabby` y `Rabby Wallet` son la misma extensión con dos nombres según el
 * handshake. Se normaliza para que la fila de la lista encuentre la instalada
 * sin importar cuál de los dos reportó.
 */
function normalise(name: string): string {
  return name
    .toLowerCase()
    .replace(/\s*wallet$/, "")
    .trim();
}

/**
 * Las cadenas que **se le pueden ofrecer** a una wallet acá: las que la tabla
 * dice que soporta, cruzadas con las que este sitio indexa, y cruzadas otra vez
 * con **las que esa wallet anunció en este navegador**.
 *
 * El tercer cruce evita un error real. La tabla dice que Phantom firma en
 * Robinhood, y es cierto; pero si en este navegador Phantom se anunció sólo por
 * Wallet Standard, lo único que tenemos es un `Choice` de Solana. Ofrecer
 * Robinhood ahí terminaba en `choices.find(...) ?? choices[0]`, o sea firmando
 * en Solana un mensaje que decía Robinhood.
 *
 * Lo que la tabla aporta sigue siendo **recortar**: una wallet que anuncia una
 * cadena que no soporta no la ofrece igual.
 */
function offerable(option: WalletOption, active: readonly Chain[]): Chain[] {
  const supported = supportedChains(option.name, option.chains, active);
  const announced = new Set<string>(option.choices.map((choice) => choice.chain));
  return supported.filter((chain) => announced.has(chain));
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
  const [expanded, setExpanded] = useState(false);
  const [missingLogo, setMissingLogo] = useState<Set<string>>(new Set());
  /** La wallet que se tocó y no estaba: su fila muestra la línea de abajo. */
  const [absent, setAbsent] = useState<string | null>(null);

  useEffect(() => {
    /*
      Se busca más de una vez. Una extensión que responde el `app-ready` unos
      milisegundos más tarde —porque se está desbloqueando— no aparecía nunca
      con una sola pasada, y no había nada que reintentar. `focus` cubre además
      el caso de instalarla en otra pestaña y volver, que es exactamente lo que
      la línea `Instálala y vuelve a intentar` invita a hacer.
    */
    let cancelled = false;
    const find = () => {
      if (cancelled) return;
      setInstalled(groupChoices(discoverChoices(chains)));
    };
    const timers = [
      setTimeout(find, 0),
      setTimeout(find, 250),
      setTimeout(find, 900),
    ];
    window.addEventListener("focus", find);
    return () => {
      cancelled = true;
      for (const timer of timers) clearTimeout(timer);
      window.removeEventListener("focus", find);
    };
  }, [chains]);

  const byName = new Map(
    installed.map((option) => [normalise(option.name), option]),
  );

  /*
    **Las detectadas que no están en la lista fija.**

    Glow, OKX, la que sea: si el navegador la anunció, se puede firmar con ella,
    y esconderla sería ofrecer menos de lo que hay. Van al final de
    `Mostrar más` con el ícono que anunciaron y en el mismo formato — sin chips,
    como el resto.

    No van arriba: la lista fija es fija justamente para que sea la misma en dos
    lectores distintos, y una wallet que aparece o no según lo que cada uno tenga
    instalado no puede empujar a las que siempre están.
  */
  const known = new Set(
    [...PRIMARY, ...SECONDARY].map((wallet) => normalise(wallet.name)),
  );
  const extras = installed.filter(
    (option) => !known.has(normalise(option.name)),
  );

  // Paso 2: la cadena, sólo si la wallet elegida firma en más de una.
  if (chosen !== null) {
    const options = offerable(chosen, chains);
    return (
      <div className="connect-step">
        {/*
          `← Volver` va **en la fila del título**, no suelto arriba: suelto
          empujaba el encabezado hacia abajo y el paso quedaba más alto que la
          lista, que es lo que el dueño marcó en el gate.
        */}
        <div className="connect-step-head">
          <button type="button" className="connect-back" onClick={() => setChosen(null)}>
            ← Volver
          </button>
          <h3 className="connect-step-title">¿Con qué chain firmas con {chosen.name}?</h3>
        </div>

        {/*
          Tarjetas iguales en grilla. Cada una lleva el color de su cadena —el
          mismo vocabulario de color que las columnas del ranking— como fondo
          tenue, y ese color pasa al borde en hover y foco.

          La grilla **estira** para llenar el alto de la lista: el panel no
          cambia de tamaño entre pasos, así que dos o tres opciones ocupan lo
          que ocupaban las tres filas de wallets en vez de dejar un hueco.
        */}
        <div className="chain-choices">
          {options.map((chain) => (
            <button
              key={chain}
              type="button"
              className={`chain-choice is-chain-${chain}`}
              disabled={busy}
              onClick={() => {
                const choice = chosen.choices.find((c) => c.chain === chain) ?? chosen.choices[0];
                onPick(choice);
              }}
            >
              <span className="chain-choice-dot" aria-hidden="true" />
              <span className="chain-choice-name">{CHAIN_LABEL[chain] ?? chain}</span>
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

  const row = (wallet: Listed) => {
    const found = byName.get(normalise(wallet.name));
    // El ícono de la extensión si está; si no, el SVG del brand kit; y si ese
    // archivo todavía no llegó, la inicial en un círculo. Nunca uno inventado.
    const icon =
      found?.icon ??
      (missingLogo.has(wallet.slug) ? null : `/wallets/${wallet.slug}.svg`);

    return (
      <li key={wallet.name}>
        <button
          type="button"
          className="wallet-choice"
          disabled={busy}
          onClick={() => {
            if (found === undefined) {
              /*
                No estaba. Se abre su página oficial en una pestaña nueva y la
                fila explica qué hacer al volver. **Nada de esto se anuncia
                antes del clic**: la lista no dice quién está instalada.
              */
              window.open(wallet.url, "_blank", "noopener,noreferrer");
              setAbsent(wallet.name);
              return;
            }
            setAbsent(null);
            const shown = offerable(found, chains);
            if (shown.length <= 1) {
              onPick(
                found.choices.find((c) => c.chain === shown[0]) ??
                  found.choices[0],
              );
              return;
            }
            setChosen(found);
          }}
        >
          {icon !== null ? (
            // eslint-disable-next-line @next/next/no-img-element -- data URI de la extensión o SVG propio
            <img
              alt=""
              aria-hidden="true"
              className="wallet-choice-icon"
              src={icon}
              onError={() =>
                setMissingLogo((current) => new Set(current).add(wallet.slug))
              }
            />
          ) : (
            <span aria-hidden="true" className="wallet-choice-icon is-monogram">
              {wallet.name.slice(0, 1)}
            </span>
          )}
          <span className="wallet-choice-name">{wallet.name}</span>
        </button>

        {absent === wallet.name && (
          <p className="wallet-absent" role="status">
            Instálala y vuelve a intentar.
          </p>
        )}
      </li>
    );
  };

  return (
    <div className="connect-step">
      {/*
        La línea de privacidad se dice **una vez, en la lista**. Vivía en el
        diálogo, así que se repetía en el paso de chain y en `Casi listo` — y
        para entonces el lector ya la leyó.
      */}
      <p className="connect-lead">{CONNECT_LEAD}</p>

      {busy && (
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

      <ul className="wallet-choices">{PRIMARY.map(row)}</ul>

      {expanded ? (
        <ul className="wallet-choices">
          {SECONDARY.map(row)}
          {/* Y las detectadas que no están en la lista fija, al final. */}
          {extras.map((option) => (
            <li key={option.name}>
              <button
                type="button"
                className="wallet-choice"
                disabled={busy}
                onClick={() => {
                  setAbsent(null);
                  const shown = supportedChains(
                    option.name,
                    option.chains,
                    chains,
                  );
                  if (shown.length <= 1) {
                    onPick(
                      option.choices.find((c) => c.chain === shown[0]) ??
                        option.choices[0],
                    );
                    return;
                  }
                  setChosen(option);
                }}
              >
                {option.icon !== undefined ? (
                  // El ícono que anunció la extensión, como data URI. Nunca uno
                  // nuestro: de estas wallets no tenemos ni el logo ni por qué.
                  // eslint-disable-next-line @next/next/no-img-element -- data URI
                  <img
                    alt=""
                    aria-hidden="true"
                    className="wallet-choice-icon"
                    src={option.icon}
                  />
                ) : (
                  <span
                    aria-hidden="true"
                    className="wallet-choice-icon is-monogram"
                  >
                    {option.name.slice(0, 1)}
                  </span>
                )}
                <span className="wallet-choice-name">{option.name}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <button
          type="button"
          className="connect-secondary"
          onClick={() => setExpanded(true)}
        >
          Mostrar más
        </button>
      )}
    </div>
  );
}
