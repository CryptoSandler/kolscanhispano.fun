# kolscanhispano.fun — implementation plan, batch 1

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** A local site where a seeded KOL, a swap injected through the webhook endpoint, a live feed
and a leaderboard all work end to end — with the encryption, hygiene and privacy invariants in place
from the first commit rather than retrofitted.

**Architecture:** Next.js App Router over Neon Postgres. The webhook endpoint only authenticates,
encrypts and stores; a parser turns stored payloads into normalised trades; a recompute step derives
positions and daily realized PnL; pages read the derived tables. Wallet addresses and transaction
signatures are encrypted at rest and looked up through an HMAC blind index.

**Tech Stack:** Node 26, Next 16.3.2, React 19.2.8, TypeScript 5, `pg` 8, vitest 4, tsx, Tailwind 4,
Neon (`neonctl`). No new runtime dependency beyond `bs58`.

**Spec:** `docs/spec-v1.md`. Security model: `SECURITY.md`. Reference teardown: `docs/references.md`.

## Global constraints

- **Language split.** UI copy in neutral Spanish (not Rioplatense). Code, comments, commit messages,
  file names and docs in English.
- **No-doxx.** No real name anywhere in the repo, in any commit, or in any file. Author is
  `CryptoSandler`.
- **No real Solana addresses in the repository** — not in seeds, fixtures, tests, logs or error
  messages. Enforced by Task 1. Tests generate addresses at run time.
- **Connection strings live only in `.env.local`**, are never echoed, never pasted on a command
  line, never logged, and always carry `sslmode=verify-full`.
- **Money is `numeric`**, never float. Token amounts are stored raw next to their `decimals`.
- **All row ids are application-generated UUIDs** (`crypto.randomUUID()`), because the encryption
  AAD binds a ciphertext to its exact row and needs the id before the insert.
- **Every task ends green**: `npm test` passes and the work is committed.

## File structure

| File | Responsibility |
|---|---|
| `src/lib/hygiene.ts` | Base58 scanner and the allowlist of public constants |
| `src/lib/crypto.ts` | AES-256-GCM encrypt/decrypt with AAD, HMAC blind index, key loading |
| `src/lib/db.ts` | Pool, query helper, `.env.local` loading |
| `src/lib/ids.ts` | UUID generation and base58 helpers |
| `src/lib/wallets.ts` | Wallet storage and lookup by blind index |
| `src/lib/rate-limit.ts` | `ip_hash` fixed-window limiter |
| `src/lib/parse-swap.ts` | Helius enhanced SWAP payload → trade rows |
| `src/lib/pnl.ts` | Weighted-average replay → `position` and `pnl_daily` |
| `src/lib/serialize.ts` | Public serializers; the single place addresses can be omitted |
| `src/app/api/webhooks/helius/route.ts` | Authenticate, encrypt, store, return 200 |
| `src/app/api/feed/route.ts` | Cursor feed with ETag |
| `src/app/api/leaderboard/route.ts` | Windowed realized PnL |
| `src/app/page.tsx` | Home: live feed |
| `src/app/leaderboard/page.tsx` | Leaderboard |
| `migrations/001_core.sql` | Batch-1 schema |
| `scripts/migrate.mts` | Migration runner |
| `scripts/seed-dev.mts` | One KOL, one invented wallet, one SOL price row |

Registration tables (`kol_claim`, `claim_wallet`, `siws_nonce`) arrive with the registration batch,
not here. Batch 1 seeds its KOL directly.

---

### Task 1: Project scaffold and the base58 hygiene test

The hygiene test comes first deliberately: it is the constraint that is impossible to retrofit once
a real address has entered git history.

**Files:**
- Create: `package.json`, `tsconfig.json`, `next.config.ts`, `eslint.config.mjs`,
  `postcss.config.mjs`, `vitest.config.mts`, `.gitignore`, `.env.example`
- Create: `src/lib/hygiene.ts`
- Test: `src/lib/hygiene.test.ts`

**Interfaces:**
- Produces: `findDisallowedBase58(text: string): string[]`, `ALLOWED_BASE58: Set<string>`,
  `HYGIENE_SKIP: string[]`

- [ ] **Step 1: Scaffold the project**

```bash
npm init -y
npm pkg set name=kolscanhispano type=module private=true
npm pkg set scripts.dev="next dev" scripts.build="next build" scripts.start="next start"
npm pkg set scripts.lint="eslint" scripts.test="vitest run" scripts.test:watch="vitest"
npm i next@16.3.2 react@19.2.8 react-dom@19.2.8 pg@^8.23.0 bs58@^6.0.0
npm i -D typescript@^5 @types/node@^26 @types/react@^19 @types/react-dom@^19 @types/pg@^8.23.1 \
  vitest@^4.1.11 tsx@^4.23.12 eslint@^9 eslint-config-next@16.3.2 tailwindcss@^4 @tailwindcss/postcss@^4
printf '.env*.local\nnode_modules\n.next\n' > .gitignore
```

`tsconfig.json`, `next.config.ts`, `eslint.config.mjs` and `postcss.config.mjs` follow the
`outbid-tokens` versions unchanged. `vitest.config.mts`:

```ts
import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Tests share one database and truncate between cases, so they cannot run
    // in parallel against each other.
    fileParallelism: false,
    // Every query is a network round-trip to Neon; the local default is far too tight.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
```

- [ ] **Step 2: Write the failing test**

`src/lib/hygiene.test.ts`. Note that every base58-looking string in this file is *built* rather than
written as a literal — otherwise the test file would fail its own scan.

```ts
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ALLOWED_BASE58, HYGIENE_SKIP, findDisallowedBase58 } from "./hygiene";

const address = "z".repeat(44);   // base58 charset, address length
const signature = "z".repeat(88); // base58 charset, signature length

describe("findDisallowedBase58", () => {
  it("flags an address-length base58 string", () => {
    expect(findDisallowedBase58(`wallet is ${address} ok`)).toEqual([address]);
  });

  it("flags a signature-length base58 string", () => {
    expect(findDisallowedBase58(`tx ${signature}`)).toEqual([signature]);
  });

  it("ignores strings that are too short or too long", () => {
    expect(findDisallowedBase58("z".repeat(31))).toEqual([]);
    expect(findDisallowedBase58("z".repeat(45))).toEqual([]);
  });

  it("ignores strings containing characters outside the base58 alphabet", () => {
    expect(findDisallowedBase58(`0${"z".repeat(43)}0`)).toEqual([]);
  });

  it("allows the public constants on the allowlist", () => {
    for (const allowed of ALLOWED_BASE58) {
      expect(findDisallowedBase58(`mint ${allowed}`)).toEqual([]);
    }
  });

  it("reports each distinct offender once", () => {
    expect(findDisallowedBase58(`${address} and ${address}`)).toEqual([address]);
  });
});

describe("the repository itself", () => {
  it("contains no Solana address or signature outside the allowlist", () => {
    const tracked = execFileSync("git", ["ls-files"], { encoding: "utf8" })
      .split("\n")
      .filter((f) => f && !HYGIENE_SKIP.includes(f));

    const offenders: string[] = [];
    for (const file of tracked) {
      let text: string;
      try {
        text = readFileSync(file, "utf8");
      } catch {
        continue; // unreadable or binary
      }
      for (const hit of findDisallowedBase58(text)) offenders.push(`${file}: ${hit}`);
    }

    expect(offenders).toEqual([]);
  });
});
```

- [ ] **Step 3: Run the test and watch it fail**

Run: `npx vitest run src/lib/hygiene.test.ts`
Expected: FAIL — `hygiene.ts` does not exist.

- [ ] **Step 4: Implement the scanner**

`src/lib/hygiene.ts`:

```ts
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
```

- [ ] **Step 5: Run the tests and watch them pass**

Run: `npm test`
Expected: PASS, 7 tests.

- [ ] **Step 6: Prove the repository scan actually bites**

```bash
printf 'const leaked = "%s";\n' "$(node -e 'process.stdout.write("z".repeat(44))')" > src/lib/scratch-check.ts
npx vitest run src/lib/hygiene.test.ts   # expected: FAIL, offender listed as src/lib/scratch-check.ts
rm src/lib/scratch-check.ts
npx vitest run src/lib/hygiene.test.ts   # expected: PASS
```

A test that has never failed for the right reason is not evidence.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "Scaffold the project and forbid real addresses in the repo

The base58 scan lands before any database code because git history
cannot be rewritten once an address has been published."
```

---

### Task 2: Neon project, branches, and the migration runner

**Files:**
- Create: `scripts/migrate.mts`, `migrations/000_bootstrap.sql`, `src/lib/db.ts`, `.env.example`
- Test: `src/lib/db.test.ts`

**Interfaces:**
- Produces: `query<T>(sql: string, params?: unknown[]): Promise<T[]>`, `pool: Pool`,
  `loadEnvLocal(): void`

- [ ] **Step 1: Create the Neon project and both branches**

Nothing here prints a connection string. `neonctl` writes them straight into `.env.local` through
command substitution, so they never reach the terminal or shell history.

```bash
neonctl projects create --name kolscanhispano --output json > /tmp/neon-project.json
PROJECT_ID=$(python3 -c "import json;print(json.load(open('/tmp/neon-project.json'))['project']['id'])")
rm /tmp/neon-project.json
echo "project: $PROJECT_ID"          # the id is not a secret

