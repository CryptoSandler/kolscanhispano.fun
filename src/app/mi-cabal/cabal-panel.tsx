"use client";

import { useState } from "react";
import { WalletPicker } from "../wallet-picker";
import { connectChoice, discoverChoices, signChoice, type Choice } from "../wallet-choice";
import { CABAL_ACTIONS, type CabalAction } from "@/lib/cabal-subject";
import { PROOF_DOMAIN, proofMessage, type ProofFields } from "@/lib/wallet-proof";
import type { Chain } from "@/lib/chain";

/**
 * `/mi-cabal` — the six signed actions, as a page.
 *
 * **There is no session, and the page is built around that rather than around
 * hiding it.** `docs/round-cabals.md` §4 decided authority is proved per action
 * over a nonce this server issued, so every button here ends in a wallet prompt
 * the person reads and approves. Nothing is remembered between two of them: the
 * wallet stays connected for convenience, and the *authority* does not.
 *
 * **The queue is read by the leader and the deputies, and by nobody else.**
 * `docs/round-cabals.md` §5, decided 2026-09-05. It is never public: showing who
 * asked to join publishes a rejection, and that cannot be taken back. An
 * applicant reads the status of their own request and nothing more — not the
 * queue, not their position in it, because a position is a fact about the other
 * people in it.
 *
 * Both reads are signed, like every write here. That costs a wallet prompt per
 * refresh, and it is what *no KOL session* buys everywhere else rather than a
 * choice this page makes.
 *
 * **What the panel does not do is guess who you are.** It offers all six
 * actions and lets the server refuse the ones that do not apply, because the
 * alternative — asking the server "what may this address do?" — is an endpoint
 * that turns a guessed address into a person's cabal, and addresses are hidden
 * by default in this product (`hide_wallets`).
 */

/** What each action asks for, in the order a person meets them. */
const FORMS: {
  action: CabalAction;
  title: string;
  hint: string;
  label: string;
  placeholder: string;
}[] = [
  {
    action: "crear cabal",
    title: "Crear un cabal",
    hint: "Quedas como líder. La sigla es tuya mientras el cabal exista.",
    label: "Sigla",
    placeholder: "ARG",
  },
  {
    action: "pedir entrar al cabal",
    title: "Pedir entrar",
    hint: "El líder recibe tu pedido y lo acepta o lo rechaza.",
    label: "Sigla del cabal",
    placeholder: "ARG",
  },
  {
    action: "aceptar solicitud",
    title: "Aceptar una solicitud",
    hint: "Solo el líder o el co-líder.",
    label: "Usuario de X",
    placeholder: "@usuario",
  },
  {
    action: "rechazar solicitud",
    title: "Rechazar una solicitud",
    hint: "Puede volver a pedir más adelante.",
    label: "Usuario de X",
    placeholder: "@usuario",
  },
  {
    action: "expulsar del cabal",
    title: "Expulsar a un miembro",
    hint: "Al líder no se lo puede expulsar.",
    label: "Usuario de X",
    placeholder: "@usuario",
  },
  {
    action: "transferir el cabal",
    title: "Transferir el cabal",
    hint: "Solo el líder, y solo a alguien que ya sea miembro. Sigues en el cabal.",
    label: "Usuario de X",
    placeholder: "@usuario",
  },
  {
    action: "nombrar co-líder",
    title: "Nombrar co-líder",
    hint: "Solo el líder. Como máximo dos por cabal.",
    label: "Usuario de X",
    placeholder: "@usuario",
  },
  {
    action: "revocar co-líder",
    title: "Revocar co-líder",
    hint: "Solo el líder. La persona sigue en el cabal.",
    label: "Usuario de X",
    placeholder: "@usuario",
  },
  {
    action: "ver solicitudes",
    title: "Ver solicitudes",
    hint: "Solo el líder y los co-líderes. La cola no es pública.",
    label: "Sigla de tu cabal",
    placeholder: "ARG",
  },
  {
    action: "ver mi solicitud",
    title: "Ver mi solicitud",
    hint: "El estado de la tuya. No muestra quién más pidió entrar.",
    label: "Sigla del cabal",
    placeholder: "ARG",
  },
];

/**
 * The two reads answer with data rather than with a sentence.
 *
 * They still cost a signature, which is `docs/round-cabals.md` §4's *no KOL
 * session* showing its price rather than a quirk of this page: nothing
 * remembers between two requests that this wallet leads anything.
 */
type Pending = { handle: string; requestedAt: string };
type ReadResult =
  | { kind: "queue"; tag: string | null; pending: Pending[] }
  | { kind: "own"; tag: string; status: string; decidedAt: string | null };

