/**
 * The local avatar fallback: a monogram, drawn from the display name.
 *
 * DESIGN.md's `row-leaderboard` puts a 22px avatar on every row, and both
 * reference sites carry one — a row without one does not read as this category.
 * But the upstream is a third party we do not control, so **every** way the
 * image can fail resolves here instead: a KOL with no handle, an upstream 404,
 * an upstream timeout, a body that is not an image. Same box, same size, no
 * broken-image glyph and no layout shift, ever.
 *
 * It imports nothing. That is load-bearing: `feed-live.tsx` is a client
 * component, and a module that reached `db.ts` for this would drag `pg` into the
 * browser bundle. `avatar.ts` (server, with the database) and `avatar.tsx` (the
 * component, on both sides) both read the letter from here, so the fallback the
 * route serves and the fallback the markup draws are the same letter.
 */

/**
 * DESIGN.md's palette, transcribed for a context that cannot read a CSS
 * variable: an SVG inside an `<img>` is a separate document with no access to
 * `:root`. These two are `surface-3` and `ink-subtle`, and `monogram.test.ts`
 * parses DESIGN.md's `colors:` block and fails if either drifts from it — so
 * this is a guarded transcription, not a second palette.
 *
 * They are what `.avatar` already paints in `globals.css`, so a row whose image
 * is still loading and a row whose image is the monogram look the same.
 */
export const MONOGRAM_BACKGROUND = "#23272c";
export const MONOGRAM_INK = "#7e878f";

/**
 * The one character the avatar shows. `?` when the name is empty or is nothing
 * but whitespace — `slice(0, 1)` on a trimmed empty string is `""`, which would
 * render an avatar with a hole in it.
 *
 * Deliberately the first *code point*, not the first UTF-16 unit: `"Ñandú"`
 * is fine either way, but an emoji or an astral-plane character sliced at one
 * unit yields half a surrogate pair and a replacement glyph.
 */
export function monogramLetter(name: string): string {
  return [...name.trim()][0]?.toUpperCase() ?? "?";
}

/** XML-escapes text destined for an SVG text node. */
function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * The monogram as an SVG document, for the avatar route to serve.
 *
 * 44×44 rather than 22×22: the box is 22 CSS pixels, and this is what a 2× and
 * 3× display renders into. It is a vector, so the size only fixes the
 * proportions — the type scales with it.
 *
 * A square with no border and no corner radius, deliberately. `.avatar` in
 * `globals.css` already draws the 22px circle, its hairline and `overflow:
 * hidden`, and `.avatar img` already covers it — so a ring drawn here would sit
 * inside that one and read as a 2px double border at the exact size where 2px
 * is a tenth of the element.
 *
 * `font-family` names a stack rather than the site's face: this document is
 * loaded by the browser's image decoder, which has no access to `next/font`'s
 * `@font-face` rules. `system-ui` is the closest thing available there, and one
 * capital letter is where a substituted face costs least.
 *
 * Deterministic: same name in, same bytes out. That is what lets it be cached
 * and what makes the letter stable across a reload.
 */
export function monogramSvg(name: string): string {
  const letter = escapeXml(monogramLetter(name));
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="44" height="44" viewBox="0 0 44 44">` +
    `<rect width="44" height="44" fill="${MONOGRAM_BACKGROUND}"/>` +
    `<text x="22" y="22" fill="${MONOGRAM_INK}" font-family="system-ui, sans-serif" ` +
    `font-size="20" font-weight="600" text-anchor="middle" dominant-baseline="central">` +
    `${letter}</text>` +
    `</svg>`
  );
}
