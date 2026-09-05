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
/**
 * **`docs/multichain.md` is the canonical list and this is its copy in code.**
 * `hygiene-allowlist.test.ts` compares the two in both directions, so neither
 * half can drift. It is not read from the file at run time: this module is
 * imported by `src/app/api/admin/kol/route.ts`, Next bundles by following
 * imports rather than file paths, and a `readFileSync` of a doc would work in
 * development and fail in production.
 */
const ALLOWED_CONTRACTS = [
  "0x8366a39cc670b4001a1121b8f6a443a643e40951", // Uniswap V4 PoolManager, Robinhood Chain 4663
  "0x8876789976dEcBfCbBbe364623C63652db8C0904", // UniversalRouter (Robinhood fork), chain 4663
  // Third-party swap aggregator on the same chain, documented in
  // `docs/multichain.md`: 761+ distinct users in seven days, and the reason
  // behavioural analysis has to control for it — everything routed through it
  // shares a signature. Probed 2026-09-04 before being listed here: 752 bytes
  // of bytecode and nonce 2, so it is a deployed contract and not somebody's
  // wallet, which is the only distinction this list is about.
  "0x65050a9b7e5075a2ba5ced7b1b64ee66262c40dc",
];

/**
 * Event topic hashes: 64 hex, **not addresses**, and a separate list on purpose.
 *
 * `docs/multichain.md` records why the distinction is not pedantry. A grep for
 * `0x[a-fA-F0-9]{40}` over another repo matched the **first 40 characters of
 * these 64-character values** and reported them as three unallowlisted
 * addresses, which is how `docs/round-robinhood.md` §2 came to say something
 * false. `EVM_IDENTIFIER` never had that defect — it demands exact lengths — so
 * it sees a topic as a 64 and not as a 40 followed by rubbish.
 *
 * They are allowlisted so the Robinhood parser can name the events it decodes.
 * A public topic and a person's wallet are not the same class of thing even
 * when they share a shape, which is the whole reason this is a second list and
 * not three more rows in the one above.
 *
 * Verified by RPC 2026-09-04: zero bytecode, zero balance, nonce zero. Not
 * accounts.
 */
const ALLOWED_TOPICS = [
  "0xec36bf571f136799e8dc0b0b8bea4b04d8bd3d43de838aab0d5fc21d4cbfc455", // CURVE_BUY
  "0x8113d738abdcb6b38357e9d53a54a7157861a09031b453651f0fe7fe151f59df", // CURVE_SELL
  "0x8d4aad4953d0ca700d468f3753aa14432d1b35b43ec6409f051fb6aa43a89607", // TOKEN_LAUNCHED
  // PancakeSwap on BNB 56, added 2026-09-05. Verified against mainnet the same
  // day: 162 V2 logs and 19 V3 logs in a ten-block window, across 109 and 14
  // pools. `bnb-swap.ts` decodes both, and the guard flagged them the moment
  // they entered the tree — which is the guard working, not a nuisance.
  "0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822", // V2 Swap
  "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67", // V3 Swap
];

/** Both lists, for the test that compares them against the document. */
export const ALLOWLISTED_IDENTIFIERS = {
  contracts: ALLOWED_CONTRACTS,
  topics: ALLOWED_TOPICS,
} as const;

const ALLOWED_CONTRACT_RE = new RegExp(
  [...ALLOWED_CONTRACTS, ...ALLOWED_TOPICS]
    .map((a) => a.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|"),
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
