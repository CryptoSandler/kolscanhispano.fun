/**
 * Which of DESIGN.md's four cabal tints a cabal gets.
 *
 * `chip-cabal`: *"its text in one of four tints assigned per cabal: `cabal-a`
 * violet, `cabal-b` pink, `cabal-c` peach, `cabal-d` slate. Four fixed tokens
 * rather than a generated hue, because a generated one can land on green or
 * red — reserved here for money — or on a podium tint. **A fifth cabal reuses
 * the first**: repetition is honest, a colour outside the palette is not."*
 *
 * So the assignment has to be a function of the tag and nothing else. Not a
 * position in a list — the ranking reorders every window, and a chip that
 * changed colour when its KOL moved from rank 4 to rank 5 would be telling the
 * reader about the sort rather than about the cabal. Not a counter either:
 * that is state, and two surfaces holding it separately (the row and the
 * modal's header) would disagree on the same page.
 *
 * A tag is three or four uppercase letters (`cabal.tag` is
 * `CHECK (tag ~ '^[A-Z]{3,4}$')`, `migrations/001_core.sql`), so the hash below
 * is over a handful of characters and its only job is to spread them. It is
 * deliberately arithmetic a person can run by hand: the same tag gives the same
 * tint on the server, in the browser, and after a redeploy, which is what
 * "keeps its colour across renders and reloads" means in practice.
 *
 * There is no attempt to guarantee that four cabals get four different tints.
 * The document rules that out in as many words — a fifth *must* collide — and a
 * scheme that avoided collisions among the first four would have to know how
 * many cabals exist, which is exactly the global state this is written to
 * avoid.
 */

/** The four tints DESIGN.md publishes, in the order it names them. */
export const CABAL_TINTS = ["a", "b", "c", "d"] as const;

export type CabalTint = (typeof CABAL_TINTS)[number];

/** Keeps the running hash inside the exactly-representable integer range. */
const MODULUS = 1_000_003;

export function cabalTint(tag: string): CabalTint {
  let hash = 0;
  for (let i = 0; i < tag.length; i += 1) {
    hash = (hash * 31 + tag.charCodeAt(i)) % MODULUS;
  }
  return CABAL_TINTS[hash % CABAL_TINTS.length];
}

/** The chip's classes: the component's own, plus the tint this tag resolves to. */
export function cabalChipClass(tag: string): string {
  return `chip-cabal chip-cabal-${cabalTint(tag)}`;
}
