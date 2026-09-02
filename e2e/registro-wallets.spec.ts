import { expect, test } from "@playwright/test";
import { installWallets } from "./fake-wallet";

/**
 * `/registro`'s wallet chooser, driven in a real browser by wallets that
 * register themselves exactly as an extension does.
 *
 * **This is the case no unit test can reach and no installed extension can
 * provide here.** Playwright's browser has no wallet extension, and the two
 * wallets that matter for the rule — one that does Solana and one that does not
 * — cannot both be installed on demand. Registering them from the page is the
 * same handshake an extension performs, so the whole path is exercised: the
 * `app-ready` dispatch, the filter, the chooser, the connect and the signature.
 *
 * `addInitScript` runs before any page script, which is what makes these
 * wallets "already present" when discovery asks — the ordering that the real
 * failure mode depends on.
 */

test.describe("the wallet chooser on /registro", () => {
  test("lists a registered Solana wallet and leaves an EVM-only one out", async ({ page }) => {
    await installWallets(page);
    await page.goto("/registro");

    await page.getByRole("button", { name: "Conectar wallet" }).click();

    const dialog = page.locator("dialog.modal-wallets");
    await expect(dialog).toHaveAttribute("open", "", { timeout: 30_000 });
    await expect(dialog.getByText("Prueba Solana")).toBeVisible();
    // The whole point: it is absent because it declares no Solana chain.
    await expect(dialog.getByText("Prueba Solo EVM")).toHaveCount(0);
  });

  test("says so, and opens nothing, when no wallet is installed", async ({ page }) => {
    await page.goto("/registro");
    await page.getByRole("button", { name: "Conectar wallet" }).click();

    await expect(page.locator("dialog.modal-wallets")).toHaveCount(0);
    // `.state-error` and not `getByRole("alert")`: Next injects its own
    // `__next-route-announcer__` with `role="alert"`, so the role alone matches
    // two elements and fails on strict mode rather than on the copy.
    await expect(page.locator("p.state-error")).toContainText(
      "No encontramos ninguna wallet de Solana",
    );
  });

  test("Esc closes the chooser without connecting anything", async ({ page }) => {
    await installWallets(page);
    await page.goto("/registro");
    await page.getByRole("button", { name: "Conectar wallet" }).click();
    await expect(page.locator("dialog.modal-wallets")).toHaveAttribute("open", "");

    await page.keyboard.press("Escape");

    await expect(page.locator("dialog.modal-wallets")).toHaveCount(0);
    // Still on the first step: nothing was connected, so no wallet list rendered.
    await expect(page.getByRole("button", { name: "Conectar wallet" })).toBeVisible();
  });

  /**
   * Picking a wallet runs the real flow as far as the browser can take it: the
   * page asks the server for a nonce, builds the proof text, and hands it to the
   * wallet's `signMessage`. The wallet returns a fixed signature, so the server
   * will refuse the proof later — which is correct and is not what this asserts.
   * What it asserts is that choosing a wallet leaves the first step, which no
   * unit test can show.
   */
  test("picking a wallet carries the flow past the connect step", async ({ page }) => {
    await installWallets(page);
    await page.goto("/registro");
    await page.getByRole("button", { name: "Conectar wallet" }).click();
    await page.getByRole("button", { name: "Prueba Solana" }).click();

    await expect(page.locator("dialog.modal-wallets")).toHaveCount(0);
    await expect(page.getByText("¡Casi listo!")).toBeVisible({ timeout: 30_000 });
  });
});
