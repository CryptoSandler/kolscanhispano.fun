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

**`POST /api/webhooks/helius` parses a small batch after it has answered**, through Next's
`after()`. The cron stays exactly as it is and becomes the net.

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

## 3. The Helius webhooks, and which account owns what

There are **two** webhooks delivering to `https://kolscanhispano.fun/api/webhooks/helius`.

### Ours

    webhookID   b5739db9-5039-49e8-aae6-4d69f467b4ba
    project     8185e8ee-e5db-4b4c-b4ef-68dee3c5ade6
    wallet      8185e8ee-e5db-4b4c-b4ef-68dee3c5ade6
    enhanced, ["SWAP"], authHeader set, 3 addresses — all three on the roster

Created 2026-09-02 16:05:28Z by `scripts/sync-helius-webhook.ts` with this environment's
`HELIUS_API_KEY`. The first trade it delivered has a block time of **16:06:29Z**, sixty-one
seconds later.

**The key is not the one Cowork holds.** Cowork reports that the Helius project named
`kolscanhispano`, across its four keys, contains only `440aecce` — the 27 August smoke test,
already retired — and that `b5739db9` is not there. That is consistent with what the API says:
the webhook object carries `project` and `wallet`, both
`8185e8ee-e5db-4b4c-b4ef-68dee3c5ade6`, which is a different project from the one Cowork is
looking at.

**The key itself, by fingerprint** — 36 characters, begins `ce8b`, ends `1fc8` — so it can be
matched against a list of keys without being written down anywhere. Helius exposes nothing else
about a key's owner: `/v0/account`, `/v0/usage` and `/v0/me` all answer *"Method not found"*.
The `project` id above is the only identifier the API gives, and it comes from the webhook
object rather than from the key.

**Open, and the owner's:** whether to recreate this webhook under the `kolscanhispano-server`
key so that everything lives in one project. It is one run of the sync script with a different
`HELIUS_API_KEY` — it would create a webhook in that project — plus deleting this one by hand.
Nothing is blocked on it; it is tidiness, and the cost of getting it wrong is a period with two
live webhooks or none.

### Theirs

    webhookID   not visible from this environment
    URL         https://kolscanhispano.fun/api/webhooks/helius
    which one   the one pointing at that URL that is NOT b5739db9-…

It holds the correct `HELIUS_WEBHOOK_SECRET` and has been delivering since 27 August: 5,128 rows
by the time it was found, still arriving. **Not one of them touches a wallet on this roster** —
verified by scanning every stored payload, 99,817 distinct addresses, zero matches. The parser
discards them exactly as it always has, and that costs only the queue.

Deleting it is Cowork's, from the dashboard of whichever account owns it. **Nothing here depends
on it and nothing here can reach it.**

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
