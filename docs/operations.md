# Operations

What this product needs a person to know while it is running: how a trade becomes a row, what
to watch, and which external objects it depends on that are not in this repository.

---

## 1. Trade → row: the latency, and why it was hours

A trade becomes a row on the ranking through three hops:

1. **Helius delivers** the swap to `POST /api/webhooks/helius`, which stores it in `raw_tx`.
2. **The parse** turns that row into a `trade` and marks its position dirty.
3. **The recompute** replays dirty positions into `pnl_daily`, which is what the ranking reads.

Hops 2 and 3 were GitHub Actions crons and nothing else, and that is where the hours came from.
`parse-pending.yml` is scheduled every five minutes; **GitHub actually ran it at 13:36, 09:04,
04:37 and 00:09 on 2026-09-02** — roughly every three hours. That is documented throttling of
scheduled workflows, not a broken job, and `DEFAULT_BUDGET_MS`'s comment already budgets for
about four runs a day. It is a perfectly good arrangement for a backlog and the wrong one for a
live tracker: the first seventeen trades this product ever attributed all landed in a single run
that cleared a queue of 102, hours after the earliest of them happened.

### The decision: the delivery drains

**`POST /api/webhooks/helius` parses a small batch after it has answered, and replays the
positions that parse dirtied**, through Next's `after()`. Both crons stay exactly as they are
and become the net.

**Both hops, because one is not enough.** The parse writes a `trade` and marks its position
dirty; the ranking reads `pnl_daily`, which only `recomputeDirty` writes. A drain that stopped
after the parse would have moved the wait from one throttled GitHub cron to another. Each hop
takes its own cron's lock — `parse-pending` then `recompute-dirty` — never a new one.

Three options were on the table, in the owner's order of preference, and the first one wins on
every axis that matters:

| | New pieces | New secrets | Latency | Why not |
|---|---|---|---|---|
| **The delivery drains** | none | none | seconds | **chosen** |
| Vercel Cron at `*/5` | a schedule, a plan dependency | none | ≤5 min | Needs the team's plan to allow five-minute crons, and still leaves a trade waiting up to five minutes for a job that mostly finds nothing |
| `repository_dispatch` from the route | a workflow trigger, a PAT | a PAT in Vercel | ~1 min | A long-lived GitHub token in an environment that did not need one, to ask a runner to do work the function was already awake for |

**The constraint that shapes it.** Spec §5.1: Helius allows one second end to end, retries three
times a second apart, and then **loses the event permanently**. So nothing may go on the request
path. `after()` is Next's own primitive for precisely this — the response is finished, then the
callback runs, inside the route's `maxDuration`.

**What keeps it safe:**

- **The existing lock, not a new one.** The drain takes `withLock("parse-pending")`, the cron's
  own name. A delivery arriving while the cron is parsing, or while another delivery is, finds
  it held and does nothing — the holder is draining the same queue.
- **A killed function costs nothing.** `parsePending` marks each row as it finishes it, so
  partial progress persists, and the advisory lock lives on a dedicated connection the platform
  closes when it kills the function.
- **Ten rows a delivery.** ~1.8 s a row in CI and ~3.7 s locally, so ten fits inside
  `maxDuration = 60` at either rate. Ingest runs 30–60 rows an hour, so a delivery that drains
  ten keeps the queue at zero on an ordinary hour and a burst is absorbed by the next delivery.
- **It cannot fail a delivery.** It runs after the `200`, and every error becomes a log line with
  no payload in it.

## 2. The queue is the metric

`raw_tx` rows with `parsed_at IS NULL AND parse_error IS NULL`. It is the one number that says
whether ingestion is outrunning the parse, and `parse-pending` already writes it to
`setting['parse_pending_queue_depth']` on every run, with a timestamp.

**The arithmetic to keep in your head:**

- **Capacity:** about 200 rows a cron run, at roughly four runs a day — plus ten rows per
  delivery now, which is the part that actually keeps up.
- **Arrivals, 2026-09-02:** 30–60 rows an hour. Measured 2026-08-31 it was ~19.
- **It roughly halves** when the foreign webhook of §3 is deleted: that one delivers into the
  same endpoint and every row of it is discarded by the parser, because no wallet of ours has
  ever appeared in one.

A queue that grows across several readings with the delivery drain live means either a burst of
real activity or something wrong with the drain, and it is worth looking at either way.

## 3. Helius: one project, and what its API will and will not tell you

There is **one** Helius project. `HELIUS_API_KEY` in `.env.local` is the `kolscanhispano-server`
key and always was; it is loaded into Vercel Production as `HELIUS_API_KEY`, Sensitive, since
2026-09-02.

**Two identifiers for one project, and they do not match.** The API returns
`project: 8185e8ee-e5db-4b4c-b4ef-68dee3c5ade6` on a webhook object; the dashboard shows a
different identifier for the same project. Neither is wrong — they are different names for the
same thing, and reading one as evidence about the other is what caused the incident below.