# Neon's default branch: rename it to production if it is not already.
neonctl branches list --project-id "$PROJECT_ID"
# If the default branch is named something else:
#   neonctl branches rename <current-name> production --project-id "$PROJECT_ID"

neonctl branches create --project-id "$PROJECT_ID" --name tests
```

- [ ] **Step 2: Write the connection strings into `.env.local`**

```bash
write_url () {  # $1 = env var name, $2 = branch
  local url
  url=$(neonctl connection-string "$2" --project-id "$PROJECT_ID" --pooled)
  url=${url/sslmode=require/sslmode=verify-full}
  case "$url" in *sslmode=*) ;; *) url="$url?sslmode=verify-full" ;; esac
  printf '%s=%s\n' "$1" "$url" >> .env.local
}
write_url DATABASE_URL production
write_url TEST_DATABASE_URL tests
grep -c '^DATABASE_URL=\|^TEST_DATABASE_URL=' .env.local   # expect 2, and no value printed
```

`.env.example` documents both variables and the `sslmode=verify-full` requirement, with no values.

- [ ] **Step 2b: Write the failing test**

`src/lib/db.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { query } from "./db";

describe("db", () => {
  it("connects to the test database and runs a query", async () => {
    const rows = await query<{ one: number }>("SELECT 1::int AS one");
    expect(rows[0].one).toBe(1);
  });

  it("refuses to run the suite against the production database", async () => {
    expect(process.env.TEST_DATABASE_URL).toBeTruthy();
    expect(process.env.TEST_DATABASE_URL).not.toBe(process.env.DATABASE_URL);
  });

  it("uses a verified TLS connection", () => {
    expect(process.env.TEST_DATABASE_URL).toContain("sslmode=verify-full");
  });

  it("has applied the bootstrap migration", async () => {
    const rows = await query<{ version: string }>("SELECT version FROM schema_migrations");
    expect(rows.map((r) => r.version)).toContain("000_bootstrap");
  });
});
```

- [ ] **Step 3: Run it and watch it fail**

Run: `npx vitest run src/lib/db.test.ts`
Expected: FAIL — `./db` does not exist.

- [ ] **Step 4: Implement `src/lib/db.ts`**

```ts
import { existsSync, readFileSync } from "node:fs";
import { Pool } from "pg";

/**
 * Loaded here rather than from the shell, so a connection string never has to be
 * typed on a command line where it would land in shell history.
 */
export function loadEnvLocal(): void {
  if (!existsSync(".env.local")) return;
  for (const line of readFileSync(".env.local", "utf8").split("\n")) {
    const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].trim();
  }
}
loadEnvLocal();

const isTest = process.env.NODE_ENV === "test" || process.env.VITEST === "true";
const variable = isTest ? "TEST_DATABASE_URL" : "DATABASE_URL";
const connectionString = process.env[variable]?.trim();

if (!connectionString) {
  // Never interpolate the value into the message: this string reaches logs.
  throw new Error(`${variable} is not set. See .env.example.`);
}
if (isTest && connectionString === process.env.DATABASE_URL?.trim()) {
  throw new Error("TEST_DATABASE_URL must not be the production database: the suite truncates it.");
}

export const pool = new Pool({ connectionString, max: 1 });

