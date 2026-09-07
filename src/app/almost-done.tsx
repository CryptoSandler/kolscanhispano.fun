"use client";

import { useState } from "react";
import type { Chain } from "@/lib/chain";
import { truncateAddressLong } from "@/lib/truncate";
import { WalletStep } from "./wallet-step";
import type { Choice } from "./wallet-choice";

/**
 * `Casi listo`: tres controles y un botón, y nada más.
 *
 * **Era un muro de texto.** Cada control arrastraba dos o tres frases —el PnL
 * suma todas las wallets, qué cadenas se indexan, qué pasa al publicar— y el
 * CTA quedaba abajo de todo, fuera de pantalla a 390. `docs/copy.md` fija ahora
 * la regla que faltaba: **en un modal, una línea de ayuda por control**.
 *
 * Lo que se sacó no se perdió: vive en el `?` de la fila de la wallet y en el
 * perfil, que es donde alguien va a buscarlo cuando lo necesite.
 */

const CHAIN_LABEL: Record<string, string> = {
  solana: "Solana",
  robinhood: "Robinhood",
  bnb: "BNB",
  ethereum: "ETH",
};

export type Proven = {
  id: string;
  address: string;
  chain: Chain;
  signature: string;
  nonce: string;
  expiresAt: string;
};

export function AlmostDone({
  wallets,
  error,
  busy,
  onSubmit,
  onAddAnother,
  picking,
  onPickAnother,
  onCancelPick,
  chains,
}: {
  wallets: Proven[];
  error: string | null;
  busy: boolean;
  onSubmit: (result: { handle: string; publicWalletIds: string[] }) => void;
  onAddAnother: () => void;
  picking: Choice[] | null;
  onPickAnother: (choice: Choice) => void;
  onCancelPick: () => void;
  chains: readonly Chain[];
}) {
  const [handle, setHandle] = useState("");
  const [publicIds, setPublicIds] = useState<Set<string>>(new Set());
  const [explain, setExplain] = useState(false);

  // Agregar otra wallet reemplaza el contenido del panel, no abre otro encima.
  if (picking !== null) {
    return (
      /*
        El chevron lo dibuja `WalletStep`, no esta pantalla. Acá había un
        `← Volver` propio que se superponía con el del paso de chain cuando la
        wallet elegida firmaba en más de una cadena: dos controles de volver en
        el mismo píxel, cada uno volviendo a un lugar distinto.
      */
      <WalletStep
        chains={chains}
        busy={busy}
        error={error}
        onPick={onPickAnother}
        onBack={onCancelPick}
      />
    );
  }

  return (
    <div className="connect-step">
      {/*
        **Sin subtítulo.** Decía `Casi listo` debajo de `Conecta tu wallet`, y
        dos títulos encima del mismo formulario son dos nombres para el mismo
        paso. El título del modal alcanza.
      */}
      <ul className="almost-wallets">
        {wallets.map((wallet) => {
          const isPublic = publicIds.has(wallet.id);
          return (
            <li key={wallet.id} className="almost-wallet">
              <span className="wallet-choice-chain">{CHAIN_LABEL[wallet.chain] ?? wallet.chain}</span>
              <span className="almost-address">{truncateAddressLong(wallet.address)}</span>
              <button
                type="button"
                className={`visibility-toggle ${isPublic ? "is-public" : ""}`}
                aria-pressed={isPublic}
                onClick={() =>
                  setPublicIds((current) => {
                    const next = new Set(current);
                    if (next.has(wallet.id)) next.delete(wallet.id);
                    else next.add(wallet.id);
                    return next;
                  })
                }
              >
                {isPublic ? "Pública" : "Privada"}
              </button>
            </li>
          );
        })}
      </ul>

      {/* Una línea, y el resto detrás del `?`. */}
      <p className="control-help">
        Privada por defecto. Pública muestra la dirección; una vez pública no se puede ocultar.{" "}
        <button
          type="button"
          className="help-toggle"
          aria-expanded={explain}
          onClick={() => setExplain((current) => !current)}
        >
          ?
        </button>
      </p>

      {explain && (
        <p className="control-help is-expanded">
          El PnL suma todas tus wallets, publiques o no cuáles son. Se indexan las cadenas que el
          sitio tiene encendidas; las demás se pueden agregar y quedan esperando. Todo esto se
          cambia después desde tu perfil.
        </p>
      )}

      {/*
        **Agregar otra wallet va acá**, pegado a la tarjeta de la primera y
        antes del campo de X: es una acción sobre las wallets, y abajo de todo
        quedaba lejos de lo que modifica. Con forma propia —fondo tenue y borde
        punteado— para que se lea como un control y no como un enlace suelto.
      */}
      <button type="button" className="add-another" onClick={onAddAnother} disabled={busy}>
        <span aria-hidden="true">+</span> Conectar otra wallet
      </button>

      <label className="almost-field">
        <span className="label">Tu usuario de X</span>
        <input
          value={handle}
          onChange={(event) => setHandle(event.target.value)}
          placeholder="@usuario"
          autoComplete="off"
          spellCheck={false}
        />
      </label>
      <p className="control-help">Después publicas un tweet con tu código para verificar.</p>

      {error !== null && (
        <p className="label state-error" role="alert">
          {error}
        </p>
      )}

      <button
        type="button"
        className="cta connect-cta"
        disabled={busy || handle.trim() === ""}
        onClick={() =>
          onSubmit({ handle: handle.trim(), publicWalletIds: [...publicIds] })
        }
      >
        Entrar al ranking
      </button>

    </div>
  );
}
