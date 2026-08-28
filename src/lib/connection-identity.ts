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

/**
 * The `ep-…` fragment of a Neon connection string: enough to say which branch
 * a process is about to write to, and nothing else of the secret.
 *
 * This is the one thing in this repo allowed to be derived from a connection
 * string and then *printed*. It exists as a function because it is printed
 * from six cron entry points, `migrate.mts` and `seed-preview.ts`, and a
 * regex copied nine times is a regex that gets loosened in one of them.
 */
export function hostFragment(raw: string): string {
  const match = raw.match(/ep-[a-z0-9-]+/);
  return match ? match[0] : "(unknown host)";
}

/** The `sslmode` values `pg-connection-string` recognises. Anything else is
 * echoed as "an unrecognised sslmode" rather than quoted back, so the error
 * message cannot be made to carry a fragment of the secret. */
const KNOWN_SSLMODES = new Set(["disable", "no-verify", "prefer", "require", "verify-ca", "verify-full"]);

/**
 * Refuses a connection string that does not ask for `sslmode=verify-full`.
 *
 * TLS here is entirely a property of the *text of the secret*: nothing in this
 * repo passes an `ssl` option, so whatever the connection string says is what
 * happens. Measured 2026-08-28 against the installed `pg` 8.23.0 /
 * `pg-connection-string` 2.14.0:
 *
 *     (no sslmode)          ssl: undefined              -- no TLS at all
 *     sslmode=disable       ssl: false                  -- no TLS at all
 *     sslmode=no-verify     rejectUnauthorized: false   -- TLS, no verification
 *     sslmode=require       ssl: {}  + a deprecation warning
 *     sslmode=verify-full   ssl: {}
 *
 * So today `require` is silently *upgraded* to full verification — and the
 * warning that comes with it says that in `pg-connection-string` v3 / `pg` v9
 * it adopts libpq semantics instead, which do not verify the certificate. A
 * connection string that says `require` is therefore one dependency bump away
 * from an unverified TLS session, with nothing in the diff to show for it.
 * `verify-full` is the only spelling that means the same thing before and
 * after, and `.env.example` has always documented it.
 *
 * The message names the `ep-…` host and the mode, never the string.
 */
export function assertVerifyFull(raw: string, variableName: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${variableName} is not a valid connection URL. See .env.example.`);
  }
  const sslmode = url.searchParams.get("sslmode");
  if (sslmode === "verify-full") return raw;

  // **Absent is corrected, not refused.** An earlier version threw here, and
  // that made a missing `sslmode` a boot failure: `resolveConnectionString`
  // runs at module load, so the first request after a deploy would have thrown
  // rather than served. Verified 2026-08-28 that this was not a hypothetical —
  // `vercel env pull` returns sensitive values **empty** for this project, so
  // production's spelling could not be read from a developer machine at all,
  // and shipping a throw would have been shipping an outage nobody could rule
  // out beforehand.
  //
  // Appending the mode reaches the same end state the throw was protecting:
  // the connection is verified either way. What it does not do is make the
  // deploy depend on a value nobody can inspect.
  if (sslmode === null) {
    url.searchParams.set("sslmode", "verify-full");
    return url.toString();
  }

  // A *wrong* mode is different in kind: somebody wrote `require` or `disable`
  // on purpose, and silently overriding a deliberate choice would hide a
  // decision rather than correct an omission. That still throws.
  const found = KNOWN_SSLMODES.has(sslmode) ? `sslmode=${sslmode}` : "an unrecognised sslmode";
  throw new Error(
    `${variableName} must carry sslmode=verify-full; it has ${found} (target ${hostFragment(raw)}). ` +
      "Nothing in this repo passes an ssl option, so the connection string is the only thing that " +
      "decides whether the connection is encrypted and verified. See .env.example."
  );
}
