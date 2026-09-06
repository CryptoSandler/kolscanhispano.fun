import { addWallet, findWalletByAddress, setWalletVisibility } from "@/lib/wallets";
import { canonicalAddress, chainsForAddress, isChain, isChainActive } from "@/lib/chain";
import { query } from "@/lib/db";
import { rateLimited } from "@/lib/rate-limit";
import { readProfile } from "@/lib/profile";
import { kolFromSession, sessionTokenFrom } from "@/lib/session";

/**
 * Agregar una wallet pegando la dirección, y cambiar su visibilidad.
 *
 * **Sin firma, por el supersede del 2026-09-06** (`DECISIONES.md`,
 * `docs/clone-map.md` §11): el molde firma una vez para entrar y las demás se
 * pegan. Entran con `verified = false` y la pantalla las muestra como
 * `Esperando validación`, con el botón para firmar cuando el KOL quiera.
 *
 * **El riesgo aceptado, dicho acá también:** alguien puede anotar una wallet que
 * no es suya. Lo que lo acota:
 *
 *   - Una dirección pertenece a **un solo KOL**: el índice ciego es único por
 *     `(chain, address_hmac)` desde `migrations/011`, así que robarle la wallet
 *     a un KOL registrado es imposible — la respuesta lo dice y no dice de
 *     quién es, que sería confirmarle a un desconocido que esa dirección está
 *     en el padrón.
 *   - `verified = false` viaja a `/admin`, que puede darla de baja.
 *   - Nada de esto la publica: `is_public` sigue siendo una decisión aparte y
 *     entra en `false`.
 */

const MAX_WALLETS = 25;

function refuse(reason: string, status = 400): Response {
  return Response.json({ error: reason }, { status });
}

export async function POST(request: Request): Promise<Response> {
  const limited = await rateLimited(request, "registro");
  if (limited) return limited;

  const kolId = await kolFromSession(sessionTokenFrom(request));
  if (kolId === null) return refuse("unauthorized", 401);

  let payload: { address?: unknown; chain?: unknown };
  try {
    payload = (await request.json()) as typeof payload;
  } catch {
    return refuse("bad_json");
  }

  const { address, chain } = payload;
  if (typeof address !== "string" || typeof chain !== "string") return refuse("bad_wallet");
  if (!isChain(chain)) return refuse("bad_chain");
  // Una cadena apagada no es una opción: ofrecerla sería un control que no
  // funciona, y aceptarla por API sería el mismo error sin la pantalla.
  if (!isChainActive(chain)) return refuse("bad_chain");

  // La forma decide qué cadenas son posibles; que la elegida esté entre ellas es
  // lo que impide guardar una dirección de Solana como si fuera de BNB.
  if (!chainsForAddress(address).includes(chain)) return refuse("address_chain_mismatch");

  let canonical: string;
  try {
    canonical = canonicalAddress(address, chain);
  } catch {
    return refuse("bad_address");
  }

  const profile = await readProfile(kolId);
  if (profile === null) return refuse("not_found", 404);
  if (profile.wallets.length >= MAX_WALLETS) return refuse("too_many_wallets");

  const existing = await findWalletByAddress(canonical, chain);
  if (existing !== null) {
    // Sin decir de quién es. Que esté tomada es lo que el que pega necesita
    // saber; quién la tiene no es asunto suyo.
    return refuse(existing.kol_id === kolId ? "already_yours" : "address_taken", 409);
  }

  const walletId = await addWallet(kolId, canonical, chain);
  await query("UPDATE kol_wallet SET verified = false WHERE id = $1::uuid", [walletId]);

  return Response.json({ id: walletId, chain, verified: false, isPublic: false }, { status: 201 });
}

/**
 * El ojo por wallet, y `Ocultar todas`.
 *
 * `Ocultar todas` es una sola petición y no una por wallet: son N escrituras que
 * tienen que pasar o no pasar juntas, y un lector que toca "ocultar todas" y ve
 * la mitad oculta no sabe qué pasó.
 */
export async function PATCH(request: Request): Promise<Response> {
  const kolId = await kolFromSession(sessionTokenFrom(request));
  if (kolId === null) return refuse("unauthorized", 401);

  let payload: { walletId?: unknown; isPublic?: unknown; all?: unknown };
  try {
    payload = (await request.json()) as typeof payload;
  } catch {
    return refuse("bad_json");
  }

  if (payload.all === true) {
    // Sólo esconder. "Mostrar todas" no existe a propósito: publicar es una
    // decisión por wallet y un botón que las publica todas de una es la clase
    // de control que se toca sin querer.
    await query(
      "UPDATE kol_wallet SET is_public = false WHERE kol_id = $1::uuid AND status = 'active'",
      [kolId],
    );
    return new Response(null, { status: 204 });
  }

  const { walletId, isPublic } = payload;
  if (typeof walletId !== "string" || typeof isPublic !== "boolean") return refuse("bad_request");

  // `setWalletVisibility` toma el `kolId`, así que una wallet ajena no se toca
  // aunque el id sea válido.
  const changed = await setWalletVisibility(kolId, walletId, isPublic);
  if (!changed) return refuse("not_found", 404);

  return new Response(null, { status: 204 });
}
