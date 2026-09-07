import { expect, test, type Locator } from "@playwright/test";
import { E2E_ADMIN_TOKEN } from "../playwright.config";

/**
 * DESIGN.md's layout rules, as a regression guard.
 *
 * **This file used to assert a thesis that no longer exists.** The previous
 * direction ("Instrumento") claimed *"the leaderboard's top ten and the live
 * feed's last eight should share one 900px viewport without scrolling"* and
 * this spec measured every row at 36px to prove it. Commit `1f83420` replaced
 * that direction on the owner's decision: rows are now 56px — *"enough for a
 * 36px circular avatar, the bold name, and the handle or `Wallets ocultas`
 * beneath it"* (Layout; the `row-leaderboard` paragraph, corrected in
 * `b0f2a43`, now carries both) — and the document makes no claim at all about
 * vertical fit. A
 * guard for a retired claim is worse than no guard: it fails for the right
 * reason exactly once and is then edited to whatever the page happens to do.
 *
 * What DESIGN.md still states, and what this file therefore still measures:
 *
 * - *"1280px maximum, 16px gutters."* — so nothing may push the page sideways.
 * - *"**Rows are 76px**"* — 56 until 2026-09-02 and 68 until 2026-09-03, when
 *   the mould's own DOM was measured; the identity merged onto
 *   one line and the row took the mould's density — and the rule that a column
 *   of figures has a fixed width.
 * - the two sentences that qualify the figures, on the page rather than behind
 *   a hover.
 *
 * The viewport is 1280×900: 1280 is the layout maximum DESIGN.md names, and 900
 * is a laptop, which is what the rows have to survive being read on.
 *
 * ## And 390×844, which nothing measured until now
 *
 * Three defects shipped because this file only ever ran one size. **DESIGN.md
 * says nothing about narrow viewports** — it has no "responsive" section, no
 * breakpoint, no media query, and the string "sideways" in the line above is
 * this file's own gloss on *"1280px maximum, 16px gutters"*, not a sentence of
 * that document. So {@link SIZES} is a judgement recorded here rather than a
 * rule quoted: 390×844 is the iPhone 14/15/16 logical viewport, the narrowest
 * mainstream size this audience reads on, and a page whose document is wider
 * than its viewport has no right gutter at all — which is the one part of
 * Layout that *is* written down.
 */
const SIZES = [
  { name: "1280×900", viewport: { width: 1280, height: 900 } },
  { name: "390×844", viewport: { width: 390, height: 844 } },
] as const;

test.use({ viewport: SIZES[0].viewport });

