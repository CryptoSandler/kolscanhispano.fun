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
import { inventAddress, inventEvmAddress, inventSignature } from "../src/lib/ids";
import { addWallet, setWalletVisibility } from "../src/lib/wallets";

/** Twelve, so the top-ten cut is exercised rather than assumed. */
const KOLS: ReadonlyArray<readonly [string, string, string | null]> = [
  ["cripto_ana", "Ana Cripto", "EJE"],
  ["trader_beto", "Beto Trader", "EJE"],
  ["la_carla", "Carla Solana", null],
  ["dani_sol", "Dani Sol", "LAT"],
  ["elena_dex", "Elena DEX", "LAT"],
  ["fer_trench", "Fer Trench", "IBE"],
  ["gaby_onchain", "Gaby On-Chain", "LAT"],
  ["hector_pump", "Héctor Pump", null],
  ["ines_meme", "Inés Meme", "EJE"],
  ["javi_flip", "Javi Flip", "IBE"],
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

  /*
    Three cabals, not two, since `/cabals` was built (`docs/clone-map.md` §6):
    that page's whole shape is a podium of three, and a fixture with two would
    photograph a podium that is missing a card for a reason nobody could tell
    from the picture. They carry real names as well as tags, because the page
    prints the name and the chip prints the tag.
  */
  const cabals = new Map<string, string>();
  for (const [tag, name] of [["EJE", "Ejemplo"], ["LAT", "Latam"], ["IBE", "Iberia"]]) {
    const id = crypto.randomUUID();
    await query("INSERT INTO cabal (id, tag, name) VALUES ($1, $2, $3)", [id, tag, name]);
    cabals.set(tag, id);
  }

  /*
    A peso rate, so the `USD · ARS` toggle has something to convert with and the
    captures show the figure a reader would see rather than `sin precio`.

    The values are the ones verified against `https://dolarapi.com/v1/dolares`
    on 2026-09-02 — a fixture, never a live call: the suite must not depend on
    somebody else's uptime, and `network-guard.ts` exists to keep it from
    trying. The quote is dated *now* so `fx.ts`'s 96-hour staleness rule does
    not expire it as the fixture ages, which is the same reason the `pnl_daily`
    rows below land on today rather than on a written date.
  */
  const quotedAt = new Date().toISOString();
  await query(
    `INSERT INTO setting (key, value) VALUES ('fx.ars', $1::jsonb)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [
      JSON.stringify({
        fetchedAt: quotedAt,
        casas: {
          oficial: { rate: "1535", asOf: quotedAt },
          blue: { rate: "1545", asOf: quotedAt },
          bolsa: { rate: "1533.9", asOf: quotedAt },
        },
      }),
    ],
  );

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
    // Publication is per wallet since migration 012. The seed's `index % 3`
    // split was written when it was per KOL, and it is kept as-is -- the
    // roster still carries both shapes -- but it now has to reach the row that
    // actually decides. Without this every seeded wallet is private, and the
    // half of `modal-kol.spec.ts` that checks a *published* signature would be
    // asserting against a roster that publishes nothing.
    if (index % 3 === 0) await setWalletVisibility(kolId, walletId, true);

    /*
      **Un KOL publica dos wallets**, para que exista el desplegable `+N ▾`.

      El panel sólo aparece con más de una wallet pública, así que sin esto
      `chain-columns.spec.ts` no tiene qué abrir y sus tres casos no prueban
      nada. Es la misma lección que dejó `address-invariant.test.ts` unas horas
      antes: un fixture con una sola wallet publicada hace que la regla del panel
      quede sin ejercitar en la superficie donde rige.
    */
    if (index === 0) {
      const second = await addWallet(kolId, inventAddress());
      await setWalletVisibility(kolId, second, true);
    }

    await query(
      `INSERT INTO pnl_daily (kol_id, day, realized_sol, realized_usd, wins, losses)
       VALUES ($1, $2::date, $3::numeric, $4::numeric, $5, $6)`,
      [kolId, today, SOL[index], USD[index], WINS[index], LOSSES[index]],
    );

    /*
      **And the same figure as a realized sell**, which is where the ranking
      reads it from since 2026-09-03.

      Every window is rolling now and a day bucket cannot be cut at an arbitrary
      hour, so `leaderboard.ts`, `kol.ts` and `cabals.ts` all sum
      `trade.realized_sol` — the per-sell amount `migrations/015` records.
      Seeding only `pnl_daily` left every figure at zero, every surface as its
      own empty state, and **44 of 74 Playwright cases failing on
      `toBeVisible()`** — not 44 defects but one, seen from 44 angles.

      `pnl_daily` is still written because the modal's calendar month reads it,
      and because that is the state a real replay leaves: the same arithmetic
      feeds both (`migrations/015`).

      **Ten minutes ago, not at a day boundary.** A rolling window ends at the
      instant the page renders, so a row dated today's midnight sits outside
      `1D` for most of the day and a row dated later is in the future.
    */
    const realizedId = crypto.randomUUID();
    const realizedSignature = inventSignature();
    await query(
      `INSERT INTO trade (id, signature_hmac, signature_enc, instruction_index, slot, kol_id,
                          wallet_id, mint, side, token_amount, sol_amount, price_usd, fee_sol,
                          block_time, realized_sol, realized_usd)
       VALUES ($1, decode($2,'hex'), decode($3,'hex'), 1, $4, $5, $6, $7, 'sell', 1,
               $8::numeric, 0.0000071, 0, now() - interval '10 minutes', $8::numeric, $9::numeric)`,
      [
        realizedId,
        blindIndex(realizedSignature, "signature").toString("hex"),
        encrypt(realizedSignature, aadFor("trade", "signature", realizedId)).toString("hex"),
        2000 + index,
        kolId,
        walletId,
        mint,
        SOL[index],
        USD[index],
      ],
    );

    /*
      **One KOL trades on a second chain**, so the ranking has a row with two
      chain amounts beside rows with one. Without it `chain-columns.spec.ts`
      compares a page where every row is identical and proves nothing.

      `migrations/011` ties `trade.chain` to the wallet's with a composite
      foreign key, so the wallet has to exist on that chain first.
    */
    /*
      **Elena DEX, y un monto que no la mueve de puesto.**

      Este fixture rompió dos casos ajenos antes de quedarse quieto, por dos
      razones distintas, y las dos valen la pena:

      1. En el índice 0 le sumaba una operación a Ana Cripto, cuyos totales fija
         `modal-kol.spec.ts` en `+18,42 SOL`. Pasaron a `+19,92`.
      2. Movido al último, le sumaba **4.500 USD** a Luis Scalp (-2.460), que
         saltó del puesto 12 al 4 y **reordenó la tabla entera**. Los casos que
         eligen su fila por puesto — `PUBLIC_ROW`, `HIDDEN_ROW` — se quedaron
         mirando a otro KOL, y fallaron diciendo que faltaba un candado.

      Así que la fila tiene que tener dos montos **y** el puesto tiene que
      quedar donde estaba. Elena está en 708 USD, entre 1.140,25 y 355: cualquier
      cosa entre -352 y +431 la deja quinta. `+300` está cómodo en el medio.

      `chain-columns.spec.ts` recorre todas las filas buscando una con dos
      montos, así que no le importa cuál sea — pedía la más fácil, no la
      primera.
    */
    if (index === 4) {
      const evmWalletId = crypto.randomUUID();
      const evmAddress = inventEvmAddress();
      await query(
        `INSERT INTO kol_wallet (id, kol_id, chain, address_hmac, address_enc, status, is_public)
         VALUES ($1, $2, 'robinhood', decode($3,'hex'), decode($4,'hex'), 'active', FALSE)`,
        [
          evmWalletId,
          kolId,
          blindIndex(evmAddress, "address").toString("hex"),
          encrypt(evmAddress, aadFor("kol_wallet", "address", evmWalletId)).toString("hex"),
        ],
      );
      const evmTradeId = crypto.randomUUID();
      const evmSignature = inventSignature();
      await query(
        `INSERT INTO trade (id, signature_hmac, signature_enc, instruction_index, slot, kol_id,
                            wallet_id, chain, mint, side, token_amount, sol_amount, price_usd,
                            fee_sol, block_time, realized_sol, realized_usd)
         VALUES ($1, decode($2,'hex'), decode($3,'hex'), 3, $4, $5, $6, 'robinhood', $7, 'sell',
                 1, 0.12, 0.0000071, 0, now() - interval '12 minutes', 0.12, 300)`,
        [
          evmTradeId,
          blindIndex(evmSignature, "signature").toString("hex"),
          encrypt(evmSignature, aadFor("trade", "signature", evmTradeId)).toString("hex"),
          3000 + index,
          kolId,
          evmWalletId,
          mint,
        ],
      );
    }

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
