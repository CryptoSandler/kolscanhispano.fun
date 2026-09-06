import { usdToArs } from "./ars-convert";
// Sólo el tipo: un `import type` se borra en compilación y no arrastra `fx.ts`
// —ni `pg`— al bundle del cliente.
import type { ArsRate } from "./fx";
import {
  formatSignedArs,
  formatSignedUsd,
  formatUnsignedArs,
  formatUnsignedUsd,
} from "./format";
import type { LeaderboardFiat } from "./leaderboard";

/**
 * One total, in whichever currency the toggle is on.
 *
 * **The peso is a display conversion of the USD total at one rate**
 * (`docs/round-ars.md`), never a second measurement: the same figure, in
 * another currency, with the rate and its date printed beside the list. It is
 * explicitly *not* the sum of each day's trades at that day's rate, which is
 * what a reader might reasonably assume a peso PnL to be — which is why the
 * qualifier sentence travels with every surface that prints one.
 *
 * **`null` means there is no rate**, and the caller renders that as absence —
 * `(—)`, never `AR$0`. A peso figure with no rate behind it is a fabrication,
 * and a zero is the most confident-looking one available.
 *
 * This lived inline in `leaderboard-table.tsx` until 2026-09-05, when the modal
 * and `/cabals` needed the same three lines. Three copies of a rule about money
 * is three places to fix it.
 */
export function fiatTotal(
  usdText: string,
  fiat: LeaderboardFiat,
  rate: ArsRate | null,
  sign: "signed" | "unsigned" = "unsigned",
): string | null {
  if (fiat === "usd") {
    return sign === "signed" ? formatSignedUsd(usdText) : formatUnsignedUsd(usdText);
  }
  if (rate === null) return null;
  const pesos = usdToArs(usdText, rate.rate);
  return sign === "signed" ? formatSignedArs(pesos) : formatUnsignedArs(pesos);
}
