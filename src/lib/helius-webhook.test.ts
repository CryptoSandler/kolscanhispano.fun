/**
 * The address-set sync, against the database and a fake Helius.
 *
 * The property the whole module exists for is the one this file exercises
 * hardest: **the hash decides**. Spec §5.4 buys "no API call, zero credits" on
 * an unchanged set, and that saving is only honest if a *changed* set is
 * actually noticed — so the central case falsifies the stored hash and requires
 * the sync to see it and repair it.
 *
 * No network: `network-guard.ts` fails the suite for a real call, and a test
 * that spent a Helius credit per run would be paying for its own coverage.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { blindIndex } from "@/lib/crypto";
import { query } from "@/lib/db";
import {
  WEBHOOK_SETTING_KEY,
  addressSetHash,
  desiredAddresses,
  readWebhookState,
  syncHeliusWebhook,
} from "@/lib/helius-webhook";
import { inventAddress } from "@/lib/ids";
import { createKol } from "@/lib/roster";
import { approveKol } from "@/lib/roster";

const WEBHOOK_ID = "wh-test-0001";

type Call = { url: string; method: string; body: Record<string, unknown> };

/**
 * A Helius that accepts everything, remembers what it was asked, and — like the
 * real one — answers a `GET` of a webhook with the set it holds.
 *
 * `holds` is what that read-back reports, and it defaults to "whatever the last
 * write sent". Overriding it is how the silent-partial-write case is staged.
 *
 * `foreign` stages the case that cost us the ingest: the webhook belongs to
 * **another account**, so the listado de esta clave viene vacío mientras el
 * detalle sigue contestando 200 — que es exactamente lo que hizo Helius el
 * 2026-09-06 al rotar la clave a la cuenta de CryptoSandler.
 */
function fakeHelius(
  calls: Call[],
  options: { status?: number; holds?: number | null; gone?: boolean; foreign?: boolean } = {},
): typeof globalThis.fetch {
  const status = options.status ?? 200;
  let lastSent = 0;
  return (async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET";
    // El listado es por cuenta; el detalle no. Los separa el path: `/v0/webhooks`
    // contra `/v0/webhooks/<id>`.
    const isList = !/\/webhooks\/[^?]+/.test(url);
    if (method === "GET" && isList) {
      const ours = options.gone === true || options.foreign === true ? [] : [{ webhookID: WEBHOOK_ID }];
      return { ok: true, status: 200, json: async () => ours } as Response;
    }
    if (method === "GET") {
      // `gone` stages a webhook Helius has forgotten: every read of it 404s,
      // which is what a deletion from the dashboard looks like from here.
      const held = options.gone === true ? null : options.holds === undefined ? lastSent : options.holds;
      return {
        ok: held !== null,
        status: held === null ? 404 : 200,
        json: async () => ({ webhookID: WEBHOOK_ID, accountAddresses: new Array(held ?? 0).fill("x") }),
      } as Response;
    }
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    lastSent = (body.accountAddresses as string[]).length;
    options.gone = false; // a write brings it back into existence
    options.foreign = false; // y lo trae a esta cuenta
    calls.push({ url, method, body });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => ({ webhookID: WEBHOOK_ID }),
    } as Response;
  }) as unknown as typeof globalThis.fetch;
}

let previous: Record<string, string | undefined> = {};

beforeEach(async () => {
  await query("TRUNCATE kol, kol_wallet CASCADE");
  await query("DELETE FROM setting WHERE key = $1", [WEBHOOK_SETTING_KEY]);
  previous = {
    key: process.env.HELIUS_API_KEY,
    secret: process.env.HELIUS_WEBHOOK_SECRET,
    base: process.env.WEBHOOK_BASE_URL,
  };
  process.env.HELIUS_API_KEY = "test-helius-key";
  process.env.HELIUS_WEBHOOK_SECRET = "test-webhook-secret";
  process.env.WEBHOOK_BASE_URL = "https://kolscanhispano.fun";
});

