import { Pool } from "pg";
import { loadEnvLocal } from "./env";

loadEnvLocal();

const isTest = process.env.NODE_ENV === "test" || process.env.VITEST === "true";
const variable = isTest ? "TEST_DATABASE_URL" : "DATABASE_URL";
const connectionString = process.env[variable]?.trim();

if (!connectionString) {
  // Never interpolate the value into the message: this string reaches logs.
  throw new Error(`${variable} is not set. See .env.example.`);
}

/**
 * A stable identity for a Postgres connection URL that ignores the one
 * difference a pooled vs. a direct URL to the *same* branch would otherwise
 * introduce: a "-pooler" suffix on the first hostname label. Host, database,
 * and user together are what actually identify "the same branch" — query
 * parameter differences or a trailing slash must not hide a collision, and
 * must not manufacture one either, so only these three fields are compared.
 * Used solely to detect that TEST_DATABASE_URL and DATABASE_URL name the
 * same database; the identity itself is never logged.
 */
function connectionIdentity(raw: string, variableName: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${variableName} is not a valid connection URL. See .env.example.`);
  }
  const labels = parsed.hostname.split(".");
  labels[0] = labels[0].replace(/-pooler$/, "");
  const host = labels.join(".");
  const path = parsed.pathname.replace(/\/$/, "");
  return `${parsed.username}@${host}${path}`;
}

if (isTest) {
  const productionUrl = process.env.DATABASE_URL?.trim();
  // Nothing to collide with if DATABASE_URL isn't set at all.
  if (productionUrl) {
    const testIdentity = connectionIdentity(connectionString, "TEST_DATABASE_URL");
    const productionIdentity = connectionIdentity(productionUrl, "DATABASE_URL");
    if (testIdentity === productionIdentity) {
      throw new Error("TEST_DATABASE_URL must not be the production database: the suite truncates it.");
    }
  }
}

export const pool = new Pool({ connectionString, max: 1 });

// Neon scales to zero and can drop idle connections; without a handler that
// surfaces as an uncaught exception instead of a recoverable, logged event.
// Never interpolate the connection string here.
pool.on("error", (err) => {
  console.error("Unexpected error on idle database client:", err.message);
});

export async function query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  const result = await pool.query(sql, params);
  return result.rows as T[];
}
