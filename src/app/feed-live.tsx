"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { formatRelative, formatSol, formatTokenAmount, formatUsdPrice } from "@/lib/format";
import { FEED_PAGE_SIZE, type PublicTrade } from "@/lib/serialize";

/** Spec §10 says 3–5 s; four is the middle of it. */
const POLL_MS = 4_000;

/** How often the ages re-render. The shortest unit the row prints is a second. */
const TICK_MS = 1_000;

/**
 * The polling feed.
 *
 * Spec §10: polling, no WebSockets. Each poll sends the newest
 * `(block_time, id)` this component holds as `since` and the last `ETag` as
 * `If-None-Match`, so a quiet feed costs a `304` with no body. The `ETag` is
 * kept here rather than left to the browser cache because `next.config.ts`
 * marks `/api/*` `no-store`, and a response the browser may not store is a
 * response it cannot revalidate.
 */
export function FeedLive({ initialTrades }: { initialTrades: PublicTrade[] }) {
  const [trades, setTrades] = useState(initialTrades);

  // The server renders the ages against its own clock and the browser against
  // its own, so the two strings can differ by a second on the very first
  // paint. Each `<time>` below carries `suppressHydrationWarning` for exactly
  // that; the alternative — render no age until mount — leaves the column
  // blank on first paint and empty forever without JavaScript.
  const [now, setNow] = useState(() => Date.now());
  const [arriving, setArriving] = useState<ReadonlySet<string>>(new Set());

  // Read inside the interval callback, so the interval is installed once
  // instead of being torn down and rebuilt on every tick of the clock.
  const etag = useRef<string | null>(null);
  const newest = useRef<PublicTrade | undefined>(initialTrades[0]);

  const inFlight = useRef(false);

  /** One request. Returns whether the server says more rows are waiting. */
  const fetchPage = useCallback(async (): Promise<boolean> => {
    const cursor = newest.current;
    const search = cursor
      ? `?since=${encodeURIComponent(`${cursor.blockTime},${cursor.id}`)}`
      : "";

    let response: Response;
    try {
      response = await fetch(`/api/feed${search}`, {
        headers: etag.current ? { "if-none-match": etag.current } : {},
        cache: "no-store",
      });
    } catch {
      // A dropped connection is the normal case for a laptop that slept, not
      // an error worth showing. The next tick tries again.
      return false;
    }

    if (response.status === 304) {
      etag.current = response.headers.get("etag") ?? etag.current;
      return false;
    }
    if (!response.ok) return false;

    etag.current = response.headers.get("etag");
    const body = (await response.json()) as { trades: PublicTrade[]; hasMore?: boolean };
    if (body.trades.length === 0) return false;

    // The cursor advances to the newest row **that arrived**, never past it.
    // The server pages forward from the cursor, so a burst larger than one
    // page arrives oldest first and the rows still waiting stay reachable;
    // advancing to anything else would skip them silently.
    newest.current = body.trades[0];
    setArriving(new Set(body.trades.map((trade) => trade.id)));
    setTrades((current) => [...body.trades, ...current].slice(0, FEED_PAGE_SIZE));
    return body.hasMore === true;
  }, []);

  const poll = useCallback(async () => {
    // A tab nobody is looking at still costs a database round trip every four
    // seconds. This is a page people leave open, so that adds up.
    if (typeof document !== "undefined" && document.hidden) return;
    // A catch-up can outlast the interval; a second loop would race the first
    // for the cursor and re-request rows it already holds.
    if (inFlight.current) return;

    inFlight.current = true;
    try {
      // Bounded: a server that answered `hasMore` forever would otherwise
      // spin here. Ten pages is 500 trades, well past any real burst, and the
      // next tick resumes whatever is left.
      for (let page = 0; page < 10; page += 1) {
        if (!(await fetchPage())) return;
      }
    } finally {
      inFlight.current = false;
    }
  }, [fetchPage]);

  useEffect(() => {
    const timer = setInterval(poll, POLL_MS);
    return () => clearInterval(timer);
  }, [poll]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, []);

  return (
    /*
      A section of a panel, not a panel. The home page wraps this and the
      leaderboard in one card divided by a hairline; giving the feed its own
      border and padding cost a padding pair, a border pair and a gap that the
      900px budget does not have.
    */
    <section className="panel-section">
      <div className="panel-head">
        <span className="live">
          <span className="live-dot" aria-hidden="true" />
          <h1 className="headline">En vivo</h1>
        </span>
        <span className="label">Últimas operaciones</span>
      </div>

      <ul className="feed-list">
        {trades.map((trade) => (
          <FeedRow
            key={trade.id}
            trade={trade}
            now={now}
            isNew={arriving.has(trade.id)}
          />
        ))}
        {trades.length === 0 && (
          <li className="feed-empty">Todavía no hay operaciones registradas.</li>
        )}
      </ul>
    </section>
  );
}

