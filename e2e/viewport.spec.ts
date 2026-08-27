import { expect, test } from "@playwright/test";

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
 */
test.use({ viewport: { width: 1280, height: 900 } });

test.describe("the home page at 1280×900", () => {
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
  test("holds the wallet slot without pretending it is a flow", async ({ page }) => {
    await page.goto("/");

    await expect(page.getByText("Ranking de traders hispanos")).toBeVisible();
    const registro = page.locator(".registro");
    await expect(registro).toHaveText("Registro — próximamente");
    await expect(registro).toHaveAttribute("aria-disabled", "true");
    // Not a link, not a button, and not reachable by keyboard.
    expect(await registro.evaluate((node) => node.tagName)).toBe("SPAN");
    expect(await registro.evaluate((node) => node.hasAttribute("tabindex"))).toBe(false);
  });
});
