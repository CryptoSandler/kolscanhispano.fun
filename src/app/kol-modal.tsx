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

/**
 * The slugs of KOLs the API answered `404` for while the reader had their modal
 * open.
 *
 * DESIGN.md, on the gone state: *"the row leaves the list when the modal
 * closes"* — and, in the paragraph beneath the table, *"the stale row is
 * removed on close rather than left to invite a second click."* A row whose KOL
 * has been withdrawn or suspended since the page rendered is a control that
 * cannot work, which the same document's last Don't forbids.
 *
 * It is a **context** and not a prop for the same reason `KolModalContext` is:
 * `LeaderboardTable` is a server component and the rows are rendered on the
 * server, so the only place a client can reach them is where they already read
 * one context. {@link KolRow} is the single consumer; nothing else needs to
 * know.
 *
 * The default is a shared frozen empty set rather than a fresh one per render,
 * so a table with no provider above it never re-renders on identity alone.
 */
export const NO_GONE_KOLS: ReadonlySet<string> = new Set();

export const GoneKolsContext = createContext<ReadonlySet<string>>(NO_GONE_KOLS);
