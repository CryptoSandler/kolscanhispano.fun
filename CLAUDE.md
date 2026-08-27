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

## Kill processes by PID, never by name

`pkill -f vitest` matches every vitest in the process table, not the one you
started. Measured in another repo: one such call killed two suites belonging to
other sessions, which then reported failures with no cause anywhere in their own
logs — the most expensive kind of wrong answer, because the evidence lands in a
session that did nothing wrong.

Capture the PID when you start the process and kill that:

    npm test & PID=$!
    ...
    kill "$PID"

The same holds for `killall`, for `pkill -f next`, and for any pattern that could
match a sibling session. If you did not start it, you do not get to kill it. A
process you cannot identify by PID is one you leave alone and report.

## A branch with migrations gets its own test database

A migration changes the shape the whole suite runs against, so a branch carrying
one cannot share `tests` with every other branch: whichever branch runs second
sees the other's schema. Create a Neon branch **from `production`** — the schema
the migration will actually meet — named for the branch, point
`TEST_DATABASE_URL` at it in `.env.local`, and delete it when the branch merges.
It dies with the branch; it is not a second permanent environment.

`production` is the parent, not `tests`: branching from `tests` inherits whatever
half-applied state the last branch left, which is the thing this rule exists to
avoid.

## The suite lock goes on a direct connection

`vitest.globalSetup.ts` takes its advisory lock over the **direct** Neon endpoint,
the one without `-pooler`. Session-scoped locks do not survive PgBouncer
transaction pooling: through the pooler the lock is taken on whatever backend the
statement happened to land on and released the moment that statement returns, so
the guard silently protects nothing while continuing to look like it works.

Anything else in the suite may use the pooled endpoint. The lock may not.

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

## Verify an environment fact before writing it into a brief

A claim about this environment — a key being present or absent, a service being reachable, a
version, a table existing — is verified with a command before it is written down, and the command
goes in beside the claim. It is never asserted from memory or inference.

This rule exists because it was broken. A batch 2 brief stated "there is no `HELIUS_API_KEY` in
this environment". There was one, and it worked. Four tests were written against the false premise
and would have made real, credit-spending Helius calls on every `vitest run` — the subagent caught
it, not the author. An unverified environment fact in a brief propagates into tests that pass while
resting on it, which is the most expensive shape a wrong assumption can take here.

    # verified 2026-08-26: key present, 36 chars, getHealth -> {"result":"ok"}

