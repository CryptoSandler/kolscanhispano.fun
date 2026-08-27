import { monogramLetter } from "@/lib/monogram";

/**
 * One avatar component for both surfaces, so the feed row and the leaderboard
 * row cannot drift into two avatars.
 *
 * `src` is `PublicTrade.kol.avatarUrl` / `PublicLeaderboardEntry.kol.avatarUrl`,
 * which `serialize.ts` builds as `/api/avatar/<kol_id>` and nothing else. Same
 * origin, so the browser never reaches a third party — DESIGN.md's second
 * Don't is *"**Don't** hotlink an avatar. Every photo comes from
 * `/api/avatar/<kol_id>`"*, and `docs/references.md` §6 records
 * kolscanbrasil.io hotlinking `pbs.twimg.com`, which hands X every visitor's
 * request and makes a broken upstream a broken row.
 *
 * **The box is reserved by the `<span>`, not by the image.** `.avatar` is a
 * fixed square with `flex: none` and the `<img>` fills it — so a slow image, a
 * failed image and a monogram all occupy the same pixels and nothing on the row
 * moves. The route makes that easy to hold: it answers every upstream failure
 * with the monogram at `200`, so an `<img>` here has nothing to fall back
 * *from*.
 *
 * `size` is the one dimension the two surfaces disagree on. DESIGN.md
 * `row-leaderboard` says *"36px circular avatar from `/api/avatar/<kol_id>`"*;
 * it says nothing about the feed row, whose one-line sentence keeps the 22px
 * it already had. The value is passed to the browser three ways on purpose —
 * the `width`/`height` attributes give the image its intrinsic box before any
 * CSS loads, and `--avatar-size` sizes the reserved span and its monogram.
 *
 * `alt=""` and `aria-hidden` because the name is already the next thing on the
 * row, in text. An avatar that announced the name again would make every row
 * say it twice to a screen reader.
 *
 * Rendered without `next/image`: this is a small image from our own origin and
 * the optimizer would add a second request and a query string to save nothing.
 */
export function Avatar({ name, src, size = 22 }: { name: string; src: string; size?: number }) {
  return (
    <span
      className="avatar"
      style={{ "--avatar-size": `${size}px` } as React.CSSProperties}
      aria-hidden="true"
    >
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt="" width={size} height={size} loading="lazy" decoding="async" />
      ) : (
        // No URL at all is not a state the serializer can produce; it is what a
        // hand-built fixture or a future caller might pass. The same letter the
        // route would have drawn, so even that case is not a broken image.
        monogramLetter(name)
      )}
    </span>
  );
}
