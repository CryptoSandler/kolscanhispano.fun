import { clearedSessionCookie, closeSession, sessionTokenFrom } from "@/lib/session";

/**
 * `salir`: cierra la sesión de quien la pide.
 *
 * **Cierra la fila y borra la cookie, en ese orden.** Sólo borrar la cookie
 * dejaría la sesión viva del lado del servidor: cualquiera que hubiera copiado
 * el token seguiría entrando. Sólo cerrar la fila dejaría al navegador mandando
 * una cookie muerta en cada petición.
 *
 * **Responde 204 aunque no hubiera sesión.** No hay nada que un llamador sin
 * sesión pueda aprender de esta ruta, y distinguir "cerré la tuya" de "no
 * tenías" sería decirle a alguien con una cookie ajena si le sirve.
 *
 * `POST` y no `GET`: cerrar sesión cambia estado, y un `GET` lo dispararía
 * cualquier cosa que precargue enlaces. `SameSite=Strict` en la cookie es lo
 * que hace que no haga falta un token CSRF además.
 */
export async function POST(request: Request): Promise<Response> {
  const token = sessionTokenFrom(request);
  if (token) await closeSession(token, "kol");

  return new Response(null, {
    status: 204,
    headers: { "set-cookie": clearedSessionCookie(process.env.NODE_ENV === "production") },
  });
}
