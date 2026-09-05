/**
 * The peso rate, without a database.
 *
 * Everything worth pinning here is pure: what a stored blob has to look like
 * before it is allowed to multiply a money figure, when a quote stops counting,
 * and that the multiplication goes through `decimal.ts` rather than a double.
 *
 * `docs/round-ars.md` is the round behind the module; these cases are the three
 * promises it made, asserted rather than restated.
 */
import { describe, expect, it } from "vitest";
import {
  ARS_STALE_AFTER_MS,
  parseArsRates,
  selectArsRate,
  usdToArs,
  type ArsRates,
} from "./fx";

const AS_OF = "2026-09-02T11:55:00.000Z";
const NOW = Date.parse("2026-09-02T12:00:00.000Z");

function stored(overrides: Record<string, unknown> = {}): unknown {
  return {
    fetchedAt: "2026-09-02T12:00:00.000Z",
    casas: {
      oficial: { rate: "1535", asOf: "2026-09-01T18:55:00.000Z" },
      blue: { rate: "1545", asOf: AS_OF },
    },
    ...overrides,
  };
}

describe("parseArsRates", () => {
  it("keeps the casas that are complete and well formed", () => {
    const rates = parseArsRates(stored());
    expect(rates?.casas.blue).toEqual({ rate: "1545", asOf: AS_OF });
    expect(rates?.casas.oficial?.rate).toBe("1535");
  });

  it("rejects a value that is not the shape it stored", () => {
    expect(parseArsRates(null)).toBeNull();
    expect(parseArsRates("1545")).toBeNull();
    expect(parseArsRates({ casas: {} })).toBeNull();
    expect(parseArsRates({ fetchedAt: "ayer", casas: {} })).toBeNull();
    expect(parseArsRates({ fetchedAt: "2026-09-02T12:00:00.000Z" })).toBeNull();
  });

  /**
   * The case this validation exists for. A blob that survived a bad write with
   * one broken casa must lose that casa, not the whole rate — and a rate that
   * is not a positive decimal must never reach the multiplication, because
   * `undefined` and `0` both produce a peso figure that looks like a number.
   */
  it("drops a casa whose rate or date could not be believed", () => {
    const rates = parseArsRates(
      stored({
        casas: {
          blue: { rate: "1545", asOf: AS_OF },
          oficial: { rate: "0", asOf: AS_OF },
          bolsa: { rate: "no", asOf: AS_OF },
          mayorista: { rate: "1500", asOf: "el martes" },
          contadoconliqui: { rate: 1592.1, asOf: AS_OF },
        },
      }),
    );

    expect(Object.keys(rates?.casas ?? {})).toEqual(["blue"]);
  });
});

describe("selectArsRate", () => {
  const rates = parseArsRates(stored()) as ArsRates;

  it("returns the configured casa with the date it was quoted", () => {
    expect(selectArsRate(rates, "blue", NOW)).toEqual({
      rate: "1545",
      source: "blue",
      asOf: AS_OF,
      /*
        Dos campos nuevos del 2026-09-05. `stale` marca —no oculta— una
        cotización de más de 6 h, que es la decisión del dueño: se muestra igual,
        con aviso, *nunca en cero*. `ageMinutes` es lo que el tooltip imprime
        (`blue $1.545 · actualizado hace N min`), y está acá y no calculado en la
        vista porque el reloj vive en un solo lado.
      */
      stale: false,
      ageMinutes: 5,
    });
  });

  it("has no rate at all for a casa the source did not publish", () => {
    expect(selectArsRate(rates, "bolsa", NOW)).toBeNull();
    expect(selectArsRate(null, "blue", NOW)).toBeNull();
  });

  /**
   * DESIGN.md: *"Absence is rendered as absence, never as a zero."* A quote
   * past the window is not used with a caveat and is not swapped for another
   * casa — a peso total computed from last week's dollar looks current and is
   * not. Both sides of the boundary are asserted, because a staleness rule
   * nobody has seen expire is a rule that silently never fires.
   */
  it("stops believing a quote once it is too old, and not before", () => {
    const edge = Date.parse(AS_OF) + ARS_STALE_AFTER_MS;
    expect(selectArsRate(rates, "blue", edge)?.rate).toBe("1545");
    expect(selectArsRate(rates, "blue", edge + 1)).toBeNull();
  });
});

describe("usdToArs", () => {
  it("multiplies without going through a double", () => {
    expect(usdToArs("1802.40", "1545")).toBe("2784708");
    expect(usdToArs("-14.60", "1533.9")).toBe("-22394.94");
  });

  /**
   * The reason this goes through `decimal.ts`. `0.1 * 3` in doubles is
   * `0.30000000000000004`, and a figure like this one is what a reader sees.
   */
  it("keeps the digits a float would lose", () => {
    expect(usdToArs("0.1", "3")).toBe("0.3");
    expect(usdToArs("12345678.91", "1545.55")).toBe("19080864039.3505");
  });

  it("keeps the sign of a loss", () => {
    expect(usdToArs("-1", "1545")).toBe("-1545");
  });
});
