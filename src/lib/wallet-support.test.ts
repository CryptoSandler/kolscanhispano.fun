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
  /*
    **Phantom sí ofrece Robinhood, y no ofrece BNB.**

    Este caso decía lo contrario hasta el 2026-09-06, cuando `docs/wallets.md` se
    verificó contra las docs oficiales: Phantom trae Robinhood Chain (4663) de
    forma **nativa**. El razonamiento viejo —"anuncia EIP-6963, pero eso no
    implica cualquier EVM"— era cierto como premisa y falso como conclusión.

    Lo que sigue siendo verdad es que su lista es **cerrada**: no se le pueden
    agregar redes arbitrarias, y BNB no está adentro.
  */
  it("offers Robinhood for Phantom, natively, and still not BNB", () => {
    const chains = supportedChains("Phantom", ["solana"], ALL);
    expect(chains).toContain("robinhood");
    expect(chains).toContain("solana");
    expect(chains).toContain("ethereum");
    expect(chains).not.toContain("bnb");
  });

  it("offers Solana for MetaMask, which it has had since 2025", () => {
    expect(supportedChains("MetaMask", [], ALL)).toContain("solana");
  });

  it("does not offer Robinhood for Backpack, whose closed list lacks it", () => {
    const chains = supportedChains("Backpack", ["solana"], ALL);
    expect(chains).toContain("solana");
    expect(chains).not.toContain("robinhood");
    expect(chains).not.toContain("bnb");
  });

  it("offers Robinhood and BNB for the RPC-configurable wallets", () => {
    for (const name of ["MetaMask", "Rabby"]) {
      const chains = supportedChains(name, ["robinhood"], ALL);
      expect(chains, name).toContain("robinhood");
      expect(chains, name).toContain("bnb");
    }
  });

  it("ignores what a known wallet reported: the table decides", () => {
    // Solflare anunciando BNB no la habilita — su lista cerrada es sólo Solana.
    expect(supportedChains("Solflare", ["solana", "bnb"], ALL)).toEqual(["solana"]);
  });

  it("leaves out chains this product does not index, though the table names them", () => {
    // La tabla dice `base` y `polygon` porque las wallets las soportan; el cruce
    // con las cadenas activas es lo que las deja afuera de la pantalla.
    expect(supportedChains("Phantom", [], ALL)).not.toContain("base");
    expect(supportedChains("Phantom", [], ALL)).not.toContain("polygon");
  });

  it("keeps an unknown wallet's own report, because inventing a list is worse", () => {
    expect(supportedChains("Wallet Rara", ["solana"], ALL)).toEqual(["solana"]);
  });

  it("never offers a chain that is switched off", () => {
    /*
      Una cadena apagada no es una opción. El caso usa Rabby y no MetaMask
      porque MetaMask **sí** tiene Solana desde 2025 (`docs/wallets.md`,
      verificado el 2026-09-06): con `["solana"]` activo devolvía `["solana"]`,
      correctamente, y el caso fallaba por su propia premisa vencida.
    */
    expect(supportedChains("Rabby", ["robinhood"], ["solana"])).toEqual([]);
    expect(supportedChains("Solflare", ["solana"], ["bnb"])).toEqual([]);
  });

  it("lists no wallet twice under names that differ only in spacing", () => {
    // `Rabby` y `Rabby Wallet` son la misma extensión con dos nombres según el
    // handshake; las dos claves tienen que decir lo mismo.
    expect(WALLET_SUPPORT["Rabby"]).toEqual(WALLET_SUPPORT["Rabby Wallet"]);
  });
});
