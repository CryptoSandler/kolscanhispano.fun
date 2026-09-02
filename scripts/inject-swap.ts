/**
 * Delivers one SWAP to the local webhook and drives it all the way to the
 * feed. Development only.
 *
 * Helius cannot reach `localhost`, so this posts the payload itself: the same
 * endpoint, the same shape, the same shared secret, no API key and no credit
 * spent. Then it runs the two steps that a deployed system runs on a
 * schedule — `parsePending()`, which turns `raw_tx` into `trade` rows and
 * marks the touched positions dirty, and `recomputeDirty()`, whose cron is a
 * later batch. Until that cron exists this script is the only thing that
 * services those dirty marks.
 *
 * A `.ts` file, not `.mts`: an earlier task's `.mts` import broke `next build`
 * for two tasks running.
 *
 *   npm run dev
 *   npx tsx scripts/inject-swap.ts
 */
import { query } from "../src/lib/db";
import { buildSwapPayload } from "../src/lib/fixtures/swap";
import { inventAddress } from "../src/lib/ids";
import { parsePending } from "../src/lib/parse-swap";
import { recomputeDirty } from "../src/lib/pnl";
import { seedDev } from "./seed-dev";

const BASE_URL = process.env.INJECT_BASE_URL ?? "http://localhost:3102";

/** 1,23 SOL for 16,9M tokens, with a 5,000-lamport fee. */
const SOL_SPENT_LAMPORTS = 1_230_000_000n;
const FEE_LAMPORTS = 5_000n;
const TOKEN_DECIMALS = 6;
const TOKEN_UNITS = 16_900_000n;

/**
 * A token row so the feed row can say `$EJE` instead of "un token sin
 * símbolo". The parser writes `trade.mint` but never a `token` row — metadata
 * comes from DexScreener, which is a later task — so in development that row
 * has to come from somewhere.
 *
 * Reuses the mint from a previous run if there is one, so repeated injections
 * accumulate trades on one token instead of one token per trade.
 */
async function developmentToken(): Promise<string> {
  const [existing] = await query<{ mint: string }>(
    "SELECT mint FROM token WHERE symbol = 'EJE' LIMIT 1",
  );
  if (existing) return existing.mint;

  const mint = inventAddress();
  await query(
    `INSERT INTO token (mint, symbol, name, decimals, price_state)
     VALUES ($1, 'EJE', 'Ejemplo', $2, 'unpriced')`,
    [mint, TOKEN_DECIMALS],
  );
  return mint;
}

async function main(): Promise<void> {
  const secret = process.env.HELIUS_WEBHOOK_SECRET;
  // Never interpolate the value, here or anywhere: this line reaches a
  // terminal and a CI log.
  if (!secret) throw new Error("HELIUS_WEBHOOK_SECRET is not set. See .env.example.");

  const { walletId, address } = await seedDev();
  const mint = await developmentToken();

  // `insertTrade` prices a trade from the newest `sol_price` row at or before
  // its block time. Seeding one for this minute is what makes the injected
  // trade show a USD price rather than `sin precio`.
  await query(
    `INSERT INTO sol_price (minute, usd) VALUES (date_trunc('minute', now()), 150)
     ON CONFLICT (minute) DO NOTHING`,
  );

  // A buy: SOL out, tokens in. `nativeBalanceChange` carries the fee for the
  // fee payer (spec §4.4), which the parser adds back, so the net SOL side is
  // exactly SOL_SPENT_LAMPORTS.
  const payload = buildSwapPayload({
    wallet: address,
    mint,
    decimals: TOKEN_DECIMALS,
    nativeChangeLamports: -Number(SOL_SPENT_LAMPORTS + FEE_LAMPORTS),
    tokenChangeRaw: (TOKEN_UNITS * 10n ** BigInt(TOKEN_DECIMALS)).toString(),
    feeLamports: Number(FEE_LAMPORTS),
    isFeePayer: true,
    slot: Math.floor(Date.now() / 1000),
    timestamp: Math.floor(Date.now() / 1000),
  });

  const response = await fetch(`${BASE_URL}/api/webhooks/helius`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: secret },
    body: JSON.stringify([payload]),
  });
  if (!response.ok) {
    throw new Error(`webhook rejected the delivery: ${response.status}`);
  }

  const examined = await parsePending();
  const replayed = await recomputeDirty();

  const [counted] = await query<{ count: string }>(
    "SELECT count(*) FROM trade WHERE wallet_id = $1",
    [walletId],
  );

  // Neither the address nor the signature is printed: both identify the
  // signer to anyone with an explorer, and a terminal scrollback is not where
  // they belong.
  console.log(
    `delivered 1 swap; parsePending examined ${examined} raw row(s); ` +
      `recomputeDirty replayed ${replayed} position(s); ` +
      `${counted.count} trade(s) now on the seeded wallet`,
  );
}

await main();
process.exit(0);
