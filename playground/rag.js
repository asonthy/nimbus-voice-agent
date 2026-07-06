// RAG vector visualization: scatter of all chunk embeddings (PCA->2D), colored
// by source category, with a query overlay highlighting the retrieved chunks.
// Talks to our backend's /api/rag/* routes (see backend/routers/rag.py).

const LS_BASE = "nimbus_pg_base";
// window.NIMBUS_API_BASE is set by runtime-config.js; ignore the un-edited placeholder.
const RUNTIME_BASE = window.NIMBUS_API_BASE && !window.NIMBUS_API_BASE.includes("REPLACE-ME") ? window.NIMBUS_API_BASE : "";
const BASE = localStorage.getItem(LS_BASE) || RUNTIME_BASE || "http://localhost:8000";

const CATEGORIES = ["products", "pricing", "faqs", "policies", "company"];
const PALETTE = ["#6e8bff", "#9d7bff", "#2ea043", "#d29922", "#f85149", "#3fb0c9", "#e06aa8", "#b0b54a"];
const $ = (id) => document.getElementById(id);

const view = { points: [], bounds: null, retrieved: new Set(), queryPoint: null, dpr: 1 };

function clusterOf(p) {
  const i = CATEGORIES.indexOf(p.source);
  return i < 0 ? CATEGORIES.length : i;
}

function computeBounds(points) {
  const xs = points.map((p) => p.x), ys = points.map((p) => p.y);
  const pad = 0.08;
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const dx = (maxX - minX) || 1, dy = (maxY - minY) || 1;
  return { minX: minX - dx * pad, maxX: maxX + dx * pad, minY: minY - dy * pad, maxY: maxY + dy * pad };
}

function sizeCanvas() {
  const c = $("plot");
  view.dpr = window.devicePixelRatio || 1;
  c.width = c.clientWidth * view.dpr;
  c.height = c.clientHeight * view.dpr;
}

function toPx(p) {
  const c = $("plot"), b = view.bounds;
  const x = ((p.x - b.minX) / (b.maxX - b.minX)) * c.width;
  const y = (1 - (p.y - b.minY) / (b.maxY - b.minY)) * c.height;
  return [x, y];
}

