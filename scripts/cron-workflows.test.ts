/**
 * Static checks on the two cron workflow files. This project has no
 * committed YAML-parsing dependency (js-yaml is only ever a transitive one,
 * present today but not something this repo declares -- see package.json),
 * so these checks read the files as text rather than adding one just for a
 * handful of assertions. `actionlint` (see task-2-report.md) is the real
 * syntax check; what this test defends is content actionlint has no opinion
 * on -- the missing-secret guard's completeness, in particular, which is
 * exactly the property Task 2 asks to be able to break on purpose and watch
 * a test die.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const REQUIRED_SECRETS = ["DATABASE_URL", "WALLET_ENC_KEY", "WALLET_HMAC_KEY"];

const WORKFLOWS = [
  { path: ".github/workflows/parse-pending.yml", cron: "*/5 * * * *", group: "parse-pending", script: "scripts/parse-pending.ts" },
  { path: ".github/workflows/recompute-dirty.yml", cron: "*/15 * * * *", group: "recompute-dirty", script: "scripts/recompute-dirty.ts" },
] as const;

describe.each(WORKFLOWS)("$path", ({ path, cron, group, script }) => {
  const text = readFileSync(path, "utf8");

  it("schedules the requested cron and also allows workflow_dispatch", () => {
    expect(text).toMatch(new RegExp(`cron:\\s*["']${cron.replace(/\*/g, "\\*")}["']`));
    expect(text).toMatch(/^\s*workflow_dispatch:/m);
  });

  it("serializes overlapping runs instead of racing them", () => {
    expect(text).toMatch(new RegExp(`group:\\s*${group}\\b`));
    expect(text).toMatch(/cancel-in-progress:\s*false/);
  });

  it("checks out the repo, installs with npm ci, and runs its script", () => {
    expect(text).toMatch(/uses:\s*actions\/checkout@/);
    expect(text).toContain("npm ci");
    expect(text).toContain(`npx tsx ${script}`);
  });

  it("hands the job a read-only GITHUB_TOKEN", () => {
    // Declared at workflow level, so it applies to every job and every step
    // rather than to whichever one someone remembered. Without it the token
    // is whatever the repository default grants -- write-scoped on a public
    // repo by default -- handed to a job that only checks out code and talks
    // to Neon. Nothing here uses the token for anything at all; `contents:
    // read` is what actions/checkout needs and not one scope more.
    expect(text).toMatch(/^permissions:\s*\n\s+contents:\s*read\s*$/m);
  });

  it("wires all three required secrets into the job env", () => {
    for (const name of REQUIRED_SECRETS) {
      expect(text).toMatch(new RegExp(`${name}:\\s*\\$\\{\\{\\s*secrets\\.${name}\\s*\\}\\}`));
    }
  });

  it("fails loudly, naming the secret and where to add it, when any one of them is missing", () => {
    // The property under test: for *every* required secret, there is a
    // check that (a) tests it for emptiness, (b) names it in an ::error::
    // line so it shows up annotated in the Actions UI, and (c) actually
    // stops the job (`exit 1`) rather than limping on with an empty value.
    // Dropping any one secret's check -- the mutation Task 2 asks for --
    // makes exactly one of these iterations fail.
    for (const name of REQUIRED_SECRETS) {
      const guard = new RegExp(
        `if \\[ -z "\\$\\{${name}\\}" \\]; then\\s*\\n\\s*echo "::error::${name} is not set\\..*Settings -> Secrets`,
      );
      expect(text, `missing-secret guard for ${name}`).toMatch(guard);
    }
    // "exit 1" must appear at least once per secret guard; counting overall
    // occurrences is a cheap proxy that still catches a guard that checks
    // and prints but forgets to stop the job.
    const exitCount = (text.match(/exit 1/g) ?? []).length;
    expect(exitCount).toBeGreaterThanOrEqual(REQUIRED_SECRETS.length);
  });

  it("never writes a literal secret value -- only the ${{ secrets.* }} reference", () => {
    // A whole-file scan rather than a line-by-line one: this is the last
    // line of defense against someone pasting a real key into the workflow
    // while editing it by hand.
    expect(text).not.toMatch(/DATABASE_URL\s*[:=]\s*["']?postgres(ql)?:\/\//i);
    expect(text).not.toMatch(/WALLET_(ENC|HMAC)_KEY\s*[:=]\s*["']?[A-Za-z0-9+/]{20,}={0,2}["']?\s*$/m);
  });
});

/**
 * The parse workflow gained a second step in Task 5: the backfill, which is
 * the only thing that writes `sol_price` and therefore the only reason a new
 * trade carries a USD amount at all. The order is the property — a rate
 * written before the parse would be one cycle stale by the time the trades
 * exist, and nothing ever revisits a parsed `raw_tx` row.
 */
describe(".github/workflows/parse-pending.yml: pricing step", () => {
  const text = readFileSync(".github/workflows/parse-pending.yml", "utf8");

  it("runs the backfill in the same workflow, after the parse", () => {
    const parseAt = text.indexOf("npx tsx scripts/parse-pending.ts");
    const backfillAt = text.indexOf("npx tsx scripts/backfill-prices.ts");
    expect(parseAt).toBeGreaterThan(-1);
    expect(backfillAt).toBeGreaterThan(-1);
    expect(backfillAt).toBeGreaterThan(parseAt);
  });

  it("gives the backfill step the secrets it needs to connect and to load wallets.ts", () => {
    // Everything from the backfill step's own `env:` block to the end of the
    // file, so a secret declared only on the *parse* step cannot satisfy this.
    const step = text.slice(text.indexOf("Price the trades it wrote"));
    for (const name of REQUIRED_SECRETS) {
      expect(step, `${name} on the pricing step`).toMatch(
        new RegExp(`${name}:\\s*\\$\\{\\{\\s*secrets\\.${name}\\s*\\}\\}`),
      );
    }
  });
});

/**
 * The recompute workflow gained a second step in Task 9: the rate_limit
 * prune. Which workflow it is in and where in it are both properties, not
 * arrangement. It is not in parse-pending.yml because parsing is the
 * ingestion critical path, and it is after the recompute rather than before
 * because a step that fails stops the ones behind it -- a prune that cannot
 * delete week-old counters must not be able to stop a recompute.
 */
describe(".github/workflows/recompute-dirty.yml: prune step", () => {
  const text = readFileSync(".github/workflows/recompute-dirty.yml", "utf8");
  const parseText = readFileSync(".github/workflows/parse-pending.yml", "utf8");

  it("runs the prune in the same workflow, after the recompute", () => {
    const recomputeAt = text.indexOf("npx tsx scripts/recompute-dirty.ts");
    const pruneAt = text.indexOf("npx tsx scripts/prune-rate-limit.ts");
    expect(recomputeAt).toBeGreaterThan(-1);
    expect(pruneAt).toBeGreaterThan(-1);
    expect(pruneAt).toBeGreaterThan(recomputeAt);
  });

  it("keeps the prune off the ingestion critical path", () => {
    expect(parseText).not.toContain("prune-rate-limit");
  });

  it("gives the prune step the one secret it needs, and no key it cannot use", () => {
    // Everything from the prune step's own `env:` block to the end of the
    // file, so a secret declared only on the *recompute* step cannot satisfy
    // this -- nor be mistaken for one this step was granted.
    const step = text.slice(text.indexOf("Prune expired rate_limit rows"));
    expect(step).toMatch(/DATABASE_URL:\s*\$\{\{\s*secrets\.DATABASE_URL\s*\}\}/);
    expect(step).not.toContain("WALLET_ENC_KEY");
    expect(step).not.toContain("WALLET_HMAC_KEY");
  });
});
