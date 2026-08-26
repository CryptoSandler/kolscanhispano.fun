import { beforeEach, describe, expect, it } from "vitest";
import { query } from "./db";
import { parseAffiliateSlot, readAffiliateSlot } from "./settings";

beforeEach(async () => {
  await query("DELETE FROM setting WHERE key = 'affiliate'");
});

async function setAffiliate(value: unknown): Promise<void> {
  await query(
    `INSERT INTO setting (key, value) VALUES ('affiliate', $1::jsonb)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [JSON.stringify(value)],
  );
}

describe("readAffiliateSlot", () => {
  // Spec §1.9: empty at launch. Nothing configured must render nothing, not a
  // placeholder and not a broken link.
  it("is null when the setting has never been written", async () => {
    expect(await readAffiliateSlot()).toBeNull();
  });

  it("returns the configured label and link", async () => {
    await setAffiliate({ label: "Operá en Ejemplo", url: "https://ejemplo.test/ref/abc" });
    expect(await readAffiliateSlot()).toEqual({
      label: "Operá en Ejemplo",
      url: "https://ejemplo.test/ref/abc",
    });
  });

  it("is null when the admin cleared it", async () => {
    await setAffiliate({ label: "", url: "" });
    expect(await readAffiliateSlot()).toBeNull();
  });
});

describe("parseAffiliateSlot", () => {
  /**
   * The sink this guard exists for. React renders a `javascript:` href with a
   * console warning and no block, so an admin row — or anything that can write
   * one — would be stored XSS on every page of the site.
   */
  it("refuses a scheme that is not https", () => {
    for (const url of [
      "javascript:alert(1)",
       
      "JavaScript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "http://ejemplo.test/ref",
      "/ref/abc",
      "ejemplo.test",
    ]) {
      expect(parseAffiliateSlot({ label: "Ir", url })).toBeNull();
    }
  });

  it("refuses a row missing either half", () => {
    expect(parseAffiliateSlot({ url: "https://ejemplo.test" })).toBeNull();
    expect(parseAffiliateSlot({ label: "Ir" })).toBeNull();
    expect(parseAffiliateSlot({ label: "   ", url: "https://ejemplo.test" })).toBeNull();
  });

  it("refuses a value that is not an object", () => {
    for (const value of [null, undefined, "https://ejemplo.test", 7, []]) {
      expect(parseAffiliateSlot(value)).toBeNull();
    }
  });

  it("accepts an https link and trims it", () => {
    expect(parseAffiliateSlot({ label: "  Ir  ", url: "  https://ejemplo.test/ref  " })).toEqual({
      label: "Ir",
      url: "https://ejemplo.test/ref",
    });
  });
});
