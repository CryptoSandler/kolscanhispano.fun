import { expect, test } from "@playwright/test";
import { seedLeaderboard } from "./seed";

/**
 * `Connect Wallet` como modal sobre la home.
 *
 * Decisión del dueño, 2026-09-05. Lo que este archivo mide es lo que la
 * decisión pedía y que un test de componente no puede ver: que el botón **no
 * navega**, que `/registro` sigue siendo una ruta directa **con su URL**, y que
 * la primera pantalla dice qué pasa con las wallets antes de pedir nada.
 */
test.beforeEach(async () => {
  await seedLeaderboard();
});

test.describe("el modal de Connect Wallet", () => {
  test("abre sobre la home sin cambiar de página", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector(".board > li");

    await page.getByRole("link", { name: "Connect Wallet" }).click();

    const dialog = page.locator("dialog.modal-connect");
    await expect(dialog).toBeVisible();
    // La clasificación sigue abajo: es un modal, no una pantalla.
    await expect(page.locator(".board > li").first()).toBeAttached();
    expect(new URL(page.url()).pathname).toBe("/");
  });

  test("dice qué pasa con las wallets en la primera pantalla", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("link", { name: "Connect Wallet" }).click();

    const dialog = page.locator("dialog.modal-connect");
    // Las dos promesas, y las dos las verifica un test:
    // `address-invariant.test.ts` y `no-money-path.test.ts`.
    // Una sola vez: vivía duplicada en el modal y en `RegistroForm`.
    await expect(dialog.locator(".privacy-line")).toHaveCount(1);
    await expect(dialog.locator(".privacy-line")).toContainText("nunca se publican");
    // La cláusula que se sumó con la eliminación del feed público.
    await expect(dialog.locator(".privacy-line")).toContainText(
      "tampoco publicamos tus operaciones una por una",
    );
    await expect(dialog.locator(".privacy-line")).toContainText(
      "Firmas un mensaje, no una transacción",
    );
  });

  test("/registro abre el mismo modal y conserva la URL", async ({ page }) => {
    // Los DMs a los KOL tienen esta ruta escrita: un 308 la convertiría en un
    // enlace que ya no lleva a lo que prometía.
    const response = await page.goto("/registro");
    expect(response?.status()).toBe(200);
    expect(new URL(page.url()).pathname).toBe("/registro");

    await expect(page.locator("dialog.modal-connect")).toBeVisible();
    // Y abajo está la home, que es sobre lo que el modal se abre.
    await expect(page.locator(".board > li").first()).toBeAttached();
  });

  test("Esc lo cierra", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("link", { name: "Connect Wallet" }).click();
    await expect(page.locator("dialog.modal-connect")).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(page.locator("dialog.modal-connect")).toHaveCount(0);
  });
});
