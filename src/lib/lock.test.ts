import { Client } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { query } from "./db";
import { lockKey, withLock } from "./lock";

// withLock opens its own dedicated connection per call (see lock.ts), not
// the shared, max: 1 pool -- so two concurrent calls to withLock itself
// would now genuinely race for the same advisory lock rather than being
// forced to serialize on one connection. These tests still use a rival held
// on a separate, manually-controlled connection, because that gives a case
// deterministic control: assert the lock is held ("returns null"), then
// explicitly release it and assert `withLock` succeeds -- instead of
// leaving a real race's winner to chance. This also matches the real
// scenario this task defends against: a scheduled cron run and a manual
// dispatch are two separate processes, each with a connection of its own.
//
// A second, independent reason a rival needs its own connection: both
// DATABASE_URL and TEST_DATABASE_URL point at Neon's pooled (`-pooler`)
// endpoint, so a rival's lock has to be a
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

  it("closes its dedicated connection when done, success or failure", async () => {
    // withLock's own client is never shared or pooled by this codebase, so
    // a leaked one doesn't block a later call the way a leaked pool client
    // would -- each call just opens another fresh connection. That means
    // none of the behavioral assertions above would notice if `client.end()`
    // stopped being called; only a direct check that it happened does.
    const endSpy = vi.spyOn(Client.prototype, "end");
    const before = endSpy.mock.calls.length;

    await withLock("withLock-closes-on-success", async () => "done");
    expect(endSpy.mock.calls.length).toBe(before + 1);

    await expect(
      withLock("withLock-closes-on-failure", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(endSpy.mock.calls.length).toBe(before + 2);

    endSpy.mockRestore();
  });

  it("lets fn use the shared pool without deadlocking", async () => {
    // The real calling shape (Task 2): withLock(name, () => parsePending()),
    // and parsePending is nothing but queries through the shared pool. An
    // earlier version of withLock held that pool's one (max: 1) connection
    // for the whole call, so this query waited for a connection withLock
    // itself was holding and hung instead of completing. withLock now holds
    // its lock on a dedicated connection of its own, so fn is free to use
    // the shared pool normally.
    const result = await withLock("withLock-pool-probe", () =>
      query<{ one: number }>("SELECT 1::int AS one"),
    );
    expect(result).toEqual([{ one: 1 }]);
  }, 10_000);

  // The three cases below are about the *connection*, not the lock. The lock
  // releases itself on ROLLBACK, on COMMIT, and on a dropped backend, so
  // every assertion about lock release above still passes with the
  // connection left wide open -- which is exactly how a leaked one survives
  // review. Against Neon's pooled endpoint a leaked connection is not free:
  // it keeps a PgBouncer server backend pinned, showing as "idle in
  // transaction" until the server times it out.

  it("closes its connection when connecting itself fails", async () => {
    const endSpy = vi.spyOn(Client.prototype, "end");
    const connectSpy = vi
      .spyOn(Client.prototype, "connect")
      .mockRejectedValueOnce(new Error("password authentication failed"));
    const before = endSpy.mock.calls.length;

    try {
      let ran = false;
      await expect(
        withLock("withLock-connect-fails", async () => {
          ran = true;
          return "never";
        }),
      ).rejects.toThrow("password authentication failed");

      expect(ran).toBe(false);
      // connect() used to sit outside the try, so this path returned without
      // ever closing the client.
      expect(endSpy.mock.calls.length).toBe(before + 1);
    } finally {
      connectSpy.mockRestore();
      endSpy.mockRestore();
    }
  });

  it("closes its connection when the lock query throws before fn is ever reached", async () => {
    const endSpy = vi.spyOn(Client.prototype, "end");
    // The first query withLock issues is the BEGIN.
    const querySpy = vi
      .spyOn(Client.prototype, "query")
      .mockRejectedValueOnce(new Error("terminating connection due to administrator command"));
    const before = endSpy.mock.calls.length;

    try {
      let ran = false;
      await expect(
        withLock("withLock-begin-fails", async () => {
          ran = true;
          return "never";
        }),
      ).rejects.toThrow("terminating connection due to administrator command");

      expect(ran).toBe(false);
      expect(endSpy.mock.calls.length).toBe(before + 1);
    } finally {
      querySpy.mockRestore();
      endSpy.mockRestore();
    }
  });

  it("propagates fn's error rather than a failure to close the connection", async () => {
    const realEnd = Client.prototype.end as (this: Client) => Promise<void>;
    // Close for real first, then fail: the point is that a rejecting end()
    // does not replace the caller's error, not that the connection leaks.
    const endSpy = vi.spyOn(Client.prototype, "end").mockImplementationOnce(async function (this: Client) {
      await realEnd.call(this);
      throw new Error("Connection terminated unexpectedly");
    });

    try {
      await expect(
        withLock("withLock-end-fails", async () => {
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");
    } finally {
      endSpy.mockRestore();
    }
  });
});

describe("lockKey", () => {
  it("is deterministic and differs between names", () => {
    expect(lockKey("same")).toBe(lockKey("same"));
    expect(lockKey("a")).not.toBe(lockKey("b"));
  });
});
