"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { PublicKolDetail } from "@/lib/serialize";
import { LEADERBOARD_WINDOWS, WINDOW_LABELS, type LeaderboardWindow } from "@/lib/windows";
import { KolDetail } from "./kol-detail";
import { KolModalContext } from "./kol-modal";

/**
 * DESIGN.md's `modal-kol`, and the provider task A left the seam for.
 *
 * *"opened from a row, dismissible by `Esc`, backdrop click and a close button;
 * focus trapped; the trigger row regains focus on close."*
 *
 * It wraps the table. A client component may wrap server-rendered children, so
 * `LeaderboardTable` stays a server component and every cell is still formatted
 * on the server; the only thing that changes for the row is that a provider now
 * exists, which is what switches its affordance on — no edit to `kol-row.tsx`,
 * exactly as A's report describes.
 *
 * ## Why a native `<dialog>`
 *
 * `showModal()` is the platform feature that already does the four things
 * DESIGN.md asks for and that a hand-rolled overlay gets wrong: it traps focus
 * inside the dialog, it closes on `Esc`, it puts the element in the top layer so
 * nothing on the page can paint over it, and **it restores focus to whatever was
 * focused when it opened** — the trigger row. Reimplementing any of that would
 * be a keydown listener, a focusable-node walk and a `z-index` argument, in
 * place of one method call.
 *
 * Two things it does not do, and which are done here:
 *
 * - **Body scroll lock.** The page behind a modal still scrolls under the
 *   pointer. `overflow: hidden` on `<body>` for as long as one is open.
 * - **Focus restoration when the trigger is a `<tr tabindex="0">`.** The
 *   restoration above depends on the row actually having been focused, and
 *   browsers disagree about whether clicking a `tabindex` element focuses it —
 *   Safari historically does not. The element is captured at open and focused
 *   again on close, so the behaviour does not depend on that disagreement.
 *
 * ## The window
 *
 * The modal opens on the **page's** window, so the PnL in its header is the
 * same figure as the row the reader just clicked; opening on a fixed default
 * would show one number in the row and a different one in the modal for the
 * same KOL. Its segments then move the modal's period alone, without navigating
 * the page underneath.
 *
 * **The segments are labelled `Diario · Semanal · Mensual`, where `modal-kol`
 * says `1D · 7D · 30D`.** Those labels would be false here: spec §4.9 makes
 * every window calendar-aligned UTC and never rolling, so `Semanal` is the
 * current ISO week — one day long on a Monday — and is not `7D`. DESIGN.md's
 * own `segmented` component names the same three windows in Spanish. Recorded
 * in the batch report as a conflict for the document to settle rather than
 * resolved by printing a label the aggregation does not honour.
 */
