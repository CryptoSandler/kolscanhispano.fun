import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { STATUS_LABEL } from "./admin/page";

/**
 * `CLAUDE.md`: *"Site UI copy: neutral Spanish (not Rioplatense)."*
 *
 * Stated as a convention, and conventions are what a writer forgets at the end
 * of a long change. This one was forgotten three times in one commit — the
 * `/registro` page shipped `Conectá`, `firmá`, `Podés`, `Publicá`, `pegá` and
 * `acá`, and the screenshot taken for the owner's gate is what caught them.
 * A scan is cheaper than a screenshot.
 *
 * **Voseo is the marker, not vocabulary.** The tell is the second-person
 * imperative and present with the stress on the last syllable — `conectá`,
 * `podés`, `tenés` — which `es-ES` and most of Latin America do not use. Words
 * that are merely regional (`acá`, `plata`) are a matter of taste; the verb
 * form is the one a reader in Madrid or Bogotá notices immediately.
 */

/**
 * The voseo forms this product's copy actually reaches for.
 *
 * **An explicit list, after an endings-based pattern was tried and abandoned.**
 * The heuristic — a word ending in `-á -é -í -ás -és -ís` — cannot separate
 * voseo from the ordinary future tense, because they share the ending and the
 * stem: `mirá` (vos, imperative) and `mirará` (it will look) both end in `rá`,
 * and so do `guardá` and `guardará`. Every version of that pattern needed an
 * exception list that grew with the copy — `qué`, `guardará`, `aparecerá` —
 * which is a maintained list either way, and the maintained list that produces
 * *no false positives* is the one naming the thing being looked for.
 *
 * ponytail: a list of the forms a Rioplatense writer reaches for first. It
 * misses a verb nobody listed; the upgrade is a conjugator, which is a
 * dependency for a check that has to be read more than it has to be complete.
 * Both times this rule was broken it was broken with a word on this list.
 */
const VOSEO = [
  // Imperatives: the -ar verbs this product's screens use.
  "conectá", "firmá", "pegá", "publicá", "probá", "mirá", "entrá", "dejá",
  "esperá", "cambiá", "guardá", "copiá", "revisá", "verificá", "agregá",
  "buscá", "seleccioná", "confirmá", "cancelá", "aceptá", "continuá", "volvé",
  "elegí", "escribí", "seguí", "abrí", "subí", "compartí", "andá", "vení",
  // Present, second person.
  "tenés", "podés", "querés", "sabés", "hacés", "sos", "vas a poder",
  // The pronoun itself, and the possessive that gives it away.
  "vos", "usás", "necesitás", "vení", "ponés", "recargá", "instalá", "pulsá",
];

const VOSEO_SET = new Set(VOSEO);

/** Words as a reader meets them, so `Conectá` and `conectá` are one word. */
const WORD = /[A-Za-zÁÉÍÓÚÑáéíóúñ]+/gu;

/** Every tracked page and component: what a reader actually sees. */
function uiFiles(): string[] {
  const root = join(import.meta.dirname, "..", "..");
  return execFileSync("git", ["ls-files", "src/app"], { cwd: root, encoding: "utf8" })
    .split("\n")
    .filter((file) => file.endsWith(".tsx"))
    .map((file) => join(root, file));
}

/**
 * The words a file's *copy* contains, which is deliberately narrower than the
 * file: comments are prose written for developers and are not held to the UI's
 * language rule. Comment bodies are stripped first, so a note explaining a
 * regionalism does not fail the check that enforces avoiding it.
 */
function copyWords(source: string): string[] {
  const withoutComments = source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/.*$/gm, "$1 ");
  return [...withoutComments.matchAll(WORD)]
    .map((match) => match[0].toLowerCase())
    .filter((word) => VOSEO_SET.has(word));
}

