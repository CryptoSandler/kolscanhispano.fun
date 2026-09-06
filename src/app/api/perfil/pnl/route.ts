import { query } from "@/lib/db";
import { rateLimited } from "@/lib/rate-limit";
import { kolFromSession, sessionTokenFrom } from "@/lib/session";

/**
 * `Actualizar PnL`: marca las posiciones del KOL para que el cron las recalcule.
 *
 * **No recalcula acá.** El recálculo es `recompute-dirty`, que corre en el cron
 * y toma el lock de la suite; hacerlo dentro de una petición sería una petición
 * que tarda lo que tarde la cadena y que dos lectores pueden disparar a la vez.
 * Lo que esta ruta hace es lo que el botón promete de verdad: **pedir** el
 * recálculo. La respuesta dice cuántas posiciones quedaron marcadas, que es lo
 * que la pantalla puede afirmar sin mentir.
 *
 * Con rate limit propio: es el único botón de esta pantalla que provoca trabajo
 * fuera de ella, y un lector impaciente no debe poder marcar lo mismo cien
 * veces.
 */
export async function POST(request: Request): Promise<Response> {
  const limited = await rateLimited(request, "registro");
  if (limited) return limited;

  const kolId = await kolFromSession(sessionTokenFrom(request));
  if (kolId === null) return new Response("unauthorized", { status: 401 });

  const rows = await query<{ id: string }>(
    `UPDATE position SET dirty = true
      WHERE kol_id = $1::uuid AND dirty = false
      RETURNING id`,
    [kolId],
  );

  return Response.json({ queued: rows.length });
}
