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
 * The roster is shaped to make the states worth looking at, not just the happy
 * one: ten ranked rows spanning gains and losses, one KOL with no closed
 * episode in any window so DESIGN.md's `sin cierres` renders, one token the
 * price feed has never resolved so `state-unpriced` renders, four KOLs that
 * publish their wallets (Solscan links) against eight that do not (`Wallets
 * ocultas`), and forty-eight feed rows against a list eight rows tall, so it
 * scrolls.
 *
 * ## It cannot reach production
 *
 * A seed that can reach production is a worse bug than an empty preview, so the
 * target is `PREVIEW_DATABASE_URL` and nothing else — there is no fallback to
 * `DATABASE_URL` anywhere in this file. Three guards, all of which must pass
 * before a single row is written:
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
 * ## Idempotent
 *
 * The whole seed is one transaction, so the roster is either entirely present
 * or entirely absent — never half-written. That is what makes the check at the
 * top sound: if any `preview-` KOL exists, the roster is already there and this
 * run does nothing. Running it twice leaves the same rows, not double.
 *
 * It only ever inserts, and only rows it owns under the `preview-` slug prefix.
 * Nothing here updates or deletes anything, so even a run that somehow got past
 * every guard above could not destroy a row it did not write.
 *
 * The `pnl_daily` figures are written directly rather than replayed through
 * `pnl.ts`: this is fixture data for a visual gate, and the arithmetic that
 * produces those numbers for real has its own suite. A `recompute-dirty` run
 * against the same branch would overwrite them from the trades, which is
 * correct and is not this script's problem.
 */
import { Client } from "pg";
import { assertDistinctFromProduction, connectionIdentity } from "../src/lib/connection-identity";
import { aadFor, blindIndex, encrypt } from "../src/lib/crypto";
// Type-only, and erased at compile time: importing `db.ts` for real would
// construct its module-level pool against DATABASE_URL, which is the one
// connection string this script must never hold.
import type { TxQuery } from "../src/lib/db";
import { loadEnvLocal } from "../src/lib/env";
import { inventAddress, inventSignature } from "../src/lib/ids";
import { utcDayString } from "../src/lib/windows";

/** Every slug this script writes starts with it. Nothing else is ever touched. */
const SLUG_PREFIX = "preview-";

type Figures = {
  /** `daysAgo` counted in UTC calendar days, spec §4.9. */
  daysAgo: number;
  /** Strings, always: a float here would defeat the point of `numeric`. */
  sol: string;
  usd: string;
  wins: number;
  losses: number;
};

type PreviewKol = {
  name: string;
  handle: string;
  cabal: string | null;
  /** Spec §7. Four of the twelve publish, so both row shapes are on the page. */
  hideWallets: boolean;
  /** Empty means no closed episode in any window: DESIGN.md's `sin cierres`. */
  daily: Figures[];
};

/**
 * `LUNA`, `ORB` and `VEL` are invented three/four-letter tags matching the
 * `cabal.tag` check constraint. They name nothing that exists.
 */
