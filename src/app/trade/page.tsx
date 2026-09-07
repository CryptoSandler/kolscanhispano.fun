import { permanentRedirect } from "next/navigation";

/**
 * `/trade` — **308 a la home desde el 2026-09-06.**
 *
 * Decisión del dueño: la página se elimina **por ahora**, y vuelve cuando haya
 * terminal socio (`DECISIONES.md`). Sin socio, era una página que explicaba
 * cómo operar y no ofrecía dónde — un control que no funciona, que es la última
 * prohibición de `DESIGN.md` aplicada a una pantalla entera.
 *
 * **308 y no 404**, por lo mismo que `/leaderboard` y `/en-vivo`: la ruta estuvo
 * en el nav y pudo quedar en un marcador. Un enlace que fue correcto no se
 * contesta con un error.
 *
 * Lo que había adentro no se perdió: el disclaimer legal está al pie de
 * `/cabals` —el único lugar donde queda— y `Cómo protegemos tus wallets` es
 * ahora `/privacidad`, enlazada desde el pie.
 */
export default function TradePage(): never {
  permanentRedirect("/");
}