afterEach(async () => {
  for (const [name, value] of [
    ["HELIUS_API_KEY", previous.key],
    ["HELIUS_WEBHOOK_SECRET", previous.secret],
    ["WEBHOOK_BASE_URL", previous.base],
  ] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  await query("DELETE FROM setting WHERE key = $1", [WEBHOOK_SETTING_KEY]);
});

async function approvedKolWithWallet(slug: string): Promise<string> {
  const address = inventAddress();
  const created = await createKol({
    handle: slug,
    wallets: [{ address, chain: "solana" }],
    status: "pending",
  });
  if (!created.ok) throw new Error(`fixture failed: ${created.reason}`);
  await approveKol(created.kolId);
  return address;
}

describe("desiredAddresses", () => {
  /**
   * Spec §5.2: *"every `active` wallet of every `approved` KOL"*. Both halves
   * are asserted, because either one alone is a webhook watching the wrong set:
   * a pending KOL is somebody nobody vouched for, and a withdrawn wallet is one
   * whose owner asked to be taken off.
   */
  it("takes active wallets of approved KOLs, and nothing else", async () => {
    const approved = await approvedKolWithWallet("aprobado");

    const pending = await createKol({
      handle: "pendiente",
      wallets: [{ address: inventAddress(), chain: "solana" }],
      status: "pending",
    });
    if (!pending.ok) throw new Error("fixture failed");

    const withdrawnOwner = await approvedKolWithWallet("retirado");
    await query("UPDATE kol_wallet SET status = 'withdrawn' WHERE address_hmac = $1", [
      blindIndex(withdrawnOwner, "address"),
    ]);

    expect(await desiredAddresses()).toEqual([approved]);
  });

  it("is sorted, so the digest is a function of the set and not of the query plan", async () => {
    await approvedKolWithWallet("uno");
    await approvedKolWithWallet("dos");
    await approvedKolWithWallet("tres");

    const addresses = await desiredAddresses();
    expect(addresses).toHaveLength(3);
    expect(addresses).toEqual([...addresses].sort());
  });
});

describe("addressSetHash", () => {
  it("does not depend on the order it is handed", () => {
    const a = inventAddress();
    const b = inventAddress();
    expect(addressSetHash([a, b])).toBe(addressSetHash([b, a]));
  });

  it("changes when the set does", () => {
    const a = inventAddress();
    expect(addressSetHash([a])).not.toBe(addressSetHash([a, inventAddress()]));
    expect(addressSetHash([])).not.toBe(addressSetHash([a]));
  });

  /**
   * The reason `"webhook"` is its own blind-index domain. With exactly one
   * wallet on the roster the digest is over that one address, and in the
   * `"address"` domain it would be byte-identical to the `address_hmac` stored
   * beside it in `kol_wallet` — one number meaning two things in two tables.
   */
  it("is not the blind index of the one address it contains", () => {
    const address = inventAddress();
    expect(addressSetHash([address])).not.toBe(blindIndex(address, "address").toString("hex"));
  });
});

describe("syncHeliusWebhook", () => {
  it("creates the webhook the first time, with the secret and the swap filter", async () => {
    const address = await approvedKolWithWallet("uno");
    const calls: Call[] = [];

    const result = await syncHeliusWebhook(fakeHelius(calls));

    expect(result).toMatchObject({ ok: true, changed: true, created: true, addresses: 1 });
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].body).toMatchObject({
      webhookURL: "https://kolscanhispano.fun/api/webhooks/helius",
      transactionTypes: ["SWAP"],
      webhookType: "enhanced",
      // The endpoint compares this header against HELIUS_WEBHOOK_SECRET in
      // constant time; a webhook registered without it delivers nothing but
      // 403s.
      authHeader: "test-webhook-secret",
      accountAddresses: [address],
    });
    expect(await readWebhookState()).toMatchObject({ webhookId: WEBHOOK_ID, addresses: 1 });
  });

  /** Spec §5.4: *"If unchanged: no API call, zero credits."* */
  it("spends nothing when the set has not moved", async () => {
    await approvedKolWithWallet("uno");
    await syncHeliusWebhook(fakeHelius([]));

    const calls: Call[] = [];
    const result = await syncHeliusWebhook(fakeHelius(calls));

    expect(result).toMatchObject({ ok: true, changed: false, reason: "unchanged" });
    // `calls` records writes only. An unchanged set costs one read — spec §5.4
    // says "no API call" and this is the line that departs from it, for the
    // reason the module states — and no write at all.
    expect(calls).toEqual([]);
  });

  /**
   * **The falsified hash**, and the case the whole module rests on.
   *
   * The saving above is only honest if a set that *has* moved is noticed. A
   * sync that wrote the hash and never compared it would pass every other case
   * here — it would create the webhook, report `unchanged` forever after, and
   * quietly stop watching anybody added later. So the stored hash is corrupted
   * by hand, with the address set left exactly as it was, and the sync must
   * treat that as a difference, call Helius, and repair the row.
   */
  it("notices a hash that does not describe the set, and repairs it", async () => {
    await approvedKolWithWallet("uno");
    await syncHeliusWebhook(fakeHelius([]));
    const before = await readWebhookState();

    await query("UPDATE setting SET value = jsonb_set(value, '{hash}', '\"mentira\"') WHERE key = $1", [
      WEBHOOK_SETTING_KEY,
    ]);
    expect((await readWebhookState())?.hash).toBe("mentira");

    const calls: Call[] = [];
    const result = await syncHeliusWebhook(fakeHelius(calls));

    expect(result).toMatchObject({ ok: true, changed: true, created: false });
    // An edit of the webhook it already knows about, never a second webhook.
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("PUT");
    expect(calls[0].url).toContain(WEBHOOK_ID);
    expect((await readWebhookState())?.hash).toBe(before?.hash);
  });

  it("edits rather than creates once a webhook exists, when a KOL is added", async () => {
    await approvedKolWithWallet("uno");
    await syncHeliusWebhook(fakeHelius([]));

    await approvedKolWithWallet("dos");
    const calls: Call[] = [];
    const result = await syncHeliusWebhook(fakeHelius(calls));

    expect(result).toMatchObject({ ok: true, changed: true, created: false, addresses: 2 });
    expect(calls[0].method).toBe("PUT");
    expect((calls[0].body.accountAddresses as string[]).length).toBe(2);
  });

  /**
   * The self-healing half. A hash written before Helius accepted the set would
   * make the next call believe the webhook already had it, and the difference
   * would never be repaired — a webhook permanently one KOL behind, with
   * nothing in the database saying so.
   */
  it("writes no hash when Helius refuses, so the next run retries", async () => {
    await approvedKolWithWallet("uno");

    const result = await syncHeliusWebhook(fakeHelius([], { status: 500 }));

    expect(result).toEqual({ ok: false, reason: "helius_failed" });
    expect(await readWebhookState()).toBeNull();

    const calls: Call[] = [];
    expect(await syncHeliusWebhook(fakeHelius(calls))).toMatchObject({ ok: true, changed: true });
    expect(calls).toHaveLength(1);
  });

  /**
   * The case the first production run made necessary.
   *
   * Helius answered `200` with a webhook id, and the webhook list then showed
   * that webhook holding **no addresses** — the list summarises and the object
   * itself had them, but for several minutes nothing in this code could tell
   * the difference. A `200` is Helius accepting a request; what this module
   * owes is a webhook that watches the roster, and only the webhook can say so.
   */
  it("does not believe a write the webhook cannot confirm", async () => {
    await approvedKolWithWallet("uno");

    const calls: Call[] = [];
    const result = await syncHeliusWebhook(fakeHelius(calls, { holds: 0 }));

    expect(result).toEqual({ ok: false, reason: "helius_failed" });
    // It tried, and it refused to record the try as a success.
    expect(calls).toHaveLength(1);
    expect(await readWebhookState()).toBeNull();
  });

  it("does not believe a write it cannot read back at all", async () => {
    await approvedKolWithWallet("uno");

    expect(await syncHeliusWebhook(fakeHelius([], { holds: null }))).toEqual({
      ok: false,
      reason: "helius_failed",
    });
    expect(await readWebhookState()).toBeNull();
  });

  /**
   * The hole the address hash does not cover.
   *
   * Measured 2026-09-02: two hours after this webhook was created,
   * `GET /v0/webhooks` answered `[]` for a webhook that `GET /v0/webhooks/<id>`
   * returned `200` for. The list is not just a summary, it is inconsistent —
   * and a webhook that really is deleted, or auto-disabled by Helius on the
   * free plan, leaves a stored hash that still describes the set perfectly
   * while nothing at all is being watched.
   *
   * So an unchanged set still asks whether the webhook is there, and a webhook
   * that is gone is **created**, never edited: a `PUT` against an id Helius has
   * forgotten answers 404 for ever.
   */
  it("recreates a webhook that vanished, even though the set did not change", async () => {
    await approvedKolWithWallet("uno");
    await syncHeliusWebhook(fakeHelius([]));

    const calls: Call[] = [];
    const result = await syncHeliusWebhook(fakeHelius(calls, { gone: true }));

    expect(result).toMatchObject({ ok: true, changed: true, created: true });
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("POST");
  });

  /**
   * **Cuenta nueva, hash viejo.**
   *
   * El 2026-09-06 se rotó `HELIUS_API_KEY` a la cuenta de CryptoSandler porque
   * la anterior era personal. El webhook había quedado en la cuenta vieja, y el
   * `webhook_state` de la base seguía guardando su id y el hash de un conjunto
   * de direcciones que no había cambiado. El sync dijo `already in sync;
   * 3 address(es)` — con la ingesta a punto de morir en cuanto la cuenta vieja
   * se revocara, que es lo que pasó ese mismo día.
   *
   * La causa: preguntaba por el detalle, y Helius contesta 200 al detalle de un
   * id que no es de esta cuenta. Ahora pregunta por el **listado**, que sí es
   * por cuenta, y un webhook ajeno se recrea acá.
   */
  it("recreates the webhook when the key now belongs to another account", async () => {
    await approvedKolWithWallet("uno");
    await syncHeliusWebhook(fakeHelius([]));
    const before = await readWebhookState();

    const calls: Call[] = [];
    const result = await syncHeliusWebhook(fakeHelius(calls, { foreign: true }));

    expect(result).toMatchObject({ ok: true, changed: true, created: true });
    expect(calls).toHaveLength(1);
    // POST, no PUT: el id viejo no es nuestro para editar.
    expect(calls[0].method).toBe("POST");
    // Y el hash no alcanza para nada por sí solo: el conjunto no se movió.
    expect(await readWebhookState()).toMatchObject({ hash: before?.hash });
  });

  it("refuses to sync without the key or the secret, and calls nothing", async () => {
    await approvedKolWithWallet("uno");
    const calls: Call[] = [];

    delete process.env.HELIUS_API_KEY;
    expect(await syncHeliusWebhook(fakeHelius(calls))).toEqual({ ok: false, reason: "no_api_key" });
    process.env.HELIUS_API_KEY = "test-helius-key";

    delete process.env.HELIUS_WEBHOOK_SECRET;
    expect(await syncHeliusWebhook(fakeHelius(calls))).toEqual({ ok: false, reason: "no_secret" });

    expect(calls).toEqual([]);
  });
});
