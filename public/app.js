const $ = (id) => document.getElementById(id);
const SERIES = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"];
const FEED_MAX = 40;
const FEED_INTERVAL_MS = 1500;
const SIGNALS = [["hostile", "hostile"], ["sarcasm", "sarcasm"], ["bait", "bait /3"], ["sentiment", "sentiment /4"]];
const BARO = [["sentiment", "mood", (v) => v == null ? "–" : `${Math.round(v * 100)}`], ["bait", "bait"], ["hostile", "hostile"], ["sarcasm", "sarcasm"], ["bot", "bots"]];

let questions = {};
let intentKeys = [];
let ws;
let tab = "all";
let shownJudged = 0;
const queue = [];
const seenIds = new Set();
let reviewCount = 0;

// ---- connection ------------------------------------------------------------

function connect() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === "hello") {
      questions = msg.questions;
      intentKeys = Object.keys(questions.intent?.criteria || {});
      $("feed").replaceChildren();
      seenIds.clear();
      queue.length = 0;
      for (const p of msg.recent) enqueue(p, true);
      renderStats(msg.stats);
      renderPanel(msg.panel);
    } else if (msg.type === "post") {
      enqueue(msg.post, false);
      renderStats(msg.stats);
    } else if (msg.type === "stats") {
      renderStats(msg.stats);
    } else if (msg.type === "panel") {
      renderPanel(msg.panel);
    } else if (msg.type === "calibration") {
      renderCalibration(msg.calibration);
    }
  };
  ws.onclose = () => { $("status").textContent = "reconnecting…"; $("live-dot").className = "dot"; setTimeout(connect, 1500); };
}

