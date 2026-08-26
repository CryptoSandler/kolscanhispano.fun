import { readFeedPage } from "@/lib/feed";
import { FeedLive } from "./feed-live";

/**
 * Spec §2: the home page is the live trade feed, newest first.
 *
 * The first page is read from the database directly rather than fetched from
 * `/api/feed`: the route exists for the poll, and making the server call its
 * own HTTP endpoint to render would cost a round trip to say something it
 * already knows. Both go through `readFeedPage`, so the filters cannot drift
 * apart.
 */
export const dynamic = "force-dynamic";

export default async function HomePage() {
  const { trades } = await readFeedPage();
  return <FeedLive initialTrades={trades} />;
}
