const $ = (id) => document.getElementById(id);
const FEED_MAX = 40;
const REVIEW_MAX = 20;
const HIST_COLORS = ["#f59e0b", "#3b82f6", "#34d399", "#a78bfa", "#fb7185", "#22d3ee", "#facc15", "#f97316", "#94a3b8", "#4ade80"];

let questions = {};
let shownJudged = 0;

function connect() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onopen = () => { $("status").textContent = "connected"; };
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === "hello") {
      questions = msg.questions;
      $("threshold").title = Object.entries(msg.thresholds).map(([k, v]) => `${k} < ${v}`).join(", ");
      $("feed").replaceChildren();
      $("review").replaceChildren();
      for (const p of msg.recent) addPost(p, false);
      renderStats(msg.stats);
    } else if (msg.type === "post") {
      addPost(msg.post, true);
      renderStats(msg.stats);
    } else if (msg.type === "stats") {
      renderStats(msg.stats);
    }
  };
  ws.onclose = () => { $("status").textContent = "reconnecting…"; $("live-dot").className = "dot"; setTimeout(connect, 1500); };
}

function renderStats(s) {
  animateNumber($("s-judged"), s.judged);
  $("s-latency").textContent = s.medianLatencyMs ? s.medianLatencyMs : "–";
  $("s-cost").textContent = s.costUsd.toFixed(4);
  $("s-review").textContent = s.judged ? Math.round((100 * s.reviewed) / s.judged) : 0;
  $("s-rate").textContent = s.live ? `${s.ratePerSec}/s of ${Math.round(s.seenPerSec)}/s` : "paused";
  $("s-viewers").textContent = s.viewers;
  $("model").textContent = s.model ? `(${s.model})` : "";
  $("live-dot").className = s.live ? "dot live" : "dot";
  $("status").textContent = s.live ? "live · sampling the firehose" : s.viewers ? "connecting to jetstream…" : "idle";
  renderHist(s.hist.intent || {});
}

function animateNumber(el, target) {
  const from = shownJudged;
  shownJudged = target;
  if (target - from > 50 || target < from) { el.textContent = target.toLocaleString(); return; }
  const t0 = performance.now();
  const step = (t) => {
    const k = Math.min(1, (t - t0) / 350);
    el.textContent = Math.round(from + (target - from) * k).toLocaleString();
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function renderHist(h) {
  const total = Object.values(h).reduce((a, b) => a + b, 0) || 1;
  const keys = Object.keys(questions.intent?.criteria || h);
  const el = $("hist");
  el.replaceChildren(...keys.map((k, i) => {
    const seg = document.createElement("div");
    seg.className = "seg";
    seg.style.flex = String((h[k] || 0) / total);
    seg.style.background = HIST_COLORS[i % HIST_COLORS.length];
    seg.title = `${k}: ${h[k] || 0}`;
    if ((h[k] || 0) / total > 0.07) seg.textContent = `${k} ${Math.round((100 * (h[k] || 0)) / total)}%`;
    return seg;
  }));
}

function addPost(p, animate) {
  const card = renderCard(p);
  if (!animate) card.style.animation = "none";
  prepend($("feed"), card, FEED_MAX);
  if (p.review.length) prepend($("review"), renderCard(p), REVIEW_MAX);
}

function prepend(container, el, max) {
  container.prepend(el);
  while (container.children.length > max) container.lastChild.remove();
}

function renderCard(p) {
  const card = document.createElement("article");
  card.className = "card";
  const unsure = new Set(p.review);

  const text = document.createElement("p");
  text.className = "text";
  text.textContent = p.text;

  const meta = document.createElement("div");
  meta.className = "meta";
  meta.innerHTML = `<span>${p.latencyMs}ms</span><span>${p.inputTokens} tok</span><a href="${p.url}" target="_blank" rel="noopener">bsky ↗</a>`;

  const rows = document.createElement("div");
  rows.className = "rows";
  const pills = [];
  for (const [q, a] of Object.entries(p.answers)) {
    if (q === "nsfw") continue;
    if (a.type === "noul") { pills.push(pill(q, a.noul, unsure.has(q))); continue; }
    rows.append(label(q, unsure.has(q)), a.type === "choice" ? choiceBar(a) : meter(a, q === "bait"));
  }
  if (pills.length) {
    const wrap = document.createElement("div");
    wrap.className = "pills";
    wrap.append(...pills);
    rows.append(label("signals", false), wrap);
  }
  card.append(text, meta, rows);
  return card;
}

function label(q, unsure) {
  const el = document.createElement("div");
  el.className = "q" + (unsure ? " unsure" : "");
  el.textContent = q;
  el.title = questions[q]?.instructions || "";
  return el;
}

function choiceBar(a) {
  const bar = document.createElement("div");
  bar.className = "bar";
  const sorted = Object.entries(a.probabilities).sort((x, y) => y[1] - x[1]).slice(0, 3).filter(([, p]) => p >= 0.01);
  sorted.forEach(([k, p], i) => {
    const seg = document.createElement("div");
    seg.className = "seg" + (i ? " alt" : "");
    seg.style.width = `${p * 100}%`;
    seg.style.opacity = String(0.9 - i * 0.3);
    seg.title = `${k} ${(p * 100).toFixed(0)}%`;
    bar.append(seg);
  });
  const lbl = document.createElement("span");
  lbl.className = "lbl";
  lbl.textContent = sorted.map(([k, p]) => `${k} ${Math.round(p * 100)}`).join(" · ");
  bar.append(lbl);
  return bar;
}

function meter(a, hot) {
  const el = document.createElement("div");
  el.className = "meter";
  const n = a.legend.length;
  const lit = Math.round(a.score) + 1;
  for (let i = 0; i < n; i++) {
    const s = document.createElement("div");
    s.className = "step" + (i < lit ? (hot && i >= n - 2 ? " hot" : " on") : "");
    el.append(s);
  }
  const lbl = document.createElement("span");
  lbl.className = "lbl";
  lbl.textContent = a.legend[Math.round(a.score)] || a.score.toFixed(2);
  el.append(lbl);
  return el;
}

function pill(q, p, unsure) {
  const el = document.createElement("span");
  el.className = "pill" + (p > 0.65 ? " yes" : unsure ? " maybe" : "");
  el.textContent = `${q} ${Math.round(p * 100)}%`;
  return el;
}

connect();