export async function query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  const result = await pool.query(sql, params);
  return result.rows as T[];
}
```

- [ ] **Step 5: Implement the migration runner**

`scripts/migrate.mts` — the `outbid-tokens` runner, unchanged in shape: it loads `.env.local`, picks
`DATABASE_URL` or `TEST_DATABASE_URL` from a `--test` flag, creates `schema_migrations (version,
applied_at)`, applies every unapplied `migrations/*.sql` in filename order inside a transaction, and
logs **only** the `ep-...` host fragment — never the URL.

`migrations/000_bootstrap.sql`:

```sql
-- Extensions and conventions shared by every later migration.
CREATE EXTENSION IF NOT EXISTS citext;
```

```bash
npm pkg set scripts.db:migrate="tsx scripts/migrate.mts"
npm pkg set scripts.db:migrate:test="tsx scripts/migrate.mts --test"
```

- [ ] **Step 6: Apply and run the tests**

Run: `npm run db:migrate && npm run db:migrate:test && npm test`
Expected: both migrations report `000_bootstrap` applied; PASS.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "Add Neon connection handling and the migration runner

Connection strings are read from .env.local and never printed; the test
suite refuses to run against the production branch."
```

---

### Task 3: Core schema

**Files:**
- Create: `migrations/001_core.sql`
- Test: `src/lib/schema.test.ts`

**Interfaces:**
- Produces: the tables every later task reads and writes. Column names here are load-bearing.

- [ ] **Step 1: Write the failing test**

`src/lib/schema.test.ts`:

```ts
import { beforeAll, describe, expect, it } from "vitest";
import { query } from "./db";

const uuid = () => crypto.randomUUID();

async function truncate() {
  await query("TRUNCATE kol, cabal, kol_wallet, raw_tx, trade, position, pnl_daily, token, sol_price, audit_log CASCADE");
}

describe("core schema", () => {
  beforeAll(truncate);

  it("stores a KOL that hides its wallets by default", async () => {
    const id = uuid();
    await query("INSERT INTO kol (id, slug, display_name, x_handle) VALUES ($1,$2,$3,$4)",
      [id, "ejemplo", "Ejemplo", "ejemplo"]);
    const [row] = await query<{ hide_wallets: boolean; status: string }>(
      "SELECT hide_wallets, status FROM kol WHERE id = $1", [id]);
    expect(row.hide_wallets).toBe(true);
    expect(row.status).toBe("pending");
  });

  it("rejects the same X handle twice, case-insensitively", async () => {
    await query("INSERT INTO kol (id, slug, display_name, x_handle) VALUES ($1,$2,$3,$4)",
      [uuid(), "dup-a", "A", "Repetido"]);
    await expect(
      query("INSERT INTO kol (id, slug, display_name, x_handle) VALUES ($1,$2,$3,$4)",
        [uuid(), "dup-b", "B", "repetido"]),
    ).rejects.toThrow();
  });

  it("rejects the same wallet blind index under two KOLs", async () => {
    const hmac = Buffer.from("a".repeat(64), "hex");
    const first = uuid(), second = uuid();
    await query("INSERT INTO kol (id, slug, display_name, x_handle) VALUES ($1,$2,$3,$4)",
      [first, "w-a", "A", "wa"]);
    await query("INSERT INTO kol (id, slug, display_name, x_handle) VALUES ($1,$2,$3,$4)",
      [second, "w-b", "B", "wb"]);
    await query(
      "INSERT INTO kol_wallet (id, kol_id, address_enc, address_hmac) VALUES ($1,$2,$3,$4)",
      [uuid(), first, Buffer.from("x"), hmac]);
    await expect(
      query("INSERT INTO kol_wallet (id, kol_id, address_enc, address_hmac) VALUES ($1,$2,$3,$4)",
        [uuid(), second, Buffer.from("y"), hmac]),
    ).rejects.toThrow();
  });

  it("keeps money as numeric, not double precision", async () => {
    const [row] = await query<{ data_type: string }>(
      `SELECT data_type FROM information_schema.columns
       WHERE table_name = 'trade' AND column_name = 'sol_amount'`);
    expect(row.data_type).toBe("numeric");
  });

  it("enforces one trade per signature, instruction and wallet", async () => {
    const [row] = await query<{ count: string }>(
      `SELECT count(*) FROM pg_indexes
       WHERE tablename = 'trade' AND indexdef ILIKE '%UNIQUE%signature_hmac%instruction_index%wallet_id%'`);
    expect(Number(row.count)).toBe(1);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run src/lib/schema.test.ts`
Expected: FAIL — relation `kol` does not exist.

- [ ] **Step 3: Write the migration**

`migrations/001_core.sql`:

```sql
CREATE TABLE IF NOT EXISTS cabal (
  id         UUID PRIMARY KEY,
  tag        TEXT NOT NULL UNIQUE CHECK (tag ~ '^[A-Z]{3,4}$'),
  name       TEXT NOT NULL,
  logo_url   TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS kol (
  id                  UUID PRIMARY KEY,
  slug                TEXT NOT NULL UNIQUE,
  display_name        TEXT NOT NULL,
  x_handle            CITEXT NOT NULL UNIQUE,
  avatar_override_url TEXT,
  cabal_id            UUID REFERENCES cabal (id),
  hide_wallets        BOOLEAN NOT NULL DEFAULT TRUE,
  status              TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','approved','rejected','suspended')),
  approved_at         TIMESTAMPTZ,
  suspended_at        TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- address_enc: AES-256-GCM. address_hmac: HMAC-SHA-256 under a separate key, and the
-- only way anything looks a wallet up. See docs/spec-v1.md section 8.
CREATE TABLE IF NOT EXISTS kol_wallet (
  id                  UUID PRIMARY KEY,
  kol_id              UUID NOT NULL REFERENCES kol (id),
  address_enc         BYTEA NOT NULL,
  address_hmac        BYTEA NOT NULL UNIQUE,
  key_version         SMALLINT NOT NULL DEFAULT 1,
  proof_signature_enc BYTEA,
  proof_message_enc   BYTEA,
  proof_verified_at   TIMESTAMPTZ,
  status              TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','withdrawn')),
  added_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  withdrawn_at        TIMESTAMPTZ,
  backfill_status     TEXT NOT NULL DEFAULT 'queued'
                        CHECK (backfill_status IN ('queued','running','done','capped','failed')),
  backfill_cursor     TEXT
);
CREATE INDEX IF NOT EXISTS kol_wallet_kol_idx ON kol_wallet (kol_id) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS raw_tx (
  signature_hmac BYTEA PRIMARY KEY,
  signature_enc  BYTEA NOT NULL,
  payload_enc    BYTEA NOT NULL,
  key_version    SMALLINT NOT NULL DEFAULT 1,
  slot           BIGINT,
  block_time     TIMESTAMPTZ NOT NULL,
  received_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  parsed_at      TIMESTAMPTZ,
  parse_error    TEXT,
  source         TEXT NOT NULL CHECK (source IN ('webhook','backfill','reconcile'))
);
CREATE INDEX IF NOT EXISTS raw_tx_unparsed_idx ON raw_tx (received_at) WHERE parsed_at IS NULL;

CREATE TABLE IF NOT EXISTS token (
  mint           TEXT PRIMARY KEY,
  symbol         TEXT,
  name           TEXT,
  decimals       SMALLINT NOT NULL DEFAULT 9,
  image_url      TEXT,
  price_usd      NUMERIC,
  price_sol      NUMERIC,
  liquidity_usd  NUMERIC,
  price_state    TEXT NOT NULL DEFAULT 'unpriced'
                   CHECK (price_state IN ('priced','stale','unpriced')),
  pair_url       TEXT,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS trade (
  id                UUID PRIMARY KEY,
  signature_hmac    BYTEA NOT NULL,
  signature_enc     BYTEA NOT NULL,
  instruction_index SMALLINT NOT NULL,
  kol_id            UUID NOT NULL REFERENCES kol (id),
  wallet_id         UUID NOT NULL REFERENCES kol_wallet (id),
  mint              TEXT NOT NULL,
  side              TEXT NOT NULL CHECK (side IN ('buy','sell')),
  token_amount      NUMERIC NOT NULL,
  sol_amount        NUMERIC NOT NULL,
  usd_amount        NUMERIC,
  sol_usd           NUMERIC,
  price_sol         NUMERIC,
  price_usd         NUMERIC,
  fee_sol           NUMERIC NOT NULL DEFAULT 0,
  basis             TEXT NOT NULL DEFAULT 'known' CHECK (basis IN ('known','unknown')),
  block_time        TIMESTAMPTZ NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS trade_unique_idx
  ON trade (signature_hmac, instruction_index, wallet_id);
CREATE INDEX IF NOT EXISTS trade_feed_idx ON trade (block_time DESC, id DESC);
CREATE INDEX IF NOT EXISTS trade_position_idx ON trade (kol_id, mint, block_time);
CREATE INDEX IF NOT EXISTS trade_token_idx ON trade (mint, block_time DESC);

CREATE TABLE IF NOT EXISTS position (
  kol_id        UUID NOT NULL REFERENCES kol (id),
  mint          TEXT NOT NULL,
  qty           NUMERIC NOT NULL DEFAULT 0,
  cost_sol      NUMERIC NOT NULL DEFAULT 0,
  avg_cost_sol  NUMERIC NOT NULL DEFAULT 0,
  realized_sol  NUMERIC NOT NULL DEFAULT 0,
  realized_usd  NUMERIC NOT NULL DEFAULT 0,
  first_buy_at  TIMESTAMPTZ,
  last_trade_at TIMESTAMPTZ,
  basis         TEXT NOT NULL DEFAULT 'known' CHECK (basis IN ('known','unknown')),
  dirty         BOOLEAN NOT NULL DEFAULT TRUE,
  PRIMARY KEY (kol_id, mint)
);
CREATE INDEX IF NOT EXISTS position_dirty_idx ON position (kol_id, mint) WHERE dirty;

CREATE TABLE IF NOT EXISTS pnl_daily (
  kol_id       UUID NOT NULL REFERENCES kol (id),
  day          DATE NOT NULL,
  realized_sol NUMERIC NOT NULL DEFAULT 0,
  realized_usd NUMERIC NOT NULL DEFAULT 0,
  wins         INTEGER NOT NULL DEFAULT 0,
  losses       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (kol_id, day)
);

CREATE TABLE IF NOT EXISTS sol_price (
  minute TIMESTAMPTZ PRIMARY KEY,
  usd    NUMERIC NOT NULL
);

CREATE TABLE IF NOT EXISTS setting (
  key   TEXT PRIMARY KEY,
  value JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS rate_limit (
  ip_hash     BYTEA NOT NULL,
  bucket      TEXT NOT NULL,
  window_start TIMESTAMPTZ NOT NULL,
  hits        INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (ip_hash, bucket, window_start)
);

CREATE TABLE IF NOT EXISTS audit_log (
  id          UUID PRIMARY KEY,
  actor       TEXT NOT NULL,
  action      TEXT NOT NULL,
  target_type TEXT,
  target_id   TEXT,
  before      JSONB,
  after       JSONB,
  ip_hash     BYTEA,
  at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_log_at_idx ON audit_log (at DESC);
```

- [ ] **Step 4: Apply and run the tests**

Run: `npm run db:migrate && npm run db:migrate:test && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "Add the core schema

Wallet addresses and transaction signatures exist only as ciphertext plus
an HMAC index; nothing in the schema can look a wallet up by plaintext."
```

---

### Task 4: Encryption and the blind index

**Files:**
- Create: `src/lib/crypto.ts`
- Test: `src/lib/crypto.test.ts`

**Interfaces:**
- Produces: `encrypt(plaintext: string, aad: string): Buffer`,
  `decrypt(blob: Buffer, aad: string): string`, `blindIndex(value: string): Buffer`,
  `KEY_VERSION: number`

- [ ] **Step 1: Generate development keys**

Two independent 32-byte keys, appended without ever being printed:

```bash
printf 'WALLET_ENC_KEY=%s\n'  "$(node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("base64"))')" >> .env.local
printf 'WALLET_HMAC_KEY=%s\n' "$(node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("base64"))')" >> .env.local
printf 'HELIUS_WEBHOOK_SECRET=%s\n' "$(node -e 'process.stdout.write(require("crypto").randomBytes(24).toString("base64url"))')" >> .env.local
```

`.env.example` gains all three with empty values and a comment saying they are 32-byte base64 keys
that live in the Vercel environment and never in Neon.

- [ ] **Step 2: Write the failing test**

`src/lib/crypto.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { blindIndex, decrypt, encrypt } from "./crypto";

const value = "z".repeat(44);           // an address-shaped string, invented
const aad = "kol_wallet:address:row-1";

describe("encrypt / decrypt", () => {
  it("round-trips under the same AAD", () => {
    expect(decrypt(encrypt(value, aad), aad)).toBe(value);
  });

  it("produces a different ciphertext every time", () => {
    expect(encrypt(value, aad).equals(encrypt(value, aad))).toBe(false);
  });

  it("refuses a ciphertext moved to another row", () => {
    const blob = encrypt(value, aad);
    expect(() => decrypt(blob, "kol_wallet:address:row-2")).toThrow();
  });

  it("refuses a ciphertext moved to another column", () => {
    const blob = encrypt(value, aad);
    expect(() => decrypt(blob, "kol_wallet:proof_signature:row-1")).toThrow();
  });

  it("refuses a tampered ciphertext", () => {
    const blob = encrypt(value, aad);
    blob[blob.length - 1] ^= 0xff;
    expect(() => decrypt(blob, aad)).toThrow();
  });

  it("carries a key version in the first byte", () => {
    expect(encrypt(value, aad)[0]).toBe(1);
  });

  it("never contains the plaintext", () => {
    expect(encrypt(value, aad).toString("utf8")).not.toContain(value);
  });
});

describe("blindIndex", () => {
  it("is deterministic and 32 bytes", () => {
    const a = blindIndex(value);
    expect(a.equals(blindIndex(value))).toBe(true);
    expect(a.length).toBe(32);
  });

  it("differs for different inputs", () => {
    expect(blindIndex(value).equals(blindIndex("y".repeat(44)))).toBe(false);
  });

  it("is not a bare hash of the input", () => {
    const sha = require("node:crypto").createHash("sha256").update(value).digest();
    expect(blindIndex(value).equals(sha)).toBe(false);
  });
});
```

- [ ] **Step 3: Run it and watch it fail**

Run: `npx vitest run src/lib/crypto.test.ts`
Expected: FAIL — `./crypto` does not exist.

- [ ] **Step 4: Implement**

`src/lib/crypto.ts`:

```ts
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";
import { loadEnvLocal } from "./db";

loadEnvLocal();

export const KEY_VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;

/**
 * Keys live in the host environment and never in Neon: a database dump alone
 * must not yield addresses. See SECURITY.md.
 */
