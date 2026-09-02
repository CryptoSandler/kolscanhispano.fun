"use client";

import { useCallback, useState } from "react";
import { activeChains, type Chain } from "@/lib/chain";

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
 */

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
  bad_status: "Ese estado no existe."
};

export default function AdminPage() {
  const [token, setToken] = useState("");
  const [rows, setRows] = useState<Row[] | null>(null);
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
                    {activeChains().map((chain) => (
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
