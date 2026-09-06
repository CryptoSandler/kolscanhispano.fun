import { FeedAdmin } from "./feed-admin";

/**
 * `/admin/en-vivo` — el feed que era público, ahora sólo para operar.
 *
 * El feed público se eliminó el 2026-09-06 porque una fila con token, monto
 * exacto y hora permite encontrar la transacción en un explorador y con ella la
 * wallet (`DECISIONES.md`). Para operar hace falta ver lo que entra, así que no
 * se borró: se movió detrás de `ADMIN_TOKEN`.
 *
 * **La página no es el guard.** Lo que protege los datos es `/api/feed`, que
 * refusa sin token: esta pantalla sin token no muestra nada porque no tiene
 * nada que mostrar, no porque se esconda. Un guard en la página y no en la ruta
 * habría dejado la ruta abierta, que es donde están los datos.
 */
export const metadata = { title: "Feed · admin", robots: { index: false, follow: false } };

export default function AdminEnVivoPage() {
  return (
    <>
      <div className="page-head">
        <h1 className="display-lg">Feed</h1>
        <p className="page-subtitle">Operaciones en cuanto la cadena las confirma. Sólo admin.</p>
      </div>
      <FeedAdmin />
    </>
  );
}
