import { activeChains } from "@/lib/chain";
import { AdminScreen } from "./admin-screen";

/**
 * `/admin` — a server wrapper, for the same reason `/registro` has one.
 *
 * `activeChains()` reads `CHAIN_ROBINHOOD_INGESTION` from `process.env`. The
 * screen below is a client component, so calling it there produced one list on
 * the server and another in the browser: React reported a hydration mismatch on
 * the `<option>` for that chain, which is how it was found — in the dev-server
 * log of a Playwright run that otherwise passed.
 *
 * The alternative was a second `NEXT_PUBLIC_` copy of the flag, and that is
 * precisely what `chain.ts` says it exists to prevent: two variables are two
 * answers about which chains exist.
 */
export default function AdminPage() {
  return <AdminScreen chains={activeChains()} />;
}
