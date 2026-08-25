import { afterEach, describe, expect, it, vi } from "vitest";
import { query } from "./db";

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
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // Fresh module instance per case, under invented (never real) connection
  // strings, so a regression in the guard itself is what gets exercised —
  // not a copy of the same comparison the guard already makes.
  async function importDbWith(databaseUrl: string, testDatabaseUrl: string) {
    vi.stubEnv("DATABASE_URL", databaseUrl);
    vi.stubEnv("TEST_DATABASE_URL", testDatabaseUrl);
    vi.resetModules();
    return import("./db");
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

  it("does not throw for genuinely different databases", async () => {
    const production = "postgres://app:secret@ep-invented-branch.us-east-2.aws.neon.tech/neondb?sslmode=verify-full";
    const test =
      "postgres://app:secret@ep-another-invented-branch.us-east-2.aws.neon.tech/neondb_test?sslmode=verify-full";
    await expect(importDbWith(production, test)).resolves.toBeDefined();
  });
});
