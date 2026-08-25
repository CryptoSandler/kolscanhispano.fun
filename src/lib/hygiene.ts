/**
 * Guards the constraint in SECURITY.md: no real Solana address or transaction
 * signature may enter this repository. Git history cannot be un-published, so
 * this runs as a test rather than as a lint anyone can skip.
 */
const BASE58 = "[1-9A-HJ-NP-Za-km-z]";
const CANDIDATE = new RegExp(`${BASE58}{32,88}`, "g");

/** Public, non-personal constants. Anything added here must be justified in review. */
export const ALLOWED_BASE58 = new Set([
  "So11111111111111111111111111111111111111112", // wrapped SOL mint
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC mint
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

/** Distinct address- or signature-length base58 strings that are not allowlisted. */
export function findDisallowedBase58(text: string): string[] {
  const found = new Set<string>();
  for (const [match] of text.matchAll(CANDIDATE)) {
    const isAddress = match.length >= 32 && match.length <= 44;
    const isSignature = match.length >= 87 && match.length <= 88;
    if (!isAddress && !isSignature) continue;
    if (ALLOWED_BASE58.has(match)) continue;
    found.add(match);
  }
  return [...found];
}
