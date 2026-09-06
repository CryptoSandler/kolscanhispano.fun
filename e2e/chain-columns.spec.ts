import { expect, test } from "@playwright/test";

/**
 * **The fiat total starts at the same x on every row, whatever the row holds.**
 *
 * The ranking's figures are four fixed tracks — ETH, BNB, SOL, fiat — measured
 * in kolscanbrasil's DOM at 1440 on 2026-09-05: `x=676 w=120`, `x=796 w=130`,
 * `x=926 w=130`, `x=1056 w=140`, ending exactly at the card's inner edge.
 *
 * They were content-sized siblings before that, and the failure it produced is
 * the reason this file exists: a row with two chain amounts pushed the total
 * left until it collided with the amount beside it — `+12.50 SOL(+US$7.275,00)`,
 * with no gap at all, in the 1440 capture.
 *
 * A layout assertion needs a browser, so it lives here rather than in the unit
 * suite: `renderToStaticMarkup` produces no geometry, and a test of the CSS
 * string would assert what was written rather than what the browser did with it.
 */
/**
 * **Both viewports.** The owner compares at ~1245 in a real window, not at 1440,
 * and the container's rule differs above and below its `max-width` — measured on
 * the mould 2026-09-05: `max-width: 1024px` with `padding: 0 16px`, so the card
 * is 992 wide at 1245 and at 1440 alike, and fluid below 1056. A geometry test
 * at one width would miss a regression that only appears at the other.
 */
const VIEWPORTS = [
  { name: "1245", width: 1245, height: 900 },
  { name: "1440", width: 1440, height: 1000 },
];

for (const viewport of VIEWPORTS) {
test.describe(`the chain columns do not collapse @${viewport.name}`, () => {
  test.use({ viewport: { width: viewport.width, height: viewport.height } });
  test("puts the fiat total at the same x on a row with three chains and one with one", async ({
    page,
  }) => {
    await page.goto("/");
    await page.waitForSelector(".board > li");

    const rows = await page.evaluate(() =>
      [...document.querySelectorAll(".board > li")].map((li) => ({
        // A slot holding a real amount, rather than the `---` placeholder.
        filled: li.querySelectorAll(".chain-slot .chain-amount").length,
        slots: li.querySelectorAll(".chain-slot").length,
        fiatX: Math.round(li.querySelector(".pnl-fiat")?.getBoundingClientRect().x ?? -1),
        slotXs: [...li.querySelectorAll(".chain-slot")].map((s) =>
          Math.round(s.getBoundingClientRect().x),
        ),
      })),
    );

    expect(rows.length).toBeGreaterThan(2);

    // The comparison has to be between rows that actually differ, or it proves
    // nothing. `e2e/seed.ts` gives one KOL a second chain for exactly this.
    const many = rows.filter((row) => row.filled >= 2);
    const one = rows.filter((row) => row.filled === 1);
    expect(many.length, "the fixture has no row with two chain amounts").toBeGreaterThan(0);
    expect(one.length, "the fixture has no row with a single chain amount").toBeGreaterThan(0);

    // The property: one x for the fiat, across every row on the page.
    const fiatXs = new Set(rows.map((row) => row.fiatX));
    expect([...fiatXs], `the fiat total moved between rows: ${JSON.stringify(rows)}`).toHaveLength(
      1,
    );

    // And the slots themselves: three on every row, at the same three x's,
    // whether or not they hold a figure.
    for (const row of rows) {
      expect(row.slots, "a row rendered a different number of chain slots").toBe(3);
      expect(row.slotXs).toEqual(rows[0].slotXs);
    }

    // The slot before the fiat must end before the fiat begins — the collision
    // that started this, asserted directly rather than inferred from equality.
    expect(rows[0].slotXs[2]).toBeLessThan(rows[0].fiatX);
  });

  /**
   * **No amount's right edge may reach the fiat's text.**
   *
   * The slots were right-aligned and still collided, because the *fiat* string
   * overflowed its 140px track leftward — their totals carry no `+` and ours
   * did, one glyph too many. Equal x's would not have caught that: the fiat
   * element started in the same place on every row while its text spilled out
   * of it. This measures the painted boxes.
   */
  test("never lets an amount touch the fiat total", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector(".board > li");

    const overlaps = await page.evaluate(() =>
      [...document.querySelectorAll(".board > li")].flatMap((li) => {
        const fiat = li.querySelector(".pnl-fiat");
        if (!fiat) return [];
        // The text's own box, not the track's: a range around the text node is
        // what a reader actually sees, and it is what overflowed.
        const range = document.createRange();
        range.selectNodeContents(fiat);
        const fiatLeft = range.getBoundingClientRect().left;
        return [...li.querySelectorAll(".chain-slot .chain-amount")]
          .map((a) => ({
            amount: (a.textContent ?? "").trim(),
            right: Math.round(a.getBoundingClientRect().right),
            fiatLeft: Math.round(fiatLeft),
            who: (li.querySelector(".name")?.textContent ?? "").trim(),
          }))
          .filter((m) => m.right >= m.fiatLeft);
      }),
    );

    expect(overlaps, "a chain amount reaches the fiat total's text").toEqual([]);
  });

  /**
   * **Every row is 76px, with no exception.**
   *
   * The mould's are, and ours were 76 on the podium and 84 below: the `@handle`
   * printed beside the `𝕏` glyph pushed the identity line onto a second row on
   * most cards. The handle moved to the modal on 2026-09-05 for exactly this
   * (`docs/references.md`), and this is what stops it coming back — a height
   * regression is invisible in a diff and obvious in a side-by-side.
   */
  test("renders every row at the mould's 76px, not just the podium", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector(".board > li");

    const heights = await page.evaluate(() =>
      [...document.querySelectorAll(".board > li")].map((li) => ({
        h: Math.round(li.getBoundingClientRect().height),
        who: (li.querySelector(".name")?.textContent ?? "").trim(),
      })),
    );

    expect(heights.length).toBeGreaterThan(3);
    const wrong = heights.filter((row) => row.h !== 76);
    expect(wrong, `rows taller or shorter than the mould's 76px`).toEqual([]);
  });

  test("keeps the row card and the figure block at the mould's measure", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector(".board > li");

    const measured = await page.evaluate(() => {
      const li = document.querySelector(".board > li")!;
      const box = li.getBoundingClientRect();
      const figures = li.querySelector(".row-figures")!.getBoundingClientRect();
      return {
        width: Math.round(box.width),
        height: Math.round(box.height),
        figures: Math.round(figures.width),
        radius: getComputedStyle(li).borderRadius,
      };
    });

    // Measured on kolscanbrasil at 1440: 992 wide, 76 tall, 8px radius, and a
    // 520px figure block (120 + 130 + 130 + 140).
    expect(measured.width).toBe(992);
    expect(measured.height).toBe(76);
    expect(measured.figures).toBe(520);
    expect(measured.radius).toBe("8px");
  });
});
}

