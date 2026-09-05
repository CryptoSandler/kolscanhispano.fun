import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ALLOWLISTED_IDENTIFIERS, findDisallowedEvm } from "./hygiene";

/**
 * **The allowlist in the code and the one in the document are the same list.**
 *
 * `docs/multichain.md` is canonical — it is where a person looks to find out
 * what a contract is and who says so. `hygiene.ts` has to carry the values in
 * code because it is imported by a route and Next bundles by following imports,
 * not file paths: a `readFileSync` of a doc works in development and fails in
 * production. So there are two copies, and this is what stops them drifting —
 * the same arrangement `wallet-proof-store.test.ts` uses for the Postgres
 * `CHECK`, and for the same reason.
 *
 * **Only the delimited tables count.** This document is itself scanned by the
 * guard; if any address written in any paragraph allowlisted itself, pasting a
 * wallet in here by mistake would stop being a mistake, which is precisely what
 * the guard exists to catch.
 */
function fromDoc(kind: "contracts" | "topics"): string[] {
  const text = readFileSync("docs/multichain.md", "utf8");
  const open = `<!-- allowlist:${kind} -->`;
  const close = `<!-- /allowlist:${kind} -->`;
  const start = text.indexOf(open);
  const end = text.indexOf(close);
  // A missing marker must fail loudly rather than produce an empty list that
  // agrees with nothing and passes.
  expect(start, `${open} not found in docs/multichain.md`).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return [...text.slice(start, end).matchAll(/`(0x[0-9a-fA-F]+)`/g)].map((m) => m[1]);
}

describe("the allowlist in the code matches the document", () => {
  it.each(["contracts", "topics"] as const)("agrees on %s, in both directions", (kind) => {
    const doc = fromDoc(kind).map((v) => v.toLowerCase()).sort();
    const code = [...ALLOWLISTED_IDENTIFIERS[kind]].map((v) => v.toLowerCase()).sort();
    expect(doc.length).toBeGreaterThan(0);
    // Both directions, so neither "the doc gained a row" nor "the code gained a
    // constant" can pass. The message says which way it drifted.
    expect(code, "in docs/multichain.md but not in hygiene.ts").toEqual(doc);
  });

  it("keeps contracts and topics apart by length, which is the distinction", () => {
    for (const address of ALLOWLISTED_IDENTIFIERS.contracts) {
      expect(address, `${address} is not 40 hex`).toMatch(/^0x[0-9a-fA-F]{40}$/);
    }
    for (const topic of ALLOWLISTED_IDENTIFIERS.topics) {
      // The confusion this guards against is real: a grep for 40 hex once
      // matched the first 40 characters of these and called them addresses.
      expect(topic, `${topic} is not 64 hex`).toMatch(/^0x[0-9a-fA-F]{64}$/);
    }
  });

  it("exempts every allowlisted value from the EVM scan, and nothing else", () => {
    const all = [...ALLOWLISTED_IDENTIFIERS.contracts, ...ALLOWLISTED_IDENTIFIERS.topics];
    expect(findDisallowedEvm(all.join(" "))).toEqual([]);

    // A wallet-shaped address that is not on the list is still caught — the
    // check would be worthless if widening the list widened it to everything.
    const stranger = `0x${"a1b2c3d4".repeat(5)}`;
    expect(findDisallowedEvm(stranger)).toEqual([stranger]);
  });
});
