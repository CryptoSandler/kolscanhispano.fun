import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * The Alchemy Address Activity webhook for BNB, and the signature that proves a
 * delivery came from it.
 *
 * ## Why a webhook and not polling
 *
 * Measured 2026-09-05 against BNB mainnet through the `arrival` app: this plan
 * caps `eth_getLogs` at a **ten-block range**, BSC produces a block every 0.45 s
 * — 192,000 a day — so walking it would be 38,400 calls and roughly 2.7 hours of
 * wall clock per day, against a CU ceiling shared with `smartmoney`. Polling was
 * never on the table; `docs/multichain.md` §5 said so before it was measured and
 * §"BNB (56)" has the numbers.
 *
 * ## How a delivery is authenticated
 *
 * Alchemy signs the **raw body** with HMAC-SHA256 under a per-webhook signing
 * key and sends it as `X-Alchemy-Signature`. The key is issued once, when the
 * webhook is created, and is never retrievable again — which is why
 * `scripts/sync-bnb-webhook.mts` prints where to put it and not what it is.
 *
 * **The raw body, not the parsed one.** `JSON.parse` followed by
 * `JSON.stringify` reorders keys and drops whitespace, so a signature computed
 * over a re-serialised body fails for correct deliveries and — worse — a
 * verifier written that way tends to get "fixed" by loosening it.
 */

export const ALCHEMY_API = "https://dashboard.alchemy.com/api";

/** BNB mainnet, in Alchemy's own naming. */
export const BNB_NETWORK = "BNB_MAINNET";

/**
 * Whether `body` was signed by our webhook's key.
 *
 * Constant-time, and length-checked first because `timingSafeEqual` throws on a
 * length mismatch rather than returning false — the same shape the Helius
 * endpoint uses.
 */
export function verifyAlchemySignature(
  rawBody: string,
  signature: string | null,
  secret: string | undefined,
): boolean {
  if (!secret || !signature) return false;
  const expected = createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(signature, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

export type AlchemyWebhook = {
  id: string;
  network: string;
  webhook_type: string;
  webhook_url: string;
  is_active: boolean;
};

async function call<T>(
  path: string,
  token: string,
  init?: { method: string; body: unknown },
): Promise<T> {
  const response = await fetch(`${ALCHEMY_API}/${path}`, {
    method: init?.method ?? "GET",
    headers: {
      "X-Alchemy-Token": token,
      ...(init ? { "content-type": "application/json" } : {}),
    },
    ...(init ? { body: JSON.stringify(init.body) } : {}),
  });
  if (!response.ok) {
    // The status and nothing else: an Alchemy error body can echo the request,
    // and the request carries every address we watch.
    throw new Error(`alchemy ${path}: HTTP ${response.status}`);
  }
  return (await response.json()) as T;
}

export async function listWebhooks(token: string): Promise<AlchemyWebhook[]> {
  const body = await call<{ data: AlchemyWebhook[] }>("team-webhooks", token);
  return body.data ?? [];
}

/**
 * Creates the webhook and returns the signing key **once**.
 *
 * Alchemy issues it in this response and never again. The caller writes it down
 * or loses it, which is why the script that calls this says so before it runs.
 */
export async function createAddressActivityWebhook(
  token: string,
  webhookUrl: string,
  addresses: string[],
): Promise<{ id: string; signingKey: string | null }> {
  const body = await call<{ data: { id: string; signing_key?: string } }>(
    "create-webhook",
    token,
    {
      method: "POST",
      body: {
        network: BNB_NETWORK,
        webhook_type: "ADDRESS_ACTIVITY",
        webhook_url: webhookUrl,
        addresses,
      },
    },
  );
  return { id: body.data.id, signingKey: body.data.signing_key ?? null };
}

/** Replaces the watched set on an existing webhook. */
export async function updateWebhookAddresses(
  token: string,
  webhookId: string,
  addresses: string[],
): Promise<void> {
  await call("update-webhook-addresses", token, {
    method: "PATCH",
    body: { webhook_id: webhookId, addresses_to_add: addresses, addresses_to_remove: [] },
  });
}
