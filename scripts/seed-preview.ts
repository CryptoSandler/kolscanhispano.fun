/**
 * A populated preview, so the owner's visual gate happens on a leaderboard with
 * rows in it rather than on empty panels.
 *
 * Everything here is invented. The KOLs are twelve fictional names with
 * `ejemplo_` handles that could not be mistaken for a real person, none of them
 * resembling any handle recorded in `docs/references.md`; the addresses, the
 * mints and the signatures all come from `inventAddress` / `inventSignature`,
 * so nothing the no-doxx scan would flag is ever written into a file
 * (SECURITY.md §8.3).
 *
 * ## The fixture obeys the same laws as real data
 *
 * **Only `trade` rows are invented.** `position`, `pnl_position_daily` and
 * `pnl_daily` are derived from them by the real engine — `recomputeDirty()` in
 * `src/lib/pnl.ts`, the same function the cron calls — exactly as spec §3 says:
 * *"`trade` is the only source of truth. `position`, `pnl_daily` and the
 * leaderboard are derived"*.
 *
 * The previous version of this file wrote `pnl_daily` by hand and said so. That
 * is a leaderboard which does not reconcile with the trades sitting beside it in
 * the same database: the first `recompute-dirty` run against the preview branch
 * would have rewritten every figure the visual gate had just approved, and read
 * as "the product is broken" when the broken thing was the fixture. On the last
 * preview seed the hand-written figures were the *only* thing the leaderboard
 * displayed, so the gate reviewed numbers that no trade in the same database
 * produced.
 *
 * The property that makes the replacement right, and the one
 * {@link assertReconciled} pins before this script exits: **running
 * `recomputeDirty()` again changes nothing.** The seed leaves the database in
 * the state the real pipeline would have left it in, so the cron is a no-op
 * rather than a correction.
 *
 * So the roster is written as **episodes** — a buy, then the sell that closes
 * it — and every figure the gate looks at is a consequence of that arithmetic
 * rather than an assertion beside it. The states are still all there, now
 * earned: ten ranked rows spanning gains and losses, one KOL whose only trades
 * are buys so nothing has closed and DESIGN.md's `sin cierres` renders, one
 * token the price feed never resolved so `un token sin símbolo` renders, a gap
 * in `sol_price` over the newest minutes so `state-unpriced` (`sin precio`)
 * renders, four KOLs that publish their wallets against eight that do not
 * (`Wallets ocultas`), and forty-eight feed rows against a list eight rows
 * tall, so it scrolls. See the `ROSTER` comments for which episode produces
 * which state.
 *
 * ## It cannot reach production
 *
 * A seed that can reach production is a worse bug than an empty preview, and
 * `recomputeDirty()` *writes* — to `position`, `pnl_daily` and
 * `pnl_position_daily` — so the guards matter more now than they did when this
 * script only inserted rows it owned. The target is `PREVIEW_DATABASE_URL` and
 * nothing else; there is no fallback to `DATABASE_URL` anywhere in this file.
 * Three guards, all of which must pass before a single row is written:
 *
 * 1. `PREVIEW_DATABASE_URL` unset is a hard stop. It is never defaulted.
 * 2. `DATABASE_URL` unset is *also* a hard stop, which looks backwards until you
 *    read `env.ts`: `assertDistinctFromProduction` skips its comparison
 *    entirely when `DATABASE_URL` is absent, so an environment without one
 *    would disable guard 3 silently. `env.ts` already records the measured case
 *    — a one-off script run with `DATABASE_URL` unset connected to the
 *    production branch and matched no rows, "which was luck of the statement,
 *    not of the method".
 * 3. `assertDistinctFromProduction`, the same comparison `db.ts` and
 *    `migrate.mts` use, so a bypass fixed in one is fixed for all three.
 *
 * And one that does not depend on parsing a connection string at all, which is
 * the shape `migrate.mts` established with `test_database_marker`: if the target
 * carries that marker it is the tests branch, which `npm test` truncates, and
 * seeding it would corrupt another run's fixtures. Refuse.
 *
 * **The replay never widens that target.** `recomputeDirty` reaches its database
 * through `db.ts`'s module-level pool, which is built from `DATABASE_URL` at
 * import — the one connection string this script must never hold. So the replay
 * runs in a **child process** with `DATABASE_URL` set to the already-guarded
 * preview string, and this process's own environment is left untouched. See
 * {@link replaySeeded}.
 *
 * ## Idempotent
 *
 * The rows are written in one transaction, so the roster is either entirely
 * present or entirely absent — never half-written. That is what makes the check
 * at the top sound: if any `preview-` KOL exists, the roster is already there
 * and this run does nothing. Running it twice leaves the same rows, not double.
 *
 * It only ever inserts, and only rows it owns: the `preview-` slug prefix, the
 * freshly invented mints, and the derived rows the replay computes from its own
 * trades. Nothing here updates or deletes a row it did not write.
 */
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client } from "pg";
import { assertDistinctFromProduction, connectionIdentity } from "../src/lib/connection-identity";
import { aadFor, blindIndex, encrypt } from "../src/lib/crypto";
import { ONE, formatDecimal, mulDiv, parseDecimal } from "../src/lib/decimal";
// Type-only, and erased at compile time: importing `db.ts` for real would
// construct its module-level pool against DATABASE_URL, which is the one
// connection string this script must never hold.
import type { TxQuery } from "../src/lib/db";
import { loadEnvLocal } from "../src/lib/env";
import { inventAddress, inventSignature } from "../src/lib/ids";

