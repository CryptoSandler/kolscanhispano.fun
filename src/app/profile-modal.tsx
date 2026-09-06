"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Chain } from "@/lib/chain";
import type { Profile, ProfileWallet } from "@/lib/profile";
import { VerifiedTick } from "./verified-tick";

/**
 * El perfil del KOL, en un modal. Copia el flujo del molde
 * (`docs/clone-map.md` §11) y no su estética.
 *
 * Lo que el molde tiene y esto tiene: `Mis wallets` agrupadas por cadena,
 * `+ Agregar` pegando la dirección, la etiqueta `validada` sólo en las
 * firmadas, un ojo por wallet, `Ocultar todas`, `Actualizar PnL` y
 * `Exportar PnL Card`.
 *
 * Lo que cambia: la jerarquía. El molde mezcla tamaños y apoya todo sobre el
 * mismo gris; acá las wallets son tarjetas con el fondo y el borde de las filas
 * del ranking, el espaciado es 8/16/24 y hay un solo tamaño por nivel.
 */

const CHAIN_LABEL: Record<string, string> = {
  solana: "Solana",
  robinhood: "Robinhood",
  bnb: "BNB Chain",
  ethereum: "Ethereum",
};

const CHAIN_TINT: Record<string, string> = {
  solana: "is-chain-sol",
  robinhood: "is-chain-eth",
  ethereum: "is-chain-eth",
  bnb: "is-chain-bnb",
};

const MESSAGES: Record<string, string> = {
  address_taken: "Esta wallet ya está registrada por otro KOL.",
  already_yours: "Esta wallet ya está en tu perfil.",
  address_chain_mismatch: "Esa dirección no es de la cadena elegida.",
  bad_address: "Esa dirección no tiene un formato válido.",
  bad_chain: "Esa cadena no está disponible todavía.",
  too_many_wallets: "Llegaste al máximo de wallets.",
  unauthorized: "Tu sesión venció. Vuelve a entrar.",
};

export function ProfileModal({
  profile,
  onClose,
  onChanged,
}: {
  profile: Profile;
  onClose: () => void;
  onChanged: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    const dialog = ref.current;
    if (dialog !== null && !dialog.open) dialog.showModal();
  }, []);

  const call = useCallback(
    async (input: RequestInfo, init: RequestInit) => {
      setBusy(true);
      setError(null);
      try {
        const response = await fetch(input, init);
        if (!response.ok) {
          const body = (await response.json().catch(() => ({}))) as { error?: string };
          setError(MESSAGES[body.error ?? ""] ?? "No se pudo completar. Prueba de nuevo.");
          return null;
        }
        onChanged();
        return response;
      } finally {
        setBusy(false);
      }
    },
    [onChanged],
  );

  const byChain = new Map<Chain, ProfileWallet[]>();
  for (const wallet of profile.wallets) {
    byChain.set(wallet.chain, [...(byChain.get(wallet.chain) ?? []), wallet]);
  }

  return (
    <dialog
      ref={ref}
      className="modal-profile"
      aria-labelledby="profile-title"
      onCancel={(event) => {
        // Sólo si el `cancel` es de este diálogo: React simula el burbujeo y un
        // diálogo anidado se llevaría éste puesto. Ver `connect-wallet.tsx`.
        if (event.target !== ref.current) return;
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === ref.current) onClose();
      }}
    >
      <div className="modal-card">
        <button type="button" className="modal-close" onClick={onClose} aria-label="Cerrar">
          ×
        </button>

        <header className="profile-head">
          {/* eslint-disable-next-line @next/next/no-img-element -- ruta propia. */}
          <img src={profile.avatarUrl} alt="" width={48} height={48} className="profile-avatar" />
          <div>
            <h2 id="profile-title" className="headline">
              {profile.name}
            </h2>
            <p className="profile-handle">
              @{profile.handle}
              <VerifiedTick verified={profile.handleVerified} />
              {profile.cabalTag !== null && <span className="cabal-chip">{profile.cabalTag}</span>}
            </p>
          </div>
        </header>

        <section className="profile-section">
          <div className="profile-section__head">
            <h3 className="label">Mis wallets</h3>
            <button
              type="button"
              className="panel-link"
              disabled={busy || profile.wallets.length === 0}
              onClick={() =>
                void call("/api/perfil/wallets", {
                  method: "PATCH",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ all: true }),
                })
              }
            >
              Ocultar todas
            </button>
          </div>

          {profile.wallets.length === 0 && (
            <p className="label">Todavía no agregaste ninguna wallet.</p>
          )}

          {[...byChain.entries()].map(([chain, wallets]) => (
            <div key={chain} className="profile-chain">
              <span className={`chain-badge ${CHAIN_TINT[chain] ?? ""}`}>
                {CHAIN_LABEL[chain] ?? chain}
              </span>
              <ul className="profile-wallets">
                {wallets.map((wallet) => (
                  <WalletRow
                    key={wallet.id}
                    wallet={wallet}
                    busy={busy}
                    onToggle={() =>
                      void call("/api/perfil/wallets", {
                        method: "PATCH",
                        headers: { "content-type": "application/json" },
                        body: JSON.stringify({ walletId: wallet.id, isPublic: !wallet.isPublic }),
                      })
                    }
                    onValidated={onChanged}
                  />
                ))}
              </ul>
            </div>
          ))}

          {adding ? (
            <AddWallet
              busy={busy}
              onCancel={() => setAdding(false)}
              onSubmit={async (address, chain) => {
                const response = await call("/api/perfil/wallets", {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ address, chain }),
                });
                if (response !== null) setAdding(false);
              }}
            />
          ) : (
            <button type="button" className="cta profile-add" onClick={() => setAdding(true)}>
              + Agregar
            </button>
          )}

          {error !== null && (
            <p className="label state-error" role="alert">
              {error}
            </p>
          )}
        </section>

        <section className="profile-actions">
          <button
            type="button"
            className="segment"
            disabled={busy}
            onClick={() => void call("/api/perfil/pnl", { method: "POST" })}
          >
            Actualizar PnL
          </button>
          <a className="segment" href={`/api/perfil/pnl-card`} download>
            Exportar PnL Card
          </a>
        </section>
      </div>
    </dialog>
  );
}

