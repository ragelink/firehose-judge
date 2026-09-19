const $ = (id) => document.getElementById(id);
const SERIES = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"];
const FEED_MAX = 40;
const FEED_INTERVAL_MS = 1500;
const POLL_MS = 60000;
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
let thresholds = null;
const filter = { term: null, intent: null, topic: null };

// ---- connection ------------------------------------------------------------

function connect() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === "hello") {
      questions = msg.questions;
      thresholds = msg.thresholds || null;
      intentKeys = Object.keys(questions.intent?.criteria || {});
      $("feed").replaceChildren();
      seenIds.clear();
      queue.length = 0;
      for (const p of msg.recent) enqueue(p, true);
      renderStats(msg.stats);
      renderPanel(msg.panel);
      renderCurve();
      if (filterActive()) loadFiltered();
    } else if (msg.type === "post") {
      enqueue(msg.post, false);
      renderStats(msg.stats);
    } else if (msg.type === "stats") {
      renderStats(msg.stats);
    } else if (msg.type === "panel") {
      renderPanel(msg.panel);
    } else if (msg.type === "calibration") {
      renderCalibration(msg.calibration);
    } else if (msg.type === "backers") {
      renderBackers(msg.backers);
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
  $("s-viewers").textContent = s.viewers;
  $("model").textContent = s.model ? `(${s.model})` : "";
  // The daily budget stops the sampler; the page says so rather than looking dead.
  const b = s.budget;
  const paused = !!(b && b.paused);
  $("stat-budget").hidden = !b;
  if (b) { $("s-spent").textContent = usd(b.spent24h); $("s-cap").textContent = usd(b.usdPerDay); }
  $("s-rate").textContent = paused ? "paused" : s.live ? `${s.ratePerSec}/s of ${Math.round(s.seenPerSec)}/s` : "paused";
  $("live-dot").className = paused ? "dot paused" : s.live ? "dot live" : "dot";
  $("status").textContent = paused ? `paused · daily budget reached ($${usd(b.spent24h)} of $${usd(b.usdPerDay)})`
    : s.live ? "live" : "connecting to jetstream…";
  renderFunding(s.funding, b);
  renderAds(s.ads);
}

const usd = (v) => (Number(v) || 0).toFixed(2);

// ---- funding ----------------------------------------------------------------

let fundKey = "";

function renderFunding(f, budget) {
  const tile = $("fund-tile");
  if (!f) { tile.hidden = true; fundKey = ""; return; }
  tile.hidden = false;
  fundingLink = typeof f.link === "string" ? f.link : "";
  updateBuyLink();
  const cap = typeof budget?.usdPerDay === "number" ? budget.usdPerDay : null;
  const key = JSON.stringify([f.today, f.week, f.month, f.costToday, f.costWeek, f.costMonth, f.link, cap]);
  if (key === fundKey) return;
  fundKey = key;
  const bar = (label, got, cost, hue, tick) => {
    const g = Number(got) || 0, c = Number(cost) || 0;
    const pct = c > 0 ? Math.min(1, g / c) : g > 0 ? 1 : 0;
    const mark = tick != null && c > 0
      ? `<i class="tick" style="left:${(100 * Math.min(1, tick / c)).toFixed(1)}%" title="daily budget cap $${usd(tick)}"></i>` : "";
    return `<div class="m"><span class="k">${label}</span><div class="track"><i class="fill" style="width:${(100 * pct).toFixed(1)}%;background:var(${hue})"></i>${mark}</div><span class="v">$${usd(g)} of $${usd(c)}</span></div>`;
  };
  const day = cap || Number(f.costToday) || 5;
  const give = f.link
    ? `<a class="give" href="${escapeHtml(String(f.link))}" target="_blank" rel="noopener">cover a day ($${day % 1 ? day.toFixed(2) : day})</a>` : "";
  $("fund").innerHTML = `<div class="meters">${bar("today", f.today, f.costToday, "--seq-2", cap)}${bar("this week", f.week, f.costWeek, "--seq-4", null)}${bar("this month", f.month, f.costMonth, "--seq-6", null)}</div>`
    + `<div class="foot"><span>Jev bill + hosting, covered by readers</span>${give}</div>`;
}

// ---- backers ----------------------------------------------------------------

let fundingLink = "";

