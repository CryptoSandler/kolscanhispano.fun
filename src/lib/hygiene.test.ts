import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ALLOWED_BASE58, HYGIENE_SKIP, findDisallowedBase58 } from "./hygiene";

const address = "z".repeat(44); // base58 charset, address length
const signature = "z".repeat(88); // base58 charset, signature length

describe("findDisallowedBase58", () => {
  it("flags an address-length base58 string", () => {
    expect(findDisallowedBase58(`wallet is ${address} ok`)).toEqual([address]);
  });

  it("flags a signature-length base58 string", () => {
    expect(findDisallowedBase58(`tx ${signature}`)).toEqual([signature]);
  });

  it("ignores strings that are too short or too long", () => {
    expect(findDisallowedBase58("z".repeat(31))).toEqual([]);
    expect(findDisallowedBase58("z".repeat(45))).toEqual([]);
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
  it("contains no Solana address or signature outside the allowlist", () => {
    const tracked = execFileSync("git", ["ls-files"], { encoding: "utf8" })
      .split("\n")
      .filter((f) => f && !HYGIENE_SKIP.includes(f));

    const offenders: string[] = [];
    for (const file of tracked) {
      let text: string;
      try {
        text = readFileSync(file, "utf8");
      } catch {
        continue; // unreadable or binary
      }
      for (const hit of findDisallowedBase58(text)) offenders.push(`${file}: ${hit}`);
    }

    expect(offenders).toEqual([]);
  });
});
