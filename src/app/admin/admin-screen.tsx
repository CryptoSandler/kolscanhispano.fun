"use client";

import { useCallback, useState } from "react";
import type { Chain } from "@/lib/chain";

/**
 * The admin, spec §9, at the size this batch actually built: put a KOL on the
 * roster, and approve one that registered themselves.
 *
 * **The token is typed in and held in memory for the tab.** No cookie and no
 * session: a session is a thing to get wrong — expiry, rotation, CSRF — for a
 * screen one person opens occasionally, and a token in a field is refused by
 * every route the same way whether it came from a browser or from `curl`. It
 * is deliberately not persisted; closing the tab logs out.
 *
 * `docs/padron.md` §4 says plainly what §9 describes and this does not do:
 * editing, cabals, withdrawal, suspension, health. Nothing here pretends at
 * them, because a control that does not work is DESIGN.md's last Don't.
 *
 * **The chain list is a prop, and that was a bug.** `activeChains()` reads
 * `CHAIN_ROBINHOOD_INGESTION` from `process.env`, so calling it inside this
 * client component answered one thing on the server and another in the browser —
 * React reported the hydration mismatch on the `<option>` for exactly that chain,
 * and Playwright's dev-server log is where it surfaced. `/registro` had the same
 * bug and the same fix: one value, resolved on the server, handed down. A second
 * `NEXT_PUBLIC_` copy of the flag is what `chain.ts` exists to prevent.
 *
 * **One exception since 2026-09-05, and it is a list rather than a control.**
 * `docs/round-cabals.md` §5.1 closed the orphaned-cabal question: a cabal whose
 * leader cannot sign and that has no co-leader is resolved **only** by an admin
 * reassignment recorded in `audit_log` — no timer, no self-promotion. That makes
 * the state something a person has to notice, and a state that only resolves by
 * hand and that nothing surfaces is one that resolves when somebody complains.
 * So the orphans are shown. Reassigning is not built and there is no button for
 * it, which is the same Don't read the right way round.
 */

/** `GET /api/admin/cabal`. A handle, a tag and a count — never an address. */
type Orphan = {
  id: string;
  tag: string | null;
  name: string;
  leaderHandle: string | null;
  reason: string;
  members: number;
};

type Row = {
  id: string;
  slug: string;
  handle: string;
  status: string;
  tweetUrl: string | null;
  tweetVerified: boolean;
  wallets: number;
  publicWallets: number;
};

type WalletDraft = { address: string; chain: Chain; isPublic: boolean };

const CHAIN_LABEL: Record<Chain, string> = {
  solana: "Solana",
  ethereum: "Ethereum",
  bnb: "BNB Chain",
  robinhood: "Robinhood",
};

/**
 * `kol.status` is an English enum in the database; this is what the screen says.
 *
 * All four values of migration 001's `CHECK (status IN (...))`, because the
 * screen rendered `row.status` raw and every value but `pending` reached the
 * page in English — caught by reading `test-results/capturas/admin-*.png`
 * rather than by a test, since `copy.test.ts` scans for voseo and an English
 * word is not voseo.
 *
 * **No status carries a colour.** `DESIGN.md`: *"Green and red are direction of
 * money and nothing else. No status pill, no chart series, no validation
 * message may use them."* The previous `status === "pending" ? … : "gain"` put
 * `semantic-gain` on every other value — so a **rejected** KOL rendered in the
 * green that means profit. `pendiente` stays distinguishable without a tint:
 * it is the only row that carries an `Aprobar` button, and pending rows sort
 * first. `semantic-stale` is not reused here either — `DESIGN.md` spends it on
 * `sin precio`, and a second meaning for it is the owner's call, not this
 * file's.
 */
export const STATUS_LABEL: Record<string, string> = {
  pending: "pendiente",
  approved: "aprobado",
  rejected: "rechazado",
  suspended: "suspendido",
};

