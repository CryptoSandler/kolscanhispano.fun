import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * **Nothing inside a transaction may ask the pool for a second connection.**
 *
 * `db.ts` runs the pool at `max: 1`. A module-level {@link query} issued from
 * inside `withTransaction` waits for the one client that transaction is already
 * holding, and hangs until `connectionTimeoutMillis`. In production it looks
 * like a slow database; in a test it looks like a hang.
 *
 * This is not hypothetical and it is why the check exists. `cabal-actions.ts`
 * shipped with `authorise` calling `consumeNonce` — a module-level `query` —
 * from inside the transaction, and **every cabal action would have hung**. It
 * was found by reading `db.ts`, which is exactly the way a rule gets enforced
 * once and then forgotten.
 *
 * ## How it looks, rather than which cases somebody remembered
 *
 * Two passes over tracked source:
 *
 * 1. Find every exported function that reaches the module pool — directly
 *    through `query(`, or by calling another function already known to. Repeated
 *    until the set stops growing, so a helper three modules deep still counts.
 * 2. For every `withTransaction(` body, flag a call to `query(` or to anything
 *    in that set.
 *
 * ponytail: regex and brace-matching, not a TypeScript AST. It reads the shapes
 * this repository actually writes — `export async function f(`, and calls
 * spelled `f(` — and it will not follow a function passed as a value or renamed
 * on import. The upgrade is `ts-morph`, and it is a dependency for a check whose
 * value is that it runs on every commit. If it ever produces a false positive,
 * the fix is to pass `tx` instead, which is what the code should have done.
 */

/** The body of the balanced parentheses starting at `open`. */
function balanced(source: string, open: number): string {
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === "(") depth += 1;
    else if (source[i] === ")") {
      depth -= 1;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  return source.slice(open);
}

function sourceFiles(): string[] {
  return execFileSync("git", ["ls-files", "src", "scripts"], { encoding: "utf8" })
    .split("\n")
    .filter((f) => f.endsWith(".ts") || f.endsWith(".tsx"))
    .filter((f) => !f.includes(".test."));
}

/** Function names that reach `pool.connect()` without being handed a `tx`. */
function poolUsers(files: { path: string; text: string }[]): Set<string> {
  const known = new Set<string>(["query", "withTransaction", "withLock"]);
  const declarations: { name: string; body: string }[] = [];

  for (const { text } of files) {
    const pattern = /(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_]+)\s*\(/g;
    for (const match of text.matchAll(pattern)) {
      const start = text.indexOf("{", match.index + match[0].length);
      if (start === -1) continue;
      let depth = 0;
      let end = start;
      for (let i = start; i < text.length; i += 1) {
        if (text[i] === "{") depth += 1;
        else if (text[i] === "}") {
          depth -= 1;
          if (depth === 0) {
            end = i;
            break;
          }
        }
      }
      declarations.push({ name: match[1], body: text.slice(start, end) });
    }
  }

  // Fixed point: a function that calls a known pool user is one itself.
  let grew = true;
  while (grew) {
    grew = false;
    for (const { name, body } of declarations) {
      if (known.has(name)) continue;
      for (const user of known) {
        if (new RegExp(`\\b${user}\\s*[(<]`).test(body)) {
          known.add(name);
          grew = true;
          break;
        }
      }
    }
  }
  return known;
}

describe("no second connection inside a transaction", () => {
  const files = sourceFiles().map((path) => ({ path, text: readFileSync(path, "utf8") }));

  it("finds the transactions to check, so an empty scan cannot pass", () => {
    const total = files.filter((f) => f.text.includes("withTransaction(")).length;
    expect(total).toBeGreaterThan(3);
  });

  it("never calls the module pool from inside withTransaction", () => {
    const users = poolUsers(files);
    const offences: string[] = [];

    for (const { path, text } of files) {
      let from = 0;
      for (;;) {
        const at = text.indexOf("withTransaction(", from);
        if (at === -1) break;
        const body = balanced(text, at + "withTransaction".length);
        from = at + body.length;

        for (const user of users) {
          // `tx(` is the correct spelling and never an offence; so is the
          // declaration line itself.
          if (user === "withTransaction" || user === "withLock") continue;
          const call = new RegExp(`(?<![.\\w])${user}\\s*[(<]`);
          if (call.test(body)) {
            const line = text.slice(0, at).split("\n").length;
            offences.push(`${path}:${line} calls ${user}() inside withTransaction`);
          }
        }
      }
    }

    expect(
      offences,
      "db.ts runs the pool at max: 1 — pass `tx` instead, or move the call outside the transaction",
    ).toEqual([]);
  });
});
