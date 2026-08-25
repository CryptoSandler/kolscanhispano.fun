import { afterEach, describe, expect, it, vi } from "vitest";
import { assertDistinctFromProduction } from "./connection-identity";

// This is the guard migrate.mts calls before stamping test_database_marker.
// Exercised directly (no shelling out to the migration script) with the
// same three collision shapes the db.ts guard tests already cover, plus the
// two cases where refusal must NOT happen.
describe("assertDistinctFromProduction (migrate.mts stamp guard)", () => {
  const STAMP_MESSAGE =
    "Refusing to stamp test_database_marker: TEST_DATABASE_URL and DATABASE_URL name the same database.";

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("refuses to stamp when the two URLs are literally identical", () => {
    const url = "postgres://app:secret@ep-invented-branch.us-east-2.aws.neon.tech/neondb?sslmode=verify-full";
    vi.stubEnv("DATABASE_URL", url);
    expect(() => assertDistinctFromProduction(url, STAMP_MESSAGE)).toThrow(STAMP_MESSAGE);
  });

  it("refuses to stamp for a pooled vs. direct connection to the same branch", () => {
    const direct = "postgres://app:secret@ep-invented-branch.us-east-2.aws.neon.tech/neondb?sslmode=verify-full";
    const pooled =
      "postgres://app:secret@ep-invented-branch-pooler.us-east-2.aws.neon.tech/neondb?sslmode=verify-full";
    vi.stubEnv("DATABASE_URL", direct);
    expect(() => assertDistinctFromProduction(pooled, STAMP_MESSAGE)).toThrow(STAMP_MESSAGE);
  });

  it("refuses to stamp when the two URLs differ only in hostname casing", () => {
    const lower = "postgres://app:secret@ep-invented-branch.us-east-2.aws.neon.tech/neondb?sslmode=verify-full";
    const upper = "postgres://app:secret@EP-INVENTED-BRANCH.us-east-2.aws.neon.tech/neondb?sslmode=verify-full";
    vi.stubEnv("DATABASE_URL", lower);
    expect(() => assertDistinctFromProduction(upper, STAMP_MESSAGE)).toThrow(STAMP_MESSAGE);
  });

  it("does not refuse for genuinely different databases", () => {
    const production = "postgres://app:secret@ep-invented-branch.us-east-2.aws.neon.tech/neondb?sslmode=verify-full";
    const test =
      "postgres://app:secret@ep-another-invented-branch.us-east-2.aws.neon.tech/neondb_test?sslmode=verify-full";
    vi.stubEnv("DATABASE_URL", production);
    expect(() => assertDistinctFromProduction(test, STAMP_MESSAGE)).not.toThrow();
  });

  it("does not refuse when DATABASE_URL is unset: nothing to collide with", () => {
    vi.stubEnv("DATABASE_URL", "");
    const test = "postgres://app:secret@ep-invented-branch.us-east-2.aws.neon.tech/neondb?sslmode=verify-full";
    expect(() => assertDistinctFromProduction(test, STAMP_MESSAGE)).not.toThrow();
  });

  it("never includes a connection-string fragment in the refusal message", () => {
    const url = "postgres://app:secret@ep-invented-branch.us-east-2.aws.neon.tech/neondb?sslmode=verify-full";
    vi.stubEnv("DATABASE_URL", url);
    let caught: unknown;
    try {
      assertDistinctFromProduction(url, STAMP_MESSAGE);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).not.toContain(url);
    expect((caught as Error).message).not.toContain("ep-invented-branch");
  });
});