/** Reason codes are what the API answers; this is the Spanish for each. */
const REASONS: Record<string, string> = {
  unauthorized: "Token incorrecto.",
  bad_handle: "Ese no parece un usuario de X.",
  bad_address: "La dirección no tiene la forma de esa cadena.",
  bad_chain: "Cadena desconocida.",
  chain_not_active: "Todavía no indexamos esa cadena.",
  address_taken: "Esa dirección ya está en el padrón.",
  duplicate_in_request: "Repetiste la misma dirección.",
  handle_taken: "Ese usuario ya está en el padrón.",
  no_wallets: "Hace falta al menos una wallet.",
  not_pending: "Ese KOL ya no está pendiente.",
  bad_status: "Ese estado no existe.",
  // Reassignment. `not_orphaned` is the one worth spelling out: it is the rule
  // the round added, and an admin who meets it should learn that the cabal is
  // fine rather than that something went wrong.
  not_orphaned: "Ese cabal no está huérfano: su líder o un co-líder todavía puede firmar.",
  already_nominated: "Ya hay una nominación pendiente para ese cabal.",
  reason_required: "El motivo es obligatorio y tiene que decir algo.",
  not_confirmed: "Falta confirmar.",
  unknown_kol: "No hay ningún KOL aprobado con ese usuario.",
  cannot_lead: "Esa persona no tiene wallet activa, así que tampoco podría firmar.",
  already_in_cabal: "Esa persona ya está en otro cabal.",
};

