import { readProfile } from "@/lib/profile";
import { kolFromSession, sessionTokenFrom } from "@/lib/session";

/**
 * El perfil del KOL que está mirando. Sin sesión, 401.
 *
 * **No toma un id de ningún lado.** El KOL sale de la sesión y nada más: una
 * ruta que aceptara `?kolId=` sería una forma de leer el perfil de otro, con
 * sus wallets adentro, y no hay parámetro que valga la pena aceptar acá.
 *
 * `no-store`: es la pantalla de una persona sobre sus propias wallets y no
 * puede quedar en ninguna caché intermedia.
 */
export async function GET(request: Request): Promise<Response> {
  const kolId = await kolFromSession(sessionTokenFrom(request));
  if (kolId === null) return new Response("unauthorized", { status: 401 });

  const profile = await readProfile(kolId);
  if (profile === null) return new Response("not found", { status: 404 });

  return Response.json(profile, { headers: { "cache-control": "no-store" } });
}
