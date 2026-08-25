/**
 * One KOL, one cabal, one wallet, one SOL price. Development only.
 *
 * The wallet address is generated, never copied from a real one: see
 * SECURITY.md. Re-running this returns the existing rows.
 */
import { query } from "../src/lib/db";
import { inventAddress } from "../src/lib/ids";
import { addWallet, revealAddress } from "../src/lib/wallets";

const HANDLE = "kolejemplo";

export async function seedDev() {
  const existing = await query<{ id: string }>("SELECT id FROM kol WHERE x_handle = $1", [HANDLE]);
  if (existing[0]) {
    const kolId = existing[0].id;
    const [wallet] = await query<{ id: string }>(
      "SELECT id FROM kol_wallet WHERE kol_id = $1 AND status = 'active' LIMIT 1", [kolId]);
    if (wallet) {
      return {
        kolId,
        walletId: wallet.id,
        address: await revealAddress(wallet.id),
      };
    }
    // Self-healing: KOL exists but no active wallet, create one
    const address = inventAddress();
    const walletId = await addWallet(kolId, address);
    return { kolId, walletId, address };
  }

  const cabalId = crypto.randomUUID();
  await query("INSERT INTO cabal (id, tag, name) VALUES ($1, 'EJE', 'Ejemplo')", [cabalId]);

  const kolId = crypto.randomUUID();
  await query(
    `INSERT INTO kol (id, slug, display_name, x_handle, cabal_id, status, approved_at)
     VALUES ($1, $2, $3, $4, $5, 'approved', now())`,
    [kolId, HANDLE, "KOL de Ejemplo", HANDLE, cabalId],
  );

  const address = inventAddress();
  const walletId = await addWallet(kolId, address);

  await query(
    `INSERT INTO sol_price (minute, usd) VALUES (date_trunc('minute', now()), 150)
     ON CONFLICT (minute) DO NOTHING`,
  );

  return { kolId, walletId, address };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { kolId } = await seedDev();
  // The address is deliberately not printed: it belongs in the database, not in
  // a terminal scrollback or a CI log.
  console.log(`seeded KOL ${kolId}`);
  process.exit(0);
}
