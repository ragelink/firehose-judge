# What the deploy costs

[`src/costs.ts`](../src/costs.ts) pulls this Worker's live usage out of Cloudflare's
[GraphQL Analytics API](https://developers.cloudflare.com/analytics/graphql-api/) and prices it against
the published rates, so the page can show what the hosting costs next to what Jev costs. Three windows:
UTC today, the last seven days, the last thirty. One HTTP request, cached for five minutes.

```ts
const costs = await cloudflareCosts(env);
// { today: { requests, cpuMs, doRequests, doDurationGbS, doStorageGb, r2ClassA, r2ClassB,
//            r2StorageGb, estimatedUsd, breakdown }, week: {...}, month: {...}, fetchedAt }
// or { error: "..." } — it never throws and never rejects.
```

## Set it up

**1. Create a read-only analytics token.** In the Cloudflare dashboard go to
[**Account API tokens**](https://dash.cloudflare.com/?to=/:account/api-tokens) (on older dashboards,
**My Profile → API Tokens**) → **Create Token** → **Custom token → Get started**. Then:

| Field | Value |
|---|---|
| Token name | `firehose-judge costs` |
| Permissions | **Account** · **Account Analytics** · **Read** |
| Account Resources | **Include** · the CONFLICT LLC account |
| Zone Resources | leave as is; the query is account-scoped |
| TTL | your call — the code reports the API's error verbatim when a token expires |

`Account Analytics: Read` is the only permission the
[token docs](https://developers.cloudflare.com/analytics/graphql-api/getting-started/authentication/api-token-auth/)
ask for, and it covers the Worker, Durable Object and R2 datasets. It does **not** grant the ability to
read code, secrets or bucket contents. If the R2 half of the query ever comes back unauthorised the
code drops R2 to `null` rather than failing, and you can add **Workers R2 Storage · Read** to the token.

**2. Store the token.**

```bash
npx wrangler secret put CF_ANALYTICS_TOKEN
```

For `wrangler dev`, put it in `.dev.vars` instead — that file is gitignored.

**3. Add the two plain vars** to `wrangler.jsonc` (neither is secret; the account id is the 32-hex id in
every dashboard URL):

```jsonc
"vars": {
  "CF_ACCOUNT_ID": "<32-hex account id>",
  "CF_SCRIPT_NAME": "firehose-judge"
}
```

`CF_SCRIPT_NAME` defaults to `firehose-judge` if unset. `CF_ANALYTICS_TOKEN` is a secret, so
`wrangler types` cannot see it — declare it on the `SecretEnv` interface in `src/index.ts` the way
`TYPESAFE_API_KEY` already is.

## Serve it

`cloudflareCosts` needs `fetch`, so call it from the Worker, not from inside the Durable Object, and put
it ahead of the `/api/` hand-off in `src/index.ts`:

```ts
import { cloudflareCosts } from "./costs";

if (pathname === "/api/costs") {
  const costs = await cloudflareCosts(env);
  return Response.json(costs, { status: "error" in costs ? 502 : 200 });
}
```

The five-minute cache is module state, so it is per isolate: a busy deploy makes one analytics call per
isolate per five minutes, not one per page view.

## What it reads

| Dataset | Fields | Feeds |
|---|---|---|
| `workersInvocationsAdaptive` | `sum.requests`, `sum.cpuTimeUs` | `requests`, `cpuMs` |
| `durableObjectsInvocationsAdaptiveGroups` | `sum.requests`, `dimensions.namespaceId` | `doRequests` |
| `durableObjectsPeriodicGroups` | `sum.duration` | `doDurationGbS` |
| `durableObjectsSqlStorageGroups` | `max.storedBytes` | `doStorageGb` |
| `r2OperationsAdaptiveGroups` | `sum.requests`, `dimensions.actionType` | `r2ClassA`, `r2ClassB` |
| `r2StorageAdaptiveGroups` | `max.payloadSize`, `max.metadataSize` | `r2StorageGb` |

Field names came from schema
[introspection](https://developers.cloudflare.com/analytics/graphql-api/features/discovery/introspection/)
against the live account on 2026-09-19, not from the doc pages, which lag. Three of them are easy to get
wrong:

- **`cpuTimeUs` is microseconds.** The Workers `sum` has no `cpuTime`; divide by 1000 for CPU-ms.
- **`durableObjectsPeriodicGroups.sum.duration` is already GB-seconds**, exactly
  `activeTime_µs / 1e6 × 0.128` — Cloudflare counts a GB as 10⁹ bytes and bills the flat 128 MB
  allocation. Do not compute duration from the invocations dataset's `wallTime`: that counts wall time
  on hibernating WebSockets, which Cloudflare
  [does not bill](https://developers.cloudflare.com/durable-objects/platform/pricing/#compute-billing),
  and on this deploy it reads about four times high.
- **`durableObjectsSqlStorageGroups` is the SQLite backend.** `durableObjectsStorageGroups` is the
  key-value one and returns nothing here. `Firehose` is declared in `new_sqlite_classes`.

`durableObjectsPeriodicGroups` and `durableObjectsSqlStorageGroups` have no `scriptName` filter — they
only take `namespaceId` — so the query groups them by `namespaceId` and keeps the namespaces that this
script's invocations reported. Without that, every other Durable Object on the account lands in the
total.

## The exact query

Paste this into a GraphQL client with the variables below to see the raw numbers behind an estimate.

```graphql
query FirehoseCosts($account: string!, $script: string!, $bucket: string!, $todayStart: string!, $weekStart: string!, $monthStart: string!, $end: string!) {
  viewer {
    accounts(filter: { accountTag: $account }) {
      todayWorkers: workersInvocationsAdaptive(limit: 1, filter: { scriptName: $script, datetime_geq: $todayStart, datetime_leq: $end }) { sum { requests cpuTimeUs } }
      todayDo: durableObjectsInvocationsAdaptiveGroups(limit: 100, filter: { scriptName: $script, datetime_geq: $todayStart, datetime_leq: $end }) { sum { requests } dimensions { namespaceId } }
      todayDoDuration: durableObjectsPeriodicGroups(limit: 100, filter: { datetime_geq: $todayStart, datetime_leq: $end }) { sum { duration } dimensions { namespaceId } }
      todayDoStorage: durableObjectsSqlStorageGroups(limit: 100, filter: { datetime_geq: $todayStart, datetime_leq: $end }) { max { storedBytes } dimensions { namespaceId } }
      todayR2Ops: r2OperationsAdaptiveGroups(limit: 100, filter: { bucketName: $bucket, datetime_geq: $todayStart, datetime_leq: $end }) { sum { requests } dimensions { actionType } }
      todayR2Storage: r2StorageAdaptiveGroups(limit: 1, filter: { bucketName: $bucket, datetime_geq: $todayStart, datetime_leq: $end }) { max { payloadSize metadataSize } }
      weekWorkers: workersInvocationsAdaptive(limit: 1, filter: { scriptName: $script, datetime_geq: $weekStart, datetime_leq: $end }) { sum { requests cpuTimeUs } }
      weekDo: durableObjectsInvocationsAdaptiveGroups(limit: 100, filter: { scriptName: $script, datetime_geq: $weekStart, datetime_leq: $end }) { sum { requests } dimensions { namespaceId } }
      weekDoDuration: durableObjectsPeriodicGroups(limit: 100, filter: { datetime_geq: $weekStart, datetime_leq: $end }) { sum { duration } dimensions { namespaceId } }
      weekDoStorage: durableObjectsSqlStorageGroups(limit: 100, filter: { datetime_geq: $weekStart, datetime_leq: $end }) { max { storedBytes } dimensions { namespaceId } }
      weekR2Ops: r2OperationsAdaptiveGroups(limit: 100, filter: { bucketName: $bucket, datetime_geq: $weekStart, datetime_leq: $end }) { sum { requests } dimensions { actionType } }
      weekR2Storage: r2StorageAdaptiveGroups(limit: 1, filter: { bucketName: $bucket, datetime_geq: $weekStart, datetime_leq: $end }) { max { payloadSize metadataSize } }
      monthWorkers: workersInvocationsAdaptive(limit: 1, filter: { scriptName: $script, datetime_geq: $monthStart, datetime_leq: $end }) { sum { requests cpuTimeUs } }
      monthDo: durableObjectsInvocationsAdaptiveGroups(limit: 100, filter: { scriptName: $script, datetime_geq: $monthStart, datetime_leq: $end }) { sum { requests } dimensions { namespaceId } }
      monthDoDuration: durableObjectsPeriodicGroups(limit: 100, filter: { datetime_geq: $monthStart, datetime_leq: $end }) { sum { duration } dimensions { namespaceId } }
      monthDoStorage: durableObjectsSqlStorageGroups(limit: 100, filter: { datetime_geq: $monthStart, datetime_leq: $end }) { max { storedBytes } dimensions { namespaceId } }
      monthR2Ops: r2OperationsAdaptiveGroups(limit: 100, filter: { bucketName: $bucket, datetime_geq: $monthStart, datetime_leq: $end }) { sum { requests } dimensions { actionType } }
      monthR2Storage: r2StorageAdaptiveGroups(limit: 1, filter: { bucketName: $bucket, datetime_geq: $monthStart, datetime_leq: $end }) { max { payloadSize metadataSize } }
    }
  }
}
```

```json
{
  "account": "<32-hex account id>",
  "script": "firehose-judge",
  "bucket": "cloutmetrics-archive",
  "todayStart": "2026-09-19T00:00:00.000Z",
  "weekStart": "2026-09-12T12:30:00.000Z",
  "monthStart": "2026-08-20T12:30:00.000Z",
  "end": "2026-09-19T12:30:00.000Z"
}
```

By hand:

```bash
curl -s https://api.cloudflare.com/client/v4/graphql \
  -H "Authorization: Bearer $CF_ANALYTICS_TOKEN" \
  -H "Content-Type: application/json" \
  --data @query.json | jq .
```

The variable types are the API's own lowercase scalars (`string!`), not GraphQL's `String!`. An account
with no R2 bucket of that name returns `[]` for the two R2 aliases and no error.

## What it charges

Rates read on 2026-09-19 from
[Workers](https://developers.cloudflare.com/workers/platform/pricing/),
[Durable Objects](https://developers.cloudflare.com/durable-objects/platform/pricing/) and
[R2](https://developers.cloudflare.com/r2/pricing/) pricing; they live in the `PRICING` const.

| Line | Included per month | Over that |
|---|---|---|
| `plan` | — | $5.00/month, always charged, prorated by window |
| `workerRequests` | 10,000,000 | $0.30 per million |
| `workerCpu` | 30,000,000 CPU-ms | $0.02 per million |
| `doRequests` | 1,000,000 | $0.15 per million |
| `doDuration` | 400,000 GB-s | $12.50 per million GB-s |
| `doStorage` | 5 GB-month (SQLite backend) | $0.20 per GB-month |
| `r2ClassA` | 1,000,000 | $4.50 per million |
| `r2ClassB` | 10,000,000 | $0.36 per million |
| `r2Storage` | 10 GB-month | $0.015 per GB-month |

`estimateUsd` prorates every monthly allowance to the window — a one-day window gets a thirtieth of the
quota and a thirtieth of the $5 — and returns the per-line `breakdown` alongside the total. Lines for
products with no data (`null` fields) are left out of the breakdown entirely.

The second argument decides whether the allowances apply:

```ts
estimateUsd(usage, true)   // what the deploy costs if it owns the plan
estimateUsd(usage, false)  // what it adds to a bill whose allowances other Workers already spend
```

That second number is the honest one on a shared account: the 10M requests and 400k GB-s are
account-wide, and this account runs thirty-odd other Workers.

## Where the estimate and the invoice differ

- **Cloudflare rounds billable units up to the next million** before applying a rate (500,000 billable
  GB-s bills as 1,000,000). This estimate is linear, so small overages read low.
- **Requests to static assets are free and unlimited**, but they are not broken out of
  `workersInvocationsAdaptive`, so `requests` reads high on an asset-heavy day.
- **Incoming WebSocket messages bill at 20:1** for Durable Object requests. The analytics datasets
  report actual counts, so `doRequests` reads up to twenty times the billed figure for a socket-heavy
  window.
- **`durableObjectsPeriodicGroups` lags a few minutes**, so the current hour always looks cheap.
- **SQLite storage billing started 2026-01-07**; rows read and written are billed separately
  (`sum.rowsRead`, `sum.rowsWritten` on the same dataset) and are not in this estimate yet.
- Analytics are usage, not billing. Cloudflare says so
  [itself](https://developers.cloudflare.com/analytics/graphql-api/#limitations): use the dashboard for
  what you actually owe.
