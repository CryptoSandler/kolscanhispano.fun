import { permanentRedirect } from "next/navigation";

/**
 * `/cabals` — **308 a `/daos` desde el 2026-09-07.**
 *
 * Decisión del dueño: en superficie pública el grupo se llama **DAO**, no
 * cabal. El molde dice `Cabals` y acá se llama distinto a propósito
 * (`docs/copy.md`, `docs/clone-map.md`).
 *
 * **308 y no 404**, como `/leaderboard` y `/en-vivo`: la ruta estuvo en el nav
 * durante semanas y pudo quedar en un marcador o en un mensaje. Un enlace que
 * fue correcto no se contesta con un error.
 *
 * **Sólo cambia el nombre visible.** Las tablas, las columnas, los
 * identificadores y las acciones firmadas siguen diciendo `cabal`: renombrarlos
 * costaría una migración y un cambio en `PROOF_ACTIONS` —o sea invalidar cada
 * firma emitida— por una palabra que ningún lector ve.
 */
export default function CabalsPage(): never {
  permanentRedirect("/daos");
}
