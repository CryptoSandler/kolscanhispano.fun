/**
 * `setting` (spec §3) holds the affiliate slot, the caps and the feature
 * switches. Only the affiliate slot is read in v1.
 */
import { query } from "./db";

/** Spec §1.9: link and label, configurable from the admin, **empty at launch**. */
export type AffiliateSlot = { label: string; url: string };

/**
 * The affiliate slot, or `null` when it is not configured — which is its
 * launch state, and renders nothing at all rather than a placeholder.
 *
 * Two things this has to get right, because the value is admin-supplied and
 * lands in an `href`:
 *
 * - **Only `https:`.** A `javascript:` URL in a settings row would be stored
 *   XSS on every page of the site, and React will happily render it: its own
 *   protection here is a development-mode warning, not a block. An affiliate
 *   link has no reason to be anything but `https:`, so the whitelist costs
 *   nothing and closes the sink.
 * - **A failure is not worth a blank site.** The slot is in the root layout,
 *   so a database hiccup while reading it would otherwise take down every
 *   page including the legal ones. It degrades to "not configured".
 */
export async function readAffiliateSlot(): Promise<AffiliateSlot | null> {
  let value: unknown;
  try {
    const rows = await query<{ value: unknown }>(
      "SELECT value FROM setting WHERE key = 'affiliate'",
    );
    value = rows[0]?.value;
  } catch {
    // Never the driver's message: it can carry a fragment of the connection
    // string.
    console.warn("readAffiliateSlot: the setting could not be read");
    return null;
  }
  return parseAffiliateSlot(value);
}

/**
 * Exported for its own test: the validation is the part worth pinning, and it
 * has nothing to do with the database.
 */
export function parseAffiliateSlot(value: unknown): AffiliateSlot | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;

  const label = typeof record.label === "string" ? record.label.trim() : "";
  const url = typeof record.url === "string" ? record.url.trim() : "";
  if (label === "" || url === "") return null;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:") return null;

  return { label, url: parsed.href };
}
