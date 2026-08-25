import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { blindIndex, decrypt, encrypt } from "./crypto";

const value = "z".repeat(44); // an address-shaped string, invented
const aad = "kol_wallet:address:row-1";

describe("encrypt / decrypt", () => {
  it("round-trips under the same AAD", () => {
    expect(decrypt(encrypt(value, aad), aad)).toBe(value);
  });

  it("produces a different ciphertext every time", () => {
    expect(encrypt(value, aad).equals(encrypt(value, aad))).toBe(false);
  });

  it("refuses a ciphertext moved to another row", () => {
    const blob = encrypt(value, aad);
    expect(() => decrypt(blob, "kol_wallet:address:row-2")).toThrow();
  });

  it("refuses a ciphertext moved to another column", () => {
    const blob = encrypt(value, aad);
    expect(() => decrypt(blob, "kol_wallet:proof_signature:row-1")).toThrow();
  });

  it("refuses a tampered ciphertext", () => {
    const blob = encrypt(value, aad);
    blob[blob.length - 1] ^= 0xff;
    expect(() => decrypt(blob, aad)).toThrow();
  });

  it("carries a key version in the first byte", () => {
    expect(encrypt(value, aad)[0]).toBe(1);
  });

  it("never contains the plaintext", () => {
    expect(encrypt(value, aad).toString("utf8")).not.toContain(value);
  });
});

describe("blindIndex", () => {
  it("is deterministic and 32 bytes", () => {
    const a = blindIndex(value);
    expect(a.equals(blindIndex(value))).toBe(true);
    expect(a.length).toBe(32);
  });

  it("differs for different inputs", () => {
    expect(blindIndex(value).equals(blindIndex("y".repeat(44)))).toBe(false);
  });

  it("is not a bare hash of the input", () => {
    const sha = createHash("sha256").update(value).digest();
    expect(blindIndex(value).equals(sha)).toBe(false);
  });
});
