import type { ChainPnl } from "@/lib/chain-pnl";
import { fiatTotal } from "@/lib/fiat-total";
import type { ArsRate } from "@/lib/fx";
import { amountDirection, formatSignedAmount } from "@/lib/format";
import type { LeaderboardFiat } from "@/lib/leaderboard";

/**
 * A KOL's realized figures, one per chain, in the row and in the modal.
 *
 * `docs/round-columnas-chain.md` §3, and the rule the brief turns on:
 * **a chain with nothing measured on it is absent, never `0.00`.** That falls
 * out of the data rather than being enforced here — nothing indexed the chain,
 * so nothing summed it, so there is no entry to render. A flag that was on but
 * had produced no trades behaves identically, which is right: a column says
 * "we measured this", not "we intended to".
 *
 * Each amount carries **its own sign colour**, because `DESIGN.md` makes green
 * and red the direction of money and nothing else — and a KOL up on one chain
 * and down on another is two directions, not an average of them.
 */

/** The unit each chain's native amount is denominated in. */
const CHAIN_UNIT: Record<string, string> = {
  solana: "SOL",
  robinhood: "ETH",
  ethereum: "ETH",
  bnb: "BNB",
};

/**
 * **Positive amounts are coloured by chain; negative ones are red.**
 *
 * Measured off the mould's home at 1440 on 2026-09-05: `+11.75 ETH` blue,
 * `+0.24 BNB` yellow, `+2.41 SOL` green — and `-0.14 BNB`, `-0.30 BNB` both
 * red, losing the chain colour. So the chain tints the gain and the loss is red
 * whatever it was denominated in.
 *
 * This is the one place in this product where green is **not** simply direction
 * of money: SOL's gain happens to be green because SOL's brand is green.
 * `DESIGN.md`'s rule still holds for every figure that is not a chain amount —
 * the fiat total, the modal header — and red still means exactly one thing
 * everywhere, which is the half of the rule that matters.
 */


/**
 * The site's Spanish formatter, not `toFixed`.
 *
 * This printed `+12.50 SOL` with a dot until 2026-09-05, on a site whose every
 * other figure uses a comma. `formatSignedAmount` is the shared one and it does
 * the sign, the rounding and the trailing-zero trim in one place.
 */
function short(amount: string, unit: string): string {
  return formatSignedAmount(amount, unit);
}

/**
 * **Three fixed slots, keyed by unit: ETH, BNB, SOL.**
 *
 * Measured in the mould's DOM at 1440 on 2026-09-05 — ETH x676 w120,
 * BNB x796 w130, SOL x926 w130, then the fiat at x1056 w140. The slots do not
 * depend on what is indexed and do not collapse when a chain has no figure:
 * that is what keeps the fiat total starting at the same x on every row, which
 * `e2e/chain-columns.spec.ts` measures.
 *
 * **By unit and not by chain**, because Robinhood and Ethereum are both
 * denominated in ETH and the mould has one ETH column, not two. Two chains
 * sharing a unit sum into one slot, which is the only arithmetic here that is
 * allowed to cross chains — they are the same unit, so it is addition rather
 * than the category error the ranking's old native sort made.
 *
 * An earlier version derived the columns from the union of what each page had.
 * That was right for "a chain nothing indexes has no column" and wrong for
 * layout: a row with two chains got two tracks and the fiat slid into the
 * third. The mould keeps the tracks and empties the cell.
 */
const UNIT_SLOTS = ["ETH", "BNB", "SOL"] as const;

type UnitTotal = { realized: number; unpriced: boolean };

function byUnit(chains: ChainPnl[]): Map<string, UnitTotal> {
  const totals = new Map<string, UnitTotal>();
  for (const entry of chains) {
    const unit = CHAIN_UNIT[entry.chain] ?? entry.chain.toUpperCase();
    const current = totals.get(unit) ?? { realized: 0, unpriced: false };
    totals.set(unit, {
      realized: current.realized + Number(entry.realized),
      unpriced: current.unpriced || entry.realizedUsd === null,
    });
  }
  return totals;
}

