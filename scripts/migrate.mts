import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { loadEnvLocal } from "../src/lib/env";

loadEnvLocal();

const isTest = process.argv.includes("--test");
const variable = isTest ? "TEST_DATABASE_URL" : "DATABASE_URL";
const connectionString = process.env[variable]?.trim();

if (!connectionString) {
  // Never interpolate the value into the message: this string reaches logs.
  throw new Error(`${variable} is not set. See .env.example.`);
}

// Log only the ep-... host fragment: enough to confirm the target branch
// without ever printing a connection string.
const hostMatch = connectionString.match(/ep-[a-z0-9-]+/);
console.log(`Applying migrations to ${hostMatch ? hostMatch[0] : "(unknown host)"}`);

const client = new Client({ connectionString });
await client.connect();

try {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  const migrationsDir = join(import.meta.dirname, "..", "migrations");
  const files = readdirSync(migrationsDir)
    .filter((name) => name.endsWith(".sql"))
    .sort();

  const { rows: applied } = await client.query<{ version: string }>(
    "SELECT version FROM schema_migrations"
  );
  const appliedVersions = new Set(applied.map((row) => row.version));

  for (const file of files) {
    const version = file.replace(/\.sql$/, "");
    if (appliedVersions.has(version)) continue;

    const sql = readFileSync(join(migrationsDir, file), "utf8");
    await client.query("BEGIN");
    try {
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (version) VALUES ($1)", [version]);
      await client.query("COMMIT");
      console.log(`Applied ${version}`);
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    }
  }
} finally {
  await client.end();
}
