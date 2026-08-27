import { expect, test, type Locator, type Page } from "@playwright/test";
import { findDisallowedBase58 } from "../src/lib/hygiene";

/**
 * `modal-kol`'s behaviour, in a real browser, opened from a real seeded row.
 *
 * **Why this file exists.** Five of the six things DESIGN.md states about this
 * component are *behaviours* — *"dismissible by `Esc`, backdrop click and a
 * close button; focus trapped; the trigger row regains focus on close"* — and
 * none of them can be asserted by the unit suite: `vitest.config.mts` sets
 * `environment: "node"`, there is no DOM in it, and `renderToStaticMarkup`
 * cannot press a key. They were held up by review alone until this file.
 *
 * **Nothing here mounts a component.** The modal is opened by clicking a row of
 * the seeded leaderboard, which is the only way to exercise the composition:
 * the provider wrapping the table, the row's conditional affordance, the fetch
 * to `/api/kol/<slug>`, the serializer and the markup, in the order a reader
 * meets them. This project's expensive defects have all been in composition —
 * `fee_sol` written and never read, `tokenMetadata` called by nothing, an
 * `avatarUrl` that 404ed on every response — and each of them would have
 * survived a mounted component.
 *
 * ## The seed, and which row is which
 *
 * `e2e/seed.ts` ranks twelve KOLs by realized SOL descending and sets
 * `hide_wallets = index % 3 !== 0`, so the roster carries both shapes and the
 * ranking puts them next to each other:
 *
 * - **rank 1** (`cripto_ana`, +18,42 SOL) publishes its wallets — its trade row
 *   carries a Solscan link with a real signature, which spec §8.2 publishes on
 *   purpose.
 * - **rank 2** (`trader_beto`, +12,05 SOL) hides them — its trade row must read
 *   `PRIVADO`, and nothing base58 may reach the DOM at all.
 *
 * Both are needed: a suite that only opened the hidden one would pass with a
 * modal that published nothing anywhere, which asserts the absence of a string
 * that was never supplied.
 *
 * Each KOL gets exactly one `pnl_daily` row, so the daily chart is the
 * single-point case `chart.ts` handles — drawn here for real, in a browser.
 */
test.use({ viewport: { width: 1280, height: 900 } });

/** The public KOL and the hidden one, by rank. See the note above. */
const PUBLIC_ROW = 1;
const HIDDEN_ROW = 2;

/**
 * The dev server compiles `/api/kol/[slug]` on the first request to it, which
 * is slower than Playwright's default expect timeout on a cold Turbopack.
 */
const FIRST_LOAD = 30_000;

function rowAt(page: Page, rank: number): Locator {
  return page.locator(".row-leaderboard").nth(rank - 1);
}

/**
 * Clicks a ranked row and waits for the modal to hold real content.
 *
 * The rank cell is the click target on purpose: the row's handler excludes
 * clicks that land on an `<a>` so the `@handle` still goes to X, and the
 * identity cell is full of one.
 */
async function open(page: Page, rank: number): Promise<{ row: Locator; dialog: Locator }> {
  const row = rowAt(page, rank);
  const dialog = page.locator("dialog.modal-kol");

  await row.locator(".rank-cell").click();
  await expect(dialog).toHaveAttribute("open", "", { timeout: FIRST_LOAD });
  await expect(dialog.locator(".modal-head")).toBeVisible({ timeout: FIRST_LOAD });
  return { row, dialog };
}

/**
 * Opens a row and hands back the response the browser actually received from
 * `/api/kol/<slug>`, alongside the dialog it filled.
 *
 * **The payload has to be asserted separately from the DOM, and a mutation
 * proved it.** `KolDetail` branches on `kol.hideWallets` before it ever looks at
 * a signature, so publishing every signature from `serialize.ts` changes nothing
 * a DOM scan can see — the component refuses to render it either way. That is
 * the right product behaviour and the wrong thing to rely on in a test: the
 * response is still on the wire, in the browser's memory, and one `fetch` in a
 * console away from anybody. The scan below is the only place in this repository
 * where the whole chain — query, serializer, route, network, browser — is
 * observed at once.
 */