/** Every slug this script writes starts with it. Nothing else is ever touched. */
const SLUG_PREFIX = "preview-";

/**
 * One round trip on one `(kol, mint)`: the buy that opens it and the sell that
 * closes it. Spec §4.8 counts a win or a loss **per closed position**, so this
 * is the unit the leaderboard's `wins`/`losses` are actually made of, and the
 * unit the roster below is written in.
 *
 * Two episodes on the same mint chain into one position and close twice — spec
 * §4.8's *"a position that reopens after closing can close again, and counts
 * again"*. `ejemplo_velacorta` is written that way on purpose.
 *
 * Strings, always: a float here would defeat the point of `numeric` (spec §3).
 */
type Episode = {
  /** The UTC calendar day both legs land on, counted back from the run instant (spec §4.9). */
  daysAgo: number;
  /** Index into {@link TOKENS}. */
  mint: number;
  /** Bought and sold whole, so the exit assigns the entire remaining basis. */
  tokens: string;
  /** SOL paid on the swap leg. `pnl.ts` adds `fee_sol` on top of it (spec §4.4). */
  buy: string;
  /** SOL received on the swap leg, or `null` for a position still held open. */
  sell: string | null;
  /**
   * No `sol_price` row covers this block, so `usd_amount`, `sol_usd` and
   * `price_usd` are all NULL — never `0`, which the leaderboard would sum. This
   * is the state migration 005 names *"looked, no rate existed"*, and it is what
   * puts DESIGN.md's `state-unpriced` (`sin precio`) on a feed row.
   */
  unpriced?: boolean;
};

type PreviewKol = {
  name: string;
  handle: string;
  cabal: string | null;
  /** Spec §7. Four of the twelve publish, so both row shapes are on the page. */
  hideWallets: boolean;
  episodes: Episode[];
};

/**
 * Six invented tokens. The last has no symbol and no price the feed ever
 * resolved: `price_state = 'unpriced'` and `symbol NULL` are what put spec
 * §4.6's *sin precio* chip and the feed row's `un token sin símbolo` on the
 * page.
 *
 * `price_usd` here is DexScreener's *current* answer for the mint, which is a
 * different question from `trade.price_usd` — spec §4.1 fixes a trade's USD
 * value at its block and never re-prices it. A mint that had liquidity when it
 * was traded and lost it since is therefore `unpriced` on this row while its
 * trades still carry the price they were worth at the time, and that is a state
 * the real pipeline produces routinely.
 */
const TOKENS: { symbol: string | null; priceUsd: string | null }[] = [
  { symbol: "NUBE", priceUsd: "0.00042" },
  { symbol: "FARO", priceUsd: "0.0118" },
  { symbol: "ANCLA", priceUsd: "1.42" },
  { symbol: "COMETA", priceUsd: "0.09" },
  { symbol: "PIEDRA", priceUsd: "31.7" },
  { symbol: null, priceUsd: null },
];

/**
 * The SOL/USD rate every priced trade is valued at, and the transaction fee
 * every trade pays. One rate across the roster keeps the USD column a faithful
 * second rendering of the SOL column rather than a second, independent story.
 *
 * `231.71` is deliberately not a round number: `prices.ts` records that
 * `0.1 * 231.71` is `23.171000000000003` in doubles, so any figure derived from
 * it through a float would be visibly wrong rather than accidentally right.
 * (`0.1 * 231.7`, an earlier draft's example, is exactly `23.17` in doubles.)
 */
const SOL_USD = "231.71";

/** 5,000 lamports, the ordinary Solana transaction fee. Spec §4.4 charges it separately. */
const FEE_SOL = "0.000005";

/** Any plausible mainnet slot; only the *ordering* it gives the replay matters (spec §4.10). */
const BASE_SLOT = 300_000_000;

/**
 * `LUNA`, `ORB` and `VEL` are invented three/four-letter tags matching the
 * `cabal.tag` check constraint. They name nothing that exists.
 *
 * The order below is the order trades are emitted in, and therefore — after the
 * chronological sort in {@link writeRoster} — roughly the order they appear in
 * the feed. It is not the leaderboard order: that is now earned by the
 * arithmetic, not declared here.
 */
