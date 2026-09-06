"use client";

import { useCallback, useState } from "react";
import type { PublicTrade } from "@/lib/serialize";
import { formatSignedSol, formatUtcMoment } from "@/lib/format";

/**
 * El feed, para operar, detrás de `ADMIN_TOKEN`.
 *
 * **El token se escribe y vive en memoria de la pestaña**, igual que en
 * `/admin`: sin cookie y sin `localStorage`. Es una pantalla que una persona
 * abre de vez en cuando, y un token en un campo es lo que un navegador no
 * guarda solo.
 */
export function FeedAdmin() {
  const [token, setToken] = useState("");
  const [rows, setRows] = useState<PublicTrade[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/feed", {
        headers: { authorization: `Bearer ${token}` },
      });
      if (response.status === 401) {
        setError("Token rechazado.");
        setRows(null);
        return;
      }
      if (!response.ok) {
        setError(`La ruta respondió ${response.status}.`);
        setRows(null);
        return;
      }
      const body = (await response.json()) as { trades: PublicTrade[] };
      setRows(body.trades);
    } catch {
      setError("No se pudo consultar el feed.");
      setRows(null);
    } finally {
      setBusy(false);
    }
  }, [token]);

  return (
    <section className="panel">
      <div className="admin-token">
        <input
          type="password"
          value={token}
          onChange={(event) => setToken(event.target.value)}
          placeholder="pega el token"
          aria-label="ADMIN_TOKEN"
        />
        <button type="button" className="cta" onClick={load} disabled={token === "" || busy}>
          Cargar
        </button>
      </div>

      {error !== null && (
        <p className="label state-error" role="alert">
          {error}
        </p>
      )}

      {rows !== null && rows.length === 0 && <p className="label">No entró nada todavía.</p>}

      {rows !== null && rows.length > 0 && (
        <ul className="feed-admin">
          {rows.map((trade) => (
            <li key={trade.id}>
              <span className="label">{formatUtcMoment(trade.blockTime)}</span>
              <span className="name">{trade.kol.name}</span>
              <span className="label">{trade.side === "buy" ? "compra" : "venta"}</span>
              <span className="label">{trade.symbol ?? "—"}</span>
              <span className="num">{formatSignedSol(trade.solAmount)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
