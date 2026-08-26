/**
 * Guards the constraint in SECURITY.md: no real Solana address or transaction
 * signature may enter this repository. Git history cannot be un-published, so
 * this runs as a test rather than as a lint anyone can skip.
 */
const BASE58 = "[1-9A-HJ-NP-Za-km-z]";
// No upper bound: matching only the address/signature-length window let a real
// address slip through undetected whenever it abutted more base58 text with no
// delimiter (the combined run fell outside 32-44 and 87-88 and was dropped).
// Any run of 32+ is now reported whole; false positives on long incidental
// base58 runs are the accepted cost, absorbed by HYGIENE_SKIP and the allowlist.
const CANDIDATE = new RegExp(`${BASE58}{32,}`, "g");

/** Public, non-personal constants. Anything added here must be justified in review. */
export const ALLOWED_BASE58 = new Set([
  "So11111111111111111111111111111111111111112", // wrapped SOL mint
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC mint
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDT mint (named only to decline swaps quoted in it)
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", // SPL Token program
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL", // Associated Token program
  "11111111111111111111111111111111", // System program
]);

/**
 * Files exempt from the repository scan:
 * - this module, because the allowlist above is written out in full;
 * - lockfiles, whose integrity hashes produce base58-shaped false positives.
 */
export const HYGIENE_SKIP = ["src/lib/hygiene.ts", "package-lock.json"];

/** Distinct maximal base58 runs of 32+ characters that are not allowlisted. */
export function findDisallowedBase58(text: string): string[] {
  const found = new Set<string>();
  for (const [match] of text.matchAll(CANDIDATE)) {
    if (ALLOWED_BASE58.has(match)) continue;
    found.add(match);
  }
  return [...found];
}
