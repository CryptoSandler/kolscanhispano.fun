import { describe, expect, it } from "vitest";
import { WALLET_SUPPORT, supportedChains } from "./wallet-support";

/**
 * La tabla de soporte real por wallet. Ver `docs/wallets.md`.
 *
 * El caso que existe por el bug del gate es el primero: **Phantom no ofrece
 * Robinhood**. Anunciaba EIP-6963 y el selector deducía de ahí que firmaba en
 * cualquier cadena EVM, que no es lo que ese anuncio quiere decir.
 */
const ALL = ["solana", "robinhood", "bnb", "ethereum"] as const;

describe("supportedChains", () => {
  it("never offers Robinhood for Phantom, which is the bug this table exists for", () => {
    const chains = supportedChains("Phantom", ["solana", "robinhood"], ALL);
    expect(chains).not.toContain("robinhood");
    expect(chains).not.toContain("bnb");
    expect(chains).toContain("solana");
  });

  it("offers Robinhood and BNB for the RPC-configurable wallets", () => {
    for (const name of ["MetaMask", "Rabby"]) {
      const chains = supportedChains(name, ["robinhood"], ALL);
      expect(chains, name).toContain("robinhood");
      expect(chains, name).toContain("bnb");
    }
  });

  it("ignores what a known wallet reported, because the report is what was wrong", () => {
    // Phantom reportando Robinhood no la habilita: la tabla manda.
    expect(supportedChains("Solflare", ["solana", "bnb"], ALL)).toEqual(["solana"]);
  });

  it("keeps an unknown wallet's own report, because inventing a list is worse", () => {
    expect(supportedChains("Wallet Rara", ["solana"], ALL)).toEqual(["solana"]);
  });

  it("never offers a chain that is switched off", () => {
    // Una cadena apagada no es una opción, ni siquiera para MetaMask.
    expect(supportedChains("MetaMask", ["robinhood"], ["solana"])).toEqual([]);
  });

  it("lists no wallet twice under names that differ only in spacing", () => {
    // `Rabby` y `Rabby Wallet` son la misma extensión con dos nombres según el
    // handshake; las dos claves tienen que decir lo mismo.
    expect(WALLET_SUPPORT["Rabby"]).toEqual(WALLET_SUPPORT["Rabby Wallet"]);
  });
});
