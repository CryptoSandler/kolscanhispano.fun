"use client";

import { useEffect, useRef } from "react";
import type { StandardWallet } from "@/lib/wallet-standard";

/**
 * The chooser `/registro` opens once it knows which wallets are installed.
 *
 * **It renders what discovery found and nothing else.** There is no list in this
 * file, no ordering by preference and no name anywhere: a wallet is a row
 * because it registered itself and declared a Solana chain and message signing
 * (`wallet-standard.ts`), so the day a reader installs a new one it appears here
 * with no change to this repository.
 *
 * A native `<dialog>`, for the reasons `kol-modal-host.tsx` already sets out —
 * the platform gives focus trapping, `Esc`, inertness of the page behind, and
 * the top layer, and every one of those is a thing to get wrong by hand.
 *
 * The wallet's own icon is rendered when it ships one. It is a `data:` URI in
 * every wallet observed, which is why it can be used directly: it is not a
 * request to a third party, so it does not put anyone in the reader's request
 * path. A wallet with no icon gets its initial, the same fallback the avatar
 * takes.
 */
/**
 * What the chooser needs from a wallet: a name to show and a chain to label it
 * with. Deliberately structural rather than a union of the two wallet types —
 * this component has no business knowing which handshake found a row.
 */
/** The chains a row may name, spelled for a reader. `chain.ts` is the source. */
const CHAIN_LABEL: Record<string, string> = {
  solana: "Solana",
  robinhood: "Robinhood",
  bnb: "BNB",
  ethereum: "Ethereum",
};

/**
 * Una fila del selector: una **wallet**, con las cadenas que soporta.
 *
 * Era `{ name, chain }` —una fila por cadena— y en el gate se vio el problema:
 * Phantom habla los dos handshakes, así que salían dos filas que decían
 * `Phantom` y no se distinguían. Ahora la fila es la wallet y las cadenas son
 * chips; si al elegirla hay más de una, la cadena se pregunta después.
 */
export type PickableWallet = { name: string; chains: readonly string[]; icon?: string };

/** Dónde manda a alguien que no tiene ninguna wallet EVM instalada. */
const METAMASK_URL = "https://metamask.io/download/";

export function WalletPicker({
  wallets,
  onPick,
  onCancel,
  needsEvm = false,
}: {
  /**
   * **A row is a name and a chain, and nothing else.** It was
   * `readonly StandardWallet[]` while Solana was the only namespace; EIP-6963
   * wallets arrive through a different handshake and have no `features` map, so
   * the chooser stopped taking wallets and started taking rows. What it must
   * never take is anything it could *call* — it picks, the caller connects.
   */
  wallets: readonly PickableWallet[];
  onPick: (wallet: PickableWallet) => void;
  onCancel: () => void;
  /**
   * Si hay que ofrecer instalar una wallet EVM.
   *
   * Lo decide el que llama, no esta lista: depende de qué cadenas están
   * activas, y eso lo sabe el servidor. Una fila `Instalar MetaMask` en un sitio
   * donde ninguna cadena EVM está prendida sería un control que no funciona.
   */
  needsEvm?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog || dialog.open) return;
    dialog.showModal();
  }, []);

  return (
    <dialog
      className="modal-wallets"
      ref={ref}
      aria-labelledby="wallet-picker-title"
      // `Esc` and the backdrop both mean "not now", and both land here rather
      // than leaving a dialog the page thinks is still open.
      onCancel={(event) => {
        event.preventDefault();
        onCancel();
      }}
      onClick={(event) => {
        if (event.target === ref.current) onCancel();
      }}
    >
      <div className="wallet-card">
        <header className="card-head">
          <h2 className="headline" id="wallet-picker-title">
            Elige tu wallet
          </h2>
        </header>

        <ul className="wallet-choices">
          {wallets.map((wallet) => (
            <li key={wallet.name}>
              <button type="button" className="wallet-choice" onClick={() => onPick(wallet)}>
                {wallet.icon ? (
                  /*
                    **El ícono lo trae la wallet**, como data URI, por Wallet
                    Standard o por EIP-6963. Nunca un asset nuestro: dibujar el
                    logo de una marca ajena es peor que no dibujarlo, y una
                    lista con íconos propios mentiría sobre qué hay instalado.

                    El nombre ya es el texto del botón, así que el ícono es
                    decorativo y anunciarlo de nuevo sería ruido.
                  */
                  // eslint-disable-next-line @next/next/no-img-element -- data URI de la extensión
                  <img alt="" aria-hidden="true" className="wallet-choice-icon" src={wallet.icon} />
                ) : (
                  <span aria-hidden="true" className="wallet-choice-icon is-monogram">
                    {wallet.name.slice(0, 1)}
                  </span>
                )}
                <span className="wallet-choice-name">{wallet.name}</span>
                {/* Un chip por cadena que esta wallet puede firmar acá. Nunca
                    lleva una dirección. */}
                <span className="wallet-choice-chains">
                  {wallet.chains.map((chain) => (
                    <span key={chain} className="wallet-choice-chain">
                      {CHAIN_LABEL[chain] ?? chain}
                    </span>
                  ))}
                </span>
              </button>
            </li>
          ))}

          {/*
            **`Instalar MetaMask` sólo cuando no hay ninguna wallet EVM.**

            Sin ícono, a propósito: no tenemos su logo y no vamos a dibujarlo.
            Es la única fila de esta lista que no es una wallet instalada, así
            que se ve distinta y lleva el enlace oficial.
          */}
          {needsEvm && (
            <li>
              <a
                className="wallet-choice is-install"
                href={METAMASK_URL}
                target="_blank"
                rel="noreferrer noopener"
              >
                <span aria-hidden="true" className="wallet-choice-icon is-monogram">
                  +
                </span>
                <span className="wallet-choice-name">Instalar MetaMask</span>
                <span className="wallet-choice-chains">
                  <span className="wallet-choice-chain">EVM</span>
                </span>
              </a>
            </li>
          )}
        </ul>

        <p className="label onboarding-note">
          Aparecen las wallets instaladas en este navegador. Firmas con una para entrar; después
          puedes agregar todas las que quieras desde tu perfil.
        </p>

        <button type="button" className="segment" onClick={onCancel}>
          Cancelar
        </button>
      </div>
    </dialog>
  );
}
