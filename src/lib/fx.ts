/**
 * The peso rate behind the `USD · ARS` toggle.
 *
 * **Read `docs/round-ars.md` before changing anything here.** That round is the
 * one `CLAUDE.md` requires before a change to what a number means, and it fixes
 * three things this module implements and must not quietly outgrow:
 *
 * 1. **A display conversion, never a second measurement.** The peso figure is
 *    the row's already-computed USD total multiplied by one rate. It is not
 *    summed per day at that day's own rate — that is different arithmetic, it
 *    can reorder the ranking, and it is a separate change with its own round.
 * 2. **The ordering never depends on it.** A single positive rate is a monotone
 *    multiple, so the peso ranking *is* the USD ranking. Nothing here reaches
 *    the `ORDER BY`.
 * 3. **Which rate is the owner's open decision**, so the fetch stores every
 *    `casa` the source publishes and the choice is one environment variable.
 *    Switching costs no re-fetch, no migration and no code.
 *
 * **No table, and that is deliberate.** `setting (key TEXT PRIMARY KEY, value
 * JSONB)` has existed since `001_core.sql` and `settings.ts` already reads it;
 * an `fx_rate` table would have been a migration, a Neon branch and a
 * three-database close for one row of state that nothing reads historically.
 * The round asked for a dated, cited, reproducible rate — the date and the
 * source are in the value, which is the whole requirement.
 *
 * ponytail: one `setting` row, no history. If a past screenshot ever has to be
 * reproduced, the upgrade is a real table and a migration; nothing else here
 * changes, because every reader goes through {@link readArsRate}.
 */
// Sólo `parseDecimal`: la multiplicación se mudó a `ars-convert.ts` para que
// un componente cliente pueda convertir sin arrastrar `pg` al navegador.
import { parseDecimal } from "./decimal";
import { query } from "./db";

/** The `setting` row this module owns. */
export const FX_SETTING_KEY = "fx.ars";

/**
 * The rates `https://dolarapi.com/v1/dolares` publishes, by its own `casa`
 * names. Verified 2026-09-02: `oficial`, `blue`, `bolsa`, `contadoconliqui`
 * and `mayorista`, each with a `venta` and a `fechaActualizacion`.
 *
 * All of them are stored. The list exists so a misconfigured `ARS_FX_SOURCE`
 * fails as "no rate" rather than as a silent fallback to whichever key happened
 * to be first.
 */
export const ARS_SOURCES = ["oficial", "blue", "bolsa", "contadoconliqui", "mayorista"] as const;

export type ArsSource = (typeof ARS_SOURCES)[number];

/**
 * What the qualifier line prints. Their `casa` names are jargon in three of
 * five cases; a reader is told which dollar this is, in words.
 */
export const ARS_SOURCE_LABELS: Record<ArsSource, string> = {
  oficial: "dólar oficial",
  blue: "dólar blue",
  bolsa: "dólar MEP",
  contadoconliqui: "contado con liqui",
  mayorista: "dólar mayorista",
};

/**
 * The default, and the reason it is this one.
 *
 * The peso figure answers *"what is this profit worth to me"*, and the rate a
 * reader in Buenos Aires can actually transact at is the blue, not the state's.
 * Measured 2026-09-02 the two were 0.7 % apart, which is the weakest this
 * argument has been in years and exactly why the choice is configurable: the
 * gap was a factor of two as recently as 2023, and whatever is chosen has to
 * survive it reopening on a public page.
 *
 * **It is the owner's decision, recorded as open in `docs/round-ars.md`.**
 * `ARS_FX_SOURCE` overrides it with no other change anywhere.
 */
export const DEFAULT_ARS_SOURCE: ArsSource = "blue";

/**
 * How old a quote may be before the peso figure becomes `sin precio`.
 *
 * Four days, from the calendar rather than from taste: these rates are quoted
 * on business days, so a Friday evening quote read on the Tuesday after a long
 * weekend is about 86 hours old and is still the last real price. Ninety-six
 * hours covers that and nothing beyond it.
 *
 * **A stale rate is never used with a caveat.** DESIGN.md: *"Absence is
 * rendered as absence, never as a zero"* — a peso total computed from last
 * week's dollar is a number that looks current and is not.
 */
export const ARS_STALE_AFTER_MS = 96 * 60 * 60 * 1000;

/**
 * When a quote starts being **labelled** stale, as opposed to refused.
 *
 * The owner's decision of 2026-09-05: past six hours the figure is still shown,
 * with `cotización desactualizada` beside it — *"nunca en cero"*.
 *
 * **That is a different policy from the one above, and both now apply.** The
 * original refused a stale figure outright, on the reasoning that "a peso total
 * computed from last week's dollar is a number that looks current and is not".
 * The answer to that objection is to stop it looking current, which is what the
 * label does — so six hours marks it and {@link ARS_STALE_AFTER_MS} still
 * refuses it, four days out, where the number stops being a price at all.
 *
 * Six hours against a rate quoted on business days means a Sunday reader sees
 * the notice. That is correct rather than noisy: on a Sunday the last real price
 * *is* old, and the notice is what says so.
 */