const ROSTER: PreviewKol[] = [
  {
    name: "Brújula Rota",
    handle: "ejemplo_brujularota",
    cabal: "ORB",
    hideWallets: false,
    // The day's best round trip, and the figure `seed-preview.test.ts` pins
    // exactly: 20.5 - 8.15 - 2 x 0.000005 = 12.34999.
    episodes: [
      { daysAgo: 0, mint: 0, tokens: "18250.5", buy: "8.15", sell: "20.5" },
      { daysAgo: 4, mint: 1, tokens: "640", buy: "2.4", sell: "1.9" },
    ],
  },
  {
    name: "Tortuga Veloz",
    handle: "ejemplo_tortugaveloz",
    cabal: null,
    hideWallets: true,
    episodes: [
      { daysAgo: 0, mint: 1, tokens: "9310", buy: "3.3", sell: "9.1" },
      { daysAgo: 0, mint: 2, tokens: "77.5", buy: "4.4", sell: "6.0" },
      { daysAgo: 19, mint: 3, tokens: "1250.5", buy: "3.15", sell: "7.85" },
    ],
  },
  {
    // A win and a loss on the same day: the row that reads 50,0 %.
    name: "Farol de Niebla",
    handle: "ejemplo_faroldeniebla",
    cabal: "ORB",
    hideWallets: true,
    episodes: [
      { daysAgo: 0, mint: 2, tokens: "12.25", buy: "6.25", sell: "10.4" },
      { daysAgo: 0, mint: 3, tokens: "88000", buy: "1.9", sell: "1.55" },
    ],
  },
  {
    name: "Cometa Menor",
    handle: "ejemplo_cometamenor",
    cabal: "VEL",
    hideWallets: false,
    episodes: [{ daysAgo: 0, mint: 3, tokens: "190240", buy: "2.05", sell: "4.3" }],
  },
  {
    name: "Sierra Alta",
    handle: "ejemplo_sierraalta",
    cabal: null,
    hideWallets: true,
    episodes: [
      { daysAgo: 0, mint: 4, tokens: "3.75", buy: "0.75", sell: "2.18" },
      { daysAgo: 19, mint: 0, tokens: "45120", buy: "6.7", sell: "1.95" },
    ],
  },
  {
    name: "Nube Baja",
    handle: "ejemplo_nubebaja",
    cabal: "VEL",
    hideWallets: true,
    episodes: [{ daysAgo: 0, mint: 0, tokens: "2410.25", buy: "1.35", sell: "1.82" }],
  },
  {
    // The `sin cierres` row: approved, on the padrón, ranked, and holding two
    // open bags it has never sold. Nothing has closed, so `pnl.ts` writes no
    // `pnl_position_daily` contribution for it at all and the leaderboard's
    // LEFT JOIN ranks it at zero with an empty denominator. Spec §2 keeps such
    // a KOL in the list; DESIGN.md refuses to print `0 %` over it.
    //
    // Exactly one KOL may be in this state: `LeaderboardTable`'s empty state is
    // keyed on every entry having `winRate === null`, so a second one is fine
    // for the panel but would stop this row being the *only* `sin cierres` cell
    // the gate has to find.
    name: "Hilo Fino",
    handle: "ejemplo_hilofino",
    cabal: null,
    hideWallets: true,
    episodes: [
      { daysAgo: 0, mint: 5, tokens: "31500", buy: "2.6", sell: null },
      { daysAgo: 0, mint: 4, tokens: "1.85", buy: "1.15", sell: null },
    ],
  },
  {
    name: "Ancla Suelta",
    handle: "ejemplo_anclasuelta",
    cabal: null,
    hideWallets: false,
    episodes: [
      { daysAgo: 0, mint: 5, tokens: "77400", buy: "3.6", sell: "2.68" },
      { daysAgo: 0, mint: 1, tokens: "530.75", buy: "1.2", sell: "1.35" },
    ],
  },
  {
    name: "Reloj de Arena",
    handle: "ejemplo_relojdearena",
    cabal: "LUNA",
    hideWallets: true,
    episodes: [
      { daysAgo: 0, mint: 4, tokens: "9.6", buy: "5.4", sell: "2.35" },
      { daysAgo: 0, mint: 0, tokens: "6120.5", buy: "1.1", sell: "1.42" },
      { daysAgo: 4, mint: 2, tokens: "24.75", buy: "1.65", sell: "3.4" },
    ],
  },
  {
    name: "Piedra Lunar",
    handle: "ejemplo_piedralunar",
    cabal: null,
    hideWallets: true,
    episodes: [{ daysAgo: 0, mint: 2, tokens: "18.4", buy: "9.35", sell: "4.6" }],
  },
  {
    // Three round trips on one mint, all of them losing. The position closes,
    // reopens on the next buy and closes again — spec §4.8 — so this is a real
    // measurement of zero wins over three closed positions, which is `0,0 %`
    // and is not the same cell as `sin cierres`. It ranks ninth on the day, so
    // the home page carries both cells at once.
    name: "Vela Corta",
    handle: "ejemplo_velacorta",
    cabal: "LUNA",
    hideWallets: false,
    episodes: [
      { daysAgo: 0, mint: 3, tokens: "4820", buy: "2.3", sell: "1.45" },
      { daysAgo: 0, mint: 3, tokens: "4820", buy: "1.75", sell: "1.2" },
      { daysAgo: 0, mint: 3, tokens: "4820", buy: "0.9", sell: "0.62" },
    ],
  },
  {
    // Emitted last, so its `unpriced` episode is the newest thing in the feed.
    // A gap in `sol_price` is always at the *newest* end — `backfill-prices`
    // fills a minute after the fact — so putting it anywhere else would be a
    // state the real pipeline does not reach. It is on a mint that *does* have
    // a symbol, on purpose: `sin precio` is a property of the block, not of the
    // token, and a fixture where the two always coincide would let a consumer
    // conflate them.
    name: "Eco Lejano",
    handle: "ejemplo_ecolejano",
    cabal: null,
    hideWallets: true,
    episodes: [
      { daysAgo: 0, mint: 5, tokens: "610.5", buy: "0.85", sell: "0.7" },
      { daysAgo: 0, mint: 1, tokens: "142300", buy: "14.2", sell: "5.75", unpriced: true },
      { daysAgo: 19, mint: 4, tokens: "2.05", buy: "1.05", sell: "4.28" },
    ],
  },
];

