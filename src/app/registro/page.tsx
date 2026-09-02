"use client";

import bs58 from "bs58";
import { useState } from "react";
import { OnboardingModal, type OnboardingWallet } from "../onboarding-modal";
import { WalletPicker } from "../wallet-picker";
import { PROOF_DOMAIN, proofMessage, type ProofFields } from "@/lib/wallet-proof";
import {
  connect as connectWallet,
  discoverWallets,
  signMessage,
  solanaWallets,
  type StandardWallet,
} from "@/lib/wallet-standard";

/**
 * `/registro` — spec §6, the only page in the product that connects a wallet.
 *
 * **It asks for a signature over a message and nothing else.** No transaction is
 * built, offered or sent, and `src/lib/no-money-path.test.ts` is what keeps that
 * true rather than this comment: it refuses every transaction-constructing API
 * and both wallet libraries by name in tracked source, which is why the
 * handshake in `wallet-standard.ts` is written out here rather than imported,
 * and why the only wallet feature this page ever reaches for is message signing.
 *
 * That scan is literal, and it caught this file — an earlier draft of this
 * paragraph spelled one of the refused package names out, and a comment naming
 * it is one paste away from an import. The rule is the file's, not this one's,
 * so the prose gave way.
 *
 * **Which wallets appear is not decided here.** `wallet-standard.ts` asks the
 * browser and shows whatever answers, so the list is open by construction and
 * this file names no wallet. It used to read `window.solana` — one global, one
 * slot, awarded to whichever extension overwrote it last, which is a list of one
 * chosen by load order rather than by the reader.
 *
 * The flow is three steps and they are on one page, because each one is a
 * sentence: connect, decide what to publish and say who you are, then tweet a
 * code. `docs/padron.md` §2 records why the middle step submits every wallet's
 * proof at once — there is no session, so nothing has to remember which wallets
 * were proven between requests.
 */

type Proven = OnboardingWallet & { signature: string; nonce: string; expiresAt: string };

const MESSAGES: Record<string, string> = {
  no_provider:
    "No encontramos ninguna wallet de Solana en este navegador. Instala una extensión que " +
    "firme mensajes en Solana, ábrela una vez y recarga.",
  rejected: "Cancelaste la firma. Puedes intentarlo otra vez.",
  chain_not_active: "Todavía no indexamos esa cadena.",
  bad_address: "Esa dirección no tiene la forma que esperábamos.",
  address_taken: "Esa wallet ya está en el padrón.",
  handle_taken: "Ese usuario de X ya está en el padrón.",
  already_added: "Esa wallet ya está en la lista.",
  wallet_no_account: "Esa wallet se conectó pero no compartió ninguna cuenta.",
  wallet_account_gone: "La cuenta cambió durante la firma. Prueba otra vez.",
  wallet_no_signature: "Esa wallet no devolvió una firma.",
};

