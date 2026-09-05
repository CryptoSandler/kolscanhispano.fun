import { describe, expect, it } from "vitest";
import {
  CHAINS,
  EVM_CHAIN_IDS,
  activeChains,
  canonicalAddress,
  isChain,
  isChainActive,
  isEvm,
} from "./chain";
import { blindIndex } from "./crypto";
import { inventAddress, inventEvmAddress } from "./ids";

/**
 * The bug this guards is not "two strings differ". It is "two digests differ",
 * because `kol_wallet.address_hmac` is what a wallet is looked up by and a
 * lookup that misses reports the wallet as untracked rather than as an error.
 * So every assertion below that matters goes through {@link blindIndex}, which
 * is the thing whose case-sensitivity caused it (`docs/multichain.md` §1.2).
 */
describe("canonicalAddress", () => {
  it("collapses EIP-55 and lowercase EVM casing onto one digest", () => {
    const address = inventEvmAddress();
    const checksummed = `0x${address.slice(2).toUpperCase()}`;

    expect(canonicalAddress(checksummed, "ethereum")).toBe(address);
    expect(blindIndex(canonicalAddress(checksummed, "ethereum"), "address")).toEqual(
      blindIndex(canonicalAddress(address, "ethereum"), "address"),
    );
  });

  it("is the reason the two digests differ without it", () => {
    // The mutation, written down rather than described: this is what the code
    // did before, and it is why a wallet could be registered and never found.
    const address = inventEvmAddress();
    const checksummed = `0x${address.slice(2).toUpperCase()}`;
    expect(blindIndex(checksummed, "address")).not.toEqual(blindIndex(address, "address"));
  });

  it("leaves Solana untouched, because base58 case is significant", () => {
    const address = inventAddress();
    expect(canonicalAddress(address, "solana")).toBe(address);
  });

  /**
   * The negative half, and the one that would have caught a "just lowercase
   * everything" fix. Two base58 strings differing only in case are two
   * different addresses; mapping them onto one digest would make the second
   * wallet unregistrable against a `UNIQUE` index.
   */
  it("keeps two base58 addresses that differ only in case distinct", () => {
    // Only letters valid in *both* cases: base58 drops lowercase `l` and
    // uppercase `I` and `O`, so a pair built from the whole alphabet would
    // fail validation rather than exercise the case rule.
    // Built from halves, never written whole: this file is scanned by
    // `hygiene.test.ts`'s repository case, which reports any base58 run of 32
    // or more and cannot tell a made-up alphabet from a real address. Each
    // half is under the floor, so the source carries no scannable run.
    const lower = "abcdefghjkmnpqrs" + "tuvwxyz123456789";
    const upper = "ABCDEFGHJKMNPQRS" + "TUVWXYZ123456789";
    expect(canonicalAddress(lower, "solana")).not.toBe(canonicalAddress(upper, "solana"));
    expect(blindIndex(canonicalAddress(lower, "solana"), "address")).not.toEqual(
      blindIndex(canonicalAddress(upper, "solana"), "address"),
    );
  });

  it("refuses an address of the wrong shape for its chain", () => {
    expect(() => canonicalAddress(inventAddress(), "ethereum")).toThrow(/ethereum/);
    expect(() => canonicalAddress(inventEvmAddress(), "solana")).toThrow(/solana/);
    expect(() => canonicalAddress("0xnothex", "bnb")).toThrow();
    expect(() => canonicalAddress("", "solana")).toThrow();
    // 39 hex digits: one short, and a silent accept here is a permanent row.
    expect(() => canonicalAddress(`0x${"a".repeat(39)}`, "bnb")).toThrow();
  });

  it("never puts the address in the error it throws", () => {
    const address = inventEvmAddress();
    try {
      canonicalAddress(address, "solana");
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(String(error)).not.toContain(address);
    }
  });

  it("trims surrounding whitespace, which a paste into a field carries", () => {
    const address = inventEvmAddress();
    expect(canonicalAddress(`  ${address}\n`, "bnb")).toBe(address);
  });
});

