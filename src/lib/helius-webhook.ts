/**
 * Spec §5.2 and §5.4: the Helius webhook's address set **is** the database.
 *
 * *"`accountAddresses` = every `active` wallet of every `approved` KOL"*, and
 * *"a cron computes the desired address set from the database, hashes it, and
 * compares it with `setting['helius_webhook_address_hash']`. If unchanged: no
 * API call, zero credits. If changed: one edit call, then the hash is updated.
 * Approving, suspending, withdrawing a wallet or adding one all flow through
 * this single path, so the database stays the source of truth and the webhook
 * is only ever repaired, never manually curated."*
 *
 * **It was unbuilt until 2026-09-02, and the cost of that was measured rather
 * than guessed.** Three KOLs were approved that day and nothing changed: the
 * live webhook was watching addresses none of them own, under a key this
 * environment does not hold, and all 5,128 stored payloads were scanned to
 * prove it (`docs/padron.md` §3). An approved roster that no webhook watches is
 * a roster that cannot produce a single trade.
 *
 * Four properties this module is written around:
 *
 * - **Idempotent and cheap.** The hash is the whole point: an approval that
 *   changes nothing costs zero credits. `syncHeliusWebhook` is safe to call
 *   after every mutation for exactly that reason.
 * - **It never fails the mutation that triggered it.** An approval that
 *   succeeded must not be reported as failed because Helius was down; the
 *   stored hash is only written *after* Helius has accepted the set, so a
 *   failed sync leaves the difference in place and the next call retries it.
 *   That is the self-healing half of "only ever repaired".
 * - **No address is ever logged.** They go to Helius in a request body and
 *   nowhere else; every message here is a count.
 * - **The digest is keyed.** `blindIndex(..., "webhook")` rather than a bare
 *   SHA-256, so a `setting` row cannot be tested against a candidate address
 *   list, and — with one wallet on the roster — cannot collide with that
 *   wallet's own `address_hmac`.
 */
import { aadFor, blindIndex, decrypt } from "./crypto";
import { query } from "./db";

/** The `setting` row this module owns. Spec §5.4 names it. */
export const WEBHOOK_SETTING_KEY = "helius_webhook_address_hash";

/** Helius's REST base. One place, so a test can point at a fake. */
export const HELIUS_API = "https://api.helius.xyz/v0/webhooks";

/**
 * What the webhook is registered as, per spec §5.2 and §8.5: enhanced, swaps
 * only, **bare addresses, no names or labels, and a neutral webhook name**.
 * Helius has no name field on this endpoint, so "neutral name" is satisfied by
 * there being nothing to name.
 */
const WEBHOOK_TYPE = "enhanced";
const TRANSACTION_TYPES = ["SWAP"];

export type WebhookState = {
  /** Keyed digest of the desired set, hex. */
  hash: string;
  /** Helius's own id, so the next change is an edit rather than a second webhook. */
  webhookId: string;
  /** How many addresses were sent. A count is publishable; the set is not. */
  addresses: number;
  syncedAt: string;
};

export type SyncResult =
  | { ok: true; changed: false; addresses: number; reason: "unchanged" }
  | { ok: true; changed: true; addresses: number; webhookId: string; created: boolean }
  | { ok: false; reason: "no_api_key" | "no_secret" | "no_url" | "helius_failed" };

/**
 * Every address the webhook should watch: active wallets of approved KOLs.
 *
 * One query and one decrypt per row rather than `revealAddress` per wallet —
 * same AAD, same key, one round trip. Sorted, because the digest below has to
 * be a function of the *set* and not of the order Postgres happened to return.
 */
export async function desiredAddresses(): Promise<string[]> {
  const rows = await query<{ id: string; address_enc: Buffer }>(
    `SELECT w.id, w.address_enc
       FROM kol_wallet w
       JOIN kol k ON k.id = w.kol_id
      WHERE k.status = 'approved' AND w.status = 'active'`,
  );
  return rows
    .map((row) => decrypt(row.address_enc, aadFor("kol_wallet", "address", row.id)))
    .sort();
}

/** The keyed digest of a desired set. Exported so its test can falsify it. */
export function addressSetHash(addresses: readonly string[]): string {
  return blindIndex([...addresses].sort().join("\n"), "webhook").toString("hex");
}