test.describe("the home page at 1280×900", () => {
  /**
   * The canary, and the reason it exists.
   *
   * Every case in this file passed for its whole life against a page whose
   * JavaScript never loaded. `baseURL` was `127.0.0.1` while `next dev`
   * initialises on `localhost`, so Next 16 treated every `/_next/static/chunks/*`
   * request as cross-origin and answered `403` — nothing hydrated, in any spec,
   * ever. It was invisible precisely because the cases here measure
   * server-rendered layout, which is byte-identical with the bundle blocked.
   *
   * Discovered only when the modal suite was written and twelve cases failed on
   * a dialog that never opened. So the bundle now has to prove it arrived, in
   * one assertion, before any behavioural case is trusted: a green suite that
   * never ran the client is a worse result than a red one.
   */
  test("actually loads the client bundle", async ({ page }) => {
    const blocked: string[] = [];
    page.on("response", (r) => {
      if (r.url().includes("/_next/static/") && !r.ok()) blocked.push(`${r.status()} ${r.url()}`);
    });

    await page.goto("/");
    // One mark: `KolModalHost`. It was two until 2026-09-03, when the ranking
    // took the home page and `FeedLive` moved to `/en-vivo` — which is asserted
    // below, so neither component can quietly stop mounting. Counted rather
    // than merely found, so a page that stopped mounting it is a failure here
    // instead of a mystery in `modal-kol.spec.ts`.
    await expect(page.locator("[data-hydrated]")).toHaveCount(1);
    expect(blocked, "static chunks the browser could not fetch").toEqual([]);
  });

  test("never scrolls horizontally, whatever the figures say", async ({ page }) => {
    await page.goto("/");

    // The rows have to be there for the assertion to mean anything: a page
    // that rendered nothing would pass every size check on this list. Twelve,
    // not ten: the home page is the full ranking since 2026-09-03, not a top
    // ten with a feed above it.
    await expect(page.locator(".row-leaderboard")).toHaveCount(12);

    const box = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
    }));

    // A table of fixed-width columns is the easiest thing on this page to push
    // past the viewport.
    expect(box.scrollWidth).toBeLessThanOrEqual(box.innerWidth);
  });

  /**
   * **The home page is the ranking and nothing else**, since 2026-09-03.
   *
   * This case used to assert the opposite — a feed above a top ten, in one
   * panel of two sections. `docs/clone-map.md` §2 recorded from the first day
   * that the mould's home *is* the leaderboard; the owner settled it, the feed
   * took `/en-vivo`, and the assertion moved with the page rather than being
   * deleted. What it still guards is the row height, which is a DESIGN.md
   * token.
   */
  test("is the ranking, with every row at DESIGN.md's 76px", async ({ page }) => {
    await page.goto("/");

    await expect(page.locator(".row-feed")).toHaveCount(0);
    // The title is `page-title` since the clone batch of 2026-09-03, not
    // `display-lg`, and it names the screen the way DESIGN.md does.
    // `KOL Leaderboard` desde el 2026-09-05, el título del molde.
    await expect(page.locator("h1.page-title")).toHaveText("KOL Leaderboard");

    const heights = await page
      .locator(".row-leaderboard")
      .evaluateAll((rows) => rows.map((row) => Math.round(row.getBoundingClientRect().height)));
    // **76 since 2026-09-03**, measured on the mould's own DOM at 1440 rather
    // than taken from a picture — `docs/parecido-2026-09-02.md` §8. It was 68,
    // and 56 before that.
    expect(new Set(heights)).toEqual(new Set([76]));
  });

  /** And the feed is where it moved to, still alive and still hydrating. */
  /*
    **`/en-vivo` ya no es el feed: es un 308 a la home.**

    El feed público se eliminó el 2026-09-06 (`DECISIONES.md`). Este caso medía
    que la ruta sirviera el feed y ahora mide lo contrario, que es lo que hay
    que sostener: la URL sigue contestando —estuvo enlazada y pudo quedar en un
    marcador— y lo que entrega es la clasificación.
  */
  test("redirects /en-vivo to the ranking", async ({ page }) => {
    await page.goto("/en-vivo");

    expect(new URL(page.url()).pathname).toBe("/");
    await expect(page.locator(".row-leaderboard").first()).toBeVisible();
    await expect(page.locator(".row-feed")).toHaveCount(0);
  });

  /**
   * The published URL still answers, and lands on the ranking — **through two
   * redirects, which is the case worth having.**
   *
   * `/leaderboard` moved to `/` on 2026-09-03 and the calendar windows became
   * rolling the same day, so a link saved before either change carries both a
   * dead path and a dead window value. It has to survive the pair: the route
   * redirect preserves the query string, and the window redirect then rewrites
   * `semanal` to `7d`. Neither is allowed to swallow the other's work — the
   * currency has to reach the far side too.
   */
  test("redirects /leaderboard to the ranking, through the window rename as well", async ({
    page,
  }) => {
    await page.goto("/leaderboard?window=semanal&unit=ars");

    expect(new URL(page.url()).pathname).toBe("/");
    expect(new URL(page.url()).search).toBe("?window=7d&unit=ars");
    await expect(page.locator(".row-leaderboard").first()).toBeVisible();
  });

  /**
   * The statement that qualifies the figures, on the page rather than behind a
   * hover: spec §4.1's USD caveat.
   *
   * **It used to check two.** Spec §4.8's win-rate definition was the second,
   * and it left the page on 2026-09-02 with the column it defined — the mould
   * has no record column, so a caption defining one had nothing to define. The
   * case shrank rather than being deleted: the remaining caveat is about the
   * figure the card still prints, and it is the one that is easy to lose.
   */
  /*
    La nota pasó a ser el `title` del toggle de período el 2026-09-06: explica
    lo que ese control decide, y suelta al pie estaba a media pantalla de la
    cosa que explica. Se sigue afirmando que el sitio califica sus cifras en
    palabras; lo que cambió es dónde.
  */
  test("qualifies its figures in words, on the control they belong to", async ({ page }) => {
    await page.goto("/");

    const windows = page.locator(".segmented.is-windows");
    await expect(windows).toHaveAttribute("title", /USD derivado del precio de SOL/);
  });

  /**
   * DESIGN.md, Identity and the last Don't: the header carries the wordmark,
   * the subtitle and the wallet slot — the two `segmented` controls moved to
   * the page on 2026-09-02 — and the
   * wallet slot is a label, not a control. *"Don't show a control that does not
   * work"*: `/registro` does not exist yet, so nothing here may be clickable.
   */
  test("the wallet slot is a real link now that the page behind it exists", async ({ page }) => {
    await page.goto("/");

    await expect(page.getByText("Clasificación de traders hispanos")).toBeVisible();
    const registro = page.locator(".registro");
    // It held a muted, unfocusable label while `/registro` did not exist --
    // DESIGN.md's "don't show a control that does not work". The page exists,
    // so the same rule now requires the opposite, and this case moved with it.
    await expect(registro).toHaveAttribute("href", "/registro");
    expect(await registro.evaluate((node) => node.tagName)).toBe("A");

    /*
      Y abre algo que responde: el modal, **directo en la lista de wallets**.
      Este caso esperaba un botón `Connect Wallet` adentro del modal — el paso
      previo que salió el 2026-09-06 porque no decidía nada.
    */
    await registro.click();
    await expect(page.locator("dialog.modal-connect")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("heading", { name: "Conecta tu wallet" })).toBeVisible();
  });
});

