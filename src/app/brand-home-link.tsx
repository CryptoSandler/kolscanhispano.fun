"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";

/**
 * **The wordmark and the flag tile, as one link to the ranking that keeps the
 * window you were reading.**
 *
 * `Clasificación` left the nav on 2026-09-03 because the mould reaches its
 * ranking by clicking the wordmark, and ours does too. That made a plain
 * `href="/"` wrong in a way it had not been before: the ranking's state lives
 * entirely in the query string — `docs/parecido-2026-09-02.md` §2, and
 * `LeaderboardControls`' *"every combination is a real URL, so the state
 * survives a reload, a share and a back button"* — so a bare `/` is not "go
 * home", it is **`?window=diario&unit=usd`**. A reader on `Semanal` who clicks
 * the logo gets silently moved to `Diario` and has no way to know the page did
 * that rather than the week having emptied.
 *
 * So the link carries the two parameters forward. It is the URL that persists
 * them, not `localStorage`: the choice is already in the address bar, a copied
 * link already means what it says, and a second store would be a place for the
 * two to disagree. Nothing here writes to the browser.
 *
 * **The values are validated before they are re-emitted.** They come from the
 * URL, which is the reader's to write, and this is the one component that
 * copies one URL's parameters into another link — so an unrecognised `window`
 * or `unit` is dropped rather than passed along. The page validates on arrival
 * too; this keeps the site from generating links to states it does not have.
 * The option lists arrive as props for the same reason `LeaderboardControls`
 * takes them: `LEADERBOARD_FIATS` lives beside the Postgres driver, and a
 * client component importing it would pull `pg` into the browser bundle.
 *
 * `useSearchParams` is typed non-null and is null when this renders outside a
 * request — `renderToStaticMarkup`, which is how `address-invariant.test.ts`
 * sweeps every public surface. Absent parameters mean a bare `/`, which is the
 * same answer this gives on a URL that carries none.
 */
export function BrandHomeLink({
  windows,
  fiats,
  children,
}: {
  windows: readonly string[];
  fiats: readonly string[];
  children: React.ReactNode;
}) {
  const params = useSearchParams();

  const query = new URLSearchParams();
  const window = params?.get("window");
  const unit = params?.get("unit");
  if (window !== null && window !== undefined && windows.includes(window)) {
    query.set("window", window);
  }
  if (unit !== null && unit !== undefined && fiats.includes(unit)) {
    query.set("unit", unit);
  }
  const suffix = query.toString();

  /*
    **The whole brand block is the link**, tile and subtitle included, rather
    than the wordmark alone with a decorative tile beside it. The alternative
    was two anchors to one destination, or an `aria-hidden` anchor around the
    tile — a focusable element hidden from assistive technology, which is a
    defect rather than a shortcut. One anchor, one accessible name, and the
    grid the header already has is unchanged: this element *is* `.brand`.
  */
  return (
    <Link className="brand" href={suffix === "" ? "/" : `/?${suffix}`}>
      {children}
    </Link>
  );
}
