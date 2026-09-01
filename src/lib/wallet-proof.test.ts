import bs58 from "bs58";
import { ed25519 } from "@noble/curves/ed25519.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { describe, expect, it } from "vitest";
import type { Chain } from "./chain";
import {
  PROOF_DOMAIN,
  PROOF_VALIDITY_MS,
  type ProofAction,
  type ProofFields,
  addressFromPublicKey,
  caip2,
  personalSignDigest,
  proofMessage,
  verifyProof,
} from "./wallet-proof";

/**
 * `docs/wallet-proof.md` §3 names thirteen negative cases before this file
 * existed. Each one asserts the **reason** and not merely the refusal: a guard
 * that fires on the wrong branch is not guarding what it claims, and a test
 * that only checks `ok === false` cannot tell the two apart.
 */

const NOW = Date.parse("2026-09-01T12:00:00.000Z");

/** A Solana keypair, and the address it produces. */
function solanaWallet() {
  const secret = ed25519.utils.randomSecretKey();
  const publicKey = ed25519.getPublicKey(secret);
  return {
    address: bs58.encode(publicKey),
    sign: (message: string) =>
      bs58.encode(ed25519.sign(new TextEncoder().encode(message), secret)),
  };
}

/** An EVM keypair, signing the way `personal_sign` does. */
function evmWallet() {
  const secret = secp256k1.utils.randomSecretKey();
  const address = addressFromPublicKey(secp256k1.getPublicKey(secret, false));

  /** noble returns 64 raw bytes; a wallet appends `v`. Recover it by trying both. */
  const withRecovery = (digest: Uint8Array): string => {
    const raw = secp256k1.sign(digest, secret, { prehash: false });
    for (const recovery of [0, 1]) {
      const candidate = secp256k1.Signature.fromBytes(raw.slice(0, 64), "compact").addRecoveryBit(
        recovery,
      );
      if (addressFromPublicKey(candidate.recoverPublicKey(digest).toBytes(false)) === address) {
        return `0x${Buffer.from(raw).toString("hex")}${(27 + recovery).toString(16)}`;
      }
    }
    throw new Error("no recovery bit matched");
  };

  return {
    address,
    sign: (message: string) => withRecovery(personalSignDigest(message)),
    /** The classic EIP-191 mistake: hash the message, skip the prefix. */
    signUnprefixed: (message: string) =>
      withRecovery(keccak_256(new TextEncoder().encode(message))),
  };
}

function fieldsFor(address: string, chain: Chain, over: Partial<ProofFields> = {}): ProofFields {
  return {
    domain: PROOF_DOMAIN,
    address,
    chain,
    action: "alta de perfil",
    nonce: "a1b2c3d4e5f60718293a4b5c6d7e8f90",
    expiresAt: new Date(NOW + 60_000).toISOString(),
    ...over,
  };
}

function expectedFor(fields: ProofFields) {
  return {
    domain: fields.domain,
    chain: fields.chain,
    action: fields.action,
    nonce: fields.nonce,
  };
}

describe("the message that gets signed", () => {
  it("states the chain in CAIP-2, on both families", () => {
    expect(caip2("solana")).toBe("solana:mainnet");
    expect(caip2("ethereum")).toBe("eip155:1");
    expect(caip2("bnb")).toBe("eip155:56");
    expect(caip2("robinhood")).toBe("eip155:4663");
  });

  it("carries the Cadena line, which is the whole reason this is a contract change", () => {
    const message = proofMessage(fieldsFor("x".repeat(32), "solana"));
    expect(message).toContain("Cadena: solana:mainnet");
    // And the sentence a person actually reads, which is what makes "I did not
    // agree to that" checkable.
    expect(message).toContain("No mueve fondos ni aprueba ninguna transacción");
  });

  it("changes when any bound field changes", () => {
    const base = fieldsFor("x".repeat(32), "solana");
    for (const over of [
      { domain: "otrositio.com" },
      { action: "agregar wallet" as ProofAction },
      { nonce: "f".repeat(32) },
      { expiresAt: new Date(NOW + 120_000).toISOString() },
    ]) {
      expect(proofMessage({ ...base, ...over })).not.toBe(proofMessage(base));
    }
  });
});