function renderStats(s) {
  animateNumber($("s-judged"), s.judged);
  $("s-latency").textContent = s.medianLatencyMs || "–";
  $("s-cost").textContent = s.costUsd.toFixed(2);
  $("s-review").textContent = s.judged ? Math.round((100 * s.reviewed) / s.judged) : 0;
  $("s-votes").textContent = s.votes.toLocaleString();
  $("s-rate").textContent = s.live ? `${s.ratePerSec}/s of ${Math.round(s.seenPerSec)}/s` : "paused";
  $("s-viewers").textContent = s.viewers;
  $("model").textContent = s.model ? `(${s.model})` : "";
  $("live-dot").className = s.live ? "dot live" : "dot";
  $("status").textContent = s.live ? "live" : "connecting to jetstream…";
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

// ---- panel -------------------------------------------------------------------

function renderPanel(p) {
  baroTarget(p.baro);
  renderBars($("bars-intent"), p.shares.intent, intentKeys);
  renderBars($("bars-topic"), p.shares.topic, Object.keys(questions.topic?.criteria || {}));
  renderIntentTrend(p.series);
  renderSignals(p.series);
  renderCloud(p.terms);
  renderGraph(p.graph);
  renderWire(p.wire);
  renderCalibration(p.calibration);
  renderPerf(p.perf);
  workload = p.workload;
  renderSavings();
}

// ---- performance ------------------------------------------------------------

function renderPerf(perf) {
  const host = $("perf");
  if (!perf || !perf.n) { host.innerHTML = '<div class="hint">collecting…</div>'; return; }
  const hist = (title, right, rows, unit, hiFrom) => {
    const max = Math.max(1, ...rows.map((r) => r.n));
    const bars = rows.map((r) => `<i style="height:${Math.max(2, (100 * r.n) / max)}%" class="${hiFrom != null && r.b >= hiFrom ? "hi" : ""}" title="${r.b}${unit}: ${r.n}"></i>`).join("");
    return `<div class="h"><div class="t"><span>${title}</span><b>${right}</b></div><div class="bars">${bars}</div><div class="ax"><span>${rows[0]?.b ?? ""}${unit}</span><span>${rows.at(-1)?.b ?? ""}${unit}</span></div></div>`;
  };
  const pctOf = (rows, p) => { const t = rows.reduce((a, r) => a + r.n, 0); let acc = 0; for (const r of rows) { acc += r.n; if (acc >= t * p) return r.b; } return null; };
  const conf = (rows) => { const t = rows.reduce((a, r) => a + r.n, 0) || 1; return `${Math.round((100 * rows.filter((r) => r.b >= 80).reduce((a, r) => a + r.n, 0)) / t)}% ≥80` ; };
  const fence = (rows) => { const t = rows.reduce((a, r) => a + r.n, 0) || 1; return `${Math.round((100 * rows.filter((r) => r.b >= 30 && r.b < 70).reduce((a, r) => a + r.n, 0)) / t)}% in 30–70`; };
  host.innerHTML = [
    hist("latency", `p50 ${perf.p50} · p90 ${perf.p90} · p99 ${perf.p99}ms`, perf.latency.filter((r) => r.b < 2000), "ms", perf.p90),
    hist("input tokens / post", `p50 ${pctOf(perf.tokens, 0.5)}`, perf.tokens, "", null),
    hist("intent confidence", conf(perf.intentConf), perf.intentConf, "", 80),
    hist("topic confidence", conf(perf.topicConf), perf.topicConf, "", 80),
    hist("hostile p(yes)", fence(perf.hostile), perf.hostile, "", null),
    hist("sarcasm p(yes)", fence(perf.sarcasm), perf.sarcasm, "", null),
    hist("bot p(yes)", fence(perf.bot), perf.bot, "", null),
    `<div class="h"><div class="t"><span>sample</span><b>${perf.n.toLocaleString()} posts</b></div><div class="note hint" style="margin:0">24h window. Confidence = how peaked the distribution is; a noul near 50 is the model saying it does not know. Highlighted bars: latency past p90, confidence ≥ 80.</div></div>`,
  ].join("");
}

// ---- savings ---------------------------------------------------------------

let workload = null;
const pref = (k, d) => { try { return Number(localStorage.getItem(k)) || d; } catch { return d; } };
const savingsIn = { secs: pref("secsPerPost", 20), rate: pref("usdPerHour", 30) };

function renderSavings() {
  const host = $("savings");
  const w = workload;
  if (!w || !w.judged24h) { host.innerHTML = '<div class="hint">collecting…</div>'; return; }
  const perDay = (w.judged24h / w.hoursObserved) * 24;
  const reviewShare = w.reviewed24h / w.judged24h;
  const autoShare = 1 - reviewShare;
  const hoursAll = (perDay * savingsIn.secs) / 3600;
  const hoursSaved = hoursAll * autoShare;
  const usdSaved = hoursSaved * savingsIn.rate;
  const jevPerDay = ((w.tokens24h / w.hoursObserved) * 24 / 1e6) * w.pricePerM;
  const fid = w.confidentAgree == null ? null : Math.round(w.confidentAgree * 100);
  const errs = fid == null ? null : Math.round(perDay * autoShare * (1 - w.confidentAgree));
  host.innerHTML = `
    <div class="in">
      <label>sec / post <input id="in-secs" type="number" min="1" max="600" value="${savingsIn.secs}"></label>
      <label>$ / hour <input id="in-rate" type="number" min="1" max="500" value="${savingsIn.rate}"></label>
    </div>
    <div class="row"><span>posts / day at this sampling</span><b>${Math.round(perDay).toLocaleString()}</b></div>
    <div class="row"><span>model decides alone</span><b>${Math.round(autoShare * 100)}%</b></div>
    <div class="row"><span>a human still reviews</span><b>${Math.round(reviewShare * 100)}% · ${(hoursAll * reviewShare).toFixed(1)} h/day</b></div>
    <div class="row hero"><span>human hours saved / day</span><b>${hoursSaved.toFixed(1)} h</b></div>
    <div class="row"><span>worth, at your rate</span><b>$${Math.round(usdSaved).toLocaleString()} / day</b></div>
    <div class="row"><span>Jev bill at this rate</span><b>$${jevPerDay.toFixed(2)} / day</b></div>
    <div class="row"><span>fidelity on confident answers</span><b>${fid == null ? "no spot checks yet" : `${fid}% (n=${w.confidentVotes})`}</b></div>
    <div class="note">${fid == null ? "Confident cards in the feed carry a spot-check question. Each vote on one measures how often the model is right when it was sure, and that becomes the fidelity above." : `At that fidelity, about ${errs.toLocaleString()} of the auto-decided posts per day would be judged differently by a human.`}${w.hoursObserved < 24 ? ` Extrapolated from ${w.hoursObserved.toFixed(1)} h of data.` : ""}</div>`;
  $("in-secs").onchange = (e) => { savingsIn.secs = Number(e.target.value) || 20; try { localStorage.setItem("secsPerPost", savingsIn.secs); } catch {} renderSavings(); };
  $("in-rate").onchange = (e) => { savingsIn.rate = Number(e.target.value) || 30; try { localStorage.setItem("usdPerHour", savingsIn.rate); } catch {} renderSavings(); };
}

function renderBars(el, shares, keys) {
  const hotTotal = Object.values(shares).reduce((a, b) => a + b.hot, 0) || 1;
  const baseTotal = Object.values(shares).reduce((a, b) => a + b.base, 0) || 1;
  const rows = keys.map((k) => {
    const s = shares[k] || { hot: 0, base: 0 };
    return { k, hot: s.hot / hotTotal, base: s.base / baseTotal };
  }).sort((a, b) => b.hot - a.hot);
  const max = Math.max(0.05, ...rows.map((r) => Math.max(r.hot, r.base)));
  const frag = document.createDocumentFragment();
  for (const h of ["", "", "10m", "vs 24h"]) { const d = document.createElement("div"); d.className = "head"; d.textContent = h; frag.append(d); }
  for (const r of rows) {
    const k = document.createElement("div"); k.className = "k"; k.textContent = r.k; k.title = questions[el.id === "bars-intent" ? "intent" : "topic"]?.criteria?.[r.k] || "";
    const track = document.createElement("div"); track.className = "track";
    const fill = document.createElement("div"); fill.className = "fill"; fill.style.width = `${(100 * r.hot) / max}%`;
    const base = document.createElement("div"); base.className = "base"; base.style.left = `${(100 * r.base) / max}%`; base.title = `24h: ${Math.round(r.base * 100)}%`;
    track.append(fill, base);
    const pct = document.createElement("div"); pct.className = "pct"; pct.textContent = `${Math.round(r.hot * 100)}%`;
    const d = Math.round((r.hot - r.base) * 100);
    const delta = document.createElement("div"); delta.className = "delta " + (d > 1 ? "up" : d < -1 ? "down" : ""); delta.textContent = d > 0 ? `▲${d}` : d < 0 ? `▼${-d}` : "·";
    frag.append(k, track, pct, delta);
  }
  el.replaceChildren(frag);
}

// ---- barometer (canvas equalizer) --------------------------------------------

const baro = { level: [0, 0, 0, 0, 0], target: [0, 0, 0, 0, 0], peak: [0, 0, 0, 0, 0], base: [null, null, null, null, null], raw: [] };

function baroTarget(b) {
  BARO.forEach(([k], i) => {
    baro.target[i] = b[k]?.now ?? 0;
    baro.base[i] = b[k]?.base ?? null;
  });
  baro.raw = BARO.map(([k]) => b[k]?.now);
  const labels = BARO.map(([k, name], i) => `<div><div class="v">${baro.raw[i] == null ? "–" : Math.round(baro.raw[i] * 100)}</div><div class="k">${name}</div></div>`).join("");
  $("baro-labels").innerHTML = labels;
}

function drawBaro() {
  const c = $("baro");
  const ctx = c.getContext("2d");
  const W = c.width, H = c.height;
  const n = BARO.length, leds = 24, gap = 3;
  const colW = W / n, ledH = (H - 16) / leds;
  ctx.clearRect(0, 0, W, H);
  for (let i = 0; i < n; i++) {
    // Attack fast, release slow, like a real meter.
    const t = baro.target[i];
    baro.level[i] += (t - baro.level[i]) * (t > baro.level[i] ? 0.18 : 0.05);
    baro.peak[i] = baro.level[i] >= baro.peak[i] ? baro.level[i] : baro.peak[i] - 0.0015;
    const x0 = i * colW + colW * 0.2, w = colW * 0.6;
    const lit = Math.round(baro.level[i] * leds);
    for (let j = 0; j < leds; j++) {
      const y = H - 8 - (j + 1) * ledH + gap / 2;
      const frac = j / leds;
      ctx.fillStyle = j < lit ? ledColor(frac) : "#232322";
      ctx.fillRect(x0, y, w, ledH - gap);
    }
    const py = H - 8 - baro.peak[i] * (H - 16);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(x0, py - 1, w, 2);
    if (baro.base[i] != null) {
      const by = H - 8 - baro.base[i] * (H - 16);
      ctx.fillStyle = "#c3c2b7";
      ctx.fillRect(x0 - 6, by - 1, 4, 2);
      ctx.fillRect(x0 + w + 2, by - 1, 4, 2);
    }
  }
  requestAnimationFrame(drawBaro);
}

// One sequential hue, light at the bottom to deep at the top.
function ledColor(frac) {
  const stops = ["#86b6ef", "#5598e7", "#3987e5", "#256abf", "#1c5cab"];
  return stops[Math.min(stops.length - 1, Math.floor(frac * stops.length))];
}

// ---- svg charts -------------------------------------------------------------

function svgEl(name, attrs = {}) {
  const el = document.createElementNS("http://www.w3.org/2000/svg", name);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

function minuteAxis(series, W, H, padL, padB) {
  const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}` });
  const plotW = W - padL - 8, plotH = H - padB - 6;
  for (const f of [0, 0.5, 1]) {
    const y = 6 + plotH * (1 - f);
    svg.append(svgEl("line", { x1: padL, x2: W - 8, y1: y, y2: y, class: f === 0 ? "axis" : "grid" }));
    const t = svgEl("text", { x: padL - 4, y: y + 3, "text-anchor": "end" }); t.textContent = `${Math.round(f * 100)}%`; svg.append(t);
  }
  const first = series[0]?.m, last = series.at(-1)?.m;
  if (first != null && last != null && last > first) {
    for (const m of [first, Math.round((first + last) / 2), last]) {
      const x = padL + (plotW * (m - first)) / (last - first);
      const t = svgEl("text", { x, y: H - 2, "text-anchor": m === first ? "start" : m === last ? "end" : "middle" });
      t.textContent = new Date(m * 60000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      svg.append(t);
    }
  }
  return { svg, plotW, plotH, padL, first, last, x: (m) => padL + (last > first ? (plotW * (m - first)) / (last - first) : 0), y: (v) => 6 + plotH * (1 - v) };
}

function fillMinutes(series) {
  if (!series.length) return [];
  const byM = new Map(series.map((r) => [r.m, r]));
  const out = [];
  for (let m = series[0].m; m <= series.at(-1).m; m++) out.push(byM.get(m) || { m, n: 0, intent: {}, hostile: null, sarcasm: null, bait: null, sentiment: null });
  return out;
}

function renderIntentTrend(raw) {
  const series = fillMinutes(raw);
  const host = $("trend-intent");
  if (series.length < 2) { host.innerHTML = '<div class="hint">collecting…</div>'; return; }
  const W = 900, H = 170;
  const ax = minuteAxis(series, W, H, 34, 14);
  const stacks = series.map((r) => {
    const total = intentKeys.reduce((a, k) => a + (r.intent[k] || 0), 0) || 1;
    let acc = 0;
    return intentKeys.map((k) => { const v = (r.intent[k] || 0) / total; const seg = [acc, acc + v]; acc += v; return seg; });
  });
  intentKeys.forEach((k, i) => {
    const top = series.map((r, j) => `${ax.x(r.m).toFixed(1)},${ax.y(stacks[j][i][1]).toFixed(1)}`);
    const bottom = series.map((r, j) => `${ax.x(r.m).toFixed(1)},${ax.y(stacks[j][i][0]).toFixed(1)}`).reverse();
    ax.svg.append(svgEl("polygon", { points: [...top, ...bottom].join(" "), fill: SERIES[i], stroke: "#1a1a19", "stroke-width": 1, opacity: 0.9 }));
  });
  host.replaceChildren(ax.svg);
  hoverLayer(host, ax, series, (r) => {
    const total = intentKeys.reduce((a, k) => a + (r.intent[k] || 0), 0) || 1;
    return `<b>${fmtMin(r.m)}</b> · ${r.n} posts<br>` + intentKeys.filter((k) => r.intent[k]).map((k) => `${k} ${Math.round((100 * r.intent[k]) / total)}%`).join(" · ");
  });
  $("legend-intent").innerHTML = intentKeys.map((k, i) => `<span><i class="sw" style="background:${SERIES[i]}"></i>${k}</span>`).join("");
}

function renderSignals(raw) {
  const series = fillMinutes(raw);
  const host = $("trend-signals");
  if (series.length < 2) { host.innerHTML = '<div class="hint">collecting…</div>'; return; }
  const W = 900, H = 150;
  const ax = minuteAxis(series, W, H, 34, 14);
  SIGNALS.forEach(([k], i) => {
    const pts = series.filter((r) => r[k] != null).map((r) => `${ax.x(r.m).toFixed(1)},${ax.y(r[k]).toFixed(1)}`);
    ax.svg.append(svgEl("polyline", { points: pts.join(" "), fill: "none", stroke: SERIES[i], "stroke-width": 2, "stroke-linejoin": "round" }));
  });
  host.replaceChildren(ax.svg);
  hoverLayer(host, ax, series, (r) => `<b>${fmtMin(r.m)}</b> · ${r.n} posts<br>` + SIGNALS.map(([k, name]) => `${name.split(" ")[0]} ${r[k] == null ? "–" : Math.round(r[k] * 100)}`).join(" · "));
  $("legend-signals").innerHTML = SIGNALS.map(([, name], i) => `<span><i class="sw" style="background:${SERIES[i]}"></i>${name}</span>`).join("");
}

function fmtMin(m) { return new Date(m * 60000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); }

function hoverLayer(host, ax, series, html) {
  const cross = svgEl("line", { y1: 6, y2: 6 + ax.plotH, class: "cross" });
  ax.svg.append(cross);
  const tip = document.createElement("div"); tip.className = "tip"; host.append(tip);
  host.onmousemove = (e) => {
    const rect = ax.svg.getBoundingClientRect();
    const xm = ((e.clientX - rect.left) / rect.width) * ax.svg.viewBox.baseVal.width;
    const m = Math.round(ax.first + ((xm - ax.padL) / ax.plotW) * (ax.last - ax.first));
    const r = series.find((s) => s.m === m);
    if (!r) return;
    cross.style.display = "block"; cross.setAttribute("x1", ax.x(m)); cross.setAttribute("x2", ax.x(m));
    tip.style.display = "block"; tip.innerHTML = html(r);
    tip.style.left = `${Math.min(rect.width - tip.offsetWidth - 4, Math.max(0, e.clientX - rect.left + 12))}px`;
    tip.style.top = `${e.clientY - rect.top - 10}px`;
  };
  host.onmouseleave = () => { cross.style.display = "none"; tip.style.display = "none"; };
}

// ---- cloud ------------------------------------------------------------------

function renderCloud(terms) {
  const el = $("cloud");
  if (!terms.length) { el.innerHTML = '<span class="empty">warming up…</span>'; return; }
  const hots = terms.map((t) => t.hot).sort((a, b) => a - b);
  const q = (f) => hots[Math.min(hots.length - 1, Math.floor(f * hots.length))];
  const s2 = q(0.6), s3 = q(0.9);
  const frag = document.createDocumentFragment();
  for (const t of terms.slice(0, 48)) {
    const span = document.createElement("span");
    const size = t.hot >= s3 ? "s3" : t.hot >= s2 ? "s2" : "s1";
    const burst = t.burst >= 4 ? "b3" : t.burst >= 2 ? "b2" : t.burst >= 1.3 ? "b1" : "";
    span.className = `term ${size} ${burst} ${t.t.startsWith("#") ? "tag" : ""}`;
    span.innerHTML = `${escapeHtml(t.t)}<small>${t.hot}</small>`;
    span.title = `${t.hot} in the last 15 min · ${t.base} in 6h · ${t.burst.toFixed(1)}× expected`;
    frag.append(span);
  }
  el.replaceChildren(frag);
}

function escapeHtml(s) { return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

// ---- co-occurrence graph (tiny force layout) --------------------------------

const gpos = new Map();

function renderGraph(g) {
  const svg = $("graph");
  const W = 480, H = 360;
  const linked = new Set(g.edges.flatMap((e) => [e.a, e.b]));
  const nodes = g.nodes.filter((n) => linked.has(n.id));
  svg.replaceChildren();
  if (nodes.length < 2) { const t = svgEl("text", { x: W / 2, y: H / 2, "text-anchor": "middle" }); t.textContent = "no repeated pairs yet"; svg.append(t); return; }
  const maxN = Math.max(...nodes.map((n) => n.n));
  const pos = new Map(nodes.map((n, i) => {
    const prev = gpos.get(n.id);
    const a = (i / nodes.length) * Math.PI * 2;
    return [n.id, prev || { x: W / 2 + Math.cos(a) * 120, y: H / 2 + Math.sin(a) * 100, vx: 0, vy: 0 }];
  }));
  const r = (n) => 4 + 10 * Math.sqrt(n.n / maxN);
  for (let it = 0; it < 220; it++) {
    for (const a of nodes) {
      const pa = pos.get(a.id);
      let fx = (W / 2 - pa.x) * 0.01, fy = (H / 2 - pa.y) * 0.01;
      for (const b of nodes) {
        if (a === b) continue;
        const pb = pos.get(b.id);
        let dx = pa.x - pb.x, dy = pa.y - pb.y;
        const d2 = dx * dx + dy * dy + 0.01, d = Math.sqrt(d2);
        const f = 1800 / d2;
        fx += (dx / d) * f; fy += (dy / d) * f;
      }
      pa.vx = (pa.vx + fx) * 0.5; pa.vy = (pa.vy + fy) * 0.5;
    }
    for (const e of g.edges) {
      const pa = pos.get(e.a), pb = pos.get(e.b);
      if (!pa || !pb) continue;
      const dx = pb.x - pa.x, dy = pb.y - pa.y, d = Math.sqrt(dx * dx + dy * dy) + 0.01;
      const want = 70, k = ((d - want) / d) * 0.02 * Math.min(3, e.n);
      pa.vx += dx * k; pa.vy += dy * k; pb.vx -= dx * k; pb.vy -= dy * k;
    }
    for (const n of nodes) { const p = pos.get(n.id); p.x = Math.max(30, Math.min(W - 30, p.x + p.vx)); p.y = Math.max(14, Math.min(H - 14, p.y + p.vy)); }
  }
  for (const [id, p] of pos) gpos.set(id, p);
  const maxE = Math.max(...g.edges.map((e) => e.n));
  for (const e of g.edges) {
    const pa = pos.get(e.a), pb = pos.get(e.b);
    if (!pa || !pb) continue;
    const l = svgEl("line", { x1: pa.x, y1: pa.y, x2: pb.x, y2: pb.y, "stroke-width": 1 + (3 * e.n) / maxE, opacity: 0.35 + (0.5 * e.n) / maxE });
    l.append(svgEl("title")); l.firstChild.textContent = `${e.a} + ${e.b}: ${e.n} posts`;
    svg.append(l);
  }
  for (const n of nodes) {
    const p = pos.get(n.id);
    const c = svgEl("circle", { cx: p.x, cy: p.y, r: r(n) });
    c.append(svgEl("title")); c.firstChild.textContent = `${n.id}: ${n.n} mentions`;
    const t = svgEl("text", { x: p.x + r(n) + 3, y: p.y + 3 }); t.textContent = n.id;
    svg.append(c, t);
  }
}

// ---- wire + calibration -----------------------------------------------------

function renderWire(rows) {
  const el = $("wire");
  el.replaceChildren(...rows.map((r) => {
    const li = document.createElement("li");
    li.innerHTML = `<div class="t">${escapeHtml(r.text)}</div><div class="m"><span class="hot">bait ${(r.bait || 0).toFixed(1)}/3</span><span class="hot">hostile ${Math.round((r.hostile || 0) * 100)}%</span><span>${r.intent} · ${r.topic}</span><a href="${r.url}" target="_blank" rel="noopener">bsky ↗</a></div>`;
    return li;
  }));
}

function renderCalibration(c) {
  const host = $("calibration");
  $("s-votes").textContent = (c.votes || 0).toLocaleString();
  if (!c.votes || c.votes < 5) { host.innerHTML = `<div class="hint">${c.votes || 0} votes so far. Vote on cards in the "needs a human" tab and the curve appears here.</div>`; $("calib-foot").textContent = ""; return; }
  const W = 300, H = 170, padL = 30, padB = 22;
  const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}` });
  const plotW = W - padL - 8, plotH = H - padB - 8;
  const x = (p) => padL + plotW * p, y = (v) => 8 + plotH * (1 - v);
  for (const f of [0, 0.5, 1]) {
    svg.append(svgEl("line", { x1: padL, x2: W - 8, y1: y(f), y2: y(f), class: f === 0 ? "axis" : "grid" }));
    const t = svgEl("text", { x: padL - 4, y: y(f) + 3, "text-anchor": "end" }); t.textContent = `${f * 100}%`; svg.append(t);
  }
  for (const p of [0, 0.5, 1]) { const t = svgEl("text", { x: x(p), y: H - 4, "text-anchor": p === 0 ? "start" : p === 1 ? "end" : "middle" }); t.textContent = `${Math.round(p * 100)}%`; svg.append(t); }
  svg.append(svgEl("line", { x1: x(0), y1: y(0), x2: x(1), y2: y(1), stroke: "#898781", "stroke-dasharray": "3 3" }));
  const bins = c.bins.filter((b) => b.n > 0);
  const pts = bins.map((b) => `${x(b.p)},${y(b.agree)}`);
  if (pts.length > 1) svg.append(svgEl("polyline", { points: pts.join(" "), fill: "none", stroke: SERIES[0], "stroke-width": 2 }));
  for (const b of bins) {
    const dot = svgEl("circle", { cx: x(b.p), cy: y(b.agree), r: 3 + Math.min(5, Math.sqrt(b.n)), fill: SERIES[0], stroke: "#1a1a19", "stroke-width": 2 });
    dot.append(svgEl("title")); dot.firstChild.textContent = `model ${Math.round(b.p * 100)}% sure → humans agreed ${Math.round(b.agree * 100)}% (n=${b.n})`;
    svg.append(dot);
  }
  const lbl = svgEl("text", { x: W / 2, y: 8, "text-anchor": "middle" }); lbl.textContent = "p(model's answer) → human agreement"; svg.append(lbl);
  host.replaceChildren(svg);
  $("calib-foot").textContent = `${c.votes} votes · humans agree ${Math.round((c.agree || 0) * 100)}% overall · dotted line = perfectly calibrated`;
}

