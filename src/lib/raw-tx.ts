import { aadFor, blindIndex, encrypt } from "./crypto";
import { query } from "./db";

export type RawTxInput = {
  signature: string;
  blockTime: Date;
  slot: number | null;
  payload: unknown;
  source: "webhook" | "backfill" | "reconcile";
};

/**
 * Stores one delivered transaction, encrypted. The signature's blind index is
 * the primary key, which is also the idempotency barrier: Helius retries and
 * may deliver the same event more than once.
 */
export async function storeRawTx(input: RawTxInput): Promise<boolean> {
  const hmac = blindIndex(input.signature, "signature");
  const hmacHex = hmac.toString("hex");
  const rows = await query<{ signature_hmac: Buffer }>(
    `INSERT INTO raw_tx (signature_hmac, signature_enc, payload_enc, slot, block_time, source)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (signature_hmac) DO NOTHING
     RETURNING signature_hmac`,
    [
      hmac,
      encrypt(input.signature, aadFor("raw_tx", "signature", hmacHex)),
      encrypt(JSON.stringify(input.payload), aadFor("raw_tx", "payload", hmacHex)),
      input.slot,
      input.blockTime,
      input.source,
    ],
  );
  return rows.length > 0;
}