/**
 * DESIGN.md `row-feed`: avatar, name, verb, amount, symbol, price, relative
 * time right-aligned, and sign colour on the verb and the amount only. The row
 * reads as a sentence, so the amount sits inside the prose rather than in a
 * column.
 *
 * Exported only so a test can render it. It takes no props but a
 * `PublicTrade`, holds no state and reads no context, which is what lets
 * `renderToStaticMarkup` prove DESIGN.md's `state-unpriced` rule directly
 * instead of a test asserting against the source text of this file.
 */
export function FeedRow({
  trade,
  now,
  isNew,
}: {
  trade: PublicTrade;
  now: number;
  isNew: boolean;
}) {
  const direction = trade.side === "buy" ? "gain" : "loss";
  const verb = trade.side === "buy" ? "compró" : "vendió";
  const age = formatRelative(trade.blockTime, now);

  return (
    <li className={`row-feed${isNew ? " is-new" : ""}`}>
      <Avatar name={trade.kol.name} />

      <span className="row-sentence">
        <span className="kol-name">{trade.kol.name}</span>{" "}
        {/* The space lives inside the branch: a KOL with no cabal must not
            leave a double space in the middle of the sentence. */}
        {trade.kol.cabalTag && (
          <>
            <span className="chip-cabal">{trade.kol.cabalTag}</span>{" "}
          </>
        )}
        <span className={direction}>{verb}</span>{" "}
        <span className={`num ${direction}`}>{formatSol(trade.solAmount)} SOL</span>{" "}
        <span className="num quantity">({formatTokenAmount(trade.tokenAmount)})</span> de{" "}
        <span className="symbol">
          {trade.symbol ? `$${trade.symbol}` : "un token sin símbolo"}
        </span>{" "}
        {trade.priceUsd === null ? (
          // DESIGN.md `state-unpriced`: never a dash, never a red −100 %.
          <span className="state-unpriced">sin precio</span>
        ) : (
          <span className="num price">a {formatUsdPrice(trade.priceUsd)}</span>
        )}
      </span>

      {/*
        Spec §7: this label is the only thing that appears where an address
        otherwise would. It is not a claim of anonymity — the amount, the mint
        and the timestamp still find the transaction in any explorer — only a
        statement that we do not publish the address.

        It is driven by `kol.hideWallets`, not by the absence of a signature.
        Those differ when a stored signature will not decrypt: the row loses
        its explorer link either way, but a KOL that publishes its wallets
        must not be labelled as hiding them because of a key rotation.
      */}
      {trade.kol.hideWallets && <span className="chip-hidden-wallets">Wallets ocultas</span>}

      {trade.signature === null ? (
        <time className="num row-age" dateTime={trade.blockTime} suppressHydrationWarning>
          {age}
        </time>
      ) : (
        <a
          className="num row-age"
          href={`https://solscan.io/tx/${trade.signature}`}
          target="_blank"
          rel="noreferrer noopener"
        >
          <time dateTime={trade.blockTime} suppressHydrationWarning>
            {age}
          </time>
        </a>
      )}
    </li>
  );
}

/**
 * Spec §7: the avatar is keyed by `kol_id`. kolscan.io serves
 * `cdn.kolscan.io/profiles/<wallet>.png` and leaks the address in an image URL
 * that no API response ever mentions; `PublicTrade.avatarUrl` cannot, because
 * the id is all it has.
 *
 * What renders today is the monogram, not that URL. The proxy behind
 * `/api/avatar/<kol_id>` is a later task, and an `<img>` pointed at it now
 * would fire fifty 404s per page load and show fifty broken-image glyphs: an
 * `onError` fallback does not help, because the request fails before React has
 * hydrated and attached the handler. The monogram is the same 22px circle the
 * image will occupy, so nothing moves when the image arrives.
 */
function Avatar({ name }: { name: string }) {
  return (
    <span className="avatar" aria-hidden="true">
      {name.trim().slice(0, 1).toUpperCase() || "?"}
    </span>
  );
}
