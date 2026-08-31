# Operations

Things that are true of the running system rather than of the code, and the commands
that establish them. Every number here was measured on the date beside it.

---

## The two timeouts, which defend different things

Confusing them is easy and expensive, so both are set and both are named.

| | `query_timeout` | `statement_timeout` |
|---|---|---|
| Where it runs | in `pg`, on our side | in Postgres, on Neon's side |
| What it stops | the **caller waiting** | the **server working** |
| Set in | `src/lib/db.ts`, pool option | `SET` per connection + `ALTER ROLE` |
| Value | 30 s | 30 s |

`query_timeout` alone frees the request and leaves Neon executing the statement it was
already sent — the work keeps burning compute and keeps holding whatever it holds.
`statement_timeout` alone would stop the work but leave a caller waiting on a socket.
Neither is a substitute for the other.

**30 s** because the slowest thing measured on any public surface is the KOL-detail read
at ~760 ms over four queries (audit of `20040c7`). Thirty seconds is roughly forty times
that: it cannot fire on real work, and it fires long before a runaway costs a day.

### Getting `statement_timeout` to apply took three attempts

Measured 2026-08-31 against Neon. Two of the obvious routes **do not reach a pooled
session**, which is what the application uses:

    # as a pg pool option (a startup parameter) — silently dropped
    SHOW statement_timeout  ->  0        SELECT pg_sleep(3)  ->  completes

    # in the connection string's options= — the pooler refuses to connect
    unsupported startup parameter in options: statement_timeout

    # ALTER ROLE neondb_owner SET statement_timeout = '30s'
    direct endpoint   ->  30s            pooled, 24 fresh connections  ->  0 every time

`ALTER DATABASE neondb SET statement_timeout = '30s'` fails the same way: applied, and
`0` on 12 fresh pooled connections.

What works through the pooler is an explicit `SET` on the session, issued by
`src/lib/db.ts` when it acquires a client — **on acquisition, not in
`pool.on("connect")`**. `pg` does not await a `connect` listener, so a query started
there is still in flight when the client is handed out; that shipped briefly on
2026-08-31 and killed a `parse-pending` run against production after 189 rows with
*"Client has encountered a connection error and is not queryable"*, preceded by pg's
*"client.query() when the client is already executing a query"* warning. On acquisition
it is awaited, and `max: 1` makes it one extra round trip per connection rather than per
query.

    pool session statement_timeout: 30s
    SELECT pg_sleep(35)  ->  refused at 30.0s, pool immediately usable again

Both mechanisms are kept. The `ALTER ROLE` default covers the **direct** endpoint —
migrations and the suite's advisory lock use it — and the per-connection `SET` covers the
**pooled** endpoint, which is everything the app does.

    ALTER ROLE neondb_owner SET statement_timeout = '30s';   -- applied to production and preview, 2026-08-31

### A trap worth knowing before you open psql

Through a transaction pooler a session-level `SET` can **outlive the connection that set
it**, on a shared backend, and reach the next client. It happened during this
investigation: a probe set `statement_timeout = '2s'` on production's pooled endpoint and
a later, unrelated connection read `2s` back. It was cleared with `DISCARD ALL` and
confirmed clear across 24 samples.

It is harmless for the app because every connection the pool opens sets the same value.
It is **not** harmless from a one-off session. If you `SET` anything on a pooled endpoint
by hand, `DISCARD ALL` before you disconnect.

---

## Rate limiting, and where each layer lives

`src/lib/rate-limit.ts` holds the per-minute budgets; `PUBLIC_LIMITS` carries the
reasoning for each number. Verified in production, 2026-08-31, 130 concurrent requests:

    /api/leaderboard  ->  200×120  429×10      (limit 120)
    /                 ->  200×120  429×10      (limit 120, applied by src/proxy.ts)
    /leaderboard      ->  429×130              (same `page` bucket, already spent by /)

Two things that follow from the third line: `src/proxy.ts` **does** run and **does** reach
Postgres on Vercel — the open question at merge time, now closed by behaviour rather than
by logs — and the two pages **share one bucket**.

### `/` and `/leaderboard` share the `page` bucket, and that is the decision

