import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { query } from "./db";
import {
  SESSION_COOKIE,
  clearedSessionCookie,
  closeAllSessions,
  closeSession,
  kolFromSession,
  openSession,
  sessionCookie,
  sessionTokenFrom,
} from "./session";

/**
 * La sesión del KOL. Supersede de spec §6 ("sin sesión"), 2026-09-06.
 *
 * Lo que se mide acá es que **la fila decide y la cookie no**: una cookie viva
 * cuya fila venció o fue revocada no entra, que es la razón por la que esto es
 * una tabla y no una cookie firmada.
 */
async function insertKol(slug: string): Promise<string> {
  const id = crypto.randomUUID();
  await query(
    // Tres parámetros y no uno repetido: las tres columnas no tienen el mismo
    // tipo declarado y Postgres refusa deducirlo ("inconsistent types deduced").
    `INSERT INTO kol (id, slug, display_name, x_handle, status, approved_at)
     VALUES ($1, $2, $3, $4, 'approved', now())`,
    [id, slug, slug, slug],
  );
  return id;
}

beforeEach(async () => {
  await query("TRUNCATE kol, kol_session CASCADE");
});

afterEach(async () => {
  await query("TRUNCATE kol, kol_session CASCADE");
});

describe("openSession", () => {
  it("hands back a token that resolves to its KOL", async () => {
    const kolId = await insertKol("uno");
    const { token } = await openSession(kolId);

    expect(await kolFromSession(token)).toBe(kolId);
  });

  it("stores the hash and never the token", async () => {
    // La fila no sirve para entrar: es la propiedad que hace que un dump de
    // `kol_session` no abra ninguna sesión.
    const kolId = await insertKol("uno");
    const { token } = await openSession(kolId);

    const rows = await query<{ token_hash: Buffer }>("SELECT token_hash FROM kol_session");
    expect(rows).toHaveLength(1);
    expect(rows[0].token_hash.toString("utf8")).not.toContain(token);
    expect(rows[0].token_hash.toString("base64url")).not.toBe(token);
    expect(rows[0].token_hash).toHaveLength(32);
  });

  it("gives two sessions two different tokens", async () => {
    const kolId = await insertKol("uno");
    const first = await openSession(kolId);
    const second = await openSession(kolId);

    expect(first.token).not.toBe(second.token);
    expect(await kolFromSession(first.token)).toBe(kolId);
    expect(await kolFromSession(second.token)).toBe(kolId);
  });
});

describe("kolFromSession", () => {
  it("refuses a token nobody issued", async () => {
    expect(await kolFromSession("no-existe")).toBeNull();
  });

  it("refuses no token at all", async () => {
    expect(await kolFromSession(null)).toBeNull();
  });

  it("refuses an expired session even though the cookie still says otherwise", async () => {
    // La cookie puede mentir sobre su vencimiento; `expires_at` no.
    const kolId = await insertKol("uno");
    const { token } = await openSession(kolId);
    await query("UPDATE kol_session SET expires_at = now() - interval '1 minute'");

    expect(await kolFromSession(token)).toBeNull();
  });

  it("refuses a revoked session", async () => {
    const kolId = await insertKol("uno");
    const { token } = await openSession(kolId);
    await closeSession(token, "kol");

    expect(await kolFromSession(token)).toBeNull();
  });
});

describe("closeSession", () => {
  it("is idempotent and keeps the first revocation's stamp", async () => {
    const kolId = await insertKol("uno");
    const { token } = await openSession(kolId);
    await closeSession(token, "kol");
    const [first] = await query<{ revoked_at: Date; revoked_by: string }>(
      "SELECT revoked_at, revoked_by FROM kol_session",
    );

    await closeSession(token, "admin");
    const [second] = await query<{ revoked_at: Date; revoked_by: string }>(
      "SELECT revoked_at, revoked_by FROM kol_session",
    );

    // Cerrar una sesión ya cerrada no la reabre ni reescribe quién la cerró.
    expect(second.revoked_at.toISOString()).toBe(first.revoked_at.toISOString());
    expect(second.revoked_by).toBe("kol");
  });
});

describe("closeAllSessions", () => {
  it("closes this KOL's live sessions and leaves another KOL's alone", async () => {
    const mine = await insertKol("uno");
    const theirs = await insertKol("otra");
    const a = await openSession(mine);
    const b = await openSession(mine);
    const untouched = await openSession(theirs);

    expect(await closeAllSessions(mine, "admin")).toBe(2);
    expect(await kolFromSession(a.token)).toBeNull();
    expect(await kolFromSession(b.token)).toBeNull();
    expect(await kolFromSession(untouched.token)).toBe(theirs);
  });
});

describe("the cookie itself", () => {
  it("is HttpOnly, SameSite=Strict and Secure outside development", () => {
    const cookie = sessionCookie("abc", true);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("Path=/");
  });

  it("drops Secure on localhost, or the browser discards it and the gate cannot log in", () => {
    expect(sessionCookie("abc", false)).not.toContain("Secure");
  });

  it("clears with the same Path, or the browser keeps the old one", () => {
    const cleared = clearedSessionCookie(true);
    expect(cleared).toContain("Max-Age=0");
    expect(cleared).toContain("Path=/");
    expect(cleared).toContain("HttpOnly");
  });

  it("reads its own cookie out of a request, and ignores the others", () => {
    const request = new Request("http://localhost/", {
      headers: { cookie: `otra=1; ${SESSION_COOKIE}=el-token; tercera=3` },
    });
    expect(sessionTokenFrom(request)).toBe("el-token");
  });

  it("returns null when there is no cookie header at all", () => {
    expect(sessionTokenFrom(new Request("http://localhost/"))).toBeNull();
  });
});