describe("personalSignDigest", () => {
  it("counts bytes, not characters", () => {
    // The message contains `Acción` and `transacción`, so it is not ASCII and
    // the two readings differ. A verifier using `.length` rejects every real
    // signature; this pins that the prefix is built from the byte count.
    const message = proofMessage(fieldsFor(`0x${"ab".repeat(20)}`, "ethereum"));
    const bytes = new TextEncoder().encode(message);
    expect(bytes.length).toBeGreaterThan(message.length);

    const expected = keccak_256(
      new TextEncoder().encode(`\x19Ethereum Signed Message:\n${bytes.length}`).length === 0
        ? bytes
        : (() => {
            const prefix = new TextEncoder().encode(
              `\x19Ethereum Signed Message:\n${bytes.length}`,
            );
            const joined = new Uint8Array(prefix.length + bytes.length);
            joined.set(prefix, 0);
            joined.set(bytes, prefix.length);
            return joined;
          })(),
    );
    expect(personalSignDigest(message)).toEqual(expected);
  });
});

describe("verifyProof: the happy paths", () => {
  it("accepts a Solana signature over exactly this message", () => {
    const wallet = solanaWallet();
    const fields = fieldsFor(wallet.address, "solana");
    const result = verifyProof({
      signature: wallet.sign(proofMessage(fields)),
      fields,
      expected: expectedFor(fields),
      nowMs: NOW,
    });
    expect(result).toEqual({ ok: true, address: wallet.address, chain: "solana" });
  });

  it("accepts an EVM signature, and returns the canonical address", () => {
    const wallet = evmWallet();
    const fields = fieldsFor(wallet.address, "bnb");
    const result = verifyProof({
      signature: wallet.sign(proofMessage(fields)),
      fields,
      expected: expectedFor(fields),
      nowMs: NOW,
    });
    expect(result).toEqual({ ok: true, address: wallet.address.toLowerCase(), chain: "bnb" });
  });

  it("accepts an EVM signature whose address is spelled in EIP-55 casing", () => {
    const wallet = evmWallet();
    const checksummed = `0x${wallet.address.slice(2).toUpperCase()}`;
    const fields = fieldsFor(checksummed, "ethereum");
    const result = verifyProof({
      signature: wallet.sign(proofMessage(fields)),
      fields,
      expected: expectedFor(fields),
      nowMs: NOW,
    });
    expect(result).toEqual({ ok: true, address: wallet.address.toLowerCase(), chain: "ethereum" });
  });
});

