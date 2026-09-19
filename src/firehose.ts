import { DurableObject } from "cloudflare:workers";
import { judge, needsReview, confidenceOf, QUESTIONS, REVIEW_THRESHOLD, type Answer } from "./jev";
import { extractTerms } from "./terms";
import { detectAlerts, recentAlerts } from "./alerts";

const HEARTBEAT_MS = 15_000;
const PANEL_EVERY_MS = 4_000;
const RECENT_LIMIT = 40;
const LATENCY_WINDOW = 200;
const NSFW_DROP = 0.6;
const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const RAW_RETENTION = 7 * DAY;
const EDGE_RETENTION = DAY;
const PRUNE_EVERY = HOUR;
const EDGE_TERMS = 6;
const VOTES_PER_MIN = 20;
const METER_EVERY_MS = 30_000;
const CURVE_CACHE_MS = 60_000;
const CURVE_STEPS = 20;
const ARCHIVE_AFTER_MS = 10 * MINUTE;
const ARCHIVE_PAGE = 5000;
const PART_MIN = 5 << 20;
const MULTIPART_ABOVE = 20 << 20;
const BADGE_LABEL = "bluesky mood";
const BACKER_MESSAGE_MAX = 280;
const BACKER_NSFW = 0.6;
const BACKER_HOSTILE = 0.6;
// Columns added after the first deploy: the live DO and any local state keep the rows they already have.
const LATE_COLUMNS: [string, string, string][] = [
  ["judgments", "sentiment_conf", "REAL"],
  ["judgments", "bait_conf", "REAL"],
  ["votes", "conf", "REAL"],
  ["contributions", "name", "TEXT"],
  ["contributions", "message", "TEXT"],
  ["contributions", "judged", "TEXT"],
  ["contributions", "approved", "INTEGER NOT NULL DEFAULT 0"],
];

interface JetstreamEvent {
  did: string;
  kind: string;
  commit?: {
    operation: string;
    collection: string;
    rkey: string;
    record?: { text?: string; langs?: string[] };
  };
}

export interface JudgedPost {
  id: string;
  url: string;
  text: string;
  at: number;
  latencyMs: number;
  inputTokens: number;
  answers: Record<string, Answer>;
  review: string[];
}

export interface Funding {
  link: string;
  today: number;
  week: number;
  month: number;
  costToday: number;
  costWeek: number;
  costMonth: number;
  goalUsd: number;
  raisedMonth: number;
}

export interface Stats {
  judged: number;
  filtered: number;
  reviewed: number;
  votes: number;
  retries: number;
  inputTokens: number;
  costUsd: number;
  medianLatencyMs: number;
  seenPerSec: number;
  viewers: number;
  live: boolean;
  ratePerSec: number;
  idleRatePerSec: number;
  model: string;
  hist: Record<string, Record<string, number>>;
  budget: { usdPerDay: number; spent24h: number; paused: boolean };
  funding: Funding;
  ads: { client: string; slot: string };
}

interface Curve {
  n: number;
  votes: number;
  points: { c: number; noul: number; score: number; reviewShare: number; confidentVotes: number; confidentAgree: number | null }[];
}

type Row = Record<string, string | number | null>;
type PostRow = { id: string; ts: number; url: string; text: string; json: string; review: string; latency: number; tokens: number };
type HourlyRow = {
  hour: number; n: number; reviewed: number; dropped: number; tokens: number; latency_sum: number;
  sentiment_sum: number; bait_sum: number; hostile_sum: number; sarcasm_sum: number; bot_sum: number;
};

interface Attachment { votes: number; since: number }

