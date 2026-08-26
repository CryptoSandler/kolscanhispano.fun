/**
 * Fills the **test** database before the browser starts.
 *
 * `NODE_ENV` is set before `db.ts` is imported because that module picks
 * `TEST_DATABASE_URL` over `DATABASE_URL` on exactly that signal, and it reads
 * it once at import time — hence the dynamic import rather than a static one.
 * It also means `assertDistinctFromProduction` runs, so a `TEST_DATABASE_URL`
 * pointing at production stops this before it truncates anything.
 *
 * `playwright.config.ts` starts the app against the same URL.
 */
export default async function globalSetup(): Promise<void> {
  // `@types/node` types `NODE_ENV` as read-only. Writing it is the whole
  // point here — `db.ts` reads it once, at import time, to choose between
  // `DATABASE_URL` and `TEST_DATABASE_URL`.
  (process.env as Record<string, string>).NODE_ENV = "test";
  const { seedLeaderboard } = await import("./seed");
  await seedLeaderboard();
}
