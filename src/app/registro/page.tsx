"use client";

import bs58 from "bs58";
import { useState } from "react";
import { OnboardingModal, type OnboardingWallet } from "../onboarding-modal";
import { PROOF_DOMAIN, proofMessage, type ProofFields } from "@/lib/wallet-proof";

/**
 * `/registro` — spec §6, the only page in the product that connects a wallet.
 *
 * **It asks for a signature over a message and nothing else.** No transaction is
 * built, offered or sent, and `src/lib/no-money-path.test.ts` is what keeps that
 * true rather than this comment: it refuses `@solana/wallet-adapter` and every
 * transaction-constructing API in the tracked source, which is why this talks to
 * the injected provider directly and uses only `signMessage`.
 *
 * The flow is three steps and they are on one page, because each one is a
 * sentence: connect, decide what to publish and say who you are, then tweet a
 * code. `docs/padron.md` §2 records why the middle step submits every wallet's
 * proof at once — there is no session, so nothing has to remember which wallets
 * were proven between requests.
 */

type Provider = {
  connect: () => Promise<{ publicKey: { toString: () => string } }>;
  signMessage: (message: Uint8Array, encoding?: string) => Promise<{ signature: Uint8Array }>;
};

type Proven = OnboardingWallet & { signature: string; nonce: string; expiresAt: string };

function provider(): Provider | null {
  if (typeof window === "undefined") return null;
  const injected = (window as unknown as { solana?: Provider & { isPhantom?: boolean } }).solana;
  return injected && typeof injected.signMessage === "function" ? injected : null;
}

const MESSAGES: Record<string, string> = {
  no_provider: "No encontramos una wallet en este navegador. Instalá una extensión y recargá.",
  rejected: "Cancelaste la firma. Podés intentarlo otra vez.",
  chain_not_active: "Todavía no indexamos esa cadena.",
  bad_address: "Esa dirección no tiene la forma que esperábamos.",
  address_taken: "Esa wallet ya está en el padrón.",
  handle_taken: "Ese usuario de X ya está en el padrón.",
  already_added: "Esa wallet ya está en la lista.",
};

export default function RegistroPage() {
  const [wallets, setWallets] = useState<Proven[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ code: string; kolId: string } | null>(null);

  const fail = (reason: string) => {
    setError(MESSAGES[reason] ?? "No se pudo completar el paso. Probá de nuevo.");
  };

  async function connect() {
    setError(null);
    const wallet = provider();
    if (!wallet) return fail("no_provider");

    setBusy(true);
    try {
      const { publicKey } = await wallet.connect();
      const address = publicKey.toString();
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
      const signed = await wallet.signMessage(
        new TextEncoder().encode(proofMessage(fields)),
        "utf8",
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
          signature: bs58.encode(signed.signature), nonce, expiresAt },
      ]);
    } catch {
      // Never the caught error: a provider's rejection can carry the address.
      fail("rejected");
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
      {wallets.length === 0 ? (
        <section className="onboarding">
          <header className="onboarding-head">
            <h1 className="display-lg">Entrá al padrón</h1>
            <p className="page-subtitle">
              Conectá tu wallet y firmá un mensaje. No mueve fondos ni aprueba ninguna
              transacción.
            </p>
          </header>
          {error && (
            <p className="label state-error" role="alert">
              {error}
            </p>
          )}
          <button type="button" className="cta" onClick={connect} disabled={busy}>
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
          <button type="button" className="segment" onClick={connect} disabled={busy}>
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
        unreachable: "No pudimos consultar X ahora mismo. Probá de nuevo en un minuto.",
        not_pending: "Ese registro ya no está pendiente.",
      }[body.error ?? ""] ?? "No se pudo verificar. Probá de nuevo.",
    );
  }

  return (
    <main className="page">
      <section className="onboarding">
        <header className="onboarding-head">
          <h1 className="display-lg">Último paso</h1>
          <p className="page-subtitle">Publicá este tweet y pegá el enlace acá.</p>
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
              aparezcas en el ranking; hasta entonces tu perfil no es visible.
            </p>
          )}
        </section>
      </section>
    </main>
  );
}
