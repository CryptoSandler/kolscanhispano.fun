/**
 * Cron entry point for the peso rate: one HTTP read of a public source, one
 * `setting` row written.
 *
 * **Its own workflow, not a sixth step in `parse-pending.yml`.** `CLAUDE.md`
 * requires the next addition to that file to justify itself in writing, and the
 * justification here is that it does not belong: every step in that workflow has
 * an ordering dependency on the ones around it — the `sol_price` fill must
 * precede the parse, the requeue must sit between them — and this has none with
 * anything. A step whose position in a five-step file carries no meaning is a
 * step that makes the other four harder to read.
 *
 * `docs/round-ars.md` is the round behind the figure this feeds, and
 * `src/lib/fx.ts` is what reads what this writes. Two rules from that round
 * live here:
 *
 * - **Every casa is stored**, not just the configured one, so switching which
 *   dollar the site prints costs one environment variable and no re-fetch.
 * - **Nothing is computed.** The rate is the source's `venta` and the date is
 *   the source's `fechaActualizacion`, both carried through as strings. A rate
 *   this repository averaged, interpolated or carried forward would be a
 *   measurement it invented.
 *
 * Verified 2026-09-02: `curl https://dolarapi.com/v1/dolares` answers 200 with a
 * JSON array of `{casa, venta, fechaActualizacion}`, no key and no account.
 */
import { loadEnvLocal } from "../src/lib/env";
loadEnvLocal();

import { announceDatabaseTarget, query } from "../src/lib/db";
import { withLock } from "../src/lib/lock";
import {
  ARS_SOURCES,
  FX_SETTING_KEY,
  parseArsRates,
  type ArsRates,
  type ArsSource,
} from "../src/lib/fx";

/** The source, and the one place its URL is written. */
export const DOLARAPI_URL = "https://dolarapi.com/v1/dolares";

/**
 * The source's payload as the stored value, or `null` when nothing usable came
 * back.
 *
 * Pure and exported so its test needs no network: this is the only place the
 * outside world's shape is believed, and a change on their side has to fail
 * here rather than three layers in. Everything it emits goes back through
 * `parseArsRates`, so the writer and the reader agree on what a valid row is by
 * construction rather than by two matching opinions.
 *
 * `venta` is the selling rate — what it costs to *buy* a dollar — which is the
 * side a person converting a dollar figure into pesos is quoted. Taking the
 * midpoint of `compra` and `venta` would be this repository inventing a number
 * nobody publishes.
 */
export function toStoredRates(payload: unknown, fetchedAt: string): ArsRates | null {
  if (!Array.isArray(payload)) return null;

  const casas: Record<string, { rate: string; asOf: string }> = {};
  for (const entry of payload) {
    if (typeof entry !== "object" || entry === null) continue;
    const row = entry as Record<string, unknown>;
    if (row.moneda !== "USD") continue;
    if (!(ARS_SOURCES as readonly string[]).includes(String(row.casa))) continue;
    if (typeof row.venta !== "number" || !Number.isFinite(row.venta) || row.venta <= 0) continue;
    if (typeof row.fechaActualizacion !== "string") continue;
    // `venta` arrives as a JSON number and leaves as a string, once, here --
    // every reader downstream parses it with `decimal.ts` and never sees a
    // double again. `String` rather than `toFixed`: the source publishes whole
    // pesos for some casas and one decimal for others, and padding either would
    // be a digit this repository made up.
    casas[String(row.casa)] = { rate: String(row.venta), asOf: row.fechaActualizacion };
  }

  return parseArsRates({ fetchedAt, casas } satisfies {
    fetchedAt: string;
    casas: Partial<Record<ArsSource, { rate: string; asOf: string }>>;
  });
}

/**
 * One cycle: fetch, transform, write. Resolves to the exit code it implies.
 *
 * The fetcher is injectable so the test can exercise the whole path without a
 * network call — `network-guard.ts` would fail the suite for one, and rightly.
 *
 * A source that answers with nothing usable is a **failure**, not a silent
 * no-op: the rate on the page goes stale on its own after 96 hours (`fx.ts`),
 * and the run that could not refresh it should say so in the Actions log while
 * there are still three days to notice.
 */
export async function fetchFx(
  fetcher: typeof globalThis.fetch = globalThis.fetch,
  now: Date = new Date(),
): Promise<number> {
  const code = await withLock("fetch-fx", async (): Promise<number> => {
    let payload: unknown;
    try {
      const response = await fetcher(DOLARAPI_URL, { headers: { accept: "application/json" } });
      if (!response.ok) {
        console.error(`fetch-fx: the source answered ${response.status}`);
        return 1;
      }
      payload = await response.json();
    } catch {
      // Never the thrown message: a fetch error can carry the whole request.
      console.error("fetch-fx: the source could not be read");
      return 1;
    }

    const rates = toStoredRates(payload, now.toISOString());
    if (rates === null || Object.keys(rates.casas).length === 0) {
      console.error("fetch-fx: the source answered nothing usable");
      return 1;
    }

    await query(
      `INSERT INTO setting (key, value) VALUES ($1, $2::jsonb)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [FX_SETTING_KEY, JSON.stringify(rates)],
    );
    console.log(`fetch-fx: stored ${Object.keys(rates.casas).length} casas`);
    return 0;
  });

  // `withLock<T>` returns `T | null` and uses `null` for "the lock was busy".
  // Unambiguous here because the function above always resolves to a number —
  // the same property `prune-rate-limit.ts` relies on, and for the same reason
  // it says so out loud.
  if (code === null) {
    console.log("fetch-fx: another run holds the lock; doing nothing");
    return 0;
  }
  return code;
}

// Only when this file is the process entry point, not when a test imports it.
if (import.meta.url === `file://${process.argv[1]}`) {
  announceDatabaseTarget();
  process.exit(await fetchFx());
}
