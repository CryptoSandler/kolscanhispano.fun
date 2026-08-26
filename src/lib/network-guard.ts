/**
 * Blocks every real network call for the duration of a test file.
 *
 * **Why this lives in a setup file, not `vitest.globalSetup.ts`.** `globalSetup`
 * runs once per suite run, but in its own throwaway Node context — separate
 * from the realm each test file actually executes in. Patching `globalThis.fetch`
 * there has no effect on a test: by the time a test file runs, it has its own
 * `globalThis`, unpatched. `setupFiles` (see `vitest.env.ts`) runs inside the
 * same realm as the test file it precedes, once per file, which is the only
 * place patching `globalThis.fetch` reaches the code under test.
 *
 * **Why this exists at all.** Task 4 shipped tests written against the belief
 * that no `HELIUS_API_KEY` was configured in this environment. One is. Every
 * function in `prices.ts` that calls out to a third party takes its `fetch`
 * as an injectable parameter defaulting to the real global — exactly so a
 * test can swap it for a stub. That default is also exactly the thing a test
 * author can forget to override. This guard makes forgetting loud instead of
 * silent and credit-spending: the *default* itself refuses to make a real
 * call, everywhere, for every test file, whether or not that file has ever
 * heard of this module.
 */

function hostOf(input: RequestInfo | URL): string {
  try {
    const url = input instanceof Request ? input.url : input;
    return new URL(url as string | URL).host;
  } catch {
    // Not a parseable URL. Say so rather than falling back to printing
    // whatever was passed in — that fallback is exactly the kind of "just
    // log it" instinct that leaks a query string on the day it matters.
    return "<unparseable request target>";
  }
}

/**
 * The original, un-patched `fetch`, captured at import time — before
 * `installNetworkGuard` overwrites `globalThis.fetch`. The one deliberate
 * escape hatch: a test that needs a real network call imports this by name
 * and passes it explicitly, so the call is visible in a diff and in the
 * test's own source rather than hidden behind an unqualified `fetch`.
 */
export const realFetch: typeof fetch = globalThis.fetch;

/**
 * Overwrites `globalThis.fetch` with one that always throws, naming the host
 * it was asked to reach. Never includes the full URL in the thrown message:
 * a host is not a secret, but a full URL can carry one — this codebase's own
 * Helius calls append `?api-key=...` — so only `URL#host` is ever surfaced.
 */
export function installNetworkGuard(): void {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    throw new Error(
      `Network access is blocked in tests (attempted call to host "${hostOf(input)}"). ` +
        `Mock fetch explicitly for this test, or pass realFetch from src/lib/network-guard.ts ` +
        `for a deliberate, named live call.`,
    );
  }) as typeof fetch;
}
