/**
 * The peso fetch, from the source's payload to the figure the page will print.
 *
 * The transform is pure and is tested without a network — `network-guard.ts`
 * fails the suite for a real call, and rightly: a test that spent a request on
 * dolarapi.com every run would be measuring their uptime.
 *
 * The round trip is tested against the real database, because the property that
 * matters is that **the writer and the reader agree**: `fetch-fx.ts` stores a
 * blob and `fx.ts` decides whether to believe it, and two modules with matching
 * opinions about a JSON shape is exactly the arrangement that drifts.
 */
import { afterEach, describe, expect, it } from "vitest";
import { query } from "../src/lib/db";
import { FX_SETTING_KEY, readArsRate, selectArsRate, parseArsRates } from "../src/lib/fx";
import { DOLARAPI_URL, fetchFx, toStoredRates } from "./fetch-fx";

/** The shape verified against the live endpoint on 2026-09-02. */
const PAYLOAD = [
  { moneda: "USD", casa: "oficial", nombre: "Oficial", compra: 1485, venta: 1535, fechaActualizacion: "2026-09-01T18:55:00.000Z" },
  { moneda: "USD", casa: "blue", nombre: "Blue", compra: 1525, venta: 1545, fechaActualizacion: "2026-09-02T11:55:00.000Z" },
  { moneda: "USD", casa: "bolsa", nombre: "Bolsa", compra: 1528, venta: 1533.9, fechaActualizacion: "2026-09-02T11:55:00.000Z" },
];

const NOW = new Date("2026-09-02T12:00:00.000Z");

function answering(payload: unknown, status = 200): typeof globalThis.fetch {
  return (async (url: string) => {
    expect(url).toBe(DOLARAPI_URL);
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => payload,
    } as Response;
  }) as unknown as typeof globalThis.fetch;
}

afterEach(async () => {
  await query("DELETE FROM setting WHERE key = $1", [FX_SETTING_KEY]);
});

describe("toStoredRates", () => {
  it("keeps every casa the source published, at its own quoted moment", () => {
    const rates = toStoredRates(PAYLOAD, NOW.toISOString());

    expect(rates?.fetchedAt).toBe("2026-09-02T12:00:00.000Z");
    expect(rates?.casas.blue).toEqual({ rate: "1545", asOf: "2026-09-02T11:55:00.000Z" });
    expect(rates?.casas.bolsa?.rate).toBe("1533.9");
    // Stored as it was published: a whole peso is not padded to `1535.00`, and
    // one decimal is not rounded away. Neither digit is ours to invent.
    expect(rates?.casas.oficial?.rate).toBe("1535");
  });

  /**
   * The source publishes more than dollars — `EUR` rows sit in the same array —
   * and a euro quote stored under a casa this product prints as a dollar rate
   * would be wrong by a factor nobody would question.
   */
  it("takes the dollar rows only", () => {
    const rates = toStoredRates(
      [...PAYLOAD, { moneda: "EUR", casa: "blue", venta: 1800, fechaActualizacion: NOW.toISOString() }],
      NOW.toISOString(),
    );

    expect(rates?.casas.blue?.rate).toBe("1545");
  });

  it("ignores a casa this product does not know and a quote it cannot believe", () => {
    const rates = toStoredRates(
      [
        { moneda: "USD", casa: "cripto", venta: 1600, fechaActualizacion: NOW.toISOString() },
        { moneda: "USD", casa: "mayorista", venta: 0, fechaActualizacion: NOW.toISOString() },
        { moneda: "USD", casa: "blue", venta: "1545", fechaActualizacion: NOW.toISOString() },
      ],
      NOW.toISOString(),
    );

    expect(Object.keys(rates?.casas ?? {})).toEqual([]);
  });

  it("has nothing to store when the source answers something else entirely", () => {
    expect(toStoredRates({ error: "nope" }, NOW.toISOString())).toBeNull();
    expect(toStoredRates(null, NOW.toISOString())).toBeNull();
  });
});

describe("fetchFx", () => {
  it("writes a row the reader believes, at the casa the page will print", async () => {
    expect(await fetchFx(answering(PAYLOAD), NOW)).toBe(0);

    // Read back through `fx.ts`, not through a second copy of the shape here:
    // the whole point is that the module that renders the figure accepts what
    // the cron wrote.
    const rate = await readArsRate(NOW.getTime());
    expect(rate).toEqual({ rate: "1545", source: "blue", asOf: "2026-09-02T11:55:00.000Z" });

    // And every other casa is there, which is what makes switching the
    // configured source cost no re-fetch — `docs/round-ars.md` §3.4.
    const rows = await query<{ value: unknown }>("SELECT value FROM setting WHERE key = $1", [
      FX_SETTING_KEY,
    ]);
    const stored = parseArsRates(rows[0]?.value);
    expect(selectArsRate(stored, "oficial", NOW.getTime())?.rate).toBe("1535");
    expect(selectArsRate(stored, "bolsa", NOW.getTime())?.rate).toBe("1533.9");
  });

  it("replaces the previous row rather than accumulating rows", async () => {
    await fetchFx(answering(PAYLOAD), NOW);
    await fetchFx(
      answering([{ ...PAYLOAD[1], venta: 1560, fechaActualizacion: "2026-09-02T15:55:00.000Z" }]),
      new Date("2026-09-02T16:00:00.000Z"),
    );

    const rows = await query("SELECT 1 FROM setting WHERE key = $1", [FX_SETTING_KEY]);
    expect(rows).toHaveLength(1);
    expect((await readArsRate(Date.parse("2026-09-02T16:00:00.000Z")))?.rate).toBe("1560");
  });

  /**
   * A source that answers badly is a **failure**, not a silent success. The
   * rate on the page expires on its own after 96 hours, and the run that could
   * not refresh it should be red in the Actions log while there are still three
   * days to notice — and it must not leave a half-written row behind.
   */
  it("fails without touching what is already stored", async () => {
    await fetchFx(answering(PAYLOAD), NOW);

    expect(await fetchFx(answering(PAYLOAD, 503), NOW)).toBe(1);
    expect(await fetchFx(answering({ error: "nope" }), NOW)).toBe(1);
    expect(await fetchFx(answering([]), NOW)).toBe(1);

    expect((await readArsRate(NOW.getTime()))?.rate).toBe("1545");
  });
});
