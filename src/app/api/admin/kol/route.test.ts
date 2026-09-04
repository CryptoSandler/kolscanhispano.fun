import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { query } from "@/lib/db";
import { blindIndex } from "@/lib/crypto";
import { inventAddress, inventEvmAddress } from "@/lib/ids";
import { POST } from "./route";

/**
 * `docs/padron.md` §5, cases 1–7, written before this route existed.
 *
 * Every case asserts the **reason**, not merely the status: a route that
 * refuses everything with `400` passes a status-only test while telling the
 * caller nothing, and two of these cases exist specifically to keep two
 * different mistakes from collapsing into one answer.
 */

const TOKEN = "admin-token-for-tests";
let previousToken: string | undefined;

beforeEach(async () => {
  previousToken = process.env.ADMIN_TOKEN;
  process.env.ADMIN_TOKEN = TOKEN;
  await query("TRUNCATE kol, kol_wallet, audit_log CASCADE");
});

afterEach(() => {
  if (previousToken === undefined) delete process.env.ADMIN_TOKEN;
  else process.env.ADMIN_TOKEN = previousToken;
});

/** A standard-B line: the tracker URL where the pair is printed, and the date it was read. */
const PROVENANCE = "Solana Tracker KOL leaderboard https://data.solanatracker.io/v2/pnl/leaderboard/kols, read 2026-09-01";

function request(body: unknown, token: string | null = TOKEN): Request {
  return new Request("https://kolscanhispano.fun/api/admin/kol", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
      "x-forwarded-for": "203.0.113.7",
    },
    body: JSON.stringify(body),
  });
}

const oneWallet = (over: Record<string, unknown> = {}) => ({
  handle: "ejemplo",
  wallets: [{ address: inventAddress(), chain: "solana", ...over }],
});

describe("1. the gate", () => {
  it("refuses with no token, a wrong token, an empty token and the wrong scheme", async () => {
    // The headers are built here rather than through `request`, which prepends
    // `Bearer ` -- the bare-token case has to reach the route *without* it, and
    // an earlier draft of this test passed the raw token through the helper and
    // was therefore asserting that a valid request is refused.
    const headers: (string | null)[] = [
      null,
      "Bearer wrong",
      "Bearer ",
      "",
      TOKEN, // the right secret under no scheme
      `Basic ${TOKEN}`,
      `bearer ${TOKEN}`, // the scheme is compared literally
    ];
    for (const header of headers) {
      const response = await POST(
        new Request("https://kolscanhispano.fun/api/admin/kol", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(header === null ? {} : { authorization: header }),
          },
          body: JSON.stringify(oneWallet()),
        }),
      );
      expect(response.status, `header: ${header === null ? "(none)" : header}`).toBe(401);
      expect(await response.json()).toEqual({ error: "unauthorized" });
    }
    expect(await query("SELECT id FROM kol")).toHaveLength(0);
  });

  it("refuses when ADMIN_TOKEN is not configured, rather than allowing", async () => {
    // The failure mode this is here for: "no token configured, so this must be
    // a dev machine, so allow" ships an open admin route on exactly the
    // deployment where somebody forgot to set the variable.
    delete process.env.ADMIN_TOKEN;
    const response = await POST(request(oneWallet(), "anything"));
    expect(response.status).toBe(401);
  });

  it("does not read the body of an unauthenticated request", async () => {
    // A body that would fail JSON parsing. If the parser ran first, this would
    // answer `bad_json` and the parser would be anonymous surface.
    const bad = new Request("https://kolscanhispano.fun/api/admin/kol", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    const response = await POST(bad);
    expect(response.status).toBe(401);
  });
});

