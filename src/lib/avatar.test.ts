/**
 * Every branch of the avatar, with **no network anywhere**.
 *
 * `fetchImpl` is injected in every case. `vitest.env.ts` replaces the global
 * `fetch` with one that throws naming the host, so a case that forgot to inject
 * would fail loudly rather than quietly reaching unavatar on every `vitest run`
 * — which is the exact failure that put the network guard in this repo. The
 * cases that must not fetch at all assert the stub was never called, which is
 * the only way to tell "did not reach the network" from "reached it and the
 * guard caught it".
 *
 * The property under all of this is one sentence: **a KOL with no handle, an
 * upstream 404 and an upstream timeout all resolve to the same deterministic
 * local monogram.** It is asserted as byte equality between the three, not as
 * three separate "looks about right" checks.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readAvatar } from "./avatar";
import { query } from "./db";
import { monogramSvg } from "./monogram";

const HANDLE = "ejemplo_brujularota";
const NAME = "Brújula Rota";

/**
 * `kol.x_handle` is unique, so cases that insert several KOLs get a distinct
 * handle each. The cases that assert what the upstream URL says pass {@link
 * HANDLE} explicitly, because there the handle is the thing under test.
 */
let handleCounter = 0;

beforeEach(async () => {
  await query("TRUNCATE kol, kol_wallet, cabal CASCADE");
});

async function insertKol(options: {
  name?: string;
  handle?: string;
  status?: string;
  override?: string | null;
} = {}): Promise<string> {
  const id = crypto.randomUUID();
  await query(
    `INSERT INTO kol (id, slug, display_name, x_handle, avatar_override_url, status, approved_at)
     VALUES ($1, $2, $3, $4, $5, $6, now())`,
    [
      id,
      `preview-${id.slice(0, 8)}`,
      options.name ?? NAME,
      options.handle ?? `${HANDLE}_${(handleCounter += 1)}`,
      options.override ?? null,
      options.status ?? "approved",
    ],
  );
  return id;
}

/** A stub `fetch` that answers with `response` and records what it was asked. */
function stub(response: Response | Error) {
  return vi.fn(async (input: RequestInfo | URL) => {
    void input;
    if (response instanceof Error) throw response;
    return response.clone();
  }) as unknown as typeof fetch & { mock: { calls: unknown[][] } };
}

function image(bytes = new Uint8Array([1, 2, 3, 4]), contentType = "image/png", status = 200) {
  return new Response(bytes, { status, headers: { "content-type": contentType } });
}

const never = () =>
  vi.fn(async () => {
    throw new Error("the avatar reached the network when it should not have");
  }) as unknown as typeof fetch & { mock: { calls: unknown[][] } };

describe("readAvatar answers nothing for anything that is not a public KOL", () => {
  it("rejects an id that is not a UUID, without touching Postgres", async () => {
    // `SELECT ... WHERE id = 'x'` would raise 22P02, which is a 500 dressed up
    // as a database error for what is plainly a bad request.
    expect(await readAvatar("../../etc/passwd", never())).toBeNull();
    expect(await readAvatar("1; DROP TABLE kol", never())).toBeNull();
  });

  it("answers null for a UUID no KOL has", async () => {
    expect(await readAvatar(crypto.randomUUID(), never())).toBeNull();
  });

  it("answers null for a suspended KOL, and for one still pending", async () => {
    // Spec §9: a suspended KOL disappears from every public surface, and an
    // avatar endpoint still serving their picture would be one that did not.
    for (const status of ["suspended", "pending", "rejected"]) {
      expect(await readAvatar(await insertKol({ status }), never()), status).toBeNull();
    }
  });
});

