import { canonicalAddress } from "@/lib/chain";
import { query } from "@/lib/db";
import { rateLimited } from "@/lib/rate-limit";
import { revealAddress } from "@/lib/wallets";
import { kolFromSession, sessionTokenFrom } from "@/lib/session";
import { consumeNonce, issueNonce } from "@/lib/wallet-proof-store";
import { PROOF_DOMAIN, verifyProof } from "@/lib/wallet-proof";
import { truncateAddressLong } from "@/lib/public-wallets";
import type { Chain } from "@/lib/chain";

/**
 * Validar una wallet pegada: probar con una firma que es de quien la anotó.
 *
 * Es el otro extremo del supersede del 2026-09-06. Pegar la dirección alcanza
 * para agregarla (`verified = false`, `Esperando validación`); firmar es lo que
 * la pasa a `validada`, que es la única etiqueta que el molde publica.
 *
 * ## El caso de la wallet equivocada
 *
 * Pedido del dueño, y copiado del molde: si la wallet conectada en la extensión
 * no es la que se está validando, el mensaje dice **cuál hay que poner y cuál
 * está puesta**, y **el nonce no se gasta**.
 *
 * Que no se gaste sale gratis y conviene decir por qué: `consumeNonce` quema en
 * un solo `UPDATE ... WHERE nonce = $1 AND address_hmac = $2`, así que una
 * dirección que no coincide simplemente no empata ninguna fila. Aun así se
 * comprueba **antes** de llamarlo, por dos razones: para poder decir *cuál* era
 * la esperada, y para que el refusal sea `wrong_wallet` y no `wrong_nonce` —
 * dos causas que se arreglan de forma distinta y que un mensaje genérico
 * confunde.
 *
 * La dirección esperada se dice **truncada**. El KOL ya la tiene: la pegó él.
 */

function refuse(reason: string, status = 400, extra: Record<string, unknown> = {}): Response {
  return Response.json({ error: reason, ...extra }, { status });
}

/** La wallet, si es de quien pide y todavía se puede validar. */
async function walletOf(kolId: string, walletId: string) {
  const rows = await query<{ id: string; chain: Chain; verified: boolean; status: string }>(
    `SELECT id, chain, verified, status FROM kol_wallet
      WHERE id = $1::uuid AND kol_id = $2::uuid`,
    [walletId, kolId],
  );
  return rows[0] ?? null;
}

/** Paso 1: pedir el nonce para esta wallet, y saber qué dirección hay que usar. */
export async function POST(request: Request): Promise<Response> {
  const limited = await rateLimited(request, "registro");
  if (limited) return limited;

  const kolId = await kolFromSession(sessionTokenFrom(request));
  if (kolId === null) return refuse("unauthorized", 401);

  let payload: { walletId?: unknown; address?: unknown; signature?: unknown; nonce?: unknown; expiresAt?: unknown };
  try {
    payload = (await request.json()) as typeof payload;
  } catch {
    return refuse("bad_json");
  }

  const { walletId } = payload;
  if (typeof walletId !== "string") return refuse("bad_request");

  const wallet = await walletOf(kolId, walletId);
  if (wallet === null) return refuse("not_found", 404);
  if (wallet.status !== "active") return refuse("wallet_inactive");
  if (wallet.verified) return refuse("already_verified", 409);

  /*
    La acción firmada es `agregar wallet`, que ya existe en `PROOF_ACTIONS` y
    significa exactamente esto. Inventar una nueva habría requerido una
    migración (`migrations/017` liga el nonce a su acción) para nombrar lo mismo.
  */
  const expected = await revealAddress(walletId);

  // Sin firma en el cuerpo, esto es el paso 1: se emite el nonce y se dice qué
  // dirección tiene que firmar.
  if (typeof payload.signature !== "string") {
    const issued = await issueNonce(expected, wallet.chain, "agregar wallet");
    return Response.json({
      nonce: issued.nonce,
      expiresAt: issued.expiresAt,
      chain: wallet.chain,
      expect: truncateAddressLong(expected),
    });
  }

  // Paso 2: llegó una firma.
  const { address, signature, nonce, expiresAt } = payload;
  if (typeof address !== "string" || typeof nonce !== "string" || typeof expiresAt !== "string") {
    return refuse("bad_request");
  }

  let connected: string;
  try {
    connected = canonicalAddress(address, wallet.chain);
  } catch {
    return refuse("bad_address");
  }

  /*
    **La comprobación que deja el nonce intacto.**

    Va antes de `consumeNonce` a propósito: comparar acá permite nombrar las dos
    direcciones en el mensaje, y deja el refusal como `wrong_wallet`. Después de
    quemar el nonce el lector tendría que pedir otro para reintentar, que es
    exactamente lo que el dueño pidió evitar.
  */
  if (connected !== expected) {
    return refuse("wrong_wallet", 409, {
      expect: truncateAddressLong(expected),
      connected: truncateAddressLong(connected),
    });
  }

  const claim = await consumeNonce(nonce, expected, wallet.chain, "agregar wallet");
  if (!claim.ok) return refuse(claim.reason);

  const proof = verifyProof({
    signature,
    fields: { domain: PROOF_DOMAIN, chain: wallet.chain, action: "agregar wallet", address: expected, nonce, expiresAt },
    expected: { domain: PROOF_DOMAIN, chain: wallet.chain, action: "agregar wallet", nonce },
    nowMs: Date.now(),
  });
  if (!proof.ok) return refuse("bad_proof");

  await query(
    "UPDATE kol_wallet SET verified = true, verified_at = now() WHERE id = $1::uuid",
    [walletId],
  );

  return Response.json({ id: walletId, verified: true });
}
