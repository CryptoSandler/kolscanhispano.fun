/**
 * This project never builds or sends a transaction, and this is the test that
 * keeps it true.
 *
 * `docs/spec-v1.md:659-660` states it as a property rather than an intention:
 * *"`/registro` never builds or sends a transaction. An assertion over the
 * registration module's import graph and source that no
 * transaction-constructing or transaction-sending API is reachable."* Until
 * `/registro` exists there is no narrower graph to walk, so this scans **all**
 * application source — which is strictly stronger, and stays correct when that
 * page lands.
 *
 * Why it matters more than it looks: `docs/wallet-warnings.md` records a house
 * rule that any transaction offered for signature carries one signer, an
 * explicit chain, and a server-side pre-flight. Those rules are *dormant* here
 * because there is no money path — and the difference between "dormant" and
 * "quietly implemented badly" is exactly this file. A wallet that can only be
 * asked for a signature over a message cannot be asked for funds by a bug.
 */
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..");

/**
 * Transaction-constructing and transaction-sending surface.
 *
 * Word-boundary anchored, and `Transaction` deliberately is **not** on its own:
 * `withTransaction` is this repo's Postgres helper and appears throughout
 * `pnl.ts` and `db.ts`. Matching it would make the test noise, and a noisy
 * guard is one somebody eventually deletes.
 */
const FORBIDDEN = [
  /\bsignAndSendTransaction\b/,
  /\bsendTransaction\b/,
  /\bsendRawTransaction\b/,
  /\bnew\s+Transaction\b/,
  /\bVersionedTransaction\b/,
  /\bTransactionMessage\b/,
  /\bSystemProgram\b/,
  /\bTransactionInstruction\b/,
  /\bsignAllTransactions\b/,
  /@solana\/web3\.js/,
  /@solana\/wallet-adapter/,
];

/** This file names every forbidden API, so it cannot scan itself. */
const SKIP = ["src/lib/no-money-path.test.ts"];

function trackedSource(): string[] {
  return execFileSync("git", ["ls-files", "src", "e2e", "scripts"], { cwd: ROOT, encoding: "utf8" })
    .split("\n")
    .filter((f) => /\.(ts|tsx)$/.test(f) && !SKIP.includes(f));
}

describe("the money path this project does not have", () => {
  it("reaches no transaction-constructing or transaction-sending API", () => {
    const offenders: string[] = [];
    for (const file of trackedSource()) {
      const text = readFileSync(join(ROOT, file), "utf8");
      for (const pattern of FORBIDDEN) {
        if (pattern.test(text)) offenders.push(`${file}: ${pattern.source}`);
      }
    }
    expect(offenders, "spec 659: no transaction API may be reachable").toEqual([]);
  });

  it("declares no wallet-transaction dependency", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
    // `@solana/web3.js` is how a transaction gets built; a wallet adapter is how
    // it gets signed. Neither is needed to verify a wallet proof.
    //
    // This comment used to add "which is an ed25519 check `node:crypto` already
    // does", and that stopped being what the code does when `wallet-proof.ts`
    // landed. It was true -- but only by wrapping a raw 32-byte key in a 12-byte
    // SPKI DER prefix, and `@noble/curves` had to be taken anyway for the EVM
    // half, where Node has no public-key recovery at all. `docs/wallet-proof.md`
    // §1 argues it out. Corrected here rather than left to rot, which is the
    // mistake `key_version` was: a written claim nobody re-read.
    //
    // What still holds, and is what this case actually asserts: verification
    // needs no transaction library. `@noble/curves` recovers and checks; it
    // constructs nothing and sends nothing.
    expect(deps.filter((d) => /^@solana\/(web3\.js|wallet-adapter)/.test(d))).toEqual([]);
  });

  it("still scans a meaningful number of files, so an empty glob cannot pass it", () => {
    // A guard that silently scanned nothing would be green forever. This is the
    // canary for that, and the reason the count is asserted rather than assumed.
    expect(trackedSource().length).toBeGreaterThan(40);
  });
});