export default function RegistroPage() {
  const [wallets, setWallets] = useState<Proven[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [choices, setChoices] = useState<StandardWallet[] | null>(null);
  const [done, setDone] = useState<{ code: string; kolId: string } | null>(null);

  const fail = (reason: string) => {
    setError(MESSAGES[reason] ?? "No se pudo completar el paso. Prueba de nuevo.");
  };

  /**
   * Step one: ask the browser which wallets are there, and let the reader pick.
   *
   * Discovery runs on the click rather than on mount, so a wallet the reader
   * installs or unlocks while the page is open is found on the next attempt
   * without a reload -- which is most of what the old copy's "recarga" was for.
   */
  function openPicker() {
    setError(null);
    const found = solanaWallets(discoverWallets());
    if (found.length === 0) return fail("no_provider");
    setChoices(found);
  }

  /** Step two: the wallet the reader chose signs the proof. */
  async function connect(wallet: StandardWallet) {
    setChoices(null);
    setError(null);
    setBusy(true);
    try {
      const address = await connectWallet(wallet);
      if (wallets.some((w) => w.address === address)) return fail("already_added");

      const issued = await fetch("/api/registro/nonce", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ address, chain: "solana", action: "alta de perfil" }),
      });
      if (!issued.ok) return fail(((await issued.json()) as { error?: string }).error ?? "");
      const { nonce, expiresAt } = (await issued.json()) as { nonce: string; expiresAt: string };

      // The exact text the server rebuilds. Built from the shared module rather
      // than typed out here, so there is one definition of what gets signed.
      const fields: ProofFields = {
        domain: PROOF_DOMAIN,
        address,
        chain: "solana",
        action: "alta de perfil",
        nonce,
        expiresAt,
      };
      const signature = await signMessage(
        wallet,
        address,
        new TextEncoder().encode(proofMessage(fields)),
      );

      setWallets((current) => [
        ...current,
        { id: `w-${current.length + 1}`, address, chain: "solana",
          // `bs58`, already a dependency and already how `ids.ts` and the
          // verifier speak. An earlier draft hand-rolled the encoder and wrote
          // the 58-character alphabet out as a literal, which the no-doxx scan
          // correctly flagged as a base58 run -- and which was reimplementing
          // an installed dependency, the first thing CLAUDE.md's ladder asks
          // about.
          signature: bs58.encode(signature), nonce, expiresAt },
      ]);
    } catch (error) {
      // The message is only ever one of this module's own reason codes, never
      // the wallet's text: a provider's rejection can carry the address, and
      // MESSAGES falls back to a generic line for anything it does not know.
      const reason = error instanceof Error ? error.message : "";
      fail(reason in MESSAGES ? reason : "rejected");
    } finally {
      setBusy(false);
    }
  }

  async function submit(result: { handle: string; publicWalletIds: string[] }) {
    setError(null);
    setBusy(true);
    try {
      const response = await fetch("/api/registro", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          handle: result.handle,
          wallets: wallets.map((w) => ({
            address: w.address,
            chain: w.chain,
            isPublic: result.publicWalletIds.includes(w.id),
            signature: w.signature,
            nonce: w.nonce,
            expiresAt: w.expiresAt,
          })),
        }),
      });
      if (!response.ok) return fail(((await response.json()) as { error?: string }).error ?? "");
      const body = (await response.json()) as { kolId: string; verificationCode: string };
      setDone({ kolId: body.kolId, code: body.verificationCode });
    } finally {
      setBusy(false);
    }
  }

  if (done) return <TweetStep kolId={done.kolId} code={done.code} />;

  return (
    <main className="page">
      {choices && (
        <WalletPicker wallets={choices} onPick={connect} onCancel={() => setChoices(null)} />
      )}
      {wallets.length === 0 ? (
        <section className="onboarding">
          <header className="onboarding-head">
            <h1 className="display-lg">Entra al padrón</h1>
            <p className="page-subtitle">
              Conecta tu wallet y firma un mensaje. No mueve fondos ni aprueba ninguna
              transacción.
            </p>
          </header>
          {error && (
            <p className="label state-error" role="alert">
              {error}
            </p>
          )}
          <button type="button" className="cta" onClick={openPicker} disabled={busy}>
            Conectar wallet
          </button>
        </section>
      ) : (
        <>
          {error && (
            <p className="label state-error" role="alert">
              {error}
            </p>
          )}
          <OnboardingModal wallets={wallets} onSubmit={submit} />
          <button type="button" className="segment" onClick={openPicker} disabled={busy}>
            + conectar otra wallet
          </button>
        </>
      )}
    </main>
  );
}

/** The last step: tweet the code, paste the link back. */
function TweetStep({ kolId, code }: { kolId: string; code: string }) {
  const [url, setUrl] = useState("");
  const [state, setState] = useState<"idle" | "ok" | "error">("idle");
  const [reason, setReason] = useState<string | null>(null);

  const text = `Verifico mi cuenta en kolscanhispano.fun ${code}`;

  async function check() {
    setReason(null);
    const response = await fetch("/api/registro/tweet", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kolId, url }),
    });
    if (response.ok) {
      setState("ok");
      return;
    }
    const body = (await response.json()) as { error?: string };
    setState("error");
    setReason(
      {
        wrong_author: "Ese tweet no es de la cuenta que registraste.",
        code_missing: "Ese tweet no lleva tu código.",
        bad_url: "Eso no parece un enlace a un tweet.",
        not_found: "No pudimos leer ese tweet. ¿Está público?",
        unreachable: "No pudimos consultar X ahora mismo. Prueba de nuevo en un minuto.",
        not_pending: "Ese registro ya no está pendiente.",
      }[body.error ?? ""] ?? "No se pudo verificar. Prueba de nuevo.",
    );
  }

  return (
    <main className="page">
      <section className="onboarding">
        <header className="onboarding-head">
          <h1 className="display-lg">Último paso</h1>
          <p className="page-subtitle">Publica este tweet y pega el enlace aquí.</p>
        </header>

        <section className="card">
          <div className="card-head">
            <h2 className="label">Tu código</h2>
          </div>
          <p className="num code-block">{text}</p>
          <a
            className="cta"
            href={`https://x.com/intent/tweet?text=${encodeURIComponent(text)}`}
            target="_blank"
            rel="noreferrer noopener"
          >
            Publicar en X
          </a>
        </section>

        <section className="card">
          <div className="card-head">
            <h2 className="label">El enlace</h2>
          </div>
          <label className="field">
            <span className="label">Enlace al tweet</span>
            <input
              className="input"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder="https://x.com/…/status/…"
            />
          </label>
          <button type="button" className="cta" onClick={check} disabled={url === ""}>
            Verificar
          </button>
          {state === "error" && reason && (
            <p className="label state-error" role="alert">
              {reason}
            </p>
          )}
          {state === "ok" && (
            <p className="label onboarding-note">
              Tu tweet quedó verificado. Un administrador tiene que aprobarte para que
              aparezcas en la clasificación; hasta entonces tu perfil no es visible.
            </p>
          )}
        </section>
      </section>
    </main>
  );
}
