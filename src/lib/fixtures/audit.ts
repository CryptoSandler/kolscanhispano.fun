import { query } from "../db";

/**
 * Empties `audit_log` and `audit_signature` between tests.
 *
 * Both tables refuse `DELETE` and `TRUNCATE` by trigger (`migrations/018`,
 * `migrations/019`), so a fixture cannot simply clear them — and that refusal
 * is the point, not an obstacle to route around quietly.
 *
 * **This function is the tripwire's own proof.** The migrations say in as many
 * words that the trigger stops the accident and not the operator: "the same
 * owner the trigger stops from running `DELETE` can run `DROP TRIGGER` and then
 * run it". This is that sentence, executable. It is here, in a fixtures module
 * no production path imports, so the only code that turns the guard off is code
 * that exists to reset a database nobody trusts anyway.
 *
 * `DISABLE TRIGGER USER` rather than dropping and recreating: the triggers come
 * back on with one statement instead of a copy of the migration that would rot
 * the moment the migration changed.
 */
export async function resetAuditLog(): Promise<void> {
  await query("ALTER TABLE audit_log DISABLE TRIGGER USER");
  await query("ALTER TABLE audit_signature DISABLE TRIGGER USER");
  try {
    await query("TRUNCATE audit_log, audit_signature");
  } finally {
    // Re-enabled even if the truncate failed: a suite that left the guard off
    // would let every later test pass against a table that is no longer
    // append-only, which is the one failure this whole mechanism is about.
    await query("ALTER TABLE audit_log ENABLE TRIGGER USER");
    await query("ALTER TABLE audit_signature ENABLE TRIGGER USER");
  }
}