/**
 * Una wallet: badge de cadena, dirección `6...4`, su estado y el ojo.
 *
 * **`validada` es la única etiqueta pública**, como en el molde. Una wallet
 * pegada no lleva contra-etiqueta pública: lo que ve su dueño es
 * `Esperando validación` con el botón para firmar, y eso vive acá adentro, que
 * es su perfil.
 */
function WalletRow({
  wallet,
  busy,
  onToggle,
  onValidated,
}: {
  wallet: ProfileWallet;
  busy: boolean;
  onToggle: () => void;
  onValidated: () => void;
}) {
  const [message, setMessage] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  /**
   * Firmar con la wallet que esta fila nombra.
   *
   * El servidor emite el nonce, dice qué dirección tiene que firmar, y si la
   * conectada es otra responde `wrong_wallet` **sin gastar el nonce** — así que
   * cambiar de wallet en la extensión y volver a tocar `Validar` alcanza.
   */
  const validate = useCallback(async () => {
    setWorking(true);
    setMessage(null);
    try {
      const issued = await fetch("/api/perfil/validar", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ walletId: wallet.id }),
      });
      if (!issued.ok) {
        setMessage("No se pudo empezar la validación.");
        return;
      }
      const { nonce, expiresAt, chain, expect } = (await issued.json()) as {
        nonce: string;
        expiresAt: string;
        chain: Chain;
        expect: string;
      };

      const { connectChoice, discoverChoices, signChoice } = await import("./wallet-choice");
      const { PROOF_DOMAIN, proofMessage } = await import("@/lib/wallet-proof");
      const choices = discoverChoices([chain]);
      if (choices.length === 0) {
        setMessage("No hay ninguna wallet instalada en este navegador.");
        return;
      }
      const address = await connectChoice(choices[0]);
      /*
        El texto lo arma `proofMessage`, no esta pantalla. Es el mismo que el
        servidor vuelve a armar para verificar: dos redacciones del mismo
        mensaje serían dos firmas que nunca coinciden.
      */
      const signature = await signChoice(
        choices[0],
        address,
        proofMessage({ domain: PROOF_DOMAIN, address, chain, action: "agregar wallet", nonce, expiresAt }),
      );

      const response = await fetch("/api/perfil/validar", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ walletId: wallet.id, address, signature, nonce, expiresAt }),
      });
      if (response.ok) {
        onValidated();
        return;
      }
      const body = (await response.json().catch(() => ({}))) as {
        error?: string;
        expect?: string;
        connected?: string;
      };
      if (body.error === "wrong_wallet") {
        // El mensaje del molde: cuál hay que poner y cuál está puesta.
        setMessage(
          `Cambia a la wallet ${body.expect ?? expect} en tu extensión y toca Validar de nuevo. ` +
            `Conectada ahora: ${body.connected ?? "otra"}`,
        );
        return;
      }
      setMessage("No se pudo validar. Prueba de nuevo.");
    } catch {
      setMessage("La wallet no completó la firma.");
    } finally {
      setWorking(false);
    }
  }, [wallet.id, onValidated]);

  return (
    <li className="profile-wallet">
      <span className="profile-wallet__address">{wallet.address}</span>

      {wallet.verified ? (
        <span className="chip-validated">validada</span>
      ) : (
        <span className="chip-pending">Esperando validación</span>
      )}

      {!wallet.verified && (
        <button type="button" className="panel-link" disabled={busy || working} onClick={validate}>
          Validar
        </button>
      )}

      {/*
        El ojo: `is_public`. Es la única cosa de esta pantalla que cambia lo que
        ve un desconocido, así que dice en palabras en qué estado está y no sólo
        con el dibujo.
      */}
      <button
        type="button"
        className={`eye ${wallet.isPublic ? "is-on" : ""}`}
        disabled={busy}
        onClick={onToggle}
        aria-pressed={wallet.isPublic}
        title={wallet.isPublic ? "Visible en tu fila" : "Oculta"}
      >
        <span className="sr-only">
          {wallet.isPublic ? "Ocultar esta wallet" : "Mostrar esta wallet"}
        </span>
        <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
          <path
            d="M1 8s2.5-4.5 7-4.5S15 8 15 8s-2.5 4.5-7 4.5S1 8 1 8z"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
          />
          <circle cx="8" cy="8" r="2" fill="currentColor" />
          {!wallet.isPublic && (
            <path d="M3 13L13 3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          )}
        </svg>
      </button>

      {message !== null && (
        <p className="label state-error profile-wallet__message" role="alert">
          {message}
        </p>
      )}
    </li>
  );
}

/**
 * El campo de pegar, con detección de cadena por formato.
 *
 * `0x` más 40 hex puede ser tres cadenas distintas —la misma dirección es una
 * wallet distinta en cada una (`migrations/011`)— así que ahí **se pregunta**.
 * Base58 es Solana y no hay nada que preguntar: el selector no aparece.
 */
function AddWallet({
  busy,
  onCancel,
  onSubmit,
}: {
  busy: boolean;
  onCancel: () => void;
  onSubmit: (address: string, chain: Chain) => void | Promise<void>;
}) {
  const [address, setAddress] = useState("");
  const [chains, setChains] = useState<Chain[]>([]);
  const [chain, setChain] = useState<Chain | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const { chainsForAddress } = await import("@/lib/chain");
      if (cancelled) return;
      // Las cadenas activas las decide el servidor; acá sólo se mira la forma.
      const options = chainsForAddress(address, {
        CHAIN_ROBINHOOD_INGESTION: "on",
        CHAIN_BNB_INGESTION: "on",
        CHAIN_ETHEREUM_INGESTION: "on",
      });
      setChains(options);
      setChain(options.length === 1 ? options[0] : null);
    })();
    return () => {
      cancelled = true;
    };
  }, [address]);

  return (
    <div className="profile-add-form">
      <label className="sr-only" htmlFor="new-wallet">
        Dirección de la wallet
      </label>
      <input
        id="new-wallet"
        value={address}
        onChange={(event) => setAddress(event.target.value)}
        placeholder="Pega la dirección"
        autoComplete="off"
        spellCheck={false}
      />

      {chains.length > 1 && (
        <select
          value={chain ?? ""}
          onChange={(event) => setChain(event.target.value as Chain)}
          aria-label="Cadena"
        >
          <option value="">Elige la cadena</option>
          {chains.map((option) => (
            <option key={option} value={option}>
              {CHAIN_LABEL[option] ?? option}
            </option>
          ))}
        </select>
      )}

      {address.trim() !== "" && chains.length === 0 && (
        <p className="label state-error">Esa dirección no parece de Solana ni de una EVM.</p>
      )}

      <button
        type="button"
        className="cta"
        disabled={busy || chain === null}
        onClick={() => chain !== null && void onSubmit(address, chain)}
      >
        Agregar
      </button>
      <button type="button" className="segment" onClick={onCancel}>
        Cancelar
      </button>
    </div>
  );
}
