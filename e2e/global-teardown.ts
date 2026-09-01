/**
 * Releases the machine-wide e2e lock. Playwright runs this even when the suite
 * fails, which is the case that matters: a lock held by a crashed run would
 * block every repo on this machine until somebody deleted a file they had
 * never heard of.
 *
 * A crash hard enough to skip teardown still resolves itself — `acquireHarnessLock`
 * treats a lock whose pid is gone as stale and takes it over.
 */
export default async function globalTeardown(): Promise<void> {
  const { releaseHarnessLock } = await import("./harness-lock");
  releaseHarnessLock();
}
