import { expect, test } from "@playwright/test";
import { activeChains } from "../src/lib/chain";
import { E2E_ADMIN_TOKEN } from "../playwright.config";
import { installWallets } from "./fake-wallet";

/**
 * The preview route mocks two wallets per chain with live ingestion, so the
 * count is derived rather than written down: this spec and the page read the
 * same flags, and a chain switched on moves both together. Hardcoding `4` is
 * what broke this file the first time.
 */
const ROWS = activeChains().length * 2;

/**
 * The screenshots the **closing agent** reads: `¡Casi listo!` and the KOL
 * detail, each at the desktop width DESIGN.md names and at 390px.
 *
 * **These are captures, not assertions**, and they are kept apart from
 * `viewport.spec.ts` for that reason. That file states rules and fails when
 * they break; this one produces images for a person to look at, and the few
 * `expect`s in it exist only to make sure the shot was taken *after* the thing
 * being photographed had arrived — a screenshot of a half-rendered modal is
 * worse than no screenshot, because it looks like a finding.
 *
 * **They are not the owner's gate, and they are not handed over.** `~/.claude/
 * GATES.md` and `/cierre` §3: the agent closing the batch opens every one of
 * these, describes it in a line, and contrasts it against `DESIGN.md` and the
 * copy the page is supposed to say — any deviation becomes a finding of the
 * close, red test or not. Listing the paths and letting the owner look is the
 * failure mode that rule exists to prevent: the run wrote files, and nobody
 * read them. The single exception is an aesthetic batch, where the owner's eye
 * is the acceptance criterion — and there the gate is the **preview URL**, the
 * real page at their viewport, never a directory of PNGs.
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

    /**
     * The surfaces the audit against `kolscanbrasil.io` reads first, with the
     * twelve-KOL seed behind them. **The home page and the ranking are one
     * page** since 2026-09-03, so there is one capture where there were two;
     * the feed has its own now. `docs/parecido-2026-09-02.md` reads these
     * beside theirs.
     */
    test("la home, que es la clasificación", async ({ page }) => {
      await page.goto("/");
      await expect(page.locator(".row-leaderboard").first()).toBeVisible({ timeout: 30_000 });
      await page.screenshot({ path: `${OUT}/home-${name}.png` });
    });

    /*
      La captura del feed público se borró el 2026-09-06 con el feed
      (`DECISIONES.md`): `/en-vivo` es un 308 a la home, así que la foto sería
      de la home con otro nombre. El feed de admin no se fotografía acá porque
      pide token y estas capturas son de superficies públicas.
    */

    /**
     * The same ranking with the peso selected, which is the surface
     * `docs/round-ars.md` is about: the figure, the rate, the casa and the date
     * it was quoted, all on the page.
     */
    test("la clasificación en pesos", async ({ page }) => {
      await page.goto("/?unit=ars");
      await expect(page.locator(".row-leaderboard").first()).toBeVisible({ timeout: 30_000 });
      await page.screenshot({ path: `${OUT}/ranking-ars-${name}.png` });
    });

    /** The two surfaces built on 2026-09-02: `docs/clone-map.md` §6 and §7. */
    test("los cabals, con el podio de tres", async ({ page }) => {
      await page.goto("/cabals");
      await expect(page.locator(".podium-card").first()).toBeVisible({ timeout: 30_000 });
      await page.screenshot({ path: `${OUT}/cabals-${name}.png`, fullPage: true });
    });

    test("la página de operar, sin socio", async ({ page }) => {
      await page.goto("/trade");
      await expect(page.locator(".step").first()).toBeVisible({ timeout: 30_000 });
      await page.screenshot({ path: `${OUT}/trade-${name}.png`, fullPage: true });
    });

    test("¡Casi listo!, con varias wallets", async ({ page }) => {
      await page.goto("/preview/onboarding");

      // Two rows per active chain, so the shot shows what a multi-row list
      // actually looks like -- a single row hides every layout question this
      // screen has.
      const rows = page.locator(".row-wallet");
      await expect(rows).toHaveCount(ROWS, { timeout: 30_000 });
      expect(ROWS).toBeGreaterThan(1);
      await expect(page.getByText("¡Casi listo!")).toBeVisible();

      await page.screenshot({ path: `${OUT}/onboarding-${name}.png`, fullPage: true });
    });

    test("¡Casi listo!, con una wallet pública y el handle escrito", async ({ page }) => {
      await page.goto("/preview/onboarding");
      await expect(page.locator(".row-wallet")).toHaveCount(ROWS, { timeout: 30_000 });

      // The second state worth photographing: one row switched to `Pública`,
      // and the handle field showing what it will store. A shot of the default
      // state alone would not show either control doing anything.
      await page.locator(".row-wallet").first().getByText("Pública").click();
      await page.locator("input.input").fill("https://x.com/ejemplo");
      await expect(page.locator(".onboarding-echo")).toContainText("@ejemplo");

      await page.screenshot({ path: `${OUT}/onboarding-activo-${name}.png`, fullPage: true });
    });

    /**
     * The admin, with the roster the seed built. The token is typed the way an
     * operator types it, so the shot is of the screen as it is actually used
     * rather than of a state only a test can reach.
     */
    test("admin, con el padrón cargado", async ({ page }) => {
      await page.goto("/admin");
      await page.locator('input[type="password"]').fill(E2E_ADMIN_TOKEN);
      await page.getByRole("button", { name: "Ver el padrón" }).click();

      // Waits for the roster rather than for the click: a shot taken between
      // the two would photograph an empty table and look like a finding.
      await expect(page.locator(".admin-table .row-leaderboard").first()).toBeVisible({
        timeout: 30_000,
      });
      await page.screenshot({ path: `${OUT}/admin-${name}.png`, fullPage: true });
    });

    test("/registro, el paso de conectar", async ({ page }) => {
      await page.goto("/registro");
      // No wallet extension exists in this browser, so this is the state a
      // first-time visitor sees. The steps behind it are photographed by the
      // onboarding captures above, which render the same component.
      /*
        El modal abre **directo en la lista de wallets** desde el 2026-09-06: el
        paso previo con un botón `Connect Wallet` adentro de un modal que se
        abrió con `Connect Wallet` no decidía nada, y salió. Sin extensiones
        instaladas en este navegador, lo que se ve es la sección `Otras`.
      */
      await expect(page.locator("dialog.modal-connect")).toBeVisible({ timeout: 30_000 });
      await expect(page.getByRole("heading", { name: "Conecta tu wallet" })).toBeVisible();
      await expect(page.locator(".connect-step")).toBeVisible();
      await page.screenshot({ path: `${OUT}/registro-${name}.png`, fullPage: true });
    });

    /**
     * The wallet chooser, with two Solana wallets registered from the page --
     * two because one connects straight through and opens no chooser.
     *
     * The shot the owner asked for cannot be taken literally: it wanted the
     * chooser with Rabby installed, and Rabby declares 63 chains, all EVM
     * (`rabby.io`, read 2026-09-01). It cannot register as a Solana wallet, so
     * no chooser can show it. What this photographs instead is the rule that
     * decides the question — a registered Solana wallet present, a registered
     * EVM-only wallet absent — which is the same reason Rabby is absent.
     */
    test("el selector de wallet, con una wallet de Solana registrada", async ({ page }) => {
      await installWallets(page, 2);
      await page.goto("/registro");
      /*
        La lista vive **en el mismo panel**, no en un diálogo encima: un modal
        adentro de otro fue lo que el dueño marcó en el gate.
      */
      const dialog = page.locator("dialog.modal-connect");
      await expect(dialog).toBeVisible({ timeout: 30_000 });
      // Waits for the row, so the shot is never of an empty dialog.
      await expect(dialog.getByText("Prueba Solana 1")).toBeVisible();

      await page.screenshot({ path: `${OUT}/wallet-picker-${name}.png`, fullPage: true });
    });

    test("detalle del KOL", async ({ page }) => {
      await page.goto("/");
      const dialog = page.locator("dialog.modal-kol");
      await page.locator(".row-leaderboard").first().locator(".rank-cell").click();
      await expect(dialog).toHaveAttribute("open", "", { timeout: 30_000 });
      await expect(dialog.locator(".modal-head")).toBeVisible({ timeout: 30_000 });
      // The calendar is the biggest thing on this screen and the last to
      // arrive, so the shot waits for it rather than for the modal alone. It
      // waited for `.card-wallets` until 2026-09-03, when the wallet counts
      // moved into the header and that selector stopped existing — a stale
      // wait that turned into a 30-second timeout on every capture.
      await expect(dialog.locator(".calendar, .calendar-empty")).toBeVisible({ timeout: 30_000 });

      await page.screenshot({ path: `${OUT}/detalle-${name}.png` });
    });
  });
}