type Counts = { kols: number; wallets: number; tokens: number; trades: number; positions: number };

/** A UTC day in milliseconds. Constant, unlike a local one — see `windows.ts`. */
const DAY_MS = 86_400_000;

/** Midnight UTC of the day `daysAgo` before `instant`. Never reads local time. */
function utcDayStart(instant: number, daysAgo: number): number {
  const at = new Date(instant);
  return Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()) - daysAgo * DAY_MS;
}

/**
 * Opens the preview branch, or refuses. See the guards documented at the top of
 * this file; every one of them runs before the caller gets a client back. The
 * validated connection string comes back with it, because {@link replaySeeded}
 * needs the same string and must not re-derive it.
 */
async function openPreview(): Promise<{ client: Client; connectionString: string }> {
  loadEnvLocal();

  const connectionString = process.env.PREVIEW_DATABASE_URL?.trim();
  if (!connectionString) {
    // Never interpolate the value into the message: this string reaches logs.
    throw new Error(
      "PREVIEW_DATABASE_URL is not set. See .env.example. This script never falls back to " +
        "DATABASE_URL: seeding production is the failure it exists to prevent.",
    );
  }
  if (!process.env.DATABASE_URL?.trim()) {
    throw new Error(
      "DATABASE_URL is not set, so the production comparison below cannot run and would pass " +
        "vacuously. Set it to the branch you are protecting, then re-run. Never unset it to " +
        "'disable' a guard -- see the note in src/lib/env.ts.",
    );
  }

  // Parsed here first so a malformed URL is reported against the variable it
  // actually came from: assertDistinctFromProduction labels every parse failure
  // TEST_DATABASE_URL, which was its only caller until this one.
  connectionIdentity(connectionString, "PREVIEW_DATABASE_URL");
  assertDistinctFromProduction(
    connectionString,
    "Refusing to seed: PREVIEW_DATABASE_URL and DATABASE_URL name the same database. Point " +
      "PREVIEW_DATABASE_URL at the Neon preview branch before running this.",
  );

  // Log only the ep-... host fragment, the way migrate.mts does: enough to
  // confirm the target branch without printing a connection string.
  const host = connectionString.match(/ep-[a-z0-9-]+/);
  console.log(`Seeding preview data into ${host ? host[0] : "(unknown host)"}`);

  const client = new Client({ connectionString });
  await client.connect();

  // The one check that does not depend on parsing anything: a database can only
  // carry this marker if it was migrated with `npm run db:migrate:test`, which
  // makes it the branch `npm test` truncates. Seeding it would corrupt a run.
  try {
    const marker = await client.query<{ present: string | null }>(
      "SELECT to_regclass('public.test_database_marker')::text AS present",
    );
    if (marker.rows[0]?.present !== null) {
      throw new Error(
        "Refusing to seed: this database carries test_database_marker, so it is the tests " +
          "branch, which `npm test` truncates. PREVIEW_DATABASE_URL is pointing somewhere it " +
          "should not.",
      );
    }
  } catch (error) {
    await client.end();
    throw error;
  }

  return { client, connectionString };
}

/**
 * Every row this script actually invents, against a caller-owned transaction:
 * the roster, its wallets, its tokens, its **trades**, and the dirty `position`
 * marks that tell `pnl.ts` to replay them. Nothing derived is written here.
 *
 * The trade insert and the dirty mark are the same pair `parse-swap.ts`'s
 * `insertTrade` writes, in the same order and in one transaction, and for the
 * same reason it gives: *"the trade is the source of truth and the dirty mark
 * is the only thing that will ever cause it to be read"*. A seed that wrote the
 * trades without the marks would leave a database whose leaderboard is empty
 * and whose trade log is not, which is a state the parser cannot produce.
 *
 * Split from {@link seedPreview} so the two halves can be proved separately:
 * the guards above, which must refuse, and the rows below, which must derive
 * the states this seed exists to show. `seed-preview.test.ts` drives this
 * function against the tests branch through `withTransaction` and then calls
 * the real `recomputeDirty()`, which is the only way to exercise the insert
 * path — the tests branch carries `test_database_marker`, so {@link seedPreview}
 * itself refuses it, deliberately.
 *
 * Returns `seeded: false` and writes nothing if the roster is already there.
 */