function draw() {
  const c = $("plot"), ctx = c.getContext("2d");
  ctx.clearRect(0, 0, c.width, c.height);
  if (!view.bounds) return;
  const r = 3 * view.dpr;
  for (const p of view.points) {
    const [x, y] = toPx(p);
    const hit = view.retrieved.has(p.id);
    ctx.beginPath();
    ctx.arc(x, y, hit ? r * 2.2 : r, 0, Math.PI * 2);
    ctx.fillStyle = PALETTE[clusterOf(p) % PALETTE.length];
    ctx.globalAlpha = hit ? 1 : (view.retrieved.size ? 0.28 : 0.75);
    ctx.fill();
    if (hit) {
      ctx.globalAlpha = 1; ctx.lineWidth = 2 * view.dpr; ctx.strokeStyle = "#fff"; ctx.stroke();
    }
  }
  ctx.globalAlpha = 1;
  if (view.queryPoint) {
    const [qx, qy] = toPx(view.queryPoint);
    const retrieved = view.points.filter((p) => view.retrieved.has(p.id));
    retrieved.forEach((p, i) => {
      const [x, y] = toPx(p);
      ctx.beginPath(); ctx.moveTo(qx, qy); ctx.lineTo(x, y);
      ctx.strokeStyle = "#ffd166"; ctx.globalAlpha = 0.85;
      ctx.lineWidth = 2 * view.dpr; ctx.stroke();
      ctx.globalAlpha = 1;
      const bx = qx + (x - qx) * 0.86, by = qy + (y - qy) * 0.86;
      ctx.fillStyle = "#ffd166"; ctx.beginPath(); ctx.arc(bx, by, 8 * view.dpr, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "#0d1117"; ctx.font = `${10 * view.dpr}px system-ui`;
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText(String(i + 1), bx, by);
    });
    ctx.save(); ctx.translate(qx, qy); ctx.rotate(Math.PI / 4);
    const s = 8 * view.dpr;
    ctx.fillStyle = "#fff"; ctx.strokeStyle = "#ffd166"; ctx.lineWidth = 2 * view.dpr;
    ctx.fillRect(-s, -s, s * 2, s * 2); ctx.strokeRect(-s, -s, s * 2, s * 2);
    ctx.restore();
  }
}

async function loadViz() {
  try {
    const r = await fetch(BASE + "/api/rag/vectors");
    const d = await r.json();
    if (d.error || !d.points) { $("ragInfo").className = "pill pill-bad"; $("ragInfo").textContent = "index not built"; $("buildHint").textContent = d.error || "no index"; return; }
    view.points = d.points;
    view.bounds = computeBounds(d.points);
    $("ragInfo").className = "pill pill-ok";
    $("ragInfo").textContent = `${d.chunks ?? d.points.length} chunks · ${d.model} (${d.dim}-d) · ${d.profile}`;
    sizeCanvas(); draw(); renderLegend();
  } catch (e) {
    $("ragInfo").className = "pill pill-bad"; $("ragInfo").textContent = "backend unreachable";
  }
}

function renderLegend() {
  $("legend").innerHTML = "";
  const labels = ["Products", "Pricing", "FAQs", "Policies", "Company"];
  labels.forEach((name, i) => {
    const el = document.createElement("span");
    el.className = "lg";
    el.innerHTML = `<span class="dot" style="background:${PALETTE[i % PALETTE.length]}"></span>${name}`;
    $("legend").append(el);
  });
  const q = document.createElement("span");
  q.className = "lg"; q.innerHTML = `<span class="dot" style="background:#fff;border-radius:2px"></span>query`;
  $("legend").append(q);
}

async function runQuery() {
  const q = $("q").value.trim();
  if (!q) return;
  $("run").disabled = true; $("results").innerHTML = "<em>retrieving...</em>";
  try {
    const r = await fetch(BASE + "/api/rag/query", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: q, top_k: Number($("topk").value), rerank: $("rerank").checked }),
    });
    const d = await r.json();
    if (d.error) { $("results").innerHTML = `<span style="color:#f85149">${d.error}</span>`; return; }
    view.retrieved = new Set(d.chunks.map((c) => c.id));
    view.queryPoint = d.query_coords ? { x: d.query_coords[0], y: d.query_coords[1] } : null;
    draw();
    $("latency").innerHTML =
      `<div>search${$("rerank").checked ? " + rerank" : ""}: <b>${Math.round(d.latency_ms)}ms</b></div>`;
    $("results").innerHTML = d.chunks.map((c) =>
      `<div class="rc"><div class="rh"><span class="src">${c.source} / ${c.label}</span><span class="sc">${c.score.toFixed(3)}</span></div><div class="tx">${escapeHtml(c.text.slice(0, 220))}</div></div>`
    ).join("");
  } catch (e) {
    $("results").innerHTML = `<span style="color:#f85149">query failed: ${e.message}</span>`;
  } finally { $("run").disabled = false; }
}

function escapeHtml(s) { return s.replace(/[<>&]/g, (m) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[m])); }

async function rebuild() {
  $("buildHint").textContent = "building index (embedding all chunks)...";
  $("buildBtn").disabled = true;
  try {
    const r = await fetch(BASE + "/api/rag/rebuild", { method: "GET" });
    const d = await r.json();
    $("buildHint").textContent = d.error || `built ${d.chunks} chunks · ${d.model}`;
    view.retrieved = new Set(); view.queryPoint = null;
    await loadViz();
  } catch (e) { $("buildHint").textContent = "build failed: " + e.message; }
  finally { $("buildBtn").disabled = false; }
}

function nearestPoint(e) {
  const c = $("plot"), rect = c.getBoundingClientRect();
  const mx = (e.clientX - rect.left) * view.dpr, my = (e.clientY - rect.top) * view.dpr;
  let best = null, bd = 14 * view.dpr;
  for (const p of view.points) {
    const [x, y] = toPx(p);
    const dist = Math.hypot(x - mx, y - my);
    if (dist < bd) { bd = dist; best = p; }
  }
  return best;
}

function showHover(p) {
  if (!p) return;
  const color = PALETTE[clusterOf(p) % PALETTE.length];
  $("hover").innerHTML =
    `<div class="hh"><span class="src">${escapeHtml(p.source)} / ${escapeHtml(p.label)}</span>` +
    `<span class="clab" style="background:${color}">${escapeHtml(p.source)}</span></div>` +
    `<div class="body">${escapeHtml(p.text || "")}</div>`;
}

$("plot").addEventListener("mousemove", (e) => {
  if (!view.bounds) return;
  const p = nearestPoint(e);
  $("plot").style.cursor = p ? "pointer" : "crosshair";
  if (p) showHover(p);
});

$("run").addEventListener("click", runQuery);
$("q").addEventListener("keydown", (e) => { if (e.key === "Enter") runQuery(); });
$("buildBtn").addEventListener("click", rebuild);
window.addEventListener("resize", () => { sizeCanvas(); draw(); });

loadViz();