/**
 * The same page at both sizes, and the three defects that shipped because
 * nothing here ever ran at the second one.
 *
 * `/leaderboard` rather than `/`: it carries the full table and the modal host,
 * which is where all three defects lived. The home page keeps its own cases
 * above.
 *
 * The first two assertions of each case are about the *document*, and the last
 * two are about the modal — so every case here opens it, and the canary below
 * is what makes that meaningful at all.
 */
for (const { name, viewport } of SIZES) {
  test.describe(`the ranking at ${name}`, () => {
    test.use({ viewport });

    /**
     * The canary, at this size too.
     *
     * `viewport.spec.ts`'s original canary runs on `/` and counts the two marks
     * that page mounts. This one is on `/leaderboard`, which mounts one —
     * `KolModalHost` — and it exists for the same reason: **every case below
     * this line clicks something.** A mobile case against an unhydrated page
     * would be the 403-on-every-chunk trap in a new size, and it would be just
     * as invisible, because a dialog that never opens fails as "element not
     * found" rather than as "the bundle did not load".
     */
    test("actually loads the client bundle", async ({ page }) => {
      const blocked: string[] = [];
      page.on("response", (r) => {
        if (r.url().includes("/_next/static/") && !r.ok()) blocked.push(`${r.status()} ${r.url()}`);
      });

      await page.goto("/leaderboard");
      await expect(page.locator("dialog.modal-kol[data-hydrated]")).toHaveCount(1);
      expect(blocked, "static chunks the browser could not fetch").toEqual([]);
    });

    /**
     * Nothing may push the *page* sideways, at either size.
     *
     * Wide content is allowed to scroll **inside its own container**, and the
     * document does not move. The ranking used to be the wide thing here; it is
     * a list of cards that wraps since 2026-09-02, and the case below is what
     * holds it to that.
     *
     * Measured as `documentElement.scrollWidth` rather than by looking for a
     * scrollbar: at 390 the ranking's own columns made the document 581px wide
     * on both `/` and `/leaderboard`, and a screenshot taken at scroll offset 0
     * showed nothing at all. That is how this shipped.
     */
    for (const [path, present] of [
      ["/", ".row-leaderboard"],
      ["/leaderboard", ".row-leaderboard"],
      ["/leaderboard?unit=ars", ".row-leaderboard"],
      // Built 2026-09-02. `/cabals` carries the widest thing on the site after
      // the ranking: tres tarjetas de podio una al lado de la otra.
      //
      // `/trade` salió de esta lista el 2026-09-06 con la página: es un 308 a
      // la home, así que medirla acá sería medir la home con otro nombre.
      ["/cabals", ".podium-card"],
      ["/privacidad", ".privacy-list"],
    ] as const) {
      test(`never scrolls the document sideways on ${path}`, async ({ page }) => {
        await page.goto(path);
        // The content has to be there for the measurement to mean anything: an
        // empty page fits every viewport on this list.
        await expect(page.locator(present).first()).toBeVisible();

        const box = await page.evaluate(() => ({
          scrollWidth: document.documentElement.scrollWidth,
          innerWidth: window.innerWidth,
        }));

        expect(box.scrollWidth).toBeLessThanOrEqual(box.innerWidth);
      });
    }

    /**
     * The money is on screen, at both sizes.
     *
     * **This is the defect the parity audit found and the reason the ranking
     * stopped being a table** (`docs/clone-map.md` §4). At 390 the six fixed
     * columns came to 768px inside a 358px card, so the PnL — the figure the
     * page is sorted by — sat past the right edge behind a container scroll,
     * while `documentElement.scrollWidth` stayed at 390 and the case above
     * passed. A guard for the document is not a guard for the data.
     *
     * So this measures the **cell**, the way the trade timestamp's case does:
     * the ranked figure's box has to be inside the viewport with nothing
     * scrolled, and its text has to fit its own box. Both halves are needed —
     * a cell scrolled out of sight still reports the right `textContent`, and
     * a cell clipped to `+18,4` still sits inside the viewport.
     */
    test("keeps the ranked figure on screen, unscrolled", async ({ page }) => {
      await page.goto("/leaderboard");
      /*
        `.pnl-fiat`, no `.pnl`: la fila dejó de imprimir un total nativo el
        2026-09-05 —el molde no tiene uno, y al lado de las columnas por chain
        duplicaba el monto de SOL— así que la cifra por la que se ordena y que
        tiene que quedar a la vista es la del paréntesis en fiat.
      */
      const pnl = page.locator(".row-leaderboard .pnl-fiat").first();
      await expect(pnl).toBeVisible();

      // Nothing may have been scrolled to make this true.
      const scrolled = await page.locator(".board").evaluate((board) => ({
        left: board.scrollLeft,
        over: board.scrollWidth - board.clientWidth,
      }));
      expect(scrolled.left, "the ranking was scrolled before the measurement").toBe(0);
      expect(scrolled.over, "the ranking list is wider than the space it has").toBeLessThanOrEqual(
        0,
      );

      await expect(pnl).toBeInViewport();
      const box = await pnl.evaluate((cell) => ({
        left: cell.getBoundingClientRect().left,
        right: cell.getBoundingClientRect().right,
        scrollWidth: cell.scrollWidth,
        clientWidth: cell.clientWidth,
        innerWidth: window.innerWidth,
        text: cell.textContent,
      }));
      expect(box.left, "the PnL starts off the left of the screen").toBeGreaterThanOrEqual(0);
      expect(box.right, "the PnL runs off the right of the screen").toBeLessThanOrEqual(
        box.innerWidth,
      );
      expect(box.scrollWidth, "the PnL is clipped by its own cell").toBeLessThanOrEqual(
        box.clientWidth,
      );
      // And it is a figure, not an empty box that would satisfy every rect
      // assertion above.
      // La cifra por la que se ordena es el total en fiat entre paréntesis: la
      // fila dejó de imprimir un total nativo con signo.
      expect(box.text).toMatch(/^\((US\$|AR\$)/);
    });

    /**
     * `/admin`, which the loop above did not cover, and which broke the rule.
     *
     * It is not in that list because its table only exists after a token is
     * typed — so the measurement needs the roster on screen, and a `goto` alone
     * would photograph the empty state and pass. It gets its own case rather
     * than a conditional inside the loop.
     *
     * **This shipped.** `.admin-table` carries `.leaderboard`'s `min-width:
     * 768px` and was not wrapped in `.table-scroll`, so at 390 the *document*
     * measured 784px. Nothing failed: this guard covered two paths, and
     * `capturas.spec.ts` photographed it happily — the PNG came out 784px wide
     * while every other mobile capture came out 390, which is what reading the
     * captures (GATES.md, `/cierre` §3) is for and what an assertion nobody
     * wrote is not.
     */
    test("never scrolls the document sideways on /admin", async ({ page }) => {
      await page.goto("/admin");
      await page.locator('input[type="password"]').fill(E2E_ADMIN_TOKEN);
      await page.getByRole("button", { name: "Ver el padrón" }).click();
      // The table is the wide thing; measuring before it renders measures nothing.
      await expect(page.locator(".admin-table .row-leaderboard").first()).toBeVisible({
        timeout: 30_000,
      });

      const box = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
      }));

      expect(box.scrollWidth).toBeLessThanOrEqual(box.innerWidth);
    });

    /**
     * DESIGN.md's `modal-kol` is *"opened from a row"* and is the surface a
     * reader lands on from the ranking; a dialog whose card hangs off the side
     * of the screen is unreadable there in a way it never is at 1280.
     */
    test("keeps the open modal inside the viewport on both axes", async ({ page }) => {
      const dialog = await openFirstKol(page);
      const fit = await modalFit(dialog);

      expect(fit.left).toBeGreaterThanOrEqual(0);
      expect(fit.top).toBeGreaterThanOrEqual(0);
      expect(fit.right).toBeLessThanOrEqual(fit.innerWidth);
      expect(fit.bottom).toBeLessThanOrEqual(fit.innerHeight);
    });

    /**
     * The case above, forced red.
     *
     * A guard that has never been shown to fail is decoration, and this one had
     * a specific way of being decoration: it measured the `<dialog>` alone. A
     * `<dialog>` is laid out by the browser and does not necessarily grow past
     * the viewport when its *contents* do -- so a card hanging off the side of
     * the screen, which is the defect a reader actually meets, could leave the
     * dialog's own rect entirely within bounds and the assertion green.
     *
     * So {@link modalFit} measures the union of the dialog and its card, and
     * this test proves the measurement reports the overflow: it makes the card
     * far wider and taller than the viewport, measures with **the same
     * function** the guard uses, and requires the numbers to come back out of
     * bounds. Measuring with a second, hand-written expression here would prove
     * only that this test can measure something.
     *
     * The style is injected and never committed to the stylesheet; the page is
     * discarded with the test.
     */
    test("that guard reports an overflow when one is forced", async ({ page }) => {
      const dialog = await openFirstKol(page);
      expect(await modalFit(dialog)).toMatchObject({
        left: expect.any(Number),
      });

      await page.addStyleTag({
        content: `.modal-kol .modal-card {
          width: 4000px !important;
          max-width: none !important;
          height: 4000px !important;
          max-height: none !important;
        }`,
      });
      // The layout has to have settled before the rects are read, or this can
      // measure the card at its old size and pass for the wrong reason.
      await expect
        .poll(async () => (await modalFit(dialog)).right)
        .toBeGreaterThan((await modalFit(dialog)).innerWidth);

      const forced = await modalFit(dialog);
      expect(forced.right).toBeGreaterThan(forced.innerWidth);
      expect(forced.bottom).toBeGreaterThan(forced.innerHeight);
    });

    /**
     * The trade row's timestamp, as text and as a box.
     *
     * **Both halves are needed and neither is sufficient.** `textContent` is
     * the full `31/08 02:12 UTC` even when CSS has clipped the final glyph off
     * the screen, so the text assertion alone would have been green over the
     * defect it is here for — this repository's characteristic failure. And a
     * box assertion alone would pass over a cell that rendered the wrong
     * moment, or none.
     *
     * So the text is checked against **what the data says** — the ISO instant
     * in the `<time datetime>` attribute, reformatted here rather than imported
     * from `format.ts`, because asserting a formatter against itself proves
     * only that it is deterministic — and the box is then checked for having
     * actually shown it.
     */
    /*
      El caso de la hora de la operación se borró el 2026-09-06 con
      `list-defi-trades` (`DECISIONES.md`). Medía que `DD/MM HH:MM UTC` se
      imprimiera entero y sin recortar — y esa hora, junto con el monto, es
      justamente lo que permitía encontrar la transacción en un explorador.
      `modal-kol.spec.ts` afirma ahora que no hay ninguna fila de operación.
    */
  });
}