const ROSTER: PreviewKol[] = [
  {
    name: "Brújula Rota",
    handle: "ejemplo_brujularota",
    cabal: "ORB",
    hideWallets: false,
    daily: [
      { daysAgo: 0, sol: "18.42", usd: "1802.40", wins: 7, losses: 2 },
      { daysAgo: 4, sol: "5.10", usd: "498.20", wins: 3, losses: 1 },
      { daysAgo: 19, sol: "-2.30", usd: "-224.60", wins: 1, losses: 4 },
    ],
  },
  {
    name: "Tortuga Veloz",
    handle: "ejemplo_tortugaveloz",
    cabal: null,
    hideWallets: true,
    daily: [
      { daysAgo: 0, sol: "11.07", usd: "1083.10", wins: 5, losses: 3 },
      { daysAgo: 19, sol: "14.80", usd: "1448.90", wins: 6, losses: 2 },
    ],
  },
  {
    name: "Farol de Niebla",
    handle: "ejemplo_faroldeniebla",
    cabal: "ORB",
    hideWallets: true,
    daily: [
      { daysAgo: 0, sol: "6.31", usd: "617.80", wins: 4, losses: 4 },
      { daysAgo: 4, sol: "2.05", usd: "200.60", wins: 2, losses: 1 },
    ],
  },
  {
    name: "Cometa Menor",
    handle: "ejemplo_cometamenor",
    cabal: "VEL",
    hideWallets: false,
    daily: [{ daysAgo: 0, sol: "3.88", usd: "379.90", wins: 3, losses: 1 }],
  },
  {
    name: "Sierra Alta",
    handle: "ejemplo_sierraalta",
    cabal: null,
    hideWallets: true,
    daily: [
      { daysAgo: 0, sol: "1.24", usd: "121.30", wins: 2, losses: 2 },
      { daysAgo: 19, sol: "-6.40", usd: "-626.10", wins: 1, losses: 7 },
    ],
  },
  {
    name: "Nube Baja",
    handle: "ejemplo_nubebaja",
    cabal: "VEL",
    hideWallets: true,
    daily: [{ daysAgo: 0, sol: "0.46", usd: "45.10", wins: 1, losses: 1 }],
  },
  {
    // The `sin cierres` row: approved, on the padrón, ranked, and with nothing
    // closed behind it. Spec §2 keeps such a KOL in the list; DESIGN.md refuses
    // to print `0 %` over an empty denominator.
    name: "Hilo Fino",
    handle: "ejemplo_hilofino",
    cabal: null,
    hideWallets: true,
    daily: [],
  },
  {
    name: "Ancla Suelta",
    handle: "ejemplo_anclasuelta",
    cabal: null,
    hideWallets: false,
    daily: [{ daysAgo: 0, sol: "-0.92", usd: "-90.10", wins: 1, losses: 3 }],
  },
  {
    name: "Reloj de Arena",
    handle: "ejemplo_relojdearena",
    cabal: "LUNA",
    hideWallets: true,
    daily: [
      { daysAgo: 0, sol: "-7.60", usd: "-744.20", wins: 2, losses: 5 },
      { daysAgo: 4, sol: "9.60", usd: "939.20", wins: 4, losses: 1 },
    ],
  },
  {
    name: "Piedra Lunar",
    handle: "ejemplo_piedralunar",
    cabal: null,
    hideWallets: true,
    daily: [{ daysAgo: 0, sol: "-4.73", usd: "-463.10", wins: 1, losses: 6 }],
  },
  {
    // Zero wins over four closed positions: a real measurement, and the row
    // that shows `0,0 %` is not the same thing as `sin cierres`. Ranked inside
    // the top ten on purpose, so the home page carries both cells at once.
    name: "Vela Corta",
    handle: "ejemplo_velacorta",
    cabal: "LUNA",
    hideWallets: false,
    daily: [{ daysAgo: 0, sol: "-2.15", usd: "-210.40", wins: 0, losses: 4 }],
  },
  {
    name: "Eco Lejano",
    handle: "ejemplo_ecolejano",
    cabal: null,
    hideWallets: true,
    daily: [
      { daysAgo: 0, sol: "-12.35", usd: "-1209.30", wins: 1, losses: 9 },
      { daysAgo: 19, sol: "3.15", usd: "308.20", wins: 2, losses: 2 },
    ],
  },
];

/**
 * Six invented tokens. The last has no symbol and no price at all: its trades
 * carry a null `price_usd`, which is what puts DESIGN.md's `state-unpriced`
 * (`sin precio`) and the feed row's `un token sin símbolo` on the page.
 */
const SYMBOLS: (string | null)[] = ["NUBE", "FARO", "ANCLA", "COMETA", "PIEDRA", null];

/** Four trades per KOL, one a minute, so the feed holds forty-eight rows. */
const TRADES_PER_KOL = 4;

/** Cycled so consecutive rows do not repeat a figure. Strings, never floats. */
const SOL_AMOUNTS = ["0.42", "1.18", "2.75", "4.06", "7.31", "12.90", "0.09", "23.44"];
const TOKEN_AMOUNTS = ["1250.5", "88000", "3.75", "190240", "640", "12.25", "9310", "77.5"];
const USD_PRICES = ["0.00042", "0.0118", "1.42", "0.09", "31.7", "0.0006", "2.08", "0.31"];

type Counts = { kols: number; wallets: number; tokens: number; trades: number; days: number };

/**
 * Opens the preview branch, or refuses. See the guards documented at the top of
 * this file; every one of them runs before the caller gets a client back.
 */
async function openPreview(): Promise<Client> {
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

  return client;
}

/**
 * Every row, against a caller-owned transaction.
 *
 * Split from {@link seedPreview} so the two halves can be proved separately:
 * the guards above, which must refuse, and the rows below, which must render
 * the states this seed exists to show. `seed-preview.test.ts` drives this
 * function against the tests branch through `withTransaction`, which is the
 * only way to exercise the insert path — the tests branch carries
 * `test_database_marker`, so {@link seedPreview} itself refuses it, deliberately.
 *
 * Returns `seeded: false` and writes nothing if the roster is already there.
 */
