/**
 * DESIGN.md is normative, so this file reads it rather than restating it.
 *
 * Every value asserted below is parsed out of `DESIGN.md` at run time. Nothing
 * here hardcodes a hex, a pixel or a ratio: if the document changes, this test
 * changes with it, and the only way to make it pass is to move the stylesheet
 * to match the document. A guardian that carried its own copy of the palette
 * would be a second source of truth, which is the thing it exists to prevent.
 *
 * Whitespace is collapsed before every comparison, so reformatting either file
 * -- reflowing the frontmatter, reindenting the CSS block -- never fails a
 * test about colour.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..");
const DESIGN = readFileSync(join(ROOT, "DESIGN.md"), "utf8");
const CSS = readFileSync(join(ROOT, "src", "app", "globals.css"), "utf8");

const squash = (s: string): string => s.replace(/\s+/g, " ").trim();

/** The frontmatter's `colors:` block, as { token: "#rrggbb" }. */
function designColors(): Record<string, string> {
  const block = DESIGN.split(/^colors:$/m)[1]?.split(/^[a-z]+:/m)[0];
  if (!block) throw new Error("DESIGN.md has no colors: block");
  const out: Record<string, string> = {};
  for (const line of block.split("\n")) {
    const m = squash(line).match(/^([a-z0-9-]+): "(#[0-9a-f]{6})"$/i);
    if (m) out[m[1]] = m[2].toLowerCase();
  }
  return out;
}

/** A `--name: value;` declaration from globals.css's :root block. */
function cssVar(name: string): string {
  const m = squash(CSS).match(new RegExp(`--${name}:\\s*([^;]+);`));
  if (!m) throw new Error(`globals.css defines no --${name}`);
  return m[1].trim().toLowerCase();
}

/**
 * DESIGN.md names tokens for the design system; the stylesheet names them for
 * the component that uses them. This is the only reconstruction in the file,
 * and it is a rename table, not a copy of any value.
 */
const CSS_NAME: Record<string, string> = {
  primary: "accent",
  "on-primary": "on-accent",
  "primary-hover": "accent-hover",
  "semantic-gain": "gain",
  "semantic-loss": "loss",
  "semantic-stale": "stale",
  "semantic-neutral": "neutral",
};

function relativeLuminance(hex: string): number {
  const channel = (v: number): number => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const n = Number.parseInt(hex.slice(1), 16);
  return (
    0.2126 * channel((n >> 16) & 255) +
    0.7152 * channel((n >> 8) & 255) +
    0.0722 * channel(n & 255)
  );
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

describe("the stylesheet matches DESIGN.md", () => {
  it("defines every colour the document specifies, at the document's value", () => {
    const colors = designColors();
    expect(Object.keys(colors).length).toBeGreaterThan(10);

    for (const [token, hex] of Object.entries(colors)) {
      const name = CSS_NAME[token] ?? token;
      expect(cssVar(name), `--${name} (DESIGN.md "${token}")`).toBe(hex);
    }
  });

  it("uses the document's spacing and radii", () => {
    const spacing = squash(DESIGN.match(/^spacing: \{([^}]*)\}/m)?.[1] ?? "");
    const rounded = squash(DESIGN.match(/^rounded: \{([^}]*)\}/m)?.[1] ?? "");
    expect(spacing, "DESIGN.md spacing block").not.toBe("");
    expect(rounded, "DESIGN.md rounded block").not.toBe("");

    for (const pair of [...spacing.split(","), ...rounded.split(",")]) {
      const m = squash(pair).match(/^([a-z-]+): (\d+px)$/);
      if (!m) continue;
      const [, key, value] = m;
      const name = ["sm", "md", "lg", "pill"].includes(key) ? `radius-${key}` : key;
      expect(cssVar(name), `--${name}`).toBe(value);
    }
  });
});

