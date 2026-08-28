import { afterEach, describe, expect, it, vi } from "vitest";
import { assertDistinctFromProduction, assertVerifyFull, hostFragment } from "./connection-identity";

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


/**
 * F1. TLS to Neon is entirely a property of the text of the secret — nothing
 * in this repo passes an `ssl` option — so an operator who pastes a
 * connection string without `sslmode=verify-full` gets a connection that is
 * either unencrypted or unverified, and nothing says so.
 *
 * The modes below are not guesses: they are what `pg-connection-string`
 * 2.14.0 was measured to produce (see the function's docstring). `require` is
 * refused even though *today* it happens to be treated as an alias for
 * `verify-full`, because the deprecation warning that comes with it says that
 * stops being true in the next major of `pg`.
 */
describe("assertVerifyFull", () => {
  const url = (query: string) =>
    `postgres://app:secret@ep-invented-branch.us-east-2.aws.neon.tech/neondb${query}`;

  it("accepts sslmode=verify-full", () => {
    expect(() => assertVerifyFull(url("?sslmode=verify-full"), "DATABASE_URL")).not.toThrow();
  });

  it("accepts it alongside the other parameters Neon adds", () => {
    expect(() =>
      assertVerifyFull(url("?sslmode=verify-full&channel_binding=require"), "DATABASE_URL"),
    ).not.toThrow();
  });

  it.each(["", "?sslmode=require", "?sslmode=prefer", "?sslmode=verify-ca", "?sslmode=no-verify", "?sslmode=disable", "?sslmode=nonsense"])(
    "refuses %s",
    (query) => {
      expect(() => assertVerifyFull(url(query), "DATABASE_URL")).toThrow(/verify-full/);
    },
  );

  it("refuses a string that is not a URL at all", () => {
    expect(() => assertVerifyFull("not a url", "DATABASE_URL")).toThrow(/DATABASE_URL/);
  });

  // The message reaches logs. It may name the variable, the mode and the
  // `ep-…` host — the repo's convention for saying which branch is meant —
  // and nothing else of the secret.
  it("names the variable, the mode and the ep- host, and never the credentials", () => {
    let caught: unknown;
    try {
      assertVerifyFull(url("?sslmode=require"), "DATABASE_URL");
    } catch (err) {
      caught = err;
    }
    const message = (caught as Error).message;
    expect(message).toContain("DATABASE_URL");
    expect(message).toContain("sslmode=require");
    expect(message).toContain("ep-invented-branch");
    expect(message).not.toContain("secret");
    expect(message).not.toContain("app:");
    expect(message).not.toContain("neondb");
  });

  // An unrecognised mode is described, not quoted: the value comes out of the
  // secret, and quoting it back would put a caller-chosen fragment of that
  // secret into a log line.
  it("describes an unrecognised mode instead of echoing it", () => {
    let caught: unknown;
    try {
      assertVerifyFull(url("?sslmode=hunter2"), "DATABASE_URL");
    } catch (err) {
      caught = err;
    }
    expect((caught as Error).message).toContain("an unrecognised sslmode");
    expect((caught as Error).message).not.toContain("hunter2");
  });
});

describe("hostFragment", () => {
  it("returns the ep- fragment and nothing else of the string", () => {
    const url = "postgres://app:secret@ep-invented-branch-pooler.us-east-2.aws.neon.tech/neondb?sslmode=verify-full";
    expect(hostFragment(url)).toBe("ep-invented-branch-pooler");
  });

  it("says so rather than guessing when there is no ep- host", () => {
    expect(hostFragment("postgres://app:secret@localhost:5432/neondb")).toBe("(unknown host)");
  });
});
