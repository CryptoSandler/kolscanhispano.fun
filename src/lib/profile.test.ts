import { beforeEach, describe, expect, it } from "vitest";
import { addWallet, setWalletVisibility } from "./wallets";
import { inventAddress, inventEvmAddress } from "./ids";
import { query } from "./db";
import { readProfile } from "./profile";

/**
 * El perfil que el KOL ve de sí mismo.
 *
 * **Este archivo existe por un error que llegó a correr.** `PROFILE_SQL`
 * ordenaba por `w.created_at`, y `kol_wallet` no tiene esa columna — se llama
 * `added_at`. La consulta tiraba `errorMissingColumn` en la primera petición
 * real y no la vio ninguna suite, porque no había ninguna. `tsc` no puede
 * revisar el texto de una consulta; un test que la ejecute, sí.
 */
async function insertKol(slug: string): Promise<string> {
  const id = crypto.randomUUID();
  await query(
    `INSERT INTO kol (id, slug, display_name, x_handle, status, approved_at)
     VALUES ($1, $2, $3, $4, 'approved', now())`,
    [id, slug, `Nombre de ${slug}`, slug],
  );
  return id;
}

beforeEach(async () => {
  await query("TRUNCATE kol, kol_wallet, cabal CASCADE");
});

describe("readProfile", () => {
  it("runs its query at all, which is what the missing column broke", async () => {
    const kolId = await insertKol("uno");
    const profile = await readProfile(kolId);

    expect(profile).not.toBeNull();
    expect(profile?.handle).toBe("uno");
    expect(profile?.wallets).toEqual([]);
  });

  it("returns null for a KOL that does not exist", async () => {
    expect(await readProfile(crypto.randomUUID())).toBeNull();
  });

  it("truncates every address, even the owner's own", async () => {
    /*
      El dueño ve `6...4` y no la dirección entera. Para reconocer cuál es cuál
      alcanza con los extremos, y la entera se puede copiar desde la wallet —
      que es de donde salió. Imprimirla acá la pondría en el HTML, en el payload
      y en cualquier captura de pantalla que el KOL comparta.
    */
    const kolId = await insertKol("uno");
    const address = inventAddress();
    await addWallet(kolId, address, "solana");

    const profile = await readProfile(kolId);
    expect(profile?.wallets).toHaveLength(1);
    expect(profile?.wallets[0].address).toMatch(/^.{6}\.\.\..{4}$/);
    expect(profile?.wallets[0].address).not.toBe(address);
  });

  it("says which wallets are validated and which are waiting", async () => {
    const kolId = await insertKol("uno");
    const signed = await addWallet(kolId, inventAddress(), "solana");
    const pasted = await addWallet(kolId, inventEvmAddress(), "bnb");
    await query("UPDATE kol_wallet SET verified = false WHERE id = $1::uuid", [pasted]);

    const profile = await readProfile(kolId);
    const byId = new Map(profile!.wallets.map((w) => [w.id, w]));
    expect(byId.get(signed)?.verified).toBe(true);
    expect(byId.get(pasted)?.verified).toBe(false);
  });

  it("carries each wallet's visibility, which is a separate decision", async () => {
    const kolId = await insertKol("uno");
    const hidden = await addWallet(kolId, inventAddress(), "solana");
    const shown = await addWallet(kolId, inventAddress(), "solana");
    await setWalletVisibility(kolId, shown, true);

    const profile = await readProfile(kolId);
    const byId = new Map(profile!.wallets.map((w) => [w.id, w]));
    expect(byId.get(hidden)?.isPublic).toBe(false);
    expect(byId.get(shown)?.isPublic).toBe(true);
  });

  it("leaves a withdrawn wallet out", async () => {
    const kolId = await insertKol("uno");
    const gone = await addWallet(kolId, inventAddress(), "solana");
    await query("UPDATE kol_wallet SET status = 'withdrawn' WHERE id = $1::uuid", [gone]);

    expect((await readProfile(kolId))?.wallets).toEqual([]);
  });

  it("never shows another KOL's wallets", async () => {
    const mine = await insertKol("uno");
    const theirs = await insertKol("otra");
    await addWallet(theirs, inventAddress(), "solana");

    expect((await readProfile(mine))?.wallets).toEqual([]);
  });
});
