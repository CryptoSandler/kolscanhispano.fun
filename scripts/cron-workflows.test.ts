/**
 * Static checks on the cron plumbing: the two workflow files, and the entry
 * points they run. This project has no
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

/**
 * **Each workflow declares the secrets it actually needs**, and that list is
 * what the two cases below are run over.
 *
 * It used to be one shared `REQUIRED_SECRETS` for every file, which was true
 * while every cron replayed trades. `fetch-fx.yml` reads one public URL and
 * writes one `setting` row: its import graph has no `wallets.ts` on it, so
 * handing it either `WALLET_*` key would widen what a compromised step could
 * exfiltrate in exchange for nothing — the same argument the metadata step and
 * the prune step already make inside the other two files, and the same one
 * `.github/workflows/fetch-fx.yml` states in its own comment.
 *
 * The looser reading — "every workflow declares all three" — would have been
 * satisfied by handing this job two keys it cannot use, which is the outcome
 * this guardian exists to prevent rather than to require.
 */
const WORKFLOWS = [
  { path: ".github/workflows/parse-pending.yml", cron: "*/5 * * * *", group: "parse-pending", script: "scripts/parse-pending.ts", secrets: REQUIRED_SECRETS },
  { path: ".github/workflows/recompute-dirty.yml", cron: "*/15 * * * *", group: "recompute-dirty", script: "scripts/recompute-dirty.ts", secrets: REQUIRED_SECRETS },
  { path: ".github/workflows/fetch-fx.yml", cron: "0 */3 * * *", group: "fetch-fx", script: "scripts/fetch-fx.ts", secrets: ["DATABASE_URL"] },
] as const;