export const ARS_WARN_AFTER_MS = 6 * 60 * 60 * 1000;

/** One `casa`'s quote, as stored. */
export type ArsQuote = { rate: string; asOf: string };

/** The whole `setting` value: every casa the source published, and when. */
export type ArsRates = { fetchedAt: string; casas: Partial<Record<ArsSource, ArsQuote>> };

/** What a surface needs to print a peso figure and say where it came from. */
export type ArsRate = {
  rate: string;
  source: ArsSource;
  asOf: string;
  /** Older than {@link ARS_WARN_AFTER_MS}: shown, and labelled. Never hidden. */
  stale: boolean;
  /** How old the quote is, for the tooltip. */
  ageMinutes: number;
};

/**
 * Exported for its own test: this is validation of a value that came from
 * outside the process, and it is worth pinning without a database.
 *
 * Everything is checked, because a stored JSON blob is exactly the shape that
 * survives a bad write and then multiplies a money figure by `undefined`. A
 * rate must parse as a positive decimal; a date must parse as a date.
 */
export function parseArsRates(value: unknown): ArsRates | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.fetchedAt !== "string" || Number.isNaN(Date.parse(record.fetchedAt))) {
    return null;
  }
  if (typeof record.casas !== "object" || record.casas === null) return null;

  const casas: Partial<Record<ArsSource, ArsQuote>> = {};
  for (const source of ARS_SOURCES) {
    const raw = (record.casas as Record<string, unknown>)[source];
    if (typeof raw !== "object" || raw === null) continue;
    const quote = raw as Record<string, unknown>;
    if (typeof quote.rate !== "string" || typeof quote.asOf !== "string") continue;
    if (Number.isNaN(Date.parse(quote.asOf))) continue;
    let parsed: bigint;
    try {
      parsed = parseDecimal(quote.rate);
    } catch {
      continue;
    }
    if (parsed <= 0n) continue;
    casas[source] = { rate: quote.rate, asOf: quote.asOf };
  }
  return { fetchedAt: record.fetchedAt, casas };
}

/**
 * The configured casa's quote, or `null` when there is none or it is too old.
 *
 * `null` is the whole staleness policy: there is no second-best rate and no
 * fallback to another casa. A reader asked for a peso figure and either gets
 * one that is current or is told there is no price.
 */
export function selectArsRate(
  rates: ArsRates | null,
  source: ArsSource,
  now: number,
): ArsRate | null {
  const quote = rates?.casas[source];
  if (quote === undefined) return null;
  const age = now - Date.parse(quote.asOf);
  if (age > ARS_STALE_AFTER_MS) return null;
  return {
    rate: quote.rate,
    source,
    asOf: quote.asOf,
    // Shown, and marked. See `ARS_WARN_AFTER_MS`.
    stale: age > ARS_WARN_AFTER_MS,
    ageMinutes: Math.max(0, Math.floor(age / 60_000)),
  };
}

/**
 * `blue $1.545 · actualizado hace 12 min`, the tooltip on the ARS toggle and on
 * every converted figure.
 *
 * It names the casa, the rate and the age — the three things that make a
 * converted number checkable. `docs/round-ars.md` §3: *"a converted figure
 * without them is a number pretending to be a fact"*.
 */
export function arsTooltip(rate: ArsRate): string {
  const age =
    rate.ageMinutes < 60
      ? `hace ${rate.ageMinutes} min`
      : `hace ${Math.floor(rate.ageMinutes / 60)} h`;
  const label = ARS_SOURCE_LABELS[rate.source];
  return `${label} $${rate.rate} · actualizado ${age}${rate.stale ? " · cotización desactualizada" : ""}`;
}

/**
 * Which casa this deployment prints. Unset, or set to something this module
 * does not know, is the default rather than an error: a typo in an environment
 * variable must not take the ranking down, and the label on the page says which
 * rate is actually being used either way.
 */
export function configuredArsSource(): ArsSource {
  const raw = process.env.ARS_FX_SOURCE;
  return (ARS_SOURCES as readonly string[]).includes(raw ?? "")
    ? (raw as ArsSource)
    : DEFAULT_ARS_SOURCE;
}

/**
 * The rate the page will print, or `null`.
 *
 * It degrades to `null` on a database failure for the reason
 * `readAffiliateSlot` does: this is read while rendering the ranking, and a
 * hiccup reading one row must cost the peso column, not the page.
 */
export async function readArsRate(now: number = Date.now()): Promise<ArsRate | null> {
  let value: unknown;
  try {
    const rows = await query<{ value: unknown }>("SELECT value FROM setting WHERE key = $1", [
      FX_SETTING_KEY,
    ]);
    value = rows[0]?.value;
  } catch {
    // Never the driver's message: it can carry a fragment of the connection
    // string.
    console.warn("readArsRate: the setting could not be read");
    return null;
  }
  return selectArsRate(parseArsRates(value), configuredArsSource(), now);
}

/**
 * La conversión vive en `ars-convert.ts` y se reexporta acá para no romper a
 * quien ya la importaba: este módulo lee la base, y un componente cliente que
 * quiera multiplicar no puede pagar `pg` por hacerlo.
 */
export { usdToArs } from "./ars-convert";
