/**
 * Wallet discovery for `/registro`, over the Wallet Standard handshake.
 *
 * **The list is open by construction.** Nothing here names a wallet. A wallet
 * appears because it registered itself and declared the two things this page
 * needs — a Solana chain and the ability to sign a message — and it disappears
 * for the same reason. Adding support for a new wallet is not a code change.
 *
 * ## What this replaces, and why the old one was the most closed list possible
 *
 * `/registro` used to read `window.solana`: one global, one slot, awarded to
 * whichever extension overwrote it last. With two Solana wallets installed the
 * reader cannot choose, and which one answers is a race between two content
 * scripts. That is not "a fixed list of one" — it is a list whose single entry
 * is decided by load order.
 *
 * ## The handshake, both halves
 *
 * The protocol is two events, because a wallet may load before or after the page:
 *
 * - the page dispatches `wallet-standard:app-ready` carrying an API object, and
 *   every wallet already in the document calls `api.register(...)` synchronously;
 * - a wallet that loads later dispatches `wallet-standard:register-wallet`
 *   carrying a callback, and the page calls it with the same API.
 *
 * Both are implemented. Listening for only the second is the common mistake and
 * finds nothing at all when the extension won the race, which is the usual case.
 *
 * ## No dependency
 *
 * The handshake is two `CustomEvent`s and a shape; it needs no package, which
 * is the answer CLAUDE.md's ladder asks for before adding one. It also keeps
 * this page clear of the wallet library `no-money-path.test.ts` refuses by name
 * — that scan is what makes "this page cannot move funds" a property of the
 * repository rather than a claim in a comment.
 */

/** An account as the standard hands it over. `address` is base58 for Solana. */
export type StandardAccount = {
  address: string;
  publicKey?: Uint8Array;
  chains?: readonly string[];
  features?: readonly string[];
};

/** The parts of a registered wallet this page reads. */
export type StandardWallet = {
  name: string;
  icon?: string;
  version?: string;
  chains: readonly string[];
  features: Record<string, unknown>;
  accounts: readonly StandardAccount[];
};

/** The two features a wallet must expose to be usable here, and nothing more. */
export const CONNECT_FEATURE = "standard:connect";
export const SIGN_MESSAGE_FEATURE = "solana:signMessage";

type ConnectFeature = { connect: () => Promise<{ accounts: readonly StandardAccount[] }> };
type SignMessageFeature = {
  signMessage: (input: {
    account: StandardAccount;
    message: Uint8Array;
  }) => Promise<readonly { signature: Uint8Array }[]>;
};

type RegisterApi = { register: (...wallets: StandardWallet[]) => () => void };

/**
 * Every wallet currently registered, in registration order, deduplicated by name.
 *
 * Deduplicated because a wallet that registers twice — on its own re-injection,
 * or because the page ran discovery twice — must not appear twice in a chooser.
 * Name is the standard's own identity for a wallet and is what the chooser shows.
 */
export function discoverWallets(target: Window = window): StandardWallet[] {
  const found = new Map<string, StandardWallet>();
  const api: RegisterApi = {
    register: (...wallets) => {
      for (const wallet of wallets) if (!found.has(wallet.name)) found.set(wallet.name, wallet);
      // The standard hands back an unregister callback. Nothing here holds a
      // registration open, so it is a no-op rather than a stored handle.
      return () => {};
    },
  };

  const onRegister = (event: Event) => {
    const detail = (event as CustomEvent<(api: RegisterApi) => void>).detail;
    if (typeof detail === "function") detail(api);
  };

  target.addEventListener("wallet-standard:register-wallet", onRegister);
  target.dispatchEvent(new CustomEvent("wallet-standard:app-ready", { detail: api }));
  target.removeEventListener("wallet-standard:register-wallet", onRegister);

  return [...found.values()];
}

/**
 * The registered wallets that can actually do this page's job.
 *
 * Three conditions, and each one is a wallet that would otherwise fail at a
 * different, later, more confusing moment:
 *
 * - a Solana chain, so an EVM-only wallet does not appear in a Solana chooser;
 * - `standard:connect`, so there is an account to sign with;
 * - `solana:signMessage`, which is the one operation this page performs.
 *
 * `solana:` rather than `solana:mainnet` exactly: a wallet configured for devnet
 * still signs a message, and the chain this product cares about is stated inside
 * the signed payload (`wallet-proof.ts`) rather than taken from whatever network
 * the wallet happens to be on.
 */
export function solanaWallets(wallets: readonly StandardWallet[]): StandardWallet[] {
  return wallets.filter(
    (wallet) =>
      wallet.chains.some((chain) => chain.startsWith("solana:")) &&
      CONNECT_FEATURE in wallet.features &&
      SIGN_MESSAGE_FEATURE in wallet.features,
  );
}

/** Connects and returns the first account's address. */
export async function connect(wallet: StandardWallet): Promise<string> {
  const feature = wallet.features[CONNECT_FEATURE] as ConnectFeature | undefined;
  if (!feature) throw new Error("wallet_cannot_connect");
  const { accounts } = await feature.connect();
  const account = accounts[0];
  if (!account?.address) throw new Error("wallet_no_account");
  return account.address;
}

/**
 * Signs `message` with the account whose address is `address`.
 *
 * The account is looked up rather than assumed to be `accounts[0]`: a wallet
 * with several accounts may reorder them between the connect and the signature,
 * and signing with a different account than the one whose nonce was issued
 * produces a proof the server correctly rejects — after the reader has already
 * approved a dialog, which is the worst place to discover it.
 */
export async function signMessage(
  wallet: StandardWallet,
  address: string,
  message: Uint8Array,
): Promise<Uint8Array> {
  const feature = wallet.features[SIGN_MESSAGE_FEATURE] as SignMessageFeature | undefined;
  if (!feature) throw new Error("wallet_cannot_sign");
  const account = wallet.accounts.find((candidate) => candidate.address === address);
  if (!account) throw new Error("wallet_account_gone");
  const [result] = await feature.signMessage({ account, message });
  if (!result?.signature) throw new Error("wallet_no_signature");
  return result.signature;
}
