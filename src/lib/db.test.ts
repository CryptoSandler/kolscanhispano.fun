import type { Pool } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertTestDatabaseMarker, query } from "./db";

describe("db", () => {
  it("connects to the test database and runs a query", async () => {
    const rows = await query<{ one: number }>("SELECT 1::int AS one");
    expect(rows[0].one).toBe(1);
  });

  it("uses a verified TLS connection", () => {
    expect(process.env.TEST_DATABASE_URL).toContain("sslmode=verify-full");
  });

  it("has applied the bootstrap migration", async () => {
    const rows = await query<{ version: string }>("SELECT version FROM schema_migrations");
    expect(rows.map((r) => r.version)).toContain("000_bootstrap");
  });
});

describe("db production guard", () => {
  // Fresh module instance per case, under invented (never real) connection
  // strings, so a regression in the guard itself is what gets exercised —
  // not a copy of the same comparison the guard already makes.
  const pools: Pool[] = [];

  afterEach(async () => {
    vi.unstubAllEnvs();
    // These hosts are invented, so no socket was ever opened, but close the
    // pool objects anyway rather than leaving them dangling.
    await Promise.all(pools.splice(0).map((pool) => pool.end()));
  });

  async function importDbWith(databaseUrl: string, testDatabaseUrl: string) {
    vi.stubEnv("DATABASE_URL", databaseUrl);
    vi.stubEnv("TEST_DATABASE_URL", testDatabaseUrl);
    vi.resetModules();
    const mod = await import("./db");
    pools.push(mod.pool);
    return mod;
  }

  it("throws when the two URLs are literally identical", async () => {
    const url = "postgres://app:secret@ep-invented-branch.us-east-2.aws.neon.tech/neondb?sslmode=verify-full";
    await expect(importDbWith(url, url)).rejects.toThrow(/production database/);
  });

  it("throws for a pooled vs. direct connection to the same branch", async () => {
    const direct = "postgres://app:secret@ep-invented-branch.us-east-2.aws.neon.tech/neondb?sslmode=verify-full";
    const pooled =
      "postgres://app:secret@ep-invented-branch-pooler.us-east-2.aws.neon.tech/neondb?sslmode=verify-full";
    await expect(importDbWith(direct, pooled)).rejects.toThrow(/production database/);
  });

  it("throws when the two URLs differ only in hostname casing", async () => {
    // postgres:// is a non-special WHATWG scheme, so `new URL()` does not
    // lowercase the host; DNS is case-insensitive, so this pair reaches the
    // same database and must be caught.
    const lower = "postgres://app:secret@ep-invented-branch.us-east-2.aws.neon.tech/neondb?sslmode=verify-full";
    const upper = "postgres://app:secret@EP-INVENTED-BRANCH.us-east-2.aws.neon.tech/neondb?sslmode=verify-full";
    await expect(importDbWith(lower, upper)).rejects.toThrow(/production database/);
  });

  it("does not throw for genuinely different databases", async () => {
    const production = "postgres://app:secret@ep-invented-branch.us-east-2.aws.neon.tech/neondb?sslmode=verify-full";
    const test =
      "postgres://app:secret@ep-another-invented-branch.us-east-2.aws.neon.tech/neondb_test?sslmode=verify-full";
    await expect(importDbWith(production, test)).resolves.toBeDefined();
  });
});

describe("assertTestDatabaseMarker", () => {
  // Dependency-injected fake query, so these cases don't need a second,
  // deliberately unmarked database to prove the sentinel actually gates.
  it("throws when the marker table does not exist", async () => {
    const missingTable = async () => {
      throw new Error('relation "test_database_marker" does not exist');
    };
    await expect(assertTestDatabaseMarker(missingTable)).rejects.toThrow(/stamped test database/);
  });

  it("throws when the marker query returns no rows", async () => {
    const emptyResult = async () => [];
    await expect(assertTestDatabaseMarker(emptyResult)).rejects.toThrow(/stamped test database/);
  });

  it("does not throw when the marker row is present", async () => {
    const stamped = async () => [{ stamped_at: new Date().toISOString() }];
    await expect(assertTestDatabaseMarker(stamped)).resolves.toBeUndefined();
  });

  it("never includes a connection-string fragment in its message", async () => {
    const failsWithHostname = async () => {
      throw new Error("getaddrinfo ENOTFOUND ep-invented-branch.us-east-2.aws.neon.tech");
    };
    let caught: unknown;
    try {
      await assertTestDatabaseMarker(failsWithHostname);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).not.toContain("neon.tech");
  });
});
