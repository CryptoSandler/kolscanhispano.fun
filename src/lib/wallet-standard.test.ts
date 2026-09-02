import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CONNECT_FEATURE,
  SIGN_MESSAGE_FEATURE,
  connect,
  discoverWallets,
  signMessage,
  solanaWallets,
  type StandardWallet,
} from "./wallet-standard";

/**
 * The discovery `/registro` uses, exercised against a fake wallet that registers
 * itself exactly the way a real extension does.
 *
 * This is the coverage the old `window.solana` path never had: a global that one
 * extension happens to own cannot be driven from a test without pretending to be
 * that extension, so nothing exercised the connect flow at all. A registered
 * wallet is just an object and two events, so the whole path is reachable here.
 */

type Registrar = (api: { register: (...wallets: StandardWallet[]) => () => void }) => void;

/** A minimal window that carries listeners and `dispatchEvent`, like the real one. */
function fakeWindow(): Window {
  const listeners = new Map<string, Set<EventListener>>();
  return {
    addEventListener: (type: string, fn: EventListener) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(fn);
    },
    removeEventListener: (type: string, fn: EventListener) => listeners.get(type)?.delete(fn),
    dispatchEvent: (event: Event) => {
      for (const fn of listeners.get(event.type) ?? []) fn(event);
      return true;
    },
    // The wallet half: what an extension already in the document does when it
    // hears `app-ready`.
    __present: (...wallets: StandardWallet[]) => {
      const fn = ((event: Event) => {
        const api = (event as CustomEvent<{ register: (...w: StandardWallet[]) => () => void }>)
          .detail;
        api.register(...wallets);
      }) as EventListener;
      if (!listeners.has("wallet-standard:app-ready")) {
        listeners.set("wallet-standard:app-ready", new Set());
      }
      listeners.get("wallet-standard:app-ready")!.add(fn);
    },
    // The other half: an extension that loads *after* the page and announces itself.
    __late: (...wallets: StandardWallet[]) => {
      const detail: Registrar = (api) => api.register(...wallets);
      for (const fn of listeners.get("wallet-standard:register-wallet") ?? []) {
        fn(new CustomEvent("wallet-standard:register-wallet", { detail }));
      }
    },
  } as unknown as Window;
}

function wallet(name: string, overrides: Partial<StandardWallet> = {}): StandardWallet {
  return {
    name,
    chains: ["solana:mainnet"],
    accounts: [{ address: `addr-${name}` }],
    features: {
      [CONNECT_FEATURE]: { connect: async () => ({ accounts: [{ address: `addr-${name}` }] }) },
      [SIGN_MESSAGE_FEATURE]: { signMessage: async () => [{ signature: new Uint8Array([1, 2]) }] },
    },
    ...overrides,
  };
}

describe("Wallet Standard discovery", () => {
  it("finds a wallet that was already in the document when the page asked", () => {
    const target = fakeWindow();
    (target as unknown as { __present: (...w: StandardWallet[]) => void }).__present(
      wallet("Alpha"),
    );

    expect(discoverWallets(target).map((w) => w.name)).toEqual(["Alpha"]);
  });

  /**
   * The half that is usually forgotten. A page that only listens for
   * `register-wallet` finds nothing when the extension won the load race, which
   * is the ordinary case — so this asserts the `app-ready` dispatch specifically.
   */
  it("dispatches app-ready, so a wallet that loaded first is not missed", () => {
    const target = fakeWindow();
    const seen: string[] = [];
    target.addEventListener("wallet-standard:app-ready", (event) => {
      seen.push(event.type);
      (event as CustomEvent<{ register: (...w: StandardWallet[]) => () => void }>).detail.register(
        wallet("Beta"),
      );
    });

    expect(discoverWallets(target).map((w) => w.name)).toEqual(["Beta"]);
    expect(seen).toEqual(["wallet-standard:app-ready"]);
  });

  it("registers a wallet that announces itself through register-wallet", () => {
    const target = fakeWindow();
    let found: string[] = [];
    // The listener is attached only for the duration of the call, so the late
    // wallet has to arrive while discovery is running -- which is what a wallet
    // injected during the same tick does.
    target.addEventListener("wallet-standard:app-ready", () => {
      (target as unknown as { __late: (...w: StandardWallet[]) => void }).__late(wallet("Gamma"));
    });
    found = discoverWallets(target).map((w) => w.name);

    expect(found).toEqual(["Gamma"]);
  });

  it("lists several wallets, which is the case the old single global could not represent", () => {
    const target = fakeWindow();
    (target as unknown as { __present: (...w: StandardWallet[]) => void }).__present(
      wallet("Alpha"),
      wallet("Beta"),
      wallet("Gamma"),
    );

    expect(discoverWallets(target).map((w) => w.name)).toEqual(["Alpha", "Beta", "Gamma"]);
  });

  it("does not list the same wallet twice when it registers twice", () => {
    const target = fakeWindow();
    (target as unknown as { __present: (...w: StandardWallet[]) => void }).__present(
      wallet("Alpha"),
      wallet("Alpha"),
    );

    expect(discoverWallets(target).map((w) => w.name)).toEqual(["Alpha"]);
  });

  it("finds nothing, and does not throw, when no wallet is installed", () => {
    expect(discoverWallets(fakeWindow())).toEqual([]);
  });
});

