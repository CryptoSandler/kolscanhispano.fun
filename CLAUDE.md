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

**There are three databases, and a migration lands in all three.** `production`,
`tests`, and `preview` — the last is what Vercel's Preview deployments read, and
it is the one that gets forgotten. Measured 2026-08-27: `preview` was five
migrations behind and every preview deployment would have met a schema it did not
have, because `scripts/migrate.mts` knew two targets and preview was neither. It
now takes `--preview`, guarded by the same distinct-from-production assertion the
`--test` path uses before it stamps its marker.

    npm run db:migrate -- --prod   # production
    npm run db:migrate:test        # tests
    npm run db:migrate:preview     # preview

**Production is named, never defaulted into.** `npm run db:migrate` with no flag
used to mean production DDL, which made the shortest command in the repo the only
unguarded one. It now refuses and asks which database you meant; the `--prod` has
to come from the keyboard, which is the whole point of it, so `package.json` does
not carry it.

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

## The author check is a gate, not a step

`/cierre`'s author check is **mandatory**. A batch does not close, and nothing is
pushed, until every commit reads:

    git log main..HEAD --format='%h  %an  <%ae>'
    # every line: CryptoSandler <294572464+CryptoSandler@users.noreply.github.com>

    git log main..HEAD --format='%(trailers)' | grep . && echo 'TRAILERS — fix first' || echo ok

This is not belt-and-braces for a config that is already correct. The config **is**
correct — `~/.gitconfig` carries an `includeIf "gitdir:~/proyectos/"` pointing at
`~/.gitconfig-cryptosandler`, verified to fire inside `~/proyectos` and not outside,
and every repo there also sets the identity locally. Four commits picked up the
personal address anyway, and the mechanism was never found.

So the rule is about the defence, not the diagnosis. A personal email in a public
repo's history is permanent and is a no-doxx leak; the check costs one command and
catches it while it is still rewritable.

**Captured 2026-08-27, the second time it bit.** Six of eight commits on a branch
carried the personal address, and the split was exact: **every commit made by a
subagent had it, every commit made by the main session did not.** Measured in the
main session's shell at the same moment, in the same working tree:

    GIT_AUTHOR_EMAIL / GIT_COMMITTER_EMAIL / EMAIL / GIT_CONFIG_GLOBAL   all unset
    git config --show-origin user.email  ->  file:.git/config  ...noreply...
    git rev-parse --absolute-git-dir     ->  /Users/fede/proyectos/kolscanhispano/.git

So the repository config is not the variable; the committing **process** is. A
subagent resolves a different identity than its parent in the same directory —
the local `.git/config` that wins here does not win there.

### The source is local config; the include is only a net

Diagnosed from the sibling repos: the ones that never leaked had `user.email`
in their **own** `.git/config`. That file is read by every process that touches
the repository, subagent included. `includeIf "gitdir:…"` is different in kind —
it is a *condition the child process must resolve*, and sometimes it does not.

So the identity is **set locally, per repository**, and the `includeIf` in
`~/.gitconfig` stays as a backstop for repositories nobody remembered to set:

    git config user.name    # no --global: empty output means it is NOT local
    git config user.email   # if either is empty or resolves via an include, fix it now

    git config --local user.name CryptoSandler
    git config --local user.email 294572464+CryptoSandler@users.noreply.github.com

Verify with `git config --show-origin user.email`: it must say `file:.git/config`,
not the include's path. **Both keys matter** — checked 2026-08-27 across the five
repositories under `~/proyectos`, one had the email locally but not the name, which
would have put the personal *name* in a public history by exactly the same route. Until that is
understood, treat any commit a subagent makes as suspect. The fix is one
`git filter-branch --env-filter` while the branch is still unpushed; it is
unavailable the moment it is public.

### Check at the source, not only at the close

The close-time gate stays, but it is the *last* line, and by then a branch may
carry dozens of commits from a dozen agents. Since the vector is known — the
subagent — the check belongs where the vector is.

**Record `git rev-parse HEAD` before dispatching an implementer. When it reports,
before anything else:**

    git log --format='%h %an <%ae>' <base>..HEAD

Every line must be `CryptoSandler <294572464+CryptoSandler@users.noreply.github.com>`.
Fix it there, on the two or three commits that agent just made, while you still
know which task they belong to and the range is small enough to read. A rewrite of
six commits across four agents is the same command but a worse moment to discover
you need it.

Two independent checks at two different times, because they fail differently: this
one catches the leak while it is one agent's work, and the close-time gate catches
anything that reached the branch by another route.

## Adding a step to a cron workflow

`.github/workflows/parse-pending.yml` is at five steps, one of them optional. That
is the limit of what reads obviously in one file.

The next addition to it justifies **in writing** — in the pull request or the batch
report — either why it belongs in that file or how the file should be split. Not a
preference: a workflow nobody can read in one pass is one where a step's ordering
dependency stops being visible, and this file already has two that matter (the
`sol_price` fill must precede the parse, and the requeue must sit between them).

## An adversarial round before building a model change

Any change to the model — what a number means, what a rule decides — and any
large product decision gets one round **without code** first. The round asks for
three things explicitly, and a round that produced only agreement did not happen:

1. **The strongest case against.** Not caveats: the argument that the change is
   wrong, made as well as its opponent would make it.
2. **The collision with the real code.** What survives contact, what gets thrown
   away, and what the repository already knows that the discussion does not. A
   design argued only against itself has never met the thing it will run in.
3. **An honest recommendation, with standing permission to say the idea is
   wrong.** A reviewer who cannot return "don't build this" is not reviewing.

Nothing is built until that round closes. Every rule in this file below was
cheaper to learn this way than the way it was actually learned.

## Every verdict cites the written norm

A gate, a critique, or a design decision is made against the normative document
**open** — `DESIGN.md`, `SECURITY.md`, `docs/spec-v1.md` — never against a memory
of what it says. A verdict that cannot quote the line it rests on is not a verdict
yet: read the document first, then rule.

This is the same rule as verifying an environment fact, applied to the documents
instead of the machine. Both failures look identical from outside — a confident
claim with nothing under it.

## Decisions with a door

When the owner is not convinced of a one-way decision — a written promise, a
prohibition in copy, a guarantee — it does not get decided for them.

- Find the **neutral wording**: the phrasing that neither promises nor forbids.
- Build the **mechanism that fits both futures**, so whichever way the decision
  later goes, the code does not have to be unwound.
- Record the policy as an **open decision belonging to the owner**, in the report
  and in the document it would live in.

Anything irreversible is written **once, and only when explicitly asked for**. A
promise published early cannot be withdrawn quietly; a mechanism built for one
future has to be rebuilt for the other. The door stays open until its owner
chooses to close it.

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

