/**
 * Operator entry point for `syncHeliusWebhook` (see
 * `../src/lib/helius-webhook.ts`).
 *
 *     npx tsx scripts/sync-helius-webhook.ts
 *
 * Spec §5.4 describes this as a cron, and the mutation paths call the same
 * function directly — approving a KOL and creating an approved one both
 * reconcile before they answer. This exists for the changes that have **no**
 * path yet: suspension and wallet withdrawal are spec §9 and unbuilt, and until
 * they are, a roster changed by hand in the database is reconciled by running
 * this.
 *
 * It is cheap to run and safe to repeat: an unchanged address set makes no API
 * call and spends no credit, which is the whole reason the hash exists.
 *
 * Nothing here prints an address. The summary is counts and, when a webhook is
 * created or edited, the id Helius answered with — which is not a secret and is
 * what an operator needs to find the object in a dashboard.
 */
import { loadEnvLocal } from "../src/lib/env";
loadEnvLocal();

import { announceDatabaseTarget } from "../src/lib/db";
import { syncHeliusWebhook } from "../src/lib/helius-webhook";

async function main(): Promise<number> {
  announceDatabaseTarget();

  const result = await syncHeliusWebhook();
  if (!result.ok) {
    console.error(`sync-helius-webhook: not synced -- ${result.reason}`);
    return 1;
  }
  if (!result.changed) {
    console.log(
      `sync-helius-webhook: already in sync; ${result.addresses} address(es) on the webhook`,
    );
    return 0;
  }
  console.log(
    `sync-helius-webhook: ${result.created ? "created" : "updated"} webhook ${result.webhookId} ` +
      `with ${result.addresses} address(es)`,
  );
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(await main());
}
