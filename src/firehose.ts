import { DurableObject } from "cloudflare:workers";
import { judge, needsReview, QUESTIONS, REVIEW_THRESHOLD, type Answer } from "./jev";

const HEARTBEAT_MS = 15_000;
const RECENT_LIMIT = 60;
const LATENCY_WINDOW = 200;
const NSFW_DROP = 0.6;

interface JetstreamEvent {
  did: string;
  kind: string;
  commit?: {
    operation: string;
    collection: string;
    rkey: string;
    record?: { text?: string; langs?: string[]; reply?: unknown; createdAt?: string };
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
  inputTokens: number;
  costUsd: number;
  medianLatencyMs: number;
  seen: number;
  seenPerSec: number;
  viewers: number;
  live: boolean;
  ratePerSec: number;
  model: string;
  hist: Record<string, Record<string, number>>;
}

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

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS counters (k TEXT PRIMARY KEY, v REAL NOT NULL);
        CREATE TABLE IF NOT EXISTS hist (dim TEXT, k TEXT, n INTEGER NOT NULL, PRIMARY KEY (dim, k));
        CREATE TABLE IF NOT EXISTS recent (id TEXT PRIMARY KEY, at INTEGER NOT NULL, json TEXT NOT NULL);
      `);
    });
  }

  // ---- viewers -----------------------------------------------------------

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return Response.json(this.stats());
    }
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[0]);
    pair[0].send(JSON.stringify({ type: "hello", stats: this.stats(), recent: this.recent(), questions: QUESTIONS, thresholds: REVIEW_THRESHOLD }));
    this.broadcast({ type: "stats", stats: this.stats() });
    await this.ensureUpstream();
    await this.ctx.storage.setAlarm(Date.now() + HEARTBEAT_MS);
    return new Response(null, { status: 101, webSocket: pair[1] });
  }

  async webSocketMessage(): Promise<void> {
    // Viewers are read-only; ignore anything they send.
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

  // ---- heartbeat ---------------------------------------------------------

  async alarm(): Promise<void> {
    if (this.viewers() === 0) {
      this.closeUpstream();
      return;
    }
    await this.ensureUpstream();
    this.broadcast({ type: "stats", stats: this.stats() });
    await this.ctx.storage.setAlarm(Date.now() + HEARTBEAT_MS);
  }

  // ---- upstream: bluesky jetstream ---------------------------------------

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
    // The heartbeat alarm reconnects if viewers are still here.
  }

  private closeUpstream(): void {
    const ws = this.upstream;
    this.upstream = null;
    try { ws?.close(1000, "no viewers"); } catch { /* already closed */ }
  }

  private takeToken(): boolean {
    const now = Date.now();
    const rate = Number(this.env.JUDGE_RATE_PER_SEC);
    this.allowance = Math.min(rate, this.allowance + ((now - this.lastRefill) / 1000) * rate);
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

  // ---- jev ----------------------------------------------------------------

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
    if (dropped) {
      this.broadcast({ type: "stats", stats: this.stats() });
      return;
    }
    this.broadcast({ type: "post", post, stats: this.stats() });
  }

  // ---- storage -----------------------------------------------------------

  private bump(k: string, by: number): void {
    this.ctx.storage.sql.exec("INSERT INTO counters (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = v + excluded.v", k, by);
  }

  private record(post: JudgedPost, dropped: boolean): void {
    const sql = this.ctx.storage.sql;
    this.bump("judged", 1);
    this.bump("input_tokens", post.inputTokens);
    if (dropped) { this.bump("filtered", 1); return; }
    if (post.review.length) this.bump("reviewed", 1);
    for (const [q, a] of Object.entries(post.answers)) {
      if (a.type !== "choice") continue;
      sql.exec("INSERT INTO hist (dim, k, n) VALUES (?, ?, 1) ON CONFLICT(dim, k) DO UPDATE SET n = n + 1", q, a.choice);
    }
    sql.exec("INSERT OR REPLACE INTO recent (id, at, json) VALUES (?, ?, ?)", post.id, post.at, JSON.stringify(post));
    sql.exec("DELETE FROM recent WHERE id NOT IN (SELECT id FROM recent ORDER BY at DESC LIMIT ?)", RECENT_LIMIT);
  }

  private recent(): JudgedPost[] {
    return this.ctx.storage.sql
      .exec<{ json: string }>("SELECT json FROM recent ORDER BY at ASC")
      .toArray()
      .map((r) => JSON.parse(r.json));
  }

  private counter(k: string): number {
    const row = this.ctx.storage.sql.exec<{ v: number }>("SELECT v FROM counters WHERE k = ?", k).toArray()[0];
    return row?.v ?? 0;
  }

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
      inputTokens,
      costUsd: (inputTokens / 1e6) * Number(this.env.PRICE_PER_M_INPUT),
      medianLatencyMs: sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0,
      seen: this.seen,
      seenPerSec: this.seen / Math.max(1, (Date.now() - this.sessionStart) / 1000),
      viewers: this.viewers(),
      live: this.upstream !== null,
      ratePerSec: Number(this.env.JUDGE_RATE_PER_SEC),
      model: this.model,
      hist,
    };
  }
}
