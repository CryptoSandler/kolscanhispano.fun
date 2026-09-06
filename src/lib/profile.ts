import { aadFor, decrypt } from "./crypto";
import { query } from "./db";
import type { Chain } from "./chain";
import { truncateAddressLong } from "./public-wallets";

/**
 * El perfil que el KOL ve de sí mismo.
 *
 * **Es la única superficie donde alguien ve una dirección propia entera**, y por
 * eso vive en su propio módulo con su propia lectura: `public-wallets.ts` es
 * para lo público y filtra por `is_public`; esto es para el dueño de las
 * wallets, autenticado por sesión, y no filtra por nada más que su `kol_id`.
 *
 * Aun así devuelve la dirección **truncada** (`6…4`). Un perfil que imprimiera
 * la dirección entera la pondría en el HTML, en el payload y en cualquier
 * captura de pantalla que el KOL comparta — y para lo que la pantalla necesita
 * (reconocer cuál es cuál) alcanza con los extremos. La entera se puede copiar
 * desde la wallet, que es de donde salió.
 */

export type ProfileWallet = {
  id: string;
  chain: Chain;
  /** `6…4`, nunca entera. */
  address: string;
  isPublic: boolean;
  /**
   * `true` cuando la propiedad se probó con una firma.
   *
   * Las pegadas a mano entran en `false` y la pantalla las muestra como
   * `Esperando validación`, con el botón para firmar. Es interno en el sentido
   * de que ninguna superficie pública lo lee — pero el dueño de la wallet sí lo
   * ve, porque es su estado y puede cambiarlo.
   */
  verified: boolean;
  status: string;
};

export type Profile = {
  kolId: string;
  slug: string;
  name: string;
  handle: string;
  /** El handle probado por tweet firmado. Distinto de `wallet.verified`. */
  handleVerified: boolean;
  avatarUrl: string;
  cabalTag: string | null;
  wallets: ProfileWallet[];
};

type Row = {
  kol_id: string;
  slug: string;
  display_name: string;
  x_handle: string;
  handle_verified: boolean;
  cabal_tag: string | null;
  wallet_id: string | null;
  chain: Chain | null;
  address_enc: Buffer | null;
  is_public: boolean | null;
  verified: boolean | null;
  status: string | null;
};

const PROFILE_SQL = `
  SELECT k.id AS kol_id, k.slug, k.display_name, k.x_handle,
         (k.tweet_verified_at IS NOT NULL) AS handle_verified,
         c.tag AS cabal_tag,
         w.id AS wallet_id, w.chain, w.address_enc, w.is_public, w.verified, w.status
    FROM kol k
    LEFT JOIN cabal c ON c.id = k.cabal_id
    LEFT JOIN kol_wallet w ON w.kol_id = k.id AND w.status <> 'withdrawn'
   WHERE k.id = $1::uuid
   ORDER BY w.chain, w.added_at`;

export async function readProfile(kolId: string): Promise<Profile | null> {
  const rows = await query<Row>(PROFILE_SQL, [kolId]);
  const first = rows[0];
  if (!first) return null;

  const wallets: ProfileWallet[] = [];
  for (const row of rows) {
    if (row.wallet_id === null || row.address_enc === null || row.chain === null) continue;
    let address: string;
    try {
      address = decrypt(row.address_enc, aadFor("kol_wallet", "address", row.wallet_id));
    } catch {
      /*
        Un ciphertext que no abre se **omite**, no se adivina y no se muestra
        roto. La wallet existe y el KOL no la ve: es visible desde `/admin`, que
        es donde se arregla. Mostrar la fila con la dirección en blanco haría
        que el dueño creyera que la wallet se perdió.
      */
      continue;
    }
    wallets.push({
      id: row.wallet_id,
      chain: row.chain,
      address: truncateAddressLong(address),
      isPublic: row.is_public === true,
      verified: row.verified === true,
      status: row.status ?? "active",
    });
  }

  return {
    kolId: first.kol_id,
    slug: first.slug,
    name: first.display_name,
    handle: first.x_handle,
    handleVerified: first.handle_verified === true,
    avatarUrl: `/api/avatar/${first.kol_id}`,
    cabalTag: first.cabal_tag,
    wallets,
  };
}
