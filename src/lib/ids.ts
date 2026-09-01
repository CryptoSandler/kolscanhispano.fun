import { randomBytes } from "node:crypto";
import bs58 from "bs58";

/**
 * A base58 string shaped like a Solana address, generated fresh. Tests and dev
 * seeds use this instead of hardcoding an address: no real address may enter
 * this repository (SECURITY.md), and a literal in a fixture is exactly that.
 */
export function inventAddress(): string {
  return bs58.encode(randomBytes(32));
}

/** A base58 string shaped like a transaction signature, generated fresh. */
export function inventSignature(): string {
  return bs58.encode(randomBytes(64));
}

/**
 * A `0x`-prefixed 40-hex string shaped like an EVM address, generated fresh.
 *
 * The EVM siblings of the two above, for the same reason: `SECURITY.md`'s ban
 * on real identifiers is about people, not about which chain they trade on.
 * Returned lowercase, which is what {@link canonicalAddress} produces, so a
 * fixture and a stored row compare equal without either side canonicalising.
 * A test that specifically exercises EIP-55 casing upper-cases this itself.
 */
export function inventEvmAddress(): string {
  return `0x${randomBytes(20).toString("hex")}`;
}

/** A `0x`-prefixed 64-hex string shaped like an EVM transaction hash. */
export function inventEvmTxHash(): string {
  return `0x${randomBytes(32).toString("hex")}`;
}
