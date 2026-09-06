import { expect, test } from "@playwright/test";
import { installWallets } from "./fake-wallet";

/**
 * El selector de wallets, manejado en un navegador de verdad por wallets que se
 * registran exactamente como lo hace una extensión.
 *
 * **Es el caso que ningún test unitario alcanza y que ninguna extensión
 * instalada puede dar acá.** El navegador de Playwright no tiene extensiones, y
 * las dos wallets que importan para la regla —una que hace Solana y una que no—
 * no se pueden instalar a pedido. Registrarlas desde la página es el mismo
 * handshake que hace una extensión, así que se ejercita el camino entero: el
 * `app-ready`, el filtro, la lista, la conexión y la firma.
 *
 * ## Contra el modal nuevo, desde el 2026-09-06
 *
 * Este archivo estaba escrito contra dos cosas que ya no existen: un botón
 * `Connect Wallet` **adentro** del modal que se abrió con `Connect Wallet`, y un
 * `dialog.modal-wallets` encima del primero. El dueño marcó las dos en el gate.
 *
 * Ahora el modal **abre directo en la lista** y todo pasa en el mismo panel, que
 * es la estructura de RainbowKit y Reown AppKit. Los casos son los mismos; lo
 * que cambió es dónde miran.
 */

/** El panel del modal, que es donde vive todo ahora. */
const PANEL = "dialog.modal-connect";

test.describe("el selector de wallets en /registro", () => {
  test("lists the installed wallets as soon as the modal opens", async ({ page }) => {
    // Sin paso previo: `/registro` abre el modal y el modal abre en la lista.
    await installWallets(page, 2);
    await page.goto("/registro");

    const panel = page.locator(PANEL);
    await expect(panel).toBeVisible({ timeout: 30_000 });
    await expect(panel.getByText("Prueba Solana 1")).toBeVisible();
    await expect(panel.getByText("Prueba Solana 2")).toBeVisible();
    // Abrirlo no conecta nada.
    await expect(page.getByText("Casi listo")).toHaveCount(0);
  });

  test("groups the installed wallets under `Instaladas`", async ({ page }) => {
    await installWallets(page, 2);
    await page.goto("/registro");

    const panel = page.locator(PANEL);
    await expect(panel.getByText("Instaladas")).toBeVisible({ timeout: 30_000 });
  });

  /**
   * El caso Rabby. La wallet EVM-only se registra bien y no aparece porque no
   * declara ninguna cadena de Solana — no porque acá se sepa su nombre.
   */
  test("leaves an EVM-only wallet out of the installed list", async ({ page }) => {
    await installWallets(page, 2);
    await page.goto("/registro");

    const panel = page.locator(PANEL);
    await expect(panel).toBeVisible({ timeout: 30_000 });
    await expect(panel.getByText("Prueba Solo EVM")).toHaveCount(0);
    // Dos filas detectadas; las de `Otras` son enlaces, no botones.
    await expect(panel.locator("button.wallet-choice")).toHaveCount(2);
  });

  /**
   * **`Otras` cuando no hay nada instalado.**
   *
   * Antes esto era un mensaje de error. Ahora es la sección que el estándar
   * pone en su lugar: las wallets que se pueden instalar, con su enlace. Un
   * lector sin extensiones no se encuentra con un fallo — se encuentra con lo
   * que puede hacer.
   */
  test("offers wallets to install when none is present", async ({ page }) => {
    await page.goto("/registro");

    const panel = page.locator(PANEL);
    await expect(panel).toBeVisible({ timeout: 30_000 });
    await expect(panel.getByText("Otras")).toBeVisible();
    await expect(panel.getByText("MetaMask")).toBeVisible();
    await expect(panel.locator("a.wallet-choice").first()).toHaveAttribute("href", /metamask/);
    // Y nada detectado, porque no hay nada.
    await expect(panel.getByText("Instaladas")).toHaveCount(0);
  });

  test("Esc closes the panel without connecting anything", async ({ page }) => {
    await installWallets(page, 2);
    await page.goto("/registro");
    await expect(page.locator(PANEL)).toBeVisible({ timeout: 30_000 });

    await page.keyboard.press("Escape");

    await expect(page.locator(PANEL)).toHaveCount(0);
    await expect(page.getByText("Casi listo")).toHaveCount(0);
  });

  /**
   * Elegir una wallet corre el flujo real hasta donde el navegador puede: la
   * página pide el nonce, arma el texto de la prueba y se lo da a `signMessage`.
   * La wallet devuelve una firma fija, así que el servidor la va a rechazar
   * después — que es correcto y no es lo que este caso mide.
   */
  test("picking a wallet carries the flow to the last step", async ({ page }) => {
    await installWallets(page, 2);
    await page.goto("/registro");
    await page.locator(PANEL).getByRole("button", { name: /Prueba Solana 2/ }).click();

    // Sigue siendo el mismo panel: no se abrió nada encima ni se navegó.
    await expect(page.locator(PANEL)).toBeVisible();
    await expect(page.getByText("Casi listo")).toBeVisible({ timeout: 30_000 });
  });

  /**
   * `Casi listo` son tres controles y un botón, y nada más.
   *
   * Era un muro de texto: cada control arrastraba dos o tres frases y el CTA
   * quedaba fuera de pantalla a 390. `docs/copy.md` fija ahora una línea de
   * ayuda por control.
   */
  test("the last step is three controls and one primary button", async ({ page }) => {
    await installWallets(page, 2);
    await page.goto("/registro");
    await page.locator(PANEL).getByRole("button", { name: /Prueba Solana 2/ }).click();
    await expect(page.getByText("Casi listo")).toBeVisible({ timeout: 30_000 });

    const panel = page.locator(PANEL);
    // La fila de la wallet, con su toggle.
    await expect(panel.locator(".almost-wallet")).toHaveCount(1);
    await expect(panel.getByRole("button", { name: "Privada" })).toBeVisible();
    // El campo del handle.
    await expect(panel.getByPlaceholder("@usuario")).toBeVisible();
    // Un solo CTA primario.
    await expect(panel.locator(".connect-cta")).toHaveCount(1);
    await expect(panel.getByRole("button", { name: "Entrar al ranking" })).toBeVisible();
    // Sin signos de admiración, que es lo que pedía `docs/copy.md`.
    await expect(panel.getByText("¡Casi listo!")).toHaveCount(0);
  });

  test("the visibility toggle starts private and says so", async ({ page }) => {
    // Privada por defecto: publicar es una decisión, no un default.
    await installWallets(page, 2);
    await page.goto("/registro");
    await page.locator(PANEL).getByRole("button", { name: /Prueba Solana 2/ }).click();
    await expect(page.getByText("Casi listo")).toBeVisible({ timeout: 30_000 });

    const toggle = page.locator(PANEL).getByRole("button", { name: "Privada" });
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    await toggle.click();
    await expect(page.locator(PANEL).getByRole("button", { name: "Pública" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });
});
