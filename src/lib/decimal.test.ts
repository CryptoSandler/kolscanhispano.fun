import { describe, expect, it } from "vitest";
import { DECIMALS, ONE, formatDecimal, mulDiv, parseDecimal } from "./decimal";

describe("parseDecimal", () => {
  it("scales a plain decimal exactly", () => {
    expect(parseDecimal("1")).toBe(ONE);
    expect(parseDecimal("0.5")).toBe(ONE / 2n);
    expect(parseDecimal("4")).toBe(4n * ONE);
    expect(parseDecimal("0.000000001")).toBe(ONE / 10n ** 9n);
  });

  it("keeps values a double cannot represent", () => {
    // 0.1 + 0.2 === 0.30000000000000004 in binary floating point. This is the
    // whole reason the module exists, so it is asserted rather than assumed.
    expect(parseDecimal("0.1") + parseDecimal("0.2")).toBe(parseDecimal("0.3"));
  });

  it("keeps every digit of a value past double precision", () => {
    // 20 significant digits: a double holds 15-17.
    const value = parseDecimal("12345678.90123456789");
    expect(formatDecimal(value)).toBe("12345678.90123456789");
  });

  it("reads the sign", () => {
    expect(parseDecimal("-1.5")).toBe(-(ONE + ONE / 2n));
    expect(parseDecimal("+1.5")).toBe(ONE + ONE / 2n);
    expect(parseDecimal("-0")).toBe(0n);
  });

  it("reads exponent notation, which `pg` produces for a small JS number", () => {
    // String(1e-8) === "1e-8", and Postgres stores that faithfully.
    expect(parseDecimal("1e-8")).toBe(ONE / 10n ** 8n);
    expect(parseDecimal("1.5e3")).toBe(1500n * ONE);
    expect(parseDecimal("2E+2")).toBe(200n * ONE);
  });

  it("tolerates the forms Postgres and pg emit around the point", () => {
    expect(parseDecimal("5.")).toBe(5n * ONE);
    expect(parseDecimal(".5")).toBe(ONE / 2n);
    expect(parseDecimal("  7  ")).toBe(7n * ONE);
    expect(parseDecimal("0.500")).toBe(ONE / 2n);
  });

  it("rounds half away from zero below the last digit it keeps", () => {
    const half = `0.${"0".repeat(DECIMALS)}5`;
    expect(parseDecimal(half)).toBe(1n);
    expect(parseDecimal(`-${half}`)).toBe(-1n);
    expect(parseDecimal(`0.${"0".repeat(DECIMALS)}4`)).toBe(0n);
  });

  it("refuses anything that is not a decimal number", () => {
    for (const bad of ["", ".", "abc", "1.2.3", "NaN", "Infinity", "1,5", "0x10", "1 2", "--1", "1e"]) {
      expect(() => parseDecimal(bad), bad).toThrow(/not a decimal number/);
    }
  });

  /**
   * `multichain.md` §1.4. The module's stated invariant is *nine spare digits
   * below the smallest unit that exists on chain*, and the smallest unit is
   * one wei — 10^-18 — not one lamport. At DECIMALS = 18 a wei was exactly one
   * unit in the last place, the margin was zero, and the rounding above (which
   * the module calls unreachable in practice) was reachable by the smallest
   * amount an EVM chain can express.
   *
   * Both halves are pinned: the margin as arithmetic, and one wei surviving a
   * round trip through the two doors of this module unchanged. A regression to
   * 18 fails the first; a regression to anything below 18 fails the second.
   */
  it("keeps nine spare digits below one wei, the smallest on-chain unit", () => {
    const WEI_DECIMALS = 18;
    expect(DECIMALS - WEI_DECIMALS).toBe(9);

    const oneWei = `0.${"0".repeat(WEI_DECIMALS - 1)}1`;
    expect(formatDecimal(parseDecimal(oneWei))).toBe(oneWei);
    // Nine digits of headroom means a division by 10^9 still lands on the grid
    // exactly rather than rounding: that is what "spare digits" buys.
    expect(parseDecimal(oneWei) / 10n ** 9n).toBe(1n);
    expect(parseDecimal(oneWei) % 10n ** 9n).toBe(0n);
  });

  it("refuses a magnitude no real amount could reach", () => {
    expect(() => parseDecimal("1e61")).toThrow(/out of range/);
    expect(() => parseDecimal("1e-61")).toThrow(/out of range/);
    expect(() => parseDecimal(`1${"0".repeat(61)}`)).toThrow(/out of range/);
  });
});

describe("formatDecimal", () => {
  it("renders canonically, with no trailing zeros and no exponent", () => {
    expect(formatDecimal(ONE)).toBe("1");
    expect(formatDecimal(0n)).toBe("0");
    expect(formatDecimal(ONE / 2n)).toBe("0.5");
    expect(formatDecimal(-ONE / 4n)).toBe("-0.25");
    expect(formatDecimal(1n)).toBe(`0.${"0".repeat(DECIMALS - 1)}1`);
  });

  it("never produces negative zero", () => {
    expect(formatDecimal(-0n)).toBe("0");
  });

  it("round-trips every value it can render", () => {
    const values = [0n, 1n, -1n, ONE, -ONE, ONE * 12345n + 6789n, -(ONE * 7n) - 1n];
    for (const value of values) expect(parseDecimal(formatDecimal(value))).toBe(value);
  });
});

describe("mulDiv", () => {
  it("keeps the scale", () => {
    // 2 * 3 / 4 = 1.5
    expect(mulDiv(2n * ONE, 3n * ONE, 4n * ONE)).toBe(ONE + ONE / 2n);
  });

  it("takes the whole of `a` when b === c", () => {
    // The full-exit case: the sale must remove exactly the recorded cost,
    // leaving no residue behind on the position.
    const cost = 7n * ONE + 123n;
    expect(mulDiv(cost, 5n * ONE, 5n * ONE)).toBe(cost);
  });

  it("conserves the whole cost across a two-step exit, where dividing twice does not", () => {
    // 1 SOL of cost over 3 tokens, sold as 1 then 2. Whatever the rounding,
    // exiting completely must remove exactly the 1 SOL that went in.
    const start = ONE;

    let cost = start;
    let qty = 3n * ONE;
    const removed = mulDiv(cost, ONE, qty);
    expect(formatDecimal(removed)).toBe(`0.${"3".repeat(DECIMALS)}`);
    cost -= removed;
    qty -= ONE;
    const onePass = removed + mulDiv(cost, 2n * ONE, qty);
    expect(onePass).toBe(start);

    // The `avg = cost / qty` then `avg × sold` form re-divides on the second
    // sell, drops the half-unit the first division left, and multiplies the
    // loss back up: 1 unit of cost is stranded and shows up as realized profit.
    let twoCost = start;
    let twoQty = 3n * ONE;
    let average = mulDiv(twoCost, ONE, twoQty);
    const twoRemoved = mulDiv(average, ONE, ONE);
    twoCost -= twoRemoved;
    twoQty -= ONE;
    average = mulDiv(twoCost, ONE, twoQty);
    const twoPass = twoRemoved + mulDiv(average, 2n * ONE, ONE);
    expect(twoPass).toBe(start - 1n);
  });

  it("refuses to divide by zero rather than returning something", () => {
    expect(() => mulDiv(ONE, ONE, 0n)).toThrow(/division by zero/);
  });
});