// ---- feed (throttled) -------------------------------------------------------

function enqueue(p, immediate) {
  if (seenIds.has(p.id)) return;
  seenIds.add(p.id);
  if (p.review.length) { reviewCount++; $("review-count").textContent = reviewCount; }
  if (immediate) { addCard(p, false); return; }
  queue.push(p);
  if (queue.length > 12) queue.splice(0, queue.length - 12);
}

setInterval(() => { const p = queue.shift(); if (p) addCard(p, true); }, FEED_INTERVAL_MS);

const shown = [];
function addCard(p, animate) {
  shown.unshift(p);
  if (shown.length > FEED_MAX) shown.pop();
  if (tab === "review" && !p.review.length) return;
  const card = renderCard(p);
  if (!animate) card.style.animation = "none";
  const feed = $("feed");
  feed.prepend(card);
  while (feed.children.length > FEED_MAX) feed.lastChild.remove();
}

function rerenderFeed() {
  $("feed").replaceChildren(...shown.filter((p) => tab === "all" || p.review.length).map((p) => { const c = renderCard(p); c.style.animation = "none"; return c; }));
}

document.querySelectorAll(".tab").forEach((b) => b.onclick = () => {
  tab = b.dataset.tab;
  document.querySelectorAll(".tab").forEach((x) => x.classList.toggle("active", x === b));
  rerenderFeed();
});

