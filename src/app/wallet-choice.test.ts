import { describe, expect, it } from "vitest";
import type { Chain } from "@/lib/chain";
import { groupChoices, type Choice } from "./wallet-choice";

/**
 * Una fila por wallet, con su ícono real.
 *
 * Bug del gate, 2026-09-06: la lista mostraba una fila por *handshake*, así que
 * Phantom —que habla Wallet Standard y EIP-6963— aparecía dos veces, con el
 * mismo nombre y sin nada que las distinguiera.
 */
describe("groupChoices", () => {
  const solana = (name: string): Choice => ({
    kind: "solana",
    chain: "solana",
    name,
    icon: "data:image/svg+xml,sol",
    wallet: {} as never,
  });
  const evm = (name: string, chain: Chain = "robinhood"): Choice => ({
    kind: "evm",
    chain,
    name,
    icon: "data:image/svg+xml,evm",
    wallet: {} as never,
  });

  it("shows a wallet that speaks both handshakes once, with both chains", () => {
    // Phantom habla Wallet Standard y EIP-6963: dos filas idénticas que dicen
    // `Phantom` es lo que el dueño marcó en el gate.
    const options = groupChoices([solana("Phantom"), evm("Phantom")]);

    expect(options).toHaveLength(1);
    expect(options[0].name).toBe("Phantom");
    expect(options[0].chains).toEqual(["solana", "robinhood"]);
    expect(options[0].choices).toHaveLength(2);
  });

  it("keeps two different wallets apart", () => {
    const options = groupChoices([solana("Phantom"), evm("MetaMask")]);
    expect(options.map((option) => option.name)).toEqual(["Phantom", "MetaMask"]);
  });

  it("carries the wallet's own icon and never invents one", () => {
    const [option] = groupChoices([solana("Phantom")]);
    expect(option.icon).toBe("data:image/svg+xml,sol");

    // Una wallet sin ícono se queda sin ícono: dibujarle uno nuestro sería
    // poner la marca de un tercero donde el tercero no la puso.
    const [bare] = groupChoices([{ ...solana("Rara"), icon: undefined }]);
    expect(bare.icon).toBeUndefined();
  });

  it("does not repeat a chain a wallet reported twice", () => {
    const [option] = groupChoices([evm("MetaMask"), evm("MetaMask")]);
    expect(option.chains).toEqual(["robinhood"]);
    expect(option.choices).toHaveLength(2);
  });

  it("returns nothing for nothing", () => {
    expect(groupChoices([])).toEqual([]);
  });
});