describe("which registered wallets can do this page's job", () => {
  /**
   * The Rabby case, stated as a test rather than as a comment.
   *
   * Verified 2026-09-01 from `rabby.io`, which lists 63 chains — every one of
   * them EVM — and titles itself *"Your Go-to Wallet for Ethereum and EVM"*.
   * A wallet with no Solana chain is not hidden by a list this page keeps; it is
   * absent because it declares no Solana chain, and it would appear the day it
   * declared one, with no change here.
   */
  it("leaves out an EVM-only wallet, whatever its name", () => {
    const evmOnly = wallet("EvmOnly", { chains: ["eip155:1", "eip155:8453"] });
    expect(solanaWallets([evmOnly, wallet("Alpha")]).map((w) => w.name)).toEqual(["Alpha"]);
  });

  it("leaves out a Solana wallet that cannot sign a message", () => {
    const noSigning = wallet("NoSign", {
      features: { [CONNECT_FEATURE]: { connect: async () => ({ accounts: [] }) } },
    });
    expect(solanaWallets([noSigning])).toEqual([]);
  });

  it("leaves out a wallet that can sign but cannot connect", () => {
    const noConnect = wallet("NoConnect", {
      features: { [SIGN_MESSAGE_FEATURE]: { signMessage: async () => [] } },
    });
    expect(solanaWallets([noConnect])).toEqual([]);
  });

  it("keeps a wallet on devnet, because the chain is stated in the signed payload", () => {
    const devnet = wallet("Devnet", { chains: ["solana:devnet"] });
    expect(solanaWallets([devnet]).map((w) => w.name)).toEqual(["Devnet"]);
  });

  it("names no wallet anywhere in the module, so the list cannot be closed by edit", () => {
    // A guard on the source rather than on behaviour: the moment somebody adds
    // `if (wallet.name === "…")` the list stops being open, and that is exactly
    // the change this whole module exists to prevent.
    const source = readFileSync(new URL("./wallet-standard.ts", import.meta.url), "utf8");
    for (const name of ["Phantom", "Solflare", "Backpack", "Rabby", "MetaMask", "Coinbase"]) {
      expect(source, `wallet-standard.ts must not name ${name}`).not.toContain(name);
    }
  });
});

describe("connecting and signing", () => {
  it("returns the first account's address", async () => {
    await expect(connect(wallet("Alpha"))).resolves.toBe("addr-Alpha");
  });

  it("refuses when the wallet connects but hands back no account", async () => {
    const empty = wallet("Empty", {
      features: {
        [CONNECT_FEATURE]: { connect: async () => ({ accounts: [] }) },
        [SIGN_MESSAGE_FEATURE]: { signMessage: async () => [] },
      },
    });
    await expect(connect(empty)).rejects.toThrow("wallet_no_account");
  });

  it("signs with the account whose address was connected, not with accounts[0]", async () => {
    const seen: string[] = [];
    const two = wallet("Two", {
      accounts: [{ address: "second" }, { address: "first" }],
      features: {
        [CONNECT_FEATURE]: { connect: async () => ({ accounts: [{ address: "first" }] }) },
        [SIGN_MESSAGE_FEATURE]: {
          signMessage: async (input: { account: { address: string } }) => {
            seen.push(input.account.address);
            return [{ signature: new Uint8Array([9]) }];
          },
        },
      },
    });

    // `accounts[0]` is "second"; the connected address is "first". Signing with
    // the wrong one produces a proof the server rejects, after the reader has
    // already approved the dialog.
    await signMessage(two, "first", new Uint8Array([1]));
    expect(seen).toEqual(["first"]);
  });

  it("refuses when the connected account is no longer in the wallet", async () => {
    await expect(signMessage(wallet("Alpha"), "gone", new Uint8Array([1]))).rejects.toThrow(
      "wallet_account_gone",
    );
  });

  it("refuses when the wallet returns no signature", async () => {
    const silent = wallet("Silent", {
      features: {
        [CONNECT_FEATURE]: { connect: async () => ({ accounts: [{ address: "addr-Silent" }] }) },
        [SIGN_MESSAGE_FEATURE]: { signMessage: async () => [] },
      },
    });
    await expect(signMessage(silent, "addr-Silent", new Uint8Array([1]))).rejects.toThrow(
      "wallet_no_signature",
    );
  });

  it("passes the message through untouched", async () => {
    let received: Uint8Array | null = null;
    const spy = wallet("Spy", {
      features: {
        [CONNECT_FEATURE]: { connect: async () => ({ accounts: [{ address: "addr-Spy" }] }) },
        [SIGN_MESSAGE_FEATURE]: {
          signMessage: async (input: { message: Uint8Array }) => {
            received = input.message;
            return [{ signature: new Uint8Array([7]) }];
          },
        },
      },
    });

    const message = new TextEncoder().encode("alta de perfil");
    await signMessage(spy, "addr-Spy", message);
    expect(received).toEqual(message);
  });
});

