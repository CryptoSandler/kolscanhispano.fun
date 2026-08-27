/**
 * The monogram is the one thing every avatar failure resolves to, so the two
 * properties that matter are that it is **deterministic** — same name in, same
 * bytes out, which is what lets it be cached and what keeps the letter stable
 * across a reload — and that its colours are **DESIGN.md's**.
 *
 * The palette is asserted against the document rather than restated, the way
 * `design-tokens.test.ts` asserts the stylesheet. An SVG inside an `<img>` is a
 * separate document with no access to `:root`, so these three hexes have to be
 * literals somewhere; this is what stops them from becoming a second palette.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MONOGRAM_BACKGROUND, MONOGRAM_INK, monogramLetter, monogramSvg } from "./monogram";

const DESIGN = readFileSync(join(import.meta.dirname, "..", "..", "DESIGN.md"), "utf8");

/** DESIGN.md's `colors:` block, as { token: "#rrggbb" }. */
function designColors(): Record<string, string> {
  const block = DESIGN.split(/^colors:$/m)[1]?.split(/^[a-z]+:/m)[0];
  if (!block) throw new Error("DESIGN.md has no colors: block");
  const out: Record<string, string> = {};
  for (const line of block.split("\n")) {
    const match = line.trim().match(/^([a-z0-9-]+): "(#[0-9a-f]{6})"$/i);
    if (match) out[match[1]] = match[2].toLowerCase();
  }
  return out;
}

describe("the monogram uses DESIGN.md's palette and no other colour", () => {
  it("takes both its hexes from the document", () => {
    const colors = designColors();
    expect(MONOGRAM_BACKGROUND, "surface-3").toBe(colors["surface-3"]);
    expect(MONOGRAM_INK, "ink-subtle").toBe(colors["ink-subtle"]);
  });

  it("introduces no hex the document does not define", () => {
    const palette = new Set(Object.values(designColors()));
    const used = [...monogramSvg("Brújula Rota").matchAll(/#[0-9a-f]{6}/gi)].map(([hex]) =>
      hex.toLowerCase(),
    );
    expect(used.length).toBeGreaterThan(0);
    for (const hex of used) expect(palette, `${hex} is in DESIGN.md's palette`).toContain(hex);
  });
});

describe("monogramLetter", () => {
  it("takes the first character of the name, uppercased", () => {
    expect(monogramLetter("Brújula Rota")).toBe("B");
    expect(monogramLetter("tortuga veloz")).toBe("T");
  });

  it("answers `?` rather than nothing for an empty or blank name", () => {
    // `"".slice(0, 1)` is `""`, which would render a circle with a hole in it.
    expect(monogramLetter("")).toBe("?");
    expect(monogramLetter("   ")).toBe("?");
  });

  it("takes a whole code point, not half a surrogate pair", () => {
    // Sliced at one UTF-16 unit this yields a lone high surrogate and the
    // browser draws a replacement glyph.
    expect(monogramLetter("𝕏 Handle")).toBe("𝕏");
  });
});

describe("monogramSvg", () => {
  it("is deterministic: the same name yields the same bytes", () => {
    expect(monogramSvg("Farol de Niebla")).toBe(monogramSvg("Farol de Niebla"));
    expect(monogramSvg("Farol de Niebla")).not.toBe(monogramSvg("Nube Baja"));
  });

  it("escapes a name that would otherwise close the text node", () => {
    const svg = monogramSvg("<script>alert(1)</script>");
    expect(svg).toContain("&lt;");
    expect(svg).not.toContain("<script");
    // One element deep and still well-formed: the letter is the only variable.
    expect(svg.match(/<text /g)).toHaveLength(1);
  });

  it("draws the letter in a square box, so the 22px circle never reflows", () => {
    const svg = monogramSvg("Hilo Fino");
    expect(svg).toContain('width="44" height="44"');
    expect(svg).toContain('viewBox="0 0 44 44"');
    expect(svg).toContain(">H</text>");
  });

  it("draws no ring of its own: `.avatar` already owns the circle and its hairline", () => {
    // A stroke here would sit inside the span's 1px border and read as a 2px
    // double ring at the one size where 2px is a tenth of the element.
    const svg = monogramSvg("Ancla Suelta");
    expect(svg).not.toContain("stroke");
    expect(svg).not.toContain("rx=");
  });
});