async function openWithPayload(
  page: Page,
  rank: number,
): Promise<{ row: Locator; dialog: Locator; body: string }> {
  const response = page.waitForResponse(
    (candidate) => candidate.url().includes("/api/kol/") && candidate.status() === 200,
    { timeout: FIRST_LOAD },
  );
  const opened = await open(page, rank);
  return { ...opened, body: await (await response).text() };
}

/** The trades the payload carries, which is all the scans below need from it. */
function tradesIn(body: string): { mint: string; signature: string | null }[] {
  const parsed = JSON.parse(body) as { trades: { mint: string; signature: string | null }[] };
  return parsed.trades;
}

/** Whether `<body>` is scroll-locked, which is what a modal owes the page behind it. */
function bodyLocked(page: Page): Promise<boolean> {
  return page.evaluate(() => document.body.style.overflow === "hidden");
}

/**
 * Waits for the page to get its scroll back.
 *
 * Polled rather than read once, and the difference is a real race this suite
 * caught: `dialog.close()` removes the `open` attribute synchronously, while
 * releasing the lock is React unmounting an effect a commit later. Reading it
 * immediately after the attribute check passes about four times in five, which
 * is the worst kind of test. What matters is that the lock is released, not
 * that it is released in the same tick.
 */
async function expectScrollBack(page: Page): Promise<void> {
  await expect.poll(() => bodyLocked(page)).toBe(false);
}

test.beforeEach(async ({ page }) => {
  await page.goto("/leaderboard");
  await expect(page.locator(".row-leaderboard")).toHaveCount(12);
});

test.describe("modal-kol opens from a row and shows that KOL's period", () => {
  test("renders the whole composition, not just a dialog", async ({ page }) => {
    // Without this every dismissal test below could pass against an empty
    // dialog: closing something that never opened is not the property.
    const { dialog } = await open(page, PUBLIC_ROW);

    await expect(dialog.getByRole("heading", { name: "Ana Cripto" })).toBeVisible();
    await expect(dialog.getByRole("link", { name: /Perfil de Ana Cripto en X/ })).toBeVisible();
    // The header's figure is the row's figure: both read `pnl_daily` through
    // the same window bounds, and the modal opens on the page's window.
    await expect(dialog.locator(".modal-pnl")).toContainText("+18,42 SOL");
    await expect(rowAt(page, PUBLIC_ROW).locator(".num-lg")).toHaveText("+18,42 SOL");

    // The four cards DESIGN.md lists, in order.
    await expect(dialog.locator("section.card")).toHaveCount(4);
    await expect(dialog.getByText("PnL acumulado")).toBeVisible();
    await expect(dialog.getByText("PnL por cadena")).toBeVisible();
    // One `pnl_daily` row per KOL, so the daily chart is `chart.ts`'s
    // single-point case: a marker and no line.
    await expect(dialog.locator(".chart circle")).toHaveCount(1);
    await expect(dialog.locator(".chart-line")).toHaveCount(0);

    // DESIGN.md's second Don't. The seed's handles are fictional so unavatar
    // has nothing for them and `/api/avatar/<kol_id>` answers with the
    // monogram — which is the point: the assertion is the *origin*, never a
    // photo.
    const avatar = dialog.locator(".modal-head img");
    await expect(avatar).toHaveAttribute("src", /^\/api\/avatar\/[0-9a-f-]{36}$/);
    await expect(avatar).toHaveAttribute("width", "64");
  });
});