/**
 * The box every visible part of the open modal must sit inside.
 *
 * The **union of the dialog and its card**, not the dialog alone. A `<dialog>`
 * is positioned by the browser and can stay inside the viewport while the card
 * it contains hangs off the side -- which is precisely the state a reader
 * meets and the one a dialog-only measurement cannot see. Shared by the guard
 * and by the test that forces the guard red, so the two cannot disagree about
 * what "inside the viewport" means.
 */
async function modalFit(dialog: Locator) {
  return dialog.evaluate((el) => {
    const card = el.querySelector(".modal-card") ?? el;
    const boxes = [el.getBoundingClientRect(), card.getBoundingClientRect()];
    return {
      left: Math.min(...boxes.map((b) => b.left)),
      top: Math.min(...boxes.map((b) => b.top)),
      right: Math.max(...boxes.map((b) => b.right)),
      bottom: Math.max(...boxes.map((b) => b.bottom)),
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
    };
  });
}

/**
 * Opens the modal on the top-ranked KOL and hands back the dialog.
 *
 * Rank 1 is `cripto_ana`, whose wallets are public (`e2e/seed.ts` sets
 * `hide_wallets = index % 3 !== 0`), so its trade row ends in a linked
 * timestamp rather than the `PRIVADO` label — which is the cell these cases
 * measure. The rank cell is the click target because the row's handler lets
 * clicks on an `<a>` through to X, and the identity cell is full of one.
 *
 * The dev server compiles `/api/kol/[slug]` on first request, which outruns the
 * default expect timeout on a cold Turbopack.
 */
async function openFirstKol(page: import("@playwright/test").Page) {
  await page.goto("/leaderboard");
  const dialog = page.locator("dialog.modal-kol");
  await page.locator(".row-leaderboard").first().locator(".rank-cell").click();
  await expect(dialog).toHaveAttribute("open", "", { timeout: 30_000 });
  await expect(dialog.locator(".modal-head")).toBeVisible({ timeout: 30_000 });
  return dialog;
}
