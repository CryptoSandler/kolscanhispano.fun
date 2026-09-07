import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * **Quién puede descifrar una dirección, y quién no.**
 *
 * `crypto.ts` es el único módulo que lee `WALLET_ENC_KEY` y `WALLET_HMAC_KEY`.
 * Este archivo controla **quién lo importa** y con qué: `decrypt` y `encrypt`
 * son la capacidad de leer y escribir una dirección en claro; `blindIndex` y
 * `aadFor` no lo son —el índice ciego encuentra sin abrir, y la AAD es un
 * parámetro— y por eso se permiten en más lugares.
 *
 * **Es un escaneo de imports y no una prueba de comportamiento**, a propósito:
 * lo que hay que impedir es que *aparezca* un módulo nuevo con la capacidad, y
 * eso no se puede afirmar sobre módulos que todavía no existen. Es el mismo
 * patrón que `no-money-path.test.ts` y `pool-safety.test.ts`, que este
 * repositorio ya usa para dos invariantes parecidos.
 *
 * **Lo que NO cubre**, dicho también acá y en `SECURITY.md`: no impide que
 * alguien agregue su módulo a la lista de abajo. Lo que hace es que agregarlo
 * sea **un acto visible en el diff**, con un motivo escrito al lado, en vez de
 * un import que pasa desapercibido entre otros veinte.
 */

const ROOT = join(process.cwd(), "src");

/**
 * Los módulos que pueden **abrir** una dirección, y por qué.
 *
 * Cada línea es una razón, no un permiso: si la razón deja de valer, el módulo
 * sale de la lista.
 */
const MAY_DECRYPT: Record<string, string> = {
  "lib/crypto.ts": "es el módulo de la clave",
  "lib/public-wallets.ts": "la única lectura para superficie pública, filtrada por is_public",
  "lib/wallets.ts": "alta, baja y visibilidad de wallets",
  "lib/profile.ts": "el perfil que el KOL ve de sí mismo, truncado",
  "lib/feed.ts": "el feed de admin descifra firmas para el enlace al explorador",
  "lib/parse-swap.ts": "ingesta: descifra la firma del payload para parsearlo",
  "lib/helius-webhook.ts": "ingesta: resuelve la wallet de un evento entrante",
  "lib/audit-signature.ts": "verifica la firma de una entrada de auditoría",
};

/**
 * Los que pueden **escribir** un ciphertext pero nunca leerlo.
 *
 * **La distinción la encontró este mismo test en su primera corrida.** Los tenía
 * clasificados como "sólo índice" y los dos importan `encrypt`: `raw-tx.ts`
 * cifra el payload que entra por webhook, `roster.ts` cifra la dirección cuando
 * el admin da de alta un KOL. Los dos escriben y ninguno lee.
 *
 * Que sean capacidades distintas importa: `encrypt` no puede sacar una
 * dirección que ya está guardada, y `decrypt` sí. Meterlos en la misma lista
 * habría dado a ocho módulos un permiso que sólo seis necesitan.
 */
const MAY_ENCRYPT: Record<string, string> = {
  "lib/crypto.ts": "es el módulo de la clave",
  "lib/wallets.ts": "escribe la dirección al dar de alta una wallet",
  "lib/raw-tx.ts": "ingesta: cifra el payload entrante",
  "lib/roster.ts": "alta de KOL desde /admin",
  "lib/parse-swap.ts": "ingesta: cifra la firma al escribir el trade",
  "lib/audit-signature.ts": "firma una entrada de auditoría",
};

/** Los que sólo pueden **buscar** o construir la AAD, sin abrir ni escribir. */
const MAY_INDEX = new Set([
  "lib/rate-limit.ts",
  "lib/signed-action.ts",
  "lib/wallet-proof-store.ts",
  "lib/requeue-untracked.ts",
]);

function sourceFiles(): string[] {
  return execFileSync("git", ["ls-files", "src"], { cwd: process.cwd(), encoding: "utf8" })
    .split("\n")
    .filter((file) => /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file))
    .map((file) => file.replace(/^src\//, ""));
}

/** Lo que un archivo importa de `crypto.ts`, o `null` si no lo importa. */
function cryptoImports(relative: string): string[] | null {
  const source = readFileSync(join(ROOT, relative), "utf8");
  const match = /import\s*\{([^}]+)\}\s*from\s*"(?:\.\/|\.\.\/|@\/lib\/)crypto"/.exec(source);
  if (match === null) return null;
  return match[1]
    .split(",")
    .map((name) => name.trim().replace(/^type\s+/, ""))
    .filter(Boolean);
}

describe("spec: only named modules can open a wallet address", () => {
  const files = sourceFiles();

  it("scans a meaningful number of files, so an empty glob cannot pass it", () => {
    expect(files.length).toBeGreaterThan(40);
  });

  it("lets no unnamed module import decrypt or encrypt", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const imported = cryptoImports(file);
      if (imported === null) continue;
      if (imported.includes("decrypt") && !(file in MAY_DECRYPT)) {
        offenders.push(`${file} -> decrypt`);
      }
      if (imported.includes("encrypt") && !(file in MAY_ENCRYPT)) {
        offenders.push(`${file} -> encrypt`);
      }
    }
    expect(
      offenders,
      "un módulo nuevo puede abrir direcciones: agregalo a MAY_DECRYPT con su motivo, o no lo importes",
    ).toEqual([]);
  });

  it("keeps every allowed module honest: on the list means importing it", () => {
    /*
      La lista no puede envejecer hacia el otro lado. Un módulo que dejó de
      descifrar y quedó anotado ensancha el permiso sin que nadie lo note, y la
      próxima persona lo lee como "acá se puede".
    */
    const stale = Object.keys(MAY_DECRYPT).filter((file) => {
      if (file === "lib/crypto.ts") return false;
      const imported = cryptoImports(file);
      return imported === null || !imported.includes("decrypt");
    });
    expect(stale, "estos módulos ya no descifran: sacalos de MAY_DECRYPT").toEqual([]);
  });

  it("keeps the write-only modules unable to read", () => {
    // Escribir un ciphertext no es leer uno. Un módulo que cifra y empieza a
    // descifrar gana una capacidad distinta, y tiene que decir por qué.
    const readers = Object.keys(MAY_ENCRYPT).filter((file) => {
      if (file in MAY_DECRYPT) return false;
      return (cryptoImports(file) ?? []).includes("decrypt");
    });
    expect(readers, "un módulo que sólo escribía empezó a descifrar").toEqual([]);
  });

  it("keeps the index-only modules index-only", () => {
    // `blindIndex` encuentra sin abrir. Un módulo de esta lista que empiece a
    // cifrar o descifrar es un cambio de capacidad, no un import más.
    const promoted: string[] = [];
    for (const file of MAY_INDEX) {
      const imported = cryptoImports(file);
      if (imported === null) continue;
      if (imported.includes("decrypt") || imported.includes("encrypt")) promoted.push(file);
    }
    expect(promoted, "un módulo de sólo-índice empezó a descifrar").toEqual([]);
  });

  it("keeps the two keys distinct, which is what makes the split mean anything", () => {
    // Si `blindIndex` y `encrypt` usaran la misma clave, separar quién importa
    // cuál no protegería nada.
    const crypto = readFileSync(join(ROOT, "lib/crypto.ts"), "utf8");
    expect(crypto).toContain("WALLET_ENC_KEY");
    expect(crypto).toContain("WALLET_HMAC_KEY");
  });
});