/*
  **`chainColumns` se borró el 2026-09-05, y no sólo por estar muerta.**

  Devolvía las cadenas presentes en orden, "para el modal, que lista cadenas y
  no unidades" — y el modal terminó listando `detail.chains` directamente, así
  que nunca la llamó nadie. Lo que la hacía cara es que era el único uso de
  `CHAIN_ORDER` acá, un import de valor desde `chain-pnl.ts`, que importa la
  base: con el modal renderizando esta sección desde un componente cliente, el
  build se llevaba `pg` al navegador y fallaba con `dns`, `fs`, `net` y `tls`.

  El tipo `ChainPnl` se sigue importando, pero como `import type`, que se borra
  en compilación y no arrastra el módulo.
*/
const UNIT_TINT: Record<string, string> = {
  ETH: "is-chain-eth",
  BNB: "is-chain-bnb",
  SOL: "is-chain-sol",
};

export function ChainAmounts({ chains }: { chains: ChainPnl[] }) {
  const totals = byUnit(chains);
  return (
    <>
      {UNIT_SLOTS.map((unit) => {
        const total = totals.get(unit);
        return (
          <span key={unit} className="chain-slot">
            {total === undefined ? (
              // The slot stays, empty. `---` is what the mould renders here and
              // it is deliberately far back: the column must hold its width
              // whether or not there is a figure in it.
              <span className="state-unpriced" aria-label={`sin operaciones en ${unit}`}>
                ---
              </span>
            ) : (
              <span
                className={`chain-amount ${
                  total.realized < 0 ? "is-loss" : (UNIT_TINT[unit] ?? "")
                }`}
              >
                {short(String(total.realized), unit)}
              </span>
            )}
          </span>
        );
      })}
    </>
  );
}

/**
 * The modal's `CHAIN PNL` section: the same split, with the USD equivalent and
 * the unpriced state spelled out.
 *
 * **`sin precio`, never a zero and never a dash.** That is `DESIGN.md`'s
 * existing `state-unpriced` vocabulary, reused rather than invented — the brief
 * called it "sin cotizar" and the site already had a word for exactly this
 * state, and two phrases for one thing is worse than either.
 *
 * A chain is unpriced when **any** position in it could not be priced, not when
 * all of them were: `chain-pnl.ts` refuses to sum the priced half, because a
 * total computed over a hole is a number with an invisible gap.
 */
export function ChainPnlSection({
  chains,
  fiat = "usd",
  rate = null,
}: {
  chains: ChainPnl[];
  fiat?: LeaderboardFiat;
  rate?: ArsRate | null;
}) {
  if (chains.length === 0) return null;
  return (
    <section className="card">
      <div className="card-head">
        <h3 className="label">CHAIN PNL</h3>
      </div>
      <ul className="chain-pnl">
        {chains.map((entry) => (
          <li key={entry.chain}>
            <span className="label">{CHAIN_UNIT[entry.chain] ?? entry.chain}</span>
            <span className={`num ${amountDirection(entry.realized)}`}>
              {short(entry.realized, CHAIN_UNIT[entry.chain] ?? "")}
            </span>
            <span className="num secondary">
              {entry.realizedUsd === null ? (
                /*
                  **The explanation lives here and not on the list row.**

                  The row shows the quoted total in parentheses and nothing
                  else; a caps `SIN PRECIO` beside four figures made one
                  unpriced position the loudest thing in the ranking. This says
                  which position, in which unit, and why — **in words**.

                  It read `(Q30–32)` for one revision: an internal question
                  number, from a repository that is not even on this machine, on
                  a surface a reader sees. Nobody outside this work could resolve
                  it. `docs/copy.md` now makes that a rule, and the underlying
                  fact — `docs/multichain.md` §4, a V4 pool with no native leg
                  has nothing to quote against — is what the sentence says
                  instead. This comment may name the document; the screen may not.
                */
                <span className="state-unpriced">
                  {short(entry.realized, CHAIN_UNIT[entry.chain] ?? "")} sin cotizar — el par de
                  este token no tiene precio en dólares todavía
                </span>
              ) : (
                // La misma conversión de presentación que el total de arriba,
                // por la misma razón: dos monedas para una cifra en la misma
                // tarjeta sería peor que no convertir ninguna.
                (() => {
                  const total = fiatTotal(entry.realizedUsd, fiat, rate, "signed");
                  return total === null ? "(—)" : `(${total})`;
                })()
              )}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