function renderCard(p) {
  const a = p.answers;
  const card = document.createElement("article");
  card.className = "card" + (p.review.length ? " review" : "");
  const chips = [];
  if (a.intent) chips.push(chip(`${a.intent.choice} ${Math.round(a.intent.probabilities[a.intent.choice] * 100)}`, ""));
  if (a.topic) chips.push(chip(a.topic.choice, ""));
  if (a.sentiment) chips.push(chip(a.sentiment.legend[Math.round(a.sentiment.score)], ""));
  if (a.bait) chips.push(chip(`bait ${a.bait.score.toFixed(1)}`, a.bait.score >= 1.5 ? "hot" : a.bait.score >= 0.8 ? "warm" : ""));
  for (const k of ["hostile", "sarcasm", "bot"]) if (a[k]) chips.push(chip(`${k} ${Math.round(a[k].noul * 100)}%`, a[k].noul > 0.65 ? "hot" : a[k].noul > 0.4 ? "warm" : ""));
  card.innerHTML = `<p class="text">${escapeHtml(p.text)}</p><div class="meta"><span>${p.latencyMs}ms</span><span>${p.inputTokens} tok</span><a href="${p.url}" target="_blank" rel="noopener">bsky ↗</a></div>`;
  const wrap = document.createElement("div"); wrap.className = "chips"; wrap.append(...chips); card.append(wrap);
  for (const q of p.review) card.append(askRow(p, q, false));
  if (!p.review.length) {
    const qs = Object.keys(a).filter((k) => k !== "nsfw");
    card.append(askRow(p, qs[Math.floor(Math.random() * qs.length)], true));
  }
  return card;
}