export async function writeRoster(tx: TxQuery): Promise<{ seeded: boolean; counts: Counts }> {
  const counts: Counts = { kols: 0, wallets: 0, tokens: 0, trades: 0, positions: 0 };

  const existing = await tx<{ one: number }>(
    "SELECT 1 AS one FROM kol WHERE slug LIKE $1 LIMIT 1",
    [`${SLUG_PREFIX}%`],
  );
  if (existing.length > 0) return { seeded: false, counts };

  // Cabals first: the KOL rows reference them. A preview branch is a copy of
  // production, so a tag may already be there -- take whichever row wins. This
  // script never edits or deletes one.
  const tags = [...new Set(ROSTER.map((kol) => kol.cabal).filter((tag) => tag !== null))];
  await tx(
    `INSERT INTO cabal (id, tag, name)
     SELECT gen_random_uuid(), t, t FROM unnest($1::text[]) AS t
     ON CONFLICT (tag) DO NOTHING`,
    [tags],
  );
  const cabalIds = new Map(
    (await tx<{ tag: string; id: string }>("SELECT tag, id FROM cabal WHERE tag = ANY($1::text[])", [
      tags,
    ])).map((row) => [row.tag, row.id]),
  );

  const mints = TOKENS.map(() => inventAddress());
  await tx(
    `INSERT INTO token (mint, symbol, name, decimals, price_usd, price_state)
     SELECT e.mint, e.symbol, e.name, 6, e.price::numeric, e.state
       FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[])
            AS e(mint, symbol, name, price, state)`,
    [
      mints,
      TOKENS.map((token) => token.symbol),
      TOKENS.map((token) => (token.symbol === null ? null : `Token ${token.symbol}`)),
      TOKENS.map((token) => token.priceUsd),
      TOKENS.map((token) => (token.symbol === null ? "unpriced" : "priced")),
    ],
  );
  counts.tokens = mints.length;

  // One instant for the whole run, so every trade's UTC day is computed against
  // the same clock instead of drifting across the roster -- and, at a run that
  // straddles UTC midnight, so `daysAgo: 0` cannot mean two different days for
  // two different KOLs.
  const startedAt = Date.now();

  // Every row is built in memory and written in one statement per table.
  // Row-at-a-time inserts cost a Neon round trip each, which put this seed --
  // and the test that drives it -- at eighteen seconds a run.
  const kols = ROSTER.map((spec) => ({
    spec,
    id: crypto.randomUUID(),
    slug: `${SLUG_PREFIX}${spec.handle.replace(/^ejemplo_/, "")}`,
    walletId: crypto.randomUUID(),
    address: inventAddress(),
  }));

  await tx(
    `INSERT INTO kol (id, slug, display_name, x_handle, cabal_id, hide_wallets, status, approved_at)
     SELECT e.id::uuid, e.slug, e.name, e.handle, e.cabal_id::uuid, e.hide, 'approved', now()
       FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::bool[])
            AS e(id, slug, name, handle, cabal_id, hide)`,
    [
      kols.map((kol) => kol.id),
      kols.map((kol) => kol.slug),
      kols.map((kol) => kol.spec.name),
      kols.map((kol) => kol.spec.handle),
      kols.map((kol) => (kol.spec.cabal === null ? null : cabalIds.get(kol.spec.cabal))),
      kols.map((kol) => kol.spec.hideWallets),
    ],
  );
  counts.kols = kols.length;

  await tx(
    `INSERT INTO kol_wallet (id, kol_id, address_enc, address_hmac, backfill_status)
     SELECT e.id::uuid, e.kol_id::uuid, decode(e.enc, 'hex'), decode(e.hmac, 'hex'), 'done'
       FROM unnest($1::text[], $2::text[], $3::text[], $4::text[])
            AS e(id, kol_id, enc, hmac)`,
    [
      kols.map((kol) => kol.walletId),
      kols.map((kol) => kol.id),
      kols.map((kol) =>
        encrypt(kol.address, aadFor("kol_wallet", "address", kol.walletId)).toString("hex"),
      ),
      kols.map((kol) => blindIndex(kol.address, "address").toString("hex")),
    ],
  );
  counts.wallets = kols.length;

  const trades = planTrades(kols, mints, startedAt);
  await writeTrades(tx, trades);
  counts.trades = trades.length;

  // The other half of `insertTrade`'s pair, and the only reason any of the
  // trades above will ever be read: `recomputeDirty` selects on this flag.
  // `ON CONFLICT DO UPDATE SET dirty = TRUE` mirrors `insertTrade` exactly; the
  // mints are freshly invented, so in practice nothing collides.
  const positions = [...new Map(trades.map((trade) => [`${trade.kolId} ${trade.mint}`, trade])).values()];
  await tx(
    `INSERT INTO position (kol_id, mint, dirty)
     SELECT e.kol_id::uuid, e.mint, TRUE
       FROM unnest($1::text[], $2::text[]) AS e(kol_id, mint)
     ON CONFLICT (kol_id, mint) DO UPDATE SET dirty = TRUE`,
    [positions.map((row) => row.kolId), positions.map((row) => row.mint)],
  );
  counts.positions = positions.length;

  return { seeded: true, counts };
}

type SeededKol = { spec: PreviewKol; id: string; walletId: string };

type PlannedTrade = {
  id: string;
  signature: string;
  kolId: string;
  walletId: string;
  mint: string;
  side: "buy" | "sell";
  tokens: string;
  sol: string;
  unpriced: boolean;
  blockTime: Date;
  slot: number;
};

