import { describe, expect, it } from "vitest";
import { CABAL_TINTS, cabalChipClass, cabalTint } from "./cabal";

/** Every three- and four-letter tag `cabal.tag`'s CHECK constraint admits. */
function* tags(): Generator<string> {
  const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  for (const a of letters) for (const b of letters) for (const c of letters) yield a + b + c;
}

describe("cabalTint", () => {
  it("gives the same tag the same tint every time it is asked", () => {
    // The property DESIGN.md actually needs: "the same cabal keeps its colour
    // across renders and reloads". A pure function of the tag has it by
    // construction, which is why this is one line and not a fixture.
    for (const tag of ["ORB", "LUNA", "VEL", "ZZZZ"]) {
      expect(cabalTint(tag)).toBe(cabalTint(tag));
    }
  });

  it("never leaves the four tints the document publishes", () => {
    // Exhaustive over the three-letter tags, which is 17,576 of them: no input
    // the constraint admits can produce a fifth class name.
    for (const tag of tags()) {
      expect(CABAL_TINTS).toContain(cabalTint(tag));
    }
  });

  it("wraps at four rather than inventing a fifth colour", () => {
    // DESIGN.md `chip-cabal`: "A fifth cabal reuses the first: repetition is
    // honest, a colour outside the palette is not." Five distinct tags cannot
    // yield five distinct tints, so a collision is required, not tolerated.
    const five = ["AAA", "AAB", "AAC", "AAD", "AAE"].map(cabalTint);
    expect(new Set(five).size).toBeLessThanOrEqual(4);
  });

  it("reaches all four tints, so the palette is not three colours in practice", () => {
    const reached = new Set<string>();
    for (const tag of tags()) reached.add(cabalTint(tag));
    expect([...reached].sort()).toEqual([...CABAL_TINTS].sort());
  });

  it("separates the three cabals the preview fixture seeds", () => {
    // Not a property of the hash — it is a property of *these three tags* under
    // it, and it is what the owner's visual gate depends on: `scripts/
    // seed-preview.ts` seeds `LUNA`, `ORB` and `VEL`, and a preview where two
    // of them came out the same colour would show the mechanism as broken when
    // it was merely unlucky. If the hash is ever changed, check this case
    // rather than deleting it.
    expect(new Set(["LUNA", "ORB", "VEL"].map(cabalTint)).size).toBe(3);
  });
});

describe("cabalChipClass", () => {
  it("keeps the component class and adds the tint", () => {
    // The component class carries the ground, the radius and the `label` role;
    // the tint carries only `color`. Dropping either would take the chip off
    // `surface-2`, which is the background DESIGN.md measured the tints
    // against.
    const className = cabalChipClass("ORB");
    expect(className.startsWith("chip-cabal ")).toBe(true);
    expect(className).toBe(`chip-cabal chip-cabal-${cabalTint("ORB")}`);
  });
});