/** What the last successful sync left behind, or `null` before the first one. */
export async function readWebhookState(): Promise<WebhookState | null> {
  const rows = await query<{ value: unknown }>("SELECT value FROM setting WHERE key = $1", [
    WEBHOOK_SETTING_KEY,
  ]);
  const value = rows[0]?.value;
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.hash !== "string" || typeof record.webhookId !== "string") return null;
  return {
    hash: record.hash,
    webhookId: record.webhookId,
    addresses: typeof record.addresses === "number" ? record.addresses : 0,
    syncedAt: typeof record.syncedAt === "string" ? record.syncedAt : "",
  };
}

/**
 * Reconciles the webhook with the database.
 *
 * `fetcher` and `now` are injectable so the whole path can be tested without
 * spending a credit or a network call — `network-guard.ts` fails the suite for
 * one, and rightly.
 */
export async function syncHeliusWebhook(
  fetcher: typeof globalThis.fetch = globalThis.fetch,
  now: Date = new Date(),
): Promise<SyncResult> {
  const apiKey = process.env.HELIUS_API_KEY;
  if (!apiKey) return { ok: false, reason: "no_api_key" };
  const secret = process.env.HELIUS_WEBHOOK_SECRET;
  if (!secret) return { ok: false, reason: "no_secret" };
  const url = webhookUrl();
  if (url === null) return { ok: false, reason: "no_url" };

  const addresses = await desiredAddresses();
  const hash = addressSetHash(addresses);
  const state = await readWebhookState();

  /*
    Spec §5.4 reads *"If unchanged: no API call, zero credits."* **It costs one
    call now, and this is why.**

    The hash guards the address *set*. It says nothing about the webhook still
    being there — and on 2026-09-02, two hours after this one was created,
    `GET /v0/webhooks` answered `[]` for a webhook that `GET /v0/webhooks/<id>`
    returned `200` for, with all three addresses. The list is not merely a
    summary, it is inconsistent. A webhook deleted from a dashboard, or
    auto-disabled by Helius on the free plan (spec §5.1), would leave this
    function reporting "unchanged" forever while nothing was being watched:
    exactly the silence this module exists to end.

    So existence is established first, by id, and the four combinations fall out
    of it: known and current is the only no-op; known and stale is an edit;
    unknown — never synced, or synced to a webhook that is gone — is a create.
    An edit against an id Helius has forgotten would answer 404 for ever.

    The credit is spent on roster mutations, a handful a week, and not on a
    schedule.
  */
  const exists =
    state !== null && (await confirmAddressCount(fetcher, apiKey, state.webhookId)) !== null;

  if (state !== null && exists && state.hash === hash) {
    return { ok: true, changed: false, addresses: addresses.length, reason: "unchanged" };
  }
  if (state !== null && !exists) {
    console.warn("syncHeliusWebhook: the stored webhook is gone; recreating");
  }

  const body = JSON.stringify({
    webhookURL: url,
    transactionTypes: TRANSACTION_TYPES,
    accountAddresses: addresses,
    webhookType: WEBHOOK_TYPE,
    authHeader: secret,
  });

  // An existing id is edited; no id is created. A second webhook pointing at
  // the same endpoint would double every delivery — harmless, because
  // `storeRawTxBatch` is keyed on the signature, and still two credits' worth
  // of the same event and two rows in somebody's dashboard.
  const created = !exists;
  const endpoint = created
    ? `${HELIUS_API}?api-key=${encodeURIComponent(apiKey)}`
    : `${HELIUS_API}/${encodeURIComponent(state!.webhookId)}?api-key=${encodeURIComponent(apiKey)}`;

  let webhookId: string;
  try {
    const response = await fetcher(endpoint, {
      method: created ? "POST" : "PUT",
      headers: { "content-type": "application/json" },
      body,
    });
    if (!response.ok) {
      // The status and nothing else: a Helius error body can echo the request,
      // and the request is the address set.
      console.error(`syncHeliusWebhook: Helius answered ${response.status}`);
      return { ok: false, reason: "helius_failed" };
    }
    const answered = (await response.json()) as { webhookID?: unknown };
    webhookId =
      typeof answered.webhookID === "string" && answered.webhookID !== ""
        ? answered.webhookID
        : (state?.webhookId ?? "");
    if (webhookId === "") {
      console.error("syncHeliusWebhook: Helius accepted the set but named no webhook");
      return { ok: false, reason: "helius_failed" };
    }
  } catch {
    // Never the thrown message: a fetch error can carry the whole request.
    console.error("syncHeliusWebhook: Helius could not be reached");
    return { ok: false, reason: "helius_failed" };
  }

  /*
    **Read back what Helius actually holds**, and only then store the hash.

    This is one extra call per change — never per approval, since an unchanged
    set makes no call at all — and it exists because of what happened the first
    time this ran, on 2026-09-02. The create answered `200` with a webhook id,
    and `GET /v0/webhooks` then listed that webhook with **no**
    `accountAddresses` at all. The list endpoint summarises and the individual
    object carries the field, so the set was there and the list was the thing
    lying; but for several minutes nothing in this code could tell the
    difference, and neither could anyone reading the row it had just written.

    A `200` is Helius accepting a request. The property this module owes is that
    the webhook *watches the roster*, and the only thing that can say so is the
    webhook. If the count disagrees, the hash is not written and the next call
    repairs it, exactly as a refusal would.
  */
  const confirmed = await confirmAddressCount(fetcher, apiKey, webhookId);
  if (confirmed !== addresses.length) {
    console.error(
      `syncHeliusWebhook: Helius accepted ${addresses.length} address(es) and holds ` +
        `${confirmed === null ? "an unreadable set" : confirmed}`,
    );
    return { ok: false, reason: "helius_failed" };
  }

  // Written only now. A hash stored before Helius accepted the set would make
  // the next call believe the webhook already had it, and the difference would
  // never be repaired.
  await query(
    `INSERT INTO setting (key, value) VALUES ($1, $2::jsonb)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [
      WEBHOOK_SETTING_KEY,
      JSON.stringify({
        hash,
        webhookId,
        addresses: addresses.length,
        syncedAt: now.toISOString(),
      } satisfies WebhookState),
    ],
  );

  return { ok: true, changed: true, addresses: addresses.length, webhookId, created };
}

/**
 * How many addresses the webhook actually holds, or `null` when that cannot be
 * read. **The individual object, never the list**: `GET /v0/webhooks` returns a
 * summary with no `accountAddresses`, verified 2026-09-02 against a webhook
 * that demonstrably had three.
 */
async function confirmAddressCount(
  fetcher: typeof globalThis.fetch,
  apiKey: string,
  webhookId: string,
): Promise<number | null> {
  try {
    const response = await fetcher(
      `${HELIUS_API}/${encodeURIComponent(webhookId)}?api-key=${encodeURIComponent(apiKey)}`,
      { method: "GET" },
    );
    if (!response.ok) return null;
    const body = (await response.json()) as { accountAddresses?: unknown };
    return Array.isArray(body.accountAddresses) ? body.accountAddresses.length : null;
  } catch {
    return null;
  }
}

/**
 * Where Helius posts. `NEXT_PUBLIC_SITE_URL` when it is set, and the production
 * host otherwise — the webhook is a production-only object and pointing it at a
 * preview deployment would send live deliveries somewhere that truncates its
 * database.
 */
function webhookUrl(): string | null {
  const base = process.env.WEBHOOK_BASE_URL ?? "https://kolscanhispano.fun";
  try {
    const url = new URL("/api/webhooks/helius", base);
    return url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * The shape every mutation calls: fire it, never let it throw, say what it did.
 *
 * Spec §5.4's "single path". Approving, creating an approved KOL, suspending
 * one and adding or withdrawing a wallet all end here, and none of them may
 * fail because Helius did.
 */
export async function syncWebhookAfterRosterChange(reason: string): Promise<void> {
  try {
    const result = await syncHeliusWebhook();
    if (!result.ok) {
      console.warn(`syncHeliusWebhook (${reason}): not synced — ${result.reason}`);
      return;
    }
    if (!result.changed) {
      console.log(`syncHeliusWebhook (${reason}): unchanged, ${result.addresses} address(es)`);
      return;
    }
    console.log(
      `syncHeliusWebhook (${reason}): ${result.created ? "created" : "updated"} webhook with ` +
        `${result.addresses} address(es)`,
    );
  } catch {
    console.warn(`syncHeliusWebhook (${reason}): failed`);
  }
}
