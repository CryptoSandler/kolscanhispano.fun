import type { ProofAction } from "./wallet-proof";

/**
 * What a cabal action is *about*, and how that is spelled.
 *
 * **Its own module because the panel needs it and the panel is a client
 * component.** `cabal-actions.ts` imports `db.ts`, which imports `pg`; the
 * moment `/mi-cabal` imported one constant from there, the build tried to put a
 * Postgres driver in the browser bundle and said so. Nothing here touches a
 * database, a clock or a network — it is string handling, and it is the string
 * both sides have to agree on.
 *
 * **The route that issues a nonce and the handler that spends it must produce
 * the same subject**, because the nonce is bound to it server-side and the
 * signature covers it byte for byte. One function, called from both, is what
 * keeps that true — a subject built twice is a subject that eventually differs
 * by a `@`.
 */

export const TAG = /^[A-Z]{3,4}$/;
export const COLORS = new Set(["a", "b", "c", "d"]);

/**
 * The subject line for an action about a cabal, and for one about a KOL.
 *
 * **The route that issues the nonce and the handler that spends it must produce
 * the same string**, because the nonce is bound to it server-side and the
 * signature covers it byte for byte. One function each, used on both sides, is
 * what keeps that true — a subject built twice is a subject that eventually
 * differs by a `@`.
 */
export function subjectForTag(tag: string): string {
  return tag.trim().toUpperCase();
}

export function subjectForHandle(handle: string): string {
  return `@${handle.trim().replace(/^@/, "")}`;
}

/**
 * The twelve actions this module handles, and which kind of subject each takes.
 *
 * Exported because the route that **issues** the nonce has to write the same
 * subject the handler will later spend, and the only safe way to guarantee that
 * is for both to call this.
 */
export const CABAL_ACTIONS = {
  "crear cabal": "tag",
  "pedir entrar al cabal": "tag",
  "aceptar solicitud": "handle",
  "rechazar solicitud": "handle",
  "expulsar del cabal": "handle",
  "transferir el cabal": "handle",
  "nombrar co-líder": "handle",
  "revocar co-líder": "handle",
  // The two reads name the cabal, not a person: a leader asks about their own
  // queue, and an applicant asks about the one cabal they asked to join.
  "ver solicitudes": "tag",
  "ver mi solicitud": "tag",
  "reclamar cabal": "tag",
  "disolver cabal": "tag",
} as const satisfies Partial<Record<ProofAction, "tag" | "handle">>;

export type CabalAction = keyof typeof CABAL_ACTIONS;

export function isCabalAction(value: unknown): value is CabalAction {
  return typeof value === "string" && value in CABAL_ACTIONS;
}

/**
 * The subject line for an action, from whatever the caller typed.
 *
 * `null` when the input cannot be a subject at all, so a nonce is never issued
 * against a target that no handler could resolve — a row nobody can ever spend.
 */
export function subjectFor(action: CabalAction, raw: string): string | null {
  if (CABAL_ACTIONS[action] === "tag") {
    const tag = subjectForTag(raw);
    return TAG.test(tag) ? tag : null;
  }
  const subject = subjectForHandle(raw);
  return handleFromSubject(subject) === null ? null : subject;
}

/** The handle inside a subject line, or `null` if there is not one. */
export function handleFromSubject(subject: string | undefined): string | null {
  if (subject === undefined) return null;
  const handle = subject.trim().replace(/^@/, "");
  return /^[A-Za-z0-9_]{1,15}$/.test(handle) ? handle : null;
}
