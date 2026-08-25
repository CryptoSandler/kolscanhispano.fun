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
 * A stable identity for a Postgres connection URL that ignores differences
 * a pooled vs. a direct URL to the *same* branch would otherwise introduce.
 * This is a cheap first line of defense, not a proof: string comparison
 * cannot rule out every way two URLs might name the same database (Neon's
 * endpoint-id query-string routing is one; there may be others). The real
 * backstop is assertTestDatabaseMarker() below, which does not depend on
 * parsing anything. This identity is never logged.
 */
function connectionIdentity(raw: string, variableName: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${variableName} is not a valid connection URL. See .env.example.`);
  }

  const endpointId = extractEndpointId(parsed.searchParams.get("options"));
  const host = endpointId ?? normalizeHost(parsed.hostname);
  const port = parsed.port === "" ? "5432" : parsed.port;
  const database = parsed.pathname.replace(/\/$/, "").toLowerCase();
  const username = parsed.username.toLowerCase();

  return `${username}@${host}:${port}${database}`;
}

// postgres:// is a non-special WHATWG scheme, so `new URL()` does not
// lowercase its host the way it would for http(s). DNS is case-insensitive,
// so two URLs differing only in host casing name the same database and must
// compare equal here. The "-pooler" suffix on the first label is stripped
// so a pooled and a direct URL to the same branch also compare equal.
function normalizeHost(hostname: string): string {
  const lower = hostname.toLowerCase().replace(/\.$/, "");
  const labels = lower.split(".");
  labels[0] = labels[0].replace(/-pooler$/, "");
  return labels.join(".");
}

// Neon's endpoint-id routing (`?options=endpoint=<id>`) lets two entirely
// different hostnames reach the same database. When present, the endpoint
// id is the real identity of the target; the hostname is not.
function extractEndpointId(options: string | null): string | null {
  if (!options) return null;
  const match = options.match(/(?:^|\s)endpoint=([^\s]+)/i);
  return match ? match[1].toLowerCase() : null;
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

/**
 * A sentinel that does not depend on parsing any connection string: a
 * database can only carry this marker if it was migrated with
 * `npm run db:migrate:test`, no matter how TEST_DATABASE_URL happens to be
 * spelled. `runQuery` is injectable so this can be unit-tested against a
 * fake without a second, deliberately unmarked database.
 *
 * Fails closed on any error, including a genuine connectivity problem:
 * rethrowing the original driver error risks leaking a connection-string
 * fragment (a hostname, for example) into the message.
 */
export async function assertTestDatabaseMarker(
  runQuery: (sql: string, params?: unknown[]) => Promise<unknown[]> = query
): Promise<void> {
  try {
    const rows = await runQuery("SELECT stamped_at FROM test_database_marker LIMIT 1");
    if (rows.length === 0) throw new Error("test_database_marker has no row");
  } catch {
    throw new Error(
      "TEST_DATABASE_URL does not point at a stamped test database (test_database_marker is missing). " +
        "Run `npm run db:migrate:test` to stamp one. If this fires unexpectedly, TEST_DATABASE_URL is " +
        "pointing somewhere it should not."
    );
  }
}
