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

/**
 * A GitHub Actions pin: `uses: owner/repo@<40 lowercase hex> # tag`.
 *
 * These are removed before the scan rather than allowlisted, because the
 * allowlist holds *values* and a pin changes every time an action is re-pinned.
 * A 40-character commit SHA is not an address, but its leading run up to the
 * first `0` is base58-shaped — `49933ea5288caeca8642d1e84afbd3f7d6820020`
 * yields a 36-character run, which is exactly what tripped this scan when the
 * workflows were pinned.
 *
 * Deliberately narrow: only a full `uses:@<40 hex>` on one line, and the caller
 * applies it only to workflow files. Exempting *all* lowercase-hex runs
 * everywhere would have been shorter and would have opened a real hole — a
 * wallet's `address_hmac` is 64 lowercase hex characters, and this scan is one
 * of the things standing between that and a committed file.
 */
/**
 * Public contract addresses that documentation is allowed to name.
 *
 * The same category as `ALLOWED_BASE58`'s mints and programs: a contract is a
 * published, permanent identifier that every explorer lists, not a person's
 * wallet. `docs/multichain.md` names these because a parser has to decode
 * their events, and a document that says "the V4 PoolManager" without saying
 * which one is not documentation.
 *
 * Stripped before the scan rather than compared against it, because an EVM
 * address is hex: base58 excludes `0`, so a 40-hex address is chopped into
 * runs at every zero and what the scanner actually sees is a fragment. The
 * fragment is not a stable thing to allowlist -- the full address is.
 *
 * Deliberately a short, hand-written list. Widening this to "any 0x-prefixed
 * hex" would exempt every EVM wallet address in the repository, which is the
 * opposite of the point.
 */
const ALLOWED_CONTRACTS = [
  "0x8366a39cc670b4001a1121b8f6a443a643e40951", // Uniswap V4 PoolManager, Robinhood Chain 4663
  "0x8876789976dEcBfCbBbe364623C63652db8C0904", // UniversalRouter (Robinhood fork), chain 4663
];

const ALLOWED_CONTRACT_RE = new RegExp(
  ALLOWED_CONTRACTS.map((a) => a.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"),
  "gi",
);

const ACTION_PIN = /(uses:\s*[\w.-]+\/[\w.-]+)@[0-9a-f]{40}\b/g;

/** Distinct maximal base58 runs of 32+ characters that are not allowlisted. */
export function findDisallowedBase58(text: string): string[] {
  const found = new Set<string>();
  // Public contracts leave first, so their hex cannot be read as a base58 run.
  for (const [match] of text.replace(ALLOWED_CONTRACT_RE, "<contract>").matchAll(CANDIDATE)) {
    if (ALLOWED_BASE58.has(match)) continue;
    found.add(match);
  }
  return [...found];
}

/** `findDisallowedBase58`, with GitHub Actions SHA pins removed first. */
export function findDisallowedBase58InWorkflow(text: string): string[] {
  return findDisallowedBase58(text.replace(ACTION_PIN, "$1@PINNED"));
}

/**
 * EVM addresses and transaction hashes, which the base58 scan above is nearly
 * blind to.
 *
 * **Why a second pattern and not a wider first one.** Base58 excludes `0`, so
 * a 40-hex address is chopped into runs at every zero and the scanner sees
 * fragments; only an address whose hex happens to contain no `0` early enough
 * survives as a run long enough to clear the 32-character floor. Measured in
 * `docs/multichain.md` §1: about **7.6%** of them. A guard that catches one in
 * thirteen is worse than none, because it reads as coverage.
 *
 * **Why anchored on `0x` rather than on bare hex.** `[0-9a-f]{40}` is also a
 * git commit SHA, and `ACTION_PIN` above already records what happens when
 * this scan meets one. Requiring the `0x` prefix means that carve-out needs no
 * second exception — and, more importantly, it does not exempt a 64-character
 * lowercase-hex `address_hmac`, which is precisely the value the strict scan
 * exists to keep out of a committed file.
 *
 * ponytail: exact lengths, 40 and 64, with the prefix as the delimiter. An
 * address abutting further hex with no `0x` and no boundary is not matched;
 * if that ever appears in practice, the upgrade is a maximal-hex-run scan with
 * a length window, which costs the SHA carve-out a second exception.
 */
const EVM_IDENTIFIER = /(?<![0-9a-fA-Fx])0x(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})(?![0-9a-fA-F])/g;

/** Distinct EVM addresses and transaction hashes that are not public contracts. */
export function findDisallowedEvm(text: string): string[] {
  // The same strip as above and for the same reason: a documented public
  // contract is a published identifier, not a person's wallet.
  return [...new Set(text.replace(ALLOWED_CONTRACT_RE, "<contract>").match(EVM_IDENTIFIER) ?? [])];
}
