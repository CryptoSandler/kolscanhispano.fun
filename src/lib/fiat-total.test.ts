import { describe, expect, it } from "vitest";
import { fiatTotal } from "./fiat-total";
import type { ArsRate } from "./fx";

/**
 * La conversión a pesos, con una cotización fija.
 *
 * Fija a propósito: la aritmética es lo que se mide acá, no de dónde salió el
 * número. `fx.test.ts` cubre la fuente, el parseo y los dos umbrales de edad;
 * este archivo cubre lo único que el lector ve, que es la cifra.
 */
function rate(overrides: Partial<ArsRate> = {}): ArsRate {
  return {
    rate: "1450",
    source: "blue",
    asOf: "2026-09-05T12:00:00.000Z",
    stale: false,
    ageMinutes: 30,
    ...overrides,
  };
}

describe("fiatTotal", () => {
  it("leaves dollars alone, unsigned, the way the mould prints them", () => {
    expect(fiatTotal("3100.5", "usd", null)).toBe("US$3.100,50");
    // U+2212, el menos tipográfico que usa todo `format.ts`, no el guion ASCII.
    expect(fiatTotal("-2460", "usd", null)).toBe("\u2212US$2.460,00");
  });

  it("keeps the sign when the caller asks for one", () => {
    // El modal firma su total; la fila no. Las dos superficies, una función.
    expect(fiatTotal("3100.5", "usd", null, "signed")).toBe("+US$3.100,50");
  });

  it("converts at the rate it is given, with no decimals", () => {
    // 3.100,50 × 1.450 = 4.495.725. Sin decimales: un peso es seis milésimas
    // de centavo de dólar a esta cotización, así que un decimal imprimiría el
    // redondeo de la cotización y no algo de la operación.
    expect(fiatTotal("3100.5", "ars", rate())).toBe("AR$4.495.725");
    expect(fiatTotal("3100.5", "ars", rate(), "signed")).toBe("+AR$4.495.725");
  });

  /*
    **El caso que encontró el error.**

    `formatUnsignedUsd` comparaba `signOf(value) === "-"` contra una función que
    devuelve U+2212, así que la comparación no daba nunca y toda pérdida se
    imprimía como ganancia — sin color que la distinguiera, porque el total en
    fiat no lleva clase de dirección. Estuvo mal unas horas el 2026-09-05, entre
    que se agregó la función para copiar el molde y que este archivo preguntó.
  */
  it("keeps a loss's minus in pesos", () => {
    expect(fiatTotal("-2460", "ars", rate())).toBe("\u2212AR$3.567.000");
  });

  /*
    **Una cotización vieja convierte igual.**

    El dueño lo pidió con esas palabras: *"si la cotización tiene más de 6 h, se
    muestra igual con aviso 'cotización desactualizada', nunca en cero"*. Así
    que `stale` no cambia la aritmética — cambia lo que la página dice al lado
    de la cifra, y eso lo prueba `arsTooltip` y el render de la home.
  */
  it("converts with a stale rate exactly as with a fresh one", () => {
    const old = rate({ stale: true, ageMinutes: 60 * 9 });
    expect(fiatTotal("3100.5", "ars", old)).toBe(fiatTotal("3100.5", "ars", rate()));
  });

  /*
    **Sin cotización no hay cifra, y no hay cero.**

    `null` es ausencia y la página la dibuja como ausencia — `(—)`. Un `AR$0`
    sería un número inventado con toda la apariencia de un dato, que es la
    forma más cara que tiene un error de estos.
  */
  it("returns null rather than a peso figure it cannot compute", () => {
    expect(fiatTotal("3100.5", "ars", null)).toBeNull();
    expect(fiatTotal("0", "ars", null)).toBeNull();
  });

  it("still says zero in dollars, because that zero is measured", () => {
    expect(fiatTotal("0", "usd", null)).toBe("US$0,00");
  });
});
