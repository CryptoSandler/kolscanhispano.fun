import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ALLOWED_BASE58,
  HYGIENE_SKIP,
  findDisallowedBase58,
  findDisallowedBase58InWorkflow,
  findDisallowedEvm,
} from "./hygiene";

const address = "z".repeat(44); // base58 charset, address length
const signature = "z".repeat(88); // base58 charset, signature length

describe("the public-contract allowlist", () => {
  // Built, never pasted: this file is scanned by the repository case below, and
  // an earlier addition to it failed that case by pasting a real address.
  const poolManager = "0x8366a39cc670b4001a" + "121b8f6a443a643e40951";
  const wallet = "0x" + "a1b2c3d4e5".repeat(4);

  it("does not flag a documented public contract", () => {
    expect(findDisallowedBase58(`the V4 PoolManager ${poolManager} emits Swap`)).toEqual([]);
  });

  it("still flags an EVM address that is not on the list", () => {
    // The scanner is base58, so it sees a fragment of the hex rather than the
    // whole address -- which is exactly why the allowlist strips full addresses
    // before the scan instead of comparing against what the scan produces.
    expect(findDisallowedBase58(`payer ${wallet}`).length).toBeGreaterThan(0);
  });

  it("does not flag a documented public contract as EVM either", () => {
    expect(findDisallowedEvm(`the V4 PoolManager ${poolManager} emits Swap`)).toEqual([]);
  });

  it("does not exempt hex generally", () => {
    const hmac = "a".repeat(64);
    expect(findDisallowedBase58(`x: ${hmac}`)).toEqual([hmac]);
  });
});

/**
 * `docs/multichain.md` §1: the base58 scan is *nearly blind* to EVM, because
 * base58 excludes `0` and a 40-hex address is chopped at every zero. Every
 * literal below is built from halves, never pasted, for the same reason the
 * block above builds its own: this file is scanned by the repository case.
 */
describe("findDisallowedEvm", () => {
  // Zeros scattered through it, which is the ordinary case and the blind one.
  const walletWithZeros = "0x" + "0a1b0c2d0e".repeat(4);
  const txHash = "0x" + "0f1e0d2c0b".repeat(6) + "0a1b";

  it("flags an EVM address the base58 scan cannot see", () => {
    expect(findDisallowedEvm(`payer ${walletWithZeros}`)).toEqual([walletWithZeros]);
    // The blindness itself, pinned: without this scan the address is invisible.
    expect(findDisallowedBase58(`payer ${walletWithZeros}`)).toEqual([]);
  });

  it("flags a 64-hex transaction hash", () => {
    expect(findDisallowedEvm(`tx ${txHash}`)).toEqual([txHash]);
  });

  it("does not flag a git commit SHA, which carries no 0x", () => {
    // 40 lowercase hex and not an address. This is why the pattern is anchored
    // on the prefix rather than on bare hex.
    expect(findDisallowedEvm(`pinned at ${"49933ea5288caeca8642" + "d1e84afbd3f7d6820020"}`)).toEqual(
      [],
    );
  });

  it("does not flag a blind index, which is 64 bare hex", () => {
    expect(findDisallowedEvm(`hmac ${"a".repeat(64)}`)).toEqual([]);
  });

  it("ignores hex of the wrong length", () => {
    expect(findDisallowedEvm("0x" + "0a".repeat(19) + "0")).toEqual([]); // 39
    expect(findDisallowedEvm("0x" + "0a".repeat(25))).toEqual([]); // 50
  });

  it("reports each distinct offender once", () => {
    expect(findDisallowedEvm(`${walletWithZeros} and ${walletWithZeros}`)).toEqual([
      walletWithZeros,
    ]);
  });

  it("is case-insensitive, so EIP-55 casing does not evade it", () => {
    const checksummed = "0x" + "0A1b0C2d0E".repeat(4);
    expect(findDisallowedEvm(`payer ${checksummed}`)).toEqual([checksummed]);
  });
});

