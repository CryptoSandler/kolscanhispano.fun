/**
 * EVM wallet discovery for `/registro`, over the EIP-6963 handshake.
 *
 * The exact counterpart of `wallet-standard.ts`, one namespace over, and it
 * exists for the same reason that file does: **the list is open by
 * construction.** Nothing here names a wallet. A wallet appears because it
 * announced itself, and it disappears for the same reason. Adding support for a
 * new one is not a code change.
 *
 * ## Why not `window.ethereum`
 *
 * The same defect `wallet-standard.ts` was written to remove, in the namespace
 * where it is worse. `window.ethereum` is one global awarded to whichever
 * extension overwrote it last, and EVM users routinely run three — MetaMask,
 * Rabby, a hardware bridge. Reading that global is not "a fixed list of one": it
 * is a list whose single entry is decided by load order, and the reader cannot
 * choose. EIP-6963 exists because that race was bad enough to standardise a way
 * out of it.
 *
 * ## The handshake, both halves
 *
 * Two events, because a wallet may load before or after the page:
 *
 * - a wallet already in the document dispatches `eip6963:announceProvider`
 *   whenever it sees `eip6963:requestProvider`;
 * - the page dispatches `eip6963:requestProvider`, and every wallet answers.
 *
 * The listener is installed **before** the request goes out. Requesting first
 * and listening after loses every wallet that answers synchronously, which is
 * the usual case for an extension already injected — the same ordering mistake
 * `wallet-standard.ts` documents on its side.
 *
 * ## No dependency
 *
 * `viem` and `ethers` both ship a discovery helper, and both bring a provider
 * stack, an ABI codec and a transaction builder with them. `no-money-path.test.ts`
 * fails the suite if a transaction-constructing API becomes importable from
 * application code, so the cheap way to get discovery would cost this project
 * the invariant that keeps `docs/wallet-warnings.md` rules 1 and 2 dormant. The
 * handshake is two events and forty lines; the ABI codec is not worth it.
 */

/** What a wallet says about itself. `rdns` is the stable identity; `name` is for a reader. */
export type ProviderInfo = {
  uuid: string;
  name: string;
  icon: string;
  rdns: string;
};

/**
 * The slice of EIP-1193 this project uses, and deliberately no more.
 *
 * `request` is the whole provider surface as far as `/registro` is concerned,
 * and the two methods below are the only ones it ever passes. Typing the
 * provider as `unknown`-with-a-request rather than importing a full EIP-1193
 * interface keeps `eth_sendTransaction` from being reachable by autocomplete in
 * a file that must never call it.
 */
export type Eip1193Provider = {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
};

export type Eip6963Wallet = {
  info: ProviderInfo;
  provider: Eip1193Provider;
};

/** The two event names, from EIP-6963. */
export const ANNOUNCE_EVENT = "eip6963:announceProvider";
export const REQUEST_EVENT = "eip6963:requestProvider";

type AnnounceEvent = CustomEvent<Eip6963Wallet>;

function looksLikeWallet(detail: unknown): detail is Eip6963Wallet {
  if (typeof detail !== "object" || detail === null) return false;
  const { info, provider } = detail as { info?: unknown; provider?: unknown };
  if (typeof provider !== "object" || provider === null) return false;
  if (typeof (provider as { request?: unknown }).request !== "function") return false;
  if (typeof info !== "object" || info === null) return false;
  const { uuid, name, rdns } = info as Record<string, unknown>;
  return typeof uuid === "string" && typeof name === "string" && typeof rdns === "string";
}

/**
 * Every EVM wallet in the document, collected over one round of the handshake.
 *
 * Synchronous, like its Solana counterpart, and for the same reason: an
 * extension that is already injected answers `eip6963:requestProvider` in the
 * same tick, so the wallets a reader actually has are known by the time this
 * returns. A wallet that loads later announces itself again and is found by the
 * next call — which is what the chooser does when it reopens.
 *
 * **Deduplicated by `rdns`, not by `uuid`.** A wallet may announce more than
 * once in a round (some do it on every request event), and `uuid` is fresh per
 * announcement while `rdns` is the wallet's identity. Keying on `uuid` shows
 * MetaMask three times.
 */
export function discoverEvmWallets(target: Window = window): Eip6963Wallet[] {
  const found = new Map<string, Eip6963Wallet>();

  const onAnnounce = (event: Event) => {
    const detail = (event as AnnounceEvent).detail;
    if (looksLikeWallet(detail) && !found.has(detail.info.rdns)) {
      found.set(detail.info.rdns, detail);
    }
  };

  target.addEventListener(ANNOUNCE_EVENT, onAnnounce);
  try {
    target.dispatchEvent(new Event(REQUEST_EVENT));
  } finally {
    // Removed in a `finally` so a wallet that throws inside its own announce
    // handler cannot leave this page accumulating listeners on every open.
    target.removeEventListener(ANNOUNCE_EVENT, onAnnounce);
  }

  return [...found.values()];
}

/**
 * The connected account, as the address the wallet will sign with.
 *
 * `eth_requestAccounts` and never `eth_accounts`: the second answers silently
 * with whatever was already authorised, which means a reader who has not
 * approved anything gets an empty array and a reader who approved this site
 * months ago gets an address without being asked. The prompt is the point.
 */
export async function connectEvm(wallet: Eip6963Wallet): Promise<string> {
  const accounts = await wallet.provider.request({ method: "eth_requestAccounts" });
  const address = Array.isArray(accounts) ? accounts[0] : undefined;
  if (typeof address !== "string" || address.length === 0) throw new Error("wallet_no_account");
  return address;
}

/**
 * Signs `message` with `address`, as EIP-191 `personal_sign`.
 *
 * ## The parameter order, which is the classic way to get this wrong
 *
 * `personal_sign` takes `[message, address]` — the message **first**. `eth_sign`
 * takes them the other way round, and a wallet handed the pair in the wrong
 * order either refuses or, worse, signs the address as if it were a message.
 * `docs/wallet-proof.md` §2 rule 2 says the server rebuilds the text it expects;
 * a signature over the wrong string fails there, after the reader has already
 * approved a dialog, which is the worst place to find a parameter order bug.
 *
 * ## Hex, and why the encoding is here rather than at the call site
 *
 * The message goes as `0x`-prefixed UTF-8 hex. A wallet handed raw text mostly
 * works and sometimes double-encodes; the hex form is unambiguous and is what
 * the specification shows. The digest the server verifies is built from the same
 * bytes by `personalSignDigest`, so the encoding has exactly one definition on
 * each side and neither is a string the other has to parse.
 */
export async function signPersonal(
  wallet: Eip6963Wallet,
  address: string,
  message: string,
): Promise<string> {
  const hex = `0x${Buffer.from(message, "utf8").toString("hex")}`;
  const signature = await wallet.provider.request({
    method: "personal_sign",
    params: [hex, address],
  });
  if (typeof signature !== "string" || !signature.startsWith("0x")) {
    throw new Error("wallet_bad_signature");
  }
  return signature;
}