describe("the UI speaks neutral Spanish", () => {
  it("uses no voseo in any page or component", () => {
    const offenders: string[] = [];
    for (const file of uiFiles()) {
      for (const word of copyWords(readFileSync(file, "utf8"))) {
        offenders.push(`${file.split("/src/").pop()}: ${word}`);
      }
    }
    expect(offenders, "CLAUDE.md: UI copy is neutral Spanish, not Rioplatense").toEqual([]);
  });

  it("catches the forms that actually shipped", () => {
    // The six that reached the screenshot, upper and lower case alike.
    expect(copyWords("Conectá tu wallet y firmá. Podés pegá Publicá Probá.")).toEqual([
      "conectá", "firmá", "podés", "pegá", "publicá", "probá",
    ]);
  });

  it("flags nothing in ordinary neutral Spanish, including the future tense", () => {
    // `guardará` and `mirará` are the forms that made an endings-based pattern
    // unworkable: they end exactly like `guardá` and `mirá`.
    expect(
      copyWords(
        "Se guardará como @ejemplo. ¿Qué wallets quieres mostrar? Está aquí, " +
          "también así, y el número de días mirará el código público.",
      ),
    ).toEqual([]);
  });

  it("does not read a developer comment as UI copy", () => {
    // A comment explaining voseo must not fail the check about avoiding it.
    const source = `// no escribas "conectá" acá\nconst x = "Conecta tu wallet";`;
    expect(copyWords(source)).toEqual([]);
  });

  it("scans a meaningful number of files, so an empty glob cannot pass it", () => {
    expect(uiFiles().length).toBeGreaterThan(8);
  });
});

/**
 * The other way English reaches a Spanish screen: not a word somebody typed,
 * but a database enum rendered straight into the page.
 *
 * `/admin` printed `row.status` raw, so `approved`, `rejected` and `suspended`
 * all shipped in English while only `pending` had been translated. The voseo
 * scan above cannot see it — an English word is not voseo — and it was caught
 * by reading `test-results/capturas/admin-desktop-1280.png`, which is what
 * `~/.claude/GATES.md` and `/cierre` §3 now require of every capture.
 *
 * The guard is driven off migration 001's own `CHECK` list rather than a
 * second copy of it, so a fifth status added to the schema fails here instead
 * of appearing on the screen in English.
 */
describe("a status enum never reaches the screen untranslated", () => {
  /** The values migration 001 allows for `kol.status`, read from the migration. */
  function schemaStatuses(): string[] {
    const sql = readFileSync(join(process.cwd(), "migrations", "001_core.sql"), "utf8");
    const match = sql.match(/status\s+TEXT NOT NULL DEFAULT 'pending'\s*CHECK \(status IN \(([^)]*)\)\)/);
    if (!match) throw new Error("could not find kol.status CHECK in migrations/001_core.sql");
    return [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  }

  it("reads the four the schema actually declares", () => {
    expect(schemaStatuses()).toEqual(["pending", "approved", "rejected", "suspended"]);
  });

  it("has Spanish for every status the schema allows", () => {
    const missing = schemaStatuses().filter((status) => !(status in STATUS_LABEL));
    expect(missing, "every kol.status needs a STATUS_LABEL entry").toEqual([]);
  });

  it("translates them, rather than passing the English through", () => {
    for (const status of schemaStatuses()) {
      expect(STATUS_LABEL[status]).not.toBe(status);
    }
  });
});

/**
 * One screen, one name.
 *
 * `DESIGN.md`: *"The ranked list is called `Clasificación`, everywhere a reader
 * can see."* It had three names at once — the nav said `Clasificación`, the
 * onboarding CTA said `leaderboard`, and five sentences of body copy said *"el
 * ranking"* — which reads as three screens rather than one.
 *
 * **It looks for the words in Spanish prose, not for the words.** Subtracting
 * identifiers was tried first and does not converge: `row-leaderboard` is a
 * class, `/leaderboard` is a route, `readLeaderboard` is an import, and
 * `const leaderboard = await readLeaderboard(...)` is a local variable spelled
 * exactly like the English noun. Excluding each shape needs a rule per shape,
 * and the next shape ships unguarded.
 *
 * So the pattern names what it is looking for, the same way `VOSEO` above does
 * after an endings-based heuristic failed for the same reason: an article or a
 * preposition in front of the word, or the word heading a phrase with `de`
 * after it. That is what copy looks like and what an identifier never does.
 * Comments are stripped first, so `DECISIONES.md`'s quoted *"el ranking suma
 * todas las wallets"* in a developer note does not fail the check.
 *
 * `ranking` and `leaderboard` survive untouched wherever a reader never meets
 * them — identifiers, class names, and the `/leaderboard` route, which stays
 * because a published URL costs more to change than the inconsistency it removes.
 */
