import { readAffiliateSlot } from "@/lib/settings";

/**
 * Spec §1.9: an affiliate slot in the nav, link and label configurable from
 * the admin, **empty at launch**.
 *
 * Empty means it renders nothing — not a placeholder, not a reserved box. It
 * is the only revenue surface either reference site has and both put it in the
 * nav, so the slot exists now; what goes in it is an admin row that does not
 * exist yet.
 *
 * `rel="sponsored"` because that is what the link is, and `noreferrer` so the
 * destination is not told which page of ours sent the reader.
 */
export async function AffiliateSlot() {
  const slot = await readAffiliateSlot();
  if (slot === null) return null;

  return (
    <a
      className="affiliate"
      href={slot.url}
      target="_blank"
      rel="noreferrer noopener sponsored"
    >
      {slot.label}
    </a>
  );
}
