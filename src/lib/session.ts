import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { query } from "./db";

/**
 * La sesión del KOL: la cookie que emite firmar el nonce.
 *
 * **Supersede de spec §6 ("sin sesión"), decisión del dueño del 2026-09-06**,
 * anotada en `DECISIONES.md`. El perfil —"Mis wallets", agregar, ocultar,
 * exportar— necesita saber quién mira, y eso es una sesión.
 *
 * ## Lo que la cookie es y lo que no
 *
 * - **`HttpOnly`**: JavaScript no la lee, así que un XSS no se la lleva.
 * - **`SameSite=Strict`**: no viaja en una petición que nazca en otro sitio, que
 *   es la defensa contra CSRF sin token adicional. Cuesta que un enlace externo
 *   a `/mi-cabal` llegue sin sesión y haya que entrar de nuevo; es el precio y
 *   es barato.
 * - **`Secure`** fuera de desarrollo. En `localhost` no, o el navegador la tira
 *   y el gate visual no puede entrar.
 * - **30 días**, y la fila manda: la cookie puede mentir sobre su vencimiento,
 *   `expires_at` no.
 *
 * ## El token se guarda hasheado
 *
 * `token_hash` es SHA-256 del valor que viaja. La fila **no sirve para entrar**:
 * un dump de `kol_session` no abre ninguna sesión. Es el mismo razonamiento que
 * una tabla de contraseñas, y la razón por la que no hace falta cifrarla.
 *
 * SHA-256 crudo y no un KDF a propósito: el token son 32 bytes aleatorios, no
 * una contraseña elegida por una persona, así que no hay diccionario contra el
 * que defenderse y el costo de un KDF no compra nada.
 */

/** El nombre de la cookie. Sin prefijo `__Host-` porque en `localhost` no aplica. */
export const SESSION_COOKIE = "kh_session";

/** Treinta días, en segundos y en milisegundos. La fila es la que manda. */
export const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
const SESSION_TTL_MS = SESSION_TTL_SECONDS * 1000;

function hash(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

/**
 * Abre una sesión y devuelve el token en claro **una vez**.
 *
 * Es el único momento en que el valor existe fuera de la cookie del lector: se
 * escribe el hash y se devuelve el original para armar el `Set-Cookie`.
 */
export async function openSession(kolId: string): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await query(
    "INSERT INTO kol_session (token_hash, kol_id, expires_at) VALUES ($1, $2::uuid, $3)",
    [hash(token), kolId, expiresAt.toISOString()],
  );
  return { token, expiresAt };
}

/**
 * El KOL de una sesión viva, o `null`.
 *
 * **La fila decide, no la cookie.** Se comprueba `revoked_at IS NULL` y
 * `expires_at > now()` en la consulta: una cookie que sobrevivió a su
 * vencimiento, o cuya sesión el admin cerró, no entra.
 */
export async function kolFromSession(token: string | null): Promise<string | null> {
  if (!token) return null;
  const rows = await query<{ kol_id: string }>(
    `SELECT kol_id FROM kol_session
      WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now()`,
    [hash(token)],
  );
  return rows[0]?.kol_id ?? null;
}

/**
 * Cierra una sesión. Idempotente: cerrar una ya cerrada no la reabre ni falla.
 *
 * `revoked_by` distingue quién la cerró — el propio KOL con `salir`, o un admin.
 * `audit_log` guarda el hecho cuando el que cierra es un admin; cuando es el
 * dueño de la sesión no hay nada que auditar más allá de la fila.
 */
export async function closeSession(token: string, by: string): Promise<void> {
  await query(
    `UPDATE kol_session SET revoked_at = now(), revoked_by = $2
      WHERE token_hash = $1 AND revoked_at IS NULL`,
    [hash(token), by],
  );
}

/** Cierra todas las sesiones vivas de un KOL. Lo usa el admin. */
export async function closeAllSessions(kolId: string, by: string): Promise<number> {
  const rows = await query<{ token_hash: Buffer }>(
    `UPDATE kol_session SET revoked_at = now(), revoked_by = $2
      WHERE kol_id = $1::uuid AND revoked_at IS NULL
      RETURNING token_hash`,
    [kolId, by],
  );
  return rows.length;
}

/**
 * El `Set-Cookie` de una sesión recién abierta.
 *
 * Se arma acá y no en cada ruta para que los cinco atributos vivan en un solo
 * lugar: olvidarse de `HttpOnly` en una de tres rutas es la clase de diferencia
 * que nadie ve en una revisión.
 */
export function sessionCookie(token: string, secure: boolean): string {
  const attributes = [
    `${SESSION_COOKIE}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${SESSION_TTL_SECONDS}`,
  ];
  if (secure) attributes.push("Secure");
  return attributes.join("; ");
}

/** El `Set-Cookie` que la borra. Mismo `Path`, o el navegador deja la vieja. */
export function clearedSessionCookie(secure: boolean): string {
  const attributes = [`${SESSION_COOKIE}=`, "Path=/", "HttpOnly", "SameSite=Strict", "Max-Age=0"];
  if (secure) attributes.push("Secure");
  return attributes.join("; ");
}

/** Lee la cookie de sesión de una petición, sin depender de `next/headers`. */
export function sessionTokenFrom(request: Request): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === SESSION_COOKIE) return rest.join("=") || null;
  }
  return null;
}

/**
 * Comparación en tiempo constante, exportada para el test que la usa.
 *
 * No la usa `kolFromSession` —ahí la comparación la hace Postgres sobre el
 * hash, por índice— pero existe para cualquier comparación de tokens que se
 * agregue después, para que nadie escriba `===` sobre un secreto.
 */
export function tokensMatch(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
