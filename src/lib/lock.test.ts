import { Client } from "pg";
import { afterEach, describe, expect, it } from "vitest";
import { query } from "./db";
import { lockKey, withLock } from "./lock";

// withLock borrows the module pool's one and only connection (max: 1, see
// db.ts) for the whole call. A rival "other process" in these tests
// therefore cannot be another call routed through that same pool -- it
// would just queue behind the first `pool.connect()` and never actually
// contend; by the time it got a client the first call would already have
// released it. A rival has to be a second, independent connection instead,
// which also matches the real scenario this task defends against: a
// scheduled cron run and a manual dispatch are two separate processes, each
// with a connection of its own.
//
// A second wrinkle beyond `max: 1`: both DATABASE_URL and TEST_DATABASE_URL
// point at Neon's pooled (`-pooler`) endpoint, so a rival's lock has to be a
// `pg_try_advisory_xact_lock` held inside an explicit, still-open
// transaction -- exactly what withLock itself does (see lock.ts) -- or
// PgBouncer's transaction pooling is free to hand the rival's later
// statements to a different backend than the one that acquired the lock,
// and the whole test would be probing a lock that quietly isn't held
// anymore.
function testConnectionString(): string {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error("TEST_DATABASE_URL is not set");
  return url;
}

const rivals: Client[] = [];

async function connectRival(): Promise<Client> {
  const client = new Client({ connectionString: testConnectionString() });
  // The "killed connection" case ends this client's connection out from
  // under it via pg_terminate_backend; pg's Client emits that as an "error"
  // event, and an EventEmitter "error" with no listener is an uncaught
  // exception in Node. This mirrors the pool's own handler in db.ts.
  client.on("error", () => {});
  await client.connect();
  rivals.push(client);
  return client;
}

/**
 * Opens a transaction on `client` and tries the same advisory lock withLock
 * would, leaving the transaction open on success so the lock stays held
 * until the caller ends the connection or explicitly commits/rolls back.
 */
async function rivalAcquire(client: Client, name: string): Promise<boolean> {
  await client.query("BEGIN");
  const { rows } = await client.query<{ locked: boolean }>(
    "SELECT pg_try_advisory_xact_lock($1::bigint) AS locked",
    [lockKey(name)],
  );
  return rows[0].locked;
}

afterEach(async () => {
  // Ending the connection aborts any transaction still open on it, which
  // releases whatever advisory lock it holds -- that is the property under
  // test in most of these cases, so no separate unlock step is needed here.
  await Promise.all(rivals.splice(0).map((client) => client.end().catch(() => {})));
});

describe("withLock", () => {
  it("returns null without calling fn while a rival holds the lock, then runs normally once released", async () => {
    const name = "withLock-contended";
    const rival = await connectRival();
    expect(await rivalAcquire(rival, name)).toBe(true);

    let ran = false;
    const whileHeld = await withLock(name, async () => {
      ran = true;
      return "done";
    });
    expect(whileHeld).toBeNull();
    expect(ran).toBe(false);

    await rival.query("ROLLBACK"); // releases the xact lock; nothing was written

    await expect(withLock(name, async () => "done")).resolves.toBe("done");
  });

  it("releases the lock when fn throws, and the throw still propagates", async () => {
    const name = "withLock-throws";

    await expect(
      withLock(name, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    // If the lock were still held, a fresh connection could not acquire it.
    const rival = await connectRival();
    expect(await rivalAcquire(rival, name)).toBe(true);
  });

  it("does not let one name block a different name", async () => {
    const held = "withLock-name-a";
    const unrelated = "withLock-name-b";

    const rival = await connectRival();
    expect(await rivalAcquire(rival, held)).toBe(true);

    await expect(withLock(unrelated, async () => "unblocked")).resolves.toBe("unblocked");
  });

  it("releases the lock when the holding connection is killed", async () => {
    const name = "withLock-killed";
    const rival = await connectRival();
    expect(await rivalAcquire(rival, name)).toBe(true);

    // The pid backing this transaction, fetched from inside the same
    // still-open transaction so it names the exact backend PgBouncer pinned
    // to it -- not a different one it might hand out for a query issued
    // outside that transaction.
    const {
      rows: [{ pid }],
    } = await rival.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");

    // Confirm the lock is actually held before killing the connection, so a
    // bug that makes the lock un-acquirable for the wrong reason can't be
    // mistaken for evidence that the kill worked.
    expect(await withLock(name, async () => "ran")).toBeNull();

    // Terminate the backend rather than calling client.end(): this mirrors a
    // runner process that dies mid-job, with no graceful shutdown message,
    // and forces Postgres itself to abort the open transaction.
    await query("SELECT pg_terminate_backend($1)", [pid]);

    // The backend closes asynchronously; poll briefly instead of assuming
    // the lock is free the instant pg_terminate_backend returns.
    const deadline = Date.now() + 5_000;
    let acquired: string | null = null;
    while (Date.now() < deadline) {
      acquired = await withLock(name, async () => "ran");
      if (acquired !== null) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(acquired).toBe("ran");
  });
});

describe("lockKey", () => {
  it("is deterministic and differs between names", () => {
    expect(lockKey("same")).toBe(lockKey("same"));
    expect(lockKey("a")).not.toBe(lockKey("b"));
  });
});