/**
 * Expands the roster's episodes into trade rows and places them in time.
 *
 * **Ordering is the whole job.** `pnl.ts` replays a position in
 * `block_time, slot, instruction_index, id` order (spec §4.10), so a sell
 * placed before its own buy would replay as a sale against no basis — spec
 * §4.5's manufactured-profit case — and the position would come out
 * `basis = unknown` and be withheld from the leaderboard entirely. Every
 * episode's buy therefore precedes its sell, and `slot` increases with
 * `block_time` so the tiebreak agrees with the timestamps.
 *
 * **A day-zero trade lands on today's UTC day, whatever time it is now.** The
 * trades of each day are spread evenly across the part of that day that has
 * already happened, so nothing is stamped in the future and nothing spills into
 * yesterday. Placing them at a fixed offset backwards from the run instant
 * instead would put "today's" trades on yesterday for a run just after UTC
 * midnight, and `Diario` — the window the visual gate looks at first — would be
 * empty (spec §4.9: the current UTC day, never rolling).
 */
function planTrades(kols: SeededKol[], mints: string[], startedAt: number): PlannedTrade[] {
  const legs = kols.flatMap((kol) =>
    kol.spec.episodes.flatMap((episode) => {
      const shared = {
        kolId: kol.id,
        walletId: kol.walletId,
        mint: mints[episode.mint],
        tokens: episode.tokens,
        daysAgo: episode.daysAgo,
        unpriced: episode.unpriced ?? false,
      };
      const buy = { ...shared, side: "buy" as const, sol: episode.buy };
      return episode.sell === null
        ? [buy]
        : [buy, { ...shared, side: "sell" as const, sol: episode.sell }];
    }),
  );

  // Oldest day first; within a day, emission order — except that the rate gap
  // sorts to the end, because a missing `sol_price` minute is always the newest
  // one (see `Episode.unpriced`). Both legs of an episode carry the same flag,
  // so this never separates a buy from its sell.
  const chronological = legs
    .map((leg, seq) => ({ leg, seq }))
    .sort(
      (a, b) =>
        b.leg.daysAgo - a.leg.daysAgo ||
        Number(a.leg.unpriced) - Number(b.leg.unpriced) ||
        a.seq - b.seq,
    )
    .map((entry) => entry.leg);

  const perDay = new Map<number, number>();
  for (const leg of chronological) perDay.set(leg.daysAgo, (perDay.get(leg.daysAgo) ?? 0) + 1);

  const placed = new Map<number, number>();
  return chronological.map((leg, index) => {
    const total = perDay.get(leg.daysAgo) ?? 1;
    const nth = placed.get(leg.daysAgo) ?? 0;
    placed.set(leg.daysAgo, nth + 1);

    const dayStart = utcDayStart(startedAt, leg.daysAgo);
    // A full day for a past day; only the elapsed part of today for day zero.
    // The floor keeps every timestamp distinct even for a run at 00:00:00.000,
    // where the elapsed part is zero milliseconds wide.
    const span = Math.max(leg.daysAgo === 0 ? startedAt - dayStart : DAY_MS, total + 1);

    return {
      id: crypto.randomUUID(),
      signature: inventSignature(),
      kolId: leg.kolId,
      walletId: leg.walletId,
      mint: leg.mint,
      side: leg.side,
      tokens: leg.tokens,
      sol: leg.sol,
      unpriced: leg.unpriced,
      blockTime: new Date(dayStart + Math.floor((span * (nth + 1)) / (total + 1))),
      slot: BASE_SLOT + index,
    };
  });
}

/**
 * The same columns `insertTrade` writes, in the same units.
 *
 * `price_sol`, `usd_amount`, `sol_usd` and `price_usd` are derived here rather
 * than declared, on the exact 18-decimal grid `decimal.ts` defines, so no money
 * in this fixture passes through a double. The two lines that produce them are
 * a transcription of `prices.ts`'s `valueTrade` rather than a call to it:
 * `prices.ts` imports `db.ts`, and importing that here would build a pool
 * against `DATABASE_URL`. `decimal.ts` — which is where the arithmetic actually
 * lives, and which imports nothing — is shared.
 *
 * `priced_at` is stamped on every row, priced or not, exactly as `insertTrade`
 * does: migration 005 uses it to tell *"looked, no rate existed"* apart from
 * *"never looked"*, and an unstamped row would put this fixture in a state no
 * code path produces any more.
 */
