import { createDecipheriv, createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { aadFor, blindIndex, decrypt, encrypt } from "./crypto";

const value = "z".repeat(44); // an address-shaped string, invented
const aad = "kol_wallet:address:row-1";
const IV_BYTES = 12;
const TAG_BYTES = 16;

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

  it("refuses a blob with an unknown key version", () => {
    // This only proves the version-lookup guard rejects an unrecognized
    // version; it cannot fail for any reason related to the AAD folding
    // below, since blob[0] ^ 0xff is never a version this code knows about
    // and the lookup guard rejects it before setAAD is ever reached. See
    // "the version byte is authenticated data, not just a lookup key" for
    // coverage of the AAD folding itself.
    const blob = encrypt(value, aad);
    blob[0] ^= 0xff;
    expect(() => decrypt(blob, aad)).toThrow();
  });

  it("the version byte is authenticated data, not just a lookup key", () => {
    // decrypt()/encrypt() alone cannot exercise this: with only one key
    // version defined, an altered version byte is always rejected by the
    // version-lookup guard before setAAD runs (see the test above), so the
    // AAD folding added in review is otherwise unobservable from outside.
    // Reach into the primitives directly, the same way crypto.ts does, to
    // prove the version byte genuinely participates in GCM authentication.
    const blob = encrypt(value, aad);
    const version = blob[0];
    const iv = blob.subarray(1, 1 + IV_BYTES);
    const tag = blob.subarray(1 + IV_BYTES, 1 + IV_BYTES + TAG_BYTES);
    const body = blob.subarray(1 + IV_BYTES + TAG_BYTES);
    // Read the key the same way crypto.ts's key() does; nothing new is
    // exported from crypto.ts just to make this test possible.
    const encKey = Buffer.from(process.env.WALLET_ENC_KEY!, "base64");

    // The pre-review AAD (no version prefix) must fail authentication.
    const withoutVersionPrefix = createDecipheriv("aes-256-gcm", encKey, iv);
    withoutVersionPrefix.setAAD(Buffer.from(aad, "utf8"));
    withoutVersionPrefix.setAuthTag(tag);
    expect(() =>
      Buffer.concat([withoutVersionPrefix.update(body), withoutVersionPrefix.final()]),
    ).toThrow();

    // The current AAD (version byte prepended) must authenticate and
    // recover the original plaintext.
    const withVersionPrefix = createDecipheriv("aes-256-gcm", encKey, iv);
    withVersionPrefix.setAAD(Buffer.concat([Buffer.from([version]), Buffer.from(aad, "utf8")]));
    withVersionPrefix.setAuthTag(tag);
    const plaintext = Buffer.concat([
      withVersionPrefix.update(body),
      withVersionPrefix.final(),
    ]).toString("utf8");
    expect(plaintext).toBe(value);
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

describe("aadFor", () => {
  it("joins table, column, and id with ':'", () => {
    expect(aadFor("kol_wallet", "address", "row-1")).toBe("kol_wallet:address:row-1");
  });

  it("rejects a ':' in the table part", () => {
    expect(() => aadFor("kol_wallet:evil", "address", "row-1")).toThrow();
  });

  it("rejects a ':' in the column part", () => {
    expect(() => aadFor("kol_wallet", "address:evil", "row-1")).toThrow();
  });

  it("rejects a ':' in the id part", () => {
    expect(() => aadFor("kol_wallet", "address", "row-1:evil")).toThrow();
  });

  it("rejects an empty table part", () => {
    expect(() => aadFor("", "address", "row-1")).toThrow();
  });

  it("rejects an empty column part", () => {
    expect(() => aadFor("kol_wallet", "", "row-1")).toThrow();
  });

  it("rejects an empty id part", () => {
    expect(() => aadFor("kol_wallet", "address", "")).toThrow();
  });

  it("prevents two distinct locations from colliding on the same AAD string", () => {
    // Without the ':' rejection, ("t", "a:b", "c") and ("t", "a", "b:c")
    // would both join to "t:a:b:c" — exactly the collision the AAD exists
    // to rule out. Both must be rejected.
    expect(() => aadFor("t", "a:b", "c")).toThrow();
    expect(() => aadFor("t", "a", "b:c")).toThrow();
  });
});
