import type { Page } from "@playwright/test";
import { inventAddress } from "../src/lib/ids";

/**
 * Two wallets that register themselves over the Wallet Standard handshake, the
 * way a browser extension does.
 *
 * Its own module rather than a spec, because both the behavioural spec and the
 * captures need it and importing one spec from another would register its tests
 * twice.
 *
 * Deliberately not typed from `src/lib/wallet-standard.ts`: this stands in for a
 * third party, and it should break if the app starts expecting something the
 * standard does not promise.
 */
/**
 * @param names Nombres de las wallets de Solana a registrar. Por defecto las de
 *   la lista fija; pasar una que no esté —`Glow`— es lo que ejercita el camino
 *   de "detectada pero desconocida", que va al final de `Mostrar más`.
 */
export async function installWallets(
  page: Page,
  solanaCount = 1,
  names?: readonly string[],
) {
  // Generated on the Node side and passed in, never written down: `hygiene.ts`
  // fails the suite on any base58 run of 32+ anywhere in the repository, and an
  // address literal in a fixture is exactly what that rule is for. It caught the
  // first draft of this file.
  await page.addInitScript(
    ({
      address,
      count,
      names,
    }: {
      address: string;
      count: number;
      names?: readonly string[];
    }) => {
      const account = { address, publicKey: new Uint8Array(32) };

      const solanaWallet = (n: number) => ({
        /*
        **Se llaman como wallets reales desde el 2026-09-06.**

        El selector muestra una lista fija —Phantom, MetaMask, Rabby, y tres más
        detrás de `Mostrar más`— y busca la instalada por nombre normalizado. Una
        wallet falsa llamada `Prueba Solana 2` no aparece en ninguna fila, así
        que no se puede elegir y el flujo no se puede manejar.

        `Phantom` y `Backpack` son las dos que este fixture necesita: las dos
        firman en Solana, una está en la lista principal y la otra detrás de
        `Mostrar más`, que es justo el par que hace falta para probar las dos
        mitades de la lista.
      */
        name: names?.[n - 1] ?? (n === 1 ? "Phantom" : "Backpack"),
        // A data URI, like every real wallet icon, so the chooser's image path is
        // exercised without a network request. Deliberately an unencoded SVG and
        // not base64: a base64 payload contains long base58-shaped runs, and the
        // repository scan flags those. It flagged the base64 GIF this replaced.
        icon: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='1' height='1'/%3E",
        chains: ["solana:mainnet"],
        accounts: [account],
        features: {
          "standard:connect": {
            connect: async () => ({ accounts: [account] }),
          },
          "solana:signMessage": {
            signMessage: async () => [
              { signature: new Uint8Array(64).fill(7) },
            ],
          },
        },
      });

      // The Rabby case: a wallet that registers itself properly and does no
      // Solana. It must not appear in a Solana chooser, and it must not appear
      // because of what it declares -- not because anything here knows its name.
      const evmOnlyWallet = {
        name: "Prueba Solo EVM",
        chains: ["eip155:1", "eip155:8453"],
        accounts: [],
        features: {
          "standard:connect": { connect: async () => ({ accounts: [] }) },
        },
      };

      const wallets = [
        ...Array.from({ length: count }, (_, i) => solanaWallet(i + 1)),
        evmOnlyWallet,
      ];
      const announce = (api: { register: (...w: unknown[]) => unknown }) =>
        api.register(...wallets);

      window.addEventListener("wallet-standard:app-ready", (event) => {
        announce(
          (event as CustomEvent<{ register: (...w: unknown[]) => unknown }>)
            .detail,
        );
      });
    },
    { address: inventAddress(), count: solanaCount, names },
  );
}
