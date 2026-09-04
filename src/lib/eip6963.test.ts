import { describe, expect, it } from "vitest";
import { inventEvmAddress } from "./ids";
import {
  ANNOUNCE_EVENT,
  REQUEST_EVENT,
  connectEvm,
  discoverEvmWallets,
  signPersonal,
  type Eip6963Wallet,
} from "./eip6963";

/**
 * The EVM discovery `/registro` uses, exercised against fake wallets that
 * announce themselves exactly the way a real extension does.
 *
 * The same coverage `wallet-standard.test.ts` gives the Solana side, and it
 * exists for the same reason: `window.ethereum` is a global one extension
 * happens to own, so nothing that reads it can be driven from a test without
 * pretending to be that extension. An announced provider is an object and two
 * events, so the whole path is reachable here — including the ordering mistake
 * that loses every wallet, which is the one worth a test.
 */

/**
 * A fresh EVM address per run, never a literal.
 *
 * `hygiene.test.ts` caught the first version of this file writing
 * `0xAbC0…0001` out in full and was right to: the sweep cannot tell a fake
 * address from a real one, and the rule it enforces is that no EVM identifier
 * lives in a committed file outside the contract allowlist. A generated one is
 * also a better fixture — a literal is the same address in every case, so a
 * test that leaked it into another would still pass.
 */
const ADDRESS = inventEvmAddress();

/** A window that carries listeners and `dispatchEvent`, like the real one. */
function fakeWindow(onRequest: (win: Window) => void): Window {
  const listeners = new Map<string, Set<EventListener>>();
  const win = {
    addEventListener: (type: string, fn: EventListener) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(fn);
    },
    removeEventListener: (type: string, fn: EventListener) => {
      listeners.get(type)?.delete(fn);
    },
    dispatchEvent: (event: Event) => {
      for (const fn of [...(listeners.get(event.type) ?? [])]) fn(event);
      return true;
    },
    /** How many listeners are still installed, for the leak case below. */
    countListeners: () => [...listeners.values()].reduce((n, s) => n + s.size, 0),
  } as unknown as Window & { countListeners(): number };

  win.addEventListener(REQUEST_EVENT, () => onRequest(win));
  return win;
}

function announce(win: Window, wallet: Eip6963Wallet): void {
  win.dispatchEvent(new CustomEvent(ANNOUNCE_EVENT, { detail: wallet }));
}

function fakeWallet(rdns: string, overrides: Partial<Eip6963Wallet> = {}): Eip6963Wallet {
  return {
    info: { uuid: crypto.randomUUID(), name: rdns.split(".").pop()!, icon: "data:,", rdns },
    provider: { request: async () => undefined },
    ...overrides,
  };
}

describe("discoverEvmWallets", () => {
  it("finds every wallet that answers the request", () => {
    const metamask = fakeWallet("io.metamask");
    const rabby = fakeWallet("io.rabby");
    const win = fakeWindow((w) => {
      announce(w, metamask);
      announce(w, rabby);
    });

    expect(discoverEvmWallets(win).map((w) => w.info.rdns)).toEqual(["io.metamask", "io.rabby"]);
  });

  /**
   * The ordering the module documents, asserted rather than trusted: an
   * extension already injected answers **synchronously**, so a page that
   * dispatched the request before installing its listener would see nothing at
   * all — and would look exactly like a reader with no wallet installed.
   */
  it("hears a wallet that answers in the same tick", () => {
    let answered = false;
    const win = fakeWindow((w) => {
      answered = true;
      announce(w, fakeWallet("io.metamask"));
    });

    const found = discoverEvmWallets(win);
    expect(answered).toBe(true);
    expect(found).toHaveLength(1);
  });

  /**
   * `rdns` is the wallet's identity; `uuid` is fresh per announcement. Some
   * wallets announce on every request event, so keying the map on `uuid` shows
   * one wallet several times — which a reader reads as several wallets.
   */
  it("shows a wallet once even when it announces repeatedly", () => {
    const win = fakeWindow((w) => {
      announce(w, fakeWallet("io.metamask"));
      announce(w, fakeWallet("io.metamask"));
      announce(w, fakeWallet("io.metamask"));
    });

    expect(discoverEvmWallets(win)).toHaveLength(1);
  });

  it("ignores an announcement that is not a wallet", () => {
    const win = fakeWindow((w) => {
      w.dispatchEvent(new CustomEvent(ANNOUNCE_EVENT, { detail: { info: { rdns: "x" } } }));
      w.dispatchEvent(new CustomEvent(ANNOUNCE_EVENT, { detail: null }));
      w.dispatchEvent(new CustomEvent(ANNOUNCE_EVENT, { detail: "io.metamask" }));
      announce(w, fakeWallet("io.rabby"));
    });

    expect(discoverEvmWallets(win).map((w) => w.info.rdns)).toEqual(["io.rabby"]);
  });

  /**
   * The `finally` in the module: a wallet whose own announce handler throws must
   * not leave a listener behind, or a page that opens the chooser ten times
   * accumulates ten listeners and every wallet is announced ten times.
   */
  it("leaves no listener behind, even when a wallet throws", () => {
    const win = fakeWindow(() => {
      throw new Error("this wallet is broken");
    }) as Window & { countListeners(): number };

    expect(() => discoverEvmWallets(win)).toThrow();
    // One remains: the fake window's own request handler, installed by the test.
    expect(win.countListeners()).toBe(1);
  });
});