describe("2-6. what a wallet has to be", () => {
  it("2. refuses an address of the wrong shape for its chain", async () => {
    const response = await POST(request(oneWallet({ address: inventEvmAddress() })));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "bad_address" });
  });

  it("3. refuses a chain with no live ingestion, and says which are live", async () => {
    const response = await POST(
      request({ handle: "ejemplo", wallets: [{ address: inventEvmAddress(), chain: "bnb" }] }),
    );
    expect(response.status).toBe(400);
    // The list is the environment's, so it grew when Robinhood was switched on
    // for `/registro` (2026-09-04). `bnb` is still off, which is what this case
    // is about: the refusal names what *is* live rather than only saying no.
    expect(await response.json()).toEqual({
      error: "chain_not_active",
      active: ["solana", "robinhood"],
    });
  });

  it("3b. tells an unknown chain apart from an inactive one", async () => {
    // Different mistakes: "you typed it wrong" and "we do not index that yet".
    const response = await POST(
      request({ handle: "ejemplo", wallets: [{ address: inventAddress(), chain: "polygon" }] }),
    );
    expect(await response.json()).toEqual({ error: "bad_chain" });
  });

  it("4. refuses an address already held by another KOL, without naming them", async () => {
    const address = inventAddress();
    expect((await POST(request({ handle: "primero", wallets: [{ address, chain: "solana" }] }))).status)
      .toBe(201);

    const response = await POST(
      request({ handle: "segundo", wallets: [{ address, chain: "solana" }] }),
    );
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body).toEqual({ error: "address_taken" });
    // The holder is not named, in any field: this route must not become a
    // lookup oracle over the roster.
    expect(JSON.stringify(body)).not.toContain("primero");

    // And the refused creation left nothing behind.
    expect(await query("SELECT id FROM kol WHERE slug = 'segundo'")).toHaveLength(0);
  });

  it("5. refuses the same address twice in one request", async () => {
    const address = inventAddress();
    const response = await POST(
      request({
        handle: "ejemplo",
        wallets: [
          { address, chain: "solana" },
          { address, chain: "solana" },
        ],
      }),
    );
    // Its own reason: told "taken" the caller would look for another KOL that
    // does not exist -- they collided with themselves.
    expect(await response.json()).toEqual({ error: "duplicate_in_request" });
  });

  it("6. refuses a handle already taken, in any of its three spellings", async () => {
    expect((await POST(request(oneWallet()))).status).toBe(201);
    for (const handle of ["ejemplo", "@ejemplo", "https://x.com/ejemplo"]) {
      const response = await POST(
        request({ handle, wallets: [{ address: inventAddress(), chain: "solana" }] }),
      );
      expect(await response.json(), handle).toEqual({ error: "handle_taken" });
    }
  });

  it("refuses a KOL with no wallets at all", async () => {
    expect(await (await POST(request({ handle: "ejemplo", wallets: [] }))).json()).toEqual({
      error: "no_wallets",
    });
  });
});

