import { describe, expect, it } from "vitest";
import { parseStatusUrl, tweetText, verifyTweet } from "./tweet";

/**
 * `docs/padron.md` §5, cases 9-11, written before this module existed.
 *
 * The shape of the real oEmbed body is copied from a live call recorded in the
 * round (`jack/status/20`, 2026-09-01) rather than invented, so the parsing
 * below is parsing what X actually sends.
 */
const CODE = "KH-7F3Q2A";

function oembed(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    url: "https://x.com/ejemplo/status/1234567890",
    author_name: "Ejemplo Trader",
    author_url: "https://x.com/ejemplo",
    html:
      `<blockquote class="twitter-tweet"><p lang="es" dir="ltr">Verifico mi cuenta en ` +
      `kolscanhispano.fun ${CODE}</p>&mdash; Ejemplo Trader (@ejemplo) ` +
      `<a href="https://x.com/ejemplo/status/1234567890">September 1, 2026</a></blockquote>`,
    provider_name: "X",
    ...over,
  });
}

function answering(body: string, status = 200): typeof fetch {
  return (async () => new Response(body, { status })) as unknown as typeof fetch;
}

const URL_OK = "https://x.com/ejemplo/status/1234567890";

describe("parseStatusUrl", () => {
  it("accepts a status link on either domain, with or without www or a query", () => {
    for (const url of [
      "https://x.com/ejemplo/status/123",
      "http://x.com/ejemplo/status/123",
      "https://www.twitter.com/ejemplo/status/123",
      "https://twitter.com/ejemplo/statuses/123",
      "https://x.com/ejemplo/status/123?s=20&t=abc",
      "https://x.com/ejemplo/status/123/photo/1",
    ]) {
      expect(parseStatusUrl(url), url).toEqual({ handle: "ejemplo", id: "123" });
    }
  });

  it("refuses anything that is not a status link", () => {
    for (const url of [
      "https://x.com/ejemplo",
      "https://example.com/ejemplo/status/123",
      "https://x.com.evil.test/ejemplo/status/123",
      "not a url",
      "",
    ]) {
      expect(parseStatusUrl(url), url).toBeNull();
    }
  });
});

describe("tweetText", () => {
  it("gets the code out of the blockquote X actually sends", () => {
    expect(tweetText(JSON.parse(oembed()).html)).toContain(CODE);
  });

  it("decodes the entities that could hide a code", () => {
    expect(tweetText("<p>a&amp;b &lt;c&gt;</p>")).toBe("a&b <c>");
  });
});

