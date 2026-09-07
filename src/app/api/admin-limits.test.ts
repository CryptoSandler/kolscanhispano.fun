import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PUBLIC_LIMITS } from "@/lib/rate-limit";

/**
 * **Toda ruta de `/admin` corre el limitador, y una ruta nueva sin bucket falla
 * acá.**
 *
 * Las rutas de admin quedaron fuera de la tabla de límites porque piden
 * `ADMIN_TOKEN` y "no son públicas". Eso confunde dos cosas: cualquiera puede
 * **llamarlas**, y el token sólo decide si contestan 401 o hacen algo. Sin
 * límite, un desconocido puede pedirle a esta app que compare tokens todo el
 * día, que es el bucle con el que se adivina uno.
 *
 * **Es un escaneo de archivos**, como `rate-limit-wiring.test.ts` para las
 * públicas, y por la misma razón: la propiedad tiene que valer para las rutas
 * que todavía no existen, y eso no se prueba llamándolas una por una.
 */
const ROOT = join(process.cwd(), "src", "app", "api", "admin");

/** Los verbos que un handler de ruta puede exportar. */
const VERBS = ["GET", "POST", "PATCH", "PUT", "DELETE"];

function adminRoutes(): string[] {
  return execFileSync("git", ["ls-files", "src/app/api/admin"], {
    cwd: process.cwd(),
    encoding: "utf8",
  })
    .split("\n")
    .filter((file) => file.endsWith("/route.ts"));
}

describe("spec: every admin route is rate limited", () => {
  const routes = adminRoutes();

  it("finds the admin routes at all, so an empty glob cannot pass", () => {
    expect(routes.length).toBeGreaterThanOrEqual(4);
  });

  it("runs the limiter in every exported handler", () => {
    const offenders: string[] = [];
    for (const file of routes) {
      const source = readFileSync(join(process.cwd(), file), "utf8");
      for (const verb of VERBS) {
        const start = source.indexOf(`export async function ${verb}(`);
        if (start === -1) continue;
        // El cuerpo hasta el próximo export, que es donde tiene que estar.
        const nextExport = VERBS.map((other) =>
          source.indexOf(`export async function ${other}(`, start + 1),
        ).filter((index) => index > start);
        const end = nextExport.length > 0 ? Math.min(...nextExport) : source.length;
        const body = source.slice(start, end);
        if (!/rateLimited\(\s*request\s*,/.test(body)) {
          offenders.push(`${file.split("/api/").pop()} ${verb}`);
        }
      }
    }
    expect(
      offenders,
      "una ruta de admin no corre el limitador: agregale rateLimited con su bucket",
    ).toEqual([]);
  });

  it("uses a declared admin bucket and never a public one", () => {
    /*
      Reusar `feed` o `leaderboard` acá mezclaría el presupuesto de un
      desconocido con el de un admin: quien barra la ruta pública dejaría sin
      cupo al panel, que es la forma más silenciosa de negarle el servicio a la
      persona que administra el sitio.
    */
    const declared = Object.keys(PUBLIC_LIMITS).filter((name) => name.startsWith("admin-"));
    expect(declared.sort()).toEqual(["admin-read", "admin-write"]);

    const wrong: string[] = [];
    for (const file of routes) {
      const source = readFileSync(join(process.cwd(), file), "utf8");
      for (const [, bucket] of source.matchAll(/rateLimited\(\s*request\s*,\s*"([^"]+)"/g)) {
        if (!declared.includes(bucket)) wrong.push(`${file.split("/api/").pop()} -> ${bucket}`);
      }
    }
    expect(wrong, "una ruta de admin usa un bucket público").toEqual([]);
  });

  it("limits before it checks the token, which is the opposite of the public rule", () => {
    /*
      En una ruta pública el guard va primero: un 401 no debe costar una
      consulta. Acá lo que hay que encarecer **es** el 401, porque el 401 es el
      resultado de un intento de adivinar el token. El orden es la propiedad, no
      un detalle de escritura.
    */
    const outOfOrder: string[] = [];
    for (const file of routes) {
      const source = readFileSync(join(process.cwd(), file), "utf8");
      for (const verb of VERBS) {
        const start = source.indexOf(`export async function ${verb}(`);
        if (start === -1) continue;
        const body = source.slice(start, start + 2000);
        const limit = body.indexOf("rateLimited(");
        const auth = body.indexOf("isAdmin(");
        if (limit === -1 || auth === -1) continue;
        if (limit > auth) outOfOrder.push(`${file.split("/api/").pop()} ${verb}`);
      }
    }
    expect(outOfOrder, "el token se comprueba antes que el límite").toEqual([]);
  });
});
