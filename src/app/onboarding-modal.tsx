"use client";

import { useState } from "react";
import { activeChains, type Chain } from "@/lib/chain";
import { normalizeXHandle } from "@/lib/x-handle";

/**
 * `¡Casi listo!` — the last screen of registration, spec §6.
 *
 * The reader has proved one or more wallets and has two things left to decide:
 * which of those wallets to publish, and what their X handle is. Both are on
 * one screen because neither is worth a step of its own, and a flow that asks
 * three questions on three screens is one people abandon on the second.
 *
 * **The address is shown, truncated, and that is not a contradiction of the
 * public invariant.** `address-invariant.test.ts` governs *public* surfaces:
 * a page any reader, scraper or search engine can load. This is the owner's
 * own session, looking at the wallets they connected a moment ago, and with
 * two wallets on screen there is no way to set the right switch on the right
 * row without being able to tell them apart. It is their address, shown to
 * them. Nothing here is reachable from a public page, and nothing here is
 * rendered by the feed, the ranking or the KOL modal.
 */

export type OnboardingWallet = {
  id: string;
  chain: Chain;
  /** The owner's own address, shown truncated so two rows can be told apart. */
  address: string;
};

/** Short, neutral labels. Not tickers: `RBH` is a chain here, never a token. */
const CHAIN_LABEL: Record<Chain, string> = {
  solana: "Solana",
  ethereum: "Ethereum",
  bnb: "BNB Chain",
  robinhood: "Robinhood",
};

/**
 * `Solana`, `Solana y BNB Chain`, `Solana, BNB Chain y Ethereum`.
 *
 * `Intl.ListFormat` rather than a join with a hand-written `y`: Spanish puts
 * no comma before the conjunction, and the rule is already in the platform. It
 * also gets `e` before a word starting in `i`- right, which a hand-rolled join
 * would not until somebody noticed.
 */
function listChains(chains: Chain[]): string {
  return new Intl.ListFormat("es", { style: "long", type: "conjunction" }).format(
    chains.map((chain) => CHAIN_LABEL[chain]),
  );
}

/**
 * `AbCdEf…XyZw`. Six leading characters, four trailing.
 *
 * Six because that is what `address-invariant.test.ts` measured as the point
 * where a base58 slice stops colliding with Spanish prose by accident, and
 * because it is what the reference sites print — a length people can compare
 * against their wallet at a glance.
 */
