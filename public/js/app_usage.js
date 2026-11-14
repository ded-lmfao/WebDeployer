/**
 * WebDep App Resource Usage Cards
 * Renders live per-app CPU, RAM, Network (60fps smooth monotone spline), and Disk metrics.
 */

import { state, getSelectedProject, getSelectedDatabase } from './state.js';
import { api } from './api.js';

const SVG_W = 320;
const SVG_H = 84;
const TOP_PAD = 10;
const BOTTOM_PAD = 10;
const PLOT_BOTTOM = SVG_H - BOTTOM_PAD;
const Y_ZERO_IN = PLOT_BOTTOM - 2.5;
const Y_ZERO_OUT = PLOT_BOTTOM;
const WINDOW_MS = 45000;
const LAG_MS = 1250;
const POLL_INTERVAL_MS = 1000;

const _netState = {
  entityKey: null,
  projectId: null,
  running: false,
  port: null,
  interfaceCount: 0,
  totalRxBytes: 0,
  totalTxBytes: 0,
  samples: [],
  perfToServerOffset: 0,
  hasOffset: false,
  playheadTs: null,
  displayMaxRate: 1024,
  hoverRatio: null,
  rafId: null,
  pollTimer: null,
  fetchInFlight: false,
  lastFetchAt: 0,
  lastDrawPerf: 0,
  domMode: null, // 'online' | 'offline' | 'warming'
};

