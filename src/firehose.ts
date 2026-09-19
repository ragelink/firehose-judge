import { DurableObject } from "cloudflare:workers";
import { judge, needsReview, confidenceOf, QUESTIONS, REVIEW_THRESHOLD, type Answer } from "./jev";
import { extractTerms } from "./terms";

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

export interface Stats {
  judged: number;
  filtered: number;
  reviewed: number;
  votes: number;
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
}

type Row = Record<string, string | number | null>;

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

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
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
        DROP TABLE IF EXISTS recent;
      `);
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
    }
    return new Response("not found", { status: 404 });
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
    if (this.viewers() === 0 && Number(this.env.IDLE_RATE_PER_SEC) <= 0) {
      this.closeUpstream();
      return;
    }
    await this.ensureUpstream();
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
      res = await judge({ url: this.env.TYPESAFE_URL, model: this.env.TYPESAFE_MODEL, apiKey: this.env.TYPESAFE_API_KEY }, text);
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
    const conf = (q: string) => { const x = a[q]; return x?.type === "choice" ? x.confidence : null; };

    this.bump("judged", 1);
    this.bump("input_tokens", post.inputTokens);
    if (dropped) this.bump("filtered", 1);
    else if (post.review.length) this.bump("reviewed", 1);

    sql.exec(
      `INSERT OR REPLACE INTO judgments (id, ts, url, text, json, intent, topic, intent_conf, topic_conf, sentiment, bait, hostile, sarcasm, bot, nsfw, review, latency, tokens, dropped)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      post.id, post.at, post.url, dropped ? "" : post.text, dropped ? "" : JSON.stringify(a),
      pick("intent"), pick("topic"), conf("intent"), conf("topic"),
      num("sentiment"), num("bait"), num("hostile"), num("sarcasm"), num("bot"), num("nsfw"),
      post.review.join(","), post.latencyMs, post.inputTokens, dropped ? 1 : 0,
    );
    if (dropped) return;

    for (const [q, x] of Object.entries(a)) {
      if (x.type !== "choice") continue;
      sql.exec("INSERT INTO hist (dim, k, n) VALUES (?, ?, 1) ON CONFLICT(dim, k) DO UPDATE SET n = n + 1", q, x.choice);
    }

    const botP = num("bot") ?? 0;
    const terms = botP > 0.6 ? [] : extractTerms(post.text);
    const minute = Math.floor(post.at / MINUTE);
    const hour = Math.floor(post.at / HOUR);
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
      : Math.max(...a.probabilities);
    const modelAnswer = a.type === "noul" ? (a.noul >= 0.5 ? "yes" : "no") : a.type === "choice" ? a.choice : a.legend[Math.round(a.score)];
    this.ctx.storage.sql.exec(
      "INSERT INTO votes (ts, post_id, question, model_p, model_answer, flagged, agree) VALUES (?, ?, ?, ?, ?, ?, ?)",
      Date.now(), postId, question, modelP, modelAnswer, flagged, agree ? 1 : 0,
    );
    this.bump("votes", 1);
    this.broadcast({ type: "calibration", calibration: this.calibration() });
  }

  private recent(): JudgedPost[] {
    return this.ctx.storage.sql
      .exec<{ id: string; ts: number; url: string; text: string; json: string; review: string; latency: number; tokens: number }>(
        "SELECT id, ts, url, text, json, review, latency, tokens FROM judgments WHERE dropped = 0 ORDER BY ts DESC LIMIT ?", RECENT_LIMIT)
      .toArray()
      .reverse()
      .map((r) => ({ id: r.id, url: r.url, text: r.text, at: r.ts, latencyMs: r.latency, inputTokens: r.tokens, answers: JSON.parse(r.json), review: r.review ? r.review.split(",") : [] }));
  }

  // ---- analytics ------------------------------------------------------------

  stats(): Stats {
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

  private crosstab(rows: string, cols: string, minutes: number) {
    const dims = new Set(["intent", "topic"]);
    if (!dims.has(rows) || !dims.has(cols)) return { error: "rows and cols must be intent or topic" };
    return this.ctx.storage.sql.exec<Row>(
      `SELECT ${rows} AS row, ${cols} AS col, COUNT(*) AS n, AVG(hostile) AS hostile, AVG(sarcasm) AS sarcasm, AVG(bait)/3 AS bait, AVG(sentiment)/4 AS sentiment
       FROM judgments WHERE ts >= ? AND dropped = 0 GROUP BY row, col ORDER BY n DESC`,
      Date.now() - minutes * MINUTE).toArray();
  }

  private exportNdjson(since: number, limit: number): Response {
    const rows = this.ctx.storage.sql.exec<Row>(
      "SELECT id, ts, url, text, json, review, latency, tokens FROM judgments WHERE ts > ? AND dropped = 0 ORDER BY ts LIMIT ?",
      since, Math.min(Math.max(1, limit), 20000)).toArray();
    const body = rows.map((r) => JSON.stringify({ ...r, json: undefined, answers: JSON.parse(r.json as string) })).join("\n") + "\n";
    return new Response(body, { headers: { "Content-Type": "application/x-ndjson", "Access-Control-Allow-Origin": "*", "X-Next-Since": String(rows.at(-1)?.ts ?? since) } });
  }
}

function json(data: unknown): Response {
  return new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" } });
}

export { confidenceOf };
