import { expect, test, type Locator } from "@playwright/test";

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
 * - *"**Rows are 56px**"* and *"fixed column widths so a live update never
 *   reflows a table"*.
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
    // Two marks, one per client component the home page mounts: `FeedLive` and
    // `KolModalHost`. Counted rather than merely found, so a page that stopped
    // mounting one of them is a failure here instead of a mystery in
    // `modal-kol.spec.ts` — the modal host's mark is what that suite checks on
    // `/leaderboard`, which has no feed on it.
    await expect(page.locator("[data-hydrated]")).toHaveCount(2);
    expect(blocked, "static chunks the browser could not fetch").toEqual([]);
  });

  test("never scrolls horizontally, whatever the figures say", async ({ page }) => {
    await page.goto("/");

    // The rows have to be there for the assertion to mean anything: a page
    // that rendered nothing would pass every size check on this list.
    await expect(page.locator(".row-leaderboard")).toHaveCount(10);
    await expect(page.locator(".row-feed").first()).toBeVisible();

    const box = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
    }));

    // A table of fixed-width columns is the easiest thing on this page to push
    // past the viewport.
    expect(box.scrollWidth).toBeLessThanOrEqual(box.innerWidth);
  });

  test("puts the feed above the ranking, and every row at DESIGN.md's 56px", async ({ page }) => {
    await page.goto("/");

    // One panel, two hairline-divided sections: the feed, then the ranking.
    const sections = page.locator("main .panel-section");
    await expect(sections).toHaveCount(2);

    const feed = await sections.nth(0).boundingBox();
    const board = await sections.nth(1).boundingBox();
    expect(feed).not.toBeNull();
    expect(board).not.toBeNull();
    expect(feed!.y + feed!.height).toBeLessThanOrEqual(board!.y);

    const heights = await page.locator(".row-leaderboard").evaluateAll((rows) =>
      rows.map((row) => Math.round(row.getBoundingClientRect().height)),
    );
    expect(new Set(heights)).toEqual(new Set([56]));
  });

  /**
   * The two statements that qualify the figures, on the page rather than
   * behind a hover: spec §4.1's USD caveat and spec §4.8's win-rate
   * definition. The seed puts a KOL who closed nothing in the top ten, so the
   * `sin cierres` cell is on screen too — a percentage over an empty
   * denominator would have rendered `0 %` there and said something false.
   */
  test("qualifies its figures in words", async ({ page }) => {
    await page.goto("/");

    await expect(page.getByText(/USD derivado del precio de SOL/)).toBeVisible();
    await expect(
      page.getByText(/posiciones cerradas ganadoras \/ posiciones cerradas/),
    ).toBeVisible();
    await expect(page.locator(".state-none")).toHaveText("sin cierres");
  });

  /**
   * DESIGN.md, Identity and the last Don't: the header carries the wordmark,
   * the subtitle, both `segmented` controls and the wallet slot — and the
   * wallet slot is a label, not a control. *"Don't show a control that does not
   * work"*: `/registro` does not exist yet, so nothing here may be clickable.
   */
  test("the wallet slot is a real link now that the page behind it exists", async ({ page }) => {
    await page.goto("/");

    await expect(page.getByText("Ranking de traders hispanos")).toBeVisible();
    const registro = page.locator(".registro");
    // It held a muted, unfocusable label while `/registro` did not exist --
    // DESIGN.md's "don't show a control that does not work". The page exists,
    // so the same rule now requires the opposite, and this case moved with it.
    await expect(registro).toHaveAttribute("href", "/registro");
    expect(await registro.evaluate((node) => node.tagName)).toBe("A");

    // And it goes somewhere that answers.
    await registro.click();
    await expect(page.getByRole("button", { name: "Conectar wallet" })).toBeVisible({
      timeout: 30_000,
    });
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
     * Wide content is allowed to scroll — the ranking table is 768px of fixed
     * columns and cannot honour DESIGN.md's *"fixed column widths so a live
     * update never reflows a table"* and fit 390px at the same time — but it
     * scrolls **inside its own container**, and the document does not move.
     *
     * Measured as `documentElement.scrollWidth` rather than by looking for a
     * scrollbar: at 390 the ranking's own columns made the document 581px wide
     * on both `/` and `/leaderboard`, and a screenshot taken at scroll offset 0
     * showed nothing at all. That is how this shipped.
     */
    for (const path of ["/", "/leaderboard"]) {
      test(`never scrolls the document sideways on ${path}`, async ({ page }) => {
        await page.goto(path);
        // The rows have to be there for the measurement to mean anything.
        await expect(page.locator(".row-leaderboard").first()).toBeVisible();

        const box = await page.evaluate(() => ({
          scrollWidth: document.documentElement.scrollWidth,
          innerWidth: window.innerWidth,
        }));

        expect(box.scrollWidth).toBeLessThanOrEqual(box.innerWidth);
      });
    }

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
      expect(await modalFit(dialog)).toMatchObject({ left: expect.any(Number) });

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
    test("renders the trade timestamp in full, and does not clip it", async ({ page }) => {
      const dialog = await openFirstKol(page);
      const moment = dialog.locator(".row-moment").first();
      await expect(moment).toBeVisible();

      const iso = await moment.locator("time[datetime]").getAttribute("datetime");
      expect(iso, "the trade row must carry the instant it is printing").not.toBeNull();

      // `formatUtcMoment`'s contract, restated from the data: `DD/MM HH:MM UTC`.
      const [date, time] = iso!.split("T");
      const [, month, day] = date.split("-");
      expect(await moment.textContent()).toBe(`${day}/${month} ${time.slice(0, 5)} UTC`);

      // And the column actually holds it. `scrollWidth > clientWidth` is the
      // overflow the screenshots caught as `31/08 02:12 UT(`.
      const cell = await moment.evaluate((el) => ({
        scrollWidth: el.scrollWidth,
        clientWidth: el.clientWidth,
      }));
      expect(
        cell.scrollWidth,
        "the timestamp column is narrower than the timestamp it prints",
      ).toBeLessThanOrEqual(cell.clientWidth);

      /*
        And the cell is *reachable*, which the two assertions above do not
        cover and a first pass at this guard missed.

        They are both about the cell in isolation: the text is right and the
        column is wide enough for it. Neither says anything about where that
        column ended up. At 390 the row's five columns come to 337px inside a
        326px card, so the timestamp sat entirely past the row's right edge and
        `overflow: hidden` erased it — with a correct `textContent` and a
        column that fit its own text, so this case was green over the very
        defect it exists for. That is this repository's characteristic failure
        and it happened here, in this file, on the first attempt.

        The invariant is therefore about the *container*: a trade list may
        scroll, but it may not hide. Scrolled as far right as it goes, the
        whole cell has to be inside the visible box.
      */
      const reach = await dialog.locator(".trade-list").evaluate((list) => {
        list.scrollLeft = list.scrollWidth;
        const box = list.getBoundingClientRect();
        const cellBox = list.querySelector(".row-moment")!.getBoundingClientRect();
        return {
          listLeft: box.left,
          listRight: box.right,
          cellLeft: cellBox.left,
          cellRight: cellBox.right,
        };
      });
      expect(
        Math.round(reach.cellRight),
        "the timestamp is cut off by its row and cannot be scrolled into view",
      ).toBeLessThanOrEqual(Math.round(reach.listRight));
      expect(Math.round(reach.cellLeft)).toBeGreaterThanOrEqual(Math.round(reach.listLeft));
    });
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
