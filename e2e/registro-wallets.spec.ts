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
  test("always lists the same three, in the same order, with nothing else on the row", async ({
    page,
  }) => {
    /*
      **La lista es fija.** Antes mostraba lo que el navegador había encontrado,
      con secciones y badges, y eso convertía tres marcas en un informe sobre el
      estado de las extensiones. Un lector que abre esto dos veces ve lo mismo.
    */
    await page.goto("/registro");
    const panel = page.locator(PANEL);
    await expect(panel).toBeVisible({ timeout: 30_000 });

    const names = await panel.locator(".wallet-choice-name").allTextContents();
    expect(names).toEqual(["Phantom", "MetaMask", "Rabby"]);

    // Nada anuncia antes del clic si está instalada ni en qué cadena firma.
    await expect(panel.locator(".wallet-choice-chain")).toHaveCount(0);
    await expect(panel.getByText("Detectada")).toHaveCount(0);
    await expect(panel.getByText("Instalar")).toHaveCount(0);
  });

  test("`Mostrar más` reveals the other three in the same format", async ({ page }) => {
    await page.goto("/registro");
    const panel = page.locator(PANEL);
    await expect(panel).toBeVisible({ timeout: 30_000 });

    await panel.getByRole("button", { name: "Mostrar más" }).click();

    const names = await panel.locator(".wallet-choice-name").allTextContents();
    expect(names).toEqual(["Phantom", "MetaMask", "Rabby", "Backpack", "Solflare", "Trust Wallet"]);
    await expect(panel.locator(".wallet-choice-chain")).toHaveCount(0);
  });

  test("the list looks the same whether or not a wallet is installed", async ({ page }) => {
    // La lista no dice quién está: es la decisión del dueño, y es lo que hace
    // que la pantalla sea estable entre dos lectores distintos.
    await installWallets(page, 2);
    await page.goto("/registro");
    const panel = page.locator(PANEL);
    await expect(panel).toBeVisible({ timeout: 30_000 });

    const names = await panel.locator(".wallet-choice-name").allTextContents();
    expect(names).toEqual(["Phantom", "MetaMask", "Rabby"]);
    await expect(panel.getByText("Detectada")).toHaveCount(0);
  });

  test("clicking an installed wallet connects and carries the flow on", async ({ page }) => {
    await installWallets(page, 2);
    await page.goto("/registro");
    const panel = page.locator(PANEL);
    await expect(panel).toBeVisible({ timeout: 30_000 });

    await panel.getByRole("button", { name: "Phantom" }).click();

    // Mismo panel: no se abrió nada encima ni se navegó.
    await expect(panel).toBeVisible();
    // El paso final se reconoce por su contenido: el subtítulo `Casi listo` se
    // eliminó el 2026-09-06, porque el título del modal ya nombra el paso.
    await expect(page.locator(".almost-wallet")).toBeVisible({ timeout: 30_000 });
  });

  test("clicking a wallet that is not installed says so, after the click", async ({ page }) => {
    /*
      Sin extensiones, tocar `Phantom` abre su página oficial en otra pestaña y
      deja la línea debajo de esa fila. **Después del clic**, nunca antes.
    */
    await page.goto("/registro");
    const panel = page.locator(PANEL);
    await expect(panel).toBeVisible({ timeout: 30_000 });
    await expect(panel.getByText("Instálala y vuelve a intentar")).toHaveCount(0);

    /*
      Se mide la línea y no la pestaña. `window.open` no levanta un evento `page`
      de forma confiable en un contexto de Playwright —el caso esperó 30 s por
      uno que no llegó— y lo que importa acá es lo que el lector ve en el panel,
      no cuántas pestañas abrió el navegador. Que la URL sea la oficial lo fija
      la lista en `wallet-step.tsx` y lo mira una revisión, no un test de humo.
    */
    await panel.getByRole("button", { name: "Phantom" }).click();

    await expect(panel.getByText("Instálala y vuelve a intentar")).toBeVisible();
    // Y sólo en esa fila.
    await expect(panel.locator(".wallet-absent")).toHaveCount(1);
    // Sin navegar: el panel sigue abierto y en la lista.
    await expect(panel).toBeVisible();
    expect(new URL(page.url()).pathname).toBe("/registro");
  });

  test("Esc closes the panel without connecting anything", async ({ page }) => {
    await installWallets(page, 2);
    await page.goto("/registro");
    await expect(page.locator(PANEL)).toBeVisible({ timeout: 30_000 });

    await page.keyboard.press("Escape");

    await expect(page.locator(PANEL)).toHaveCount(0);
    await expect(page.locator(".almost-wallet")).toHaveCount(0);
  });

  /**
   * `Casi listo` son tres controles y un botón, y nada más.
   *
   * Era un muro de texto: cada control arrastraba dos o tres frases y el CTA
   * quedaba fuera de pantalla a 390. `docs/copy.md` fija una línea de ayuda por
   * control.
   */
  test("the last step is three controls and one primary button", async ({ page }) => {
    await installWallets(page, 2);
    await page.goto("/registro");
    await page.locator(PANEL).getByRole("button", { name: "Phantom" }).click();
    // El paso final se reconoce por su contenido: el subtítulo `Casi listo` se
    // eliminó el 2026-09-06, porque el título del modal ya nombra el paso.
    await expect(page.locator(".almost-wallet")).toBeVisible({ timeout: 30_000 });

    const panel = page.locator(PANEL);
    await expect(panel.locator(".almost-wallet")).toHaveCount(1);
    await expect(panel.getByRole("button", { name: "Privada" })).toBeVisible();
    await expect(panel.getByPlaceholder("@usuario")).toBeVisible();
    await expect(panel.locator(".connect-cta")).toHaveCount(1);
    await expect(panel.getByRole("button", { name: "Entrar al ranking" })).toBeVisible();
    // Ni el subtítulo viejo ni el nuevo: el título del modal alcanza.
    await expect(panel.getByText("Casi listo")).toHaveCount(0);
  });

  test("the visibility toggle starts private and says so", async ({ page }) => {
    await installWallets(page, 2);
    await page.goto("/registro");
    await page.locator(PANEL).getByRole("button", { name: "Phantom" }).click();
    // El paso final se reconoce por su contenido: el subtítulo `Casi listo` se
    // eliminó el 2026-09-06, porque el título del modal ya nombra el paso.
    await expect(page.locator(".almost-wallet")).toBeVisible({ timeout: 30_000 });

    const toggle = page.locator(PANEL).getByRole("button", { name: "Privada" });
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    await toggle.click();
    await expect(page.locator(PANEL).getByRole("button", { name: "Pública" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  /*
    **Una wallet detectada que no está en la lista fija.**

    Glow, OKX, la que sea: si el navegador la anunció, se puede firmar con ella,
    y esconderla sería ofrecer menos de lo que hay. Va al final de `Mostrar más`
    con el ícono que anunció, y **no** empuja a las que siempre están: la lista
    fija es fija justamente para ser la misma en dos lectores distintos.
  */
  test("appends a detected wallet that is not on the fixed list", async ({ page }) => {
    await installWallets(page, 2, ["Glow", "Backpack"]);
    await page.goto("/registro");
    const panel = page.locator(PANEL);
    await expect(panel).toBeVisible({ timeout: 30_000 });

    // Cerrada, la lista no cambió: Glow no se cuela arriba.
    expect(await panel.locator(".wallet-choice-name").allTextContents()).toEqual([
      "Phantom",
      "MetaMask",
      "Rabby",
    ]);

    await panel.getByRole("button", { name: "Mostrar más" }).click();

    // Y desplegada, aparece al final.
    expect(await panel.locator(".wallet-choice-name").allTextContents()).toEqual([
      "Phantom",
      "MetaMask",
      "Rabby",
      "Backpack",
      "Solflare",
      "Trust Wallet",
      "Glow",
    ]);
    // Mismo formato: sin chips.
    await expect(panel.locator(".wallet-choice-chain")).toHaveCount(0);
  });

  test("without it, the expanded list is exactly the fixed six", async ({ page }) => {
    // La otra mitad del caso de arriba: sin nada raro instalado, la lista es la
    // fija y nada más.
    await page.goto("/registro");
    const panel = page.locator(PANEL);
    await expect(panel).toBeVisible({ timeout: 30_000 });
    await panel.getByRole("button", { name: "Mostrar más" }).click();

    expect(await panel.locator(".wallet-choice-name").allTextContents()).toEqual([
      "Phantom",
      "MetaMask",
      "Rabby",
      "Backpack",
      "Solflare",
      "Trust Wallet",
    ]);
  });
});
