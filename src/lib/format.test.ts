import { describe, expect, it } from "vitest";
import { formatRelative, formatSol, formatTokenAmount, formatUsdPrice } from "./format";

describe("formatSol", () => {
  it("uses the es-ES decimal comma", () => {
    expect(formatSol("1.23")).toBe("1,23");
  });

  it("groups thousands with a point, not a comma", () => {
    expect(formatSol("1802.4")).toBe("1.802,40");
    expect(formatSol("1234567.891")).toBe("1.234.567,89");
  });

  it("rounds half away from zero rather than truncating", () => {
    expect(formatSol("1.235")).toBe("1,24");
    expect(formatSol("1.234")).toBe("1,23");
  });

  // Two decimals is right for the amounts people read and wrong for the small
  // ones: a real 0,004 SOL trade must not render as `0,00 SOL`.
  it("never renders a non-zero amount as zero", () => {
    expect(formatSol("0.004")).toBe("0,004");
    expect(formatSol("0.0000123")).toBe("0,000012");
  });

  it("renders zero as zero", () => {
    expect(formatSol("0")).toBe("0,00");
  });

  // The whole point of going through decimal.ts: a value with more precision
  // than a double carries must survive to the digit that is displayed.
  it("does not lose precision the way a double would", () => {
    expect(formatSol("9007199254740993.45")).toBe("9.007.199.254.740.993,45");
  });

  it("marks a negative amount with a typographic minus", () => {
    expect(formatSol("-2.15")).toBe("−2,15");
  });
});

describe("formatUsdPrice", () => {
  it("renders a sub-cent price at four significant digits", () => {
    expect(formatUsdPrice("0.0000071")).toBe("US$0,0000071");
    expect(formatUsdPrice("0.000015")).toBe("US$0,000015");
  });

  it("keeps four significant digits below one, where a fixed scale would round to nothing", () => {
    expect(formatUsdPrice("0.00000712345")).toBe("US$0,000007123");
  });

  // At or above one the two-decimal floor takes over, because a price of
  // `US$123,5` is not how money reads and `US$12` is not a price at all.
  it("keeps two decimals for a value of one or more", () => {
    expect(formatUsdPrice("123.456")).toBe("US$123,46");
    expect(formatUsdPrice("12")).toBe("US$12,00");
    expect(formatUsdPrice("1802.4")).toBe("US$1.802,40");
  });

  it("renders a zero price as a zero price, not as an empty string", () => {
    expect(formatUsdPrice("0")).toBe("US$0,00");
  });
});

describe("formatTokenAmount", () => {
  it("compacts millions the way spec §2's row does", () => {
    expect(formatTokenAmount("16900000")).toBe("16,9M");
    expect(formatTokenAmount("1000000")).toBe("1M");
  });

  it("keeps `M` up to a billón, which is where es-ES switches letters", () => {
    // 1.69e9 is "mil seiscientos noventa millones" in Spanish, not "1,69 B":
    // `B` is 10^12 here, not the English short-scale billion.
    expect(formatTokenAmount("1690000000")).toBe("1.690M");
    expect(formatTokenAmount("2500000000000")).toBe("2,5B");
  });

  it("leaves a figure below a million alone, because the digits are shorter", () => {
    expect(formatTokenAmount("847")).toBe("847");
    expect(formatTokenAmount("1500")).toBe("1.500");
    expect(formatTokenAmount("999999")).toBe("999.999");
  });

  it("does not print a trailing decimal comma with nothing after it", () => {
    for (const amount of ["1000000", "847", "2000000000000"]) {
      expect(formatTokenAmount(amount)).not.toMatch(/,$/);
    }
  });

  it("keeps a fractional quantity rather than rounding it to zero", () => {
    expect(formatTokenAmount("0.5")).toBe("0,5");
  });

  // Past the range a double represents exactly, and never converted to one:
  // the tier is chosen and the digits produced from `decimal.ts`'s bigint.
  it("compacts a quantity larger than Number.MAX_SAFE_INTEGER", () => {
    expect(formatTokenAmount("9007199254740993")).toBe("9.007B");
  });
});

describe("formatRelative", () => {
  const now = Date.parse("2026-08-25T12:00:00Z");
  const ago = (seconds: number) => new Date(now - seconds * 1000).toISOString();

  it("abbreviates the way the feed row does", () => {
    expect(formatRelative(ago(240), now)).toBe("hace 4 min");
    expect(formatRelative(ago(30), now)).toBe("hace 30 s");
    expect(formatRelative(ago(3 * 3600), now)).toBe("hace 3 h");
    expect(formatRelative(ago(50 * 3600), now)).toBe("hace 2 d");
  });

  it("crosses each boundary at the right second", () => {
    expect(formatRelative(ago(59), now)).toBe("hace 59 s");
    expect(formatRelative(ago(60), now)).toBe("hace 1 min");
    expect(formatRelative(ago(3599), now)).toBe("hace 59 min");
    expect(formatRelative(ago(3600), now)).toBe("hace 1 h");
    expect(formatRelative(ago(86399), now)).toBe("hace 23 h");
    expect(formatRelative(ago(86400), now)).toBe("hace 1 d");
  });

  // Two clocks, one of them the reader's. A trade a few seconds "in the
  // future" is normal and must not render as a negative age.
  it("never renders a negative age", () => {
    expect(formatRelative(ago(-30), now)).toBe("ahora");
    expect(formatRelative(ago(0), now)).toBe("ahora");
  });
});