function formatBytesShort(bytes) {
  const b = Math.max(0, Number(bytes) || 0);
  if (b < 1024) return `${Math.round(b)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let idx = -1;
  let val = b;
  while (val >= 1024 && idx < units.length - 1) {
    val /= 1024;
    idx++;
  }
  return `${val >= 100 ? val.toFixed(0) : val.toFixed(1)} ${units[idx]}`;
}

function formatRate(bps) {
  return `${formatBytesShort(bps)}/s`;
}

function setElText(el, text) {
  if (el && el.textContent !== text) {
    el.textContent = text;
  }
}

function setText(id, text) {
  setElText(document.getElementById(id), text);
}

function setAttrCached(cache, key, el, attr, val) {
  if (el && cache[key] !== val) {
    cache[key] = val;
    el.setAttribute(attr, val);
  }
}

function setStyleProp(el, prop, val) {
  if (el && el.style[prop] !== val) {
    el.style[prop] = val;
  }
}

function getNetChartEls(netState, ids) {
  let els = netState._els;
  if (!els || els.ids !== ids || (els.inLineEl && els.inLineEl.isConnected === false)) {
    els = {
      ids,
      attrCache: {},
      inAreaEl: document.getElementById(ids.inArea),
      outAreaEl: document.getElementById(ids.outArea),
      inGlowEl: document.getElementById(ids.inGlow),
      outGlowEl: document.getElementById(ids.outGlow),
      inLineEl: document.getElementById(ids.inLine),
      outLineEl: document.getElementById(ids.outLine),
      inDotEl: document.getElementById(ids.inDot),
      outDotEl: document.getElementById(ids.outDot),
      crossEl: document.getElementById(ids.crosshair),
      peakEl: document.getElementById(ids.peak),
      inValEl: document.getElementById(ids.inVal),
      outValEl: document.getElementById(ids.outVal),
    };
    netState._els = els;
  }
  return els;
}

function setMeterWidth(id, pct) {
  const el = document.getElementById(id);
  if (!el) return;
  const clamped = Math.max(0, Math.min(100, Number(pct) || 0));
  const widthStr = `${clamped.toFixed(1)}%`;
  if (el.style.width !== widthStr) {
    el.style.width = widthStr;
  }
}

const _apiStandaloneScratch = {
  _splineBuf: null,
};

function ensureSplineScratch(stateObj, needed) {
  let buf = stateObj._splineBuf;
  if (!buf) {
    const cap = Math.max(64, needed);
    buf = {
      cap,
      vis: [],
      xs: new Float64Array(cap),
      ysIn: new Float64Array(cap),
      ysOut: new Float64Array(cap),
      mIn: new Float64Array(cap),
      mOut: new Float64Array(cap),
      d: new Float64Array(cap),
      dx: new Float64Array(cap),
      parts: [],
    };
    stateObj._splineBuf = buf;
  } else if (needed > buf.cap) {
    const cap = Math.max(needed, buf.cap * 2);
    buf.cap = cap;
    buf.xs = new Float64Array(cap);
    buf.ysIn = new Float64Array(cap);
    buf.ysOut = new Float64Array(cap);
    buf.mIn = new Float64Array(cap);
    buf.mOut = new Float64Array(cap);
    buf.d = new Float64Array(cap);
    buf.dx = new Float64Array(cap);
  }
  return buf;
}

/**
 * Compute Fritsch-Carlson monotone cubic tangents into preallocated Float64Arrays
 * so 60fps spline draws avoid heap churn.
 */
function fillMonotoneTangentsArrays(xs, ys, n, m, d, dx) {
  if (n <= 0) return;
  if (n < 2) {
    m[0] = 0;
    return;
  }

  for (let i = 0; i < n - 1; i++) {
    const stepX = xs[i + 1] - xs[i];
    const h = stepX > 1e-4 ? stepX : 1e-4;
    dx[i] = h;
    d[i] = (ys[i + 1] - ys[i]) / h;
  }

  m[0] = d[0];
  m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) {
    const dPrev = d[i - 1];
    const dCurr = d[i];
    if (dPrev === 0 || dCurr === 0 || (dPrev > 0) !== (dCurr > 0)) {
      m[i] = 0;
    } else {
      const w1 = 2 * dx[i] + dx[i - 1];
      const w2 = dx[i] + 2 * dx[i - 1];
      m[i] = (w1 + w2) / (w1 / dPrev + w2 / dCurr);
    }
  }

  for (let i = 0; i < n - 1; i++) {
    const di = d[i];
    if (Math.abs(di) < 1e-9) {
      m[i] = 0;
      m[i + 1] = 0;
      continue;
    }
    const alpha = m[i] / di;
    const beta = m[i + 1] / di;
    const h = Math.hypot(alpha, beta);
    if (h > 3) {
      const scale = 3 / h;
      m[i] = scale * alpha * di;
      m[i + 1] = scale * beta * di;
    }
  }
}

function buildCubicPathsArrays(xs, ys, n, m, baseBottom, parts) {
  if (n === 0) return { line: '', area: '' };
  if (n === 1) {
    const x0 = xs[0].toFixed(2);
    const y0 = ys[0].toFixed(2);
    return {
      line: `M${x0},${y0}`,
      area: `M${x0},${baseBottom} L${x0},${y0} L${x0},${baseBottom} Z`,
    };
  }

  let k = 0;
  const xStart = xs[0].toFixed(2);
  parts[k++] = `M${xStart},${ys[0].toFixed(2)}`;
  for (let i = 0; i < n - 1; i++) {
    const x0 = xs[i];
    const y0 = ys[i];
    const x1 = xs[i + 1];
    const y1 = ys[i + 1];
    const step = (x1 - x0) / 3;
    const c1x = x0 + step;
    const c1yRaw = y0 + m[i] * step;
    const c1y = c1yRaw < TOP_PAD ? TOP_PAD : (c1yRaw > PLOT_BOTTOM ? PLOT_BOTTOM : c1yRaw);
    const c2x = x1 - step;
    const c2yRaw = y1 - m[i + 1] * step;
    const c2y = c2yRaw < TOP_PAD ? TOP_PAD : (c2yRaw > PLOT_BOTTOM ? PLOT_BOTTOM : c2yRaw);
    parts[k++] = ` C${c1x.toFixed(2)},${c1y.toFixed(2)} ${c2x.toFixed(2)},${c2y.toFixed(2)} ${x1.toFixed(2)},${y1.toFixed(2)}`;
  }
  parts.length = k;
  const line = parts.join('');
  const xEnd = xs[n - 1].toFixed(2);
  const area = `${line} L${xEnd},${baseBottom} L${xStart},${baseBottom} Z`;
  return { line, area };
}

function evalHermiteSegment(x0, y0, m0, x1, y1, m1, xTarget) {
  const dx = x1 - x0;
  const h = dx > 1e-4 ? dx : 1e-4;
  const t = Math.max(0, Math.min(1, (xTarget - x0) / h));
  const t2 = t * t;
  const t3 = t2 * t;
  const y =
    (2 * t3 - 3 * t2 + 1) * y0 +
    (t3 - 2 * t2 + t) * h * m0 +
    (-2 * t3 + 3 * t2) * y1 +
    (t3 - t2) * h * m1;
  return y < TOP_PAD ? TOP_PAD : (y > PLOT_BOTTOM ? PLOT_BOTTOM : y);
}

function evalMonotoneYAtXArrays(xs, ys, n, m, xTarget) {
  if (n === 0) return PLOT_BOTTOM;
  if (n === 1 || xTarget <= xs[0]) return ys[0];
  if (xTarget >= xs[n - 1]) return ys[n - 1];

  let lo = 0;
  for (let i = 0; i < n - 1; i++) {
    if (xTarget >= xs[i] && xTarget <= xs[i + 1]) {
      lo = i;
      break;
    }
  }
  return evalHermiteSegment(xs[lo], ys[lo], m[lo], xs[lo + 1], ys[lo + 1], m[lo + 1], xTarget);
}

function computeMonotoneTangents(pts) {
  const n = pts.length;
  const out = new Array(n).fill(0);
  if (n < 2) return out;
  const buf = ensureSplineScratch(_apiStandaloneScratch, n);
  for (let i = 0; i < n; i++) {
    buf.xs[i] = pts[i].x;
    buf.ysIn[i] = pts[i].y;
  }
  fillMonotoneTangentsArrays(buf.xs, buf.ysIn, n, buf.mIn, buf.d, buf.dx);
  for (let i = 0; i < n; i++) out[i] = buf.mIn[i];
  return out;
}

function buildCubicPaths(pts, m, baseBottom = PLOT_BOTTOM) {
  const n = pts.length;
  if (n === 0) return { line: '', area: '' };
  const buf = ensureSplineScratch(_apiStandaloneScratch, n);
  for (let i = 0; i < n; i++) {
    buf.xs[i] = pts[i].x;
    buf.ysIn[i] = pts[i].y;
  }
  return buildCubicPathsArrays(buf.xs, buf.ysIn, n, m, baseBottom, buf.parts);
}

function evalMonotoneYAtX(pts, m, xTarget) {
  const n = pts.length;
  if (n === 0) return PLOT_BOTTOM;
  if (n === 1 || xTarget <= pts[0].x) return pts[0].y;
  if (xTarget >= pts[n - 1].x) return pts[n - 1].y;

  let lo = 0;
  for (let i = 0; i < n - 1; i++) {
    if (xTarget >= pts[i].x && xTarget <= pts[i + 1].x) {
      lo = i;
      break;
    }
  }
  return evalHermiteSegment(
    pts[lo].x,
    pts[lo].y,
    m[lo],
    pts[lo + 1].x,
    pts[lo + 1].y,
    m[lo + 1],
    xTarget
  );
}

function stopNetChartRaf() {
  if (_netState.rafId !== null) {
    cancelAnimationFrame(_netState.rafId);
    _netState.rafId = null;
  }
  _netState.lastDrawPerf = 0;
}

function stopAppUsagePoller() {
  if (_netState.pollTimer !== null) {
    clearInterval(_netState.pollTimer);
    _netState.pollTimer = null;
  }
}

function setOfflinePills(isOffline) {
  const card = document.getElementById('usage-card-network');
  if (!card) return;
  card.querySelectorAll('.app-net-pill').forEach((pill) => {
    pill.classList.toggle('is-offline', isOffline);
  });
}

function renderOfflineNetChart() {
  stopNetChartRaf();
  const chartEl = document.getElementById('usage-net-chart');
  if (!chartEl) return;

  if (_netState.domMode !== 'offline') {
    setOfflinePills(true);
    chartEl.classList.add('is-offline');
    _netState.domMode = 'offline';
    _netState._chartEl = null;
    chartEl.innerHTML = `
      <div class="app-net-offline-state">
        <span class="app-net-offline-pill">
          <span class="app-net-offline-dot"></span>
          Service Offline
        </span>
        <span class="app-net-offline-hint">Start app to track live traffic</span>
      </div>`;
  }
}

function ensureOnlineChartDom() {
  if (
    _netState.domMode === 'online' &&
    _netState._chartEl &&
    _netState._chartEl.isConnected !== false
  ) {
    return _netState._chartEl;
  }

  const chartEl = document.getElementById('usage-net-chart');
  if (!chartEl) return null;

  setOfflinePills(false);
  chartEl.classList.remove('is-offline');

  if (_netState.domMode === 'online' && chartEl.querySelector('#net-in-line')) {
    _netState._chartEl = chartEl;
    return chartEl;
  }

  _netState.domMode = 'online';
  _netState._chartEl = chartEl;
  chartEl.innerHTML = `
    <svg class="app-net-svg" viewBox="0 0 ${SVG_W} ${SVG_H}" preserveAspectRatio="none" aria-label="Inbound and outbound network traffic">
      <defs>
        <clipPath id="app-net-clip">
          <rect x="0" y="0" width="${SVG_W}" height="${SVG_H}"></rect>
        </clipPath>
        <linearGradient id="netGradIn" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#4cc38a" stop-opacity="0.28"/>
          <stop offset="100%" stop-color="#4cc38a" stop-opacity="0.01"/>
        </linearGradient>
        <linearGradient id="netGradOut" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#4f8ef7" stop-opacity="0.26"/>
          <stop offset="100%" stop-color="#4f8ef7" stop-opacity="0.01"/>
        </linearGradient>
      </defs>
      <line x1="0" y1="22" x2="${SVG_W}" y2="22" stroke="rgba(238,241,247,0.045)" stroke-dasharray="3 4"/>
      <line x1="0" y1="46" x2="${SVG_W}" y2="46" stroke="rgba(238,241,247,0.045)" stroke-dasharray="3 4"/>
      <line x1="0" y1="${PLOT_BOTTOM}" x2="${SVG_W}" y2="${PLOT_BOTTOM}" stroke="rgba(238,241,247,0.08)"/>
      <g clip-path="url(#app-net-clip)">
        <path id="net-in-area" d="" fill="url(#netGradIn)"/>
        <path id="net-out-area" d="" fill="url(#netGradOut)"/>
        <path id="net-in-glow" d="" fill="none" stroke="rgba(76, 195, 138, 0.22)" stroke-width="5" vector-effect="non-scaling-stroke" stroke-linecap="round" stroke-linejoin="round"/>
        <path id="net-out-glow" d="" fill="none" stroke="rgba(79, 142, 247, 0.22)" stroke-width="5" vector-effect="non-scaling-stroke" stroke-linecap="round" stroke-linejoin="round"/>
        <path id="net-in-line" d="" fill="none" stroke="#4cc38a" stroke-width="2" vector-effect="non-scaling-stroke" stroke-linecap="round" stroke-linejoin="round"/>
        <path id="net-out-line" d="" fill="none" stroke="#4f8ef7" stroke-width="2" vector-effect="non-scaling-stroke" stroke-linecap="round" stroke-linejoin="round"/>
      </g>
    </svg>
    <div id="net-in-dot" class="app-net-live-marker net-in" style="opacity:0;"></div>
    <div id="net-out-dot" class="app-net-live-marker net-out" style="opacity:0;"></div>
    <div id="net-crosshair" class="app-net-crosshair" style="display:none;"></div>
    <span id="net-peak-label" class="app-net-scale-chip">Peak 0 B/s</span>`;

  chartEl.onmousemove = (ev) => {
    const rect = chartEl.getBoundingClientRect();
    if (!rect.width) return;
    _netState.hoverRatio = Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width));
  };
  chartEl.onmouseleave = () => {
    _netState.hoverRatio = null;
    const cross = document.getElementById('net-crosshair');
    if (cross) cross.style.display = 'none';
  };

  return chartEl;
}

function syncPerfOffset(netState, samples, blend = 0.05) {
  if (!Array.isArray(samples) || samples.length === 0) return;
  const newestTs = samples[samples.length - 1].ts;
  const impliedOffset = newestTs - performance.now();
  if (!netState.hasOffset) {
    netState.perfToServerOffset = impliedOffset;
    netState.hasOffset = true;
  } else {
    netState.perfToServerOffset += (impliedOffset - netState.perfToServerOffset) * blend;
  }
}

function renderSmoothNetFrame(cfg, netState, nowPerf) {
  const dt = netState.lastDrawPerf > 0
    ? Math.min(0.08, Math.max(0.004, (nowPerf - netState.lastDrawPerf) / 1000))
    : 0.016;
  netState.lastDrawPerf = nowPerf;

  const { svgW, svgH, topPad, yZeroIn, yZeroOut, windowMs, lagMs, ids } = cfg;
  const samples = netState.samples;
  const els = getNetChartEls(netState, ids);
  const {
    attrCache,
    inAreaEl,
    outAreaEl,
    inGlowEl,
    outGlowEl,
    inLineEl,
    outLineEl,
    inDotEl,
    outDotEl,
    crossEl,
    peakEl,
    inValEl,
    outValEl,
  } = els;
  if (!inLineEl || !outLineEl || !inAreaEl || !outAreaEl) return false;

  if (samples.length < 2) {
    const flatInLine = `M0.00,${yZeroIn.toFixed(2)} L${svgW}.00,${yZeroIn.toFixed(2)}`;
    const flatOutLine = `M0.00,${yZeroOut.toFixed(2)} L${svgW}.00,${yZeroOut.toFixed(2)}`;
    const flatInArea = `M0.00,${yZeroIn.toFixed(2)} L${svgW}.00,${yZeroIn.toFixed(2)} Z`;
    const flatOutArea = `M0.00,${yZeroOut.toFixed(2)} L${svgW}.00,${yZeroOut.toFixed(2)} Z`;
    setAttrCached(attrCache, 'inLine', inLineEl, 'd', flatInLine);
    setAttrCached(attrCache, 'outLine', outLineEl, 'd', flatOutLine);
    setAttrCached(attrCache, 'inGlow', inGlowEl, 'd', flatInLine);
    setAttrCached(attrCache, 'outGlow', outGlowEl, 'd', flatOutLine);
    setAttrCached(attrCache, 'inArea', inAreaEl, 'd', flatInArea);
    setAttrCached(attrCache, 'outArea', outAreaEl, 'd', flatOutArea);
    if (inDotEl) {
      setStyleProp(inDotEl, 'opacity', '1');
      setStyleProp(inDotEl, 'left', '100%');
      setStyleProp(inDotEl, 'top', `${(yZeroIn / svgH) * 100}%`);
    }
    if (outDotEl) {
      setStyleProp(outDotEl, 'opacity', '1');
      setStyleProp(outDotEl, 'left', '100%');
      setStyleProp(outDotEl, 'top', `${(yZeroOut / svgH) * 100}%`);
    }
    setElText(
      peakEl,
      samples.length === 1 ? (cfg.singleSamplePeakText || 'Sampling') : 'Starting'
    );
    return true;
  }

  const firstTs = samples[0].ts;
  const lastTs = samples[samples.length - 1].ts;
  const estServerNow = netState.hasOffset
    ? Math.min(lastTs + lagMs + 900, nowPerf + netState.perfToServerOffset)
    : lastTs;
  const spanMs = Math.max(0, lastTs - firstTs);
  const effectiveLag = Math.min(lagMs, spanMs * 0.5);
  const targetViewEnd = Math.max(firstTs + 50, Math.min(lastTs, estServerNow - effectiveLag));

  // Monotonic non-backwards playhead prevents HTTP round-trip jitter from jerking the waveform
  if (!Number.isFinite(netState.playheadTs) || netState.playheadTs < firstTs || netState.playheadTs > lastTs) {
    netState.playheadTs = targetViewEnd;
  } else {
    const nominal = netState.playheadTs + dt * 1000;
    const corrected = nominal + (targetViewEnd - nominal) * Math.min(0.18, dt * 2.5);
    netState.playheadTs = Math.min(lastTs, Math.max(netState.playheadTs, corrected));
  }
  const viewEnd = netState.playheadTs;
  const viewStart = viewEnd - windowMs;

  // Single-pass extraction: keep at most 1 bracket beyond view margins while tracking peak in-window
  const minRawPeak = cfg.minRawPeak ?? 512;
  let visPeak = minRawPeak;
  let inWinPeak = minRawPeak;
  let hasInWin = false;
  const buf = ensureSplineScratch(netState, samples.length + 4);
  const visible = buf.vis;
  visible.length = 0;
  const winLeft = viewStart - 3000;
  const winRight = viewEnd + 3000;
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    if (s.ts < winLeft) continue;
    if (s.ts > winRight) break;
    visible.push(s);
    const maxSample = s.inboundBps > s.outboundBps ? s.inboundBps : s.outboundBps;
    if (maxSample > visPeak) visPeak = maxSample;
    if (s.ts >= viewStart && s.ts <= viewEnd) {
      hasInWin = true;
      if (maxSample > inWinPeak) inWinPeak = maxSample;
    }
  }
  const rawPeak = hasInWin ? inWinPeak : visPeak;
  const targetPeak = Math.max(1024, rawPeak * 1.15);
  const scaleAlpha = 1 - Math.exp(-dt * 3.5);
  netState.displayMaxRate += (targetPeak - netState.displayMaxRate) * scaleAlpha;
  const maxRate = Math.max(1024, netState.displayMaxRate);

  const inUsableH = yZeroIn - topPad;
  const outUsableH = yZeroOut - topPad;
  const visLen = visible.length;
  let count = 0;
  if (visLen === 0) {
    const latest = samples[samples.length - 1];
    const yInLast = yZeroIn - Math.min(1, (latest?.inboundBps || 0) / maxRate) * inUsableH;
    const yOutLast = yZeroOut - Math.min(1, (latest?.outboundBps || 0) / maxRate) * outUsableH;
    buf.xs[0] = 0;
    buf.ysIn[0] = yZeroIn;
    buf.ysOut[0] = yZeroOut;
    buf.xs[1] = svgW;
    buf.ysIn[1] = yInLast;
    buf.ysOut[1] = yOutLast;
    count = 2;
  } else {
    const firstX = ((visible[0].ts - viewStart) / windowMs) * svgW;
    const lead = firstX > 0.5 ? (firstX > 6 ? 2 : 1) : 0;
    const lastVisX = ((visible[visLen - 1].ts - viewStart) / windowMs) * svgW;
    const tail = lastVisX < svgW - 0.5 ? 1 : 0;
    count = lead + visLen + tail;
    if (count > buf.cap) {
      ensureSplineScratch(netState, count);
    }
    const { xs, ysIn, ysOut } = buf;
    if (lead >= 1) {
      xs[0] = 0;
      ysIn[0] = yZeroIn;
      ysOut[0] = yZeroOut;
      if (lead === 2) {
        xs[1] = firstX - 3;
        ysIn[1] = yZeroIn;
        ysOut[1] = yZeroOut;
      }
    }
    for (let i = 0; i < visLen; i++) {
      const s = visible[i];
      const idx = lead + i;
      xs[idx] = ((s.ts - viewStart) / windowMs) * svgW;
      const inRatio = s.inboundBps / maxRate;
      const outRatio = s.outboundBps / maxRate;
      ysIn[idx] = yZeroIn - (inRatio < 1 ? inRatio : 1) * inUsableH;
      ysOut[idx] = yZeroOut - (outRatio < 1 ? outRatio : 1) * outUsableH;
    }
    if (tail === 1) {
      const lastIdx = lead + visLen - 1;
      xs[lastIdx + 1] = svgW;
      ysIn[lastIdx + 1] = ysIn[lastIdx];
      ysOut[lastIdx + 1] = ysOut[lastIdx];
    }
  }

  const { xs, ysIn, ysOut, mIn, mOut, d, dx, parts } = buf;
  fillMonotoneTangentsArrays(xs, ysIn, count, mIn, d, dx);
  fillMonotoneTangentsArrays(xs, ysOut, count, mOut, d, dx);
  const pathsIn = buildCubicPathsArrays(xs, ysIn, count, mIn, yZeroIn, parts);
  const pathsOut = buildCubicPathsArrays(xs, ysOut, count, mOut, yZeroOut, parts);

  setAttrCached(attrCache, 'inArea', inAreaEl, 'd', pathsIn.area);
  setAttrCached(attrCache, 'outArea', outAreaEl, 'd', pathsOut.area);
  setAttrCached(attrCache, 'inLine', inLineEl, 'd', pathsIn.line);
  setAttrCached(attrCache, 'outLine', outLineEl, 'd', pathsOut.line);
  setAttrCached(attrCache, 'inGlow', inGlowEl, 'd', pathsIn.line);
  setAttrCached(attrCache, 'outGlow', outGlowEl, 'd', pathsOut.line);

  const rightX = Math.max(0, Math.min(svgW, xs[count - 1]));
  const dotYIn = evalMonotoneYAtXArrays(xs, ysIn, count, mIn, rightX);
  const dotYOut = evalMonotoneYAtXArrays(xs, ysOut, count, mOut, rightX);

  if (inDotEl) {
    setStyleProp(inDotEl, 'opacity', '1');
    setStyleProp(inDotEl, 'left', `${(rightX / svgW) * 100}%`);
    setStyleProp(inDotEl, 'top', `${(dotYIn / svgH) * 100}%`);
  }
  if (outDotEl) {
    setStyleProp(outDotEl, 'opacity', '1');
    setStyleProp(outDotEl, 'left', `${(rightX / svgW) * 100}%`);
    setStyleProp(outDotEl, 'top', `${(dotYOut / svgH) * 100}%`);
  }

  if (netState.hoverRatio !== null) {
    const hoverTs = viewStart + netState.hoverRatio * windowMs;
    let nearest = null;
    let bestDiff = Infinity;
    for (let i = 0; i < visible.length; i++) {
      const diff = Math.abs(visible[i].ts - hoverTs);
      if (diff < bestDiff) {
        bestDiff = diff;
        nearest = visible[i];
      }
    }
    if (nearest && crossEl) {
      const hx = ((nearest.ts - viewStart) / windowMs) * svgW;
      if (hx >= 0 && hx <= svgW) {
        setStyleProp(crossEl, 'display', 'block');
        setStyleProp(crossEl, 'left', `${(hx / svgW) * 100}%`);
      } else {
        setStyleProp(crossEl, 'display', 'none');
      }
      setElText(peakEl, `In ${formatRate(nearest.inboundBps)} • Out ${formatRate(nearest.outboundBps)}`);
      setElText(inValEl, formatRate(nearest.inboundBps));
      setElText(outValEl, formatRate(nearest.outboundBps));
    }
  } else {
    setStyleProp(crossEl, 'display', 'none');
    const latest = samples[samples.length - 1];
    setElText(inValEl, formatRate(latest.inboundBps));
    setElText(outValEl, formatRate(latest.outboundBps));
    setElText(peakEl, `Peak ${formatRate(rawPeak)}`);
  }

  return true;
}

const APP_NET_CHART_CFG = {
  svgW: SVG_W,
  svgH: SVG_H,
  topPad: TOP_PAD,
  yZeroIn: Y_ZERO_IN,
  yZeroOut: Y_ZERO_OUT,
  windowMs: WINDOW_MS,
  lagMs: LAG_MS,
  minRawPeak: 512,
  singleSamplePeakText: 'Sampling',
  ids: {
    inArea: 'net-in-area',
    outArea: 'net-out-area',
    inGlow: 'net-in-glow',
    outGlow: 'net-out-glow',
    inLine: 'net-in-line',
    outLine: 'net-out-line',
    inDot: 'net-in-dot',
    outDot: 'net-out-dot',
    crosshair: 'net-crosshair',
    peak: 'net-peak-label',
    inVal: 'usage-net-in-val',
    outVal: 'usage-net-out-val',
  },
};

function drawNetFrame(nowPerf) {
  _netState.rafId = null;

  if (!_netState.running || state.currentView !== 'deployments' || document.hidden) {
    _netState.lastDrawPerf = 0;
    return;
  }

  const chartEl = ensureOnlineChartDom();
  if (!chartEl) return;

  if (renderSmoothNetFrame(APP_NET_CHART_CFG, _netState, nowPerf) && _netState.samples.length >= 2) {
    _netState.rafId = requestAnimationFrame(drawNetFrame);
  }
}

function startNetChartRaf() {
  if (!_netState.running || state.currentView !== 'deployments' || document.hidden) return;
  if (_netState.samples.length < 2) {
    drawNetFrame(typeof performance !== 'undefined' ? performance.now() : 0);
    return;
  }
  if (_netState.rafId === null) {
    _netState.rafId = requestAnimationFrame(drawNetFrame);
  }
}

function normalizeUsageEntity(entity) {
  if (!entity || !entity.id) return null;
  const kind = entity.kind === 'database' || (state.selectedEntityKind === 'database' && entity.project_kind === undefined)
    ? 'database'
    : (entity.kind || 'project');
  return {
    kind,
    id: Number(entity.id),
    entityKey: `${kind}:${entity.id}`,
    name: entity.name || '',
  };
}

function getCurrentUsageEntity() {
  if (state.selectedEntityKind === 'database') {
    const db = getSelectedDatabase();
    return db ? { kind: 'database', id: Number(db.id), entityKey: `database:${db.id}`, name: db.name } : null;
  }
  const p = getSelectedProject();
  return p ? { kind: 'project', id: Number(p.id), entityKey: `project:${p.id}`, name: p.name } : null;
}

function applyUsagePayload(entity, data) {
  if (!data || !entity || _netState.entityKey !== entity.entityKey) return;

  const running = !!data.running;
  const cpuPct = Number(data.cpu?.percent || 0);
  const cpuCores = Number(data.cpu?.hostCores || 1);
  const activePids = Number(data.cpu?.activePids || 0);

  const cpuDisplay = cpuPct > 0 && cpuPct < 0.1 ? `${cpuPct.toFixed(2)}%` : `${cpuPct.toFixed(1)}%`;
  setText('usage-cpu-val', cpuDisplay);
  const cpuBarPct = running && cpuPct > 0 ? Math.min(100, Math.max(1.5, cpuPct)) : 0;
  setMeterWidth('usage-cpu-bar', cpuBarPct);
  const cpuBadge = document.getElementById('usage-cpu-badge');
  if (cpuBadge) {
    cpuBadge.className = running ? 'badge badge-success' : 'badge badge-neutral';
    cpuBadge.textContent = running ? `${activePids} PID${activePids === 1 ? '' : 's'}` : 'Stopped';
  }
  setText(
    'usage-cpu-sub',
    running
      ? `Active process tree • ${cpuCores} host cores`
      : `Idle • ${cpuCores} host cores`
  );

  const ramBytes = Number(data.ram?.bytes || 0);
  const ramPct = Number(data.ram?.percentOfHost || 0);
  const hostRam = data.ram?.hostTotalFormatted || '0 B';
  setText('usage-ram-val', running ? (data.ram?.formatted || formatBytesShort(ramBytes)) : '0 B');
  const ramBarPct = running && ramPct > 0 ? Math.min(100, Math.max(1.5, ramPct)) : 0;
  setMeterWidth('usage-ram-bar', ramBarPct);
  setText('usage-ram-badge', `${(running ? ramPct : 0).toFixed(1)}%`);
  setText(
    'usage-ram-sub',
    running
      ? `Working set • ${hostRam} VPS RAM`
      : `Idle • ${hostRam} VPS RAM`
  );

  const diskPct = Number(data.disk?.percentOfVps || 0);
  const vpsFree = data.disk?.vpsFreeFormatted || '0 B';
  setText('usage-disk-val', data.disk?.formatted || formatBytesShort(data.disk?.bytes || 0));
  setMeterWidth('usage-disk-bar', diskPct);
  setText('usage-disk-badge', `${diskPct.toFixed(1)}%`);
  setText('usage-disk-sub', `${entity.kind === 'database' ? 'Cluster & WAL' : 'App & releases'} • ${vpsFree} free`);

  const net = data.network || {};
  const portOnly = data.port ? `${data.port}` : '';
  const rxTot = Number(net.totalRxBytes || 0);
  const txTot = Number(net.totalTxBytes || 0);
  const conns = Number(net.interfaceCount || 0);
  const samples = Array.isArray(net.history) ? net.history : [];

  _netState.running = running;
  _netState.port = data.port || null;
  _netState.interfaceCount = conns;
  _netState.totalRxBytes = rxTot;
  _netState.totalTxBytes = txTot;

  if (!running) {
    _netState.samples = [];
    _netState.hasOffset = false;
    _netState.displayMaxRate = 1024;
    setText('usage-net-in-val', '0 B/s');
    setText('usage-net-out-val', '0 B/s');
    setText('usage-net-iface', portOnly ? `Offline • ${portOnly}` : 'Offline');
    setText('usage-net-totals', '↓ 0 B  ↑ 0 B');
    renderOfflineNetChart();
    return;
  }

  _netState.samples = samples;
  syncPerfOffset(_netState, samples, 0.05);

  setText('usage-net-iface', portOnly);
  setText('usage-net-totals', `↓ ${formatBytesShort(rxTot)}  ↑ ${formatBytesShort(txTot)}`);

  if (_netState.hoverRatio === null) {
    setText('usage-net-in-val', formatRate(net.inboundBps || 0));
    setText('usage-net-out-val', formatRate(net.outboundBps || 0));
  }

  ensureOnlineChartDom();
  startNetChartRaf();
}

async function fetchProjectUsage(entityInput) {
  const entity = normalizeUsageEntity(entityInput);
  if (!entity || _netState.fetchInFlight || !state.user || !state.csrf) return;
  _netState.fetchInFlight = true;
  _netState.lastFetchAt = Date.now();
  try {
    const endpoint = entity.kind === 'database'
      ? `/api/databases/${entity.id}/usage`
      : `/api/projects/${entity.id}/usage`;
    const data = await api(endpoint, { noCache: true });
    if (getCurrentUsageEntity()?.entityKey === entity.entityKey) {
      applyUsagePayload(entity, data);
    }
  } catch (err) {
    console.warn('[WebDep] Failed to fetch app usage metrics:', err);
  } finally {
    _netState.fetchInFlight = false;
  }
}

function ensureAppUsagePoller() {
  if (!state.user || !state.csrf) {
    stopAppUsagePoller();
    return;
  }
  if (_netState.pollTimer !== null) return;
  _netState.pollTimer = setInterval(() => {
    if (!state.user || !state.csrf || state.currentView !== 'deployments') {
      stopNetChartRaf();
      stopAppUsagePoller();
      return;
    }
    if (document.hidden) {
      stopNetChartRaf();
      return;
    }
    const entity = getCurrentUsageEntity();
    if (!entity) {
      resetAppUsageCards();
      return;
    }
    if (_netState.running) {
      startNetChartRaf();
    }
    if (Date.now() - _netState.lastFetchAt >= POLL_INTERVAL_MS - 120) {
      void fetchProjectUsage(entity);
    }
  }, POLL_INTERVAL_MS);
}

function resetAppUsageCards(projectId = null, entityKey = null) {
  stopNetChartRaf();
  stopAppUsagePoller();
  _netState.entityKey = entityKey;
  _netState.projectId = projectId;
  _netState.running = false;
  _netState.samples = [];
  _netState.hasOffset = false;
  _netState.playheadTs = null;
  _netState.displayMaxRate = 1024;
  _netState.hoverRatio = null;
  _netState.domMode = null;
  _netState._chartEl = null;
  _netState._els = null;

  setText('usage-cpu-val', '0.0%');
  setMeterWidth('usage-cpu-bar', 0);
  setText('usage-ram-val', '0 B');
  setMeterWidth('usage-ram-bar', 0);
  setText('usage-ram-badge', '0%');
  setText('usage-disk-val', '0 B');
  setMeterWidth('usage-disk-bar', 0);
  setText('usage-disk-badge', '0%');
  setText('usage-net-in-val', '0 B/s');
  setText('usage-net-out-val', '0 B/s');
  setText('usage-net-iface', '');
  setText('usage-net-totals', '↓ 0 B  ↑ 0 B');

  const chartEl = document.getElementById('usage-net-chart');
  if (chartEl) {
    chartEl.classList.remove('is-offline');
    chartEl.innerHTML = '';
  }
  setOfflinePills(false);
}

async function loadAppUsageCards(entityInput) {
  const entity = normalizeUsageEntity(entityInput);
  if (!entity) {
    resetAppUsageCards();
    return;
  }

  const switchedEntity = _netState.entityKey !== entity.entityKey;
  if (switchedEntity) {
    resetAppUsageCards(entity.id, entity.entityKey);
  }

  ensureAppUsagePoller();

  // Avoid colliding with the 1s sampler when the 4.5s overview poll fires immediately after a 1s tick.
  if (!switchedEntity && Date.now() - _netState.lastFetchAt < 650) {
    return;
  }

  await fetchProjectUsage(entity);
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    stopNetChartRaf();
  } else if (_netState.running && state.currentView === 'deployments') {
    startNetChartRaf();
  }
});

window.stopAppUsagePoller = stopAppUsagePoller;

export { loadAppUsageCards, resetAppUsageCards, stopAppUsagePoller, formatBytesShort, formatRate, setText, setElText, computeMonotoneTangents, buildCubicPaths, evalMonotoneYAtX, syncPerfOffset, renderSmoothNetFrame };
