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

What works through the pooler is an explicit `SET` on the session, so `src/lib/db.ts`
issues one on every new connection:

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
by logs — and the two pages **share one bucket**, so 120/min is across both, not each.

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

## The three databases

`production`, `tests` and `preview` are separate Neon branches, and a migration lands in
all three. `preview` is the one that gets forgotten — it was five migrations behind on
2026-08-27, which would have failed every preview deployment at runtime.

    npm run db:migrate -- --prod    # production; the flag is required on purpose
    npm run db:migrate:test         # tests
    npm run db:migrate:preview      # preview
