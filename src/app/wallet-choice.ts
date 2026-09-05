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
      (wallet): Choice => ({ kind: "solana", chain: "solana", name: wallet.name, wallet }),
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
