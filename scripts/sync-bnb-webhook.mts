/**
 * Registers (or re-points) the BNB Address Activity webhook, by API.
 *
 * **No dashboard needed.** Alchemy's team API creates webhooks with the same
 * token `smartmoney` already holds — the pattern is theirs
 * (`scripts/webhook-alta.mts`), reimplemented here rather than copied, because
 * copying a file across repositories is how two copies drift.
 *
 * ## What it watches
 *
 * The active BNB wallets of **approved** KOLs, and nothing else. Both halves
 * matter: a withdrawn wallet must stop being indexed the moment its owner
 * withdraws it, and a KOL who is not approved is on no public surface, so
 * indexing them would build a ranking nobody can see.
 *
 * ## The signing key is issued once
 *
 * Alchemy returns it in the create response and never again. This prints
 * **where to put it**, never what it is: `.env.local` as
 * `ALCHEMY_WEBHOOK_SECRET`, and Vercel as a Sensitive variable. A secret that
 * reaches a terminal has reached a scrollback, a screenshot and a log —
 * `~/.claude/GATES.md` has the two occasions this project learned that.
 *
 *     npx tsx scripts/sync-bnb-webhook.mts --url https://kolscanhispano.fun/api/webhooks/alchemy
 */
import { loadEnvLocal } from "../src/lib/env";
loadEnvLocal();

import { query } from "../src/lib/db";
import {
  BNB_NETWORK,
  createAddressActivityWebhook,
  listWebhooks,
  updateWebhookAddresses,
} from "../src/lib/alchemy-webhook";
import { aadFor, decrypt } from "../src/lib/crypto";

/** Active BNB wallets of approved KOLs. Decrypted here and nowhere else. */
async function watchedAddresses(): Promise<string[]> {
  const rows = await query<{ id: string; address_enc: Buffer }>(
    `SELECT w.id, w.address_enc
       FROM kol_wallet w
       JOIN kol k ON k.id = w.kol_id
      WHERE w.chain = 'bnb' AND w.status = 'active' AND k.status = 'approved'`,
  );
  const out: string[] = [];
  for (const row of rows) {
    try {
      out.push(decrypt(row.address_enc, aadFor("kol_wallet", "address", row.id)).toLowerCase());
    } catch {
      // A ciphertext that will not open is skipped, not guessed at. The wallet
      // simply is not watched, which is the safe direction.
      continue;
    }
  }
  return out;
}

async function main(): Promise<number> {
  const token = process.env.ALCHEMY_AUTH_TOKEN;
  if (!token) {
    console.error(
      "ALCHEMY_AUTH_TOKEN is not set. It is the team token from the `arrival` Alchemy account.",
    );
    return 1;
  }
  const url = process.argv[process.argv.indexOf("--url") + 1];
  if (!url || !url.startsWith("https://")) {
    console.error("Pass --url https://<host>/api/webhooks/alchemy");
    return 1;
  }

  const addresses = await watchedAddresses();
  if (addresses.length === 0) {
    console.error(
      "No approved KOL has an active BNB wallet. Nothing to watch — refusing to " +
        "create an empty webhook, which would look registered and deliver nothing.",
    );
    return 1;
  }

  const existing = (await listWebhooks(token)).find(
    (w) => w.network === BNB_NETWORK && w.webhook_url === url,
  );

  if (existing) {
    await updateWebhookAddresses(token, existing.id, addresses);
    console.log(`updated webhook ${existing.id}: now watching ${addresses.length} addresses`);
    console.log("the signing key is unchanged; ALCHEMY_WEBHOOK_SECRET stays as it is");
    return 0;
  }

  const created = await createAddressActivityWebhook(token, url, addresses);
  console.log(`created webhook ${created.id} on ${BNB_NETWORK}, ${addresses.length} addresses`);
  if (created.signingKey) {
    // Written to a file with restrictive permissions rather than printed: this
    // value is issued once and a terminal is not where it should live.
    const { writeFileSync } = await import("node:fs");
    const out = process.env.WEBHOOK_KEY_OUT ?? "/tmp/kh-bnb-signing-key.txt";
    writeFileSync(out, `${created.signingKey}\n`, { mode: 0o600 });
    console.log(`signing key written to ${out} — put it in .env.local as`);
    console.log("  ALCHEMY_WEBHOOK_SECRET=...");
    console.log("and in Vercel as a Sensitive variable. Alchemy will not show it again.");
  } else {
    console.error("no signing key came back; the webhook exists but cannot be verified yet");
    return 1;
  }
  return 0;
}

process.exit(await main());
