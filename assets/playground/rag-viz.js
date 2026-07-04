/**
 * 2D scatter plot of FAISS chunk vectors (PCA-reduced to 2D).
 * Highlights query vector and top-k nearest chunks.
 */

const SOURCE_COLORS = {
  products: "#6366f1",
  pricing: "#0ea5e9",
  faqs: "#8b5cf6",
  policies: "#10b981",
  company: "#f59e0b",
};

let _canvas, _ctx, _wrap;
let _allPoints = [];
let _queryPoint = null;
let _topKIds = [];
let _tooltip = null;
let _transform = { scaleX: 1, scaleY: 1, offsetX: 0, offsetY: 0 };

export function init(canvas, wrap) {
  _canvas = canvas;
  _wrap = wrap;
  _ctx = canvas.getContext("2d");
  _tooltip = wrap.querySelector(".viz-tip");
  if (!_tooltip) {
    _tooltip = document.createElement("div");
    _tooltip.className = "viz-tip";
    _tooltip.style.display = "none";
    wrap.appendChild(_tooltip);
  }
  canvas.addEventListener("mousemove", _onMove);
  canvas.addEventListener("mouseleave", () => { _tooltip.style.display = "none"; });
}

export async function loadVectors(backendUrl) {
  const res = await fetch(`${backendUrl}/api/rag/vectors`);
  if (!res.ok) throw new Error("Failed to load vectors");
  const data = await res.json();
  _allPoints = data.points || [];
  render();
  return _allPoints.length;
}

export function setQueryResult(queryCoords, topKChunks) {
  _queryPoint = queryCoords ? { x: queryCoords[0], y: queryCoords[1] } : null;
  _topKIds = topKChunks.map((_, i) => i);
  render();
}

export function clearQuery() {
  _queryPoint = null;
  _topKIds = [];
  render();
}

function _computeTransform(W, H) {
  const pts = _allPoints;
  if (!pts.length) return;
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const pad = 32;
  _transform = {
    scaleX: (W - pad * 2) / (maxX - minX || 1),
    scaleY: (H - pad * 2) / (maxY - minY || 1),
    offsetX: -minX,
    offsetY: -minY,
    pad,
  };
}

function _px(p) {
  const t = _transform;
  return {
    x: (p.x + t.offsetX) * t.scaleX + t.pad,
    y: (p.y + t.offsetY) * t.scaleY + t.pad,
  };
}

export function render() {
  if (!_canvas || !_ctx) return;
  const W = _wrap.clientWidth || 480;
  const H = _wrap.clientHeight || 300;
  _canvas.width = W * devicePixelRatio;
  _canvas.height = H * devicePixelRatio;
  _canvas.style.width = W + "px";
  _canvas.style.height = H + "px";
  _ctx.scale(devicePixelRatio, devicePixelRatio);

  _ctx.clearRect(0, 0, W, H);

  if (!_allPoints.length) {
    _ctx.fillStyle = "#94a3b8";
    _ctx.font = "14px Inter, sans-serif";
    _ctx.textAlign = "center";
    _ctx.fillText("Loading vectors…", W / 2, H / 2);
    return;
  }

  _computeTransform(W, H);

  const topKSet = new Set(_topKIds);

  // Draw lines from query to top-k
  if (_queryPoint) {
    const qPx = _px(_queryPoint);
    _topKIds.forEach((id) => {
      if (_allPoints[id]) {
        const pt = _px(_allPoints[id]);
        _ctx.beginPath();
        _ctx.moveTo(qPx.x, qPx.y);
        _ctx.lineTo(pt.x, pt.y);
        _ctx.strokeStyle = "rgba(245,158,11,0.35)";
        _ctx.lineWidth = 1;
        _ctx.stroke();
      }
    });
  }

  // Draw all corpus points
  _allPoints.forEach((p, i) => {
    const { x, y } = _px(p);
    const isTopK = topKSet.has(i);
    const r = isTopK ? 7 : 4;
    _ctx.beginPath();
    _ctx.arc(x, y, r, 0, Math.PI * 2);
    _ctx.fillStyle = isTopK
      ? "#f59e0b"
      : SOURCE_COLORS[p.source] || "#94a3b8";
    _ctx.globalAlpha = isTopK ? 1 : 0.65;
    _ctx.fill();
    if (isTopK) {
      _ctx.strokeStyle = "#fff";
      _ctx.lineWidth = 1.5;
      _ctx.stroke();
    }
    _ctx.globalAlpha = 1;
  });

  // Draw query point
  if (_queryPoint) {
    const { x, y } = _px(_queryPoint);
    _ctx.beginPath();
    _ctx.arc(x, y, 9, 0, Math.PI * 2);
    _ctx.fillStyle = "#ef4444";
    _ctx.fill();
    _ctx.strokeStyle = "#fff";
    _ctx.lineWidth = 2;
    _ctx.stroke();
  }
}

function _onMove(e) {
  if (!_tooltip || !_allPoints.length) return;
  const rect = _canvas.getBoundingClientRect();
  const mx = e.clientX - rect.left;
  const my = e.clientY - rect.top;
  const HIT_R = 10;

  let found = null;
  for (const p of _allPoints) {
    const { x, y } = _px(p);
    if (Math.hypot(x - mx, y - my) < HIT_R) { found = p; break; }
  }

  if (found) {
    _tooltip.innerHTML = `<strong>${found.label}</strong><span>${found.source}</span><p>${
      (found.text || "").slice(0, 100)
    }…</p>`;
    _tooltip.style.display = "block";
    _tooltip.style.left = (mx + 12) + "px";
    _tooltip.style.top = (my - 8) + "px";
  } else {
    _tooltip.style.display = "none";
  }
}
