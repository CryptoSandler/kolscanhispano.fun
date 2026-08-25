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
