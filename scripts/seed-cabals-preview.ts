/**
 * A cabal fixture for the preview branch, so the owner can walk `/mi-cabal`,
 * `/admin` and the public routes against real rows.
 *
 * **It refuses to run anywhere but preview.** The same guard `seed-preview.ts`
 * uses and for the same reason: this writes KOLs, wallets and cabals, and the
 * one database it must never meet is the one people are looking at.
 *
 * Everything is invented — `ids.ts` is the generator every fixture uses, so no
 * real address reaches tracked source (`SECURITY.md` §8.3). The one exception is
 * deliberate: a **burner keypair** is generated at run time and written to a
 * file outside the repository, because a browser wallet cannot sign for an
 * address nobody holds the key to, and walking `/mi-cabal` means signing.
 */
import { writeFileSync } from "node:fs";
import { ed25519 } from "@noble/curves/ed25519.js";
import bs58 from "bs58";
import { loadEnvLocal } from "../src/lib/env";
loadEnvLocal();

import { aadFor, blindIndex, encrypt } from "../src/lib/crypto";
import { query } from "../src/lib/db";
import type { Chain } from "../src/lib/chain";
import { inventAddress, inventEvmAddress, inventSignature } from "../src/lib/ids";

const OUT = process.argv[2] ?? "/tmp/kh-preview-wallet.txt";

async function guard(): Promise<void> {
  const target = process.env.DATABASE_URL ?? "";
  const preview = process.env.PREVIEW_DATABASE_URL ?? "";
  if (!preview) throw new Error("PREVIEW_DATABASE_URL is not set");
  // Compared by host, because the pooled and direct spellings of one branch are
  // the same database and a string comparison would call them different.
  if (new URL(target).hostname.replace("-pooler", "") !== new URL(preview).hostname.replace("-pooler", "")) {
    throw new Error("refusing: DATABASE_URL is not the preview branch");
  }
}

async function kol(
  handle: string,
  options: { chains?: Chain[]; withdrawn?: boolean; cabalId?: string | null; isPublic?: boolean } = {},
): Promise<string> {
  const id = crypto.randomUUID();
  await query(
    // `$2` and `$4` are the same string on purpose: `slug` is TEXT and
    // `x_handle` is CITEXT, and binding one parameter to both makes Postgres
    // refuse with "inconsistent types deduced for parameter". Same trap as
    // `cabal-actions.test.ts` hit.
    `INSERT INTO kol (id, slug, display_name, x_handle, status, cabal_id, approved_at, hide_wallets)
     VALUES ($1::uuid, $2, $3, $4::citext, 'approved', $5::uuid, now(), TRUE)`,
    [id, handle, handle.replace(/_/g, " "), handle, options.cabalId ?? null],
  );
  for (const chain of options.chains ?? ["solana"]) {
    const address = chain === "solana" ? inventAddress() : inventEvmAddress();
    const walletId = crypto.randomUUID();
    await query(
      // **The AAD is the wallet's own id**, which is what `wallets.ts` binds it
      // to — so the id is generated here rather than by the database. Binding it
      // to the KOL is the bug that made every published chip disappear once.
      `INSERT INTO kol_wallet (id, kol_id, chain, address_hmac, address_enc, status, is_public)
       VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7)`,
      [
        walletId,
        id,
        chain,
        blindIndex(address, "address"),
        encrypt(address, aadFor("kol_wallet", "address", walletId)),
        options.withdrawn ? "withdrawn" : "active",
        options.isPublic ?? false,
      ],
    );
  }
  return id;
}

/**
 * A realized sell for one KOL, hours ago.
 *
 * **The board needs these to render at all.** `CabalsBoard` shows its empty
 * state when nothing closed anywhere — `DESIGN.md`'s "no zeroed rows", the same
 * rule the ranking follows — so a fixture with cabals and no trades produces a
 * correct screen that is useless to look at. Found by seeding without them.
 *
 * Placed a few hours back, not at a fixed hour: every window on this site is
 * rolling, so a trade must sit inside `now - 1d` to count, and midday would be
 * in the future for a run before noon.
 */