**The webhook list is not reliable, in either surface.** `GET /v0/webhooks` has returned `[]`
for a webhook that existed, and the dashboard's list fails the same way. **Existence is checked
by id and only by id:**

    GET https://api.helius.xyz/v0/webhooks/<id>?api-key=<key>

`syncHeliusWebhook` does exactly this before it concludes anything, which is why §4 exists.

### The webhook

    webhookID   b5739db9-5039-49e8-aae6-4d69f467b4ba
    project     8185e8ee-e5db-4b4c-b4ef-68dee3c5ade6   (the API's id for it)
    enhanced, ["SWAP"], authHeader set, 3 addresses — all three on the roster

Created 2026-09-02 16:05:28Z by `scripts/sync-helius-webhook.ts`. The first trade it delivered
has a block time of 16:06:29Z, sixty-one seconds later.

There is also a second webhook delivering to the same endpoint with the correct secret, since
27 August: 5,128 rows by the time it was found, still arriving, and **not one of them touches a
wallet on this roster** — verified by scanning every stored payload, 99,817 distinct addresses,
zero matches. `raw_tx`'s primary key is `(chain, signature_hmac)` — read from production's own
`pg_constraint`, not from the migration file — and `storeRawTxBatch` inserts
`ON CONFLICT ... DO NOTHING`, so a transaction delivered by both is one row. What doubles is
deliveries, not data. Deleting it is a dashboard action and nothing here depends on it.

### The false alarm of 2026-09-02, and its cause

For part of that day this document said there were two Helius projects and that a migration was
needed. **There are not, and it was not.** The cause was a chain of three unreliable signals
read as one story:

1. `GET /v0/webhooks` answered `[]` — the list is unreliable, as above.
2. The dashboard listed a different set, and showed a project identifier that does not match the
   API's, so the two looked like different projects.
3. A `HELIUS_API_KEY_SERVER` was added to `.env.local` as "the other key" and was byte-identical
   to `HELIUS_API_KEY` — same 36 characters, same `ce8b…1fc8` fingerprint, same SHA-256. It was
   the same key because there was only ever one.

**No migration was run, and that was the right call for the wrong reason.** The check that
stopped it — with the intended key, `GET /v0/webhooks/<stored id>` must answer `404`, and it
answered `200` — was reading the one endpoint that does **not** enforce project scoping (see the
defect below). It stopped a destructive sequence, and the reasoning under it was wrong.

`HELIUS_API_KEY_SERVER` has been removed from `.env.local`. There is one key and one project.

### Open defect: the address set is frozen

**`PUT /v0/webhooks/<id>` answers `404 "Webhook not found for this project"` for a webhook that
`GET /v0/webhooks/<id>` returns `200` for.** Measured 2026-09-02 at 21:34 from the deployed
admin and reproduced by hand immediately after, with the same key that **created** that webhook
at 16:05 and successfully edited it at 16:08.

So the two verbs disagree: the read does not scope to the key's project and the write does.
Whatever changed between 16:08 and 21:34 — a key moved between projects, a project renamed —
the consequence is exact and it is live:

**Any change to the roster now fails to reach Helius.** Approving, suspending or adding a wallet
recomputes the set, tries the edit, gets a 404, and `syncHeliusWebhook` refuses to store the
hash — which is the behaviour it was written for, so nothing is silently wrong, but the webhook
stays at the three addresses it has. It was seen exactly this way: a fourth wallet approved
through the deployed admin left the database at four and Helius at three, with
`not synced — helius_failed` in the log.

The escape is the one the create path already offers: **`POST` still works** — it is how
`b5739db9` came to exist — so deleting the stored `setting` row makes the next sync create a
webhook the key can edit, after which the old one is deleted from the dashboard. That is a
destructive-ish sequence with a window in it, and it is the owner's call, not this document's.

## 4. The webhook can vanish, and the hash will not notice

`setting['helius_webhook_address_hash']` guards the address *set*. It says nothing about the
webhook existing.

Measured 2026-09-02, two hours after ours was created: `GET /v0/webhooks` answered `[]` while
`GET /v0/webhooks/<id>` answered `200` with all three addresses. **The list endpoint is not a
summary, it is inconsistent** — anything checking this webhook must ask for the object by id.

So `syncHeliusWebhook` confirms existence by id before it concludes "unchanged", and a webhook
that is gone is **created** rather than edited: a `PUT` against an id Helius has forgotten
answers 404 for ever. That is one read per roster mutation, and spec §5.4 carries the amendment.

Helius also auto-disables failing webhooks on the free plan (spec §5.1). Running
`npx tsx scripts/sync-helius-webhook.ts` is the cheapest way to ask whether the webhook is still
there and still holds the roster.
