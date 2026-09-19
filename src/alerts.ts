// Surge detector behind the panel's "what just happened" log. It reads the aggregates the DO
// already computes, writes one short line when something notable happens, and makes no network
// calls: where those lines get published is a separate decision.

const MINUTE = 60_000;
const HOUR = 3_600_000;

const TERM_HOT_MIN = 8;           // mentions inside the hot window
const TERM_BURST_MIN = 10;        // multiple of the trailing rate
const TERM_HOT_WINDOW_MIN = 15;   // the window AlertInput.terms is built from, i.e. terms(15, 360)
const TERM_COOLDOWN_MS = 6 * HOUR;
const HOSTILE_MIN = 0.35;
const HOSTILE_RATIO = 1.6;
const MOOD_DELTA = 0.15;
const BARO_MIN_N = 30;            // posts behind the hot mean; fewer than this is noise, not a mood
const BARO_COOLDOWN_MS = 3 * HOUR;
const GLOBAL_COOLDOWN_MS = 30 * MINUTE;
const LOOKBACK_MS = Math.max(TERM_COOLDOWN_MS, BARO_COOLDOWN_MS);
const MAX_TEXT = 280;
const TERM_CHARS = 60;
const MAX_LIMIT = 100;

export interface AlertInput {
  at: number;
  terms: Array<{ t: string; hot: number; base: number; burst: number }>;
  baro: Record<string, { now: number | null; base: number | null; n: number }>;
  // Carried so a per-minute trigger can be added without changing the call site. Unused today.
  series: Array<{ m: number; n: number; hostile: number; sarcasm: number; bait: number; sentiment: number }>;
}

export interface Alert {
  id: number;
  ts: number;
  kind: "burst" | "hostile" | "mood";
  key: string;
  text: string;
}

interface Candidate { kind: Alert["kind"]; key: string; text: string; cooldown: number }

type AlertRow = { id: number; ts: number; kind: string; key: string; text: string };

// `siteUrl` is accepted so a publisher can append a link later; the stored text stays link-free so
// the same row renders in the panel, in a feed, or anywhere else without editing.
export function detectAlerts(sql: SqlStorage, input: AlertInput, siteUrl = "https://cloutmetrics.ai"): Alert[] {
  try {
    ensure(sql);
    const at = input.at;
    const last = sql.exec<{ ts: number | null }>("SELECT MAX(ts) AS ts FROM alerts").toArray()[0]?.ts ?? null;
    if (last !== null && at - last < GLOBAL_COOLDOWN_MS) return [];
    const seen = new Map<string, number>();
    for (const r of sql.exec<{ key: string; ts: number }>(
      "SELECT key, MAX(ts) AS ts FROM alerts WHERE ts >= ? GROUP BY key", at - LOOKBACK_MS).toArray()) {
      seen.set(r.key, r.ts);
    }
    for (const c of candidates(input)) {
      const prev = seen.get(c.key);
      if (prev !== undefined && at - prev < c.cooldown) continue;
      return [insert(sql, at, c)];
    }
    return [];
  } catch (err) {
    console.error("alerts failed", err);
    return [];
  }
}

export function recentAlerts(sql: SqlStorage, limit = 20): Alert[] {
  ensure(sql);
  const n = Math.min(Math.max(1, Math.trunc(limit) || 1), MAX_LIMIT);
  return sql.exec<AlertRow>("SELECT id, ts, kind, key, text FROM alerts ORDER BY id DESC LIMIT ?", n)
    .toArray()
    .map((r) => ({ id: r.id, ts: r.ts, kind: r.kind as Alert["kind"], key: r.key, text: r.text }));
}

// Every trigger that fires right now, in priority order. At most one of these becomes an alert.
function candidates(input: AlertInput): Candidate[] {
  const out: Candidate[] = [];
  for (const t of input.terms) {
    if (t.hot < TERM_HOT_MIN || t.burst < TERM_BURST_MIN) continue;
    out.push({
      kind: "burst",
      key: t.t,
      cooldown: TERM_COOLDOWN_MS,
      text: `"${clip(t.t, TERM_CHARS)}" is surging: ${t.hot} mentions in ${TERM_HOT_WINDOW_MIN} min, ${Math.round(t.burst)}× normal.`,
    });
  }
  const h = input.baro?.hostile;
  if (h && h.now !== null && h.base !== null && h.n >= BARO_MIN_N && h.now >= HOSTILE_MIN && h.now >= HOSTILE_RATIO * h.base) {
    out.push({
      kind: "hostile",
      key: "hostile",
      cooldown: BARO_COOLDOWN_MS,
      text: `Hostility on the wire jumped to ${pct(h.now)}% (24h average ${pct(h.base)}%).`,
    });
  }
  const s = input.baro?.sentiment;
  if (s && s.now !== null && s.base !== null && s.n >= BARO_MIN_N && Math.abs(s.now - s.base) >= MOOD_DELTA) {
    out.push({
      kind: "mood",
      key: "mood",
      cooldown: BARO_COOLDOWN_MS,
      text: `Bluesky's mood ${s.now < s.base ? "dropped" : "rose"} to ${pct(s.now)}/100 (24h average ${pct(s.base)}).`,
    });
  }
  return out;
}

function insert(sql: SqlStorage, at: number, c: Candidate): Alert {
  const text = clip(c.text, MAX_TEXT);
  const row = sql.exec<{ id: number }>(
    "INSERT INTO alerts (ts, kind, key, text) VALUES (?, ?, ?, ?) RETURNING id", at, c.kind, c.key, text).toArray()[0];
  return { id: row.id, ts: at, kind: c.kind, key: c.key, text };
}

// Cheap enough to run on every call, so the integrator needs no migration.
function ensure(sql: SqlStorage): void {
  sql.exec("CREATE TABLE IF NOT EXISTS alerts(id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, kind TEXT NOT NULL, key TEXT NOT NULL, text TEXT NOT NULL)");
}

function clip(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

function pct(x: number): number {
  return Math.round(x * 100);
}