export class Firehose extends DurableObject<Env> {
  private upstream: WebSocket | null = null;
  private connecting = false;
  private inflight = 0;
  private allowance = 0;
  private lastRefill = Date.now();
  private latencies: number[] = [];
  private seen = 0;
  private sessionStart = Date.now();
  private model = "";
  private lastPanelAt = 0;
  private meteredAt = 0;
  private spent24h = 0;
  private paused = false;
  private funding: Funding = { link: "", today: 0, week: 0, month: 0, costToday: 0, costWeek: 0, costMonth: 0, goalUsd: 0, raisedMonth: 0 };
  private curveCache: { minutes: number; at: number; data: Curve } | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      const sql = ctx.storage.sql;
      sql.exec(`
        CREATE TABLE IF NOT EXISTS counters (k TEXT PRIMARY KEY, v REAL NOT NULL);
        CREATE TABLE IF NOT EXISTS hist (dim TEXT, k TEXT, n INTEGER NOT NULL, PRIMARY KEY (dim, k));
        CREATE TABLE IF NOT EXISTS judgments (
          id TEXT PRIMARY KEY, ts INTEGER NOT NULL, url TEXT, text TEXT, json TEXT,
          intent TEXT, topic TEXT, intent_conf REAL, topic_conf REAL,
          sentiment REAL, bait REAL, hostile REAL, sarcasm REAL, bot REAL, nsfw REAL,
          review TEXT, latency INTEGER, tokens INTEGER, dropped INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS judgments_ts ON judgments (ts);
        CREATE TABLE IF NOT EXISTS terms (minute INTEGER, term TEXT, n INTEGER NOT NULL, PRIMARY KEY (minute, term));
        CREATE INDEX IF NOT EXISTS terms_minute ON terms (minute);
        CREATE TABLE IF NOT EXISTS edges (hour INTEGER, a TEXT, b TEXT, n INTEGER NOT NULL, PRIMARY KEY (hour, a, b));
        CREATE INDEX IF NOT EXISTS edges_hour ON edges (hour);
        CREATE TABLE IF NOT EXISTS votes (
          id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, post_id TEXT, question TEXT,
          model_p REAL, model_answer TEXT, flagged INTEGER NOT NULL DEFAULT 1, agree INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS hourly (
          hour INTEGER PRIMARY KEY, n INTEGER NOT NULL DEFAULT 0, reviewed INTEGER NOT NULL DEFAULT 0, dropped INTEGER NOT NULL DEFAULT 0,
          tokens INTEGER NOT NULL DEFAULT 0, latency_sum INTEGER NOT NULL DEFAULT 0, sentiment_sum REAL NOT NULL DEFAULT 0,
          bait_sum REAL NOT NULL DEFAULT 0, hostile_sum REAL NOT NULL DEFAULT 0, sarcasm_sum REAL NOT NULL DEFAULT 0, bot_sum REAL NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS hourly_intent (hour INTEGER, k TEXT, n INTEGER NOT NULL, PRIMARY KEY (hour, k));
        CREATE TABLE IF NOT EXISTS hourly_topic (hour INTEGER, k TEXT, n INTEGER NOT NULL, PRIMARY KEY (hour, k));
        CREATE TABLE IF NOT EXISTS contributions (
          id TEXT PRIMARY KEY, ts INTEGER NOT NULL, amount_cents INTEGER NOT NULL, currency TEXT,
          name TEXT, message TEXT, judged TEXT, approved INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS contributions_ts ON contributions (ts);
        DROP TABLE IF EXISTS recent;
      `);
      // Tables that already exist keep their rows, so late columns are added in place.
      const columns = new Map<string, Set<string>>();
      for (const [table, column, decl] of LATE_COLUMNS) {
        let have = columns.get(table);
        if (!have) columns.set(table, (have = new Set(sql.exec<{ name: string }>(`PRAGMA table_info(${table})`).toArray().map((c) => c.name))));
        if (have.has(column)) continue;
        sql.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
        have.add(column);
      }
    });
  }

  // ---- http + websocket entry ---------------------------------------------

  async fetch(request: Request): Promise<Response> {
    const { pathname, searchParams } = new URL(request.url);
    if (request.headers.get("Upgrade") === "websocket") return this.acceptViewer();
    const minutes = Math.min(7 * 24 * 60, Math.max(1, Number(searchParams.get("minutes") || 60)));
    switch (pathname) {
      case "/api/stats": return json(this.stats());
      case "/api/panel": return json(this.panel());
      case "/api/series": return json(this.series(minutes));
      case "/api/terms": return json(this.terms(minutes, Math.max(minutes * 6, 360)));
      case "/api/graph": return json(this.graph(minutes));
      case "/api/votes": return json(this.calibration());
      case "/api/crosstab": return json(this.crosstab(searchParams.get("rows") || "topic", searchParams.get("cols") || "intent", minutes));
      case "/api/export.ndjson": return this.exportNdjson(Number(searchParams.get("since") || 0), Number(searchParams.get("limit") || 5000));
      case "/api/curve": return json(this.curve(searchParams.has("minutes") ? minutes : 1440));
      case "/api/posts": return json(this.posts(minutes, searchParams.get("term"), searchParams.get("intent"), searchParams.get("topic"), Number(searchParams.get("limit") || 30)));
      case "/api/hourly": return json(this.hourly(Number(searchParams.get("hours") || 720)));
      case "/api/archive": return this.archiveList();
      case "/api/funding": this.meter(); return json(this.funding);
      case "/api/backers": return json(this.backers());
      case "/api/alerts": return json(recentAlerts(this.ctx.storage.sql));
      case "/badge.svg": return this.badge();
    }
    return new Response("not found", { status: 404, headers: { "Access-Control-Allow-Origin": "*" } });
  }

  private async acceptViewer(): Promise<Response> {
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[0]);
    pair[0].serializeAttachment({ votes: 0, since: Date.now() } satisfies Attachment);
    pair[0].send(JSON.stringify({
      type: "hello", stats: this.stats(), recent: this.recent(), questions: QUESTIONS, thresholds: REVIEW_THRESHOLD, panel: this.panel(),
    }));
    this.broadcast({ type: "stats", stats: this.stats() });
    await this.ensureUpstream();
    await this.ctx.storage.setAlarm(Date.now() + HEARTBEAT_MS);
    return new Response(null, { status: 101, webSocket: pair[1] });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    if (typeof raw !== "string") return;
    let msg: { type?: string; postId?: string; question?: string; agree?: boolean };
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.type !== "vote" || typeof msg.postId !== "string" || typeof msg.question !== "string" || typeof msg.agree !== "boolean") return;
    const att = (ws.deserializeAttachment() as Attachment | null) ?? { votes: 0, since: Date.now() };
    if (Date.now() - att.since > MINUTE) { att.votes = 0; att.since = Date.now(); }
    if (att.votes >= VOTES_PER_MIN) return;
    att.votes++;
    ws.serializeAttachment(att);
    this.recordVote(msg.postId, msg.question, msg.agree);
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    ws.close();
    this.broadcast({ type: "stats", stats: this.stats() });
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    ws.close();
  }

  private viewers(): number {
    return this.ctx.getWebSockets().length;
  }

  private broadcast(msg: unknown): void {
    const s = JSON.stringify(msg);
    for (const ws of this.ctx.getWebSockets()) {
      try { ws.send(s); } catch { /* closing */ }
    }
  }

  // ---- heartbeat ------------------------------------------------------------

  async alarm(): Promise<void> {
    this.maybePrune();
    try { await this.maybeArchive(); } catch (err) { console.error("archive failed", err); }
    if (this.viewers() === 0 && Number(this.env.IDLE_RATE_PER_SEC) <= 0) {
      this.closeUpstream();
      return;
    }
    await this.ensureUpstream();
    const now = Date.now();
    const fresh = detectAlerts(this.ctx.storage.sql, { at: now, terms: this.terms(15, 360), baro: this.baro(now), series: this.series(60) });
    if (fresh.length) this.broadcast({ type: "alert", alert: fresh[0] });
    if (this.viewers() > 0) this.broadcast({ type: "stats", stats: this.stats() });
    await this.ctx.storage.setAlarm(Date.now() + HEARTBEAT_MS);
  }

  private maybePrune(): void {
    const now = Date.now();
    if (now - this.counter("last_prune") < PRUNE_EVERY) return;
    const sql = this.ctx.storage.sql;
    sql.exec("DELETE FROM judgments WHERE ts < ?", now - RAW_RETENTION);
    sql.exec("DELETE FROM terms WHERE minute < ?", Math.floor((now - RAW_RETENTION) / MINUTE));
    sql.exec("DELETE FROM edges WHERE hour < ?", Math.floor((now - EDGE_RETENTION) / HOUR));
    sql.exec("DELETE FROM edges WHERE n = 1 AND hour < ?", Math.floor((now - 2 * HOUR) / HOUR));
    sql.exec("INSERT INTO counters (k, v) VALUES ('last_prune', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", now);
  }

  // ---- upstream: bluesky jetstream -----------------------------------------

  private async ensureUpstream(): Promise<void> {
    if (this.upstream || this.connecting) return;
    this.connecting = true;
    try {
      const res = await fetch(this.env.JETSTREAM_URL, { headers: { Upgrade: "websocket" } });
      const ws = res.webSocket;
      if (!ws) throw new Error(`jetstream upgrade failed: ${res.status}`);
      ws.accept();
      this.seen = 0;
      this.sessionStart = Date.now();
      ws.addEventListener("message", (e) => this.onPost(e.data));
      ws.addEventListener("close", () => this.onUpstreamGone(ws));
      ws.addEventListener("error", () => this.onUpstreamGone(ws));
      this.upstream = ws;
      this.broadcast({ type: "stats", stats: this.stats() });
    } catch (err) {
      console.error("jetstream connect failed", err);
    } finally {
      this.connecting = false;
    }
  }

  private onUpstreamGone(ws: WebSocket): void {
    if (this.upstream !== ws) return;
    this.upstream = null;
    this.broadcast({ type: "stats", stats: this.stats() });
    // The heartbeat alarm reconnects.
  }

  private closeUpstream(): void {
    const ws = this.upstream;
    this.upstream = null;
    try { ws?.close(1000, "idle"); } catch { /* already closed */ }
  }

  private currentRate(): number {
    return Number(this.viewers() > 0 ? this.env.JUDGE_RATE_PER_SEC : this.env.IDLE_RATE_PER_SEC);
  }

  private takeToken(): boolean {
    const now = Date.now();
    const rate = this.currentRate();
    this.allowance = Math.min(Math.max(rate, 1), this.allowance + ((now - this.lastRefill) / 1000) * rate);
    this.lastRefill = now;
    if (this.allowance < 1) return false;
    this.allowance -= 1;
    return true;
  }

  private onPost(raw: string | ArrayBuffer): void {
    if (typeof raw !== "string") return;
    let ev: JetstreamEvent;
    try { ev = JSON.parse(raw); } catch { return; }
    const c = ev.commit;
    if (ev.kind !== "commit" || !c || c.operation !== "create" || c.collection !== "app.bsky.feed.post") return;
    const text = c.record?.text?.trim();
    if (!text || text.length < 24 || text.length > 600) return;
    if (!c.record?.langs?.includes("en")) return;
    this.seen++;
    this.meter();
    if (this.paused) return;
    if (this.inflight >= Number(this.env.MAX_INFLIGHT) || !this.takeToken()) return;
    const id = `${ev.did}/${c.rkey}`;
    const url = `https://bsky.app/profile/${ev.did}/post/${c.rkey}`;
    this.inflight++;
    this.judgeOne(id, url, text).finally(() => { this.inflight--; });
  }

  // ---- jev ------------------------------------------------------------------

  private async judgeOne(id: string, url: string, text: string): Promise<void> {
    const t0 = Date.now();
    let res;
    try {
      res = await judge({ url: this.env.TYPESAFE_URL, model: this.env.TYPESAFE_MODEL, apiKey: this.env.TYPESAFE_API_KEY }, text, () => this.bump("retries", 1));
    } catch (err) {
      console.error("jev failed", err);
      return;
    }
    const latencyMs = Date.now() - t0;
    this.model = res.model;
    this.latencies.push(latencyMs);
    if (this.latencies.length > LATENCY_WINDOW) this.latencies.shift();

    const nsfw = res.answers.nsfw;
    const dropped = nsfw?.type === "noul" && nsfw.noul > NSFW_DROP;
    const review = needsReview(res.answers);
    const post: JudgedPost = { id, url, text, at: Date.now(), latencyMs, inputTokens: res.usage.input_tokens, answers: res.answers, review };

    this.record(post, dropped);
    if (this.viewers() === 0) return;
    if (!dropped) this.broadcast({ type: "post", post, stats: this.stats() });
    if (Date.now() - this.lastPanelAt > PANEL_EVERY_MS) {
      this.lastPanelAt = Date.now();
      this.broadcast({ type: "panel", panel: this.panel() });
    }
  }

  // ---- storage --------------------------------------------------------------

  private bump(k: string, by: number): void {
    this.ctx.storage.sql.exec("INSERT INTO counters (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = v + excluded.v", k, by);
  }

  private counter(k: string): number {
    const row = this.ctx.storage.sql.exec<{ v: number }>("SELECT v FROM counters WHERE k = ?", k).toArray()[0];
    return row?.v ?? 0;
  }

  private record(post: JudgedPost, dropped: boolean): void {
    const sql = this.ctx.storage.sql;
    const a = post.answers;
    const num = (q: string) => { const x = a[q]; return !x ? null : x.type === "noul" ? x.noul : x.type === "score" ? x.score : null; };
    const pick = (q: string) => { const x = a[q]; return x?.type === "choice" ? x.choice : null; };
    const conf = (q: string) => { const x = a[q]; return x ? confidenceOf(x) : null; };
    const signal = (q: string) => (dropped ? 0 : num(q) ?? 0);
    const hour = Math.floor(post.at / HOUR);

    this.bump("judged", 1);
    this.bump("input_tokens", post.inputTokens);
    if (dropped) this.bump("filtered", 1);
    else if (post.review.length) this.bump("reviewed", 1);

    sql.exec(
      `INSERT OR REPLACE INTO judgments (id, ts, url, text, json, intent, topic, intent_conf, topic_conf, sentiment_conf, bait_conf, sentiment, bait, hostile, sarcasm, bot, nsfw, review, latency, tokens, dropped)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      post.id, post.at, post.url, dropped ? "" : post.text, dropped ? "" : JSON.stringify(a),
      pick("intent"), pick("topic"), conf("intent"), conf("topic"), conf("sentiment"), conf("bait"),
      num("sentiment"), num("bait"), num("hostile"), num("sarcasm"), num("bot"), num("nsfw"),
      post.review.join(","), post.latencyMs, post.inputTokens, dropped ? 1 : 0,
    );

    // Rollups survive the raw retention window, so the means are summed here rather than recovered later.
    sql.exec(
      `INSERT INTO hourly (hour, n, reviewed, dropped, tokens, latency_sum, sentiment_sum, bait_sum, hostile_sum, sarcasm_sum, bot_sum)
       VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(hour) DO UPDATE SET n = n + 1, reviewed = reviewed + excluded.reviewed, dropped = dropped + excluded.dropped,
         tokens = tokens + excluded.tokens, latency_sum = latency_sum + excluded.latency_sum, sentiment_sum = sentiment_sum + excluded.sentiment_sum,
         bait_sum = bait_sum + excluded.bait_sum, hostile_sum = hostile_sum + excluded.hostile_sum,
         sarcasm_sum = sarcasm_sum + excluded.sarcasm_sum, bot_sum = bot_sum + excluded.bot_sum`,
      hour, dropped ? 0 : post.review.length ? 1 : 0, dropped ? 1 : 0, post.inputTokens, post.latencyMs,
      signal("sentiment"), signal("bait"), signal("hostile"), signal("sarcasm"), signal("bot"),
    );
    if (dropped) return;

    for (const [q, x] of Object.entries(a)) {
      if (x.type !== "choice") continue;
      sql.exec("INSERT INTO hist (dim, k, n) VALUES (?, ?, 1) ON CONFLICT(dim, k) DO UPDATE SET n = n + 1", q, x.choice);
    }
    for (const dim of ["intent", "topic"] as const) {
      const k = pick(dim);
      if (k) sql.exec(`INSERT INTO hourly_${dim} (hour, k, n) VALUES (?, ?, 1) ON CONFLICT(hour, k) DO UPDATE SET n = n + 1`, hour, k);
    }

    const botP = num("bot") ?? 0;
    const terms = botP > 0.6 ? [] : extractTerms(post.text);
    const minute = Math.floor(post.at / MINUTE);
    for (const t of terms) {
      sql.exec("INSERT INTO terms (minute, term, n) VALUES (?, ?, 1) ON CONFLICT(minute, term) DO UPDATE SET n = n + 1", minute, t);
    }
    const linked = terms.slice(0, EDGE_TERMS).sort();
    for (let i = 0; i < linked.length; i++) {
      for (let j = i + 1; j < linked.length; j++) {
        sql.exec("INSERT INTO edges (hour, a, b, n) VALUES (?, ?, ?, 1) ON CONFLICT(hour, a, b) DO UPDATE SET n = n + 1", hour, linked[i], linked[j]);
      }
    }
  }

  private recordVote(postId: string, question: string, agree: boolean): void {
    const row = this.ctx.storage.sql.exec<{ json: string; review: string }>("SELECT json, review FROM judgments WHERE id = ? AND dropped = 0", postId).toArray()[0];
    if (!row) return;
    const a = (JSON.parse(row.json) as Record<string, Answer>)[question];
    if (!a) return;
    const flagged = row.review.split(",").includes(question) ? 1 : 0;
    // Probability the model put on the answer it gave, so calibration can be read across question types.
    const modelP = a.type === "noul" ? Math.max(a.noul, 1 - a.noul)
      : a.type === "choice" ? a.probabilities[a.choice]
      : Math.max(...Object.values(a.probabilities));
    const modelAnswer = a.type === "noul" ? (a.noul >= 0.5 ? "yes" : "no") : a.type === "choice" ? a.choice : a.legend[String(Math.round(a.score))];
    this.ctx.storage.sql.exec(
      "INSERT INTO votes (ts, post_id, question, model_p, model_answer, flagged, agree, conf) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      Date.now(), postId, question, modelP, modelAnswer, flagged, agree ? 1 : 0, confidenceOf(a),
    );
    this.bump("votes", 1);
    this.broadcast({ type: "calibration", calibration: this.calibration() });
  }

  // Called over RPC by the Stripe webhook in src/index.ts. Stripe retries deliveries, so a repeat is a no-op.
  async recordContribution(c: { id: string; ts: number; amountCents: number; currency: string; name?: string; message?: string }): Promise<void> {
    const sql = this.ctx.storage.sql;
    if (sql.exec("SELECT 1 FROM contributions WHERE id = ?", c.id).toArray().length) return;
    const message = c.message?.trim().slice(0, BACKER_MESSAGE_MAX) || null;
    sql.exec(
      "INSERT INTO contributions (id, ts, amount_cents, currency, name, message) VALUES (?, ?, ?, ?, ?, ?)",
      c.id, c.ts, c.amountCents, c.currency, c.name?.trim() || null, message,
    );
    // Paying does not buy a bypass: the message goes past the same judge as every post.
    if (message) {
      try {
        const res = await judge({ url: this.env.TYPESAFE_URL, model: this.env.TYPESAFE_MODEL, apiKey: this.env.TYPESAFE_API_KEY }, message, () => this.bump("retries", 1));
        const nsfw = res.answers.nsfw;
        const hostile = res.answers.hostile;
        const approved = nsfw?.type === "noul" && nsfw.noul < BACKER_NSFW && hostile?.type === "noul" && hostile.noul < BACKER_HOSTILE;
        sql.exec("UPDATE contributions SET judged = ?, approved = ? WHERE id = ?", JSON.stringify(res.answers), approved ? 1 : 0, c.id);
      } catch (err) {
        console.error("backer message judge failed", err);
      }
    }
    this.meteredAt = 0;
    this.broadcast({ type: "stats", stats: this.stats() });
    this.broadcast({ type: "backers", backers: this.backers() });
  }

  private recent(): JudgedPost[] {
    return this.ctx.storage.sql
      .exec<PostRow>("SELECT id, ts, url, text, json, review, latency, tokens FROM judgments WHERE dropped = 0 ORDER BY ts DESC LIMIT ?", RECENT_LIMIT)
      .toArray()
      .reverse()
      .map(toPost);
  }

  // ---- analytics ------------------------------------------------------------

  // Summing the 24h window on every post would scan the table per post, so spend and funding are cached.
  private meter(): void {
    const now = Date.now();
    if (now - this.meteredAt < METER_EVERY_MS) return;
    this.meteredAt = now;
    const sql = this.ctx.storage.sql;
    const price = Number(this.env.PRICE_PER_M_INPUT);
    const infra = Number(this.env.INFRA_USD_PER_DAY) || 0;
    const tokens = (ts: number) => (sql.exec<Row>("SELECT SUM(tokens) AS t FROM judgments WHERE ts >= ?", ts).toArray()[0].t as number) || 0;
    // Judgments are pruned after a week, so the longer windows read the rollups instead.
    const rollupTokens = (hour: number) => (sql.exec<Row>("SELECT SUM(tokens) AS t FROM hourly WHERE hour >= ?", hour).toArray()[0].t as number) || 0;
    const given = (ts: number) => ((sql.exec<Row>("SELECT SUM(amount_cents) AS c FROM contributions WHERE ts >= ?", ts).toArray()[0].c as number) || 0) / 100;
    const dayStart = Math.floor(now / DAY) * DAY;

    this.spent24h = (tokens(now - DAY) / 1e6) * price;
    this.funding = {
      link: this.env.STRIPE_LINK,
      today: given(dayStart),
      week: given(now - 7 * DAY),
      month: given(now - 30 * DAY),
      costToday: (tokens(dayStart) / 1e6) * price + infra,
      costWeek: (rollupTokens(Math.floor((now - 7 * DAY) / HOUR)) / 1e6) * price + infra * 7,
      costMonth: (rollupTokens(Math.floor((now - 30 * DAY) / HOUR)) / 1e6) * price + infra * 30,
      goalUsd: Number(this.env.MONTHLY_GOAL_USD),
      raisedMonth: given(now - 30 * DAY),
    };
    const paused = this.spent24h >= Number(this.env.MAX_USD_PER_DAY);
    if (paused !== this.paused) {
      this.paused = paused;
      this.broadcast({ type: "stats", stats: this.stats() });
    }
  }

  stats(): Stats {
    this.meter();
    const hist: Stats["hist"] = {};
    for (const r of this.ctx.storage.sql.exec<{ dim: string; k: string; n: number }>("SELECT dim, k, n FROM hist").toArray()) {
      (hist[r.dim] ??= {})[r.k] = r.n;
    }
    const sorted = [...this.latencies].sort((a, b) => a - b);
    const inputTokens = this.counter("input_tokens");
    return {
      judged: this.counter("judged"),
      filtered: this.counter("filtered"),
      reviewed: this.counter("reviewed"),
      votes: this.counter("votes"),
      retries: this.counter("retries"),
      inputTokens,
      costUsd: (inputTokens / 1e6) * Number(this.env.PRICE_PER_M_INPUT),
      medianLatencyMs: sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0,
      seenPerSec: this.seen / Math.max(1, (Date.now() - this.sessionStart) / 1000),
      viewers: this.viewers(),
      live: this.upstream !== null,
      ratePerSec: this.currentRate(),
      idleRatePerSec: Number(this.env.IDLE_RATE_PER_SEC),
      model: this.model,
      hist,
      budget: { usdPerDay: Number(this.env.MAX_USD_PER_DAY), spent24h: this.spent24h, paused: this.paused },
      funding: this.funding,
      ads: { client: this.env.ADSENSE_CLIENT, slot: this.env.ADSENSE_SLOT },
    };
  }

  backers() {
    const sql = this.ctx.storage.sql;
    this.meter();
    const tier = (usd: number) => (usd >= 100 ? "whale" : usd >= 25 ? "patron" : "backer");
    const backers = sql.exec<{ name: string | null; cents: number; ts: number }>(
      "SELECT name, amount_cents AS cents, ts FROM contributions ORDER BY ts DESC LIMIT 100").toArray()
      .map((r) => ({ name: r.name || "anonymous", amount: r.cents / 100, ts: r.ts, tier: tier(r.cents / 100) }));
    const leaderboard = sql.exec<{ name: string; cents: number }>(
      "SELECT COALESCE(name, 'anonymous') AS name, SUM(amount_cents) AS cents FROM contributions GROUP BY name ORDER BY cents DESC LIMIT 10").toArray()
      .map((r) => ({ name: r.name, total: r.cents / 100, tier: tier(r.cents / 100) }));
    const top = sql.exec<{ name: string | null; message: string; cents: number; ts: number; judged: string | null }>(
      "SELECT name, message, amount_cents AS cents, ts, judged FROM contributions WHERE approved = 1 AND message IS NOT NULL AND ts >= ? ORDER BY amount_cents DESC LIMIT 1",
      Date.now() - DAY).toArray()[0];
    return {
      goalUsd: this.funding.goalUsd,
      raisedMonth: this.funding.raisedMonth,
      backers,
      leaderboard,
      pinned: top ? { name: top.name || "anonymous", message: top.message, amount: top.cents / 100, ts: top.ts, answers: top.judged ? JSON.parse(top.judged) : null } : null,
    };
  }

  panel() {
    const now = Date.now();
    return {
      at: now,
      hotMin: 10,
      baseMin: 1440,
      shares: { intent: this.shares("intent", now), topic: this.shares("topic", now) },
      baro: this.baro(now),
      series: this.series(60),
      terms: this.terms(15, 360),
      graph: this.graph(60),
      wire: this.wire(60),
      calibration: this.calibration(),
      perf: this.perf(),
      workload: this.workload(),
    };
  }

  // Bucketed distributions over the last 24h; percentiles are derived from the latency buckets.
  perf() {
    const since = Date.now() - DAY;
    const buckets = (expr: string, size: number) => this.ctx.storage.sql.exec<{ b: number; n: number }>(
      `SELECT CAST((${expr}) / ${size} AS INTEGER) * ${size} AS b, COUNT(*) AS n FROM judgments WHERE ts >= ? AND dropped = 0 AND (${expr}) IS NOT NULL GROUP BY b ORDER BY b`, since).toArray();
    const latency = buckets("latency", 25);
    const total = latency.reduce((a, r) => a + r.n, 0);
    const pct = (p: number) => { let acc = 0; for (const r of latency) { acc += r.n; if (acc >= total * p) return r.b + 25; } return null; };
    return {
      n: total,
      latency,
      p50: pct(0.5), p90: pct(0.9), p99: pct(0.99),
      tokens: buckets("tokens", 25),
      intentConf: buckets("intent_conf * 100", 10),
      topicConf: buckets("topic_conf * 100", 10),
      hostile: buckets("hostile * 100", 10),
      sarcasm: buckets("sarcasm * 100", 10),
      bot: buckets("bot * 100", 10),
    };
  }

  // Inputs for the savings arithmetic. Fidelity is human agreement on answers the model was confident about.
  workload() {
    const now = Date.now();
    const day = this.ctx.storage.sql.exec<Row>(
      "SELECT COUNT(*) AS n, SUM(review != '') AS reviewed, MIN(ts) AS first, SUM(tokens) AS tokens FROM judgments WHERE ts >= ? AND dropped = 0", now - DAY).toArray()[0];
    const hours = Math.max(0.25, (now - ((day.first as number) || now)) / HOUR);
    const fid = this.ctx.storage.sql.exec<Row>("SELECT flagged, COUNT(*) AS n, AVG(agree) AS agree FROM votes GROUP BY flagged").toArray();
    const confident = fid.find((r) => r.flagged === 0);
    const flagged = fid.find((r) => r.flagged === 1);
    return {
      judged24h: day.n as number,
      reviewed24h: (day.reviewed as number) || 0,
      hoursObserved: hours,
      tokens24h: (day.tokens as number) || 0,
      pricePerM: Number(this.env.PRICE_PER_M_INPUT),
      confidentVotes: (confident?.n as number) || 0,
      confidentAgree: (confident?.agree as number | null) ?? null,
      flaggedVotes: (flagged?.n as number) || 0,
      flaggedAgree: (flagged?.agree as number | null) ?? null,
    };
  }

  private shares(dim: "intent" | "topic", now: number): Record<string, { hot: number; base: number }> {
    const out: Record<string, { hot: number; base: number }> = {};
    for (const r of this.ctx.storage.sql.exec<{ k: string; hot: number; base: number }>(
      `SELECT ${dim} AS k, SUM(ts >= ?) AS hot, COUNT(*) AS base FROM judgments WHERE ts >= ? AND dropped = 0 AND ${dim} IS NOT NULL GROUP BY ${dim}`,
      now - 10 * MINUTE, now - DAY).toArray()) {
      out[r.k] = { hot: r.hot, base: r.base };
    }
    return out;
  }

  private baro(now: number) {
    const q = (since: number) => this.ctx.storage.sql.exec<Row>(
      "SELECT COUNT(*) AS n, AVG(sentiment)/4 AS sentiment, AVG(bait)/3 AS bait, AVG(hostile) AS hostile, AVG(sarcasm) AS sarcasm, AVG(bot) AS bot FROM judgments WHERE ts >= ? AND dropped = 0",
      since).toArray()[0];
    const hot = q(now - 3 * MINUTE);
    const base = q(now - DAY);
    const out: Record<string, { now: number | null; base: number | null; n: number }> = {};
    for (const k of ["sentiment", "bait", "hostile", "sarcasm", "bot"]) out[k] = { now: hot[k] as number | null, base: base[k] as number | null, n: hot.n as number };
    return out;
  }

  series(minutes: number) {
    const since = Date.now() - minutes * MINUTE;
    const byMinute = new Map<number, { m: number; n: number; intent: Record<string, number>; hostile: number; sarcasm: number; bait: number; sentiment: number }>();
    for (const r of this.ctx.storage.sql.exec<Row>(
      "SELECT ts/60000 AS m, COUNT(*) AS n, AVG(hostile) AS hostile, AVG(sarcasm) AS sarcasm, AVG(bait)/3 AS bait, AVG(sentiment)/4 AS sentiment FROM judgments WHERE ts >= ? AND dropped = 0 GROUP BY m ORDER BY m",
      since).toArray()) {
      byMinute.set(r.m as number, { m: r.m as number, n: r.n as number, intent: {}, hostile: r.hostile as number, sarcasm: r.sarcasm as number, bait: r.bait as number, sentiment: r.sentiment as number });
    }
    for (const r of this.ctx.storage.sql.exec<Row>(
      "SELECT ts/60000 AS m, intent, COUNT(*) AS n FROM judgments WHERE ts >= ? AND dropped = 0 AND intent IS NOT NULL GROUP BY m, intent",
      since).toArray()) {
      const row = byMinute.get(r.m as number);
      if (row) row.intent[r.intent as string] = r.n as number;
    }
    return [...byMinute.values()];
  }

  terms(hotMinutes: number, baseMinutes: number) {
    const nowMin = Math.floor(Date.now() / MINUTE);
    const rows = this.ctx.storage.sql.exec<{ term: string; hot: number; base: number }>(
      "SELECT term, SUM(CASE WHEN minute >= ? THEN n ELSE 0 END) AS hot, SUM(n) AS base FROM terms WHERE minute >= ? GROUP BY term HAVING hot >= 2 ORDER BY hot DESC LIMIT 300",
      nowMin - hotMinutes, nowMin - baseMinutes).toArray();
    // Burst: how many more mentions than the trailing window would predict for this slice.
    return rows.map((r) => {
      const expected = ((r.base - r.hot) / Math.max(1, baseMinutes - hotMinutes)) * hotMinutes;
      return { t: r.term, hot: r.hot, base: r.base, burst: (r.hot + 1) / (expected + 1) };
    }).sort((a, b) => b.hot - a.hot).slice(0, 60);
  }

  graph(minutes: number) {
    const nowMin = Math.floor(Date.now() / MINUTE);
    const nodes = this.ctx.storage.sql.exec<{ id: string; n: number }>(
      "SELECT term AS id, SUM(n) AS n FROM terms WHERE minute >= ? GROUP BY term ORDER BY n DESC LIMIT 30", nowMin - minutes).toArray();
    if (nodes.length < 2) return { nodes, edges: [] };
    const ids = nodes.map((n) => n.id);
    const marks = ids.map(() => "?").join(",");
    const edges = this.ctx.storage.sql.exec<{ a: string; b: string; n: number }>(
      `SELECT a, b, SUM(n) AS n FROM edges WHERE hour >= ? AND a IN (${marks}) AND b IN (${marks}) GROUP BY a, b HAVING n >= 2 ORDER BY n DESC LIMIT 80`,
      Math.floor((Date.now() - minutes * MINUTE) / HOUR), ...ids, ...ids).toArray();
    return { nodes, edges };
  }

  private wire(minutes: number) {
    return this.ctx.storage.sql.exec<Row>(
      "SELECT id, url, text, ts, intent, topic, bait, hostile, sarcasm FROM judgments WHERE ts >= ? AND dropped = 0 ORDER BY (bait/3 + hostile) DESC LIMIT 6",
      Date.now() - minutes * MINUTE).toArray();
  }

  calibration() {
    const total = this.ctx.storage.sql.exec<Row>("SELECT COUNT(*) AS n, AVG(agree) AS agree FROM votes").toArray()[0];
    const bins = this.ctx.storage.sql.exec<Row>(
      "SELECT MIN(CAST(model_p * 10 AS INTEGER), 9) AS b, COUNT(*) AS n, AVG(agree) AS agree, AVG(model_p) AS p FROM votes GROUP BY b ORDER BY b").toArray();
    const byQuestion = this.ctx.storage.sql.exec<Row>("SELECT question, COUNT(*) AS n, AVG(agree) AS agree FROM votes GROUP BY question ORDER BY n DESC").toArray();
    return { votes: total.n as number, agree: total.agree as number | null, bins, byQuestion };
  }

  // Where to put the review bar. One pass over the window, 21 thresholds per row: 21 SQL scans would cost 21x.
  private curve(minutes: number): Curve {
    const hit = this.curveCache;
    if (hit && hit.minutes === minutes && Date.now() - hit.at < CURVE_CACHE_MS) return hit.data;
    const since = Date.now() - minutes * MINUTE;
    const sql = this.ctx.storage.sql;
    const points = [];
    for (let i = 0; i <= CURVE_STEPS; i++) {
      const c = round4(i / CURVE_STEPS);
      // The three bars keep the ratios of REVIEW_THRESHOLD, so one knob moves the whole policy.
      points.push({ c, noul: round4(c * 0.4), score: round4(c * 0.25), flagged: 0, confidentVotes: 0, agreeSum: 0 });
    }

    const rows = sql.exec<{ intent_conf: number | null; topic_conf: number | null; sentiment_conf: number | null; bait_conf: number | null; hostile: number | null; sarcasm: number | null; bot: number | null }>(
      "SELECT intent_conf, topic_conf, sentiment_conf, bait_conf, hostile, sarcasm, bot FROM judgments WHERE ts >= ? AND dropped = 0", since).toArray();
    for (const r of rows) {
      const choices = [r.intent_conf, r.topic_conf];
      const scores = [r.sentiment_conf, r.bait_conf];
      const nouls = [r.hostile, r.sarcasm, r.bot].map((v) => (v == null ? null : Math.abs(v - 0.5) * 2));
      for (const p of points) {
        const flagged = choices.some((v) => v != null && v < p.c) || scores.some((v) => v != null && v < p.score) || nouls.some((v) => v != null && v < p.noul);
        if (flagged) p.flagged++;
      }
    }

    const votes = sql.exec<{ question: string; conf: number; agree: number }>(
      "SELECT question, conf, agree FROM votes WHERE ts >= ? AND conf IS NOT NULL", since).toArray();
    for (const v of votes) {
      const type = QUESTIONS[v.question]?.type;
      if (!type) continue;
      for (const p of points) {
        const bar = type === "choice" ? p.c : type === "noul" ? p.noul : p.score;
        if (v.conf >= bar) { p.confidentVotes++; p.agreeSum += v.agree; }
      }
    }

    const data: Curve = {
      n: rows.length,
      votes: votes.length,
      points: points.map((p) => ({
        c: p.c, noul: p.noul, score: p.score,
        reviewShare: rows.length ? p.flagged / rows.length : 0,
        confidentVotes: p.confidentVotes,
        confidentAgree: p.confidentVotes ? p.agreeSum / p.confidentVotes : null,
      })),
    };
    this.curveCache = { minutes, at: Date.now(), data };
    return data;
  }

  private posts(minutes: number, term: string | null, intent: string | null, topic: string | null, limit: number): JudgedPost[] {
    const where = ["ts >= ?", "dropped = 0"];
    const args: (string | number)[] = [Date.now() - minutes * MINUTE];
    if (term) {
      where.push("lower(text) LIKE ? ESCAPE '\\'");
      args.push(`%${term.toLowerCase().replace(/[\\%_]/g, "\\$&")}%`);
    }
    if (intent) { where.push("intent = ?"); args.push(intent); }
    if (topic) { where.push("topic = ?"); args.push(topic); }
    args.push(Math.min(100, Math.max(1, limit || 30)));
    return this.ctx.storage.sql.exec<PostRow>(
      `SELECT id, ts, url, text, json, review, latency, tokens FROM judgments WHERE ${where.join(" AND ")} ORDER BY ts DESC LIMIT ?`,
      ...args).toArray().map(toPost);
  }

  private hourly(hours: number) {
    const nowHour = Math.floor(Date.now() / HOUR);
    return this.rollups(nowHour - Math.min(8760, Math.max(1, hours || 720)) + 1, nowHour + 1);
  }

  // Rollups are never pruned, so this is the only view that reaches past the raw retention window.
  private rollups(fromHour: number, toHour: number) {
    const sql = this.ctx.storage.sql;
    const maps = (table: string) => {
      const out = new Map<number, Record<string, number>>();
      for (const r of sql.exec<{ hour: number; k: string; n: number }>(`SELECT hour, k, n FROM ${table} WHERE hour >= ? AND hour < ?`, fromHour, toHour).toArray()) {
        let m = out.get(r.hour);
        if (!m) out.set(r.hour, (m = {}));
        m[r.k] = r.n;
      }
      return out;
    };
    const intent = maps("hourly_intent");
    const topic = maps("hourly_topic");
    return sql.exec<HourlyRow>("SELECT * FROM hourly WHERE hour >= ? AND hour < ? ORDER BY hour", fromHour, toHour).toArray().map((r) => {
      const shown = r.n - r.dropped;
      const mean = (sum: number, scale: number) => (shown ? sum / shown / scale : null);
      return {
        hour: r.hour, at: r.hour * HOUR, n: r.n, reviewed: r.reviewed, dropped: r.dropped, tokens: r.tokens,
        latencyMs: r.n ? r.latency_sum / r.n : null,
        sentiment: mean(r.sentiment_sum, 4), bait: mean(r.bait_sum, 3),
        hostile: mean(r.hostile_sum, 1), sarcasm: mean(r.sarcasm_sum, 1), bot: mean(r.bot_sum, 1),
        intent: intent.get(r.hour) ?? {}, topic: topic.get(r.hour) ?? {},
      };
    });
  }

  private crosstab(rows: string, cols: string, minutes: number) {
    const dims = new Set(["intent", "topic"]);
    if (!dims.has(rows) || !dims.has(cols)) return { error: "rows and cols must be intent or topic" };
    return this.ctx.storage.sql.exec<Row>(
      `SELECT ${rows} AS row, ${cols} AS col, COUNT(*) AS n, AVG(hostile) AS hostile, AVG(sarcasm) AS sarcasm, AVG(bait)/3 AS bait, AVG(sentiment)/4 AS sentiment
       FROM judgments WHERE ts >= ? AND dropped = 0 GROUP BY row, col ORDER BY n DESC`,
      Date.now() - minutes * MINUTE).toArray();
  }

  private exportNdjson(since: number, limit: number): Response {
    const rows = this.ctx.storage.sql.exec<PostRow>(
      "SELECT id, ts, url, text, json, review, latency, tokens FROM judgments WHERE ts > ? AND dropped = 0 ORDER BY ts LIMIT ?",
      since, Math.min(Math.max(1, limit), 20000)).toArray();
    return new Response(rows.map(ndjsonLine).join(""), {
      headers: { "Content-Type": "application/x-ndjson", "Access-Control-Allow-Origin": "*", "X-Next-Since": String(rows.at(-1)?.ts ?? since) },
    });
  }

  // ---- r2 archive -----------------------------------------------------------

  private async maybeArchive(): Promise<void> {
    const bucket = this.env.ARCHIVE as R2Bucket | undefined;
    if (!bucket) return;
    const now = Date.now();
    const day = Math.floor(now / DAY);
    if (now - day * DAY < ARCHIVE_AFTER_MS) return;
    if (this.counter("last_archive_day") >= day) return;
    // Marked before the write: a failing archive must not re-scan the day on every heartbeat.
    this.ctx.storage.sql.exec("INSERT INTO counters (k, v) VALUES ('last_archive_day', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", day);
    const from = (day - 1) * DAY;
    const date = new Date(from).toISOString().slice(0, 10);
    await this.archiveJudgments(bucket, `judgments/${date}.ndjson`, from, day * DAY);
    await bucket.put(`hourly/${date}.json`, JSON.stringify(this.rollups(Math.floor(from / HOUR), day * 24)), { httpMetadata: { contentType: "application/json" } });
  }

  // Paged so a whole busy day never sits in memory; past ~20MB it becomes a multipart upload.
  private async archiveJudgments(bucket: R2Bucket, key: string, from: number, to: number): Promise<void> {
    const parts: R2UploadedPart[] = [];
    let upload: R2MultipartUpload | null = null;
    let buf: string[] = [];
    let buffered = 0;
    let total = 0;
    const flush = async () => {
      if (!upload || !buffered) return;
      const body = buf.join("");
      buf = [];
      buffered = 0;
      parts.push(await upload.uploadPart(parts.length + 1, body));
    };
    for (let offset = 0; ; offset += ARCHIVE_PAGE) {
      const rows = this.ctx.storage.sql.exec<PostRow>(
        "SELECT id, ts, url, text, json, review, latency, tokens FROM judgments WHERE ts >= ? AND ts < ? AND dropped = 0 ORDER BY ts, id LIMIT ? OFFSET ?",
        from, to, ARCHIVE_PAGE, offset).toArray();
      if (rows.length) {
        const chunk = rows.map(ndjsonLine).join("");
        buf.push(chunk);
        // UTF-8 is never fewer bytes than characters, so counting characters keeps parts over R2's 5MB floor.
        buffered += chunk.length;
        total += chunk.length;
        if (!upload && total > MULTIPART_ABOVE) upload = await bucket.createMultipartUpload(key, { httpMetadata: { contentType: "application/x-ndjson" } });
        if (buffered >= PART_MIN) await flush();
      }
      if (rows.length < ARCHIVE_PAGE) break;
    }
    if (upload) {
      await flush();
      await upload.complete(parts);
    } else {
      await bucket.put(key, buf.join(""), { httpMetadata: { contentType: "application/x-ndjson" } });
    }
  }

  private async archiveList(): Promise<Response> {
    const bucket = this.env.ARCHIVE as R2Bucket | undefined;
    if (!bucket) return json([]);
    const list = await bucket.list({ prefix: "judgments/" });
    return json(list.objects.map((o) => ({ name: o.key, size: o.size, uploaded: o.uploaded })));
  }

  // ---- badge ----------------------------------------------------------------

  // Same number as the panel's mood channel; the day is the fallback when three minutes is too thin.
  private mood(): number | null {
    const now = Date.now();
    const q = (since: number) => this.ctx.storage.sql.exec<{ n: number; s: number | null }>(
      "SELECT COUNT(*) AS n, AVG(sentiment)/4 AS s FROM judgments WHERE ts >= ? AND dropped = 0", since).toArray()[0];
    const hot = q(now - 3 * MINUTE);
    const row = hot.n >= 5 ? hot : q(now - DAY);
    return row.s == null ? null : Math.round(row.s * 100);
  }

  private badge(): Response {
    const v = this.mood();
    const value = v == null ? "–" : String(v);
    const color = v == null ? "#9f9f9f" : v < 40 ? "#e66767" : v <= 60 ? "#c98500" : "#0ca30c";
    const width = (s: string) => Math.round(s.length * 6.5) + 10;
    const lw = width(BADGE_LABEL);
    const rw = width(value);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${lw + rw}" height="20" role="img" aria-label="${BADGE_LABEL}: ${value}">`
      + `<title>${BADGE_LABEL}: ${value}</title>`
      + `<linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient>`
      + `<clipPath id="r"><rect width="${lw + rw}" height="20" rx="3" fill="#fff"/></clipPath>`
      + `<g clip-path="url(#r)"><rect width="${lw}" height="20" fill="#555"/><rect x="${lw}" width="${rw}" height="20" fill="${color}"/>`
      + `<rect width="${lw + rw}" height="20" fill="url(#s)"/></g>`
      + `<g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">`
      + `<text x="${lw / 2}" y="15" fill="#010101" fill-opacity=".3">${BADGE_LABEL}</text><text x="${lw / 2}" y="14">${BADGE_LABEL}</text>`
      + `<text x="${lw + rw / 2}" y="15" fill="#010101" fill-opacity=".3">${value}</text><text x="${lw + rw / 2}" y="14">${value}</text>`
      + `</g></svg>`;
    return new Response(svg, {
      headers: { "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=60", "Access-Control-Allow-Origin": "*" },
    });
  }
}

function toPost(r: PostRow): JudgedPost {
  return { id: r.id, url: r.url, text: r.text, at: r.ts, latencyMs: r.latency, inputTokens: r.tokens, answers: JSON.parse(r.json), review: r.review ? r.review.split(",") : [] };
}

function ndjsonLine(r: PostRow): string {
  return JSON.stringify({ ...r, json: undefined, answers: JSON.parse(r.json) }) + "\n";
}

function round4(x: number): number {
  return Math.round(x * 1e4) / 1e4;
}

function json(data: unknown): Response {
  return new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" } });
}

export { confidenceOf };
