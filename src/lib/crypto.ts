import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { loadEnvLocal } from "./env";

loadEnvLocal();

export const KEY_VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const MIN_BLOB_BYTES = 1 + IV_BYTES + TAG_BYTES;

function loadKey(name: "WALLET_ENC_KEY" | "WALLET_HMAC_KEY"): Buffer {
  const raw = process.env[name];
  if (!raw) throw new Error(`${name} is not set`);
  const bytes = Buffer.from(raw, "base64");
  if (bytes.length !== 32) throw new Error(`${name} must be 32 bytes, base64-encoded`);
  return bytes;
}

/**
 * Keys live in the host environment and never in Neon: a database dump alone
 * must not yield addresses. See SECURITY.md.
 *
 * Spec §8.1 requires two independent keys for the ciphertext and the blind
 * index. Both are loaded and compared on every call (cheap, and it means the
 * invariant holds no matter which function runs first) so an operator who
 * pastes the same value into both env vars gets a hard failure instead of a
 * blind index that silently collapses to a keyed function of the ciphertext
 * key. Compared in constant time; neither value appears in the error.
 */
function key(name: "WALLET_ENC_KEY" | "WALLET_HMAC_KEY"): Buffer {
  const encKey = loadKey("WALLET_ENC_KEY");
  const hmacKey = loadKey("WALLET_HMAC_KEY");
  if (timingSafeEqual(encKey, hmacKey)) {
    throw new Error("WALLET_ENC_KEY and WALLET_HMAC_KEY must not be equal");
  }
  return name === "WALLET_ENC_KEY" ? encKey : hmacKey;
}

/**
 * `aad` binds the ciphertext to its exact column and row, so a value cannot be
 * moved between fields or rows and still authenticate. The key version is
 * folded into the authenticated data too (not just prepended to the blob), so
 * once a v2 key exists a flipped version byte fails authentication rather
 * than merely failing a version lookup.
 * Layout: version(1) | iv(12) | tag(16) | ciphertext
 */
export function encrypt(plaintext: string, aad: string): Buffer {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key("WALLET_ENC_KEY"), iv);
  cipher.setAAD(Buffer.concat([Buffer.from([KEY_VERSION]), Buffer.from(aad, "utf8")]));
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([Buffer.from([KEY_VERSION]), iv, cipher.getAuthTag(), body]);
}

export function decrypt(blob: Buffer, aad: string): string {
  if (blob.length < MIN_BLOB_BYTES) throw new Error("ciphertext blob is too short");
  const version = blob[0];
  if (version !== KEY_VERSION) throw new Error(`unknown key version ${version}`);
  const iv = blob.subarray(1, 1 + IV_BYTES);
  const tag = blob.subarray(1 + IV_BYTES, 1 + IV_BYTES + TAG_BYTES);
  const body = blob.subarray(1 + IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", key("WALLET_ENC_KEY"), iv);
  decipher.setAAD(Buffer.concat([Buffer.from([version]), Buffer.from(aad, "utf8")]));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
}

/**
 * Equality lookup without decryption. Keyed, so an attacker holding a database
 * dump cannot test a guessed address against the index.
 *
 * `domain` separates the address index from the signature index (spec §8.2):
 * without it, the same value stored as both an address and a signature would
 * produce the same digest, leaking a cross-column equality an attacker could
 * exploit. The domain is folded into the HMAC input, not appended afterward,
 * so it cannot be stripped or confused with the value itself.
 */
export function blindIndex(value: string, domain: "address" | "signature"): Buffer {
  return createHmac("sha256", key("WALLET_HMAC_KEY")).update(`${domain}:${value}`, "utf8").digest();
}