describe.each(WORKFLOWS)("$path", ({ path, cron, group, script, secrets }) => {
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

  it("pins every action to a commit, with the tag beside it", () => {
    // F3. A tag is a movable ref: `v4` is whatever the action's owner -- or
    // whoever takes that account -- last pointed it at, and this job holds
    // DATABASE_URL and both WALLET_* keys. The trailing comment is what keeps
    // the pin readable; the assertion requires both halves, so a pin without a
    // version comment (unreviewable) and a version without a pin (unpinned)
    // both fail.
    const uses = text.match(/^[ \t]*uses:[ \t]*.+$/gm) ?? [];
    expect(uses.length).toBeGreaterThan(0);
    for (const line of uses) {
      expect(line, `unpinned action: ${line.trim()}`).toMatch(/@[0-9a-f]{40}\s*#\s*v\d/);
    }
  });

  it("does not leave GITHUB_TOKEN in .git/config for the steps that follow", () => {
    // F5. actions/checkout writes the token into the local git config by
    // default, where every later step in the job can read it. Nothing here
    // pushes.
    expect(text).toMatch(/persist-credentials:\s*false/);
  });

  it("installs without running dependency lifecycle scripts", () => {
    // F4. An install script runs in this job, with this job's environment,
    // ahead of every step that was reasoned about -- and the steps below hand
    // the job DATABASE_URL and both WALLET_* keys. Asserted on the `run:` line
    // rather than by a substring search, so `npm ci` reappearing anywhere else
    // in the file cannot satisfy it.
    expect(text).toMatch(/^\s*run:\s*npm ci --ignore-scripts\s*$/m);
    expect(text).not.toMatch(/^\s*run:\s*npm ci\s*$/m);
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

  it("wires every secret it declares into the job env", () => {
    for (const name of secrets) {
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
    for (const name of secrets) {
      const guard = new RegExp(
        `if \\[ -z "\\$\\{${name}\\}" \\]; then\\s*\\n\\s*echo "::error::${name} is not set\\..*Settings -> Secrets`,
      );
      expect(text, `missing-secret guard for ${name}`).toMatch(guard);
    }
    // "exit 1" must appear at least once per secret guard; counting overall
    // occurrences is a cheap proxy that still catches a guard that checks
    // and prints but forgets to stop the job.
    const exitCount = (text.match(/exit 1/g) ?? []).length;
    expect(exitCount).toBeGreaterThanOrEqual(secrets.length);
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
 * The peso rate's workflow, and the two properties that are decisions rather
 * than arrangement.
 *
 * It is a separate file on purpose — `CLAUDE.md`'s rule about the five-step
 * parse workflow, answered in that file's own header — and it holds one secret
 * on purpose. Both are asserted here so that folding it back into
 * `parse-pending.yml`, or handing it the wallet keys "for consistency", fails
 * rather than passes review.
 */
describe(".github/workflows/fetch-fx.yml", () => {
  const text = readFileSync(".github/workflows/fetch-fx.yml", "utf8");

  it("is not a step of the parse workflow", () => {
    const parse = readFileSync(".github/workflows/parse-pending.yml", "utf8");
    expect(parse).not.toContain("fetch-fx.ts");
  });

  it("holds no key its script cannot use", () => {
    expect(text).toMatch(/DATABASE_URL:\s*\$\{\{\s*secrets\.DATABASE_URL\s*\}\}/);
    expect(text).not.toContain("WALLET_ENC_KEY");
    expect(text).not.toContain("WALLET_HMAC_KEY");
    expect(text).not.toContain("HELIUS_API_KEY");
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
 * The parse workflow gained a third step when Task 3's metadata layer was
 * wired up: `scripts/refresh-token-metadata.ts`, the only production caller of
 * `tokenMetadata` and therefore the only reason a feed row carries a symbol.
 *
 * Two properties, both of them decisions rather than arrangement:
 *
 * - It runs *after* the parse (and after the backfill). A step that fails
 *   stops the ones behind it, and a metadata refresh that cannot reach
 *   DexScreener must not stand between a webhook and a trade.
 * - Its HELIUS_API_KEY guard is a `::warning::` and **not** an `::error::`
 *   with `exit 1`, unlike every other secret in this repo. Without the key
 *   the step still resolves every mint DexScreener knows; only the DAS
 *   fallback for the ones it does not is lost. Failing the step over an
 *   optional fallback would turn a partial answer into no answer.
 */
describe(".github/workflows/parse-pending.yml: token metadata step", () => {
  const text = readFileSync(".github/workflows/parse-pending.yml", "utf8");
  const step = text.slice(text.indexOf("Refresh token metadata"));

  it("runs the refresh in the same workflow, after the parse and after the backfill", () => {
    const parseAt = text.indexOf("npx tsx scripts/parse-pending.ts");
    const backfillAt = text.indexOf("npx tsx scripts/backfill-prices.ts");
    const refreshAt = text.indexOf("npx tsx scripts/refresh-token-metadata.ts");
    expect(refreshAt).toBeGreaterThan(-1);
    expect(refreshAt).toBeGreaterThan(parseAt);
    expect(refreshAt).toBeGreaterThan(backfillAt);
  });

  it("gives the step the one secret it needs, and no key it cannot use", () => {
    // Everything from this step's own `env:` block to the end of the file, so
    // a secret declared only on an earlier step cannot satisfy this -- nor be
    // mistaken for one this step was granted. The script's import graph has
    // no wallets.ts on it, so neither WALLET_* key is readable by anything it
    // runs, and handing it one would only widen what a compromised step could
    // exfiltrate.
    expect(step).toMatch(/DATABASE_URL:\s*\$\{\{\s*secrets\.DATABASE_URL\s*\}\}/);
    expect(step).not.toContain("WALLET_ENC_KEY");
    expect(step).not.toContain("WALLET_HMAC_KEY");
  });

  it("passes HELIUS_API_KEY, so the DAS fallback is not dead code in CI", () => {
    // The gap this closes: `heliusAssetMetadata` returns null with no key, and
    // before this step no workflow in the repo passed one at all -- so the
    // fallback that catches a mint DexScreener has never heard of could not
    // fire anywhere but a developer's machine.
    expect(step).toMatch(/HELIUS_API_KEY:\s*\$\{\{\s*secrets\.HELIUS_API_KEY\s*\}\}/);
  });

  it("degrades on a missing HELIUS_API_KEY instead of failing, and says what is lost", () => {
    // The distinction under test. Deleting the guard, or promoting it to an
    // ::error:: with an exit, breaks exactly one of these.
    expect(step).toMatch(/if \[ -z "\$\{HELIUS_API_KEY\}" \]; then\s*\n\s*echo "::warning::HELIUS_API_KEY is not set/);
    // It names what is degraded rather than only what is absent, so the
    // person reading the annotation knows whether to act.
    const warning = step.slice(step.indexOf("::warning::HELIUS_API_KEY"));
    expect(warning).toContain("fallback");
    expect(warning).toContain("symbol = NULL");
    expect(warning).toContain("Settings -> Secrets");
    // And it must not stop the job: no `exit` anywhere in this step's script.
    expect(step.slice(step.indexOf("run: |"))).not.toMatch(/\bexit\s+1\b/);
  });

  it("never turns HELIUS_API_KEY into a required secret elsewhere in the file", () => {
    // The three genuinely required secrets keep their ::error:: guards; the
    // optional one must not acquire one by someone pattern-matching on the
    // others.
    expect(text).not.toContain("::error::HELIUS_API_KEY");
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

/**
 * The parse workflow gained a step in FRONT of the parse in R1: the per-minute
 * `sol_price` fill. Both its position and its `continue-on-error` are
 * decisions, and both are the kind that a later edit would undo without
 * noticing.
 *
 * - It runs **before** `parse-pending.ts`. `parsePending` refuses a
 *   stablecoin-quoted swap whose block minute has no `sol_price` row and
 *   writes `parse_error`, which takes the row out of the pending query
 *   (`parsed_at IS NULL AND parse_error IS NULL`); nothing in this repository
 *   clears that column, so the refusal is permanent in practice. A fill moved
 *   after the parse would write the minute the parse had just declined.
 * - It is the one step in this repo allowed to fail without stopping the job.
 *   Everything else in these workflows is ordered so that a failing step
 *   cannot stand between a webhook and a trade; this step is deliberately in
 *   front of the parse, so it needs `continue-on-error` to keep that rule
 *   true. Deleting it would let a Binance outage stop ingestion.
 */
describe(".github/workflows/parse-pending.yml: sol_price fill step", () => {
  const text = readFileSync(".github/workflows/parse-pending.yml", "utf8");
  const stepAt = text.indexOf("Fill sol_price for the minutes about to be parsed");
  // Ends at the requeue step that R2 put between this one and the parse, so
  // this block keeps testing the fill step alone rather than both of them.
  const step = text.slice(stepAt, text.indexOf("- name: Requeue rows whose missing rate"));

  it("runs the fill in the same workflow, before the parse", () => {
    const fillAt = text.indexOf("npx tsx scripts/backfill-sol-price.ts");
    const parseAt = text.indexOf("npx tsx scripts/parse-pending.ts");
    expect(fillAt).toBeGreaterThan(-1);
    expect(parseAt).toBeGreaterThan(-1);
    expect(fillAt).toBeLessThan(parseAt);
  });

  it("does not stop the parse when it fails", () => {
    expect(step).toMatch(/^\s*continue-on-error:\s*true\s*$/m);
    // And it is the only step that carries the flag: it is an exemption from
    // this repo's ordering rule, not a general licence.
    // Anchored to the start of a line so the prose above the step -- which
    // names the flag -- is not counted as a second one.
    expect((text.match(/^\s*continue-on-error:\s*true\s*$/gm) ?? []).length).toBe(1);
  });

  it("gives the step the one secret it needs, and no key it cannot use", () => {
    // Its import graph has no wallets.ts on it, and Binance's klines endpoint
    // is public and keyless, so DATABASE_URL is the whole list.
    expect(step).toMatch(/DATABASE_URL:\s*\$\{\{\s*secrets\.DATABASE_URL\s*\}\}/);
    expect(step).not.toContain("WALLET_ENC_KEY");
    expect(step).not.toContain("WALLET_HMAC_KEY");
    expect(step).not.toContain("HELIUS_API_KEY");
  });
});

/**
 * R2 put a fourth step in this workflow, between the fill and the parse: the
 * requeue. Three properties, each of them a decision the round before it paid
 * for.
 *
 * - **Position.** It clears `parse_error` on the rows whose block minute the
 *   fill has just given a rate, and the parse is what turns them into trades.
 *   Moved behind the parse it opens rows nothing reads until the next cycle;
 *   moved in front of the fill it finds the same minutes still empty.
 * - **No `continue-on-error`.** The fill carries it because it is a
 *   third-party HTTP call standing in front of ingestion. This is one
 *   statement against the same database the parse is about to use, so a
 *   failure here is one the parse would meet anyway and must stop the job.
 * - **DATABASE_URL and nothing else.** `parse-swap.ts` decrypts payloads, but
 *   `crypto.ts` loads its keys per call rather than at import and this path
 *   decrypts nothing -- the gate reads `raw_tx.block_time`, a plaintext
 *   column. Handing it keys it cannot use would only widen what a compromised
 *   step could exfiltrate.
 */
describe(".github/workflows/parse-pending.yml: requeue step", () => {
  const text = readFileSync(".github/workflows/parse-pending.yml", "utf8");
  const stepAt = text.indexOf("- name: Requeue rows whose missing rate");
  const step = text.slice(stepAt, text.indexOf("- name: Run parsePending"));

  it("runs the requeue between the fill and the parse", () => {
    const fillAt = text.indexOf("npx tsx scripts/backfill-sol-price.ts");
    const parseAt = text.indexOf("npx tsx scripts/parse-pending.ts");
    expect(stepAt).toBeGreaterThan(-1);
    expect(stepAt).toBeGreaterThan(fillAt);
    expect(stepAt).toBeLessThan(parseAt);
  });

  it("runs the script, rather than an inline eval nothing can execute", () => {
    // It was briefly `npx tsx --eval` with the statement written into the
    // YAML. That is untestable by construction -- no case in this repo can
    // run it -- so what is pinned here is that the step goes through a file
    // scripts/requeue-no-rate.test.ts can exercise in-process and as a real
    // subprocess.
    expect(step).toContain("npx tsx scripts/requeue-no-rate.ts");
    expect(step).not.toContain("--eval");
  });

  it("passes REQUEUE_LIMIT through as a repository variable, not a secret", () => {
    // The knob that bounds a by-hand historical drain, and the one that stops
    // the step dead at 0 without an edit. A `vars.` reference, like
    // TOKEN_METADATA_LIMIT: it is a tuning number, not a credential.
    expect(step).toMatch(/REQUEUE_LIMIT:\s*\$\{\{\s*vars\.REQUEUE_LIMIT\s*\}\}/);
  });

  it("stops the job when it fails, unlike the fill above it", () => {
    expect(step).not.toMatch(/^\s*continue-on-error:/m);
  });

  it("gives the step the one secret it needs, and no key it cannot use", () => {
    expect(step).toMatch(/DATABASE_URL:\s*\$\{\{\s*secrets\.DATABASE_URL\s*\}\}/);
    expect(step).not.toContain("WALLET_ENC_KEY");
    expect(step).not.toContain("WALLET_HMAC_KEY");
    expect(step).not.toContain("HELIUS_API_KEY");
  });
});

/**
 * F6. `loadEnvLocal()` fills a variable that is *missing*, and only a missing
 * one, so `unset DATABASE_URL` before running a script by hand does not point
 * it at nothing — it points it at whatever `.env.local` says, which is
 * production. That has happened on this repo: a one-off requeue run connected
 * to the production branch and wrote nothing only because of which statement it
 * happened to be.
 *
 * So every cron entry point prints the `ep-…` host it resolved before it does
 * any work. `migrate.mts` had this line first and it is now the shared helper
 * all of them use.
 *
 * A text check rather than a subprocess: the property is "no entry point is
 * missing the call", which is about the set of files, and running eight of them
 * to find out costs eight connections to prove something the source says.
 */
describe("every cron entry point announces its database", () => {
  const ENTRY_POINTS = [
    "scripts/parse-pending.ts",
    "scripts/recompute-dirty.ts",
    "scripts/prune-rate-limit.ts",
    "scripts/requeue-no-rate.ts",
    "scripts/backfill-prices.ts",
    "scripts/backfill-sol-price.ts",
    "scripts/refresh-token-metadata.ts",
  ];

  it.each(ENTRY_POINTS)("%s calls announceDatabaseTarget before main()", (path) => {
    const text = readFileSync(path, "utf8");
    const guardAt = text.indexOf("if (import.meta.url === `file://${process.argv[1]}`) {");
    expect(guardAt, `${path} has no entry-point guard`).toBeGreaterThan(-1);
    const shell = text.slice(guardAt);
    expect(shell).toContain("announceDatabaseTarget()");
    expect(shell.indexOf("announceDatabaseTarget()")).toBeLessThan(shell.indexOf("await main()"));
  });

  // The two scripts that resolve their own target rather than db.ts's, and so
  // cannot use the same helper. Both must still print the host and only the
  // host, through `hostFragment` -- the point of extracting it was that a regex
  // copied nine times gets loosened in one of them.
  it.each(["scripts/migrate.mts", "scripts/seed-preview.ts"])("%s prints its target through hostFragment", (path) => {
    const text = readFileSync(path, "utf8");
    expect(text).toContain("hostFragment(");
    expect(text).not.toMatch(/match\(\/ep-/);
  });
});
