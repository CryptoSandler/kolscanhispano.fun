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

  test("dice qué pasa con las wallets, una sola vez y arriba de todo", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("link", { name: "Connect Wallet" }).click();

    const dialog = page.locator("dialog.modal-connect");
    /*
      **Un solo texto, de dos líneas.** Había dos párrafos que decían lo mismo
      con distintas palabras —el del modal y el del formulario— uno debajo del
      otro. El texto exacto lo fijó el dueño el 2026-09-06; `Firmás` va `Firmas`
      porque `docs/copy.md` prohíbe el voseo en superficie pública.

      Las dos promesas las verifica un test: `no-money-path.test.ts` la firma sin
      transacción, `address-invariant.test.ts` que ninguna dirección no pública
      salga a una superficie pública.
    */
    await expect(dialog.locator(".connect-lead")).toHaveCount(1);
    await expect(dialog.locator(".connect-lead")).toContainText(
      "Firmas un mensaje, no una transacción",
    );
    await expect(dialog.locator(".connect-lead")).toContainText("nunca se publican");
    // Y no quedó la copia vieja en el formulario.
    await expect(dialog.locator(".privacy-line")).toHaveCount(0);
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
