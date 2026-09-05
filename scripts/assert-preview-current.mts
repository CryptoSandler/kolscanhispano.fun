import { readdirSync } from "node:fs";
import { Pool } from "pg";
import { schemaParity } from "../src/lib/schema-parity";

/**
 * Fails the build if the `preview` database is behind this checkout.
 *
 * **The case this closes is 2026-08-27**, recorded in `CLAUDE.md`: `preview` was
 * five migrations behind and every Preview deployment would have met a schema it
 * did not have. The suite was green throughout, and correctly so — it runs
 * against `tests` and never opened the other database.
 *
 * `scripts/schema-versions.mts` already answers this question for all three
 * databases, but it is a **manual** step in `/cierre`, which is exactly the kind
 * of step a batch forgets at the end of a long change. This one runs in CI, asks
 * about one database, and costs one query.
 *
 * **It does not run the suite against preview**, on purpose. The suite truncates
 * tables; preview is what the owner's visual gate reads. The only thing this
 * needs to know is which versions the ledger has.
 *
 * ## Not being able to ask is a failure
 *
 * An unset variable, a refused connection and a missing `schema_migrations` all
 * exit non-zero. `~/.claude/GATES.md`: *not being able to prove nothing changed
 * never resolves to skipping* — "could not connect" and "up to date" must never
 * look the same, which is the same rule `schema-versions.mts` states as UNKNOWN.
 *
 * Nothing here prints the connection string, a host or an error object: a
 * refused connection carries the URL it was refused for.
 */
async function main(): Promise<number> {
  const url = process.env.PREVIEW_DATABASE_URL;
  if (!url) {
    console.error(
      "::error::PREVIEW_DATABASE_URL is not set. Add it under Settings -> Secrets and " +
        "variables -> Actions -> Repository secrets.",
    );
    return 1;
  }

  const files = readdirSync("migrations")
    .filter((file) => file.endsWith(".sql"))
    .sort();
  if (files.length === 0) {
    // An empty glob would otherwise make every comparison below vacuously true.
    console.error("::error::No migrations found. Is this running from the repository root?");
    return 1;
  }

  const pool = new Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 15_000 });
  try {
    const { rows } = await pool.query<{ version: string }>(
      "SELECT version FROM schema_migrations",
    );
    const parity = schemaParity(
      files,
      rows.map((row) => row.version),
    );
    if (parity.ok) {
      console.log(`preview is current: ${files.length} in the checkout, ${parity.applied} applied`);
      return 0;
    }
    console.error(
      `::error::preview is behind this checkout by ${parity.missing.length}: ` +
        `${parity.missing.join(", ")}. Run 'npm run db:migrate:preview' before deploying.`,
    );
    return 1;
  } catch {
    // The fact, never the error: it can carry the connection string.
    console.error(
      "::error::Could not read schema_migrations on preview. This fails the build rather " +
        "than passing: an unreadable database is not a current one.",
    );
    return 1;
  } finally {
    await pool.end();
  }
}

process.exit(await main());
