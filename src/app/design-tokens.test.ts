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

describe("the contrast table in DESIGN.md is true", () => {
  // The document publishes a ratio per token. Recomputing it from the
  // document's own hex values is what makes that table a claim rather than a
  // decoration -- and it is how a colour lifted in the palette but not in the
  // table gets caught.
  it("matches the published ratio for every row, to two decimals", () => {
    const colors = designColors();
    const surface = colors["surface-1"];
    const rows = [...DESIGN.matchAll(/^\| `([a-z-]+) (#[0-9a-f]{6})` \| (\d+\.\d+) \| (\w+) \|$/gim)];
    expect(rows.length, "rows in the contrast table").toBeGreaterThanOrEqual(7);

    for (const [, token, hex, published, verdict] of rows) {
      expect(colors[token], `${token} is still in the palette at the table's value`).toBe(hex);
      const measured = contrast(hex, surface);
      expect(measured.toFixed(2), `${token} measured against surface-1`).toBe(published);
      expect(verdict).toBe("PASS");
      expect(measured, `${token} clears AA for normal text`).toBeGreaterThanOrEqual(4.5);
    }
  });
});
