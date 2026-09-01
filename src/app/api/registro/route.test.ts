import bs58 from "bs58";
import { ed25519 } from "@noble/curves/ed25519.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { query } from "@/lib/db";
import { readFeedPage } from "@/lib/feed";
import { readKolDetail } from "@/lib/kol";
import { readLeaderboard } from "@/lib/leaderboard";
import { PROOF_DOMAIN, proofMessage } from "@/lib/wallet-proof";
import { POST as approve } from "@/app/api/admin/kol/[id]/approve/route";
import { POST as nonce } from "./nonce/route";
import { POST as submit } from "./route";
import { POST as tweet } from "./tweet/route";

/**
 * `docs/padron.md` §5, cases 8 and 12-14, over HTTP.
 *
 * The signature cases themselves are exhausted in `wallet-proof.test.ts`; what
 * this file adds is that the route reaches that verifier at all, burns the
 * nonce, and leaves a KOL nobody can see.
 */

const TOKEN = "admin-token-for-tests";
let previousToken: string | undefined;

function wallet() {
  const secret = ed25519.utils.randomSecretKey();
  const address = bs58.encode(ed25519.getPublicKey(secret));
  return {
    address,
    sign: (message: string) =>
      bs58.encode(ed25519.sign(new TextEncoder().encode(message), secret)),
  };
}

function post(url: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "198.51.100.4", ...headers },
    body: JSON.stringify(body),
  });
}

/** Issues a nonce and signs the message the server will rebuild. */
async function proven(signer: ReturnType<typeof wallet>, isPublic = false) {
  const response = await nonce(
    post("https://kolscanhispano.fun/api/registro/nonce", {
      address: signer.address,
      chain: "solana",
      action: "alta de perfil",
    }),
  );
  expect(response.status).toBe(201);
  const issued = (await response.json()) as { nonce: string; expiresAt: string };

  const fields = {
    domain: PROOF_DOMAIN,
    address: signer.address,
    chain: "solana" as const,
    action: "alta de perfil" as const,
    nonce: issued.nonce,
    expiresAt: issued.expiresAt,
  };
  return {
    address: signer.address,
    chain: "solana",
    isPublic,
    nonce: issued.nonce,
    expiresAt: issued.expiresAt,
    signature: signer.sign(proofMessage(fields)),
  };
}