describe("verifyTweet", () => {
  it("accepts a tweet by the right account carrying the code", async () => {
    const result = await verifyTweet({
      url: URL_OK,
      expectedHandle: "ejemplo",
      code: CODE,
      fetchImpl: answering(oembed()),
    });
    expect(result).toEqual({ ok: true, handle: "ejemplo", tweetUrl: URL_OK });
  });

  it("accepts the handle in another casing, on either side", async () => {
    const result = await verifyTweet({
      url: "https://x.com/Ejemplo/status/1234567890",
      expectedHandle: "ejemplo",
      code: CODE,
      fetchImpl: answering(oembed({ author_url: "https://x.com/EJEMPLO" })),
    });
    expect(result.ok).toBe(true);
  });

  /**
   * Case 9, the cheap half: the link is plainly somebody else's, so the path
   * refuses it before a request is spent.
   *
   * **This case does not prove the oEmbed comparison**, and an earlier draft of
   * this file claimed it did. Mutating the module to compare `author_name`
   * left it green, because it never reaches that code. The case that proves it
   * is 9b, and the round's mutation line was corrected to name that one.
   */
  it("9. refuses a link whose path is not the claimed handle, before fetching", async () => {
    const result = await verifyTweet({
      url: "https://x.com/impostor/status/1234567890",
      expectedHandle: "ejemplo",
      code: CODE,
      fetchImpl: answering(
        oembed({ author_name: "ejemplo", author_url: "https://x.com/impostor" }),
      ),
    });
    expect(result).toEqual({ ok: false, reason: "wrong_author" });
  });

  it("9b. refuses when the path says one account and X says another", async () => {
    // **The case the module exists for.** A path is whatever the caller typed:
    // an impostor submits `x.com/<target>/status/<their own tweet id>` and the
    // path check waves it through. `author_url` is X's answer about who wrote
    // it, and it is what decides. `author_name` here is the target's, which is
    // what a check comparing display names would have accepted.
    const result = await verifyTweet({
      url: URL_OK,
      expectedHandle: "ejemplo",
      code: CODE,
      fetchImpl: answering(
        oembed({ author_name: "ejemplo", author_url: "https://x.com/otracuenta" }),
      ),
    });
    expect(result).toEqual({ ok: false, reason: "wrong_author" });
  });

  it("10. refuses a tweet that does not contain the code", async () => {
    const result = await verifyTweet({
      url: URL_OK,
      expectedHandle: "ejemplo",
      code: "KH-OTHER11",
      fetchImpl: answering(oembed()),
    });
    expect(result).toEqual({ ok: false, reason: "code_missing" });
  });

  /**
   * Case 11: every way the check can fail to happen is a refusal. The bug this
   * guards is the one the round names -- an unreachable oEmbed read as "fine".
   */
  it("11. refuses on 404, on any non-OK status, and on a network failure", async () => {
    expect(
      await verifyTweet({
        url: URL_OK, expectedHandle: "ejemplo", code: CODE,
        fetchImpl: answering("", 404),
      }),
    ).toEqual({ ok: false, reason: "not_found" });

    for (const status of [401, 429, 500, 503]) {
      expect(
        await verifyTweet({
          url: URL_OK, expectedHandle: "ejemplo", code: CODE,
          fetchImpl: answering("", status),
        }),
        `status ${status}`,
      ).toEqual({ ok: false, reason: "unreachable" });
    }

    const throwing = (async () => {
      throw new Error(`connect ECONNREFUSED for ${URL_OK}`);
    }) as unknown as typeof fetch;
    expect(
      await verifyTweet({ url: URL_OK, expectedHandle: "ejemplo", code: CODE, fetchImpl: throwing }),
    ).toEqual({ ok: false, reason: "unreachable" });
  });

  it("11b. refuses a body that is not the shape oEmbed returns", async () => {
    for (const body of ["not json", "{}", JSON.stringify({ author_url: 5, html: "x" })]) {
      expect(
        await verifyTweet({
          url: URL_OK, expectedHandle: "ejemplo", code: CODE, fetchImpl: answering(body),
        }),
        body,
      ).toEqual({ ok: false, reason: "unreachable" });
    }
  });

  it("refuses a URL that is not a status link, without spending a request", async () => {
    const never = (async () => {
      throw new Error("fetch should not have been called");
    }) as unknown as typeof fetch;
    expect(
      await verifyTweet({
        url: "https://x.com/ejemplo", expectedHandle: "ejemplo", code: CODE, fetchImpl: never,
      }),
    ).toEqual({ ok: false, reason: "bad_url" });
  });

  it("never carries the URL or the code into what it returns", async () => {
    const results = [
      await verifyTweet({ url: "nope", expectedHandle: "ejemplo", code: CODE,
                          fetchImpl: answering(oembed()) }),
      await verifyTweet({ url: URL_OK, expectedHandle: "otro", code: CODE,
                          fetchImpl: answering(oembed()) }),
      await verifyTweet({ url: URL_OK, expectedHandle: "ejemplo", code: "NOPE",
                          fetchImpl: answering(oembed()) }),
    ];
    for (const result of results) {
      expect(result.ok).toBe(false);
      expect(JSON.stringify(result)).not.toContain(CODE);
    }
  });
});
