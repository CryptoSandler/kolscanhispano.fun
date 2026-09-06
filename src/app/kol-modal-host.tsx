"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { ArsRate } from "@/lib/fx";
import type { LeaderboardFiat } from "@/lib/leaderboard";
import type { PublicKolDetail } from "@/lib/serialize";
import {
  LEADERBOARD_WINDOWS,
  WINDOW_LABELS,
  WINDOW_MEANINGS,
  type LeaderboardWindow,
} from "@/lib/windows";
import { KolDetail } from "./kol-detail";
import { GoneKolsContext, KolModalContext } from "./kol-modal";

/**
 * Which of DESIGN.md's two failure states a load ended in.
 *
 * The document draws the line and this type is that line, so no caller has to
 * re-decide it:
 *
 * | Case | Copy | Retry |
 * |---|---|---|
 * | transient — network, 5xx | `No se pudo cargar este KOL.` | yes |
 * | gone — 404 | `Este KOL ya no está en el padrón.` | no |
 */
export type LoadFailure = "transient" | "gone";

/**
 * Reads a failure out of the **response status**, which DESIGN.md requires:
 * *"The two cases are distinguished by the response, not guessed at — `404` is
 * gone, everything else is transient."*
 *
 * A guess is the thing being ruled out. A KOL withdrawn or suspended between
 * the list's render and the click is gone, and offering it a retry is *"a
 * control that is guaranteed to fail, which `Do's and Don'ts` already forbids"*
 * — while a 502 from a cold route is a request worth making again, and hiding
 * the retry there would strand a reader on a page that would have worked.
 *
 * `404` is the only status this product can answer with for a KOL that is not
 * on a public surface: `/api/kol/[slug]` reads through `readKolDetail`, whose
 * `WHERE k.slug = $1 AND k.status = 'approved'` makes "never existed" and
 * "suspended" one answer, and whose route returns the same `not found` body for
 * both (spec §9 — the difference is information about a person).
 *
 * ponytail: `410` is not handled, because nothing in this app can send one —
 * verified by grep over `src/app/api`, whose only statuses are 200, 304, 400,
 * 401, 404 and 429. RFC 9110 makes `410` a stronger *gone* than `404`, so if a
 * future route ever answers one this becomes
 * `status === 404 || status === 410`, one word. A branch written for a response
 * that cannot arrive is a branch nothing exercises.
 */
export function loadFailure(status: number): LoadFailure {
  return status === 404 ? "gone" : "transient";
}

/**
 * DESIGN.md's two-states table, for the two rows `46b9c47` separated:
 *
 * ```
 * | `modal-kol` on a **transient** failure (network, 5xx) | the cards | `No se pudo cargar este KOL.` with a retry |
 * | `modal-kol` when the KOL is **gone** (404) | the cards | `Este KOL ya no está en el padrón.` — **no retry**, ... |
 * ```
 *
 * Both sentences are verbatim, and `empty-states.test.ts` parses them out of
 * the document to prove it.
 *
 * **The retry is absent for `gone`, not disabled.** DESIGN.md's last Don't is
 * *"Don't show a control that does not work"*, and a greyed-out `Reintentar` is
 * still that control — it says the reader is missing a permission or a moment,
 * where the truth is that there is nothing left to load. On the transient side
 * the retry is a real control that reruns the same fetch in place, not a reload
 * and not a link that closes the panel, because the state it recovers from is
 * one failed request. The document does not word it; `Reintentar` is the one
 * word neutral Spanish has for it.
 *
 * Split out of {@link KolModalHost} so it can be rendered without a browser:
 * the state only exists after an effect has run, so `renderToStaticMarkup` can
 * never reach it through the host, and asserting copy against the *source* of a
 * component is the shape of check this repository has already been wrong about.
 */
export function LoadFailureState({
  failure,
  onRetry,
}: {
  failure: LoadFailure;
  onRetry: () => void;
}) {
  if (failure === "gone") {
    return (
      <div className="state-empty">
        <p className="state-empty-lead">Este KOL ya no está en el padrón.</p>
      </div>
    );
  }

  return (
    <div className="state-empty">
      <p className="state-empty-lead">No se pudo cargar este KOL.</p>
      <p className="state-empty-note">
        <button type="button" className="retry" onClick={onRetry}>
          Reintentar
        </button>
      </p>
    </div>
  );
}

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
 *
 * ## When the KOL is gone
 *
 * A leaderboard row is a snapshot of the moment the page rendered, and a KOL
 * can be withdrawn or suspended before the reader clicks it. DESIGN.md
 * (`46b9c47`) separates that from a failure worth retrying, and this component
 * is where both halves land:
 *
 * - the failure is classified from the **response** by {@link loadFailure} —
 *   `404` is gone, everything else transient — and rendered by
 *   {@link LoadFailureState}, so the gone state carries no retry control at
 *   all;
 * - on close, a gone slug joins the set handed down through
 *   {@link GoneKolsContext}, and `kol-row.tsx` renders nothing for it. *"The
 *   stale row is removed on close rather than left to invite a second click."*
 *
 * The set is per-mount and deliberately not persisted: it is a correction to
 * one rendered page, and the next request is ranked without that KOL anyway
 * because `readLeaderboard` filters on `status = 'approved'`.
 */
