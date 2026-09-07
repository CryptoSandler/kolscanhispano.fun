import type { Metadata } from "next";
import { activeChains } from "@/lib/chain";
import { CabalPanel } from "./cabal-panel";

export const metadata: Metadata = {
  title: "Mi DAO",
  description: "Crea tu DAO, pide entrar a una y administra la tuya firmando con tu wallet.",
};

/**
 * `/mi-cabal` — the panel a cabal leader acts from.
 *
 * A server wrapper for the same reason `/registro` has one: `activeChains()`
 * reads `CHAIN_ROBINHOOD_INGESTION` from `process.env`, and the panel is a
 * client component, so calling it there would answer `["solana"]` in the browser
 * whatever the flag said. One value, resolved on the server and handed down.
 */
export default function MiCabalPage() {
  return <CabalPanel chains={activeChains()} />;
}
