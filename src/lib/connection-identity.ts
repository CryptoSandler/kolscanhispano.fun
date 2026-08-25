/**
 * A stable identity for a Postgres connection URL that ignores differences
 * a pooled vs. a direct URL to the *same* branch would otherwise introduce.
 * This is a cheap first line of defense, not a proof: string comparison
 * cannot rule out every way two URLs might name the same database (Neon's
 * endpoint-id query-string routing is one; there may be others). Shared by
 * db.ts (guards every app connection) and migrate.mts (guards the
 * test_database_marker stamp) so there is exactly one implementation to fix
 * the next time a bypass turns up. Never logged.
 */
export function connectionIdentity(raw: string, variableName: string): string {
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

/**
 * Throws `message` if `testDatabaseUrl` and DATABASE_URL (read from the
 * environment) name the same database, per connectionIdentity() above.
 * Skips the check entirely when DATABASE_URL is unset: nothing to collide
 * with then.
 *
 * Shared so db.ts's own-connection guard and migrate.mts's
 * test_database_marker stamp guard refuse on exactly the same logic instead
 * of drifting apart — a bypass fixed in one would otherwise still be open
 * in the other.
 */
export function assertDistinctFromProduction(testDatabaseUrl: string, message: string): void {
  const productionUrl = process.env.DATABASE_URL?.trim();
  if (!productionUrl) return;

  const testIdentity = connectionIdentity(testDatabaseUrl, "TEST_DATABASE_URL");
  const productionIdentity = connectionIdentity(productionUrl, "DATABASE_URL");
  if (testIdentity === productionIdentity) {
    throw new Error(message);
  }
}
