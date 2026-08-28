import { aadFor, blindIndex, encrypt } from "./crypto";
import { query } from "./db";

export type RawTxInput = {
  signature: string;
  blockTime: Date;
  slot: number | null;
  payload: unknown;
  source: "webhook" | "backfill" | "reconcile";
};

type PreparedRow = {
  signature: string;
  hmac: Buffer;
  signatureEnc: Buffer;
  payloadEnc: Buffer;
  slot: number | null;
  blockTime: Date;
  source: "webhook" | "backfill" | "reconcile";
};

/** Encrypts one input into row-ready ciphertext. Throws on any input a row
 * cannot be built from: a signature that is not actually a string despite the
 * type (which `encrypt()`'s underlying cipher rejects), a `blockTime` that is
 * not a storable instant, or a `slot` that is not a safe integer.
 *
 * The last two are checked *here* rather than left to Postgres because they
 * are the only two fields that reach the INSERT unencrypted, so `encrypt()`
 * never sees them and the caller's try/catch never fired for them. Unchecked,
 * they fail inside `insertRows` instead -- on the single multi-row INSERT
 * that carries the whole batch, after every event has already been prepared,
 * which takes every good event down with the bad one. Measured 2026-08-28
 * against TEST_DATABASE_URL: a non-numeric timestamp, a `1e18` timestamp, a
 * non-numeric slot and a fractional slot each aborted a three-event batch and
 * lost the two good events with it.
 *
 * Callers decide whether a throw here should abort the whole operation
 * (`storeRawTx`) or just skip this one item (`storeRawTxBatch`). */
function prepareRow(input: RawTxInput): PreparedRow {
  // `>= 0` is false for NaN, which is what both an unparseable Date and a
  // timestamp too large for `Date` produce, and it is also the lower bound
  // Postgres needs: a negative epoch is a pre-1970 block time, and far enough
  // below zero Postgres refuses it outright ("timestamp out of range", probed
  // at 4714 BC). The upper end needs no bound of its own -- the largest
  // instant `Date` can represent at all is 275760 AD, which Postgres stores
  // (probed, same run).
  if (!(input.blockTime instanceof Date) || !(input.blockTime.getTime() >= 0)) {
    throw new Error("blockTime is not a storable instant");
  }
  // `slot` is BIGINT, so magnitude is not what breaks: `pg` stringifies the
  // number, and `1e30` and `1.5` both arrive as text Postgres rejects for a
  // bigint. Safe-integer is the bound that makes the notation right, and a
  // Solana slot is nine digits.
  if (input.slot !== null && !Number.isSafeInteger(input.slot)) {
    throw new Error("slot is not a safe integer");
  }

  const hmac = blindIndex(input.signature, "signature");
  const hmacHex = hmac.toString("hex");
  return {
    signature: input.signature,
    hmac,
    signatureEnc: encrypt(input.signature, aadFor("raw_tx", "signature", hmacHex)),
    payloadEnc: encrypt(JSON.stringify(input.payload), aadFor("raw_tx", "payload", hmacHex)),
    slot: input.slot,
    blockTime: input.blockTime,
    source: input.source,
  };
}

/** One INSERT for however many rows are prepared. `ON CONFLICT ... DO
 * NOTHING` is what makes this safe against both a signature already stored
 * from an earlier delivery and the same signature appearing twice within
 * this one batch (`DO UPDATE` would reject the latter with "ON CONFLICT DO
 * UPDATE command cannot affect row a second time"). Returns the signatures
 * that were actually newly inserted, deduplicated. */
async function insertRows(rows: PreparedRow[]): Promise<string[]> {
  if (rows.length === 0) return [];

  const columnsPerRow = 6;
  const placeholders = rows.map((_, i) => {
    const base = i * columnsPerRow;
    return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6})`;
  });
  const values = rows.flatMap((row) => [
    row.hmac,
    row.signatureEnc,
    row.payloadEnc,
    row.slot,
    row.blockTime,
    row.source,
  ]);

  const inserted = await query<{ signature_hmac: Buffer }>(
    `INSERT INTO raw_tx (signature_hmac, signature_enc, payload_enc, slot, block_time, source)
     VALUES ${placeholders.join(", ")}
     ON CONFLICT (signature_hmac) DO NOTHING
     RETURNING signature_hmac`,
    values,
  );

  const insertedHex = new Set(inserted.map((row) => row.signature_hmac.toString("hex")));
  const seen = new Set<string>();
  const signatures: string[] = [];
  for (const row of rows) {
    const hex = row.hmac.toString("hex");
    if (insertedHex.has(hex) && !seen.has(hex)) {
      seen.add(hex);
      signatures.push(row.signature);
    }
  }
  return signatures;
}

/**
 * Stores one delivered transaction, encrypted. The signature's blind index is
 * the primary key, which is also the idempotency barrier: Helius retries and
 * may deliver the same event more than once.
 *
 * Unlike `storeRawTxBatch`, a malformed `input` throws rather than being
 * silently skipped: this is the direct, single-item entry point (used by
 * backfill/reconcile call sites outside the webhook), and a caller passing
 * bad data wants to know about it rather than have it disappear.
 */
export async function storeRawTx(input: RawTxInput): Promise<boolean> {
  const inserted = await insertRows([prepareRow(input)]);
  return inserted.length > 0;
}

/**
 * Stores a whole webhook delivery in one round trip. Helius allows one second
 * for the entire delivery regardless of how many events it contains, so N
 * sequential round trips cannot be afforded once a batch has more than a
 * couple of events — a ten-event batch on a sequential path measured well
 * over the budget. One multi-row INSERT keeps this at one round trip no
 * matter the batch size.
 *
 * Each event is prepared independently, and a preparation failure is caught,
 * skipped, and logged without the offending signature or payload: a
 * deterministically malformed event -- a non-string signature, a block time
 * that is not a storable instant, a slot that is not a safe integer -- would
 * fail identically on every Helius retry, so letting it abort the batch would
 * permanently lose every good event alongside it for nothing.
 *
 * All three of those are rejected by `prepareRow`, which is what makes that
 * true of what ships rather than only of the signature. Until 2026-08-28 the
 * block time and the slot went unchecked into the INSERT, so this paragraph
 * described a guarantee the code did not provide: one malformed timestamp
 * returned a 500, and Helius retried three times and dropped the delivery.
 */
export async function storeRawTxBatch(inputs: RawTxInput[]): Promise<string[]> {
  const rows: PreparedRow[] = [];
  for (const input of inputs) {
    try {
      rows.push(prepareRow(input));
    } catch {
      console.warn("storeRawTxBatch: skipped a malformed event");
    }
  }
  return insertRows(rows);
}