const REQUEST_STATUS: Record<string, string> = {
  pending: "Pendiente",
  accepted: "Aceptada",
  rejected: "Rechazada",
  withdrawn: "Retirada",
};

/**
 * A refusal is one word on the wire; this is where it becomes a sentence.
 *
 * `bad_proof` covers the four ways a proof can be wrong and says so vaguely on
 * purpose — telling them apart is what would let somebody map which wallet holds
 * which nonce (`SECURITY.md`). The sentence a person needs is the same in all
 * four cases: sign again.
 */
const MESSAGES: Record<string, string> = {
  bad_proof: "La firma ya no sirve. Vuelve a intentarlo: se pide una firma nueva cada vez.",
  unknown_wallet: "Esa wallet no figura en el padrón, o el perfil todavía no está aprobado.",
  not_leader: "No lideras ningún cabal.",
  cannot_expel_leader: "Al líder no se lo puede expulsar.",
  not_found: "No encontramos eso.",
  already_in_cabal: "Ya hay un cabal de por medio.",
  already_requested: "Ya tienes un pedido pendiente en ese cabal.",
  not_a_member: "Esa persona no está en tu cabal.",
  tag_taken: "Esa sigla ya está en uso.",
  bad_input: "Revisa los datos y prueba otra vez.",
  bad_subject: "Revisa los datos y prueba otra vez.",
  no_provider:
    "No encontramos ninguna wallet en este navegador. Instala una extensión que firme " +
    "mensajes, ábrela una vez y recarga la página.",
  rejected: "Cancelaste la firma. Puedes intentarlo otra vez.",
};

const DONE: Record<CabalAction, string> = {
  "crear cabal": "Cabal creado. Ya eres su líder.",
  "pedir entrar al cabal": "Pedido enviado.",
  "aceptar solicitud": "Solicitud aceptada.",
  "rechazar solicitud": "Solicitud rechazada.",
  "expulsar del cabal": "Miembro expulsado.",
  "transferir el cabal": "Cabal transferido.",
  "nombrar co-líder": "Co-líder nombrado.",
  "revocar co-líder": "Co-líder revocado.",
  // The two reads render their answer instead of this line.
  "ver solicitudes": "",
  "ver mi solicitud": "",
};

const READS: CabalAction[] = ["ver solicitudes", "ver mi solicitud"];