function key(name: "WALLET_ENC_KEY" | "WALLET_HMAC_KEY"): Buffer {
  const raw = process.env[name];
  if (!raw) throw new Error(`${name} is not set`);
  const bytes = Buffer.from(raw, "base64");
  if (bytes.length !== 32) throw new Error(`${name} must be 32 bytes, base64-encoded`);
  return bytes;
}

/**
 * `aad` binds the ciphertext to its exact column and row, so a value cannot be
 * moved between fields or rows and still authenticate.
 * Layout: version(1) | iv(12) | tag(16) | ciphertext
 */
export function encrypt(plaintext: string, aad: string): Buffer {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key("WALLET_ENC_KEY"), iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([Buffer.from([KEY_VERSION]), iv, cipher.getAuthTag(), body]);
}

export function decrypt(blob: Buffer, aad: string): string {
  const version = blob[0];
  if (version !== KEY_VERSION) throw new Error(`unknown key version ${version}`);
  const iv = blob.subarray(1, 1 + IV_BYTES);
  const tag = blob.subarray(1 + IV_BYTES, 1 + IV_BYTES + TAG_BYTES);
  const body = blob.subarray(1 + IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", key("WALLET_ENC_KEY"), iv);
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
}

/**
 * Equality lookup without decryption. Keyed, so an attacker holding a database
 * dump cannot test a guessed address against the index.
 */
export function blindIndex(value: string): Buffer {
  return createHmac("sha256", key("WALLET_HMAC_KEY")).update(value, "utf8").digest();
}
```

- [ ] **Step 5: Run the tests and watch them pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "Add AES-256-GCM storage and the HMAC blind index

AAD binds each ciphertext to its column and row, so a value cannot be
moved between fields or rows and still authenticate."
```

---

### Task 5: Wallet storage and lookup

**Files:**
- Create: `src/lib/wallets.ts`, `src/lib/ids.ts`
- Test: `src/lib/wallets.test.ts`

**Interfaces:**
- Produces: `addWallet(kolId: string, address: string): Promise<string>` (returns the wallet id),
  `findWalletByAddress(address: string): Promise<WalletRow | null>`,
  `revealAddress(walletId: string): Promise<string>`,
  `type WalletRow = { id: string; kol_id: string; status: string }`,
  `inventAddress(): string` in `ids.ts`

- [ ] **Step 1: Write the failing test**

`src/lib/wallets.test.ts`:

```ts
import { beforeEach, describe, expect, it } from "vitest";
import { query } from "./db";
import { inventAddress } from "./ids";
import { addWallet, findWalletByAddress, revealAddress } from "./wallets";

async function makeKol(handle: string): Promise<string> {
  const id = crypto.randomUUID();
  await query("INSERT INTO kol (id, slug, display_name, x_handle, status) VALUES ($1,$2,$3,$4,'approved')",
    [id, handle, handle, handle]);
  return id;
}

beforeEach(async () => {
  await query("TRUNCATE kol, kol_wallet CASCADE");
});

describe("wallets", () => {
  it("stores an address and finds it again", async () => {
    const kol = await makeKol("uno");
    const address = inventAddress();
    const walletId = await addWallet(kol, address);

    const found = await findWalletByAddress(address);
    expect(found?.id).toBe(walletId);
    expect(found?.kol_id).toBe(kol);
  });

  it("stores no plaintext address in the row", async () => {
    const kol = await makeKol("dos");
    const address = inventAddress();
    await addWallet(kol, address);

    const [row] = await query<{ blob: string }>(
      "SELECT kol_wallet::text AS blob FROM kol_wallet");
    expect(row.blob).not.toContain(address);
  });

  it("returns null for an address nobody registered", async () => {
    expect(await findWalletByAddress(inventAddress())).toBeNull();
  });

  it("refuses the same address under a second KOL", async () => {
    const a = await makeKol("tres");
    const b = await makeKol("cuatro");
    const address = inventAddress();
    await addWallet(a, address);
    await expect(addWallet(b, address)).rejects.toThrow();
  });

  it("reveals a stored address only through the explicit call", async () => {
    const kol = await makeKol("cinco");
    const address = inventAddress();
    const walletId = await addWallet(kol, address);
    expect(await revealAddress(walletId)).toBe(address);
  });
});

describe("inventAddress", () => {
  it("produces distinct base58 strings of address length", () => {
    const a = inventAddress();
    expect(a).not.toBe(inventAddress());
    expect(a.length).toBeGreaterThanOrEqual(32);
    expect(a.length).toBeLessThanOrEqual(44);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run src/lib/wallets.test.ts`
Expected: FAIL — `./wallets` does not exist.

- [ ] **Step 3: Implement `src/lib/ids.ts`**

```ts
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
```

- [ ] **Step 4: Implement `src/lib/wallets.ts`**

```ts
import { blindIndex, decrypt, encrypt } from "./crypto";
import { query } from "./db";

export type WalletRow = { id: string; kol_id: string; status: string };

const aadFor = (walletId: string) => `kol_wallet:address:${walletId}`;

export async function addWallet(kolId: string, address: string): Promise<string> {
  const id = crypto.randomUUID();
  await query(
    `INSERT INTO kol_wallet (id, kol_id, address_enc, address_hmac)
     VALUES ($1, $2, $3, $4)`,
    [id, kolId, encrypt(address, aadFor(id)), blindIndex(address)],
  );
  return id;
}

/** The only lookup path. Nothing decrypts a table to find a wallet. */
export async function findWalletByAddress(address: string): Promise<WalletRow | null> {
  const rows = await query<WalletRow>(
    "SELECT id, kol_id, status FROM kol_wallet WHERE address_hmac = $1",
    [blindIndex(address)],
  );
  return rows[0] ?? null;
}

/**
 * Decrypts exactly one address. Every caller is either the admin reveal path,
 * which audits the call, or the Helius address-set builder.
 */
export async function revealAddress(walletId: string): Promise<string> {
  const rows = await query<{ address_enc: Buffer }>(
    "SELECT address_enc FROM kol_wallet WHERE id = $1", [walletId]);
  if (!rows[0]) throw new Error(`no wallet ${walletId}`);
  return decrypt(rows[0].address_enc, aadFor(walletId));
}
```

- [ ] **Step 5: Run the tests and watch them pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "Add wallet storage keyed by blind index

Lookup goes through the HMAC index; decryption happens one row at a time
through an explicit call, never as a table scan."
```

---

### Task 6: Development seed

The first visible artefact: a KOL that exists, with a wallet nobody owns.

**Files:**
- Create: `scripts/seed-dev.mts`
- Test: `src/lib/seed.test.ts`

**Interfaces:**
- Produces: `seedDev(): Promise<{ kolId: string; walletId: string; address: string }>` exported from
  `scripts/seed-dev.mts`, so the test can call it directly.

- [ ] **Step 1: Write the failing test**

`src/lib/seed.test.ts`:

```ts
import { beforeEach, describe, expect, it } from "vitest";
import { seedDev } from "../../scripts/seed-dev.mts";
import { query } from "./db";
import { findWalletByAddress } from "./wallets";

beforeEach(async () => {
  await query("TRUNCATE kol, cabal, kol_wallet, sol_price CASCADE");
});

describe("seedDev", () => {
  it("creates an approved KOL with a cabal and a wallet", async () => {
    const { kolId, address } = await seedDev();

    const [kol] = await query<{ status: string; hide_wallets: boolean; cabal_id: string | null }>(
      "SELECT status, hide_wallets, cabal_id FROM kol WHERE id = $1", [kolId]);
    expect(kol.status).toBe("approved");
    expect(kol.hide_wallets).toBe(true);
    expect(kol.cabal_id).not.toBeNull();

    expect((await findWalletByAddress(address))?.kol_id).toBe(kolId);
  });

  it("seeds a SOL price so trades can be valued in USD", async () => {
    await seedDev();
    const [row] = await query<{ count: string }>("SELECT count(*) FROM sol_price");
    expect(Number(row.count)).toBeGreaterThan(0);
  });

  it("is idempotent", async () => {
    const first = await seedDev();
    const second = await seedDev();
    expect(second.kolId).toBe(first.kolId);
    const [row] = await query<{ count: string }>("SELECT count(*) FROM kol");
    expect(Number(row.count)).toBe(1);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run src/lib/seed.test.ts`
Expected: FAIL — `scripts/seed-dev.mts` does not exist.

- [ ] **Step 3: Implement**

`scripts/seed-dev.mts`:

```ts
/**
 * One KOL, one cabal, one wallet, one SOL price. Development only.
 *
 * The wallet address is generated, never copied from a real one: see
 * SECURITY.md. Re-running this returns the existing rows.
 */
import { query } from "../src/lib/db";
import { inventAddress } from "../src/lib/ids";
import { addWallet, revealAddress } from "../src/lib/wallets";

const HANDLE = "kolejemplo";

export async function seedDev() {
  const existing = await query<{ id: string }>("SELECT id FROM kol WHERE x_handle = $1", [HANDLE]);
  if (existing[0]) {
    const [wallet] = await query<{ id: string }>(
      "SELECT id FROM kol_wallet WHERE kol_id = $1 LIMIT 1", [existing[0].id]);
    return {
      kolId: existing[0].id,
      walletId: wallet.id,
      address: await revealAddress(wallet.id),
    };
  }

  const cabalId = crypto.randomUUID();
  await query("INSERT INTO cabal (id, tag, name) VALUES ($1, 'EJE', 'Ejemplo')", [cabalId]);

  const kolId = crypto.randomUUID();
  await query(
    `INSERT INTO kol (id, slug, display_name, x_handle, cabal_id, status, approved_at)
     VALUES ($1, $2, $3, $4, $5, 'approved', now())`,
    [kolId, HANDLE, "KOL de Ejemplo", HANDLE, cabalId],
  );

  const address = inventAddress();
  const walletId = await addWallet(kolId, address);

  await query(
    `INSERT INTO sol_price (minute, usd) VALUES (date_trunc('minute', now()), 150)
     ON CONFLICT (minute) DO NOTHING`,
  );

  return { kolId, walletId, address };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { kolId } = await seedDev();
  // The address is deliberately not printed: it belongs in the database, not in
  // a terminal scrollback or a CI log.
  console.log(`seeded KOL ${kolId}`);
  process.exit(0);
}
```

```bash
npm pkg set scripts.db:seed="tsx scripts/seed-dev.mts"
```

- [ ] **Step 4: Run the tests and seed the development database**

Run: `npm test && npm run db:seed`
Expected: PASS, then `seeded KOL <uuid>`.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "Add the development seed

The seeded wallet address is generated at run time and never printed, so
no address enters the repo or a terminal log."
```

---

### Task 7: IP-hash rate limiting

**Files:**
- Create: `src/lib/rate-limit.ts`
- Test: `src/lib/rate-limit.test.ts`

**Interfaces:**
- Produces: `ipHash(ip: string): Buffer`, `hitLimit(ip: string, bucket: string, limit: number,
  windowSeconds: number): Promise<boolean>` — returns `true` when the caller is over the limit.

- [ ] **Step 1: Write the failing test**

`src/lib/rate-limit.test.ts`:

```ts
import { beforeEach, describe, expect, it } from "vitest";
import { query } from "./db";
import { hitLimit, ipHash } from "./rate-limit";

beforeEach(async () => {
  await query("TRUNCATE rate_limit");
});

describe("ipHash", () => {
  it("is deterministic, 32 bytes, and not reversible to the address", () => {
    const hashed = ipHash("203.0.113.7");
    expect(hashed.equals(ipHash("203.0.113.7"))).toBe(true);
    expect(hashed.length).toBe(32);
    expect(hashed.toString("utf8")).not.toContain("203.0.113.7");
  });

  it("differs between addresses", () => {
    expect(ipHash("203.0.113.7").equals(ipHash("203.0.113.8"))).toBe(false);
  });
});

describe("hitLimit", () => {
  it("allows calls up to the limit and blocks the next one", async () => {
    for (let i = 0; i < 3; i++) {
      expect(await hitLimit("203.0.113.7", "test", 3, 60)).toBe(false);
    }
    expect(await hitLimit("203.0.113.7", "test", 3, 60)).toBe(true);
  });

  it("counts buckets independently", async () => {
    await hitLimit("203.0.113.7", "a", 1, 60);
    expect(await hitLimit("203.0.113.7", "b", 1, 60)).toBe(false);
  });

  it("counts callers independently", async () => {
    await hitLimit("203.0.113.7", "test", 1, 60);
    expect(await hitLimit("203.0.113.8", "test", 1, 60)).toBe(false);
  });

  it("stores no raw IP address", async () => {
    await hitLimit("203.0.113.7", "test", 5, 60);
    const [row] = await query<{ blob: string }>("SELECT rate_limit::text AS blob FROM rate_limit");
    expect(row.blob).not.toContain("203.0.113.7");
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run src/lib/rate-limit.test.ts`
Expected: FAIL — `./rate-limit` does not exist.

- [ ] **Step 3: Implement**

`src/lib/rate-limit.ts`:

```ts
import { createHmac } from "node:crypto";
import { query } from "./db";

/**
 * Client IPs are personal data we have no use for. We keep a keyed hash, which
 * is enough to count and not enough to identify. The key is the HMAC key
 * already loaded for the blind index.
 */
export function ipHash(ip: string): Buffer {
  const key = Buffer.from(process.env.WALLET_HMAC_KEY ?? "", "base64");
  if (key.length !== 32) throw new Error("WALLET_HMAC_KEY must be 32 bytes, base64-encoded");
  return createHmac("sha256", key).update(`ip:${ip}`, "utf8").digest();
}

/** Fixed window. Returns true when the caller has exceeded `limit` in the window. */
export async function hitLimit(
  ip: string,
  bucket: string,
  limit: number,
  windowSeconds: number,
): Promise<boolean> {
  const rows = await query<{ hits: number }>(
    `INSERT INTO rate_limit (ip_hash, bucket, window_start, hits)
     VALUES ($1, $2, to_timestamp(floor(extract(epoch FROM now()) / $3) * $3), 1)
     ON CONFLICT (ip_hash, bucket, window_start)
       DO UPDATE SET hits = rate_limit.hits + 1
     RETURNING hits`,
    [ipHash(ip), bucket, windowSeconds],
  );
  return rows[0].hits > limit;
}
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "Add IP-hash rate limiting

Counts by keyed hash so the table never holds a client address."
```

---

### Task 8: The webhook endpoint

The endpoint authenticates, encrypts, stores and returns. No parsing in the request path: Helius
gives us **one second**, retries three times one second apart, and then drops the event for good.

**Files:**
- Create: `src/app/api/webhooks/helius/route.ts`, `src/lib/raw-tx.ts`
- Test: `src/lib/raw-tx.test.ts`, `src/app/api/webhooks/helius/route.test.ts`

**Interfaces:**
- Produces: `storeRawTx(input: { signature: string; blockTime: Date; slot: number | null; payload:
  unknown; source: "webhook" | "backfill" | "reconcile" }): Promise<boolean>` — returns `false` when
  the signature was already stored. `POST` handler at `/api/webhooks/helius`.

- [ ] **Step 1: Write the failing tests**

`src/lib/raw-tx.test.ts`:

```ts
import { beforeEach, describe, expect, it } from "vitest";
import { query } from "./db";
import { inventSignature } from "./ids";
import { storeRawTx } from "./raw-tx";

beforeEach(async () => {
  await query("TRUNCATE raw_tx");
});

const input = () => ({
  signature: inventSignature(),
  blockTime: new Date("2026-08-25T12:00:00Z"),
  slot: 171942732,
  payload: { type: "SWAP", note: "fixture" },
  source: "webhook" as const,
});

describe("storeRawTx", () => {
  it("stores a new transaction", async () => {
    expect(await storeRawTx(input())).toBe(true);
    const [row] = await query<{ count: string }>("SELECT count(*) FROM raw_tx");
    expect(Number(row.count)).toBe(1);
  });

  it("is idempotent on a replayed signature", async () => {
    const one = input();
    expect(await storeRawTx(one)).toBe(true);
    expect(await storeRawTx(one)).toBe(false);
    const [row] = await query<{ count: string }>("SELECT count(*) FROM raw_tx");
    expect(Number(row.count)).toBe(1);
  });

  it("stores neither the signature nor the payload in plaintext", async () => {
    const one = { ...input(), payload: { type: "SWAP", marker: "PLAINTEXT-MARKER" } };
    await storeRawTx(one);
    const [row] = await query<{ blob: string }>("SELECT raw_tx::text AS blob FROM raw_tx");
    expect(row.blob).not.toContain(one.signature);
    expect(row.blob).not.toContain("PLAINTEXT-MARKER");
  });

  it("leaves the row unparsed for the parser to pick up", async () => {
    await storeRawTx(input());
    const [row] = await query<{ parsed_at: Date | null }>("SELECT parsed_at FROM raw_tx");
    expect(row.parsed_at).toBeNull();
  });
});
```

`src/app/api/webhooks/helius/route.test.ts`:

```ts
import { beforeEach, describe, expect, it } from "vitest";
import { query } from "@/lib/db";
import { inventSignature } from "@/lib/ids";
import { POST } from "./route";

const secret = process.env.HELIUS_WEBHOOK_SECRET!;

function request(body: unknown, authorization: string | null) {
  return new Request("http://localhost/api/webhooks/helius", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": "203.0.113.7",
      ...(authorization ? { authorization } : {}),
    },
    body: JSON.stringify(body),
  });
}

const payload = (signature: string) => [
  { signature, slot: 1, timestamp: 1787664000, type: "SWAP" },
];

beforeEach(async () => {
  await query("TRUNCATE raw_tx, rate_limit");
});

describe("POST /api/webhooks/helius", () => {
  it("rejects a missing authorization header", async () => {
    const res = await POST(request(payload(inventSignature()), null));
    expect(res.status).toBe(401);
    const [row] = await query<{ count: string }>("SELECT count(*) FROM raw_tx");
    expect(Number(row.count)).toBe(0);
  });

  it("rejects a wrong secret", async () => {
    const res = await POST(request(payload(inventSignature()), "wrong"));
    expect(res.status).toBe(401);
  });

  it("accepts a correct secret and stores the transaction", async () => {
    const res = await POST(request(payload(inventSignature()), secret));
    expect(res.status).toBe(200);
    const [row] = await query<{ count: string }>("SELECT count(*) FROM raw_tx");
    expect(Number(row.count)).toBe(1);
  });

  it("returns 200 on a replay without storing a duplicate", async () => {
    const body = payload(inventSignature());
    await POST(request(body, secret));
    const res = await POST(request(body, secret));
    expect(res.status).toBe(200);
    const [row] = await query<{ count: string }>("SELECT count(*) FROM raw_tx");
    expect(Number(row.count)).toBe(1);
  });

  it("answers well inside the one-second budget Helius allows", async () => {
    const started = Date.now();
    await POST(request(payload(inventSignature()), secret));
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("accepts a batch of transactions in one delivery", async () => {
    const body = [...payload(inventSignature()), ...payload(inventSignature())];
    const res = await POST(request(body, secret));
    expect(res.status).toBe(200);
    const [row] = await query<{ count: string }>("SELECT count(*) FROM raw_tx");
    expect(Number(row.count)).toBe(2);
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run src/lib/raw-tx.test.ts src/app/api/webhooks/helius/route.test.ts`
Expected: FAIL — neither module exists.

- [ ] **Step 3: Implement `src/lib/raw-tx.ts`**

```ts
import { blindIndex, encrypt } from "./crypto";
import { query } from "./db";

export type RawTxInput = {
  signature: string;
  blockTime: Date;
  slot: number | null;
  payload: unknown;
  source: "webhook" | "backfill" | "reconcile";
};

/**
 * Stores one delivered transaction, encrypted. The signature's blind index is
 * the primary key, which is also the idempotency barrier: Helius retries and
 * may deliver the same event more than once.
 */
export async function storeRawTx(input: RawTxInput): Promise<boolean> {
  const hmac = blindIndex(input.signature);
  const aad = `raw_tx:${hmac.toString("hex")}`;
  const rows = await query<{ signature_hmac: Buffer }>(
    `INSERT INTO raw_tx (signature_hmac, signature_enc, payload_enc, slot, block_time, source)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (signature_hmac) DO NOTHING
     RETURNING signature_hmac`,
    [
      hmac,
      encrypt(input.signature, `${aad}:signature`),
      encrypt(JSON.stringify(input.payload), `${aad}:payload`),
      input.slot,
      input.blockTime,
      input.source,
    ],
  );
  return rows.length > 0;
}
```

- [ ] **Step 4: Implement the route**

`src/app/api/webhooks/helius/route.ts`:

```ts
import { timingSafeEqual } from "node:crypto";
import { storeRawTx } from "@/lib/raw-tx";
import { hitLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";

function authorized(header: string | null): boolean {
  const expected = process.env.HELIUS_WEBHOOK_SECRET;
  if (!expected || !header) return false;
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Authenticate, store, return. Helius allows one second, retries three times a
 * second apart, and then drops the event permanently — so nothing is parsed
 * here. The parser reads raw_tx afterwards.
 */
export async function POST(request: Request): Promise<Response> {
  if (!authorized(request.headers.get("authorization"))) {
    return new Response("unauthorized", { status: 401 });
  }

  const ip = request.headers.get("x-forwarded-for")?.split(",")[0].trim() ?? "unknown";
  if (await hitLimit(ip, "helius-webhook", 600, 60)) {
    return new Response("rate limited", { status: 429 });
  }

  let events: Array<{ signature: string; slot?: number; timestamp?: number }>;
  try {
    const body = await request.json();
    events = Array.isArray(body) ? body : [body];
  } catch {
    return new Response("bad request", { status: 400 });
  }

  for (const event of events) {
    if (!event?.signature) continue;
    await storeRawTx({
      signature: event.signature,
      slot: event.slot ?? null,
      blockTime: new Date((event.timestamp ?? Math.floor(Date.now() / 1000)) * 1000),
      payload: event,
      source: "webhook",
    });
  }

  return new Response("ok", { status: 200 });
}
```

- [ ] **Step 5: Run the tests and watch them pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "Add the Helius webhook endpoint

Authenticates in constant time, encrypts the payload, stores it keyed by
the signature's blind index, and returns. Parsing happens elsewhere: the
delivery budget is one second and a dropped event is not redelivered."
```

---

### Task 9: The swap parser

**Scope note.** Batch 1 parses **SOL-quoted swaps only**. Stablecoin-quoted and token↔token swaps
(spec §4.3) get their own task in the next batch; until then the parser records them as
`parse_error = 'unsupported_quote'` rather than guessing. Silently dropping them would look like
missing data later.

**Files:**
- Create: `src/lib/parse-swap.ts`, `src/lib/fixtures/swap.ts`
- Test: `src/lib/parse-swap.test.ts`

**Interfaces:**
- Produces: `parseSwap(payload: EnhancedTx, wallet: { id: string; kolId: string; address: string }):
  ParsedTrade | null`, `parsePending(limit?: number): Promise<number>`,
  `type ParsedTrade = { mint: string; side: "buy" | "sell"; tokenAmount: number; solAmount: number;
  feeSol: number; instructionIndex: number }`,
  and `buildSwapPayload(...)` in `fixtures/swap.ts` for tests.

- [ ] **Step 1: Write the failing test**

`src/lib/parse-swap.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildSwapPayload } from "./fixtures/swap";
import { inventAddress } from "./ids";
import { parseSwap } from "./parse-swap";

const wallet = { id: "w-1", kolId: "k-1", address: inventAddress() };
const mint = inventAddress();

describe("parseSwap", () => {
  it("reads a buy: SOL out, tokens in", () => {
    const payload = buildSwapPayload({
      wallet: wallet.address, mint, decimals: 6,
      nativeChangeLamports: -1_005_000, // 1 SOL spent plus 0.005 fee
      tokenChangeRaw: "2000000",        // 2 tokens in
      feeLamports: 5_000,
      isFeePayer: true,
    });

    const trade = parseSwap(payload, wallet)!;
    expect(trade.side).toBe("buy");
    expect(trade.tokenAmount).toBeCloseTo(2, 9);
    expect(trade.solAmount).toBeCloseTo(1, 9);   // fee excluded from the trade amount
    expect(trade.feeSol).toBeCloseTo(0.000005, 9);
    expect(trade.mint).toBe(mint);
  });

  it("reads a sell: tokens out, SOL in", () => {
    const payload = buildSwapPayload({
      wallet: wallet.address, mint, decimals: 6,
      nativeChangeLamports: 1_995_000,  // 2 SOL received less 0.005 fee
      tokenChangeRaw: "-2000000",
      feeLamports: 5_000,
      isFeePayer: true,
    });

    const trade = parseSwap(payload, wallet)!;
    expect(trade.side).toBe("sell");
    expect(trade.solAmount).toBeCloseTo(2, 9);
  });

  it("does not charge the fee to a wallet that did not pay it", () => {
    const payload = buildSwapPayload({
      wallet: wallet.address, mint, decimals: 6,
      nativeChangeLamports: -1_000_000,
      tokenChangeRaw: "2000000",
      feeLamports: 5_000,
      isFeePayer: false,
    });

    const trade = parseSwap(payload, wallet)!;
    expect(trade.solAmount).toBeCloseTo(1, 9);
    expect(trade.feeSol).toBe(0);
  });

  it("ignores a transaction that does not touch this wallet", () => {
    const payload = buildSwapPayload({
      wallet: inventAddress(), mint, decimals: 6,
      nativeChangeLamports: -1_000_000, tokenChangeRaw: "2000000",
      feeLamports: 5_000, isFeePayer: true,
    });
    expect(parseSwap(payload, wallet)).toBeNull();
  });

  it("ignores a transaction with no SOL leg", () => {
    const payload = buildSwapPayload({
      wallet: wallet.address, mint, decimals: 6,
      nativeChangeLamports: 0, tokenChangeRaw: "2000000",
      feeLamports: 0, isFeePayer: false,
    });
    expect(parseSwap(payload, wallet)).toBeNull();
  });

  it("respects token decimals", () => {
    const payload = buildSwapPayload({
      wallet: wallet.address, mint, decimals: 9,
      nativeChangeLamports: -1_000_000, tokenChangeRaw: "2000000000",
      feeLamports: 0, isFeePayer: false,
    });
    expect(parseSwap(payload, wallet)!.tokenAmount).toBeCloseTo(2, 9);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run src/lib/parse-swap.test.ts`
Expected: FAIL — `./parse-swap` does not exist.

- [ ] **Step 3: Implement the fixture builder**

`src/lib/fixtures/swap.ts` builds the subset of the Helius enhanced payload the parser reads —
`accountData[].nativeBalanceChange`, `accountData[].tokenBalanceChanges[]`, `fee`, `feePayer`,
`signature`, `timestamp`, `slot`, `type: "SWAP"`. Every address it needs is passed in by the caller,
so the fixture file contains no address literals.

- [ ] **Step 4: Implement the parser**

`src/lib/parse-swap.ts`. The arithmetic, stated once:

- `nativeBalanceChange` is in lamports and, for the fee payer, already includes the transaction fee.
- buy: `solAmount = (|nativeChange| - fee) / 1e9`; sell: `solAmount = (nativeChange + fee) / 1e9`
  when the wallet paid the fee, and `|nativeChange| / 1e9` when it did not.
- `tokenAmount = |rawTokenAmount| / 10 ** decimals`; the sign of the token change decides the side.
- `priceSol = solAmount / tokenAmount`.

`parsePending(limit)` decrypts unparsed `raw_tx` rows, resolves each account in the payload through
`findWalletByAddress`, writes `trade` rows with `ON CONFLICT DO NOTHING`, marks the position dirty,
and sets `parsed_at`.

- [ ] **Step 5: Run the tests and watch them pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "Parse SOL-quoted swaps into normalised trades

The SOL side is the wallet's net native balance delta, which already
contains AMM and launchpad fees; the transaction fee is separated out.
Stablecoin and token-to-token quotes are recorded as unsupported rather
than guessed at."
```

---

### Task 10: Positions and realized PnL

**Files:**
- Create: `src/lib/pnl.ts`
- Test: `src/lib/pnl.test.ts`

**Interfaces:**
- Produces: `replayPosition(kolId: string, mint: string): Promise<void>`,
  `recomputeDirty(limit?: number): Promise<number>`

- [ ] **Step 1: Write the failing test**

`src/lib/pnl.test.ts`. The order-independence case is the one that matters: a 30-day backfill lands
after live trades, and the result must not depend on arrival order.

```ts
import { beforeEach, describe, expect, it } from "vitest";
import { query } from "./db";
import { inventAddress, inventSignature } from "./ids";
import { replayPosition } from "./pnl";
import { addWallet } from "./wallets";

let kolId: string, walletId: string;
const mint = inventAddress();

beforeEach(async () => {
  await query("TRUNCATE kol, kol_wallet, trade, position, pnl_daily CASCADE");
  kolId = crypto.randomUUID();
  await query("INSERT INTO kol (id, slug, display_name, x_handle, status) VALUES ($1,'p','P','p','approved')", [kolId]);
  walletId = await addWallet(kolId, inventAddress());
});

async function trade(side: "buy" | "sell", sol: number, tokens: number, minute: number) {
  await query(
    `INSERT INTO trade (id, signature_hmac, signature_enc, instruction_index, kol_id, wallet_id,
                        mint, side, token_amount, sol_amount, usd_amount, sol_usd, fee_sol, block_time)
     VALUES ($1,$2,$3,0,$4,$5,$6,$7,$8,$9,$10,150,0,$11)`,
    [crypto.randomUUID(), Buffer.from(inventSignature()), Buffer.from("x"), kolId, walletId,
     mint, side, tokens, sol, sol * 150, new Date(Date.UTC(2026, 7, 25, 12, minute))],
  );
}

const position = async () =>
  (await query<{ qty: string; avg_cost_sol: string; realized_sol: string }>(
    "SELECT qty, avg_cost_sol, realized_sol FROM position WHERE kol_id = $1 AND mint = $2",
    [kolId, mint]))[0];

describe("replayPosition", () => {
  it("averages the cost of two buys", async () => {
    await trade("buy", 1, 100, 0);
    await trade("buy", 3, 100, 1);
    await replayPosition(kolId, mint);
    const p = await position();
    expect(Number(p.qty)).toBeCloseTo(200, 9);
    expect(Number(p.avg_cost_sol)).toBeCloseTo(0.02, 9);   // 4 SOL / 200 tokens
    expect(Number(p.realized_sol)).toBeCloseTo(0, 9);
  });

  it("realizes profit only on the quantity actually sold", async () => {
    await trade("buy", 2, 200, 0);      // avg 0.01 SOL per token
    await trade("sell", 1.5, 100, 1);   // sold 100 at 0.015
    await replayPosition(kolId, mint);
    const p = await position();
    expect(Number(p.realized_sol)).toBeCloseTo(0.5, 9);  // 1.5 - 0.01 * 100
    expect(Number(p.qty)).toBeCloseTo(100, 9);
    expect(Number(p.avg_cost_sol)).toBeCloseTo(0.01, 9); // unchanged by the sale
  });

  it("does not let an open position affect realized PnL", async () => {
    await trade("buy", 5, 500, 0);
    await replayPosition(kolId, mint);
    expect(Number((await position()).realized_sol)).toBeCloseTo(0, 9);
  });

  it("produces the same result whatever order the trades were inserted in", async () => {
    await trade("sell", 1.5, 100, 1);
    await trade("buy", 2, 200, 0);      // the earlier trade, inserted second
    await replayPosition(kolId, mint);
    const p = await position();
    expect(Number(p.realized_sol)).toBeCloseTo(0.5, 9);
    expect(Number(p.qty)).toBeCloseTo(100, 9);
  });

  it("is idempotent", async () => {
    await trade("buy", 2, 200, 0);
    await trade("sell", 1.5, 100, 1);
    await replayPosition(kolId, mint);
    await replayPosition(kolId, mint);
    expect(Number((await position()).realized_sol)).toBeCloseTo(0.5, 9);
  });

  it("writes realized PnL into the UTC day of the sell", async () => {
    await trade("buy", 2, 200, 0);
    await trade("sell", 1.5, 100, 1);
    await replayPosition(kolId, mint);
    const [row] = await query<{ day: Date; realized_sol: string; wins: number }>(
      "SELECT day, realized_sol, wins FROM pnl_daily WHERE kol_id = $1", [kolId]);
    expect(row.day.toISOString().slice(0, 10)).toBe("2026-08-25");
    expect(Number(row.realized_sol)).toBeCloseTo(0.5, 9);
  });

  it("counts a win only once the position is closed", async () => {
    await trade("buy", 2, 200, 0);
    await trade("sell", 1.5, 100, 1);          // half out: not yet closed
    await replayPosition(kolId, mint);
    expect((await query<{ wins: number }>("SELECT wins FROM pnl_daily WHERE kol_id=$1",[kolId]))[0].wins).toBe(0);

    await trade("sell", 1.6, 100, 2);          // fully out: a closed win
    await replayPosition(kolId, mint);
    expect((await query<{ wins: number }>("SELECT sum(wins)::int AS wins FROM pnl_daily WHERE kol_id=$1",[kolId]))[0].wins).toBe(1);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run src/lib/pnl.test.ts`
Expected: FAIL — `./pnl` does not exist.

- [ ] **Step 3: Implement**

`src/lib/pnl.ts` replays every trade for one `(kol_id, mint)` ordered by `block_time, id`, applying
spec §4.2:

```
buy:   qty += q;  cost += sol;  avg = cost / qty
sell:  realized += sol - avg * q;  qty -= q;  cost -= avg * q
```

It accumulates realized SOL and USD per UTC day, marks the position closed when cumulative sold
quantity reaches `CLOSED_POSITION_THRESHOLD` (0.95) of cumulative bought quantity — attributing the
win or loss to the day of the closing sell — then rewrites `position` and replaces the affected
`pnl_daily` rows inside one transaction, and clears `dirty`. `recomputeDirty(limit)` selects dirty
positions and calls `replayPosition` for each.

All arithmetic goes through `numeric` in SQL or string-based decimals in JS; never `number` for
money. The test above uses `toBeCloseTo` only because the assertions read the values back as floats.

- [ ] **Step 4: Run the tests and watch them pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "Derive positions and daily realized PnL

Weighted-average cost per (KOL, mint), replayed from the trade log so the
result does not depend on the order trades arrived in. A win is counted
when a position closes, not on every partial sell."
```

---

### Task 11: The feed

The first screen. `npm run dev`, and the seeded KOL's injected swap is on the home page.

**Files:**
- Create: `src/lib/serialize.ts`, `src/app/api/feed/route.ts`, `src/app/page.tsx`,
  `src/app/layout.tsx`, `src/app/globals.css`
- Test: `src/lib/serialize.test.ts`, `src/app/api/feed/route.test.ts`

**Interfaces:**
- Produces: `serializeTrade(row: FeedRow): PublicTrade`,
  `type PublicTrade = { id: string; kol: { slug: string; name: string; cabalTag: string | null;
  avatarUrl: string }; side: "buy" | "sell"; mint: string; symbol: string | null; tokenAmount:
  string; solAmount: string; priceUsd: string | null; blockTime: string; signature: string | null }`

- [ ] **Step 1: Write the failing test**

`src/lib/serialize.test.ts` — the invariant from spec §7 lives here, in one place:

```ts
import { describe, expect, it } from "vitest";
import { inventAddress, inventSignature } from "./ids";
import { serializeTrade } from "./serialize";

const base = {
  id: "t-1", slug: "ejemplo", display_name: "Ejemplo", cabal_tag: "EJE",
  kol_id: "k-1", side: "buy" as const, mint: inventAddress(), symbol: "EJE",
  token_amount: "100", sol_amount: "1.5", price_usd: "0.01",
  block_time: new Date("2026-08-25T12:00:00Z"), signature: inventSignature(),
  hide_wallets: true, address: inventAddress(),
};

describe("serializeTrade", () => {
  it("omits the signature and the address for a KOL that hides its wallets", () => {
    const out = serializeTrade(base);
    expect(out.signature).toBeNull();
    expect(JSON.stringify(out)).not.toContain(base.signature);
    expect(JSON.stringify(out)).not.toContain(base.address);
  });

  it("includes the signature for a KOL that publishes its wallets", () => {
    const out = serializeTrade({ ...base, hide_wallets: false });
    expect(out.signature).toBe(base.signature);
  });

  it("never includes the wallet address, hidden or not", () => {
    expect(JSON.stringify(serializeTrade({ ...base, hide_wallets: false })))
      .not.toContain(base.address);
  });

  it("keys the avatar by KOL id, never by wallet", () => {
    const out = serializeTrade(base);
    expect(out.kol.avatarUrl).toBe("/api/avatar/k-1");
  });

  it("carries the cabal tag", () => {
    expect(serializeTrade(base).kol.cabalTag).toBe("EJE");
  });
});
```

`src/app/api/feed/route.test.ts` covers: newest first, `since` cursor returns only later trades, a
repeated request with `If-None-Match` returns `304`, and a hidden KOL's rows carry no signature.

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run src/lib/serialize.test.ts src/app/api/feed/route.test.ts`
Expected: FAIL — modules do not exist.

- [ ] **Step 3: Implement the serializer, then the route, then the page**

`serialize.ts` is the only module allowed to decide what leaves the server. It takes the joined row
and returns `PublicTrade`; the address is never a field of the output type, and `signature` is
`null` whenever `hide_wallets` is true.

`GET /api/feed?since=<iso>` selects the latest 50 trades joined to `kol`, `cabal` and `token`,
serializes them, and sets an `ETag` from the newest `(block_time, id)`.

`src/app/page.tsx` renders the rows in Spanish, polling every 4 seconds with `If-None-Match`:

```
[avatar] Ejemplo [EJE] compró 1,23 SOL (16,9M) de $EJE a US$0,0000071    hace 4 min
```

Buys green, sells red, `es-ES` number formatting, relative time in Spanish. The timestamp is a link
to Solscan only when `signature` is non-null. The layout carries the typographic wordmark
`kolscanhispano.fun`, one accent colour, dark background — no design pass (spec §11).

- [ ] **Step 4: Run the tests, then look at it**

```bash
npm test
npm run dev
# open http://localhost:3000 — the seeded KOL is there with no trades yet
```

- [ ] **Step 5: Inject a swap through the webhook endpoint and watch it appear**

This is the moment the batch exists for. Helius cannot reach localhost, so we deliver the payload
ourselves — the same shape, the same endpoint, no API key involved:

```bash
npx tsx scripts/inject-swap.mts     # built in this step: seeds if needed, POSTs a SWAP payload
                                    # for the seeded wallet to /api/webhooks/helius, then runs
                                    # parsePending() and recomputeDirty()
```

Reload `http://localhost:3000`: the trade is in the feed, with **"Wallets ocultas"** where an
address would be and no chain link, because the seeded KOL hides its wallets.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "Add the live feed

serialize.ts is the only place that decides what leaves the server, so
the hidden-wallet invariant is one test over one function rather than a
rule every component has to remember."
```

---

### Task 12: The leaderboard

**Files:**
- Create: `src/app/api/leaderboard/route.ts`, `src/app/leaderboard/page.tsx`,
  `src/lib/windows.ts`
- Test: `src/lib/windows.test.ts`, `src/app/api/leaderboard/route.test.ts`

**Interfaces:**
- Produces: `windowBounds(window: "diario" | "semanal" | "mensual", now: Date): { from: Date; to:
  Date }`, `GET /api/leaderboard?window=&unit=`

- [ ] **Step 1: Write the failing test**

`src/lib/windows.test.ts` pins spec §4.9 — calendar-aligned UTC, not rolling:

```ts
import { describe, expect, it } from "vitest";
import { windowBounds } from "./windows";

const now = new Date("2026-08-25T03:30:00Z"); // Tuesday

describe("windowBounds", () => {
  it("daily starts at midnight UTC of the same day", () => {
    expect(windowBounds("diario", now).from.toISOString()).toBe("2026-08-25T00:00:00.000Z");
  });

  it("weekly starts on Monday, ISO week", () => {
    expect(windowBounds("semanal", now).from.toISOString()).toBe("2026-08-24T00:00:00.000Z");
  });

  it("monthly starts on the first of the month", () => {
    expect(windowBounds("mensual", now).from.toISOString()).toBe("2026-08-01T00:00:00.000Z");
  });

  it("does not shift with the machine timezone", () => {
    const before = process.env.TZ;
    process.env.TZ = "America/Argentina/Buenos_Aires";
    expect(windowBounds("diario", now).from.toISOString()).toBe("2026-08-25T00:00:00.000Z");
    process.env.TZ = before;
  });
});
```

`src/app/api/leaderboard/route.test.ts` covers: sums `pnl_daily` inside the window and excludes a
row outside it; orders by realized PnL descending; `unit=usd` and `unit=sol` order independently;
win rate is `wins / (wins + losses)` and reads `0 %` with no closed positions; a `suspended` KOL is
absent even with rows inside the window.

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run src/lib/windows.test.ts src/app/api/leaderboard/route.test.ts`
Expected: FAIL — modules do not exist.

- [ ] **Step 3: Implement**

`windows.ts` computes bounds with `Date.UTC` arithmetic only — never `toLocaleString`, never a
timezone library. The route sums `pnl_daily` between the bounds, grouped by KOL, filtered to
`status = 'approved'`, ordered by the selected unit. The page renders the row from §2 of the spec
with `Diario / Semanal / Mensual` and `SOL / USD` toggles, and the footnote *día UTC*.

- [ ] **Step 4: Run the tests, then look at it**

```bash
npm test
npm run dev
# http://localhost:3000/leaderboard — the seeded KOL with the injected swap's realized PnL
```

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "Add the leaderboard

Windows are calendar-aligned UTC and computed with Date.UTC arithmetic, so
the boundary does not move with the machine's timezone."
```

---

## Batch 1 is done here

At this point, locally: a seeded KOL exists, a swap injected through the real webhook endpoint is
stored encrypted, parsed, and accumulated into a position and a daily realized PnL row, and both the
feed and the leaderboard show it — with the wallet hidden and no chain link, because that is the
default.

Nothing so far has touched Helius over the network. **No API key has been needed.**

---

### Task 13 — STOP: the first task that needs `HELIUS_API_KEY`

**This is where the plan stops and I need the key from you.**

Task 13 is *webhook registration and address-set reconciliation*: build the desired address set from
`kol_wallet` (decrypting one row at a time), hash it, compare against
`setting['helius_webhook_address_hash']`, and call the Helius webhook API only when the hash changed
— plus the self-healing repair from spec §5.5.

What it needs beyond the key:

- **A publicly reachable HTTPS URL.** Helius explicitly cannot deliver to `localhost`, so this task
  needs a deployed preview URL, not a dev server.
- **Credits.** Each create, edit or delete is 100 credits. The task's own tests run against a mocked
  client and cost nothing; only the final smoke test spends.

Most of the task is testable without the key and should be written that way first: the address-set
builder, the hash comparison, the "did the set change" decision, the repair decision (silence *and*
on-chain activity), and the daily repair cap are all pure logic behind a `HeliusClient` interface.
The live call is the last step.

After Task 13 the remaining v1 work is, in order: the swap parser's stablecoin and token↔token
cases; the backfill queue and its cron; gap repair; DexScreener metadata and price state; the token
page; the KOL page with realized and unrealized split; `/registro` with SIWS and the no-transaction
test; the admin with approval, withdraw, suspend, reveal and cabals; the legal pages. Each gets a
plan when the batch before it lands, so the plan reflects what the code actually became.

---

## Self-review

**Spec coverage for batch 1.** §3 schema → Tasks 3, 5. §4.2 weighted average, §4.4 fees, §4.7
realized/unrealized split, §4.8 win rate, §4.9 UTC windows, §4.10 recomputation → Tasks 9, 10, 12.
§5.2 webhook → Task 8. §7 hidden wallets → Task 11 (`serialize.ts`). §8.1 encryption and blind
index → Task 4. §8.3 no addresses in the repo → Task 1. §9 polling and ETag → Task 11. §2 pages →
Tasks 11, 12.

**Deliberately out of batch 1**, each with a task named above: §4.3 non-SOL quotes, §4.5 unknown
basis, §4.6 price states, §5.3–5.6 backfill, reconciliation, repair and budget, §6 registration,
§8.4 admin reveal, §9 admin, §10 legal.

**Consistency.** `blindIndex`, `encrypt`, `decrypt` (Task 4) are used unchanged in Tasks 5 and 8.
`findWalletByAddress` (Task 5) is what Task 9 resolves accounts through. `storeRawTx` (Task 8) is
what `parsePending` (Task 9) reads. `replayPosition` (Task 10) writes the `pnl_daily` rows Task 12
sums. `serializeTrade` (Task 11) is the only exit path for trade data.

**Risk to watch during execution.** The base58 repository scan may flag a legitimate string in a
lockfile or a generated file. The fix is to add the path to `HYGIENE_SKIP` with a comment, never to
loosen the pattern or add an address to `ALLOWED_BASE58`.