test.describe("the three dismissals DESIGN.md names", () => {
  test("Esc closes it, and gives the page its scroll back", async ({ page }) => {
    const { dialog } = await open(page, PUBLIC_ROW);
    expect(await bodyLocked(page)).toBe(true);

    await page.keyboard.press("Escape");

    await expect(dialog).not.toHaveAttribute("open", "");
    // Releasing the lock matters more than taking it: a page left unable to
    // scroll is a broken page, and it outlives the modal that broke it.
    await expectScrollBack(page);
  });

  test("a backdrop click closes it", async ({ page }) => {
    const { dialog } = await open(page, PUBLIC_ROW);

    // The card fills the dialog's box, so anything outside the card is the
    // `::backdrop` — and a click on it is dispatched with the dialog itself as
    // the target, which is exactly what the handler tests for. Clicking near
    // the top-left corner of the viewport is outside the centred card.
    await page.mouse.click(8, 8);

    await expect(dialog).not.toHaveAttribute("open", "");
    await expectScrollBack(page);
  });

  test("a click inside the card does not close it", async ({ page }) => {
    // The other half of the same rule, and the one a wrong `event.target` test
    // breaks: a modal that closed whenever you clicked its own contents would
    // pass the case above.
    const { dialog } = await open(page, PUBLIC_ROW);

    await dialog.getByText("PnL acumulado").click();

    await expect(dialog).toHaveAttribute("open", "");
  });

  test("the close button closes it", async ({ page }) => {
    const { dialog } = await open(page, PUBLIC_ROW);

    await dialog.getByRole("button", { name: "Cerrar" }).click();

    await expect(dialog).not.toHaveAttribute("open", "");
    await expectScrollBack(page);
  });
});

test.describe("focus, which is the half a keyboard user actually feels", () => {
  test("never lets focus land on the page behind it", async ({ page }) => {
    const { dialog } = await open(page, PUBLIC_ROW);

    /**
     * Where focus is: inside the dialog, on a node behind it, or off the page
     * altogether.
     *
     * **`page-left` is not a leak.** Tabbing past the last focusable in a
     * document hands focus to the browser's own UI, and `document.activeElement`
     * falls back to `<body>`; that is the browser, not this page, and asserting
     * it away would be asserting something the platform does not promise. What
     * DESIGN.md means by *"focus trapped"* is the other case: a reader must
     * never end up on a leaderboard row behind the scrim, tabbing through a page
     * they cannot see.
     */
    const where = () =>
      page.evaluate(() => {
        const node = document.activeElement;
        if (!node || node === document.body || node === document.documentElement) {
          return "page-left";
        }
        const modal = document.querySelector("dialog.modal-kol");
        if (modal?.contains(node)) return "inside";
        return `outside: ${node.className || node.tagName}`;
      });

    const focusable = dialog.locator("button, a[href], [tabindex]:not([tabindex='-1'])");
    const count = await focusable.count();
    // A trap over one node proves nothing: the modal has a close control, three
    // segments and at least one link.
    expect(count).toBeGreaterThan(3);

    // The rows behind are in the tab order in their own right, so without the
    // dialog this walk would reach them. That is what makes the assertion below
    // about the trap rather than about a page with nothing to focus.
    await expect(rowAt(page, PUBLIC_ROW)).toHaveAttribute("tabindex", "0");

    // Two full cycles plus slack, so the wrap is crossed rather than approached.
    await focusable.first().focus();
    const visited: string[] = [];
    for (let step = 0; step < count * 2 + 4; step += 1) {
      await page.keyboard.press("Tab");
      visited.push(await where());
    }
    expect(visited.filter((place) => place.startsWith("outside"))).toEqual([]);
    expect(visited).toContain("inside");

    // Backwards is a separate code path in every browser that has ever got this
    // wrong.
    await focusable.first().focus();
    for (let step = 0; step < count + 2; step += 1) {
      await page.keyboard.press("Shift+Tab");
      expect(await where(), `after ${step + 1} back-tabs`).not.toMatch(/^outside/);
    }
  });

  test("makes the page behind it inert, so nothing can hand focus back", async ({ page }) => {
    // The stronger half, and the one a hand-rolled overlay does not get: with
    // `showModal()` everything outside the dialog is inert, so even a script
    // calling `.focus()` on a row cannot move focus out of it. This is why the
    // trap is one method call rather than a keydown listener walking focusable
    // nodes — a listener only sees keystrokes.
    const { dialog } = await open(page, PUBLIC_ROW);

    await rowAt(page, 3).evaluate((node) => (node as HTMLElement).focus());

    const inside = await page.evaluate(() =>
      document.querySelector("dialog.modal-kol")?.contains(document.activeElement),
    );
    expect(inside).toBe(true);
    await expect(dialog).toHaveAttribute("open", "");
  });

  test("returns focus to the row that opened it", async ({ page }) => {
    // Opened from the keyboard, which is the path where losing focus actually
    // strands someone: a reader who pressed Enter on a row and dismissed the
    // modal has no way back to their place if focus lands on <body>.
    const row = rowAt(page, PUBLIC_ROW);
    await row.focus();
    await expect(row).toBeFocused();

    await page.keyboard.press("Enter");
    const dialog = page.locator("dialog.modal-kol");
    await expect(dialog).toHaveAttribute("open", "", { timeout: FIRST_LOAD });
    await expect(dialog.locator(".modal-head")).toBeVisible({ timeout: FIRST_LOAD });
    expect(await row.evaluate((node) => node === document.activeElement)).toBe(false);

    await page.keyboard.press("Escape");

    await expect(dialog).not.toHaveAttribute("open", "");
    await expect(row).toBeFocused();
  });
});