describe("findDisallowedBase58InWorkflow", () => {
  // Every base58-shaped literal here is *built*, never written out: this file
  // is itself scanned by the repository case below, and an earlier draft of
  // these tests failed it by pasting a real address copied out of the captured
  // reference data. The guard caught its own test.
  // Split in two halves, each under the 32-character floor, so this file
  // contains no scannable run of its own.
  const sha = "49933ea5288caeca8642" + "d1e84afbd3f7d6820020";
  const pin = `uses: actions/setup-node@${sha} # v4.4.0`;
  const fakeAddress = `${"Ab".repeat(11)}${"Cd".repeat(11)}`.slice(0, 44);
  const fakeHmac = "a".repeat(64);

  it("does not flag an action pinned to a commit SHA", () => {
    expect(findDisallowedBase58InWorkflow(pin)).toEqual([]);
  });

  it("still flags an address sitting in the same file", () => {
    expect(findDisallowedBase58InWorkflow(`${pin}\n  env:\n    A: ${fakeAddress}`)).toEqual([
      fakeAddress,
    ]);
  });

  it("still flags a 64-character hex blind index, which is the hole not opened", () => {
    expect(findDisallowedBase58InWorkflow(`${pin}\n  X: ${fakeHmac}`)).toEqual([fakeHmac]);
  });

  it("leaves a bare SHA that is not an action pin to the strict rule", () => {
    expect(findDisallowedBase58InWorkflow(`secret: ${sha}`)).toEqual([sha.slice(0, 36)]);
  });
});

describe("findDisallowedBase58", () => {
  it("flags an address-length base58 string", () => {
    expect(findDisallowedBase58(`wallet is ${address} ok`)).toEqual([address]);
  });

  it("flags a signature-length base58 string", () => {
    expect(findDisallowedBase58(`tx ${signature}`)).toEqual([signature]);
  });

  it("ignores strings that are too short", () => {
    expect(findDisallowedBase58("z".repeat(31))).toEqual([]);
  });

  it("flags an address embedded in a longer base58 run with no delimiter", () => {
    // findDisallowedBase58 matches the maximal contiguous run, not a
    // length-windowed slice of it, so an address abutting more base58 text
    // must still be caught rather than silently dropped for being 49 chars
    // instead of 44.
    const embedded = address + "abcde";
    expect(findDisallowedBase58(embedded)).toEqual([embedded]);
  });

  it("ignores strings containing characters outside the base58 alphabet", () => {
    // "0" is not in the base58 alphabet, so it splits this into two 22-char
    // runs — each below the 32-char minimum, so neither is a candidate.
    // (A single "0" inserted into one long run would leave an embedded run
    // still within address length, which the scanner is correctly supposed
    // to catch — that would not exercise this case.)
    expect(findDisallowedBase58(`${"z".repeat(22)}0${"z".repeat(22)}`)).toEqual([]);
  });

  it("allows the public constants on the allowlist", () => {
    for (const allowed of ALLOWED_BASE58) {
      expect(findDisallowedBase58(`mint ${allowed}`)).toEqual([]);
    }
  });

  it("reports each distinct offender once", () => {
    expect(findDisallowedBase58(`${address} and ${address}`)).toEqual([address]);
  });
});

describe("the repository itself", () => {
  it("contains no Solana or EVM identifier outside the allowlist", () => {
    // `ls-files` alone lists only files git already **tracks**, so a brand new
    // file is invisible to this scan until it is committed -- and the run that
    // would have caught it is the one after the commit, by which point the
    // value is in history and history cannot be un-published. Measured here:
    // `chain.test.ts` carried two 32-character base58 literals through a clean
    // full-suite run for exactly that reason, and failed the next run once it
    // was tracked.
    //
    // `--others --exclude-standard` adds the untracked files git would offer to
    // add, and excludes everything `.gitignore` covers -- so `node_modules`,
    // `.next` and the Helius payload cache stay out while a new source file is
    // scanned before it is ever committed.
    const listed = (args: string[]) =>
      execFileSync("git", ["ls-files", ...args], { encoding: "utf8" }).split("\n");
    const tracked = [...new Set([...listed([]), ...listed(["--others", "--exclude-standard"])])]
      .filter((f) => f && !HYGIENE_SKIP.includes(f));

    const offenders: string[] = [];
    for (const file of tracked) {
      let text: string;
      try {
        text = readFileSync(file, "utf8");
      } catch {
        continue; // unreadable or binary
      }
      // Workflow files get the pin-aware scan: a `uses:@<40 hex>` is a commit
      // SHA, and its run up to the first `0` is base58-shaped. Every other
      // file gets the strict scan, so the exemption cannot reach source.
      const scan = file.startsWith(".github/workflows/")
        ? findDisallowedBase58InWorkflow
        : findDisallowedBase58;
      for (const hit of scan(text)) offenders.push(`${file}: ${hit}`);
      // The EVM scan runs on every file with no workflow variant: an action
      // pin carries no `0x`, so it cannot collide with this pattern.
      for (const hit of findDisallowedEvm(text)) offenders.push(`${file}: ${hit}`);
    }

    expect(offenders).toEqual([]);
  });
});
