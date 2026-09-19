# Alerts

`src/alerts.ts` turns the numbers the panel already computes into a short "what
just happened" log: one line when a term takes off, when the wire turns hostile,
or when the mood moves. It reads and writes SQLite and nothing else — no fetch,
no webhook, no feed. Publishing those lines anywhere is a separate decision (see
the bottom of this page).

## Triggers

Evaluated in this order. At most one alert is recorded per call; the rest wait
for the next one.

| kind | fires when | key | cooldown |
|---|---|---|---|
| `burst` | a term has `hot >= 8` mentions and `burst >= 10`× its trailing rate | the term | 6h |
| `hostile` | `baro.hostile.now >= 0.35` and `>= 1.6 ×` its 24h average, `n >= 30` | `hostile` | 3h |
| `mood` | `\|baro.sentiment.now - base\| >= 0.15`, `n >= 30` | `mood` | 3h |

On top of the per-key cooldowns there is a **30-minute global cooldown**: no new
alert of any kind within half an hour of the previous one. Cooldowns are
exclusive, so an alert exactly one cooldown after the last one is allowed.

Every threshold above is a named constant at the top of the file. The burst line
says "in 15 min" because `AlertInput.terms` is what `terms(15, 360)` returns; if
you change that call, change `TERM_HOT_WINDOW_MIN` with it.

Text is capped at 280 characters so a line fits anywhere, and a long term is
clipped with an ellipsis rather than eating the sentence. Typical output:

```
"climate" is surging: 42 mentions in 15 min, 12× normal.
Hostility on the wire jumped to 41% (24h average 22%).
Bluesky's mood dropped to 38/100 (24h average 53).
```

## Storage

```sql
CREATE TABLE IF NOT EXISTS alerts(id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, kind TEXT NOT NULL, key TEXT NOT NULL, text TEXT NOT NULL)
```

Created on first use, so there is no migration step. `detectAlerts` never throws:
a broken read or write is logged and returns no alerts.

## Wiring it in

In the DO's `alarm()`, once per heartbeat:

```ts
import { detectAlerts, recentAlerts } from "./alerts";

const fresh = detectAlerts(this.ctx.storage.sql, { at: now, terms: this.terms(15, 360), baro: this.baro(now), series: this.series(60) });
if (fresh.length) this.broadcast({ type: "alert", alert: fresh[0] });
```

And in `fetch()`, for the panel's log and anything reading it later:

```ts
case "/api/alerts": return json(recentAlerts(this.ctx.storage.sql));
```

`recentAlerts(sql, limit = 20)` returns newest first, capped at 100.

`series` is carried in `AlertInput` so a per-minute trigger can be added without
touching the call site; nothing reads it today.

## Publishing

This module detects and records. It deliberately has no way to post anywhere: an
RSS or JSON feed built from `recentAlerts`, a Bluesky account that echoes the
log, or a webhook are all separate work, and whether the alerts should be
published at all is the owner's call. `detectAlerts` takes a `siteUrl` so a
future publisher can append a link; the stored text stays link-free, so the same
row renders in the panel and in a feed without editing.