describe("readAvatar derives from the X handle, and never from anything else", () => {
  it("asks unavatar for the handle, with no fallback silhouette", async () => {
    const fetchImpl = stub(image());
    const kolId = await readAvatar(await insertKol({ handle: HANDLE }), fetchImpl);

    expect(kolId).not.toBeNull();
    expect(fetchImpl.mock.calls).toHaveLength(1);
    expect(String(fetchImpl.mock.calls[0][0])).toBe(
      `https://unavatar.io/x/${HANDLE}?fallback=false`,
    );
  });

  it("relays the upstream bytes and its content type", async () => {
    const bytes = new Uint8Array([137, 80, 78, 71]);
    const avatar = await readAvatar(await insertKol(), stub(image(bytes, "image/webp")));

    expect(avatar?.source).toBe("unavatar");
    expect(avatar?.contentType).toBe("image/webp");
    expect(new Uint8Array(avatar?.body as Uint8Array)).toEqual(bytes);
  });

  it("sends the third party a handle and nothing else -- no id, no address", async () => {
    // Spec §8.5: unavatar.io is queried by X handle, and no third party is ever
    // given both halves of the wallet/persona link.
    const fetchImpl = stub(image());
    const id = await insertKol({ handle: HANDLE });
    await readAvatar(id, fetchImpl);

    const url = String(fetchImpl.mock.calls[0][0]);
    expect(url).toContain(HANDLE);
    expect(url).not.toContain(id);
  });

  it("prefers avatar_override_url when the admin has set one", async () => {
    // Spec §6.3's escape hatch, and the reader this column was written for: it
    // had none at all before this route existed.
    const fetchImpl = stub(image());
    const avatar = await readAvatar(
      await insertKol({ override: "https://assets.example.test/a.png" }),
      fetchImpl,
    );

    expect(avatar?.source).toBe("override");
    expect(String(fetchImpl.mock.calls[0][0])).toBe("https://assets.example.test/a.png");
  });

  it("ignores an override that is not https, and falls back to the handle", async () => {
    for (const override of ["http://plain.example.test/a.png", "file:///etc/passwd", "not a url"]) {
      const fetchImpl = stub(image());
      const avatar = await readAvatar(await insertKol({ override }), fetchImpl);

      expect(avatar?.source, override).toBe("unavatar");
      expect(String(fetchImpl.mock.calls[0][0])).toContain("unavatar.io");
    }
  });
});

describe("every failure resolves to the same deterministic monogram", () => {
  const expected = monogramSvg(NAME);

  it("draws the letter, and makes no request at all, when the KOL has no handle", async () => {
    const fetchImpl = never();
    const avatar = await readAvatar(await insertKol({ handle: "   " }), fetchImpl);

    expect(avatar?.source).toBe("monogram");
    expect(avatar?.body).toBe(expected);
    expect(fetchImpl.mock.calls).toHaveLength(0);
  });

  it("draws the same letter for a 404, a timeout and an unusable body", async () => {
    const failures: Record<string, Response | Error> = {
      "upstream 404": new Response("", { status: 404 }),
      "upstream 500": new Response("", { status: 500 }),
      "timeout / connection reset": new Error("The operation was aborted due to timeout"),
      "an HTML error page": new Response("<html>", { headers: { "content-type": "text/html" } }),
      // Relaying a third party's SVG under our own origin is a stored-XSS
      // primitive the moment anything renders it outside an <img>.
      "an SVG": image(new Uint8Array([60, 115]), "image/svg+xml"),
      "no content type at all": new Response(new Uint8Array([1, 2])),
      "an empty body": image(new Uint8Array(), "image/png"),
      "a body past the ceiling": image(new Uint8Array(512 * 1024 + 1), "image/png"),
    };

    for (const [label, response] of Object.entries(failures)) {
      const avatar = await readAvatar(await insertKol(), stub(response));
      expect(avatar?.source, label).toBe("monogram");
      expect(avatar?.contentType, label).toBe("image/svg+xml; charset=utf-8");
      // Byte equality, across every branch: this is the "same deterministic
      // local fallback" property, stated once.
      expect(avatar?.body, label).toBe(expected);
    }
  });

  it("refuses a body whose declared length is past the ceiling before reading it", async () => {
    const response = new Response(new Uint8Array([1, 2, 3]), {
      headers: { "content-type": "image/png", "content-length": String(512 * 1024 + 1) },
    });
    const avatar = await readAvatar(await insertKol(), stub(response));
    expect(avatar?.source).toBe("monogram");
  });

  it("draws the letter of the display name, not of the handle", async () => {
    const avatar = await readAvatar(
      await insertKol({ name: "Zorro Gris", handle: "ejemplo_algootro" }),
      stub(new Response("", { status: 404 })),
    );
    expect(avatar?.body).toBe(monogramSvg("Zorro Gris"));
    expect(avatar?.body).toContain(">Z</text>");
  });
});
