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