async function writeTrades(tx: TxQuery, trades: PlannedTrade[]): Promise<void> {
  const solUsd = parseDecimal(SOL_USD);

  const valued = trades.map((trade) => {
    const tokenAmount = parseDecimal(trade.tokens);
    const solAmount = parseDecimal(trade.sol);
    const priceSol = tokenAmount === 0n ? null : mulDiv(solAmount, ONE, tokenAmount);
    return {
      priceSol: priceSol === null ? null : formatDecimal(priceSol),
      // All three NULL together, never `0`: a zero is a number the leaderboard
      // sums and the feed renders, and is indistinguishable from a trade that
      // really was worth nothing (see `insertTrade`).
      usdAmount: trade.unpriced ? null : formatDecimal(mulDiv(solAmount, solUsd, ONE)),
      solUsd: trade.unpriced ? null : SOL_USD,
      priceUsd:
        trade.unpriced || priceSol === null ? null : formatDecimal(mulDiv(priceSol, solUsd, ONE)),
    };
  });

  await tx(
    `INSERT INTO trade (id, signature_hmac, signature_enc, instruction_index, kol_id, wallet_id,
                        mint, side, token_amount, sol_amount, usd_amount, sol_usd, price_sol,
                        price_usd, fee_sol, block_time, slot, priced_at)
     SELECT e.id::uuid, decode(e.hmac, 'hex'), decode(e.enc, 'hex'), 0, e.kol_id::uuid,
            e.wallet_id::uuid, e.mint, e.side, e.tokens::numeric, e.sol::numeric,
            e.usd::numeric, e.sol_usd::numeric, e.price_sol::numeric, e.price_usd::numeric,
            $16::numeric, e.at::timestamptz, e.slot::bigint, now()
       FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[],
                   $7::text[], $8::text[], $9::text[], $10::text[], $11::text[], $12::text[],
                   $13::text[], $14::text[], $15::text[])
            AS e(id, hmac, enc, kol_id, wallet_id, mint, side, tokens, sol, usd, sol_usd,
                 price_sol, price_usd, at, slot)`,
    [
      trades.map((trade) => trade.id),
      trades.map((trade) => blindIndex(trade.signature, "signature").toString("hex")),
      trades.map((trade) =>
        encrypt(trade.signature, aadFor("trade", "signature", trade.id)).toString("hex"),
      ),
      trades.map((trade) => trade.kolId),
      trades.map((trade) => trade.walletId),
      trades.map((trade) => trade.mint),
      trades.map((trade) => trade.side),
      trades.map((trade) => trade.tokens),
      trades.map((trade) => trade.sol),
      valued.map((row) => row.usdAmount),
      valued.map((row) => row.solUsd),
      valued.map((row) => row.priceSol),
      valued.map((row) => row.priceUsd),
      trades.map((trade) => trade.blockTime.toISOString()),
      trades.map((trade) => String(trade.slot)),
      FEE_SOL,
    ],
  );
}

/**
 * The property the whole rewrite exists for: **the derived tables agree with
 * the trades that produced them, so running `recomputeDirty()` again changes
 * nothing.** Asserted rather than assumed — that is the verdict.
 *
 * Three ways it can be false, and all three are checked rather than inferred
 * from the replay's exit code, because the replay can also decline to run at
 * all: `recompute-dirty.ts` takes an advisory lock and returns *successfully*
 * having done nothing when another run holds it, and `recomputeDirty`'s default
 * limit is 100 positions per pass.
 *
 * 1. A seeded position is still dirty — the replay never reached it.
 * 2. A seeded trade has no `position` row — the dirty mark was never written,
 *    so nothing will ever replay it (`insertTrade`'s failure mode, in fixture
 *    form).
 * 3. A `pnl_daily` row disagrees with the `pnl_position_daily` rows under it,
 *    in either direction. Spec §3: *"Derived: the sum of pnl_position_daily
 *    over the KOL's mints for that day"*. This is the check the hand-written
 *    `pnl_daily` of the previous seed would have failed.
 *
 * Exported so `seed-preview.test.ts` can prove it both ways: that it passes on
 * a replayed roster, and that it fails on one that has not been replayed yet.
 */
export async function assertReconciled(tx: TxQuery): Promise<void> {
  const [row] = await tx<{
    kols: string;
    dirty: string;
    unmarked: string;
    unreconciled: string;
    orphan_days: string;
  }>(
    `WITH seeded AS (SELECT id FROM kol WHERE slug LIKE $1)
     SELECT
       (SELECT count(*) FROM seeded) AS kols,
       (SELECT count(*) FROM position p JOIN seeded s ON s.id = p.kol_id
         WHERE p.dirty) AS dirty,
       (SELECT count(*) FROM trade t JOIN seeded s ON s.id = t.kol_id
          LEFT JOIN position p ON p.kol_id = t.kol_id AND p.mint = t.mint
         WHERE p.kol_id IS NULL) AS unmarked,
       (SELECT count(*) FROM (
          SELECT 1 FROM pnl_daily d JOIN seeded s ON s.id = d.kol_id
            LEFT JOIN pnl_position_daily c ON c.kol_id = d.kol_id AND c.day = d.day
           GROUP BY d.kol_id, d.day, d.realized_sol, d.realized_usd, d.wins, d.losses
          HAVING COALESCE(SUM(c.realized_sol), 0) <> d.realized_sol
              OR COALESCE(SUM(c.realized_usd), 0) <> d.realized_usd
              OR COALESCE(SUM(c.wins), 0) <> d.wins
              OR COALESCE(SUM(c.losses), 0) <> d.losses) mismatched) AS unreconciled,
       (SELECT count(*) FROM pnl_position_daily c JOIN seeded s ON s.id = c.kol_id
          LEFT JOIN pnl_daily d ON d.kol_id = c.kol_id AND d.day = c.day
         WHERE d.kol_id IS NULL) AS orphan_days`,
    [`${SLUG_PREFIX}%`],
  );

  // Nothing seeded means every count below is trivially zero, and a check that
  // passes because it had nothing to look at is not a check.
  if (Number(row.kols) === 0) {
    throw new Error(`No "${SLUG_PREFIX}" KOL exists, so there is nothing to reconcile.`);
  }

  const failures = [
    [Number(row.dirty), "position(s) still dirty: the replay did not reach them"],
    [Number(row.unmarked), "trade(s) with no position row: nothing will ever replay them"],
    [Number(row.unreconciled), "pnl_daily row(s) that do not equal the sum of their positions"],
    [Number(row.orphan_days), "pnl_position_daily row(s) with no pnl_daily row above them"],
  ] as const;

  const broken = failures.filter(([count]) => count > 0);
  if (broken.length > 0) {
    throw new Error(
      "The preview roster does not reconcile with its own trades, so a recompute-dirty run " +
        "would rewrite what the visual gate is about to approve: " +
        broken.map(([count, what]) => `${count} ${what}`).join("; ") +
        ". Re-run scripts/recompute-dirty.ts against the preview branch.",
    );
  }
}

