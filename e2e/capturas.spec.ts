import { expect, test } from "@playwright/test";

/**
 * The screenshots the owner's gate reviews: `¡Casi listo!` and the KOL detail,
 * each at the desktop width DESIGN.md names and at 390px.
 *
 * **These are captures, not assertions**, and they are kept apart from
 * `viewport.spec.ts` for that reason. That file states rules and fails when
 * they break; this one produces images for a person to look at, and the few
 * `expect`s in it exist only to make sure the shot was taken *after* the thing
 * being photographed had arrived — a screenshot of a half-rendered modal is
 * worse than no screenshot, because it looks like a finding.
 *
 * Output goes to `test-results/capturas/`, which `.gitignore` already covers:
 * an image of a screen is a build artefact, and committing one would put a
 * second, stale copy of the design in the repository beside the code that
 * renders it.
 */

const SIZES = [
  { name: "desktop-1280", viewport: { width: 1280, height: 900 } },
  { name: "movil-390", viewport: { width: 390, height: 844 } },
] as const;

const OUT = "test-results/capturas";

for (const { name, viewport } of SIZES) {
  test.describe(`capturas · ${name}`, () => {
    test.use({ viewport });

    test("¡Casi listo!, con varias wallets", async ({ page }) => {
      await page.goto("/preview/onboarding");

      // The preview route invents four wallets across three chains, so the
      // shot shows what a multi-row list actually looks like -- a single row
      // hides every layout question this screen has.
      const rows = page.locator(".row-wallet");
      await expect(rows).toHaveCount(4, { timeout: 30_000 });
      await expect(page.getByText("¡Casi listo!")).toBeVisible();

      await page.screenshot({ path: `${OUT}/onboarding-${name}.png`, fullPage: true });
    });

    test("¡Casi listo!, con una wallet pública y el handle escrito", async ({ page }) => {
      await page.goto("/preview/onboarding");
      await expect(page.locator(".row-wallet")).toHaveCount(4, { timeout: 30_000 });

      // The second state worth photographing: one row switched to `Pública`,
      // and the handle field showing what it will store. A shot of the default
      // state alone would not show either control doing anything.
      await page.locator(".row-wallet").first().getByText("Pública").click();
      await page.locator("input.input").fill("https://x.com/ejemplo");
      await expect(page.locator(".onboarding-echo")).toContainText("@ejemplo");

      await page.screenshot({ path: `${OUT}/onboarding-activo-${name}.png`, fullPage: true });
    });

    test("detalle del KOL", async ({ page }) => {
      await page.goto("/leaderboard");
      const dialog = page.locator("dialog.modal-kol");
      await page.locator(".row-leaderboard").first().locator(".rank-cell").click();
      await expect(dialog).toHaveAttribute("open", "", { timeout: 30_000 });
      await expect(dialog.locator(".modal-head")).toBeVisible({ timeout: 30_000 });
      // The wallet card is the new part of this screen, so the shot waits for
      // it rather than for the modal alone.
      await expect(dialog.locator(".card-wallets")).toBeVisible({ timeout: 30_000 });

      await page.screenshot({ path: `${OUT}/detalle-${name}.png` });
    });
  });
}