async function sell(
  kolId: string,
  sol: string,
  usd: string | null,
  hoursAgo: number,
  chain: Chain = "solana",
): Promise<void> {
  // The wallet must be on the chain the trade claims: `migrations/011` ties them
  // with a composite foreign key so an ingestor cannot file a BNB trade against
  // a Solana wallet.
  const [wallet] = await query<{ id: string }>(
    `SELECT id FROM kol_wallet
      WHERE kol_id = $1::uuid AND chain = $2 AND status = 'active' LIMIT 1`,
    [kolId, chain],
  );
  if (!wallet) return;
  /*
    **La firma se cifra de verdad, y el id se arma acá.**

    Hasta el 2026-09-06 esta consulta escribía `signature_enc` con
    `decode($1,'hex')` — **los mismos bytes que el HMAC**, que no son un
    ciphertext de nada. Ninguna de esas filas se podía descifrar, así que
    `readFeed` tiraba `a trade signature could not be decrypted` por cada una y
    el overlay de Next mostraba el aviso en el gate. El dato no se perdía: el
    feed devolvía `null` y la fila decía `PRIVADO`, que es la ruta de "no se
    pudo abrir" haciéndose pasar por "esta wallet es privada" — dos estados
    distintos con la misma cara.

    El atajo tenía una razón: el id salía de `gen_random_uuid()` en SQL, y la
    AAD necesita el id **antes** del insert. Se arma en JS y el problema
    desaparece.
  */
  const tradeId = crypto.randomUUID();
  const signature = inventSignature();
  await query(
    `INSERT INTO trade (id, signature_hmac, signature_enc, instruction_index, kol_id, wallet_id,
                        mint, chain, side, token_amount, sol_amount, usd_amount, sol_usd, fee_sol,
                        basis, block_time, realized_sol, realized_usd)
     VALUES ($9::uuid, decode($1, 'hex'), decode($10, 'hex'), 0, $2::uuid, $3::uuid,
             $4, $8, 'sell', 1, $5::numeric, COALESCE($6::numeric, 0), 150, 0,
             'known', now() - ($7 || ' hours')::interval, $5::numeric, $6::numeric)`,
    [
      blindIndex(signature, "signature").toString("hex"),
      kolId,
      wallet.id,
      inventAddress(),
      sol,
      usd,
      String(hoursAgo),
      chain,
      tradeId,
      encrypt(signature, aadFor("trade", "signature", tradeId)).toString("hex"),
    ],
  );
}

async function cabal(tag: string, name: string, color: string): Promise<string> {
  const id = crypto.randomUUID();
  await query(
    `INSERT INTO cabal (id, tag, name, color, created_by) VALUES ($1::uuid, $2, $3, $4, 'leader')`,
    [id, tag, name, color],
  );
  return id;
}

