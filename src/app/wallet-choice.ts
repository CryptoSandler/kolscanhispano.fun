import bs58 from "bs58";
import { isEvm, type Chain } from "@/lib/chain";
import {
  connect as connectStandard,
  discoverWallets,
  signMessage,
  solanaWallets,
  type StandardWallet,
} from "@/lib/wallet-standard";
import { connectEvm, discoverEvmWallets, signPersonal, type Eip6963Wallet } from "@/lib/eip6963";

/**
 * Connecting a wallet and getting one message signed, for the two pages that do
 * it: `/registro` and `/mi-cabal`.
 *
 * **Extracted when the second caller appeared, not before.** `/registro` had all
 * of this inline while it was the only page that touched a wallet. The cabal
 * panel needs exactly the same three steps — discover, connect, sign — and a
 * second copy is where the two would drift: one of them would learn about a new
 * namespace and the other would not.
 *
 * **It signs messages and nothing else.** No transaction is built, offered or
 * sent, and `src/lib/no-money-path.test.ts` is what keeps that true rather than
 * this sentence — it refuses every transaction-constructing API in tracked
 * source. The only wallet feature reached for here is message signing.
 */
export type Choice =
  | { kind: "solana"; chain: Chain; name: string; icon?: string; wallet: StandardWallet }
  | { kind: "evm"; chain: Chain; name: string; icon?: string; wallet: Eip6963Wallet };

/**
 * Both handshakes, every time.
 *
 * Wallet Standard for Solana and EIP-6963 for EVM: a reader with two extensions
 * has two wallets, not one, and which protocol each speaks is not their problem.
 * Discovery runs on the click rather than on mount, so a wallet installed or
 * unlocked while the page is open is found on the next attempt without a reload.
 *
 * The EVM half is gated on `activeChains()` rather than on anything this file
 * knows: a wallet on a chain nothing indexes produces no trades and moves no
 * rank, which is `DESIGN.md`'s last Don't.
 */
export function discoverChoices(chains: readonly Chain[]): Choice[] {
  return [
    ...solanaWallets(discoverWallets()).map(
      (wallet): Choice => ({
        kind: "solana",
        chain: "solana",
        name: wallet.name,
        // El ícono lo trae la wallet, siempre como data URI. **Nunca un asset
        // nuestro**: dibujar el logo de una marca ajena es peor que no
        // dibujarlo, y una lista con íconos propios miente sobre qué está
        // instalado.
        icon: wallet.icon,
        wallet,
      }),
    ),
    ...(chains.some(isEvm)
      ? discoverEvmWallets().map(
          (wallet): Choice => ({
            // The first active EVM chain: today that is Robinhood and there is
            // exactly one. A reader with two would have to be asked, and that
            // question does not exist until a second chain is switched on
            // (`docs/multichain.md` §6).
            kind: "evm",
            chain: chains.find(isEvm)!,
            name: wallet.info.name,
            icon: wallet.info.icon,
            wallet,
          }),
        )
      : []),
  ];
}

export async function connectChoice(choice: Choice): Promise<string> {
  return choice.kind === "solana" ? connectStandard(choice.wallet) : connectEvm(choice.wallet);
}

/**
 * The same text, two signatures that are not the same shape.
 *
 * `proofMessage` builds one string and each namespace signs it its own way: a
 * Solana wallet over the raw bytes, an EVM wallet as EIP-191 `personal_sign`.
 * What travels differs too — base58 for one, `0x` hex for the other — which is
 * what each verifier expects. **The message is never branched on**, which is the
 * rule `docs/wallet-proof.md` §2.2 rests on.
 */
export async function signChoice(
  choice: Choice,
  address: string,
  message: string,
): Promise<string> {
  return choice.kind === "solana"
    ? bs58.encode(await signMessage(choice.wallet, address, new TextEncoder().encode(message)))
    : signPersonal(choice.wallet, address, message);
}

/**
 * Una fila por **wallet**, no por cadena.
 *
 * Phantom habla Wallet Standard y EIP-6963, así que `discoverChoices` la
 * devuelve dos veces — una por cada handshake. En una lista eso son dos filas
 * que dicen `Phantom` y no se distinguen entre sí, que es exactamente lo que el
 * dueño marcó en el gate.
 *
 * Se agrupa por nombre y la fila lleva **chips de las cadenas que soporta**. Si
 * al elegirla hay más de una, la cadena se pregunta en el paso siguiente; si hay
 * una sola, no hay nada que preguntar.
 *
 * El nombre es la clave porque es lo único que las dos APIs comparten: Wallet
 * Standard no expone `rdns` y EIP-6963 sí, así que no hay identificador común.
 * Dos extensiones distintas con el mismo nombre se fusionarían — no se conoce
 * un caso, y la alternativa (dos filas idénticas) es peor de todos modos.
 */
export type WalletOption = {
  name: string;
  icon?: string;
  /** Las cadenas que esta wallet puede firmar acá, en orden de descubrimiento. */
  chains: Chain[];
  /** La opción concreta por cadena, para cuando haya que conectar. */
  choices: Choice[];
};

export function groupChoices(choices: readonly Choice[]): WalletOption[] {
  const options = new Map<string, WalletOption>();
  for (const choice of choices) {
    const existing = options.get(choice.name);
    if (existing === undefined) {
      options.set(choice.name, {
        name: choice.name,
        icon: choice.icon,
        chains: [choice.chain],
        choices: [choice],
      });
      continue;
    }
    if (!existing.chains.includes(choice.chain)) existing.chains.push(choice.chain);
    existing.choices.push(choice);
    // El primer ícono que aparezca gana; los dos handshakes traen el mismo.
    existing.icon ??= choice.icon;
  }
  return [...options.values()];
}
