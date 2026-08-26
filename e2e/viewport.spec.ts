import { expect, test } from "@playwright/test";

/**
 * DESIGN.md's thesis, as a regression guard.
 *
 * *"The 36px row is the point of this direction: the leaderboard's top ten and
 * the live feed's last eight should share one 900px viewport without
 * scrolling."* That was measured once by hand, and it passed with one pixel to
 * spare — which is exactly the kind of property that stops being true the next
 * time someone adds a line to a panel head. It is worth a browser.
 *
 * The viewport is 1280×900 because those are the two numbers DESIGN.md names:
 * 1280px is the layout maximum, 900px is the viewport the thesis claims.
 */
test.use({ viewport: { width: 1280, height: 900 } });

test.describe("the home page at 1280×900", () => {
  test("does not scroll, in either axis", async ({ page }) => {
    await page.goto("/");

    // The rows have to be there for the assertion to mean anything: a page
    // that rendered nothing would pass every size check on this list.
    await expect(page.locator(".row-leaderboard")).toHaveCount(10);
    // The feed holds more rows than it shows — it is a fixed-height column
    // that scrolls internally — so what the budget depends on is the height of
    // the list, which is eight rows exactly, and not how many rows exist.
    await expect(page.locator(".row-feed").first()).toBeVisible();
    const feedList = await page.locator(".feed-list").boundingBox();
    expect(Math.round(feedList!.height)).toBe(8 * 36);

    const box = await page.evaluate(() => ({
      scrollHeight: document.documentElement.scrollHeight,
      innerHeight: window.innerHeight,
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
    }));

    expect(box.scrollHeight).toBeLessThanOrEqual(box.innerHeight);
    // A table of fixed-width columns is the easiest thing on this page to push
    // past the viewport, and a horizontal scrollbar would also steal height.
    expect(box.scrollWidth).toBeLessThanOrEqual(box.innerWidth);
  });

  /**
   * The thesis is about *these two things together*, so the guard says so
   * rather than trusting the document height to imply it: both panels have to
   * be wholly inside the viewport, not merely not-scrolling because something
   * collapsed.
   */
  test("shows both sections whole, feed above leaderboard", async ({ page }) => {
    await page.goto("/");

    // One panel, two hairline-divided sections: the feed, then the ranking.
    const sections = page.locator("main .panel-section");
    await expect(sections).toHaveCount(2);

    const feed = await sections.nth(0).boundingBox();
    const board = await sections.nth(1).boundingBox();
    expect(feed).not.toBeNull();
    expect(board).not.toBeNull();

    expect(feed!.y).toBeGreaterThanOrEqual(0);
    // Feed above ranking, not merely both present.
    expect(feed!.y + feed!.height).toBeLessThanOrEqual(board!.y);
    expect(board!.y + board!.height).toBeLessThanOrEqual(900);
    // Every row at DESIGN.md's 36px, which is the only reason the two fit.
    const heights = await page.locator(".row-leaderboard").evaluateAll((rows) =>
      rows.map((row) => Math.round(row.getBoundingClientRect().height)),
    );
    expect(new Set(heights)).toEqual(new Set([36]));
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
});