export function KolModalHost({
  window: pageWindow,
  fiat,
  rate,
  children,
}: {
  /** The window the rows beneath were ranked in. */
  window: LeaderboardWindow;
  /**
   * The currency the toggle is on, and the rate to convert at.
   *
   * The modal opens over the list and shows the **same total** the row does, so
   * a row reading `(AR$4.340.700)` above a modal reading `(US$3.100,50)` would
   * be two currencies for one figure. The rate is read once, on the server,
   * beside the ranking — the modal never fetches one.
   */
  fiat: LeaderboardFiat;
  rate: ArsRate | null;
  children: ReactNode;
}) {
  const [slug, setSlug] = useState<string | null>(null);
  const [period, setPeriod] = useState<LeaderboardWindow>(pageWindow);
  const [detail, setDetail] = useState<PublicKolDetail | null>(null);
  const [failure, setFailure] = useState<LoadFailure | null>(null);
  /**
   * The slugs this modal has been told are `404`, handed down to every row
   * through {@link GoneKolsContext}.
   *
   * A row is added on **close**, not on the failure: DESIGN.md says *"the row
   * leaves the list when the modal closes"*, and removing it underneath an open
   * dialog would pull the trigger row out of the document while focus is still
   * being restored to it.
   */
  const [gone, setGone] = useState<ReadonlySet<string>>(() => new Set());
  /**
   * Bumped by the retry control, and a dependency of the fetch effect — which
   * is the whole mechanism. DESIGN.md's transient failure state is *"`No se
   * pudo cargar este KOL.` **with a retry**"*, and a retry that re-ran the
   * effect by clearing and re-setting `slug` would close and reopen the dialog.
   */
  const [attempt, setAttempt] = useState(0);

  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLElement | null>(null);

  /*
    The e2e harness's canary on this surface, written to the DOM after mount
    exactly as `feed-live.tsx` writes its own, on the ref this component already
    holds and for the same reason that one exists: the whole e2e suite once ran
    against a page whose bundle answered `403`, and a spec that clicks something
    is worthless without proof that React ran. `/leaderboard` carries no
    `FeedLive`, so until this line it had no canary at all. Nothing in this
    component reads the attribute; it is for an outside observer, which is why
    it is a DOM write and not state.
  */
  useEffect(() => {
    dialog.current?.setAttribute("data-hydrated", "");
  }, []);

  /*
    **The calendar's month, which is not the window.** Since 2026-09-03 the card
    shows a calendar month the reader pages through while the window governs
    every figure under it.

    `null` means "whatever month the server considers current", which is what an
    unparameterised request already answers — so the first fetch carries no
    `month` at all and the response says which one it read. Paging sets a
    concrete month from there.

    Unlike a period change this does **not** clear the detail: only one card on
    the screen is about to change, and blanking the header, the stats and the
    trade list to repaint a grid would be a flash of nothing in return for
    nothing. The stale-response guard below still applies.
  */
  const [month, setMonth] = useState<string | null>(null);
  const changeMonth = useCallback((next: string) => {
    setMonth(next);
  }, []);

  const open = useCallback(
    (next: string) => {
      trigger.current = document.activeElement as HTMLElement | null;
      // Every opening starts from the page's period, so the modal never
      // inherits a period the reader chose inside a *different* KOL's modal.
      setPeriod(pageWindow);
      // And the calendar starts on the current month, for the same reason: a
      // month paged to inside a *different* KOL's modal is not a choice about
      // this one.
      setMonth(null);
      setSlug(next);
      setDetail(null);
      setFailure(null);
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
    setFailure(null);
  }, []);


  useEffect(() => {
    if (slug === null) return;

    const controller = new AbortController();
    (async () => {
      try {
        const query = month === null ? "" : `&month=${encodeURIComponent(month)}`;
        const response = await fetch(
          `/api/kol/${encodeURIComponent(slug)}?window=${encodeURIComponent(period)}${query}`,
          { signal: controller.signal, cache: "no-store" },
        );
        // The **response** decides which failure this is, never a guess. See
        // {@link loadFailure}.
        if (!response.ok) {
          if (!controller.signal.aborted) setFailure(loadFailure(response.status));
          return;
        }
        const body = (await response.json()) as PublicKolDetail;
        // The abort above covers a request still in flight; this covers one
        // already delivered, whose period is no longer the selected one. The
        // route answers with the window it actually summed, so the two can be
        // compared rather than assumed.
        if (body.window === period) setDetail(body);
      } catch {
        // Everything that never produced a status line: a network error, a
        // timeout, a body that would not parse. All transient — there is no
        // response to read "gone" out of, and inventing one would be the guess
        // DESIGN.md rules out.
        //
        // A cancelled fetch is not a failure at all — it is this effect tidying
        // up after itself, and showing an error for it would flash one on every
        // segment change.
        if (!controller.signal.aborted) setFailure("transient");
      }
    })();

    return () => controller.abort();
  }, [slug, period, month, attempt]);

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
    // DESIGN.md: the gone row "leaves the list when the modal closes". This is
    // that close, and it is the only place the set grows.
    if (failure === "gone" && slug !== null) {
      setGone((previous) => new Set(previous).add(slug));
    }
    setSlug(null);
    setDetail(null);
    setFailure(null);
    // `isConnected` because the row may have been replaced by a re-render while
    // the modal was open -- and, for a gone KOL, because the line above is
    // about to remove it. Focusing a detached node silently sends focus to the
    // document body instead. A reader whose row has just left the list gets the
    // document's own focus order back, which is the honest answer: the thing
    // they were on is not there any more.
    if (trigger.current?.isConnected) trigger.current.focus();
  }, [failure, slug]);

  return (
    <KolModalContext.Provider value={open}>
      {/* Two providers, one for each thing a row needs from this component: how
          to open a modal, and which rows are no longer there. */}
      <GoneKolsContext.Provider value={gone}>{children}</GoneKolsContext.Provider>

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

          {detail && (
            <KolDetail
              detail={detail}
              fiat={fiat}
              rate={rate}
              segments={<Segments value={period} onChange={changePeriod} />}
              calendarNav={<MonthNav month={detail.calendar.month} onChange={changeMonth} />}
            />
          )}

          {failure !== null && (
            <LoadFailureState
              failure={failure}
              onRetry={() => {
                setFailure(null);
                setAttempt((n) => n + 1);
              }}
            />
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
    /*
      **`1D · 7D · 30D`**, which is the mould's modal control and, since the
      owner's amendment of 2026-09-03, the only windows this product has — so
      this list is `LEADERBOARD_WINDOWS` rather than a second one. It briefly was
      a second one, when the plan was calendar windows on the ranking and rolling
      ones here; `docs/round-ventanas-moviles.md` §5 carries what changed.

      `title` and `aria-description` carry what each one measures. The round's
      condition for adding rolling windows at all was that the two sets stay
      distinct *and* say which is which — the labels do the first, this does the
      second, and neither is asked to do both.
    */
    <div className="segmented is-modal" role="group" aria-label="Período">
      {LEADERBOARD_WINDOWS.map((option) => (
        <button
          key={option}
          type="button"
          className={option === value ? "segment is-selected" : "segment"}
          aria-pressed={option === value}
          title={WINDOW_MEANINGS[option]}
          onClick={() => onChange(option)}
        >
          {WINDOW_LABELS[option]}
        </button>
      ))}
    </div>
  );
}


/**
 * `‹ septiembre 2026 ›`, the calendar's month control.
 *
 * Buttons rather than links, unlike the ranking's `segmented`: the window is a
 * URL because the *page* is ranked by it and a reader shares that; the month a
 * modal's calendar happens to be paged to is not a state anyone links to, and
 * putting it in the address bar would put a third parameter on every ranking
 * URL for a card two levels down.
 *
 * The month arrives from the response rather than from local state, so the
 * arrows always step from the month actually rendered. `type="button"` because
 * a bare `<button>` inside a `<form>`-less dialog still defaults to `submit` in
 * some engines, and this project has been bitten by a control that navigated.
 */
function MonthNav({ month, onChange }: { month: string; onChange: (next: string) => void }) {
  const step = (delta: number): string => {
    const [year, index] = month.split("-").map(Number);
    const moved = new Date(Date.UTC(year, index - 1 + delta, 1));
    return moved.toISOString().slice(0, 7);
  };

  return (
    <div className="calendar-nav">
      <button
        type="button"
        className="calendar-arrow"
        onClick={() => onChange(step(-1))}
        aria-label="Mes anterior"
      >
        ‹
      </button>
      <span className="calendar-month">{formatUtcMonth(month)}</span>
      <button
        type="button"
        className="calendar-arrow"
        onClick={() => onChange(step(1))}
        aria-label="Mes siguiente"
      >
        ›
      </button>
    </div>
  );
}

/**
 * `2026-09` as `septiembre 2026`.
 *
 * Built from a fixed table rather than `toLocaleDateString`: the month name has
 * to be the same on the server that prerenders and the browser that hydrates,
 * and `Intl`'s data is the runtime's, not ours. It is also the only way to be
 * sure the string is `es-ES` on a machine with any locale installed.
 */
const MONTHS = [
  "enero",
  "febrero",
  "marzo",
  "abril",
  "mayo",
  "junio",
  "julio",
  "agosto",
  "septiembre",
  "octubre",
  "noviembre",
  "diciembre",
] as const;

function formatUtcMonth(month: string): string {
  const [year, index] = month.split("-").map(Number);
  const name = MONTHS[index - 1];
  return name === undefined ? month : `${name} ${year}`;
}