const BACKERS_SKELETON = `
  <div class="therm">
    <div class="col"><div class="tube"><i class="fill"></i><i class="tick" style="bottom:25%"></i><i class="tick" style="bottom:50%"></i><i class="tick" style="bottom:75%"></i><i class="tick" style="bottom:100%"></i></div><i class="bulb"></i></div>
    <div class="num"></div>
  </div>
  <div class="right">
    <div class="head"><span>top backers</span><a class="buy" href="#" target="_blank" rel="noopener" hidden>buy your way up ↗</a></div>
    <div class="board"></div>
    <div class="ticker"></div>
  </div>
  <div class="pin-slot"></div>`;

async function loadBackers() {
  let next = null;
  try {
    const res = await fetch("/api/backers");
    if (res.ok) { const data = await res.json(); if (data && Array.isArray(data.leaderboard)) next = data; }
  } catch {}
  renderBackers(next);
}

function renderBackers(b) {
  const tile = $("backers-tile");
  if (!b) { tile.hidden = true; return; }
  tile.hidden = false;
  const host = $("backers");
  // The skeleton is built once so the thermometer can transition between renders.
  if (!host.firstElementChild) host.innerHTML = BACKERS_SKELETON;
  const goal = Number(b.goalUsd) || 0, raised = Number(b.raisedMonth) || 0;
  host.querySelector(".tube .fill").style.height = `${(100 * (goal > 0 ? Math.min(1, raised / goal) : 0)).toFixed(1)}%`;
  host.querySelector(".num").innerHTML = `<b>$${money(raised)}</b> of $${money(goal)}<br><small>this month</small>`;
  updateBuyLink();
  const board = (b.leaderboard || []).slice(0, 10);
  host.querySelector(".board").innerHTML = board.length
    ? board.map((r, i) => `<div class="r"><span class="i">${i + 1}</span><span class="who">${escapeHtml(String(r.name ?? "anonymous"))}</span><span class="tier">${escapeHtml(String(r.tier || ""))}</span><span class="amt">$${money(r.total)}</span></div>`).join("")
    : '<div class="empty">no backers yet · the first name here takes the top slot</div>';
  const recent = (b.backers || []).slice(0, 8);
  host.querySelector(".ticker").textContent = recent.length
    ? `recent · ${recent.map((r) => `${r.name ?? "anonymous"} $${money(r.amount)}`).join(" · ")}` : "";
  renderPinned(host.querySelector(".pin-slot"), b.pinned);
}

function updateBuyLink() {
  const buy = $("backers").querySelector(".buy");
  if (!buy) return;
  buy.hidden = !fundingLink;
  if (fundingLink) buy.href = fundingLink;
}

function money(v) { const n = Number(v) || 0; return n % 1 ? n.toFixed(2) : String(Math.round(n)); }

// A paid message is still judged in public: same chips as any card in the feed.
function renderPinned(slot, pin) {
  if (!pin) { slot.replaceChildren(); return; }
  const box = document.createElement("div");
  box.className = "pinned";
  box.innerHTML = `<div class="who">on the wire, paid for by <b>${escapeHtml(String(pin.name || "anonymous"))}</b> · $${money(pin.amount)}</div>`
    + `<p class="msg">${linkifyOne(String(pin.message || ""))}</p>`;
  const chips = answerChips(pin.answers || {});
  if (chips.length) { const wrap = document.createElement("div"); wrap.className = "chips"; wrap.append(...chips); box.append(wrap); }
  box.append(...answerMeters(pin.answers || {}));
  const note = document.createElement("div");
  note.className = "note";
  note.textContent = "paid messages pass the same judge; anything the model flags as unsafe never shows";
  box.append(note);
  slot.replaceChildren(box);
}

// Only the URL in a paid message becomes a link, and it carries nofollow.
function linkifyOne(text) {
  const m = text.match(/https?:\/\/[^\s<]+/);
  if (!m) return escapeHtml(text);
  return escapeHtml(text.slice(0, m.index))
    + `<a href="${escapeHtml(m[0])}" target="_blank" rel="noopener nofollow">${escapeHtml(m[0])}</a>`
    + escapeHtml(text.slice(m.index + m[0].length));
}

setInterval(loadBackers, POLL_MS);
loadBackers();

// ---- ads --------------------------------------------------------------------

let adsLoaded = false;

