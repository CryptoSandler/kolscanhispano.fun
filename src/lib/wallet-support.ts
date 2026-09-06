import type { Chain } from "./chain";

/**
 * Qué cadenas soporta cada wallet **de verdad**.
 *
 * Ver `docs/wallets.md`, que trae la tabla, las fuentes y el estado de
 * verificación. El resumen: anunciar EIP-6963 significa "hablo el protocolo de
 * descubrimiento EVM", no "firmo en cualquier cadena EVM". Phantom anuncia
 * EIP-6963 y **no** soporta Robinhood Chain; el selector la mostraba con ese
 * chip hasta el 2026-09-06.
 *
 * Sólo las wallets de RPC configurable —MetaMask, Rabby— aceptan una cadena
 * arbitraria, y por eso son las únicas con Robinhood (4663) y BNB.
 */

/** Las cadenas de este producto que cada wallet conocida puede firmar. */
export const WALLET_SUPPORT: Record<string, readonly Chain[]> = {
  // Lista cerrada: Solana, Ethereum, Base, Polygon. De las nuestras, dos.
  Phantom: ["solana", "ethereum"],
  // RPC configurable: cualquier EVM, incluidas Robinhood (4663) y BNB.
  MetaMask: ["robinhood", "bnb", "ethereum"],
  Rabby: ["robinhood", "bnb", "ethereum"],
  "Rabby Wallet": ["robinhood", "bnb", "ethereum"],
  // Multichain, lista más corta que MetaMask.
  Backpack: ["solana", "ethereum"],
  // Sólo Solana.
  Solflare: ["solana"],
};

/**
 * Las cadenas a mostrar para una wallet, cruzadas con las activas.
 *
 * **Una wallet desconocida conserva lo que su handshake reportó.** Es el
 * comportamiento viejo, y es el único posible para algo de lo que no sabemos
 * nada: inventarle una lista sería peor que confiar en lo que dijo.
 */
export function supportedChains(
  name: string,
  reported: readonly Chain[],
  active: readonly Chain[],
): Chain[] {
  const known = WALLET_SUPPORT[name];
  if (known === undefined) return [...reported];
  return known.filter((chain) => active.includes(chain));
}