/**
 * Spec §7 and §8, on the one surface a page render never reaches.
 *
 * `address-invariant.test.ts` scans `KolDetail` rendered from what
 * `readKolDetail` returns; this scans the **live DOM of an open modal** in a
 * browser, after a real fetch over the wire. They can only disagree if
 * something between the two — the route, the response, hydration — puts
 * something on the page that the component alone would not.
 *
 * The rule is `hygiene.ts`'s, reused rather than restated so the two cannot
 * disagree about what an address looks like: every base58 run of 32 or more
 * characters is reported, and each one has to be accounted for. The two this
 * product publishes deliberately are a **signature**, inside a Solscan `/tx/`
 * link and only for a KOL that publishes its wallets, and a **mint**, which
 * spec §3 keeps in cleartext.
 */
test.describe("spec §7: no wallet address reaches the open modal", () => {
  test("accounts for every base58 run in a public KOL's modal, and it is its signature", async ({
    page,
  }) => {
    const { dialog, body } = await openWithPayload(page, PUBLIC_ROW);
    const html = await dialog.evaluate((node) => node.outerHTML);

    // On the wire first: mints, which spec §3 keeps in cleartext, and
    // signatures, which §8.2 publishes for a KOL that does not hide its wallets
    // so its explorer links work. Nothing else — an address above all.
    const trades = tradesIn(body);
    expect(trades.length).toBeGreaterThan(0);
    const published = new Set([
      ...trades.map((trade) => trade.mint),
      ...trades.map((trade) => trade.signature).filter((s): s is string => s !== null),
    ]);
    expect(findDisallowedBase58(body).sort()).toEqual([...published].sort());

    const runs = findDisallowedBase58(html);
    // Non-vacuous: this KOL publishes its wallets, so its one seeded trade
    // carries a real signature and the scan has something to find. A modal that
    // rendered nothing would otherwise pass this whole describe.
    expect(runs.length).toBeGreaterThan(0);

    // Every one of them is a signature in an explorer link. An address would be
    // a run that is not, and so would a mint printed into the markup, and so
    // would base58 nobody predicted.
    const linked = [...html.matchAll(/https:\/\/solscan\.io\/tx\/([1-9A-HJ-NP-Za-km-z]+)/g)].map(
      ([, signature]) => signature,
    );
    expect(runs.sort()).toEqual([...new Set(linked)].sort());
  });

  test("carries nothing base58 at all in a hidden KOL's modal", async ({ page }) => {
    // Spec §7: "For hidden KOLs, neither the signature nor the link is
    // exposed." A signature names the signer in any explorer, so publishing one
    // while withholding the address publishes the address one click later.
    const { dialog, body } = await openWithPayload(page, HIDDEN_ROW);
    const html = await dialog.evaluate((node) => node.outerHTML);

    // The payload, which is the layer the DOM cannot speak for: not one
    // signature survives serialization for this KOL, and the only base58 left
    // is the mint. Publishing a hidden KOL's signature publishes its address one
    // click later, so this is the whole promise rather than a detail of it.
    const trades = tradesIn(body);
    expect(trades.length).toBeGreaterThan(0);
    expect(trades.map((trade) => trade.signature)).toEqual(trades.map(() => null));
    expect(findDisallowedBase58(body).sort()).toEqual(
      [...new Set(trades.map((trade) => trade.mint))].sort(),
    );

    // And the DOM, which carries neither the mint nor anything else base58.
    await expect(dialog.locator(".row-trade")).not.toHaveCount(0);
    expect(findDisallowedBase58(html)).toEqual([]);
    expect(html).not.toContain("solscan.io");
  });

  test("reads PRIVADO with a padlock where the wallets are hidden", async ({ page }) => {
    // DESIGN.md `list-defi-trades`: "where the wallet is hidden the row reads
    // `PRIVADO` with a padlock instead of a signature link."
    const { dialog } = await open(page, HIDDEN_ROW);

    const rows = dialog.locator(".row-trade");
    const count = await rows.count();
    expect(count).toBeGreaterThan(0);
    // Every row, not the first: one labelled row beside three linked ones would
    // be the same defect.
    await expect(dialog.locator(".row-trade .privado")).toHaveCount(count);
    await expect(dialog.locator(".privado").first()).toContainText("PRIVADO");
    // Drawn, not typed: an emoji padlock carries its own colour and could be
    // neither tinted with the text nor kept out of the green and red DESIGN.md
    // reserves for money.
    await expect(dialog.locator(".privado svg").first()).toBeAttached();

    // The identity is still public — `b0f2a43`: "the handle is public identity,
    // the wallet is the secret."
    await expect(dialog.getByRole("link", { name: /Perfil de Beto Trader en X/ })).toBeVisible();
    await expect(dialog.locator(".hidden-wallets")).toHaveText("Wallets ocultas");
  });

  test("prints no truncated address either, which is what both references do", async ({ page }) => {
    // `docs/references.md` §5: both reference sites print a `HFx9E1`-style chip
    // in the slot this modal fills with `Wallets ocultas` or with nothing.
    // DESIGN.md: "Where the reference prints a truncated address, we print
    // nothing." A six-character truncation is below `hygiene.ts`'s 32-character
    // floor, so the scan above cannot see it; this reads the slot instead.
    const { dialog } = await open(page, HIDDEN_ROW);

    const identity = dialog.locator(".modal-identity");
    await expect(identity).toHaveText(/^Beto Trader@trader_betoWallets ocultas$/);
  });
});

