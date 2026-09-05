import { beforeEach, describe, expect, it } from "vitest";
import { query } from "./db";
import { readOrphanCabals } from "./orphan-cabals";

/**
 * The three ways a cabal ends up with nobody who can act on it, and — just as
 * important — the cases that look like it and are not.
 */
async function cabal(name: string, tag: string | null): Promise<string> {
  const id = crypto.randomUUID();
  await query("INSERT INTO cabal (id, tag, name) VALUES ($1::uuid, $2, $3)", [id, tag, name]);
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
  await query("TRUNCATE cabal_co_leader");
  await query("TRUNCATE kol, kol_wallet, cabal CASCADE");
});

describe("readOrphanCabals", () => {
  it("names the three ways a cabal loses everybody who can act", async () => {
    const noLeader = await cabal("Sin nadie", "AAA");

    const withdrawn = await cabal("Wallet retirada", "BBB");
    await lead(withdrawn, await kol("ana", { wallet: "withdrawn" }));

    const suspended = await cabal("Suspendido", "CCC");
    await lead(suspended, await kol("beto", { status: "suspended" }));

    expect(await readOrphanCabals()).toEqual([
      { id: noLeader, tag: "AAA", name: "Sin nadie", leaderHandle: null,
        reason: "sin líder", members: 0 },
      { id: withdrawn, tag: "BBB", name: "Wallet retirada", leaderHandle: "ana",
        reason: "líder sin wallet activa", members: 1 },
      { id: suspended, tag: "CCC", name: "Suspendido", leaderHandle: "beto",
        reason: "líder no aprobado", members: 1 },
    ]);
  });

  it("says nothing about a cabal whose leader can still sign", async () => {
    const live = await cabal("Vivo", "DDD");
    await lead(live, await kol("caro"));
    expect(await readOrphanCabals()).toEqual([]);
  });

  /** §4's decision, as a query: a deputy is exactly what stops it being an orphan. */
  it("is not an orphan while a co-leader exists, however gone the leader is", async () => {
    const id = await cabal("Con diputado", "EEE");
    const leader = await kol("ana", { wallet: "withdrawn" });
    await lead(id, leader);
    const deputy = await kol("caro", { cabalId: id });
    await query(
      "INSERT INTO cabal_co_leader (cabal_id, kol_id, slot) VALUES ($1::uuid, $2::uuid, 1)",
      [id, deputy],
    );

    expect(await readOrphanCabals()).toEqual([]);

    // And it becomes one the moment the deputy goes.
    await query("DELETE FROM cabal_co_leader");
    expect((await readOrphanCabals()).map((row) => row.tag)).toEqual(["EEE"]);
  });

  it("leaves a dissolved cabal out: it is finished, not stuck", async () => {
    const id = await cabal("Disuelto", "FFF");
    await query("UPDATE cabal SET dissolved_at = now() WHERE id = $1::uuid", [id]);
    expect(await readOrphanCabals()).toEqual([]);
  });

  it("counts the members, which is the stakes of leaving it stuck", async () => {
    const id = await cabal("Grande", "GGG");
    await lead(id, await kol("ana", { wallet: "none" }));
    await kol("beto", { cabalId: id });
    await kol("caro", { cabalId: id });
    expect((await readOrphanCabals())[0].members).toBe(3);
  });
});
