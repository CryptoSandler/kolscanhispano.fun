import { permanentRedirect } from "next/navigation";

/**
 * `/en-vivo` — **308 a la home desde el 2026-09-06.**
 *
 * El feed público se elimina por decisión del dueño. El motivo es concreto y no
 * es una precaución general: una fila del feed publicaba el token, el monto
 * exacto y la hora, y esas tres cosas juntas alcanzan para encontrar la
 * transacción en un explorador de bloques y, con ella, la wallet. El sitio
 * promete en el modal de conexión que *"tus wallets nunca se publican"*, y
 * publicar cada operación una por una era publicarlas por un camino más largo.
 *
 * **308 y no 404**, por lo mismo que `/leaderboard` es un 308: la ruta estuvo
 * enlazada desde la home y pudo quedar en un mensaje o en un marcador. Un
 * enlace que fue correcto no se contesta con un error.
 *
 * El feed no se borró — se mudó a `/admin/en-vivo`, detrás de `ADMIN_TOKEN`,
 * porque para operar hace falta ver lo que entra. `DECISIONES.md`, 2026-09-06.
 */
export default function EnVivoPage(): never {
  permanentRedirect("/");
}
