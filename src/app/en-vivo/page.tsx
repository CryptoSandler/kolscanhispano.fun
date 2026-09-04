import Link from "next/link";
import { readFeedPage } from "@/lib/feed";
import { FeedLive } from "../feed-live";

/** The feed is the newest trades; there is nothing here to prerender. */
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Live · kolscanhispano.fun",
  description: "Cada compra y cada venta de los KOL del padrón, en cuanto la cadena las confirma.",
};

/**
 * The live feed, on its own page since 2026-09-03.
 *
 * It sat above the ranking on the home page, which was ours rather than the
 * mould's: `docs/references.md` §5 argued that *"a live feed on the home page
 * is not a genre requirement. Putting one there is our choice, and it is the
 * choice that makes the site read as alive on the first three seconds."*
 * kolscanbrasil.io has no feed at all and its home **is** the ranking
 * (`docs/clone-map.md` §2). The owner settled it: the ranking takes the home
 * page and the feed keeps its own route rather than being deleted — kolscan.io
 * keeps its feed on its own page too, which is where this shape comes from.
 *
 * Nothing about the feed itself changed. `FeedLive` is the same client
 * component with the same initial rows rendered on the server.
 */
export default async function EnVivoPage() {
  const feed = await readFeedPage();

  return (
    <>
      <div className="page-head is-row">
        <h1 className="display-lg">Live</h1>
        <Link className="panel-link" href="/">
          ← Volver a la clasificación
        </Link>
      </div>

      <div className="panel" style={{ marginTop: "var(--stack)" }}>
        <FeedLive initialTrades={feed.trades} />
      </div>
    </>
  );
}