beforeEach(async () => {
  previousToken = process.env.ADMIN_TOKEN;
  process.env.ADMIN_TOKEN = TOKEN;
  await query(
    "TRUNCATE kol, kol_wallet, wallet_proof_nonce, rate_limit, audit_log, trade, position CASCADE",
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (previousToken === undefined) delete process.env.ADMIN_TOKEN;
  else process.env.ADMIN_TOKEN = previousToken;
});

describe("12. what a registration leaves", () => {
  it("creates a pending KOL and returns a code, once", async () => {
    const signer = wallet();
    const response = await submit(
      post("https://kolscanhispano.fun/api/registro", {
        handle: "@ejemplo",
        wallets: [await proven(signer)],
      }),
    );
    expect(response.status).toBe(201);
    const body = (await response.json()) as { kolId: string; status: string; verificationCode: string };
    expect(body.status).toBe("pending");
    expect(body.verificationCode).toMatch(/^KH-[0-9A-HJKMNP-TV-Z]{8}$/);

    const [kol] = await query<{ status: string; approved_at: Date | null }>(
      "SELECT status, approved_at FROM kol WHERE id = $1", [body.kolId]);
    expect(kol.status).toBe("pending");
    // Not approved, so not stamped: an `approved_at` on a pending row would be
    // the kind of half-truth an admin queue is read from.
    expect(kol.approved_at).toBeNull();
  });

  it("is on no public surface until an admin approves", async () => {
    const signer = wallet();
    const created = await submit(
      post("https://kolscanhispano.fun/api/registro", {
        handle: "invisible",
        wallets: [await proven(signer, true)],
      }),
    );
    const { kolId } = (await created.json()) as { kolId: string };

    // A *published* wallet, on purpose: publication is per wallet now, so a
    // surface consulting only `is_public` would carry this KOL. Only the status
    // gate can stop it.
    const [board, detail, feed] = await Promise.all([
      readLeaderboard({ window: "diario", unit: "sol" }),
      readKolDetail({ slug: "invisible", window: "diario" }),
      readFeedPage(),
    ]);
    expect(board.entries).toHaveLength(0);
    expect(detail).toBeNull();
    expect(feed.trades).toHaveLength(0);

    // ...and appears the moment they are approved.
    const approved = await approve(
      post(`https://kolscanhispano.fun/api/admin/kol/${kolId}/approve`, {}, {
        authorization: `Bearer ${TOKEN}`,
      }),
      { params: Promise.resolve({ id: kolId }) },
    );
    expect(approved.status).toBe(200);
    const after = await readLeaderboard({ window: "diario", unit: "sol" });
    expect(after.entries.map((e) => e.kol.slug)).toEqual(["invisible"]);
  });

  it("refuses to approve a KOL that is not pending, and says nothing else", async () => {
    const signer = wallet();
    const created = await submit(
      post("https://kolscanhispano.fun/api/registro", {
        handle: "ejemplo", wallets: [await proven(signer)],
      }),
    );
    const { kolId } = (await created.json()) as { kolId: string };
    const call = () =>
      approve(
        post(`https://kolscanhispano.fun/api/admin/kol/${kolId}/approve`, {}, {
          authorization: `Bearer ${TOKEN}`,
        }),
        { params: Promise.resolve({ id: kolId }) },
      );

    expect((await call()).status).toBe(200);
    // Twice is not two approvals.
    const second = await call();
    expect(second.status).toBe(404);
    expect(await second.json()).toEqual({ error: "not_pending" });
  });
});

describe("8. the proof, over HTTP", () => {
  it("refuses a nonce that was already spent", async () => {
    const signer = wallet();
    const proof = await proven(signer);
    expect(
      (await submit(post("https://kolscanhispano.fun/api/registro", {
        handle: "primero", wallets: [proof],
      }))).status,
    ).toBe(201);

    // The same proof again, under a different handle: the signature is valid
    // and the nonce is gone, which is the whole point of issuing it here.
    const replay = await submit(
      post("https://kolscanhispano.fun/api/registro", { handle: "segundo", wallets: [proof] }),
    );
    expect(await replay.json()).toEqual({ error: "nonce_nonce_used" });
    expect(await query("SELECT id FROM kol WHERE slug = 'segundo'")).toHaveLength(0);
  });

  it("refuses another wallet's signature over the same message", async () => {
    const owner = wallet();
    const impostor = wallet();
    const proof = await proven(owner);
    const response = await submit(
      post("https://kolscanhispano.fun/api/registro", {
        handle: "ejemplo",
        wallets: [{ ...proof, signature: impostor.sign("whatever") }],
      }),
    );
    expect(await response.json()).toEqual({ error: "proof_address_mismatch" });
  });

  it("refuses a nonce that was never issued, without creating anything", async () => {
    const signer = wallet();
    const proof = await proven(signer);
    const response = await submit(
      post("https://kolscanhispano.fun/api/registro", {
        handle: "ejemplo",
        wallets: [{ ...proof, nonce: "f".repeat(32) }],
      }),
    );
    // The signature is over the *issued* nonce, so changing it here breaks the
    // signature first -- which is the order that costs an attacker the most.
    expect((await response.json()).error).toMatch(/^proof_/);
    expect(await query("SELECT id FROM kol")).toHaveLength(0);
  });

  it("burns no nonce when the submit is refused for another reason", async () => {
    const signer = wallet();
    const proof = await proven(signer);
    await submit(
      post("https://kolscanhispano.fun/api/registro", { handle: "no válido!", wallets: [proof] }),
    );
    const [row] = await query<{ used_at: Date | null }>("SELECT used_at FROM wallet_proof_nonce");
    expect(row.used_at).toBeNull();
  });
});

describe("the tweet, over HTTP", () => {
  async function register(handle: string) {
    const signer = wallet();
    const response = await submit(
      post("https://kolscanhispano.fun/api/registro", {
        handle, wallets: [await proven(signer)],
      }),
    );
    return (await response.json()) as { kolId: string; verificationCode: string };
  }

  function stubOembed(body: unknown, status = 200) {
    vi.stubGlobal("fetch", async () =>
      new Response(typeof body === "string" ? body : JSON.stringify(body), { status }));
  }

  it("verifies a tweet by the right account and does not approve anybody", async () => {
    const { kolId, verificationCode } = await register("ejemplo");
    stubOembed({
      author_url: "https://x.com/ejemplo",
      html: `<blockquote><p>hola ${verificationCode}</p></blockquote>`,
    });

    const response = await tweet(
      post("https://kolscanhispano.fun/api/registro/tweet", {
        kolId, url: "https://x.com/ejemplo/status/123",
      }),
    );
    expect(response.status).toBe(200);
    expect((await response.json()).tweetVerified).toBe(true);

    const [kol] = await query<{ status: string; tweet_verified_at: Date | null; tweet_url: string }>(
      "SELECT status, tweet_verified_at, tweet_url FROM kol WHERE id = $1", [kolId]);
    // Verified is not approved: DECISIONES.md keeps the gate with a person.
    expect(kol.status).toBe("pending");
    expect(kol.tweet_verified_at).not.toBeNull();
    expect(kol.tweet_url).toBe("https://x.com/ejemplo/status/123");
    expect((await readLeaderboard({ window: "diario", unit: "sol" })).entries).toHaveLength(0);
  });

  it("refuses a tweet by another account, and marks nothing", async () => {
    const { kolId, verificationCode } = await register("ejemplo");
    stubOembed({
      author_url: "https://x.com/otracuenta",
      html: `<blockquote><p>hola ${verificationCode}</p></blockquote>`,
    });
    const response = await tweet(
      post("https://kolscanhispano.fun/api/registro/tweet", {
        kolId, url: "https://x.com/ejemplo/status/123",
      }),
    );
    expect(await response.json()).toEqual({ error: "wrong_author" });
    const [kol] = await query<{ tweet_verified_at: Date | null }>(
      "SELECT tweet_verified_at FROM kol WHERE id = $1", [kolId]);
    expect(kol.tweet_verified_at).toBeNull();
  });

  it("refuses when oEmbed cannot be reached, rather than passing", async () => {
    const { kolId } = await register("ejemplo");
    stubOembed("", 503);
    const response = await tweet(
      post("https://kolscanhispano.fun/api/registro/tweet", {
        kolId, url: "https://x.com/ejemplo/status/123",
      }),
    );
    expect(await response.json()).toEqual({ error: "unreachable" });
  });

  it("answers the same for an unknown KOL and an approved one", async () => {
    // Telling them apart would enumerate the pending queue.
    const { kolId } = await register("ejemplo");
    await approve(
      post(`https://kolscanhispano.fun/api/admin/kol/${kolId}/approve`, {}, {
        authorization: `Bearer ${TOKEN}`,
      }),
      { params: Promise.resolve({ id: kolId }) },
    );

    for (const id of [kolId, crypto.randomUUID()]) {
      const response = await tweet(
        post("https://kolscanhispano.fun/api/registro/tweet", {
          id, kolId: id, url: "https://x.com/ejemplo/status/123",
        }),
      );
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "not_pending" });
    }
  });
});

describe("13. what a refusal carries", () => {
  it("never puts an address, a signature or a nonce in a response", async () => {
    const signer = wallet();
    const proof = await proven(signer);
    const responses = [
      await submit(post("https://kolscanhispano.fun/api/registro", { handle: "!", wallets: [proof] })),
      await submit(post("https://kolscanhispano.fun/api/registro", {
        handle: "ejemplo", wallets: [{ ...proof, signature: "0xdead" }],
      })),
      await nonce(post("https://kolscanhispano.fun/api/registro/nonce", {
        address: "not-an-address", chain: "solana",
      })),
    ];
    for (const response of responses) {
      const text = await response.text();
      expect(text).not.toContain(signer.address);
      expect(text).not.toContain(proof.signature);
      expect(text).not.toContain(proof.nonce);
    }
  });
});