export function CabalPanel({ chains }: { chains: readonly Chain[] }) {
  const [choices, setChoices] = useState<Choice[] | null>(null);
  const [connected, setConnected] = useState<{ choice: Choice; address: string } | null>(null);
  const [action, setAction] = useState<CabalAction>("crear cabal");
  const [subject, setSubject] = useState("");
  const [name, setName] = useState("");
  const [color, setColor] = useState("a");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [read, setRead] = useState<ReadResult | null>(null);

  const form = FORMS.find((f) => f.action === action)!;

  function fail(reason: string) {
    setDone(null);
    setRead(null);
    setError(MESSAGES[reason] ?? "No se pudo completar la acción. Prueba de nuevo.");
  }

  function openPicker() {
    setError(null);
    const found = discoverChoices(chains);
    if (found.length === 0) return fail("no_provider");
    // A chooser with one row asks a question that has one answer — `DESIGN.md`'s
    // last Don't — so one wallet connects straight through.
    if (found.length === 1) return void connect(found[0]);
    setChoices(found);
  }

  async function connect(choice: Choice) {
    setChoices(null);
    setError(null);
    setBusy(true);
    try {
      setConnected({ choice, address: await connectChoice(choice) });
    } catch (error) {
      // Never the provider's own text: a rejection can carry the address.
      const reason = error instanceof Error ? error.message : "";
      fail(reason in MESSAGES ? reason : "rejected");
    } finally {
      setBusy(false);
    }
  }

  /**
   * Nonce, signature, action — in that order, every time.
   *
   * The subject comes back from the nonce endpoint **normalised** and is used
   * from there, not from the box above: the server bound the nonce to the string
   * it returned, and signing a different spelling of the same handle would fail
   * verification for a reason nobody could see.
   */
  async function submit() {
    if (!connected) return;
    setError(null);
    setDone(null);
    setRead(null);
    setBusy(true);
    try {
      const { choice, address } = connected;
      const chain = choice.chain;

      const issued = await fetch("/api/cabal/nonce", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ address, chain, action, subject }),
      });
      if (!issued.ok) return fail(((await issued.json()) as { error?: string }).error ?? "");
      const proof = (await issued.json()) as {
        nonce: string;
        expiresAt: string;
        subject: string;
      };

      const fields: ProofFields = {
        domain: PROOF_DOMAIN,
        address,
        chain,
        action,
        subject: proof.subject,
        nonce: proof.nonce,
        expiresAt: proof.expiresAt,
      };
      const signature = await signChoice(choice, address, proofMessage(fields));

      const response = await fetch("/api/cabal", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action,
          address,
          chain,
          signature,
          nonce: proof.nonce,
          expiresAt: proof.expiresAt,
          subject: proof.subject,
          ...(action === "crear cabal" ? { name, color } : {}),
        }),
      });
      if (!response.ok) return fail(((await response.json()) as { error?: string }).error ?? "");

      if (action === "ver solicitudes") {
        const body = (await response.json()) as { tag: string | null; pending: Pending[] };
        setRead({ kind: "queue", ...body });
        return;
      }
      if (action === "ver mi solicitud") {
        const body = (await response.json()) as {
          tag: string;
          status: string;
          decidedAt: string | null;
        };
        setRead({ kind: "own", ...body });
        return;
      }

      setDone(DONE[action]);
      setSubject("");
      setName("");
    } catch (error) {
      const reason = error instanceof Error ? error.message : "";
      fail(reason in MESSAGES ? reason : "rejected");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="page">
      {choices && (
        <WalletPicker
          wallets={choices}
          onPick={(picked) => {
            const chosen = choices.find(
              (c) => c.name === picked.name && c.chain === picked.chain,
            );
            if (chosen) void connect(chosen);
          }}
          onCancel={() => setChoices(null)}
        />
      )}

      <header className="page-head">
        <h1 className="page-title">Mi cabal</h1>
        <p className="brand-subtitle">
          Cada acción se firma con tu wallet. No hay sesión: la firma vale para esa acción y para
          ninguna otra.
        </p>
      </header>

      {!connected ? (
        <section className="state-empty is-card">
          <p>Conecta la wallet que registraste en el padrón.</p>
          <button type="button" className="registro" onClick={openPicker} disabled={busy}>
            Conectar wallet
          </button>
          {error && <p role="alert">{error}</p>}
        </section>
      ) : (
        <section className="card-calendar">
          <fieldset className="wallet-choice-chain">
            <legend>Acción</legend>
            {FORMS.map((f) => (
              <label key={f.action}>
                <input
                  type="radio"
                  name="accion"
                  value={f.action}
                  checked={action === f.action}
                  onChange={() => {
                    setAction(f.action);
                    setSubject("");
                    setError(null);
                    setDone(null);
                    setRead(null);
                  }}
                />
                {f.title}
              </label>
            ))}
          </fieldset>

          <p className="hidden-wallets">{form.hint}</p>

          <label>
            {form.label}
            <input
              value={subject}
              placeholder={form.placeholder}
              onChange={(event) => setSubject(event.target.value)}
              // The tag is three or four letters; the handle is X's own limit.
              maxLength={CABAL_ACTIONS[action] === "tag" ? 4 : 16}
            />
          </label>

          {action === "crear cabal" && (
            <>
              <label>
                Nombre
                <input
                  value={name}
                  placeholder="Argentina"
                  maxLength={40}
                  onChange={(event) => setName(event.target.value)}
                />
              </label>
              <label>
                Color
                <select value={color} onChange={(event) => setColor(event.target.value)}>
                  {/* The four measured tints. `DESIGN.md`'s contrast table is a
                      claim about a fixed set, so the list is the palette. */}
                  <option value="a">Uno</option>
                  <option value="b">Dos</option>
                  <option value="c">Tres</option>
                  <option value="d">Cuatro</option>
                </select>
              </label>
            </>
          )}

          <button type="button" className="registro" onClick={submit} disabled={busy || !subject}>
            {READS.includes(action) ? "Firmar y consultar" : "Firmar y enviar"}
          </button>

          {error && <p role="alert">{error}</p>}
          {done && <p role="status">{done}</p>}

          {read?.kind === "queue" &&
            (read.pending.length === 0 ? (
              <p role="status">No hay solicitudes pendientes.</p>
            ) : (
              <ol className="board" aria-label="Solicitudes pendientes">
                {read.pending.map((row) => (
                  <li key={row.handle}>
                    <span className="handle">@{row.handle}</span>{" "}
                    <time className="hidden-wallets" dateTime={row.requestedAt}>
                      {new Date(row.requestedAt).toLocaleDateString("es")}
                    </time>
                  </li>
                ))}
              </ol>
            ))}

          {read?.kind === "own" && (
            <p role="status">
              {read.tag}: {REQUEST_STATUS[read.status] ?? read.status}
            </p>
          )}
        </section>
      )}
    </main>
  );
}