describe("the ranked list has one name in the UI", () => {
  /** Everything under `src/app` a reader's words can come out of, `.ts` included. */
  function copyFiles(): string[] {
    const root = join(import.meta.dirname, "..", "..");
    return execFileSync("git", ["ls-files", "src/app"], { cwd: root, encoding: "utf8" })
      .split("\n")
      .filter((file) => (file.endsWith(".tsx") || file.endsWith(".ts")) && !file.endsWith(".test.ts"))
      .map((file) => join(root, file));
  }

  /** The Spanish function words that mark the next noun as copy. */
  const ARTICLE = "el|la|los|las|un|una|del|al|de|en|tu|su|mi|nuestro";

  /** The two words, where they sit in Spanish prose rather than in code. */
  function bannedNames(source: string): string[] {
    const prose = source
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/(^|[^:])\/\/.*$/gm, "$1 ");
    const inPhrase = new RegExp(`\\b(?:${ARTICLE})\\s+(ranking|leaderboard)\\b`, "gi");
    const headsPhrase = /\b(ranking|leaderboard)\s+de\s+\p{L}/giu;
    return [
      ...[...prose.matchAll(inPhrase)].map((m) => m[1]),
      ...[...prose.matchAll(headsPhrase)].map((m) => m[1]),
    ];
  }

  it("says Clasificación and never ranking or leaderboard, in any page, component or route", () => {
    const offenders: string[] = [];
    for (const file of copyFiles()) {
      for (const word of bannedNames(readFileSync(file, "utf8"))) {
        offenders.push(`${file.split("/src/").pop()}: ${word}`);
      }
    }
    expect(offenders, "DESIGN.md: the ranked list is called Clasificación everywhere a reader can see").toEqual([]);
  });

  it("catches the three names that actually shipped together", () => {
    expect(bannedNames('<p>tu perfil no aparece en el ranking.</p>')).toEqual(["ranking"]);
    expect(bannedNames("<button>Entrar al leaderboard</button>")).toEqual(["leaderboard"]);
    expect(bannedNames('<p className="brand-subtitle">Ranking de traders hispanos</p>')).toEqual(["Ranking"]);
  });

  it("leaves the identifiers, the class names and the route alone", () => {
    // Every shape that made the subtract-the-identifiers version unworkable.
    expect(bannedNames('import { readLeaderboard, LEADERBOARD_TOP } from "@/lib/leaderboard";')).toEqual([]);
    expect(bannedNames('<table className="leaderboard admin-table">')).toEqual([]);
    expect(bannedNames('<tr className={`row-leaderboard is-podium-${n}`}>')).toEqual([]);
    expect(bannedNames('<Link href="/leaderboard">Clasificación</Link>')).toEqual([]);
    expect(bannedNames('{ href: "/leaderboard", label: "Clasificación" }')).toEqual([]);
    expect(bannedNames("const leaderboard = await readLeaderboard({ window, unit });")).toEqual([]);
    expect(bannedNames("<LeaderboardTable entries={leaderboard.entries} unit={unit} />")).toEqual([]);
    expect(bannedNames("`/leaderboard?window=${w}&unit=${u}`")).toEqual([]);
  });

  it("does not read a developer comment as UI copy", () => {
    expect(bannedNames("// the ranking reorders every window\nconst a = 1;")).toEqual([]);
    expect(bannedNames("/* DECISIONES.md: el ranking suma todas las wallets */")).toEqual([]);
  });

  it("scans a meaningful number of files, so an empty glob cannot pass it", () => {
    expect(copyFiles().length).toBeGreaterThan(20);
  });
});