async function main(): Promise<void> {
  await guard();

  // Clear only what this fixture owns, by slug prefix, so a preview roster
  // seeded by `seed-preview.ts` is left alone.
  //
  // **Order matters and it bit on the first run.** A fixture KOL is referenced
  // by `cabal.leader_kol_id` and `cabal.reassigned_to_kol_id`, so deleting the
  // KOL first is refused by the foreign key. Every pointer at them is dropped
  // before they are.
  const owned = "(SELECT id FROM kol WHERE slug LIKE 'prueba_%')";
  await query(`UPDATE cabal SET leader_kol_id = NULL WHERE leader_kol_id IN ${owned}`);
  await query(`UPDATE cabal SET reassigned_to_kol_id = NULL WHERE reassigned_to_kol_id IN ${owned}`);
  await query("UPDATE kol SET cabal_id = NULL WHERE slug LIKE 'prueba_%'");
  await query(`DELETE FROM cabal_co_leader WHERE kol_id IN ${owned}`);
  await query(`DELETE FROM cabal_nomination WHERE kol_id IN ${owned}`);
  await query(`DELETE FROM cabal_request WHERE kol_id IN ${owned}`);
  await query(`DELETE FROM trade WHERE kol_id IN ${owned}`);
  await query(`DELETE FROM position WHERE kol_id IN ${owned}`);
  await query(`DELETE FROM pnl_daily WHERE kol_id IN ${owned}`);
  await query(`DELETE FROM pnl_position_daily WHERE kol_id IN ${owned}`);
  await query(`DELETE FROM kol_wallet WHERE kol_id IN ${owned}`);
  await query("DELETE FROM kol WHERE slug LIKE 'prueba_%'");
  // And the cabals themselves, once nothing points at them.
  await query("DELETE FROM cabal_nomination WHERE cabal_id IN (SELECT id FROM cabal WHERE tag IN ('PRA','PRB'))");
  await query("DELETE FROM cabal_request WHERE cabal_id IN (SELECT id FROM cabal WHERE tag IN ('PRA','PRB'))");
  await query("DELETE FROM cabal_co_leader WHERE cabal_id IN (SELECT id FROM cabal WHERE tag IN ('PRA','PRB'))");
  await query("UPDATE kol SET cabal_id = NULL WHERE cabal_id IN (SELECT id FROM cabal WHERE tag IN ('PRA','PRB'))");
  await query("DELETE FROM cabal WHERE tag IN ('PRA','PRB')");

  // 1. The burner, so a browser wallet can actually sign. It leads a cabal, so
  //    every leader action is reachable: nombrar, aceptar, expulsar, transferir,
  //    disolver.
  const secret = ed25519.utils.randomSecretKey();
  const publicKey = ed25519.getPublicKey(secret);
  const address = bs58.encode(publicKey);
  // Phantom imports the 64-byte secret||public form, base58.
  const importable = bs58.encode(Buffer.concat([Buffer.from(secret), Buffer.from(publicKey)]));

  const live = await cabal("PRA", "Cabal de prueba", "a");
  const leader = crypto.randomUUID();
  await query(
    `INSERT INTO kol (id, slug, display_name, x_handle, status, cabal_id, approved_at, hide_wallets)
     VALUES ($1::uuid, 'prueba_lider', 'Prueba lider', 'prueba_lider'::citext, 'approved',
             $2::uuid, now(), TRUE)`,
    [leader, live],
  );
  await query(
    `INSERT INTO kol_wallet (id, kol_id, chain, address_hmac, address_enc, status, is_public)
     VALUES (gen_random_uuid(), $1::uuid, 'solana', $2, $3, 'active', FALSE)`,
    [leader, blindIndex(address, "address"), encrypt(address, aadFor("kol_wallet", "address", leader))],
  );
  // A second wallet on the EVM side, so the leader's row shows two chain columns.
  // One wallet per EVM chain the leader trades on. The AAD binds to the wallet's
  // own id, so each row generates its own.
  for (const chain of ["robinhood", "bnb"] as const) {
    const walletId = crypto.randomUUID();
    const evm = inventEvmAddress();
    await query(
      `INSERT INTO kol_wallet (id, kol_id, chain, address_hmac, address_enc, status, is_public)
       VALUES ($1::uuid, $2::uuid, $3, $4, $5, 'active', FALSE)`,
      [
        walletId,
        leader,
        chain,
        blindIndex(evm, "address"),
        encrypt(evm, aadFor("kol_wallet", "address", walletId)),
      ],
    );
  }
  await query("UPDATE cabal SET leader_kol_id = $1::uuid WHERE id = $2::uuid", [leader, live]);

  // 2. Two members, so expel and nombrar co-líder have targets.
  const members = [
    await kol("prueba_miembro_1", { cabalId: live, chains: ["solana"] }),
    // Only on the EVM side: this is the row that shows `---` under SOL.
    // Publishes its EVM wallet, so the `EVM` badge appears somewhere too.
    await kol("prueba_miembro_2", {
      cabalId: live,
      chains: ["robinhood", "bnb"],
      isPublic: true,
    }),
  ];

  // 3. Somebody waiting in the queue, so `ver solicitudes` and accept/reject
  //    have something to show.
  const applicant = await kol("prueba_pide");
  await query(
    "INSERT INTO cabal_request (id, cabal_id, kol_id) VALUES (gen_random_uuid(), $1::uuid, $2::uuid)",
    [live, applicant],
  );

  // 4. An orphan: leader with every wallet withdrawn and no deputy. This is what
  //    `/admin` should list, and what a nomination repairs.
  const orphan = await cabal("PRB", "Cabal huérfano", "c");
  const gone = await kol("prueba_sin_wallet", { withdrawn: true, cabalId: orphan });
  await query("UPDATE cabal SET leader_kol_id = $1::uuid WHERE id = $2::uuid", [gone, orphan]);

  // 5. A KOL with two active wallets, so `retirar wallet` can be tried without
  //    the KOL losing the ability to act.
  // Publishes both of its wallets: this is the row that shows the chip, the
  // `+1` disclosure and the SOL badge. Everybody else stays hidden, so both
  // states are on the same screen.
  const twoWallets = await kol("prueba_dos_wallets", {
    chains: ["solana", "solana"],
    isPublic: true,
  });

  // 6. Closed positions, or the board shows its empty state and there is
  //    nothing to look at. Both signs, so the colours and the podium are real.
  // Closed positions on every active chain, so the per-chain columns have
  // something to render and the `---` case is visible beside them: the leader
  // trades on all three, one member only on Solana, another only on the EVM
  // side. The unpriced ETH sell is what puts `sin precio` on the screen.
  await sell(leader, "12.5", "1875", 3, "solana");
  await sell(leader, "1.8", "5400", 6, "robinhood");
  await sell(leader, "0.9", "810", 9, "bnb");
  await sell(members[0], "-4.25", "-637.5", 8, "solana");
  await sell(members[1], "0.42", null, 20, "robinhood");
  // BNB, so the third column has a figure and the row shows all three at once.
  // A loss on purpose: the mould paints a negative red whatever chain it is on,
  // and nothing else in this fixture exercises that.
  await sell(members[1], "-0.35", "-315", 14, "bnb");
  await sell(gone, "6.5", "975", 5, "solana");
  await sell(twoWallets, "1.25", "187.5", 11, "solana");

  // Clean up any fixture trades from a previous run of this script, so figures
  // do not accumulate every time it is re-run.
  void twoWallets;

  writeFileSync(
    OUT,
    [
      "Wallet de prueba para /mi-cabal en el preview local.",
      "Importar en Phantom: Add/Connect wallet -> Import private key.",
      "",
      `direccion:   ${address}`,
      `clave:       ${importable}`,
      "",
      "Es una wallet quemable, sin fondos, creada para esta prueba.",
      "El KOL es @prueba_lider y lidera el cabal PRA.",
      "",
    ].join("\n"),
    { mode: 0o600 },
  );

  console.log("seeded preview cabals");
  console.log(`  PRA  Cabal de prueba   leader @prueba_lider, 2 members, 1 pending request`);
  console.log(`  PRB  Cabal huérfano    leader with no active wallet, no co-leader`);
  console.log(`  @prueba_dos_wallets    two active wallets`);
  console.log(`  burner wallet written to ${OUT} (address only: ${address})`);
}

await main();
process.exit(0);