// The one third-party script on the page, and only when both ids are configured.
function renderAds(ads) {
  if (adsLoaded || !ads?.client || !ads?.slot) return;
  adsLoaded = true;
  $("ads-tile").hidden = false;
  const ins = document.createElement("ins");
  ins.className = "adsbygoogle";
  ins.style.display = "block";
  ins.dataset.adClient = ads.client;
  ins.dataset.adSlot = ads.slot;
  ins.dataset.adFormat = "auto";
  ins.dataset.fullWidthResponsive = "true";
  $("ads").replaceChildren(ins);
  const script = document.createElement("script");
  script.async = true;
  script.src = `https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${encodeURIComponent(ads.client)}`;
  script.crossOrigin = "anonymous";
  document.head.append(script);
  (window.adsbygoogle = window.adsbygoogle || []).push({});
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
  renderBars($("bars-intent"), p.shares.intent, intentKeys, "intent");
  renderBars($("bars-topic"), p.shares.topic, Object.keys(questions.topic?.criteria || {}), "topic");
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
const pref = (k, d) => { try { const v = localStorage.getItem(k); return v === null || v === "" || Number.isNaN(Number(v)) ? d : Number(v); } catch { return d; } };
const savingsIn = { secs: pref("secsPerPost", 20), rate: pref("usdPerHour", 30) };

function renderSavings() {
  const host = $("savings");
  const w = workload;
  if (!w || !w.judged24h) { host.innerHTML = '<div class="hint">collecting…</div>'; return; }
  const perDay = (w.judged24h / w.hoursObserved) * 24;
  const liveShare = w.reviewed24h / w.judged24h;
  // With a curve loaded the arithmetic follows the slider's operating point, not the threshold the server happens to run.
  const op = operatingPoint();
  const reviewShare = op ? op.reviewShare : liveShare;
  const autoShare = 1 - reviewShare;
  const hoursAll = (perDay * savingsIn.secs) / 3600;
  const hoursSaved = hoursAll * autoShare;
  const usdSaved = hoursSaved * savingsIn.rate;
  const jevPerDay = ((w.tokens24h / w.hoursObserved) * 24 / 1e6) * w.pricePerM;
  const opFid = !!op && op.confidentVotes >= 3 && op.confidentAgree != null;
  const agree = opFid ? op.confidentAgree : w.confidentAgree;
  const votes = opFid ? op.confidentVotes : w.confidentVotes;
  const fid = agree == null ? null : Math.round(agree * 100);
  const errs = fid == null ? null : Math.round(perDay * autoShare * (1 - agree));
  host.innerHTML = `
    <div class="in">
      <label>sec / post <input id="in-secs" type="number" min="1" max="600" value="${savingsIn.secs}"></label>
      <label>$ / hour <input id="in-rate" type="number" min="1" max="500" value="${savingsIn.rate}"></label>
    </div>
    <div class="row"><span>posts / day at this sampling</span><b>${Math.round(perDay).toLocaleString()}</b></div>
    <div class="row"><span>model decides alone</span><b>${Math.round(autoShare * 100)}%</b></div>
    <div class="row"><span>a human still reviews${op ? ` at c=${op.c.toFixed(2)}` : ""}</span><b>${Math.round(reviewShare * 100)}% · ${(hoursAll * reviewShare).toFixed(1)} h/day</b></div>
    ${op ? `<div class="note">at the current threshold: ${Math.round(liveShare * 100)}%</div>` : ""}
    <div class="row hero"><span>human hours saved / day</span><b>${hoursSaved.toFixed(1)} h</b></div>
    <div class="row"><span>worth, at your rate</span><b>$${Math.round(usdSaved).toLocaleString()} / day</b></div>
    <div class="row"><span>Jev bill at this rate</span><b>$${jevPerDay.toFixed(2)} / day</b></div>
    <div class="row"><span>fidelity on confident answers</span><b>${fid == null ? "no spot checks yet" : `${fid}% (n=${votes})`}</b></div>
    <div class="note">${fid == null ? "Confident cards in the feed carry a spot-check question. Each vote on one measures how often the model is right when it was sure, and that becomes the fidelity above." : `At that fidelity, about ${errs.toLocaleString()} of the auto-decided posts per day would be judged differently by a human.`}${w.hoursObserved < 24 ? ` Extrapolated from ${w.hoursObserved.toFixed(1)} h of data.` : ""}</div>`;
  $("in-secs").onchange = (e) => { savingsIn.secs = Number(e.target.value) || 20; try { localStorage.setItem("secsPerPost", savingsIn.secs); } catch {} renderSavings(); };
  $("in-rate").onchange = (e) => { savingsIn.rate = Number(e.target.value) || 30; try { localStorage.setItem("usdPerHour", savingsIn.rate); } catch {} renderSavings(); };
}

// ---- operating curve ---------------------------------------------------------

let curve = null;                              // /api/curve payload; null until it loads, or on a server without the route
let curveTarget = pref("reviewTarget", null);  // share of posts the operator wants in the human lane, 0-100
let curveGeom = null;

async function loadCurve() {
  let next = null;
  try {
    const res = await fetch("/api/curve?minutes=1440");
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data?.points) && data.points.length) next = data;
    }
  } catch {}
  curve = next;
  renderCurve();
  renderSavings();
}

