import { monogramLetter } from "@/lib/monogram";

/**
 * DESIGN.md `row-leaderboard`: *avatar 22px*. One component for both surfaces,
 * so the feed row and the leaderboard row cannot drift into two avatars.
 *
 * `src` is `PublicTrade.kol.avatarUrl` / `PublicLeaderboardEntry.kol.avatarUrl`,
 * which `serialize.ts` builds as `/api/avatar/<kol_id>` and nothing else. Same
 * origin, so the browser never reaches a third party — `docs/references.md` §5
 * records kolscanbrasil.io hotlinking `pbs.twimg.com`, which hands X every
 * visitor's request and makes a broken upstream a broken row.
 *
 * **The box is reserved by the `<span>`, not by the image.** `.avatar` is 22×22
 * with `flex: none`, and the `<img>` fills it — so a slow image, a failed image
 * and a monogram all occupy the same 22 pixels and nothing on the row moves.
 * The route makes that easy to hold: it answers every upstream failure with the
 * monogram at `200`, so an `<img>` here has nothing to fall back *from*.
 *
 * `alt=""` and `aria-hidden` because the name is already the next thing on the
 * row, in text. An avatar that announced the name again would make every row
 * say it twice to a screen reader.
 *
 * Rendered without `next/image`: this is a 22px image from our own origin,
 * already the smallest thing on the page, and the optimizer would add a second
 * request and a query string to save nothing.
 */
export function Avatar({ name, src }: { name: string; src: string }) {
  return (
    <span className="avatar" aria-hidden="true">
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt="" width={22} height={22} loading="lazy" decoding="async" />
      ) : (
        // No URL at all is not a state the serializer can produce; it is what a
        // hand-built fixture or a future caller might pass. The same letter the
        // route would have drawn, so even that case is not a broken image.
        monogramLetter(name)
      )}
    </span>
  );
}