120 per minute is across **both pages together**, not 120 each. It is visible in the run
above: `/` spent the bucket, and `/leaderboard` was refused 130 times out of 130 in the
same minute.

**Decision, 2026-08-31: it stays shared.** A real reader does not come close. Two page
views a second, sustained for a minute, from one address, is not a person navigating —
and the pages are the cheap surface anyway: the expensive reads are behind `/api/kol`
(60/min) and `/api/feed` (240/min), which have buckets of their own and are unaffected by
anything the pages spend.

What it costs, stated so nobody rediscovers it as a bug: everything behind one corporate
or carrier NAT counts as one caller, and for those the shared bucket halves the effective
allowance. If that ever shows up, the fix is a bucket per path rather than a bigger number
— the limit is not the thing that is wrong, the sharing is.

### The Vercel firewall sits in front, not instead

Applied 2026-08-31 via the Vercel API (`PATCH /v1/security/firewall/config`, action
`rules.insert` — note **PATCH**; `PUT` is rejected with a misleading
*should NOT have additional property `action`*). Verified in the active config:

    firewallEnabled: True
    rule: public-read-ip-rate-limit | active=True | rate_limit 900/60s keys=['ip'] then 10m
       match: path pre /api/     path eq /     path eq /leaderboard

**900 per minute per IP, deliberately above every app bucket.** The highest single bucket
is `avatar` at 600, and one leaderboard view costs roughly fourteen requests, so 900 is
about sixty page loads a minute from one address. It is a flood ceiling, not a reader
ceiling: the app limiters are what shape normal traffic, and this is what stops something
that ignores them.

The two layers are kept because they fail differently. The firewall runs at the edge and
costs nothing when it denies, but it is platform configuration that no test can see and
that a migration off Vercel would silently drop. The Postgres limiter is slower and costs
a write, but it is in the suite, it is in the repository, and it survives the platform.

The limiter is a Postgres write per request. `scripts/prune-rate-limit.ts` deletes rows
older than seven days and runs every 15 minutes from `.github/workflows/recompute-dirty.yml`,
after the recompute step so a prune failure cannot block it.

---

## GitHub does not run a scheduled workflow on its schedule

Measured 2026-08-31, against cron files that ask for `*/5` and `*/15`, the gaps between
consecutive scheduled runs were:

    46, 107, 115, 272, 288 and 337 minutes

Not 5 and not 15. GitHub's scheduler is best-effort and deprioritises schedules under load,
and there is nothing to configure about it.

**Anyone sizing a batch, a budget or a backlog drain against the cron's stated cadence is
designing against a number that does not happen.** The parse cron is bounded by a
wall-clock budget per run (`scripts/parse-pending.ts`, four minutes by default), so the
drain rate is that budget times however many runs actually fire — which on the numbers
above can be four a day rather than 288. A backlog large enough to matter is drained by
hand (`PARSE_BUDGET_MS` set high, run the script locally), not by waiting for the cron.

---

## The parse holds its lock for one batch, not for one run

`withLock` takes its advisory lock on a **dedicated** connection (see `src/lib/lock.ts` for
why it may not borrow the pool), and that connection sits idle for as long as the work
inside the lock runs. Neon drops an idle connection at around five minutes, so a run long
enough kills its own lock. Measured 2026-08-31 against production:

    local run 1: 189 rows, then "Client has encountered a connection error and is not queryable"
    local run 2: 191 rows in 707 s, same failure
    CI  run 33435133074: 100 rows in 178 s -> success

That is ~1.8 s/row in CI and ~3.7 s/row locally. `scripts/parse-pending.ts` therefore loops
small locked batches — 25 rows, ~45 s in CI and ~90 s locally — releasing the lock between
each. There is deliberately **no keepalive** on the lock connection: batching needs no
timer and no reasoning about a keepalive racing the work.

---

## The three databases

`production`, `tests` and `preview` are separate Neon branches, and a migration lands in
all three. `preview` is the one that gets forgotten — it was five migrations behind on
2026-08-27, which would have failed every preview deployment at runtime.

    npm run db:migrate -- --prod    # production; the flag is required on purpose
    npm run db:migrate:test         # tests
    npm run db:migrate:preview      # preview
