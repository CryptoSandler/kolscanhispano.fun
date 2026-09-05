import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { ed25519 } from "@noble/curves/ed25519.js";
import bs58 from "bs58";
import { beforeEach, describe, expect, it } from "vitest";
import { aadFor, blindIndex, encrypt } from "./crypto";
import { query } from "./db";
import { resetAuditLog } from "./fixtures/audit";
import { withdrawWallet } from "./wallet-actions";
import { issueNonce } from "./wallet-proof-store";
import { PROOF_DOMAIN, proofMessage, type ProofAction } from "./wallet-proof";

const CHAIN = "solana" as const;

function wallet() {
  const secret = ed25519.utils.randomSecretKey();
  return {
    address: bs58.encode(ed25519.getPublicKey(secret)),
    sign: (m: string) => bs58.encode(ed25519.sign(new TextEncoder().encode(m), secret)),
  };
}

async function kolWith(handles: string, wallets: number, status = "approved") {
  const id = crypto.randomUUID();
  await query(
    `INSERT INTO kol (id, slug, display_name, x_handle, status, approved_at)
     VALUES ($1::uuid, $2, $2, $3::citext, $4, now())`,
    [id, handles, handles, status],
  );
  const made = [];
  for (let i = 0; i < wallets; i += 1) {
    const w = wallet();
    await query(
      `INSERT INTO kol_wallet (id, kol_id, chain, address_hmac, address_enc, status)
       VALUES (gen_random_uuid(), $1::uuid, 'solana', $2, $3, 'active')`,
      [id, blindIndex(w.address, "address"), encrypt(w.address, aadFor("kol_wallet", "address", id))],
    );
    made.push(w);
  }
  return { id, handle: handles, wallets: made };
}

async function prove(
  w: ReturnType<typeof wallet>,
  action: ProofAction = "retirar wallet",
  over: { subject?: string; nonceAction?: ProofAction } = {},
) {
  const issued = await issueNonce(w.address, CHAIN, over.nonceAction ?? action, over.subject);
  const fields = {
    domain: PROOF_DOMAIN,
    address: w.address,
    chain: CHAIN,
    action,
    subject: over.subject,
    nonce: issued.nonce,
    expiresAt: issued.expiresAt,
  };
  return {
    address: w.address,
    chain: CHAIN,
    signature: w.sign(proofMessage(fields)),
    nonce: issued.nonce,
    expiresAt: issued.expiresAt,
    subject: over.subject,
  };
}

beforeEach(async () => {
  await query("TRUNCATE wallet_proof_nonce");
  await query("UPDATE kol SET cabal_id = NULL");
  await query("TRUNCATE kol, kol_wallet, cabal CASCADE");
  await resetAuditLog();
});

