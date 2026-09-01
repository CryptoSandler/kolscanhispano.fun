/**
 * The set of chains this project can hold rows for, and the one operation that
 * has to happen to an address *before* it is hashed.
 *
 * Nothing here activates a chain. `docs/multichain.md` §6 keeps every EVM chain
 * behind an env flag until its ingestion carries real data; this module is the
 * vocabulary that the schema keys and the signed payloads are written in, which
 * is why it lands in the seam batch rather than with the adapter.
 */

/**
 * Chain names as they are stored. `TEXT` with a `CHECK`, matching how every
 * other enumeration in this schema is declared (`trade.side`, `kol.status`,
 * `token.price_state`) rather than a numeric id: the id is an EVM concept, and
 * `solana` does not have one, so a numeric column would need a sentinel for the
 * chain that matters most today.
 */
export const CHAINS = ["solana", "robinhood", "bnb", "ethereum"] as const;

export type Chain = (typeof CHAINS)[number];

export type EvmChain = Exclude<Chain, "solana">;

/**
 * EIP-155 chain ids, from `docs/multichain.md` §4 and §6.
 *
 * Two consumers, and both need the number rather than the name: the provider
 * configuration, and the `chainId` field of a SIWE message — which is signed,
 * so it is what binds a signature to one chain instead of every chain the
 * wallet could replay it on.
 */
export const EVM_CHAIN_IDS: Record<EvmChain, number> = {
  robinhood: 4663,
  bnb: 56,
  ethereum: 1,
};

export function isEvm(chain: Chain): chain is EvmChain {
  return chain !== "solana";
}

export function isChain(value: string): value is Chain {
  return (CHAINS as readonly string[]).includes(value);
}

/** `0x` and exactly 40 hex digits. EIP-55 casing is a checksum, not an identity. */
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** Base58 as Solana writes it: no `0`, no `O`, no `I`, no `l`. */
const BASE58_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/**
 * The form of an address that is hashed, stored and compared.
 *
 * **Why this exists at all.** `blindIndex` is case-sensitive — it is
 * `HMAC(\`${domain}:${value}\`)` over an arbitrary string — and
 * `kol_wallet.address_hmac` is `UNIQUE` with `findWalletByAddress` as the only
 * lookup path. On EVM the *same* address is written both as EIP-55
 * `0xAbC…` and as lowercase `0xabc…`, and the two hash to different digests.
 * A wallet registered in one casing and delivered by the indexer in the other
 * is not merely hard to find: it is **invisible forever**, because a lookup
 * that misses reports the wallet as untracked and untracked means silently
 * skipped. There is no error anywhere and no row to notice.
 *
 * **Why here and not inside `blindIndex`.** `blindIndex`'s contract is
 * "arbitrary string, three domains", and it hashes IPs and signatures too.
 * Teaching it to recognise address formats would make every caller's behaviour
 * depend on what the function guessed the string was — an IP that happened to
 * look like hex would start being rewritten. The canonical form is a property
 * of the address, so it is applied by the code that knows it holds one.
 *
 * **Why Solana is returned untouched, deliberately.** Base58 is
 * case-*significant*: `A` and `a` are different digits, so two distinct
 * Solana addresses can differ only in case. Lowercasing one would map two real
 * wallets onto one digest — which, against a `UNIQUE` index, means the second
 * wallet cannot be registered at all. The asymmetry is the point, and it is
 * why this takes the chain as an argument instead of sniffing the shape.
 *
 * Malformed input throws rather than being hashed: this sits at a trust
 * boundary (a wallet arrives from a browser at registration, and from a
 * provider at ingestion), and a digest of a typo is a row that can never be
 * matched again. The message names the chain and never the address —
 * `SECURITY.md`'s rule that no address reaches a log or an error string.
 */
export function canonicalAddress(address: string, chain: Chain): string {
  const trimmed = address.trim();
  const pattern = isEvm(chain) ? EVM_ADDRESS : BASE58_ADDRESS;
  if (!pattern.test(trimmed)) throw new Error(`not a valid address for chain ${chain}`);
  return isEvm(chain) ? trimmed.toLowerCase() : trimmed;
}
