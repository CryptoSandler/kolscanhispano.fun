# kolscanhispano.fun

Every message you send to the user starts with the line `[kolscanhispano.fun]` on its own, before anything else, so the user can tell which project is talking when several Claude Code sessions run in parallel.

## Project

kolscan.io for the Spanish-speaking community (Spain + Latam), the way kolscanbrasil.io is for Brazil. The domain is the brand.

## Conventions

- Site UI copy: neutral Spanish (not Rioplatense).
- Code, comments, commits, and docs: English.
- No-doxx: no real names, no personal data, no author identity beyond the GitHub account `CryptoSandler`.

## Stack

Next.js 16 (App Router, Turbopack) + Postgres (Neon) + Vercel. Next 16 has breaking changes against
what most models were trained on — APIs, conventions and file structure all differ. Read the
relevant guide in `node_modules/next/dist/docs/` before writing App Router code, and heed its
deprecation notices. `next.config.ts` sets `agentRules: false`, which is why this file is not
maintaining that pointer itself: `next dev` otherwise rewrites this file on every run.

## One session per working tree

A second Claude Code session on this repo gets its own `git worktree`. Never
two in the same checkout.

Sessions in a shared checkout write over each other with no signal that it
happened. Measured on 2026-08-26: a second session replaced a migration with
`SELECT 1;` for a mutation test while another session was benchmarking the
suite, so three tests failed in a run that had nothing to do with them, and
the benchmark it was measuring became unreadable. Neither session did
anything wrong on its own. `git status` in a shared checkout shows both
sessions' edits as one indistinguishable set of changes, and the branch a
session thinks it is on is the branch every other session is also on.

The suite lock in `vitest.globalSetup.ts` only guards the database. Nothing
guards the files.

## Never run two suites of this repo at once

`npm test` truncates shared tables in a single Neon database, so two runs
delete each other's fixtures mid-assertion. Measured directly: six concurrent
single-file runs with the guard off produced failures in five of them; the
same runs with it on were clean. One uncoordinated pair cost 28 minutes of
wall clock against 270 seconds of actual test time.

`vitest.globalSetup.ts` takes a run-scoped Postgres advisory lock, so a second
run now *queues* behind the first rather than corrupting it — it is a
backstop, not a licence. Don't start a suite in one session while another
session is running one: the second just sits there, and a session waiting
20 minutes on a lock looks exactly like a session that has hung.

## Default posture: lazy senior

A skill only fires when the model judges it relevant, and this applies to every change, so
the short version lives here rather than in `~/.claude/skills/ponytail/`.

Before writing code, climb until a rung holds, and stop at the first one that does:

1. Does this need to exist at all? Speculative need: skip it, and say so in one line.
2. Does this repo already have it? Reusing what lives a few files over beats re-implementing it.
3. Does the standard library do it?
4. Does a native platform feature cover it? A DB constraint over app code, CSS over JS.
5. Does an already-installed dependency solve it? Never add one for what a few lines cover.
6. Can it be one line?

If no rung holds, write the minimum that works.

The level here is **lite**: build what was asked, and name the lazier alternative in one
line so the choice stays with the user. Nothing gets silently downscoped into something
smaller than what was requested.

Every deliberate shortcut carries a comment naming its ceiling and its upgrade path, so the
next reader knows it was a decision and not an oversight:

    // ponytail: linear scan, index it if the list outgrows a few hundred entries

Four things are never simplified away, at any level: input validation at trust boundaries,
security, error handling that prevents data loss, and accessibility basics. Laziness governs
how much code gets written. It never governs what that code is allowed to skip.