describe("withdrawWallet", () => {
  it("withdraws the wallet that signed, and only that one", async () => {
    const kol = await kolWith("ana", 2);
    const result = await withdrawWallet(await prove(kol.wallets[0]));
    expect(result).toEqual({ ok: true, value: { handle: "ana", remaining: 1 } });

    const rows = await query<{ status: string; withdrawn_at: Date | null }>(
      "SELECT status, withdrawn_at FROM kol_wallet WHERE kol_id = $1::uuid ORDER BY status",
      [kol.id],
    );
    expect(rows.map((r) => r.status)).toEqual(["active", "withdrawn"]);
    expect(rows.find((r) => r.status === "withdrawn")?.withdrawn_at).not.toBeNull();
  });

  /** The point of the action: the withdrawn wallet stops authorising anything. */
  it("leaves the withdrawn wallet unable to sign for anything else", async () => {
    const kol = await kolWith("ana", 2);
    await withdrawWallet(await prove(kol.wallets[0]));
    // A fresh, perfectly valid proof from the same wallet now resolves to no
    // signer, because `authorise` only accepts an active one.
    expect(await withdrawWallet(await prove(kol.wallets[0]))).toEqual({
      ok: false,
      reason: "unknown_wallet",
    });
  });

  /**
   * A KOL who withdraws their only wallet can no longer act, and any cabal they
   * lead becomes an orphan. Allowed on purpose: refusing would mean a
   * compromised sole wallet could not be revoked, and a key you cannot revoke is
   * worse than a group that needs a nomination to repair.
   */
  it("allows the last wallet to go, leaving the KOL unable to act", async () => {
    const kol = await kolWith("ana", 1);
    expect(await withdrawWallet(await prove(kol.wallets[0]))).toEqual({
      ok: true,
      value: { handle: "ana", remaining: 0 },
    });
  });

  it("refuses a proof issued for another action", async () => {
    const kol = await kolWith("ana", 1);
    const request = await prove(kol.wallets[0], "retirar wallet", {
      nonceAction: "alta de perfil",
    });
    expect(await withdrawWallet(request)).toEqual({ ok: false, reason: "bad_proof" });
    const [row] = await query<{ status: string }>("SELECT status FROM kol_wallet");
    expect(row.status).toBe("active");
  });

  it("refuses a proof carrying a subject, which this action has none of", async () => {
    const kol = await kolWith("ana", 1);
    expect(await withdrawWallet(await prove(kol.wallets[0], "retirar wallet", { subject: "ARG" })))
      .toEqual({ ok: false, reason: "bad_input" });
  });

  it("refuses a wallet no approved KOL holds", async () => {
    await kolWith("beto", 1, "suspended");
    const stranger = wallet();
    expect(await withdrawWallet(await prove(stranger))).toEqual({
      ok: false,
      reason: "unknown_wallet",
    });
  });

  it("records the row's id and never an address", async () => {
    const kol = await kolWith("ana", 2);
    await withdrawWallet(await prove(kol.wallets[0]));
    const [entry] = await query<{ actor: string; action: string; target_id: string; dump: string }>(
      "SELECT actor, action, target_id, after::text AS dump FROM audit_log",
    );
    expect(entry.actor).toBe("@ana");
    expect(entry.action).toBe("retirar wallet");
    expect(entry.dump).not.toContain(kol.wallets[0].address);
    expect(entry.target_id).not.toContain(kol.wallets[0].address);
  });
});

/**
 * **The invariant this action exists for**, checked against the source rather
 * than against a promise.
 *
 * `docs/round-reasignacion.md` §0: while nothing in the product wrote
 * `status = 'withdrawn'`, that value was one only the operator could set by
 * hand — which made the orphan condition the reassignment path repairs a state
 * they could manufacture. This is what keeps the fix true: exactly one writer,
 * and it is the signed action.
 */
describe("only the signed action withdraws a wallet", () => {
  it("has exactly one writer of kol_wallet.status = 'withdrawn' in tracked source", () => {
    const files = execFileSync("git", ["ls-files", "src", "scripts"], { encoding: "utf8" })
      .split("\n")
      .filter((f) => f.endsWith(".ts") || f.endsWith(".tsx"))
      // Tests build fixtures in every state; the rule is about production paths.
      .filter((f) => !f.includes(".test."));

    const writers = files.filter((file) => {
      const source = readFileSync(file, "utf8");
      // An UPDATE that sets the column to 'withdrawn'. Deliberately loose: it is
      // better to ask about a false positive than to miss a second writer.
      return /SET\s+status\s*=\s*'withdrawn'/i.test(source);
    });

    expect(writers).toEqual(["src/lib/wallet-actions.ts"]);
  });

  it("has no admin route that touches wallet status at all", () => {
    const adminFiles = execFileSync("git", ["ls-files", "src/app/api/admin", "src/app/admin"], {
      encoding: "utf8",
    })
      .split("\n")
      .filter((f) => f.endsWith(".ts") || f.endsWith(".tsx"))
      .filter((f) => !f.includes(".test."));

    for (const file of adminFiles) {
      expect(readFileSync(file, "utf8"), file).not.toMatch(/withdrawn/i);
    }
  });
});