function curvePoints() {
  return curve ? curve.points.filter((p) => p && typeof p.c === "number" && typeof p.reviewShare === "number") : [];
}

// Where the slider is parked. With no stored preference, the threshold the server is actually running.
function operatingPoint() {
  const pts = curvePoints();
  if (!pts.length) return null;
  if (curveTarget == null) {
    const c = thresholds?.choice ?? 0.4;
    return pts.reduce((best, p) => (Math.abs(p.c - c) < Math.abs(best.c - c) ? p : best), pts[0]);
  }
  const want = curveTarget / 100;
  return pts.reduce((best, p) => (Math.abs(p.reviewShare - want) < Math.abs(best.reviewShare - want) ? p : best), pts[0]);
}

function renderCurve() {
  const pts = curvePoints();
  $("curve-tile").hidden = pts.length < 2;
  if (pts.length < 2) { curveGeom = null; return; }
  const host = $("curve");
  const W = 900, H = 200, padL = 34, padR = 10, padT = 12, padB = 18;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}` });
  const x = (c) => padL + plotW * c, y = (v) => padT + plotH * (1 - Math.max(0, Math.min(1, v)));
  for (const f of [0, 0.5, 1]) {
    svg.append(svgEl("line", { x1: padL, x2: W - padR, y1: y(f), y2: y(f), class: f === 0 ? "axis" : "grid" }));
    const t = svgEl("text", { x: padL - 4, y: y(f) + 3, "text-anchor": "end" }); t.textContent = `${f * 100}%`; svg.append(t);
  }
  for (const c of [0, 0.25, 0.5, 0.75, 1]) {
    const t = svgEl("text", { x: x(c), y: H - 4, "text-anchor": c === 0 ? "start" : c === 1 ? "end" : "middle" });
    t.textContent = c.toFixed(2); svg.append(t);
  }
  const cap = svgEl("text", { x: padL + plotW / 2, y: padT - 2, "text-anchor": "middle" });
  cap.textContent = "choice-confidence threshold c →";
  svg.append(cap);
  svg.append(svgEl("polyline", {
    points: pts.map((p) => `${x(p.c).toFixed(1)},${y(p.reviewShare).toFixed(1)}`).join(" "),
    fill: "none", stroke: SERIES[0], "stroke-width": 2, "stroke-linejoin": "round",
  }));
  // Fidelity only means something once a few humans have voted; thin evidence draws dashed.
  const fid = pts.filter((p) => p.confidentVotes >= 3 && p.confidentAgree != null);
  for (let i = 1; i < fid.length; i++) {
    const a = fid[i - 1], b = fid[i];
    svg.append(svgEl("line", {
      x1: x(a.c), y1: y(a.confidentAgree), x2: x(b.c), y2: y(b.confidentAgree),
      stroke: SERIES[2], "stroke-width": 2, "stroke-dasharray": Math.min(a.confidentVotes, b.confidentVotes) < 10 ? "4 3" : "none",
    }));
  }
  for (const p of fid) svg.append(svgEl("circle", { cx: x(p.c), cy: y(p.confidentAgree), r: 2.5, fill: SERIES[2] }));
  if (thresholds?.choice != null) {
    svg.append(svgEl("line", { x1: x(thresholds.choice), x2: x(thresholds.choice), y1: padT, y2: padT + plotH, class: "mark" }));
    const t = svgEl("text", { x: x(thresholds.choice) + 4, y: padT + 9 }); t.textContent = `server c=${thresholds.choice.toFixed(2)}`; svg.append(t);
  }
  const line = svgEl("line", { class: "pick-line", y1: padT, y2: padT + plotH, x1: x(0), x2: x(0) });
  const dot = svgEl("circle", { cx: x(0), cy: y(0), r: 4, fill: SERIES[3], stroke: "#1a1a19", "stroke-width": 2 });
  svg.append(line, dot);
  host.replaceChildren(svg);
  curveGeom = { x, y, line, dot };
  hoverPoints(host, svg, padT, plotH, pts.map((p) => x(p.c)), pts, (p) => {
    const f = p.confidentVotes >= 3 && p.confidentAgree != null ? `<b>${Math.round(p.confidentAgree * 100)}%</b> (n=${p.confidentVotes})` : `${p.confidentVotes || 0} votes`;
    return `<b>c=${p.c.toFixed(2)}</b> · noul ${num(p.noul)} · score ${num(p.score)}<br>humans review <b>${Math.round(p.reviewShare * 100)}%</b><br>fidelity on the rest ${f}`;
  });
  $("legend-curve").innerHTML = [
    `<span><i class="sw" style="background:${SERIES[0]}"></i>humans review</span>`,
    `<span><i class="sw" style="background:${SERIES[2]}"></i>fidelity on the rest · dashed under 10 votes</span>`,
    `<span><i class="sw" style="background:${SERIES[3]}"></i>slider</span>`,
    `<span>dashed vertical = threshold the server runs</span>`,
    `<span>${(curve.n || 0).toLocaleString()} posts · ${(curve.votes || 0).toLocaleString()} votes</span>`,
  ].join("");
  syncCurve();
}

function num(v) { return typeof v === "number" ? v.toFixed(2) : "–"; }

function syncCurve() {
  const op = operatingPoint();
  if (!op) return;
  const share = Math.round(op.reviewShare * 100);
  // With no stored target the slider starts where the server is; with one, it starts there (including after a reload).
  $("curve-slider").value = String(curveTarget == null ? share : curveTarget);
  const measured = op.confidentVotes >= 3 && op.confidentAgree != null;
  $("curve-pick").innerHTML = `threshold <b>c=${op.c.toFixed(2)}</b> · humans review <b>${share}%</b> · `
    + `fidelity on the rest ${measured ? `<b>${Math.round(op.confidentAgree * 100)}%</b> (n=${op.confidentVotes})` : `<b>–</b> (n=${op.confidentVotes || 0})`}`;
  if (curveGeom) {
    curveGeom.line.setAttribute("x1", curveGeom.x(op.c));
    curveGeom.line.setAttribute("x2", curveGeom.x(op.c));
    curveGeom.dot.setAttribute("cx", curveGeom.x(op.c));
    curveGeom.dot.setAttribute("cy", curveGeom.y(op.reviewShare));
  }
}

$("curve-slider").oninput = (e) => { curveTarget = Number(e.target.value); syncCurve(); renderSavings(); };
$("curve-slider").onchange = () => { try { localStorage.setItem("reviewTarget", String(curveTarget)); } catch {} };
setInterval(loadCurve, POLL_MS);
loadCurve();

// Rows are kept and updated in place: the width transitions read as movement, and a row stays
// under the cursor long enough to be clicked.
const barRows = new Map();

function renderBars(el, shares, keys, dim) {
  const hotTotal = Object.values(shares).reduce((a, b) => a + b.hot, 0) || 1;
  const baseTotal = Object.values(shares).reduce((a, b) => a + b.base, 0) || 1;
  const rows = keys.map((k) => {
    const s = shares[k] || { hot: 0, base: 0 };
    return { k, hot: s.hot / hotTotal, base: s.base / baseTotal };
  }).sort((a, b) => b.hot - a.hot);
  const max = Math.max(0.05, ...rows.map((r) => Math.max(r.hot, r.base)));
  let head = el.firstElementChild;
  if (!head?.classList.contains("head")) {
    head = document.createElement("div"); head.className = "hrow head";
    for (const h of ["", "", "10m", "vs 24h"]) { const d = document.createElement("div"); d.textContent = h; head.append(d); }
    el.replaceChildren(head);
  }
  let prev = head;
  for (const r of rows) {
    const id = `${dim}:${r.k}`;
    let row = barRows.get(id);
    if (!row) {
      row = document.createElement("div");
      row.className = "hrow";
      row.dataset.dim = dim;
      row.dataset.k = r.k;
      row.innerHTML = '<div class="k"></div><div class="track"><div class="fill"></div><div class="base"></div></div><div class="pct"></div><div class="delta"></div>';
      row.firstElementChild.textContent = r.k;
      row.onclick = () => setFilter(dim, r.k);
      barRows.set(id, row);
    }
    const [kc, track, pct, delta] = row.children;
    kc.title = questions[dim]?.criteria?.[r.k] || "";
    track.firstElementChild.style.width = `${(100 * r.hot) / max}%`;
    track.lastElementChild.style.left = `${(100 * r.base) / max}%`;
    track.lastElementChild.title = `24h: ${Math.round(r.base * 100)}%`;
    pct.textContent = `${Math.round(r.hot * 100)}%`;
    const d = Math.round((r.hot - r.base) * 100);
    delta.className = "delta " + (d > 1 ? "up" : d < -1 ? "down" : "");
    delta.textContent = d > 0 ? `▲${d}` : d < 0 ? `▼${-d}` : "·";
    row.classList.toggle("sel", filter[dim] === r.k);
    if (prev.nextSibling !== row) el.insertBefore(row, prev.nextSibling);
    prev = row;
  }
  const live = new Set(rows.map((r) => `${dim}:${r.k}`));
  for (const [id, row] of barRows) if (id.startsWith(`${dim}:`) && !live.has(id)) { row.remove(); barRows.delete(id); }
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

// Same tooltip, for a chart sampled at fixed x positions rather than by minute.
function hoverPoints(host, svg, top, plotH, xs, rows, html) {
  const cross = svgEl("line", { y1: top, y2: top + plotH, class: "cross" });
  svg.append(cross);
  const tip = document.createElement("div"); tip.className = "tip"; host.append(tip);
  host.onmousemove = (e) => {
    const rect = svg.getBoundingClientRect();
    const xm = ((e.clientX - rect.left) / rect.width) * svg.viewBox.baseVal.width;
    let i = 0;
    for (let j = 1; j < xs.length; j++) if (Math.abs(xs[j] - xm) < Math.abs(xs[i] - xm)) i = j;
    cross.style.display = "block"; cross.setAttribute("x1", xs[i]); cross.setAttribute("x2", xs[i]);
    tip.style.display = "block"; tip.innerHTML = html(rows[i]);
    tip.style.left = `${Math.min(rect.width - tip.offsetWidth - 4, Math.max(0, e.clientX - rect.left + 12))}px`;
    tip.style.top = `${e.clientY - rect.top - 10}px`;
  };
  host.onmouseleave = () => { cross.style.display = "none"; tip.style.display = "none"; };
}

// ---- cloud ------------------------------------------------------------------

// Diffed by term so a chip the cursor is on survives the 4s repaint.
const cloudEls = new Map();

function renderCloud(terms) {
  const el = $("cloud");
  if (!terms.length) { cloudEls.clear(); el.innerHTML = '<span class="empty">warming up…</span>'; return; }
  el.querySelector(".empty")?.remove();
  const hots = terms.map((t) => t.hot).sort((a, b) => a - b);
  const q = (f) => hots[Math.min(hots.length - 1, Math.floor(f * hots.length))];
  const s2 = q(0.6), s3 = q(0.9);
  const list = terms.slice(0, 48);
  const live = new Set(list.map((t) => t.t));
  let prev = null;
  for (const t of list) {
    let node = cloudEls.get(t.t);
    if (!node) {
      node = document.createElement("span");
      node.dataset.term = t.t;
      const label = document.createElement("span"); label.textContent = t.t;
      const n = document.createElement("small");
      node.append(label, n);
      node.onclick = () => setFilter("term", t.t);
      cloudEls.set(t.t, node);
    }
    const size = t.hot >= s3 ? "s3" : t.hot >= s2 ? "s2" : "s1";
    const burst = t.burst >= 4 ? "b3" : t.burst >= 2 ? "b2" : t.burst >= 1.3 ? "b1" : "";
    node.className = `term ${size} ${burst} ${t.t.startsWith("#") ? "tag" : ""}${filter.term === t.t ? " sel" : ""}`;
    node.lastElementChild.textContent = t.hot;
    node.title = `${t.hot} in the last 15 min · ${t.base} in 6h · ${t.burst.toFixed(1)}× expected`;
    const at = prev ? prev.nextSibling : el.firstChild;
    if (at !== node) el.insertBefore(node, at);
    prev = node;
  }
  for (const [k, node] of cloudEls) if (!live.has(k)) { node.remove(); cloudEls.delete(k); }
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
    c.dataset.term = n.id;
    if (filter.term === n.id) c.classList.add("sel");
    c.onclick = () => setFilter("term", n.id);
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

// ---- filters ----------------------------------------------------------------

function filterActive() { return !!(filter.term || filter.intent || filter.topic); }

function matchesFilter(p) {
  if (filter.term && !(p.text || "").toLowerCase().includes(filter.term.toLowerCase())) return false;
  if (filter.intent && p.answers?.intent?.choice !== filter.intent) return false;
  if (filter.topic && p.answers?.topic?.choice !== filter.topic) return false;
  return true;
}

// One value per dimension, combinable; clicking the same value again clears it.
function setFilter(dim, value) {
  filter[dim] = filter[dim] === value ? null : value;
  renderFilterChips();
  markFilterSelection();
  $("feed-hint").textContent = filterActive() ? "last 60 min · live matches on top" : "1 card / 1.5s";
  if (filterActive()) loadFiltered(); else rerenderFeed();
}

function renderFilterChips() {
  $("filters").replaceChildren(...["term", "intent", "topic"].filter((d) => filter[d]).map((d) => {
    const chip = document.createElement("span");
    chip.className = "fchip";
    chip.append(`${d}: ${filter[d]}`);
    const x = document.createElement("button");
    x.type = "button";
    x.textContent = "×";
    x.title = `clear the ${d} filter`;
    x.onclick = () => setFilter(d, filter[d]);
    chip.append(x);
    return chip;
  }));
}

function markFilterSelection() {
  for (const el of document.querySelectorAll(".cloud .term")) el.classList.toggle("sel", el.dataset.term === filter.term);
  for (const el of document.querySelectorAll("#graph circle")) el.classList.toggle("sel", el.dataset.term === filter.term);
  for (const el of document.querySelectorAll(".hbars .hrow")) el.classList.toggle("sel", !!el.dataset.k && el.dataset.k === filter[el.dataset.dim]);
}

let filterSeq = 0;

async function loadFiltered() {
  const seq = ++filterSeq;
  const q = new URLSearchParams({ minutes: "60", limit: "40" });
  for (const d of ["term", "intent", "topic"]) if (filter[d]) q.set(d, filter[d]);
  let posts = null;
  try {
    const res = await fetch(`/api/posts?${q}`);
    if (res.ok) { const data = await res.json(); if (Array.isArray(data)) posts = data.map((r) => ({ ...r, review: r.review || [] })); }
  } catch {}
  if (seq !== filterSeq || !filterActive()) return;
  // No such route on this server, or the call failed: fall back to the buffer the feed already holds.
  if (!posts) posts = shown.filter(matchesFilter);
  const rows = posts.filter((r) => tab === "all" || r.review.length).slice(0, FEED_MAX);
  const feed = $("feed");
  if (!rows.length) { feed.innerHTML = '<div class="hint">nothing matched in the last hour · live matches will appear here</div>'; return; }
  feed.replaceChildren(...rows.map((r) => { const c = renderCard(r); c.style.animation = "none"; return c; }));
}

// ---- feed (throttled) -------------------------------------------------------

function enqueue(p, immediate) {
  if (seenIds.has(p.id)) return;
  seenIds.add(p.id);
  if (p.review.length) { reviewCount++; $("review-count").textContent = reviewCount; }
  if (immediate) { addCard(p, false); return; }
  // With a filter up, a match jumps the throttle queue so the filtered feed stays live.
  if (filterActive() && matchesFilter(p)) { addCard(p, true); return; }
  queue.push(p);
  if (queue.length > 12) queue.splice(0, queue.length - 12);
}

setInterval(() => { const p = queue.shift(); if (p) addCard(p, true); }, FEED_INTERVAL_MS);

const shown = [];
function addCard(p, animate) {
  shown.unshift(p);
  if (shown.length > FEED_MAX) shown.pop();
  if (tab === "review" && !p.review.length) return;
  if (filterActive() && !matchesFilter(p)) return;
  const feed = $("feed");
  if ([...feed.children].some((c) => c.dataset.id === p.id)) return;
  feed.querySelector(".hint")?.remove();
  const card = renderCard(p);
  if (!animate) card.style.animation = "none";
  feed.prepend(card);
  while (feed.children.length > FEED_MAX) feed.lastChild.remove();
}

function rerenderFeed() {
  const rows = shown.filter((p) => (tab === "all" || p.review.length) && (!filterActive() || matchesFilter(p)));
  $("feed").replaceChildren(...rows.map((p) => { const c = renderCard(p); c.style.animation = "none"; return c; }));
}

document.querySelectorAll(".tab").forEach((b) => b.onclick = () => {
  tab = b.dataset.tab;
  document.querySelectorAll(".tab").forEach((x) => x.classList.toggle("active", x === b));
  if (filterActive()) loadFiltered(); else rerenderFeed();
});

function renderCard(p) {
  const a = p.answers;
  const card = document.createElement("article");
  card.className = "card" + (p.review.length ? " review" : "");
  card.dataset.id = p.id;
  const chips = answerChips(a);
  card.innerHTML = `<p class="text"><a href="${escapeHtml(p.url)}" target="_blank" rel="noopener">${escapeHtml(p.text)}</a></p><div class="meta"><span>${p.latencyMs}ms</span><span>${p.inputTokens} tok</span><a href="${p.url}" target="_blank" rel="noopener">bsky ↗</a></div>`;
  const wrap = document.createElement("div"); wrap.className = "chips"; wrap.append(...chips); card.append(wrap);
  card.append(...answerMeters(a));
  for (const q of p.review) card.append(askRow(p, q, false));
  if (!p.review.length) {
    const qs = Object.keys(a).filter((k) => k !== "nsfw");
    card.append(askRow(p, qs[Math.floor(Math.random() * qs.length)], true));
  }
  return card;
}

// Score answers arrive keyed "0".."4" rather than as arrays, so levels always go through Object.values.
function levelsOf(o) { return o ? Object.values(o) : []; }

function answerChips(a) {
  const chips = [];
  if (a.intent) chips.push(chip(`${a.intent.choice} ${Math.round(a.intent.probabilities[a.intent.choice] * 100)}`, ""));
  if (a.topic) chips.push(chip(a.topic.choice, ""));
  for (const k of ["hostile", "sarcasm", "bot"]) if (a[k]) chips.push(chip(`${k} ${Math.round(a[k].noul * 100)}%`, a[k].noul > 0.65 ? "hot" : a[k].noul > 0.4 ? "warm" : ""));
  return chips;
}

// A score is a ladder, not a label: one step per level, the model's pick lit, height by probability.
function answerMeters(a) {
  return Object.entries(a).filter(([k, v]) => k !== "nsfw" && v?.type === "score").map(([k, v]) => meter(k, v));
}

function meter(name, a) {
  const legend = levelsOf(a.legend);
  const probs = levelsOf(a.probabilities);
  const max = Math.max(0.01, ...probs);
  const pick = Math.round(a.score);
  const row = document.createElement("div");
  row.className = "meter";
  const steps = legend.map((lv, i) => {
    const prob = Number(probs[i]) || 0;
    return `<i class="${i === pick ? "on" : ""}" style="height:${Math.max(8, 100 * (prob / max)).toFixed(0)}%" title="${escapeHtml(String(lv))} ${Math.round(prob * 100)}%"></i>`;
  }).join("");
  row.innerHTML = `<span class="q">${escapeHtml(name)}</span><span class="steps">${steps}</span><span class="lv">${escapeHtml(String(legend[pick] ?? ""))}</span>`;
  row.title = `${name}: ${legend[pick] ?? ""} · ${a.score.toFixed(1)} of ${Math.max(0, legend.length - 1)}`;
  return row;
}

function chip(text, cls) { const s = document.createElement("span"); s.className = `chip ${cls}`; s.textContent = text; return s; }

function askRow(p, q, spot) {
  const a = p.answers[q];
  const said = a.type === "noul" ? `${a.noul >= 0.5 ? "yes" : "no"} (${Math.round(Math.max(a.noul, 1 - a.noul) * 100)}%)`
    : a.type === "choice" ? `${a.choice} (${Math.round(a.probabilities[a.choice] * 100)}%)`
    : levelsOf(a.legend)[Math.round(a.score)];
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

// ---- badge ------------------------------------------------------------------

$("badge-link").onclick = (e) => { e.preventDefault(); $("badge-snip").hidden = !$("badge-snip").hidden; };
$("badge-img").onerror = () => { document.querySelector("footer .badge").style.display = "none"; };
$("badge-copy").onclick = async () => {
  const btn = $("badge-copy");
  try {
    await navigator.clipboard.writeText($("badge-md").textContent);
    btn.textContent = "copied";
  } catch {
    const range = document.createRange();
    range.selectNodeContents($("badge-md"));
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    btn.textContent = "select + copy";
  }
  setTimeout(() => { btn.textContent = "copy"; }, 1600);
};

connect();
drawBaro();
