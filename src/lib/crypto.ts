import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";
import { loadEnvLocal } from "./env";

loadEnvLocal();

export const KEY_VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;

/**
 * Keys live in the host environment and never in Neon: a database dump alone
 * must not yield addresses. See SECURITY.md.
 */
function key(name: "WALLET_ENC_KEY" | "WALLET_HMAC_KEY"): Buffer {
  const raw = process.env[name];
  if (!raw) throw new Error(`${name} is not set`);
  const bytes = Buffer.from(raw, "base64");
  if (bytes.length !== 32) throw new Error(`${name} must be 32 bytes, base64-encoded`);
  return bytes;
}

/**
 * `aad` binds the ciphertext to its exact column and row, so a value cannot be
 * moved between fields or rows and still authenticate.
 * Layout: version(1) | iv(12) | tag(16) | ciphertext
 */
export function encrypt(plaintext: string, aad: string): Buffer {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key("WALLET_ENC_KEY"), iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([Buffer.from([KEY_VERSION]), iv, cipher.getAuthTag(), body]);
}

export function decrypt(blob: Buffer, aad: string): string {
  const version = blob[0];
  if (version !== KEY_VERSION) throw new Error(`unknown key version ${version}`);
  const iv = blob.subarray(1, 1 + IV_BYTES);
  const tag = blob.subarray(1 + IV_BYTES, 1 + IV_BYTES + TAG_BYTES);
  const body = blob.subarray(1 + IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", key("WALLET_ENC_KEY"), iv);
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
}

/**
 * Equality lookup without decryption. Keyed, so an attacker holding a database
 * dump cannot test a guessed address against the index.
 */
export function blindIndex(value: string): Buffer {
  return createHmac("sha256", key("WALLET_HMAC_KEY")).update(value, "utf8").digest();
}
