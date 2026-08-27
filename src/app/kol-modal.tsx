"use client";

import { createContext } from "react";

/**
 * The seam for DESIGN.md's `modal-kol`, which task B builds.
 *
 * DESIGN.md `row-leaderboard`: *"whole row clickable and focusable (it opens
 * the modal)"*. The modal does not exist yet, and the same document's last
 * Don't is *"**Don't** show a control that does not work"* — so the row's
 * affordance is written now and **switched on by the presence of a provider**,
 * not by a flag someone has to remember to flip.
 *
 * Today nothing provides one, so {@link KolRow} renders a plain `<tr>`: no
 * `tabindex`, no pointer, no handler, nothing for a reader to click that
 * answers with silence. The moment task B renders
 *
 *     <KolModalContext.Provider value={open}>{table}</KolModalContext.Provider>
 *
 * around the table — a client component may wrap server-rendered children, so
 * `LeaderboardTable` stays a server component — every row becomes clickable and
 * keyboard-operable with no change to this file, to `kol-row.tsx` or to
 * `leaderboard-table.tsx`.
 *
 * `NO_MODAL` is exported so the row can tell "no provider" from "a provider
 * that happens to hand me a function". Identity comparison, not a boolean prop:
 * a boolean would be a second thing to keep in step with the provider.
 */
export type OpenKol = (slug: string) => void;

/** The default value of the context, and the sentinel for "no modal mounted". */
export const NO_MODAL: OpenKol = () => {};

export const KolModalContext = createContext<OpenKol>(NO_MODAL);