function chip(text, cls) { const s = document.createElement("span"); s.className = `chip ${cls}`; s.textContent = text; return s; }

function askRow(p, q, spot) {
  const a = p.answers[q];
  const said = a.type === "noul" ? `${a.noul >= 0.5 ? "yes" : "no"} (${Math.round(Math.max(a.noul, 1 - a.noul) * 100)}%)`
    : a.type === "choice" ? `${a.choice} (${Math.round(a.probabilities[a.choice] * 100)}%)`
    : a.legend[Math.round(a.score)];
  const row = document.createElement("div");
  row.className = "ask" + (spot ? " spot" : "");
  row.innerHTML = `<span>${spot ? "spot check · " : ""}<b>${q}?</b> model says <b>${escapeHtml(said)}</b></span>`;
  row.title = questions[q]?.instructions || "";
  const yes = document.createElement("button"); yes.textContent = "right";
  const no = document.createElement("button"); no.textContent = "wrong";
  const vote = (agree) => {
    if (ws?.readyState !== 1) return;
    ws.send(JSON.stringify({ type: "vote", postId: p.id, question: q, agree }));
    yes.remove(); no.remove();
    const d = document.createElement("span"); d.className = "done"; d.textContent = "✓ counted"; row.append(d);
  };
  yes.onclick = () => vote(true);
  no.onclick = () => vote(false);
  row.append(yes, no);
  return row;
}

connect();
drawBaro();
