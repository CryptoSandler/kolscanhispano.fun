import { openSync, closeSync, writeSync, readFileSync, unlinkSync, existsSync } from "node:fs";

/**
 * One Playwright run at a time, across every repository on this machine.
 *
 * **Why a machine-wide lock and not a per-repo one.** The vitest suite already
 * has its equivalent — a Postgres advisory lock in `vitest.globalSetup.ts`,
 * added after two concurrent runs truncated each other's fixtures. Playwright
 * had nothing, and the symptom was measured on 2026-08-31: a run took **24.6
 * minutes and failed two cases that never reproduced**, while a stray
 * Playwright server from another project was alive on this machine. Browsers
 * and dev servers compete for CPU and for ports in a way unit tests do not, so
 * the lock cannot live inside one repository's database.
 *
 * A lockfile at a fixed absolute path is what every repo here can agree on
 * without sharing infrastructure. See `~/.claude/GATES.md`.
 *
 * **The port is deliberately not checked here.** An earlier version did, and it
 * failed every legitimate run: Playwright starts its `webServer` *before*
 * `globalSetup`, so by the time this code runs the port is in use by our own
 * dev server. The busy-port case is already covered upstream —
 * `reuseExistingServer: false` makes Playwright refuse a port it did not bind,
 * which is the fail-fast half of this. What Playwright cannot see is another
 * repository's run, and that is what the lock is for.
 */
const LOCK_PATH = "/tmp/claude-playwright-e2e.lock";

type Holder = { pid: number; cwd: string; startedAt: string };

/** Whether a process is alive. Signal 0 tests for existence without signalling. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readHolder(): Holder | null {
  try {
    return JSON.parse(readFileSync(LOCK_PATH, "utf8")) as Holder;
  } catch {
    // Unreadable or malformed is treated as stale: a lockfile nobody can parse
    // protects nothing, and refusing to run because of one would be worse.
    return null;
  }
}

/**
 * Fails **fast and by name** rather than letting a second run discover the
 * first through flaky assertions twenty minutes later. That is the whole
 * design goal: the previous failure mode was not that two runs collided, it
 * was that the collision looked like a product bug.
 */
export async function acquireHarnessLock(): Promise<void> {
  const holder = existsSync(LOCK_PATH) ? readHolder() : null;

  if (holder && alive(holder.pid)) {
    throw new Error(
      `Another Playwright run holds the machine-wide e2e lock.\n` +
        `  pid ${holder.pid}, started ${holder.startedAt}\n` +
        `  in ${holder.cwd}\n` +
        `Wait for it, or kill that PID — never \`pkill -f playwright\`, which would take ` +
        `every other repo's run down with it (CLAUDE.md).`,
    );
  }
  if (holder) {
    console.warn(`e2e: taking over a stale lock from pid ${holder.pid} (no longer running)`);
    try {
      unlinkSync(LOCK_PATH);
    } catch {
      /* raced with another taker; the exclusive create below decides it */
    }
  }

  // `wx` is the atomic part: two runs racing here, one loses.
  let fd: number;
  try {
    fd = openSync(LOCK_PATH, "wx");
  } catch {
    throw new Error(
      `Another Playwright run took the e2e lock while this one was starting. ` +
        `Re-run; ${LOCK_PATH} names the holder.`,
    );
  }
  const mine: Holder = { pid: process.pid, cwd: process.cwd(), startedAt: new Date().toISOString() };
  writeSync(fd, JSON.stringify(mine));
  closeSync(fd);

}

export function releaseHarnessLock(): void {
  const holder = readHolder();
  // Only ever release our own: a stale-lock takeover elsewhere could otherwise
  // have this run delete a lock that now belongs to somebody else.
  if (holder && holder.pid !== process.pid) return;
  try {
    unlinkSync(LOCK_PATH);
  } catch {
    /* already gone */
  }
}