describe("verifyProof: the negative cases named in docs/wallet-proof.md", () => {
  it("1. refuses a payload naming another EVM chain", () => {
    const wallet = evmWallet();
    const fields = fieldsFor(wallet.address, "ethereum");
    const signature = wallet.sign(proofMessage(fields));
    const result = verifyProof({
      signature,
      fields,
      expected: { ...expectedFor(fields), chain: "bnb" },
      nowMs: NOW,
    });
    expect(result).toEqual({ ok: false, reason: "wrong_chain" });
  });

  it("2. refuses a message replayed across chain families, as wrong_chain not a curve error", () => {
    const solana = solanaWallet();
    const solanaFields = fieldsFor(solana.address, "solana");
    expect(
      verifyProof({
        signature: solana.sign(proofMessage(solanaFields)),
        fields: solanaFields,
        expected: { ...expectedFor(solanaFields), chain: "ethereum" },
        nowMs: NOW,
      }),
    ).toEqual({ ok: false, reason: "wrong_chain" });

    const evm = evmWallet();
    const evmFields = fieldsFor(evm.address, "ethereum");
    expect(
      verifyProof({
        signature: evm.sign(proofMessage(evmFields)),
        fields: evmFields,
        expected: { ...expectedFor(evmFields), chain: "solana" },
        nowMs: NOW,
      }),
    ).toEqual({ ok: false, reason: "wrong_chain" });
  });

  it("3. refuses a nonce that was never issued", () => {
    const wallet = solanaWallet();
    const fields = fieldsFor(wallet.address, "solana");
    const result = verifyProof({
      signature: wallet.sign(proofMessage(fields)),
      fields,
      expected: { ...expectedFor(fields), nonce: "b".repeat(32) },
      nowMs: NOW,
    });
    expect(result).toEqual({ ok: false, reason: "wrong_nonce" });
  });

  it("4. refuses an expired message, and one that never goes stale", () => {
    const wallet = solanaWallet();
    const stale = fieldsFor(wallet.address, "solana", {
      expiresAt: new Date(NOW - 1).toISOString(),
    });
    expect(
      verifyProof({
        signature: wallet.sign(proofMessage(stale)),
        fields: stale,
        expected: expectedFor(stale),
        nowMs: NOW,
      }),
    ).toEqual({ ok: false, reason: "expired" });

    // The direction that matters: a client naming its own `Expira` far ahead
    // would otherwise mint a signature good for ever.
    const forever = fieldsFor(wallet.address, "solana", {
      expiresAt: new Date(NOW + PROOF_VALIDITY_MS + 1000).toISOString(),
    });
    expect(
      verifyProof({
        signature: wallet.sign(proofMessage(forever)),
        fields: forever,
        expected: expectedFor(forever),
        nowMs: NOW,
      }),
    ).toEqual({ ok: false, reason: "expired" });
  });

  it("7. refuses a signature made for another domain", () => {
    const wallet = solanaWallet();
    const fields = fieldsFor(wallet.address, "solana", { domain: "otrositio.com" });
    const result = verifyProof({
      signature: wallet.sign(proofMessage(fields)),
      fields,
      expected: { ...expectedFor(fields), domain: PROOF_DOMAIN },
      nowMs: NOW,
    });
    expect(result).toEqual({ ok: false, reason: "wrong_domain" });
  });

  it("8. refuses a signature made by another wallet", () => {
    const owner = solanaWallet();
    const impostor = solanaWallet();
    const fields = fieldsFor(owner.address, "solana");
    expect(
      verifyProof({
        signature: impostor.sign(proofMessage(fields)),
        fields,
        expected: expectedFor(fields),
        nowMs: NOW,
      }),
    ).toEqual({ ok: false, reason: "address_mismatch" });

    const ownerEvm = evmWallet();
    const impostorEvm = evmWallet();
    const evmFields = fieldsFor(ownerEvm.address, "ethereum");
    expect(
      verifyProof({
        signature: impostorEvm.sign(proofMessage(evmFields)),
        fields: evmFields,
        expected: expectedFor(evmFields),
        nowMs: NOW,
      }),
    ).toEqual({ ok: false, reason: "address_mismatch" });
  });

  it("9. refuses a signature made for the other action", () => {
    const wallet = solanaWallet();
    const fields = fieldsFor(wallet.address, "solana", { action: "agregar wallet" });
    const result = verifyProof({
      signature: wallet.sign(proofMessage(fields)),
      fields,
      expected: { ...expectedFor(fields), action: "alta de perfil" },
      nowMs: NOW,
    });
    expect(result).toEqual({ ok: false, reason: "wrong_action" });
  });

  it("10. refuses a message tampered with after signing", () => {
    // The signature is real and the nonce is the expected one; only the text
    // moved. This is what "rebuilt, never parsed" buys: the verifier hashes the
    // fields it was given, so an edited field no longer matches the signature.
    const wallet = solanaWallet();
    const signed = fieldsFor(wallet.address, "solana");
    const signature = wallet.sign(proofMessage(signed));
    const tampered = { ...signed, expiresAt: new Date(NOW + 61_000).toISOString() };
    expect(
      verifyProof({
        signature,
        fields: tampered,
        expected: expectedFor(tampered),
        nowMs: NOW,
      }),
    ).toEqual({ ok: false, reason: "address_mismatch" });
  });

  it("11. refuses a malformed signature", () => {
    const wallet = evmWallet();
    const fields = fieldsFor(wallet.address, "ethereum");
    const expected = expectedFor(fields);
    for (const signature of [
      "0x",
      "not-hex",
      `0x${"ab".repeat(64)}`, // 128 hex: one byte short of r||s||v
      `0x${"ab".repeat(64)}09`, // v = 9, not a recovery id
    ]) {
      expect(verifyProof({ signature, fields, expected, nowMs: NOW })).toEqual({
        ok: false,
        reason: "malformed_signature",
      });
    }

    const solana = solanaWallet();
    const solanaFields = fieldsFor(solana.address, "solana");
    expect(
      verifyProof({
        signature: bs58.encode(new Uint8Array(63)),
        fields: solanaFields,
        expected: expectedFor(solanaFields),
        nowMs: NOW,
      }),
    ).toEqual({ ok: false, reason: "malformed_signature" });
  });

  it("12. refuses a signature that skipped the EIP-191 prefix", () => {
    // Valid secp256k1 over the raw keccak of the message: the arithmetic is
    // sound and the signer is right, but no wallet ever showed this text to
    // anybody, because `personal_sign` prefixes before it hashes.
    const wallet = evmWallet();
    const fields = fieldsFor(wallet.address, "ethereum");
    const result = verifyProof({
      signature: wallet.signUnprefixed(proofMessage(fields)),
      fields,
      expected: expectedFor(fields),
      nowMs: NOW,
    });
    expect(result).toEqual({ ok: false, reason: "address_mismatch" });
  });

  it("13. never puts the address, the signature or the nonce in a refusal", () => {
    const wallet = evmWallet();
    const fields = fieldsFor(wallet.address, "ethereum");
    const signature = wallet.sign(proofMessage(fields));

    // Every branch that can refuse, driven through one loop so a new branch
    // added without a test still has to pass this one.
    const refusals = [
      verifyProof({ signature, fields, expected: { ...expectedFor(fields), chain: "bnb" }, nowMs: NOW }),
      verifyProof({ signature, fields, expected: { ...expectedFor(fields), domain: "otro.com" }, nowMs: NOW }),
      verifyProof({ signature, fields, expected: { ...expectedFor(fields), nonce: "c".repeat(32) }, nowMs: NOW }),
      verifyProof({ signature, fields, expected: { ...expectedFor(fields), action: "agregar wallet" }, nowMs: NOW }),
      verifyProof({ signature, fields, expected: expectedFor(fields), nowMs: NOW + 10 * 60_000 }),
      verifyProof({ signature: "0xdead", fields, expected: expectedFor(fields), nowMs: NOW }),
      verifyProof({
        signature,
        fields: { ...fields, nonce: "not hex!" },
        expected: expectedFor(fields),
        nowMs: NOW,
      }),
    ];

    for (const refusal of refusals) {
      expect(refusal.ok).toBe(false);
      const text = JSON.stringify(refusal);
      expect(text).not.toContain(wallet.address);
      expect(text).not.toContain(wallet.address.toLowerCase());
      expect(text).not.toContain(signature);
      expect(text).not.toContain(fields.nonce);
    }
  });

  it("refuses an address that is not shaped like its chain's", () => {
    const wallet = solanaWallet();
    const fields = fieldsFor(wallet.address, "solana");
    // A base58 address presented as EVM: caught as a shape, before any curve
    // arithmetic, so it cannot surface as a confusing signature failure.
    expect(
      verifyProof({
        signature: wallet.sign(proofMessage(fields)),
        fields: { ...fields, chain: "ethereum" },
        expected: { ...expectedFor(fields), chain: "ethereum" },
        nowMs: NOW,
      }),
    ).toEqual({ ok: false, reason: "bad_message" });
  });
});

describe("the mutation that matters", () => {
  it("would let a cross-chain replay through if Cadena left the message", () => {
    // `docs/wallet-proof.md`: a chain field nothing checks is decoration. The
    // check that makes it load-bearing is that the *text* differs per chain, so
    // a signature over one cannot verify as another even if the comparison in
    // verifyProof were removed.
    const wallet = evmWallet();
    const onEthereum = proofMessage(fieldsFor(wallet.address, "ethereum"));
    const onBnb = proofMessage(fieldsFor(wallet.address, "bnb"));
    expect(onEthereum).not.toBe(onBnb);

    // And proven end to end: a signature over the Ethereum text, presented with
    // BNB fields that pass every equality check, still fails.
    const fields = fieldsFor(wallet.address, "bnb");
    expect(
      verifyProof({
        signature: wallet.sign(onEthereum),
        fields,
        expected: expectedFor(fields),
        nowMs: NOW,
      }),
    ).toEqual({ ok: false, reason: "address_mismatch" });
  });
});
