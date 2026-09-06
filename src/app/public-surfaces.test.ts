import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * **Ninguna superficie pública sirve operaciones individuales.**
 *
 * Decisión del dueño, 2026-09-06. El motivo es concreto y no es una precaución
 * general: una fila con el token, el monto exacto y la hora alcanza para
 * encontrar esa transacción en un explorador de bloques y, con ella, la wallet
 * — aunque la wallet nunca se haya publicado y aunque la firma viniera en
 * `null`. El monto y el minuto identifican la operación igual.
 *
 * Eso contradecía lo que el sitio promete en el modal de conexión, así que el
 * feed público se eliminó (`/en-vivo` es un 308), `/api/feed` pasó a pedir
 * `ADMIN_TOKEN`, y `list-defi-trades` salió del modal del KOL.
 *
 * **Lo que este archivo cuida es que no vuelva.** Es un escaneo de código y no
 * una prueba de comportamiento, a propósito: una ruta nueva que devolviera
 * operaciones pasaría cualquier test que no supiera que existe. Lo que se puede
 * afirmar sobre *todas* las rutas es una propiedad de la forma del código.
 *
 * Lo que **no** cubre: una ruta que sirva operaciones sin nombrar a ninguna de
 * las funciones de abajo. Es un guard contra la regresión distraída, no contra
 * alguien decidido; lo dice `SECURITY.md` y se dice acá.
 */

const ROOT = join(process.cwd(), "src", "app");

/** Las lecturas que devuelven filas de operaciones, una por una. */
const TRADE_READERS = ["readFeedPage", "readFeed", "readKolTrades"];

/** Rutas que sí pueden leerlas: son de admin y piden token. */
const ALLOWED = new Set(["api/feed/route.ts"]);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

describe("spec: public surfaces carry period aggregates, never single transactions", () => {
  const files = walk(ROOT);

  it("scans a meaningful number of files, so an empty glob cannot pass it", () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it("has no public route or page that reads individual trades", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const relative = file.slice(ROOT.length + 1);
      if (ALLOWED.has(relative)) continue;
      const source = readFileSync(file, "utf8");
      for (const reader of TRADE_READERS) {
        // La palabra tiene que aparecer como llamada o import, no dentro de un
        // comentario que explique por qué ya no se usa.
        const called = new RegExp(String.raw`(?<![\w.])` + reader + String.raw`\s*\(`).test(
          stripComments(source),
        );
        if (called) offenders.push(`${relative} -> ${reader}`);
      }
    }
    expect(offenders, "una superficie pública volvió a leer operaciones").toEqual([]);
  });

  it("keeps the admin feed behind the token, which is what makes it the exception", () => {
    const route = readFileSync(join(ROOT, "api/feed/route.ts"), "utf8");
    expect(route).toContain("isAdmin(");
    /*
      El guard antes que cualquier lectura: un 401 no debe costar una consulta.
      Se compara contra la **llamada** y no contra el import, que vive arriba de
      todo — la primera versión de este caso comparaba con el import y medía el
      orden de las líneas de import, que no es la propiedad.
    */
    const body = route.slice(route.indexOf("export async function GET"));
    expect(body.indexOf("isAdmin(")).toBeLessThan(body.indexOf("readFeedPage("));
  });

  it("answers /en-vivo with a redirect rather than a feed", () => {
    const page = readFileSync(join(ROOT, "en-vivo/page.tsx"), "utf8");
    expect(page).toContain("permanentRedirect");
    expect(page).not.toContain("FeedLive");
  });

  it("serialises no trade array onto the KOL detail payload", () => {
    const serialize = readFileSync(join(process.cwd(), "src", "lib", "serialize.ts"), "utf8");
    expect(stripComments(serialize)).not.toMatch(/^\s*trades:/m);
  });
});

/** Comentarios fuera, para que una nota que nombra la función no cuente. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}
