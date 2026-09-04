import { activeChains } from "@/lib/chain";
import { RegistroForm } from "./registro-form";

/**
 * `/registro` — spec §6, the only page in the product that connects a wallet.
 *
 * **This wrapper exists for one reason: the chain flag is a server value.**
 *
 * `activeChains()` reads `CHAIN_ROBINHOOD_INGESTION` from `process.env`, and the
 * form below is a client component — so calling it there returned `["solana"]`
 * in the browser no matter what the flag said, and the EVM half of the wallet
 * chooser silently never ran. It failed the way a switched-off feature looks,
 * which is why it took driving the page with a fake wallet to see it.
 *
 * The alternative was a second `NEXT_PUBLIC_` copy of the flag, and that is
 * precisely what `chain.ts` says it exists to prevent: *"so the registration
 * screen, the profile and anything else that offers a chain cannot disagree
 * about which ones exist yet."* Two variables are two answers. One value,
 * resolved on the server and handed down as a prop, is one.
 */
export default function RegistroPage() {
  return <RegistroForm chains={activeChains()} />;
}
