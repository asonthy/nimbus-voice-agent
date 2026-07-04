/**
 * Latency tracking and canvas bar chart.
 *
 * Usage:
 *   const lap = new Lap();
 *   lap.mark("asr");
 *   lap.mark("rag");
 *   lap.mark("llm");
 *   const report = lap.finish();   // { asr, rag, llm, total, ... }
 *   drawChart(canvasEl, report);
 */

export class Lap {
  constructor() {
    this._marks = {};
    this._order = [];
    this._start = performance.now();
    this._last = this._start;
  }

  mark(label) {
    const now = performance.now();
    this._marks[label] = Math.round(now - this._last);
    this._order.push(label);
    this._last = now;
  }

  finish() {
    const total = Math.round(performance.now() - this._start);
    return { ...this._marks, total };
  }
}

const COLORS = {
  asr: "#6366f1",
  rag: "#0ea5e9",
  llm: "#f59e0b",
  tts: "#8b5cf6",
  tools: "#10b981",
  buffer: "#94a3b8",
  total: "#1e293b",
};

const LABELS = {
  asr: "ASR",
  rag: "RAG",
  llm: "LLM",
  tts: "TTS",
  tools: "Tools",
  buffer: "Buffer",
};

export function drawChart(canvas, report) {
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const W = canvas.offsetWidth || canvas.width;
  const H = canvas.offsetHeight || canvas.height;
  canvas.width = W * devicePixelRatio;
  canvas.height = H * devicePixelRatio;
  ctx.scale(devicePixelRatio, devicePixelRatio);

  ctx.clearRect(0, 0, W, H);

  const stages = Object.keys(LABELS).filter((k) => report[k] !== undefined && report[k] > 0);
  if (!stages.length) return;

  const total = report.total || stages.reduce((s, k) => s + report[k], 0);
  const barH = 22;
  const gap = 10;
  const labelW = 56;
  const rightPad = 50;
  const barW = W - labelW - rightPad;

  stages.forEach((key, i) => {
    const y = i * (barH + gap) + 8;
    const pct = total > 0 ? report[key] / total : 0;
    const w = Math.max(pct * barW, 2);

    ctx.fillStyle = COLORS[key] || "#94a3b8";
    ctx.beginPath();
    ctx.roundRect(labelW, y, w, barH, 6);
    ctx.fill();

    ctx.fillStyle = "#64748b";
    ctx.font = `600 11px Inter, sans-serif`;
    ctx.textAlign = "right";
    ctx.fillText(LABELS[key], labelW - 6, y + barH - 7);

    ctx.fillStyle = "#1e293b";
    ctx.font = `600 11px Inter, sans-serif`;
    ctx.textAlign = "left";
    ctx.fillText(`${report[key]}ms  (${Math.round(pct * 100)}%)`, labelW + w + 6, y + barH - 7);
  });
}

export function updatePill(el, report) {
  if (!el || !report.total) return;
  el.textContent = `E2E: ${report.total}ms`;
}

const _history = [];

export function recordTurn(report) {
  _history.unshift({ ts: Date.now(), ...report });
  if (_history.length > 10) _history.pop();
}

export function getHistory() {
  return [..._history];
}
