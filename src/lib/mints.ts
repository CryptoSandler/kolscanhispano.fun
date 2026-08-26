/**
 * The two well-known mint addresses this project names in code.
 *
 * They live here rather than in `parse-swap.ts`, where they were first
 * written, so that `prices.ts` can read them without importing the parser.
 * That import used to run the other way — `prices.ts` imported the two
 * constants from `parse-swap.ts` — and it became a cycle the moment
 * `parse-swap.ts` needed `solUsdAt` to value a trade. `parse-swap.ts` still
 * re-exports both names, so every existing importer and test is unaffected;
 * this module is the definition, not a second copy.
 *
 * Both are public, well-known addresses, not addresses belonging to anyone
 * this project tracks: `hygiene.ts` allowlists them for exactly that reason,
 * and SECURITY.md's "no real Solana addresses in the repository" rule is
 * about wallets and signatures, which these are not.
 */

/**
 * Wrapped SOL mint. Spec §4.3: "A trade is a swap where the wallet's SOL/WSOL
 * balance moves against a SPL token balance" — WSOL is treated as part of the
 * SOL side, never as the traded token.
 */
export const WSOL_MINT = "So11111111111111111111111111111111111111112";

/**
 * USDC mint. Spec §4.3: "SOL ↔ stablecoin rotation is not a trade and is not
 * indexed" — a wallet swapping SOL directly for USDC (or back) is excluded
 * entirely, not recorded even as `unsupported_quote`.
 */
export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