export function KolModalHost({
  window: pageWindow,
  children,
}: {
  /** The window the rows beneath were ranked in. */
  window: LeaderboardWindow;
  children: ReactNode;
}) {
  const [slug, setSlug] = useState<string | null>(null);
  const [period, setPeriod] = useState<LeaderboardWindow>(pageWindow);
  const [detail, setDetail] = useState<PublicKolDetail | null>(null);
  const [failed, setFailed] = useState(false);

  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLElement | null>(null);

  const open = useCallback(
    (next: string) => {
      trigger.current = document.activeElement as HTMLElement | null;
      // Every opening starts from the page's period, so the modal never
      // inherits a period the reader chose inside a *different* KOL's modal.
      setPeriod(pageWindow);
      setSlug(next);
      setDetail(null);
      setFailed(false);
    },
    [pageWindow],
  );

  /**
   * Clearing what is on screen belongs to the two events that invalidate it —
   * opening a KOL and choosing a period — not to the fetch effect. An effect
   * that reset state in its body would re-render synchronously on every run,
   * which is what `react-hooks/set-state-in-effect` is about; doing it in the
   * handler also means the stale figures are gone in the same paint as the
   * click rather than one frame later.
   */
  const changePeriod = useCallback((next: LeaderboardWindow) => {
    setPeriod(next);
    setDetail(null);
    setFailed(false);
  }, []);

  useEffect(() => {
    if (slug === null) return;

    const controller = new AbortController();
    (async () => {
      try {
        const response = await fetch(
          `/api/kol/${encodeURIComponent(slug)}?window=${encodeURIComponent(period)}`,
          { signal: controller.signal, cache: "no-store" },
        );
        if (!response.ok) throw new Error("kol detail unavailable");
        const body = (await response.json()) as PublicKolDetail;
        // The abort above covers a request still in flight; this covers one
        // already delivered, whose period is no longer the selected one. The
        // route answers with the window it actually summed, so the two can be
        // compared rather than assumed.
        if (body.window === period) setDetail(body);
      } catch {
        // A cancelled fetch is not a failure — it is this effect tidying up
        // after itself, and showing an error for it would flash one on every
        // segment change.
        if (!controller.signal.aborted) setFailed(true);
      }
    })();

    return () => controller.abort();
  }, [slug, period]);

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;

    if (slug === null) {
      if (element.open) element.close();
      return;
    }

    if (!element.open) element.showModal();
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [slug]);

  // Fires for all three dismissals: `Esc` (which the browser handles), the
  // close button and a backdrop click (both of which call `close()`), so there
  // is one place that clears the state and returns focus rather than three.
  const onClose = useCallback(() => {
    setSlug(null);
    setDetail(null);
    setFailed(false);
    // `isConnected` because the row may have been replaced by a re-render while
    // the modal was open; focusing a detached node silently sends focus to the
    // document body instead.
    if (trigger.current?.isConnected) trigger.current.focus();
  }, []);

  return (
    <KolModalContext.Provider value={open}>
      {children}

      <dialog
        ref={dialog}
        className="modal-kol"
        // `showModal()` already makes this modal to assistive technology; the
        // attribute is stated because the brief asks for it explicitly and it
        // costs nothing. The name is static rather than the KOL's, because the
        // KOL's name arrives with the fetch and a dialog whose accessible name
        // appears a moment after it opens has none at the moment it is read.
        aria-modal="true"
        aria-label="Detalle del KOL"
        onClose={onClose}
        onClick={(event) => {
          // A click on the `::backdrop` is dispatched with the dialog itself as
          // the target; anything inside the card targets a descendant. The card
          // fills the dialog's box, so there is no third case.
          if (event.target === dialog.current) dialog.current?.close();
        }}
      >
        <div className="modal-card">
          <button
            type="button"
            className="modal-close"
            aria-label="Cerrar"
            onClick={() => dialog.current?.close()}
          >
            {/* U+00D7, not a lowercase x: it is a symmetrical glyph at the
                weight of the text around it, and it is in the latin subset. */}
            ×
          </button>

          {detail && <KolDetail detail={detail} segments={<Segments value={period} onChange={changePeriod} />} />}

          {failed && (
            /* DESIGN.md gives `modal-kol` no failure state — its two-states
               table covers empty, not unreachable. Written in the same voice as
               the states it does specify: a statement of fact and what to do,
               no "Ups", no illustration, no retry that hides the failure behind
               a spinner. Recorded in the batch report as a gap in the document. */
            <div className="state-empty">
              <p className="state-empty-lead">No pudimos cargar el detalle.</p>
              <p className="state-empty-note">
                Cierra este panel y vuelve a abrirlo desde la fila del KOL.
              </p>
            </div>
          )}
        </div>
      </dialog>
    </KolModalContext.Provider>
  );
}

/**
 * DESIGN.md `segmented`, as buttons rather than links.
 *
 * The header's copy of this control is links because every combination there is
 * a real URL; the modal's period is not in the URL — the modal is not a route —
 * so a link would have nowhere to point. The classes are the same, so the two
 * controls are visibly one component.
 */
function Segments({
  value,
  onChange,
}: {
  value: LeaderboardWindow;
  onChange: (next: LeaderboardWindow) => void;
}) {
  return (
    <div className="segmented" role="group" aria-label="Período">
      {LEADERBOARD_WINDOWS.map((option) => (
        <button
          key={option}
          type="button"
          className={option === value ? "segment is-selected" : "segment"}
          aria-pressed={option === value}
          onClick={() => onChange(option)}
        >
          {WINDOW_LABELS[option]}
        </button>
      ))}
    </div>
  );
}
