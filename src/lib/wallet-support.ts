import type { Chain } from "./chain";

/**
 * Qué cadenas soporta cada wallet, **verificado el 2026-09-06** contra las docs
 * oficiales. Las fuentes, fila por fila, están en `docs/wallets.md`.
 *
 * ## La distinción es lista cerrada vs RPC configurable
 *
 * No es "soporta EVM" contra "no soporta EVM", que es como estaba escrito acá y
 * llevó a una conclusión falsa.
 *
 * - **Lista cerrada** — Phantom, Backpack, Solflare. Soportan un conjunto fijo
 *   de redes y **no dejan agregar una arbitraria**: *"You can't add new or
 *   custom networks to Phantom manually"*. Que la lista sea cerrada no dice
 *   nada sobre qué hay adentro.
 * - **RPC configurable** — MetaMask, Rabby. Cualquier cadena EVM entra como red
 *   personalizada, así que soportan Robinhood y BNB por construcción.
 *
 * **Robinhood Chain (4663) entra por los dos caminos**, y ése es el punto:
 * Phantom la trae **nativa, en su lista cerrada**; MetaMask y Rabby la aceptan
 * **por RPC**. Un modelo que sólo tuviera "configurable ⇒ Robinhood" se
 * equivoca con Phantom, que fue exactamente el error anterior.
 *
 * ## El error que esto corrige
 *
 * La versión previa decía que Phantom **no** soportaba Robinhood, razonando que
 * anunciar EIP-6963 no implica firmar en cualquier EVM. Lo primero es falso y lo
 * segundo es cierto: son dos cosas distintas y se mezclaron. El chip de
 * Robinhood en Phantom que "rompió" el gate estaba bien; lo que estaba mal era
 * el modelo mental que lo sacó.
 *
 * ## Cadenas que este producto no indexa
 *
 * La tabla nombra `base` y `polygon` porque es lo que las wallets soportan, y
 * este archivo describe wallets, no nuestro `Chain`. {@link supportedChains}
 * cruza la lista con las cadenas activas, así que lo que no indexamos no llega
 * nunca a una pantalla — pero queda escrito, que es lo que hace la tabla
 * comparable con la fuente.
 */

/**
 * Las cadenas de cada wallet conocida, por nombre.
 *
 * `string[]` y no `Chain[]`: incluye redes que este producto no indexa.
 */
export const WALLET_SUPPORT: Record<string, readonly string[]> = {
  // Lista cerrada, y bastante ancha: Robinhood es nativa desde 2026.
  Phantom: ["solana", "ethereum", "base", "polygon", "robinhood"],
  // RPC configurable, más Solana nativa desde 2025.
  MetaMask: ["solana", "ethereum", "robinhood", "bnb"],
  Rabby: ["robinhood", "bnb", "ethereum"],
  "Rabby Wallet": ["robinhood", "bnb", "ethereum"],
  // Lista cerrada; sin Robinhood.
  Backpack: ["solana", "ethereum", "polygon", "base"],
  // Sólo Solana.
  Solflare: ["solana"],
};

/**
 * Las cadenas a mostrar para una wallet: lo que soporta, cruzado con lo que
 * este sitio tiene encendido.
 *
 * **Una wallet desconocida conserva lo que su handshake reportó.** Es el único
 * comportamiento posible para algo de lo que no sabemos nada: inventarle una
 * lista sería peor que confiar en lo que dijo.
 */
export function supportedChains(
  name: string,
  reported: readonly Chain[],
  active: readonly Chain[],
): Chain[] {
  const known = WALLET_SUPPORT[name];
  if (known === undefined) return [...reported];
  // El cruce es lo que deja afuera `base` y `polygon`, que la tabla nombra
  // porque las wallets las soportan y este producto no indexa.
  return active.filter((chain) => known.includes(chain));
}