/** Repo root, so `npx` resolves `tsx` from this project's node_modules. */
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

/** Twenty-three positions over a Neon round trip each, with headroom. */
const REPLAY_TIMEOUT_MS = 120_000;

/**
 * Derives `position`, `pnl_position_daily` and `pnl_daily` from the trades just
 * written, by running the **real** engine — `scripts/recompute-dirty.ts`, which
 * is what the cron runs, advisory lock and all.
 *
 * **In a child process, because of where `recomputeDirty` gets its database.**
 * It reaches it through `db.ts`'s module-level pool, built from `DATABASE_URL`
 * at import time; this script must never hold that string, and must never
 * mutate this process's copy of it either — guard 2 above depends on it still
 * naming the branch being protected. A child gets `DATABASE_URL` set to the
 * preview string the guards already cleared, and this process's environment is
 * untouched.
 *
 * `NODE_ENV` and `VITEST` are overwritten for the child on purpose: `db.ts`
 * resolves `TEST_DATABASE_URL` instead of `DATABASE_URL` when either says this
 * is a test run, so inheriting one from a caller would silently point the
 * replay at the tests branch — the branch `npm test` truncates, which is
 * exactly what guard 4 refuses to seed.
 *
 * The child's exit code is not the proof that this worked; {@link assertReconciled}
 * is. `recompute-dirty.ts` exits 0 having done nothing when another run holds
 * its lock.
 *
 * ponytail: one pass. `recomputeDirty`'s default limit is 100 positions and the
 * roster needs 23, so a preview branch carrying more than ~77 stale dirty
 * positions of its own would need a second run — which `assertReconciled` will
 * tell you about by name rather than leaving you to find it on the page.
 */
async function replaySeeded(connectionString: string): Promise<void> {
  // A copy, never `process.env` itself: nothing here may mutate this process's
  // own environment. `resolveConnectionString` is the only reader of either
  // flag -- `NODE_ENV === "test" || VITEST === "true"` -- so overwriting them
  // with anything else is what "not the tests branch" means here.
  const env = {
    ...process.env,
    DATABASE_URL: connectionString,
    NODE_ENV: "production" as const,
    VITEST: "",
  };

  // Safe to print: recompute-dirty.ts is written to never emit a connection
  // string, a key or a payload value on any path, and its own test pins that.
  const { stdout } = await promisify(execFile)("npx", ["tsx", "scripts/recompute-dirty.ts"], {
    cwd: REPO_ROOT,
    env,
    timeout: REPLAY_TIMEOUT_MS,
  });
  process.stdout.write(stdout);
}

/**
 * The script itself: open the preview branch or refuse, write the trades in one
 * transaction so they are either entirely present or entirely absent, let the
 * real engine derive everything else from them, and refuse to claim success
 * until the two agree.
 */
export async function seedPreview(): Promise<{ seeded: boolean; counts: Counts }> {
  const { client, connectionString } = await openPreview();
  const tx: TxQuery = async <T>(sql: string, params: unknown[] = []) =>
    (await client.query(sql, params)).rows as T[];

  try {
    await client.query("BEGIN");
    let result: { seeded: boolean; counts: Counts };
    try {
      result = await writeRoster(tx);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }

    // Outside the transaction, and only once it has committed: the child
    // process reads the trades over its own connection and cannot see them
    // otherwise.
    if (result.seeded) {
      await replaySeeded(connectionString);
      await assertReconciled(tx);
    }
    return result;
  } finally {
    await client.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { seeded, counts } = await seedPreview();
  if (!seeded) {
    console.log(`Preview roster already present (slug prefix "${SLUG_PREFIX}"); nothing written.`);
  } else {
    // The addresses, mints and signatures are deliberately not printed: they
    // belong in the database, not in a terminal scrollback or a CI log.
    console.log(
      `Seeded ${counts.kols} KOLs, ${counts.wallets} wallets, ${counts.tokens} tokens and ` +
        `${counts.trades} trades over ${counts.positions} positions; pnl_daily and ` +
        `pnl_position_daily were derived from them by recompute-dirty.`,
    );
  }
  process.exit(0);
}
