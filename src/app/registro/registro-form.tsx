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
import {
  connectEvm,
  discoverEvmWallets,
  signPersonal,
  type Eip6963Wallet,
} from "@/lib/eip6963";
import { isEvm, type Chain } from "@/lib/chain";

/**
 * A wallet the reader may pick, with the chain it will register on.
 *
 * **Two namespaces, one list.** Solana wallets announce over Wallet Standard and
 * EVM wallets over EIP-6963; the two handshakes have nothing in common and both
 * end here, as a row with a name and a chain. The reader is choosing a wallet,
 * not a protocol.
 *
 * The EVM half only appears when `activeChains()` says so — the flag that keeps
 * a chain nothing indexes from being offered (`chain.ts`). A wallet registered
 * on a chain with no ingestion produces no trades, appears in no feed and moves
 * no rank, which is `DESIGN.md`'s last Don't.
 */
type Choice =
  | { kind: "solana"; chain: Chain; name: string; wallet: StandardWallet }
  | { kind: "evm"; chain: Chain; name: string; wallet: Eip6963Wallet };

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
  // Names no chain: `/registro` offers Solana and, with the flag on, Robinhood,
  // and a message that named one of them was wrong the moment the second
  // appeared. What a reader needs is what to do, not which namespace failed.
  no_provider:
    "No encontramos ninguna wallet en este navegador. Instala una extensión que firme " +
    "mensajes, ábrela una vez y recarga.",
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

export function RegistroForm({ chains }: { chains: readonly Chain[] }) {
  const [wallets, setWallets] = useState<Proven[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [choices, setChoices] = useState<Choice[] | null>(null);
  const [done, setDone] = useState<{ code: string; kolId: string } | null>(null);

  const fail = (reason: string) => {
    setError(MESSAGES[reason] ?? "No se pudo completar el paso. Prueba de nuevo.");
  };

  /**
   * Step one: ask the browser which wallets are there.
   *
   * Discovery runs on the click rather than on mount, so a wallet the reader
   * installs or unlocks while the page is open is found on the next attempt
   * without a reload -- which is most of what the old copy's "recarga" was for.
   *
   * **One wallet connects straight through; two or more open the chooser.** A
   * chooser with a single row asks a question that has one answer, which
   * `DESIGN.md`'s last Don't calls a control that does not work -- and it is a
   * click every reader pays so that the minority with two wallets can choose.
   * The list is no less open for it: what decides is how many registered, not
   * anything this file knows about them.
   */
  function openPicker() {
    setError(null);

    /*
      **Both handshakes, every time.** Wallet Standard for Solana and EIP-6963
      for EVM: a reader with MetaMask and Phantom installed has two wallets, not
      one, and which of the two protocols they speak is not their problem.

      The EVM half is gated on `activeChains()` rather than on anything this
      file knows: a chain whose ingestion is off produces no trades and moves no
      rank, so offering it would be a control that does not work.
    */
    const found: Choice[] = [
      ...solanaWallets(discoverWallets()).map(
        (wallet): Choice => ({ kind: "solana", chain: "solana", name: wallet.name, wallet }),
      ),
      ...(chains.some(isEvm)
        ? discoverEvmWallets().map(
            (wallet): Choice => ({
              // The first active EVM chain: today that is Robinhood and there
              // is exactly one. A reader with two would have to be asked, and
              // that question does not exist until a second chain is switched
              // on — `docs/multichain.md` §6.
              kind: "evm",
              chain: chains.find(isEvm)!,
              name: wallet.info.name,
              wallet,
            }),
          )
        : []),
    ];

    if (found.length === 0) return fail("no_provider");
    if (found.length === 1) {
      void connect(found[0]);
      return;
    }
    setChoices(found);
  }

  /** Step two: the wallet the reader chose signs the proof. */
  async function connect(choice: Choice) {
    setChoices(null);
    setError(null);
    setBusy(true);
    try {
      const chain = choice.chain;
      const address =
        choice.kind === "solana"
          ? await connectWallet(choice.wallet)
          : await connectEvm(choice.wallet);
      if (wallets.some((w) => w.address === address)) return fail("already_added");

      const issued = await fetch("/api/registro/nonce", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ address, chain, action: "alta de perfil" }),
      });
      if (!issued.ok) return fail(((await issued.json()) as { error?: string }).error ?? "");
      const { nonce, expiresAt } = (await issued.json()) as { nonce: string; expiresAt: string };

      // The exact text the server rebuilds. Built from the shared module rather
      // than typed out here, so there is one definition of what gets signed.
      const fields: ProofFields = {
        domain: PROOF_DOMAIN,
        address,
        chain,
        action: "alta de perfil",
        nonce,
        expiresAt,
      };
      /*
        **The same text, two signatures that are not the same shape.**

        `proofMessage` builds one string — `docs/wallet-proof.md` §2, with its
        `Cadena:` line in CAIP-2 — and each namespace signs it its own way: a
        Solana wallet over the raw bytes, an EVM wallet as EIP-191
        `personal_sign`. What travels differs too: base58 for one, `0x` hex for
        the other, which is what each verifier expects.

        The message itself is never branched on. One definition of what gets
        signed is the rule `docs/wallet-proof.md` §2.2 rests on: the server
        rebuilds the text it expects, so a client that composed its own would
        simply fail there.
      */
      const message = proofMessage(fields);
      const signature =
        choice.kind === "solana"
          ? bs58.encode(
              await signMessage(choice.wallet, address, new TextEncoder().encode(message)),
            )
          : await signPersonal(choice.wallet, address, message);

      setWallets((current) => [
        ...current,
        { id: `w-${current.length + 1}`, address, chain, signature, nonce, expiresAt },
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
        <WalletPicker
          wallets={choices}
          onPick={(picked) => {
            // The chooser hands back the row it was given, so the connect path
            // gets the wallet object rather than re-discovering it: a second
            // handshake between the click and the signature could return a
            // different object for the same name.
            const chosen = choices.find(
              (c) => c.name === picked.name && c.chain === picked.chain,
            );
            if (chosen) void connect(chosen);
          }}
          onCancel={() => setChoices(null)}
        />
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
          {/* `available` is handed down rather than defaulted, for the reason the
              wrapper in `page.tsx` exists: `activeChains()` reads a server env
              var, and this component runs in the browser. Left to its default
              the sentence below read "Por ahora indexamos Solana" while the
              chooser was offering Robinhood — two answers from one flag, which
              is exactly what `chain.ts` centralises to prevent. */}
          <OnboardingModal wallets={wallets} onSubmit={submit} available={chains} />
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
