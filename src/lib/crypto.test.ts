import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { blindIndex, decrypt, encrypt } from "./crypto";

const value = "z".repeat(44); // an address-shaped string, invented
const aad = "kol_wallet:address:row-1";

describe("encrypt / decrypt", () => {
  it("round-trips under the same AAD", () => {
    expect(decrypt(encrypt(value, aad), aad)).toBe(value);
  });

  it("round-trips an empty string", () => {
    expect(decrypt(encrypt("", aad), aad)).toBe("");
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

  it("refuses a blob with a flipped byte inside the IV", () => {
    const blob = encrypt(value, aad);
    blob[1] ^= 0xff; // byte 0 is the version; the IV starts at byte 1
    expect(() => decrypt(blob, aad)).toThrow();
  });

  it("refuses a blob with a flipped byte inside the tag", () => {
    const blob = encrypt(value, aad);
    blob[1 + 12] ^= 0xff; // IV is 12 bytes; the tag starts right after it
    expect(() => decrypt(blob, aad)).toThrow();
  });

  it("refuses a blob with an altered version byte", () => {
    const blob = encrypt(value, aad);
    blob[0] ^= 0xff;
    expect(() => decrypt(blob, aad)).toThrow();
  });

  it("refuses a truncated blob instead of returning garbage", () => {
    const blob = encrypt(value, aad).subarray(0, 10);
    expect(() => decrypt(blob, aad)).toThrow();
  });

  it("refuses an empty blob instead of returning garbage", () => {
    expect(() => decrypt(Buffer.alloc(0), aad)).toThrow();
  });

  it("carries a key version in the first byte", () => {
    expect(encrypt(value, aad)[0]).toBe(1);
  });

  it("never contains the plaintext bytes", () => {
    // toString("utf8") lossily mangles random bytes (invalid sequences become
    // U+FFFD), so a substring check on the decoded string proves less than it
    // looks: it can pass even when the raw bytes are present. Check the raw
    // bytes instead.
    expect(encrypt(value, aad).includes(Buffer.from(value, "utf8"))).toBe(false);
  });
});

describe("blindIndex", () => {
  it("is deterministic and 32 bytes", () => {
    const a = blindIndex(value, "address");
    expect(a.equals(blindIndex(value, "address"))).toBe(true);
    expect(a.length).toBe(32);
  });

  it("differs for different inputs", () => {
    expect(blindIndex(value, "address").equals(blindIndex("y".repeat(44), "address"))).toBe(false);
  });

  it("differs by domain for the same input", () => {
    expect(blindIndex(value, "address").equals(blindIndex(value, "signature"))).toBe(false);
  });

  it("is not a bare hash of the input", () => {
    const sha = createHash("sha256").update(value).digest();
    expect(blindIndex(value, "address").equals(sha)).toBe(false);
  });
});