export async function writeRoster(tx: TxQuery): Promise<{ seeded: boolean; counts: Counts }> {
  const counts: Counts = { kols: 0, wallets: 0, tokens: 0, trades: 0, days: 0 };

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

  const mints = SYMBOLS.map(() => inventAddress());
  await tx(
    `INSERT INTO token (mint, symbol, name, decimals, price_usd, price_state)
     SELECT e.mint, e.symbol, e.name, 6, e.price::numeric, e.state
       FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[])
            AS e(mint, symbol, name, price, state)`,
    [
      mints,
      SYMBOLS,
      SYMBOLS.map((symbol) => (symbol === null ? null : `Token ${symbol}`)),
      SYMBOLS.map((symbol, index) => (symbol === null ? null : USD_PRICES[index])),
      SYMBOLS.map((symbol) => (symbol === null ? "unpriced" : "priced")),
    ],
  );
  counts.tokens = mints.length;

  // One instant for the whole run, so the feed's ages and the leaderboard's UTC
  // days are computed against the same clock instead of drifting apart across
  // the roster.
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

  const days = kols.flatMap((kol) =>
    kol.spec.daily.map((figures) => ({
      kolId: kol.id,
      day: utcDayString(new Date(startedAt - figures.daysAgo * 86_400_000)),
      ...figures,
    })),
  );
  await tx(
    `INSERT INTO pnl_daily (kol_id, day, realized_sol, realized_usd, wins, losses)
     SELECT e.kol_id::uuid, e.day::date, e.sol::numeric, e.usd::numeric, e.wins::int, e.losses::int
       FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::int[], $6::int[])
            AS e(kol_id, day, sol, usd, wins, losses)`,
    [
      days.map((row) => row.kolId),
      days.map((row) => row.day),
      days.map((row) => row.sol),
      days.map((row) => row.usd),
      days.map((row) => row.wins),
      days.map((row) => row.losses),
    ],
  );
  counts.days = days.length;

  const trades = kols.flatMap((kol, kolIndex) =>
    Array.from({ length: TRADES_PER_KOL }, (_, n) => {
      const index = kolIndex * TRADES_PER_KOL + n;
      const mintIndex = (kolIndex + n) % mints.length;
      return {
        id: crypto.randomUUID(),
        signature: inventSignature(),
        kolId: kol.id,
        walletId: kol.walletId,
        mint: mints[mintIndex],
        side: (kolIndex + n) % 2 === 0 ? "buy" : "sell",
        tokens: TOKEN_AMOUNTS[index % TOKEN_AMOUNTS.length],
        sol: SOL_AMOUNTS[index % SOL_AMOUNTS.length],
        // The symbol-less mint is the one the price feed never resolved, so its
        // trades carry no price at all and the row says `sin precio`.
        priceUsd: SYMBOLS[mintIndex] === null ? null : USD_PRICES[index % USD_PRICES.length],
        at: new Date(startedAt - index * 60_000).toISOString(),
      };
    }),
  );
  await tx(
    `INSERT INTO trade (id, signature_hmac, signature_enc, instruction_index, kol_id, wallet_id,
                        mint, side, token_amount, sol_amount, price_usd, fee_sol, block_time)
     SELECT e.id::uuid, decode(e.hmac, 'hex'), decode(e.enc, 'hex'), 0, e.kol_id::uuid,
            e.wallet_id::uuid, e.mint, e.side, e.tokens::numeric, e.sol::numeric,
            e.price::numeric, 0, e.at::timestamptz
       FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[],
                   $7::text[], $8::text[], $9::text[], $10::text[], $11::text[])
            AS e(id, hmac, enc, kol_id, wallet_id, mint, side, tokens, sol, price, at)`,
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
      trades.map((trade) => trade.priceUsd),
      trades.map((trade) => trade.at),
    ],
  );
  counts.trades = trades.length;

  return { seeded: true, counts };
}

/**
 * The script itself: open the preview branch or refuse, then write the roster
 * in one transaction so it is either entirely present or entirely absent.
 */
export async function seedPreview(): Promise<{ seeded: boolean; counts: Counts }> {
  const client = await openPreview();
  const tx: TxQuery = async <T>(sql: string, params: unknown[] = []) =>
    (await client.query(sql, params)).rows as T[];

  try {
    await client.query("BEGIN");
    try {
      const result = await writeRoster(tx);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
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
      `Seeded ${counts.kols} KOLs, ${counts.wallets} wallets, ${counts.tokens} tokens, ` +
        `${counts.trades} trades and ${counts.days} pnl_daily rows.`,
    );
  }
  process.exit(0);
}
