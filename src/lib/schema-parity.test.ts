import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { schemaParity, versionOf } from "./schema-parity";

describe("schemaParity", () => {
  it("passes when the database has every migration in the checkout", () => {
    expect(schemaParity(["001_a.sql", "002_b.sql"], ["001_a", "002_b"])).toEqual({
      ok: true,
      applied: 2,
    });
  });

  it("names what is missing, in the order it would be applied", () => {
    expect(schemaParity(["001_a.sql", "002_b.sql", "003_c.sql"], ["001_a"])).toEqual({
      ok: false,
      missing: ["002_b", "003_c"],
      applied: 1,
    });
  });

  /**
   * A branch that is behind `main` meets a database a newer branch has already
   * migrated. That is every feature branch, not a fault — and a check that
   * failed on it would be one people learn to re-run until it passes.
   */
  it("does not fail on a database that is ahead of this checkout", () => {
    expect(schemaParity(["001_a.sql"], ["001_a", "002_b"])).toEqual({ ok: true, applied: 2 });
  });

  it("reads a filename the way the migration ledger stores it", () => {
    // `scripts/migrate.mts` writes `file.replace(/\.sql$/, "")`. Two spellings
    // of one version would make every comparison here vacuously false.
    expect(versionOf("018_audit_append_only.sql")).toBe("018_audit_append_only");
  });

  it("is asking about this repository's real migrations, not a fixture", () => {
    // If the directory is ever renamed or emptied, the CI check would pass on
    // nothing at all. This is the assertion that an empty list cannot satisfy.
    const files = readdirSync("migrations").filter((f) => f.endsWith(".sql"));
    expect(files.length).toBeGreaterThan(15);
    expect(schemaParity(files, files.map(versionOf))).toEqual({ ok: true, applied: files.length });
  });
});