export function AdminScreen({ chains }: { chains: readonly Chain[] }) {
  const [token, setToken] = useState("");
  const [rows, setRows] = useState<Row[] | null>(null);
  const [orphans, setOrphans] = useState<Orphan[] | null>(null);
  /** Which orphan's form is open, and what has been typed into it. */
  const [reassign, setReassign] = useState<{
    id: string;
    handle: string;
    reason: string;
    confirmed: boolean;
  } | null>(null);
  const [handle, setHandle] = useState("");
  const [wallets, setWallets] = useState<WalletDraft[]>([
    { address: "", chain: "solana", isPublic: false },
  ]);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const authed = useCallback(
    (init: RequestInit = {}) => ({
      ...init,
      headers: { "content-type": "application/json", authorization: `Bearer ${token}`,
                 ...(init.headers ?? {}) },
    }),
    [token],
  );

  const say = async (response: Response, ok: string) => {
    if (response.ok) {
      setMessage(ok);
      return true;
    }
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    setMessage(REASONS[body.error ?? ""] ?? `No se pudo: ${body.error ?? response.status}`);
    return false;
  };

  const load = async () => {
    setBusy(true);
    try {
      const response = await fetch("/api/admin/kol", authed());
      if (!response.ok) {
        await say(response, "");
        setRows(null);
        return;
      }
      setRows(((await response.json()) as { kols: Row[] }).kols);
      setMessage(null);

      // Loaded with the roster rather than behind its own button: an orphaned
      // cabal is a thing to *notice*, and a list you have to ask for is one
      // nobody asks for. A failure here leaves the roster on screen — the
      // padrón is what this page is for, and a missing sidebar must not take it
      // down with it.
      const cabals = await fetch("/api/admin/cabal", authed());
      setOrphans(cabals.ok ? ((await cabals.json()) as { orphans: Orphan[] }).orphans : null);
    } finally {
      setBusy(false);
    }
  };

  /**
   * `docs/round-reasignacion.md`: the admin **nominates**, and the cabal moves
   * only when the nominee signs `reclamar cabal`. Until then nothing changes —
   * the cabal stays orphaned and stays on this list.
   *
   * The confirmation, the mandatory reason and the orphan precondition are all
   * re-checked server-side: the cabal must still be orphaned when the
   * transaction runs, not merely when this screen listed it.
   */
  const doNominate = async () => {
    if (!reassign) return;
    setBusy(true);
    try {
      const response = await fetch(
        "/api/admin/cabal/nominate",
        authed({
          method: "POST",
          // `id` is the row's, `cabalId` is the field the route reads. Spelling
          // them apart keeps the form's state from being a wire format.
          body: JSON.stringify({
            cabalId: reassign.id,
            handle: reassign.handle,
            reason: reassign.reason,
            confirmed: reassign.confirmed,
          }),
        }),
      );
      if (await say(response, "Nominado. El cabal cambia de manos cuando esa persona lo reclame y firme.")) {
        setReassign(null);
        await load();
      }
    } finally {
      setBusy(false);
    }
  };

  const create = async () => {
    setBusy(true);
    try {
      const response = await fetch(
        "/api/admin/kol",
        authed({
          method: "POST",
          body: JSON.stringify({
            handle,
            wallets: wallets
              .filter((w) => w.address.trim() !== "")
              .map((w) => ({ address: w.address.trim(), chain: w.chain, isPublic: w.isPublic })),
          }),
        }),
      );
      if (await say(response, "KOL creado y aprobado.")) {
        setHandle("");
        setWallets([{ address: "", chain: "solana", isPublic: false }]);
        await load();
      }
    } finally {
      setBusy(false);
    }
  };

  const approve = async (id: string) => {
    setBusy(true);
    try {
      const response = await fetch(`/api/admin/kol/${id}/approve`, authed({ method: "POST" }));
      if (await say(response, "Aprobado.")) await load();
    } finally {
      setBusy(false);
    }
  };

  const setWallet = (index: number, patch: Partial<WalletDraft>) =>
    setWallets((current) => current.map((w, i) => (i === index ? { ...w, ...patch } : w)));

  return (
    <main className="page admin">
      <header className="onboarding-head">
        <h1 className="display-lg">Admin</h1>
        <p className="page-subtitle">Alta y aprobación del padrón.</p>
      </header>

      <section className="card">
        <div className="card-head">
          <h2 className="label">Token</h2>
        </div>
        <label className="field">
          <span className="label">ADMIN_TOKEN</span>
          <input
            className="input"
            type="password"
            autoComplete="off"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            placeholder="pega el token"
          />
        </label>
        <button type="button" className="cta" onClick={load} disabled={token === "" || busy}>
          Ver el padrón
        </button>
      </section>

      {message && (
        <p className="label state-error" role="status">
          {message}
        </p>
      )}

      <section className="card">
        <div className="card-head">
          <h2 className="label">Alta directa</h2>
        </div>
        <label className="field">
          <span className="label">Usuario de X</span>
          <input
            className="input"
            value={handle}
            onChange={(event) => setHandle(event.target.value)}
            placeholder="@ejemplo"
          />
        </label>

        <ul className="wallet-list">
          {wallets.map((draft, index) => (
            <li className="row-wallet" key={index}>
              <div className="wallet-visibility" role="group" aria-label={`Wallet ${index + 1}`}>
                <span className="wallet-identity">
                  <select
                    className="input"
                    value={draft.chain}
                    onChange={(event) => setWallet(index, { chain: event.target.value as Chain })}
                  >
                    {chains.map((chain) => (
                      <option key={chain} value={chain}>
                        {CHAIN_LABEL[chain]}
                      </option>
                    ))}
                  </select>
                  <input
                    className="input"
                    value={draft.address}
                    onChange={(event) => setWallet(index, { address: event.target.value })}
                    placeholder="dirección"
                    aria-label={`Dirección de la wallet ${index + 1}`}
                  />
                </span>
                <div className="visibility-group">
                  <label className="visibility-option">
                    <input
                      type="radio"
                      name={`admin-vis-${index}`}
                      checked={draft.isPublic}
                      onChange={() => setWallet(index, { isPublic: true })}
                    />
                    Pública
                  </label>
                  <label className="visibility-option">
                    <input
                      type="radio"
                      name={`admin-vis-${index}`}
                      checked={!draft.isPublic}
                      onChange={() => setWallet(index, { isPublic: false })}
                    />
                    Privada
                  </label>
                </div>
              </div>
            </li>
          ))}
        </ul>

        <div className="admin-actions">
          <button
            type="button"
            className="segment"
            onClick={() =>
              setWallets((current) => [...current, { address: "", chain: "solana", isPublic: false }])
            }
          >
            + otra wallet
          </button>
          <button
            type="button"
            className="cta"
            onClick={create}
            disabled={token === "" || handle === "" || busy}
          >
            Crear y aprobar
          </button>
        </div>
      </section>

      {/*
        Orphaned cabals: leader unable to sign, and no deputy. `docs/round-cabals.md`
        §5.1 — resolved only by an admin reassignment with an `audit_log` entry.

        Above the padrón because it is an exception list: it is empty almost
        always, and when it is not, it is the thing on this page that needs a
        person. An empty state is rendered rather than the section disappearing,
        so "there are none" and "it never loaded" do not look the same.
      */}
      {orphans !== null && (
        <section className="card">
          <div className="card-head">
            <h2 className="label">Cabals huérfanos</h2>
          </div>
          {orphans.length === 0 ? (
            <p className="label">Ninguno. Todos tienen líder o co-líder que puede firmar.</p>
          ) : (
            <>
              <ul className="board">
                {orphans.map((orphan) => (
                  <li key={orphan.id}>
                    <span className="handle">{orphan.tag ?? "—"}</span> {orphan.name}
                    {" · "}
                    <span className="hidden-wallets">
                      {orphan.reason}
                      {orphan.leaderHandle === null ? "" : ` (@${orphan.leaderHandle})`}
                      {" · "}
                      {orphan.members} {orphan.members === 1 ? "miembro" : "miembros"}
                    </span>{" "}
                    {reassign?.id === orphan.id ? (
                      /*
                        The form is per-row and opens on demand. Three fields,
                        and all three are required by the handler as well as by
                        this markup: `docs/round-reasignacion.md` §3 — a rule
                        enforced only in a form is not enforced.
                      */
                      <div className="wallet-visibility" role="group" aria-label="Nominar">
                        <input
                          className="input"
                          placeholder="@usuario"
                          value={reassign.handle}
                          onChange={(event) =>
                            setReassign({ ...reassign, handle: event.target.value })
                          }
                        />
                        <input
                          className="input"
                          placeholder="Motivo (queda en la auditoría, no se publica)"
                          value={reassign.reason}
                          onChange={(event) =>
                            setReassign({ ...reassign, reason: event.target.value })
                          }
                        />
                        <label>
                          <input
                            type="checkbox"
                            checked={reassign.confirmed}
                            onChange={(event) =>
                              setReassign({ ...reassign, confirmed: event.target.checked })
                            }
                          />{" "}
                          Confirmo que nadie del cabal puede firmar
                        </label>
                        <button
                          type="button"
                          className="cta"
                          disabled={busy || !reassign.confirmed || reassign.reason.trim() === ""}
                          onClick={() => void doNominate()}
                        >
                          Nominar
                        </button>
                        <button type="button" onClick={() => setReassign(null)}>
                          Cancelar
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={() =>
                          setReassign({
                            id: orphan.id,
                            handle: "",
                            reason: "",
                            confirmed: false,
                          })
                        }
                      >
                        Nominar
                      </button>
                    )}
                  </li>
                ))}
              </ul>
              <p className="label">
                Nominar no mueve el cabal: queda huérfano hasta que la persona lo reclame
                firmando, y la nominación vence a los 7 días. El motivo queda en la auditoría
                y no se publica.
              </p>
            </>
          )}
        </section>
      )}

      <section className="card">
        <div className="card-head">
          <h2 className="label">Padrón</h2>
        </div>
        {rows === null ? (
          <p className="label">Pega el token y pulsa «Ver el padrón».</p>
        ) : rows.length === 0 ? (
          <p className="label">Todavía no hay ningún KOL.</p>
        ) : (
          <div className="table-scroll">
            {/*
              The same container the ranking uses. `.leaderboard` carries
              `min-width: 768px`, so without this wrapper the table made the
              *document* 784px wide inside a 390px viewport — DESIGN.md: "The
              page never scrolls horizontally, at either size... Wide content
              scrolls inside its own container, never by moving the body."
              Caught by measuring test-results/capturas/admin-movil-390.png,
              which came out 784px wide while every other mobile capture came
              out 390.
            */}
            <table className="leaderboard admin-table">
              <thead>
                <tr>
                  <th scope="col" className="label">Usuario</th>
                  <th scope="col" className="label">Estado</th>
                  <th scope="col" className="label">Tweet</th>
                  <th scope="col" className="label num-head">Wallets</th>
                  <th scope="col" className="label" />
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id} className="row-leaderboard">
                    <td>@{row.handle}</td>
                    <td>
                      <span className="label">
                        {STATUS_LABEL[row.status] ?? row.status}
                      </span>
                    </td>
                    <td>
                      {row.tweetUrl === null ? (
                        <span className="label">—</span>
                      ) : (
                        <a
                          className="handle"
                          href={row.tweetUrl}
                          target="_blank"
                          rel="noreferrer noopener"
                        >
                          {row.tweetVerified ? "verificado" : "sin verificar"}
                        </a>
                      )}
                    </td>
                    <td className="num">
                      {row.wallets} ({row.publicWallets} públicas)
                    </td>
                    <td>
                      {row.status === "pending" && (
                        <button
                          type="button"
                          className="segment"
                          onClick={() => approve(row.id)}
                          disabled={busy}
                        >
                          Aprobar
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}