/**
 * Which background each row of the contrast table is measured against, read
 * out of the sentence beneath it:
 *
 *   "The four cabal tints are measured against `canvas #0f1113`, the ink the
 *    solid chip prints in; every other row is against `surface-1`."
 *
 * Parsed rather than restated, for the same reason the palette is: a document
 * that moves the chip onto another surface, or adds a second exception, must
 * move this test with it or fail it. The alternative -- a hardcoded
 * `{ "cabal-": "surface-2" }` in this file -- is a second source of truth about
 * the one thing the guardian exists to prevent a second source of truth about.
 *
 * The exception exists because a chip has its own ground, and **which ground
 * moved on 2026-09-02**: the chip went solid, so the tint is the background and
 * `canvas` is the ink on it. The measured pair is the one a reader looks at —
 * `cabal-a` against `surface-1` is 6.48, against `surface-2` 6.02, against
 * `canvas` 6.95, and only the last describes the chip `globals.css` renders.
 *
 * The ground is therefore allowed to be `canvas` as well as a `surface-N`. It
 * is still read out of the document and still checked against the palette; what
 * widened is the set of grounds the sentence may name, not the number of things
 * this function is willing to believe.
 */
function measuredAgainst(colors: Record<string, string>): (token: string) => string {
  const exception = squash(DESIGN).match(
    /The four ([a-z0-9]+) tints are measured against `(surface-[0-9]+|canvas) (#[0-9a-f]{6})`/i,
  );
  const fallback = squash(DESIGN).match(/every other row is against `(surface-[0-9]+)`/i);
  if (!exception || !fallback) {
    throw new Error("DESIGN.md no longer says which surface its contrast table is measured against");
  }

  const [, family, exceptionSurface, exceptionHex] = exception;
  // The sentence quotes the surface's hex as well as its name. If the palette
  // above ever moves and the sentence does not, that is the document
  // disagreeing with itself, and it fails here rather than being averaged over.
  expect(colors[exceptionSurface], `${exceptionSurface} in the palette matches the sentence`).toBe(
    exceptionHex.toLowerCase(),
  );

  const base = colors[fallback[1]];
  expect(base, `${fallback[1]} is in the palette`).toBeTruthy();

  return (token) => (token.startsWith(`${family}-`) ? colors[exceptionSurface] : base);
}

describe("the contrast table in DESIGN.md is true", () => {
  // The document publishes a ratio per token. Recomputing it from the
  // document's own hex values is what makes that table a claim rather than a
  // decoration -- and it is how a colour lifted in the palette but not in the
  // table gets caught.
  // Backgrounds are what other colours are measured *against*, so they carry no
  // foreground ratio of their own. Everything else is text or a glyph somewhere
  // and owes the table a row. This case was written during the modal build,
  // went red on `primary-hover` and `semantic-neutral`, and was deleted rather
  // than acted on -- it is restored here with those two rows added, because a
  // rule the document states and nothing enforces is a rule that drifts.
  it("gives every foreground colour a row in the table", () => {
    const BACKGROUNDS = new Set([
      "canvas", "surface-1", "surface-2", "surface-3",
      "hairline", "hairline-strong", "on-primary",
      "podium-1-wash", "podium-2-wash", "podium-3-wash",
    ]);
    const documented = new Set(
      [...DESIGN.matchAll(/^\| `([a-z0-9-]+) #[0-9a-f]{6}` \| \d+\.\d+ \| \w+ \|$/gim)].map((m) => m[1]),
    );
    const missing = Object.keys(designColors())
      .filter((t) => !BACKGROUNDS.has(t) && !documented.has(t));
    expect(missing, "palette colours with no measured ratio in DESIGN.md").toEqual([]);
  });

  it("matches the published ratio for every row, to two decimals", () => {
    const colors = designColors();
    const surfaceFor = measuredAgainst(colors);
    const rows = [...DESIGN.matchAll(/^\| `([a-z0-9-]+) (#[0-9a-f]{6})` \| (\d+\.\d+) \| (\w+) \|$/gim)];
    expect(rows.length, "rows in the contrast table").toBeGreaterThanOrEqual(7);

    for (const [, token, hex, published, verdict] of rows) {
      expect(colors[token], `${token} is still in the palette at the table's value`).toBe(hex);
      const surface = surfaceFor(token);
      const measured = contrast(hex, surface);
      expect(measured.toFixed(2), `${token} measured against ${surface}`).toBe(published);
      expect(verdict).toBe("PASS");
      expect(measured, `${token} clears AA for normal text`).toBeGreaterThanOrEqual(4.5);
    }
  });
});