/**
 * The failed-load state, which `4a2f2df` made normative:
 * `| modal-kol on a failed load | the cards | ` + "`No se pudo cargar este KOL.` with a retry |".
 *
 * It is here rather than in the unit suite because it only exists after a fetch
 * has failed, and `renderToStaticMarkup` does not run the effect that fetches.
 * Asserting it against the source text of a component is the shape of check
 * this repository has already been wrong about.
 */
test.describe("modal-kol on a failed load", () => {
  test("says the document's sentence and offers a retry that works", async ({ page }) => {
    // The first request fails, the second succeeds — so the retry is proved to
    // recover rather than merely to exist.
    let attempts = 0;
    await page.route("**/api/kol/**", async (route) => {
      attempts += 1;
      if (attempts === 1) return route.abort("failed");
      return route.continue();
    });

    const row = rowAt(page, PUBLIC_ROW);
    await row.locator(".rank-cell").click();
    const dialog = page.locator("dialog.modal-kol");

    await expect(dialog.locator(".state-empty-lead")).toHaveText("No se pudo cargar este KOL.", {
      timeout: FIRST_LOAD,
    });
    // No copy at all while loading, and none pretending to be progress here
    // either: DESIGN.md, "`Cargando…` is a spinner in words, and this system
    // does not ship spinners."
    await expect(dialog).not.toContainText("Cargando");

    await dialog.getByRole("button", { name: "Reintentar" }).click();

    await expect(dialog.locator(".modal-head")).toBeVisible({ timeout: FIRST_LOAD });
    await expect(dialog.getByRole("heading", { name: "Ana Cripto" })).toBeVisible();
    await expect(dialog.locator(".state-empty-lead")).toHaveCount(0);
  });
});
