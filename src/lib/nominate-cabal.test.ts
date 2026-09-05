import { beforeEach, describe, expect, it } from "vitest";
import { query } from "./db";
import { resetAuditLog } from "./fixtures/audit";
import { NOMINATION_DAYS, nominateCabal } from "./nominate-cabal";

/**
 * The admin's half of the repair: a standing offer that **moves nothing**.
 *
 * `docs/round-reasignacion.md` — the direct handover was deleted, not kept
 * beside this. Everything that actually changes hands is in `claimCabal`, which
 * is signed. What these cases pin is that nominating is inert.
 */
const REASON = "El líder perdió el acceso a su wallet y no hay co-líder.";
const ok = { confirmed: true, reason: REASON };

async function cabal(tag: string): Promise<string> {
  const id = crypto.randomUUID();
  await query("INSERT INTO cabal (id, tag, name) VALUES ($1::uuid, $2, $2)", [id, tag]);
  return id;
}

async function kol(
  handle: string,
  options: { status?: string; wallet?: "active" | "withdrawn" | "none"; cabalId?: string } = {},
): Promise<string> {
  const id = crypto.randomUUID();
  await query(
    `INSERT INTO kol (id, slug, display_name, x_handle, status, cabal_id, approved_at)
     VALUES ($1::uuid, $2, $2, $3::citext, $4, $5::uuid, now())`,
    [id, handle, handle, options.status ?? "approved", options.cabalId ?? null],
  );
  if ((options.wallet ?? "active") !== "none") {
    await query(
      `INSERT INTO kol_wallet (id, kol_id, chain, address_hmac, address_enc, status)
       VALUES (gen_random_uuid(), $1::uuid, 'solana', $2, $2, $3)`,
      [id, Buffer.from(id.replace(/-/g, ""), "hex"), options.wallet ?? "active"],
    );
  }
  return id;
}

async function lead(cabalId: string, kolId: string): Promise<void> {
  await query("UPDATE cabal SET leader_kol_id = $1::uuid WHERE id = $2::uuid", [kolId, cabalId]);
  await query("UPDATE kol SET cabal_id = $1::uuid WHERE id = $2::uuid", [cabalId, kolId]);
}

beforeEach(async () => {
  await query("UPDATE kol SET cabal_id = NULL");
  await query("TRUNCATE cabal_nomination, cabal_co_leader");
  await query("TRUNCATE kol, kol_wallet, cabal CASCADE");
  await resetAuditLog();
});