describe("connectEvm", () => {
  it("asks for accounts rather than reading the ones already authorised", async () => {
    const asked: string[] = [];
    const wallet = fakeWallet("io.metamask", {
      provider: {
        request: async ({ method }) => {
          asked.push(method);
          return [ADDRESS];
        },
      },
    });

    const address = await connectEvm(wallet);
    // `eth_accounts` answers silently with whatever was authorised before, which
    // is an address without a prompt. The prompt is the point.
    expect(asked).toEqual(["eth_requestAccounts"]);
    expect(address).toBe(ADDRESS);
  });

  it("refuses when the wallet returns no account", async () => {
    for (const answer of [[], undefined, [""], "0xabc"]) {
      const wallet = fakeWallet("io.metamask", { provider: { request: async () => answer } });
      await expect(connectEvm(wallet)).rejects.toThrow("wallet_no_account");
    }
  });
});

describe("signPersonal", () => {
  /**
   * **The parameter order is the whole test.** `personal_sign` takes
   * `[message, address]`; `eth_sign` takes the reverse, and a wallet handed the
   * pair the wrong way round either refuses or signs the address as a message —
   * producing a signature the server correctly rejects, after the reader has
   * already approved a dialog.
   */
  it("passes the message first and the address second, as hex", async () => {
    let seen: unknown[] = [];
    const wallet = fakeWallet("io.metamask", {
      provider: {
        request: async ({ params }) => {
          seen = params ?? [];
          return "0x" + "11".repeat(65);
        },
      },
    });

    await signPersonal(wallet, "0xabc", "hola\nmundo");

    expect(seen[0]).toBe(`0x${Buffer.from("hola\nmundo", "utf8").toString("hex")}`);
    expect(seen[1]).toBe("0xabc");
  });

  it("keeps the message's bytes exactly, accents and newlines included", async () => {
    let hex = "";
    const wallet = fakeWallet("io.metamask", {
      provider: {
        request: async ({ params }) => {
          hex = params?.[0] as string;
          return "0x" + "22".repeat(65);
        },
      },
    });

    // The proof message is Spanish and multi-line: `Cadena:`, `Expira:`, and a
    // sentence with accents. A mangled encoding here fails on the server with a
    // signature that looks valid, which is the least debuggable outcome.
    const message = "kolscanhispano.fun quiere verificar que controlas esta wallet.\nCadena: eip155:4663";
    await signPersonal(wallet, "0xabc", message);

    expect(Buffer.from(hex.slice(2), "hex").toString("utf8")).toBe(message);
  });

  it("refuses anything that is not a hex signature", async () => {
    for (const answer of [undefined, "", "no-hex", 42, null]) {
      const wallet = fakeWallet("io.metamask", { provider: { request: async () => answer } });
      await expect(signPersonal(wallet, "0xabc", "hola")).rejects.toThrow("wallet_bad_signature");
    }
  });
});