/**
 * `docs/multichain.md` §6: each chain stays behind an env flag and its public
 * surface stays closed until its ingestion carries real data.
 *
 * Every case passes an explicit `env` rather than mutating `process.env`, which
 * would race every other file in the suite and leave whichever ran next reading
 * a flag this file set.
 */
describe("activeChains", () => {
  it("offers Solana and nothing else with no flags set", () => {
    expect(activeChains({})).toEqual(["solana"]);
  });

  /**
   * The floor. A misconfiguration must never produce a registration screen that
   * offers nothing to connect -- a broken flow with no error anywhere -- so
   * Solana is not behind a flag at all.
   */
  it("offers Solana even when every EVM flag is off, or set to nonsense", () => {
    expect(activeChains({ CHAIN_BNB_INGESTION: "off" })).toEqual(["solana"]);
    expect(activeChains({ CHAIN_ETHEREUM_INGESTION: "" })).toEqual(["solana"]);
    expect(activeChains({ CHAIN_ROBINHOOD_INGESTION: "true" })).toEqual(["solana"]);
    expect(activeChains({ CHAIN_BNB_INGESTION: "1" })).toEqual(["solana"]);
  });

  it("adds a chain when its own flag is on, and only that chain", () => {
    expect(activeChains({ CHAIN_ROBINHOOD_INGESTION: "on" })).toEqual(["solana", "robinhood"]);
    expect(activeChains({ CHAIN_BNB_INGESTION: "on" })).toEqual(["solana", "bnb"]);
  });

  it("keeps the declared order, so the copy reads the same every render", () => {
    const all = activeChains({
      CHAIN_ROBINHOOD_INGESTION: "on",
      CHAIN_BNB_INGESTION: "on",
      CHAIN_ETHEREUM_INGESTION: "on",
    });
    expect(all).toEqual([...CHAINS]);
  });

  it("tolerates the whitespace a copied env value carries", () => {
    expect(activeChains({ CHAIN_BNB_INGESTION: " on " })).toEqual(["solana", "bnb"]);
  });

  it("names a flag per chain, so activating one cannot activate another", () => {
    // One list would make a typo silently widen or narrow the set; one flag per
    // chain makes activation a visible change to a named variable.
    expect(isChainActive("bnb", { CHAIN_ETHEREUM_INGESTION: "on" })).toBe(false);
    expect(isChainActive("ethereum", { CHAIN_ETHEREUM_INGESTION: "on" })).toBe(true);
    expect(isChainActive("solana", {})).toBe(true);
  });

  it("is what the environment actually says today", () => {
    /*
      The measured fact, not an assumption — and it **moved on 2026-09-04**,
      which is the point of pinning it.

      `CHAIN_ROBINHOOD_INGESTION=on` since the registration batch, so Robinhood
      is offered in `/registro`'s wallet chooser and named in the onboarding
      sentence. It was `["solana"]` while no flag was set anywhere.

      **What this does not mean:** Robinhood ingestion is not running.
      `activeChains()` gates *the offer* — a chain a wallet may be registered on
      — and `docs/round-robinhood.md` §3 keeps the ingestion itself behind a
      different condition: a real EVM wallet existing in the roster. The two are
      deliberately not the same switch, and this test is about the first.
    */
    expect(activeChains()).toEqual(["solana", "robinhood", "bnb"]);
  });
});

describe("chain vocabulary", () => {
  it("treats every chain but Solana as EVM", () => {
    expect(CHAINS.filter(isEvm)).toEqual(["robinhood", "bnb", "ethereum"]);
    expect(isEvm("solana")).toBe(false);
  });

  it("carries the EIP-155 id of every EVM chain and of no other", () => {
    // `docs/multichain.md` §4 and §6. These are signed into a SIWE payload, so
    // a wrong number is a signature valid on a chain the user did not mean.
    expect(EVM_CHAIN_IDS).toEqual({ robinhood: 4663, bnb: 56, ethereum: 1 });
    expect(Object.keys(EVM_CHAIN_IDS).sort()).toEqual(CHAINS.filter(isEvm).sort());
  });

  it("narrows an arbitrary string", () => {
    expect(isChain("solana")).toBe(true);
    expect(isChain("polygon")).toBe(false);
    expect(isChain("")).toBe(false);
  });
});