describe("nominateCabal", () => {
  /** The whole redesign, as one assertion: nominating changes nothing. */
  it("writes an offer and leaves the cabal exactly as it was", async () => {
    const id = await cabal("ARG");
    const gone = await kol("ana", { wallet: "withdrawn" });
    await lead(id, gone);
    const heir = await kol("beto");

    const result = await nominateCabal({ cabalId: id, handle: "@beto", ...ok });
    expect(result.ok && result.handle).toBe("beto");

    const [row] = await query<{
      leader_kol_id: string;
      reassigned_at: Date | null;
      reassigned_to_kol_id: string | null;
    }>(
      "SELECT leader_kol_id, reassigned_at, reassigned_to_kol_id FROM cabal WHERE id = $1::uuid",
      [id],
    );
    // Still the leader who cannot sign. Still orphaned. Nothing public.
    expect(row).toEqual({
      leader_kol_id: gone,
      reassigned_at: null,
      reassigned_to_kol_id: null,
    });
    const [member] = await query<{ cabal_id: string | null }>(
      "SELECT cabal_id FROM kol WHERE id = $1::uuid",
      [heir],
    );
    expect(member.cabal_id).toBeNull();
  });

  it("dates the offer seven days out", async () => {
    const id = await cabal("ARG");
    await lead(id, await kol("ana", { wallet: "withdrawn" }));
    await kol("beto");
    const result = await nominateCabal({ cabalId: id, handle: "beto", ...ok });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const days = (Date.parse(result.expiresAt) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(NOMINATION_DAYS - 0.01);
    expect(days).toBeLessThan(NOMINATION_DAYS + 0.01);
  });

  it("refuses a cabal that is not orphaned", async () => {
    const id = await cabal("ARG");
    await lead(id, await kol("ana"));
    await kol("beto");
    expect(await nominateCabal({ cabalId: id, handle: "beto", ...ok })).toEqual({
      ok: false,
      reason: "not_orphaned",
    });
  });

  /** The negative the brief names first: a nominee who is not an approved KOL. */
  it("refuses a nominee who is not an approved KOL", async () => {
    const id = await cabal("ARG");
    await lead(id, await kol("ana", { wallet: "withdrawn" }));
    await kol("beto", { status: "pending" });
    await kol("caro", { status: "suspended" });

    for (const handle of ["beto", "caro", "nadie"]) {
      expect(await nominateCabal({ cabalId: id, handle, ...ok })).toEqual({
        ok: false,
        reason: "unknown_kol",
      });
    }
    expect(await query("SELECT id FROM cabal_nomination")).toHaveLength(0);
  });

  it("refuses a nominee with no active wallet, who could never sign the claim", async () => {
    const id = await cabal("ARG");
    await lead(id, await kol("ana", { wallet: "withdrawn" }));
    await kol("beto", { wallet: "none" });
    // Refusing here rather than letting them find out is the difference between
    // a refusal and a dead end.
    expect(await nominateCabal({ cabalId: id, handle: "beto", ...ok })).toEqual({
      ok: false,
      reason: "cannot_lead",
    });
  });

  it("refuses a second live nomination, and allows one over an expired offer", async () => {
    const id = await cabal("ARG");
    await lead(id, await kol("ana", { wallet: "withdrawn" }));
    await kol("beto");
    await kol("caro");

    expect((await nominateCabal({ cabalId: id, handle: "beto", ...ok })).ok).toBe(true);
    // Two pending offers would be two people racing to sign a claim neither knew
    // the other held.
    expect(await nominateCabal({ cabalId: id, handle: "caro", ...ok })).toEqual({
      ok: false,
      reason: "already_nominated",
    });

    // Once it has expired the slot frees, without a cron having run.
    await query("UPDATE cabal_nomination SET expires_at = now() - interval '1 day'");
    expect((await nominateCabal({ cabalId: id, handle: "caro", ...ok })).ok).toBe(true);
    const rows = await query<{ status: string }>(
      "SELECT status FROM cabal_nomination ORDER BY nominated_at",
    );
    expect(rows.map((r) => r.status)).toEqual(["cancelled", "pending"]);
  });

  it("requires the confirmation and a reason that says something", async () => {
    const id = await cabal("ARG");
    await lead(id, await kol("ana", { wallet: "withdrawn" }));
    await kol("beto");
    expect(
      await nominateCabal({ cabalId: id, handle: "beto", reason: REASON, confirmed: false }),
    ).toEqual({ ok: false, reason: "not_confirmed" });
    expect(
      await nominateCabal({ cabalId: id, handle: "beto", reason: " ok ", confirmed: true }),
    ).toEqual({ ok: false, reason: "reason_required" });
  });

  it("records the offer with its reason, unsigned and inside the chain", async () => {
    const id = await cabal("ARG");
    await lead(id, await kol("ana", { wallet: "withdrawn" }));
    await kol("beto");
    await nominateCabal({ cabalId: id, handle: "beto", ...ok });

    const [entry] = await query<{
      actor: string;
      action: string;
      after: { nominated: string; reason: string };
      nonce: string | null;
      row_hash: string | null;
    }>("SELECT actor, action, after, nonce, row_hash FROM audit_log");
    expect(entry.actor).toBe("admin");
    expect(entry.action).toBe("cabal.nominate");
    expect(entry.after.nominated).toBe("@beto");
    // The reason lives here and only here.
    expect(entry.after.reason).toBe(REASON);
    // Nobody signed a nomination; the claim is what carries a signature.
    expect(entry.nonce).toBeNull();
    expect(entry.row_hash).not.toBeNull();
  });
});