describe("7. what a successful creation leaves", () => {
  /**
   * The other state this route may create, and the one a tracker-sourced roster
   * needs: a candidate staged for review, vouched for by nobody yet.
   *
   * `approved_at` stays NULL, which is the difference that matters — a row that
   * says pending and carries an approval timestamp is a row two readers would
   * describe differently.
   */
  it("creates the KOL pending when asked, and leaves approved_at null", async () => {
    const address = inventAddress();
    const response = await POST(
      request({
        handle: "@Pendiente",
        wallets: [{ address, chain: "solana" }],
        status: "pending",
        provenance: PROVENANCE,
      }),
    );
    expect(response.status).toBe(201);
    const body = (await response.json()) as { kolId: string; status: string };
    expect(body.status).toBe("pending");

    const [kol] = await query<{ status: string; approved_at: Date | null }>(
      "SELECT status, approved_at FROM kol WHERE id = $1", [body.kolId]);
    expect(kol.status).toBe("pending");
    expect(kol.approved_at).toBeNull();
  });

  /**
   * The provenance, on the row and nowhere else.
   *
   * `docs/padron-candidatos.md` §1's standard B: a candidate the owner did not
   * vouch for rests on *"the tracker URL where the pair appears, plus the date
   * it was read"*, and a `pending` row created without it is a person on this
   * roster for reasons nobody can reconstruct. Both halves are asserted — that
   * it is stored, and that its absence is refused — because a requirement whose
   * refusal nobody has seen is a requirement that stops firing.
   */
  it("stores the provenance of a staged candidate in the audit trail", async () => {
    const response = await POST(
      request({
        handle: "@Procedencia",
        wallets: [{ address: inventAddress(), chain: "solana" }],
        status: "pending",
        provenance: PROVENANCE,
      }),
    );
    const { kolId } = (await response.json()) as { kolId: string };

    const [row] = await query<{ after: { provenance: string } }>(
      "SELECT after FROM audit_log WHERE target_id = $1 AND action = 'kol.create'", [kolId]);
    expect(row.after.provenance).toBe(PROVENANCE);
  });

  it("refuses to stage a candidate that does not say where it came from", async () => {
    for (const provenance of [undefined, "", "   ", 7, "x".repeat(201)]) {
      const response = await POST(
        request({
          handle: "@SinFuente",
          wallets: [{ address: inventAddress(), chain: "solana" }],
          status: "pending",
          ...(provenance === undefined ? {} : { provenance }),
        }),
      );
      expect(response.status).toBe(400);
      expect(((await response.json()) as { error: string }).error).toBe("bad_provenance");
    }
    expect(await query("SELECT 1 FROM kol")).toHaveLength(0);
  });

  /**
   * The one thing a free-text field at this boundary must not become. `audit`
   * says `after` is "the easiest place in this system to accidentally persist a
   * wallet in cleartext", and this is the first field that lets a caller write
   * into it — so it is scanned with the same two scanners that decide what an
   * address looks like everywhere else in this repository.
   */
  it("refuses a provenance with an address hidden in it", async () => {
    for (const provenance of [
      `tracker, read 2026-09-01, wallet ${inventAddress()}`,
      `tracker, read 2026-09-01, wallet ${inventEvmAddress()}`,
    ]) {
      const response = await POST(
        request({
          handle: "@ConDireccion",
          wallets: [{ address: inventAddress(), chain: "solana" }],
          status: "pending",
          provenance,
        }),
      );
      expect(response.status).toBe(400);
      expect(((await response.json()) as { error: string }).error).toBe("bad_provenance");
    }
  });

  /**
   * An `approved` create is the admin vouching, and the audit row already names
   * them — so the field is optional there, and absent means absent rather than
   * an empty string somebody has to interpret later.
   */
  it("leaves the provenance out of an approved creation that gave none", async () => {
    const response = await POST(
      request({ handle: "@Avalado", wallets: [{ address: inventAddress(), chain: "solana" }] }),
    );
    const { kolId } = (await response.json()) as { kolId: string };

    const [row] = await query<{ after: Record<string, unknown> }>(
      "SELECT after FROM audit_log WHERE target_id = $1 AND action = 'kol.create'", [kolId]);
    expect(row.after).not.toHaveProperty("provenance");
  });

  it("records the status it actually created in the audit trail, not a constant", async () => {
    const response = await POST(
      request({
        handle: "@Auditado",
        wallets: [{ address: inventAddress(), chain: "solana" }],
        status: "pending",
        provenance: PROVENANCE,
      }),
    );
    const { kolId } = (await response.json()) as { kolId: string };

    const [row] = await query<{ after: { status: string } }>(
      "SELECT after FROM audit_log WHERE target_id = $1 AND action = 'kol.create'", [kolId]);
    expect(row.after.status).toBe("pending");
  });

  /**
   * Absent means approved, which is what the admin screen sends and what this
   * route did before it could do anything else. The default is asserted so a
   * later refactor cannot quietly flip it and stage everyone the admin vouched
   * for.
   */
  it("still creates approved when no status is sent", async () => {
    const response = await POST(
      request({ handle: "@PorDefecto", wallets: [{ address: inventAddress(), chain: "solana" }] }),
    );
    const { kolId, status } = (await response.json()) as { kolId: string; status: string };
    expect(status).toBe("approved");

    const [kol] = await query<{ status: string }>("SELECT status FROM kol WHERE id = $1", [kolId]);
    expect(kol.status).toBe("approved");
  });

  /**
   * Refused rather than coerced. A typo that silently became `approved` would
   * publish somebody the caller meant to stage, which is the one direction this
   * mistake must not fail in.
   */
  it("refuses a status that is neither, and writes nothing", async () => {
    for (const status of ["rejected", "suspended", "APPROVED", "", 1, null]) {
      const response = await POST(
        request({ handle: "@Malo", wallets: [{ address: inventAddress(), chain: "solana" }], status }),
      );
      expect(response.status, `status ${JSON.stringify(status)}`).toBe(400);
      expect(((await response.json()) as { error: string }).error).toBe("bad_status");
    }
    const [{ n }] = await query<{ n: number }>(
      "SELECT count(*)::int AS n FROM kol WHERE x_handle = 'Malo'");
    expect(n).toBe(0);
  });

  it("creates the KOL approved, with its wallets private by default", async () => {
    const address = inventAddress();
    const response = await POST(
      request({ handle: "@Ejemplo", displayName: "Ejemplo", wallets: [{ address, chain: "solana" }] }),
    );
    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      kolId: string;
      handle: string;
      wallets: { chain: string; isPublic: boolean }[];
    };
    expect(body.handle).toBe("Ejemplo");
    expect(body.wallets).toEqual([{ id: expect.any(String), chain: "solana", isPublic: false }]);

    const [kol] = await query<{ status: string; approved_at: Date | null; x_handle: string }>(
      "SELECT status, approved_at, x_handle FROM kol WHERE id = $1", [body.kolId]);
    expect(kol.status).toBe("approved");
    // Approved directly, so `approved_at` is set rather than left NULL on a row
    // that claims to be approved.
    expect(kol.approved_at).not.toBeNull();

    // The wallet is stored the way the spec demands: encrypted, and findable
    // only through the blind index.
    const [wallet] = await query<{ address_enc: Buffer; address_hmac: Buffer; is_public: boolean }>(
      "SELECT address_enc, address_hmac, is_public FROM kol_wallet WHERE kol_id = $1", [body.kolId]);
    expect(wallet.is_public).toBe(false);
    expect(wallet.address_hmac).toEqual(blindIndex(address, "address"));
    // Never in cleartext, in either column.
    expect(wallet.address_enc.toString("utf8")).not.toContain(address);
    expect(wallet.address_hmac.toString("utf8")).not.toContain(address);
  });

  it("publishes a wallet when the caller asks, and only then", async () => {
    const response = await POST(
      request({
        handle: "ejemplo",
        wallets: [
          { address: inventAddress(), chain: "solana", isPublic: true },
          { address: inventAddress(), chain: "solana" },
        ],
      }),
    );
    expect(response.status).toBe(201);
    const rows = await query<{ is_public: boolean }>(
      "SELECT is_public FROM kol_wallet ORDER BY is_public DESC");
    expect(rows.map((r) => r.is_public)).toEqual([true, false]);
  });

  it("writes exactly one audit row, and no address reaches it", async () => {
    const address = inventAddress();
    const response = await POST(
      request({ handle: "ejemplo", wallets: [{ address, chain: "solana" }] }));
    const { kolId } = (await response.json()) as { kolId: string };

    const rows = await query<{
      actor: string; action: string; target_id: string; after: unknown; ip_hash: Buffer | null;
    }>("SELECT actor, action, target_id, after, ip_hash FROM audit_log");
    expect(rows).toHaveLength(1);
    expect(rows[0].actor).toBe("admin");
    expect(rows[0].action).toBe("kol.create");
    expect(rows[0].target_id).toBe(kolId);
    // `after` is JSONB and is the easiest place in this system to persist an
    // address by accident -- one careless spread of the request body does it.
    expect(JSON.stringify(rows[0].after)).not.toContain(address);
    // The IP is hashed, never stored: spec §8 makes it personal data.
    expect(rows[0].ip_hash).not.toBeNull();
    expect(rows[0].ip_hash!.toString("utf8")).not.toContain("203.0.113.7");
  });

  it("writes no audit row for a refused creation", async () => {
    await POST(request({ handle: "ejemplo", wallets: [{ address: "nope", chain: "solana" }] }));
    expect(await query("SELECT id FROM audit_log")).toHaveLength(0);
  });
});
