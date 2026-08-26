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

/**
 * USDT mint. Named here for one purpose only: to **decline** a swap quoted in
 * it with an honest reason, rather than misreporting it as token↔token.
 *
 * It is deliberately not treated the way `USDC_MINT` is. `sol_usd` is measured
 * from the solana SOL/**USDC** pair specifically (`fetchSolUsdcPair` filters to
 * that quote before ranking by liquidity), so a USDC amount is a USD amount by
 * construction and needs no assumption about a peg. A USDT amount is not: it
 * would need either a USDT/USD price this project never fetches, or the
 * assumption that USDT is worth exactly one dollar — a guessed number of
 * exactly the kind `parse-swap.ts`'s header forbids, and one that is wrong
 * precisely when it matters most.
 *
 * So this constant buys distinguishability, not valuation. See
 * `UNPRICED_STABLE_MINTS` in `parse-swap.ts`.
 */
export const USDT_MINT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