/**
 * The public-wallet disclosure, and the bug it fixes.
 *
 * `+N ▾` used to insert the extra addresses **inline beside the chip**, which
 * widened the identity line until the name was clipped — `prueba dos …`. The
 * mould opens an indented panel *below* instead: the row's first line does not
 * move, the card grows, and the rows beneath it move down.
 */
test.describe("the public-wallet panel", () => {
  test.use({ viewport: { width: 1440, height: 1000 } });

  test("opens below the row without touching the name or the rows beneath", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector(".board > li");

    const toggle = page.locator(".wallet-more").first();
    if ((await toggle.count()) === 0) {
      // The fixture must contain a KOL publishing more than one wallet, or this
      // proves nothing. Failing loudly beats passing vacuously.
      throw new Error("no KOL in the fixture publishes two wallets");
    }

    const read = () =>
      page.evaluate(() => {
        const li = [...document.querySelectorAll(".board > li")].find((l) =>
          l.querySelector(".wallet-more"),
        )!;
        const name = li.querySelector(".name")!;
        const box = name.getBoundingClientRect();
        return {
          card: Math.round(li.getBoundingClientRect().height),
          nameWidth: Math.round(box.width),
          // The name's own position: if it has not moved, the row's first line
          // has not moved, whatever the markup does underneath.
          nameX: Math.round(box.x),
          nameY: Math.round(box.y),
          clipped: name.scrollWidth > name.clientWidth + 1,
          others: [
            ...new Set(
              [...document.querySelectorAll(".board > li")]
                .filter((l) => !l.querySelector(".wallet-more"))
                .map((l) => Math.round(l.getBoundingClientRect().height)),
            ),
          ],
        };
      });

    const before = await read();
    expect(before.card, "the closed row is the mould's 76px").toBe(76);
    expect(before.clipped, "the name is clipped before the panel is even opened").toBe(false);

    await toggle.click();
    await expect(page.locator(".wallet-panel")).toBeVisible();
    const after = await read();

    // The name: same width, same place, still whole. This is the bug.
    expect(after.nameWidth).toBe(before.nameWidth);
    expect(after.nameX).toBe(before.nameX);
    expect(after.nameY).toBe(before.nameY);
    expect(after.clipped, "the name was clipped by opening the panel").toBe(false);

    // The card grows; every other row keeps the mould's height.
    expect(after.card).toBeGreaterThan(before.card);
    expect(after.others).toEqual([76]);

    // Addresses are `6...4` and never whole.
    const shown = await page.locator(".wallet-full").allTextContents();
    expect(shown.length).toBeGreaterThan(1);
    for (const address of shown) {
      expect(address, `${address} is not the 6...4 form`).toMatch(/^[\w]{6}\.\.\.[\w]{4}$/);
    }
  });

  test("closes on Escape", async ({ page }) => {
    await page.goto("/");
    await page.locator(".wallet-more").first().click();
    await expect(page.locator(".wallet-panel")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator(".wallet-panel")).toBeHidden();
  });

  test("closes on a click outside", async ({ page }) => {
    await page.goto("/");
    await page.locator(".wallet-more").first().click();
    await expect(page.locator(".wallet-panel")).toBeVisible();
    // The page title: outside the panel and not itself a control.
    await page.locator(".page-title").click();
    await expect(page.locator(".wallet-panel")).toBeHidden();
  });
});