function truncate(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/**
 * One connected wallet: which chain it is on, which address, and whether it is
 * published.
 *
 * **Two radios, not a toggle.** A single switch labelled `Pública` states one
 * of the two states and leaves the reader to infer the other, and the thing
 * being decided here cannot be undone — a published address stays in caches,
 * in screenshots and in the memory of whoever saw it. Both words are on screen,
 * one of them is selected, and the selected one is the answer.
 *
 * `role="group"` with an `aria-label` naming the wallet, rather than a
 * `<fieldset>` and a `<legend>`. The semantics are what matter — a screen
 * reader has to announce *which* wallet these two radios belong to, or it
 * reads `Pública / Privada` twice with nothing to attach it to — and the
 * fieldset delivered them at the cost of a layout that could not be fixed:
 * a `<legend>` does not participate in its fieldset's flex formatting
 * context, so the identity and the two options stacked instead of sitting on
 * one line, at every width. Caught in the first screenshot of this screen.
 *
 * The radios keep their shared `name`, which is what actually makes them one
 * group to the browser; `role="group"` is what makes them one group to a
 * reader who cannot see the row.
 */
function WalletRow({
  wallet,
  isPublic,
  indexed,
  onChange,
}: {
  wallet: OnboardingWallet;
  isPublic: boolean;
  /** Whether this wallet's chain has live ingestion. See {@link activeChains}. */
  indexed: boolean;
  onChange: (isPublic: boolean) => void;
}) {
  const name = `visibilidad-${wallet.id}`;
  const label = `${CHAIN_LABEL[wallet.chain]} ${truncate(wallet.address)}`;
  return (
    <li className="row-wallet">
      <div className="wallet-visibility" role="group" aria-label={`Visibilidad de ${label}`}>
        <span className="wallet-identity">
          <span className="chip-chain">{CHAIN_LABEL[wallet.chain]}</span>
          <span className="num wallet-address">{truncate(wallet.address)}</span>
        </span>
        <div className="visibility-group">
          <label className="visibility-option">
            <input
              type="radio"
              name={name}
              value="publica"
              checked={isPublic}
              disabled={!indexed}
              onChange={() => onChange(true)}
            />
            Pública
          </label>
          <label className="visibility-option">
            <input
              type="radio"
              name={name}
              value="privada"
              checked={!isPublic}
              disabled={!indexed}
              onChange={() => onChange(false)}
            />
            Privada
          </label>
        </div>
      </div>
    </li>
  );
}

/**
 * The screen.
 *
 * `wallets` arrives from the server; `onSubmit` receives the decisions. This
 * component owns no persistence and knows no endpoint — the same split every
 * other component in this app makes, and what lets it be rendered and asserted
 * with no database.
 */
export function OnboardingModal({
  wallets,
  available = activeChains(),
  onSubmit,
}: {
  wallets: OnboardingWallet[];
  /**
   * The chains a wallet may be connected on today — {@link activeChains}, which
   * reads the per-chain ingestion flags `docs/multichain.md` §6 defines.
   *
   * A parameter with a default rather than a call inside the component, so a
   * test can state each combination without touching `process.env`.
   */
  available?: Chain[];
  onSubmit?: (result: { handle: string; publicWalletIds: string[] }) => void;
}) {
  /**
   * **Every wallet starts private**, and the default lives here as well as on
   * the column (migration 012). Two copies of one default is usually a smell;
   * this one is deliberate, because they answer different questions — the
   * column answers "what does a row that nobody edited mean", and this answers
   * "what is selected when the screen opens". A screen that opened with
   * `Pública` selected against a column defaulting to private would publish on
   * a submit the reader never read.
   */
  const [publicIds, setPublicIds] = useState<ReadonlySet<string>>(new Set());
  const [handleInput, setHandleInput] = useState("");

  const handle = normalizeXHandle(handleInput);
  // Not `handle === null`: an empty field is *not yet* an answer, and marking
  // it as an error before anyone has typed is the shape of form that shouts at
  // people for opening it.
  const handleIsWrong = handleInput.trim() !== "" && handle === null;

  const setWallet = (id: string, isPublic: boolean) => {
    setPublicIds((current) => {
      const next = new Set(current);
      if (isPublic) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  return (
    <section className="onboarding" aria-labelledby="onboarding-title">
      <header className="onboarding-head">
        <h2 className="display-lg" id="onboarding-title">
          ¡Casi listo!
        </h2>
        <p className="page-subtitle">
          Elige qué wallets quieres mostrar y dinos cuál es tu cuenta de X.
        </p>
      </header>

      <section className="card">
        <div className="card-head">
          <h3 className="label">Wallets conectadas</h3>
        </div>
        <ul className="wallet-list">
          {wallets.map((wallet) => (
            <WalletRow
              key={wallet.id}
              wallet={wallet}
              isPublic={publicIds.has(wallet.id)}
              indexed={available.includes(wallet.chain)}
              onChange={(isPublic) => setWallet(wallet.id, isPublic)}
            />
          ))}
        </ul>
        {/*
          The honest sentence, and the one this screen exists to get right.
          `DECISIONES.md`: the ranking sums every wallet, public and private —
          *"si el ranking dependiera de cuáles son públicas, el opt-in dejaría
          de ser una decisión sobre privacidad y pasaría a ser una sobre el
          puesto."* So the copy says publishing changes what is shown and not
          what is counted. Anything vaguer would let a reader publish a wallet
          believing it improves their position.
        */}
        <p className="label onboarding-note">
          Privada es la opción por defecto. Hacer pública una wallet solo muestra su
          dirección y el enlace a cada operación; tu PnL en la clasificación suma todas tus
          wallets, públicas y privadas. Puedes cambiarlo cuando quieras, pero una
          dirección ya publicada no se puede despublicar.
        </p>
        {/*
          `docs/multichain.md` §6: a chain stays behind its ingestion flag until
          that ingestion carries real data. So the screen names what it can
          actually index today rather than listing every chain the schema knows
          about — a wallet connected on a chain nothing reads produces no
          trades, moves no rank and appears nowhere, and the person who
          connected it has no way to tell that from a service that is quiet.

          The second sentence is the one that keeps this from reading as a
          limitation: nobody has to come back and register again. A chain that
          turns on is offered to the KOLs who already exist, from their profile.
        */}
        <p className="label onboarding-note">
          Por ahora indexamos {listChains(available)}. Cuando activemos una cadena
          nueva te la ofrecemos desde tu perfil: no hace falta que vuelvas a
          registrarte.
        </p>
      </section>

      <section className="card">
        <div className="card-head">
          <h3 className="label">Tu cuenta de X</h3>
        </div>
        <label className="field">
          <span className="label">Usuario de X</span>
          <input
            className="input"
            type="text"
            inputMode="text"
            autoComplete="off"
            spellCheck={false}
            placeholder="@ejemplo"
            value={handleInput}
            onChange={(event) => setHandleInput(event.target.value)}
            aria-describedby="handle-help"
            aria-invalid={handleIsWrong || undefined}
          />
        </label>
        <p className="label" id="handle-help">
          Puedes escribir tu usuario, tu usuario con @, o pegar el enlace a tu perfil.
        </p>
        {/*
          The normalised value is shown back rather than described, because the
          three forms collapse to one and the reader should see which one gets
          stored before they agree to it.
        */}
        {handle !== null && (
          <p className="label onboarding-echo">
            Se guardará como <strong>@{handle}</strong>
          </p>
        )}
        {handleIsWrong && (
          <p className="label state-error" role="alert">
            Eso no parece un usuario de X. Prueba con tu usuario o con el enlace a tu
            perfil.
          </p>
        )}
      </section>

      {/*
        `DECISIONES.md`, 2026-08-31: a KOL is pending until the tweet with the
        code and the admin approval, and appears on no public surface until
        then. That decision was taken knowing it costs friction — *"alguien que
        conecta, firma y no ve nada puede pensar que falló. Se compensa con lo
        que dice el modal al cerrar, no aflojando el gate."* This is that
        sentence, and it is why the CTA does not promise the ranking outright.
      */}
      <p className="label onboarding-note">
        El último paso es publicar un tweet con tu código de verificación. Hasta que lo
        aprobemos, tu perfil no aparece en la clasificación.
      </p>

      <button
        type="button"
        className="cta"
        disabled={handle === null}
        onClick={() => onSubmit?.({ handle: handle ?? "", publicWalletIds: [...publicIds] })}
      >
        Entrar a la clasificación
      </button>
    </section>
  );
}
