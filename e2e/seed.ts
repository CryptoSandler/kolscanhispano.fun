/**
 * The fixture the viewport guard measures against.
 *
 * `viewport.spec.ts` asserts that the home page does not scroll at 1280×900,
 * and that assertion is worthless against whatever happens to be in the
 * database: one KOL and no trades fit any viewport. So the guard gets a board
 * that is deliberately *fuller* than the layout budget — twelve approved KOLs
 * where only ten are shown, and enough trades to overflow the feed's eight
 * rows — because the case that has to keep working is a busy day, not a quiet
 * one.
 *
 * Every address is generated (SECURITY.md); no real one may enter this
 * repository. Every amount is written as a string: a float here would defeat
 * the point of `numeric`.
 */
import { aadFor, blindIndex, encrypt } from "../src/lib/crypto";
import { query } from "../src/lib/db";
import { inventAddress, inventSignature } from "../src/lib/ids";
import { addWallet } from "../src/lib/wallets";

/** Twelve, so the top-ten cut is exercised rather than assumed. */
const KOLS: ReadonlyArray<readonly [string, string, string | null]> = [
  ["cripto_ana", "Ana Cripto", "EJE"],
  ["trader_beto", "Beto Trader", "EJE"],
  ["la_carla", "Carla Solana", null],
  ["dani_sol", "Dani Sol", "LAT"],
  ["elena_dex", "Elena DEX", "LAT"],
  ["fer_trench", "Fer Trench", null],
  ["gaby_onchain", "Gaby On-Chain", "LAT"],
  ["hector_pump", "Héctor Pump", null],
  ["ines_meme", "Inés Meme", "EJE"],
  ["javi_flip", "Javi Flip", null],
  ["kari_hold", "Kari Hold", null],
  ["luis_scalp", "Luis Scalp", "LAT"],
];

// Descending, with a zero and negatives, so sign colour and the neutral case
// are all on screen. The eighth closes nothing, which is what puts a
// `sin cierres` cell in the measured page.
const SOL = ["18.42", "12.05", "9.3", "6.77", "4.2", "2.11", "0.9", "0",
  "-1.35", "-3.4", "-8.02", "-14.6"];
const USD = ["3100.5", "1802.4", "1560", "1140.25", "708", "355", "151", "0",
  "-227", "-572", "-1350", "-2460"];
const WINS = [9, 7, 6, 5, 4, 3, 2, 0, 2, 1, 1, 0];
const LOSSES = [1, 2, 3, 3, 4, 4, 5, 0, 6, 6, 8, 9];

/** How many trades the feed is given. More than the eight rows it shows. */
const TRADES = 12;

export async function seedLeaderboard(): Promise<void> {
  await query(
    "TRUNCATE kol, kol_wallet, cabal, token, trade, position, pnl_daily, pnl_position_daily, " +
      "raw_tx CASCADE",
  );

  const cabals = new Map<string, string>();
  for (const tag of ["EJE", "LAT"]) {
    const id = crypto.randomUUID();
    await query("INSERT INTO cabal (id, tag, name) VALUES ($1, $2, $3)", [id, tag, tag]);
    cabals.set(tag, id);
  }

  const mint = inventAddress();
  await query(
    "INSERT INTO token (mint, symbol, name, decimals) VALUES ($1, 'SP3ND', 'Spend', 6)",
    [mint],
  );

  // The window is the current UTC day (spec §4.9), so the rows have to land on
  // it — not on the machine's local day, which is a different date for a third
  // of every day in this audience's timezones.
  const today = new Date().toISOString().slice(0, 10);

  for (const [index, [slug, name, tag]] of KOLS.entries()) {
    const kolId = crypto.randomUUID();
    await query(
      `INSERT INTO kol (id, slug, display_name, x_handle, cabal_id, hide_wallets, status,
                        approved_at)
       VALUES ($1, $2, $3, $6, $4, $5, 'approved', now())`,
      [kolId, slug, name, tag === null ? null : cabals.get(tag), index % 3 !== 0, slug],
    );
    const walletId = await addWallet(kolId, inventAddress());

    await query(
      `INSERT INTO pnl_daily (kol_id, day, realized_sol, realized_usd, wins, losses)
       VALUES ($1, $2::date, $3::numeric, $4::numeric, $5, $6)`,
      [kolId, today, SOL[index], USD[index], WINS[index], LOSSES[index]],
    );

    if (index < TRADES) {
      // Encrypted the way the parser writes it — AES-GCM under the AAD that
      // binds the value to this row — so the feed decrypts what production
      // stores. Random bytes here would silently exercise the
      // could-not-decrypt path instead, and every row would lose its link.
      const tradeId = crypto.randomUUID();
      const signature = inventSignature();
      await query(
        `INSERT INTO trade (id, signature_hmac, signature_enc, instruction_index, slot, kol_id,
                            wallet_id, mint, side, token_amount, sol_amount, price_usd, fee_sol,
                            block_time)
         VALUES ($1, decode($2,'hex'), decode($12,'hex'), 0, $3, $4, $5, $6, $7, $8::numeric,
                 $9::numeric, $10::numeric, 0, now() - ($11 || ' minutes')::interval)`,
        [
          tradeId,
          blindIndex(signature, "signature").toString("hex"),
          1000 + index,
          kolId,
          walletId,
          mint,
          index % 2 === 0 ? "buy" : "sell",
          `${16_900_000 + index * 1000}`,
          `${(1.23 + index * 0.4).toFixed(4)}`,
          "0.0000071",
          `${index * 3 + 1}`,
          encrypt(signature, aadFor("trade", "signature", tradeId)).toString("hex"),
        ],
      );
    }
  }
}