/**
 * **La identidad nunca entra en las columnas de monto.**
 *
 * Bug del gate, 2026-09-06: la fila de `prueba miembro 2` tenía el chip EVM
 * dibujado **debajo** de `+0,42 ETH`. El bloque de identidad —nombre, tag,
 * chip, badges— no tenía tope de ancho, así que empujaba hacia la derecha y se
 * metía en la primera pista de montos, que es fija.
 *
 * El caso usa el peor insumo a propósito: un nombre de 30 caracteres, un tag y
 * un chip de dos wallets. Lo que mide no es que se vea lindo sino la propiedad
 * geométrica: **ningún elemento de identidad supera la x del primer slot.**
 */
test.describe("la identidad no invade los montos", () => {
  test.use({ viewport: { width: 1245, height: 900 } });

  test("keeps every identity element left of the first amount slot", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector(".board > li");

    const measured = await page.evaluate(() => {
      const rows = [...document.querySelectorAll(".board > li")];
      return rows.map((li) => {
        const slot = li.querySelector(".chain-slot");
        const slotX = slot ? slot.getBoundingClientRect().x : Infinity;
        const parts = [...li.querySelectorAll(".identity-line > *, .identity-line .name")];
        const worst = parts.reduce(
          (max, el) => Math.max(max, el.getBoundingClientRect().right),
          0,
        );
        return {
          name: (li.querySelector(".name")?.textContent ?? "").slice(0, 40),
          slotX: Math.round(slotX),
          identityRight: Math.round(worst),
        };
      });
    });

    expect(measured.length).toBeGreaterThan(2);
    for (const row of measured) {
      expect(
        row.identityRight,
        `la identidad de "${row.name}" llega a ${row.identityRight} y el primer slot empieza en ${row.slotX}`,
      ).toBeLessThanOrEqual(row.slotX);
    }
  });

  test("truncates a 30-character name with an ellipsis rather than overflowing", async ({
    page,
  }) => {
    await page.goto("/");
    await page.waitForSelector(".board > li");

    const overflowing = await page.evaluate(() => {
      const names = [...document.querySelectorAll(".board > li .name")];
      // Un nombre que no entra tiene `scrollWidth > clientWidth`; lo que importa
      // es que en ese caso **no** se salga de su caja, que es lo que la elipsis
      // garantiza.
      return names.map((el) => ({
        text: el.textContent ?? "",
        clipped: el.scrollWidth > el.clientWidth,
        overflowsBox: el.getBoundingClientRect().right > (el.parentElement?.getBoundingClientRect().right ?? 0) + 1,
      }));
    });

    expect(overflowing.length).toBeGreaterThan(0);
    for (const name of overflowing) {
      expect(name.overflowsBox, `"${name.text}" se sale de su caja`).toBe(false);
    }
  });
});
