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

function setText(id, text) {
  const el = document.getElementById(id);
  if (el && el.textContent !== text) {
    el.textContent = text;
  }
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

/**
 * Compute Fritsch-Carlson monotone cubic tangents so smoothed lines never overshoot
 * plotted bounds or oscillate on step changes.
 */
function computeMonotoneTangents(pts) {
  const n = pts.length;
  const m = new Array(n).fill(0);
  if (n < 2) return m;

  const d = new Array(n - 1);
  const dx = new Array(n - 1);
  for (let i = 0; i < n - 1; i++) {
    dx[i] = Math.max(pts[i + 1].x - pts[i].x, 1e-4);
    d[i] = (pts[i + 1].y - pts[i].y) / dx[i];
  }

  m[0] = d[0];
  m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) {
    if (d[i - 1] === 0 || d[i] === 0 || Math.sign(d[i - 1]) !== Math.sign(d[i])) {
      m[i] = 0;
    } else {
      const w1 = 2 * dx[i] + dx[i - 1];
      const w2 = dx[i] + 2 * dx[i - 1];
      m[i] = (w1 + w2) / (w1 / d[i - 1] + w2 / d[i]);
    }
  }

  for (let i = 0; i < n - 1; i++) {
    if (Math.abs(d[i]) < 1e-9) {
      m[i] = 0;
      m[i + 1] = 0;
      continue;
    }
    const alpha = m[i] / d[i];
    const beta = m[i + 1] / d[i];
    const h = Math.hypot(alpha, beta);
    if (h > 3) {
      const scale = 3 / h;
      m[i] = scale * alpha * d[i];
      m[i + 1] = scale * beta * d[i];
    }
  }
  return m;
}

function buildCubicPaths(pts, m, baseBottom = PLOT_BOTTOM) {
  const n = pts.length;
  if (n === 0) return { line: '', area: '' };
  if (n === 1) {
    const p = pts[0];
    return {
      line: `M${p.x.toFixed(2)},${p.y.toFixed(2)}`,
      area: `M${p.x.toFixed(2)},${baseBottom} L${p.x.toFixed(2)},${p.y.toFixed(2)} L${p.x.toFixed(2)},${baseBottom} Z`,
    };
  }

  let line = `M${pts[0].x.toFixed(2)},${pts[0].y.toFixed(2)}`;
  for (let i = 0; i < n - 1; i++) {
    const step = (pts[i + 1].x - pts[i].x) / 3;
    const c1x = pts[i].x + step;
    const c1y = Math.max(TOP_PAD, Math.min(PLOT_BOTTOM, pts[i].y + m[i] * step));
    const c2x = pts[i + 1].x - step;
    const c2y = Math.max(TOP_PAD, Math.min(PLOT_BOTTOM, pts[i + 1].y - m[i + 1] * step));
    line += ` C${c1x.toFixed(2)},${c1y.toFixed(2)} ${c2x.toFixed(2)},${c2y.toFixed(2)} ${pts[i + 1].x.toFixed(2)},${pts[i + 1].y.toFixed(2)}`;
  }

  const last = pts[n - 1];
  const first = pts[0];
  const area = `${line} L${last.x.toFixed(2)},${baseBottom} L${first.x.toFixed(2)},${baseBottom} Z`;
  return { line, area };
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
  const h = Math.max(pts[lo + 1].x - pts[lo].x, 1e-4);
  const t = Math.max(0, Math.min(1, (xTarget - pts[lo].x) / h));
  const t2 = t * t;
  const t3 = t2 * t;
  const h00 = 2 * t3 - 3 * t2 + 1;
  const h10 = t3 - 2 * t2 + t;
  const h01 = -2 * t3 + 3 * t2;
  const h11 = t3 - t2;
  const y =
    h00 * pts[lo].y +
    h10 * h * m[lo] +
    h01 * pts[lo + 1].y +
    h11 * h * m[lo + 1];
  return Math.max(TOP_PAD, Math.min(PLOT_BOTTOM, y));
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

  setOfflinePills(true);
  chartEl.classList.add('is-offline');

  if (_netState.domMode !== 'offline') {
    _netState.domMode = 'offline';
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
  const chartEl = document.getElementById('usage-net-chart');
  if (!chartEl) return null;

  setOfflinePills(false);
  chartEl.classList.remove('is-offline');

  if (_netState.domMode === 'online' && chartEl.querySelector('#net-in-line')) {
    return chartEl;
  }

  _netState.domMode = 'online';
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
  const inAreaEl = document.getElementById(ids.inArea);
  const outAreaEl = document.getElementById(ids.outArea);
  const inGlowEl = document.getElementById(ids.inGlow);
  const outGlowEl = document.getElementById(ids.outGlow);
  const inLineEl = document.getElementById(ids.inLine);
  const outLineEl = document.getElementById(ids.outLine);
  const inDotEl = document.getElementById(ids.inDot);
  const outDotEl = document.getElementById(ids.outDot);
  const crossEl = document.getElementById(ids.crosshair);
  const peakEl = document.getElementById(ids.peak);
  if (!inLineEl || !outLineEl || !inAreaEl || !outAreaEl) return false;

  if (samples.length < 2) {
    const flatInLine = `M0.00,${yZeroIn.toFixed(2)} L${svgW}.00,${yZeroIn.toFixed(2)}`;
    const flatOutLine = `M0.00,${yZeroOut.toFixed(2)} L${svgW}.00,${yZeroOut.toFixed(2)}`;
    const flatInArea = `M0.00,${yZeroIn.toFixed(2)} L${svgW}.00,${yZeroIn.toFixed(2)} Z`;
    const flatOutArea = `M0.00,${yZeroOut.toFixed(2)} L${svgW}.00,${yZeroOut.toFixed(2)} Z`;
    inLineEl.setAttribute('d', flatInLine);
    outLineEl.setAttribute('d', flatOutLine);
    if (inGlowEl) inGlowEl.setAttribute('d', flatInLine);
    if (outGlowEl) outGlowEl.setAttribute('d', flatOutLine);
    inAreaEl.setAttribute('d', flatInArea);
    outAreaEl.setAttribute('d', flatOutArea);
    if (inDotEl) {
      inDotEl.style.opacity = '1';
      inDotEl.style.left = '100%';
      inDotEl.style.top = `${(yZeroIn / svgH) * 100}%`;
    }
    if (outDotEl) {
      outDotEl.style.opacity = '1';
      outDotEl.style.left = '100%';
      outDotEl.style.top = `${(yZeroOut / svgH) * 100}%`;
    }
    if (peakEl) {
      peakEl.textContent = samples.length === 1
        ? (cfg.singleSamplePeakText || 'Sampling')
        : 'Starting';
    }
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

  // Include at most 1 look-behind / look-ahead bracket beyond the margin so clipped tangents stay smooth
  const visible = samples.filter((s) => s.ts >= viewStart - 3000 && s.ts <= viewEnd + 3000);
  const inWindow = visible.filter((s) => s.ts >= viewStart && s.ts <= viewEnd);
  const peakBasis = inWindow.length ? inWindow : visible;

  let rawPeak = cfg.minRawPeak ?? 512;
  for (let i = 0; i < peakBasis.length; i++) {
    const s = peakBasis[i];
    if (s.inboundBps > rawPeak) rawPeak = s.inboundBps;
    if (s.outboundBps > rawPeak) rawPeak = s.outboundBps;
  }
  const targetPeak = Math.max(1024, rawPeak * 1.15);
  const scaleAlpha = 1 - Math.exp(-dt * 3.5);
  netState.displayMaxRate += (targetPeak - netState.displayMaxRate) * scaleAlpha;
  const maxRate = Math.max(1024, netState.displayMaxRate);

  const inUsableH = yZeroIn - topPad;
  const outUsableH = yZeroOut - topPad;
  const ptsIn = [];
  const ptsOut = [];
  for (let i = 0; i < visible.length; i++) {
    const s = visible[i];
    const x = ((s.ts - viewStart) / windowMs) * svgW;
    const yIn = yZeroIn - Math.min(1, s.inboundBps / maxRate) * inUsableH;
    const yOut = yZeroOut - Math.min(1, s.outboundBps / maxRate) * outUsableH;
    ptsIn.push({ x, y: yIn });
    ptsOut.push({ x, y: yOut });
  }

  if (ptsIn.length === 0) {
    const latest = samples[samples.length - 1];
    const yInLast = yZeroIn - Math.min(1, (latest?.inboundBps || 0) / maxRate) * inUsableH;
    const yOutLast = yZeroOut - Math.min(1, (latest?.outboundBps || 0) / maxRate) * outUsableH;
    ptsIn.push({ x: 0, y: yZeroIn }, { x: svgW, y: yInLast });
    ptsOut.push({ x: 0, y: yZeroOut }, { x: svgW, y: yOutLast });
  } else {
    const firstX = ptsIn[0].x;
    if (firstX > 0.5) {
      if (firstX > 6) {
        ptsIn.unshift({ x: firstX - 3, y: yZeroIn });
        ptsOut.unshift({ x: firstX - 3, y: yZeroOut });
      }
      ptsIn.unshift({ x: 0, y: yZeroIn });
      ptsOut.unshift({ x: 0, y: yZeroOut });
    }
    const lastIn = ptsIn[ptsIn.length - 1];
    const lastOut = ptsOut[ptsOut.length - 1];
    if (lastIn.x < svgW - 0.5) {
      ptsIn.push({ x: svgW, y: lastIn.y });
      ptsOut.push({ x: svgW, y: lastOut.y });
    }
  }

  const mIn = computeMonotoneTangents(ptsIn);
  const mOut = computeMonotoneTangents(ptsOut);
  const pathsIn = buildCubicPaths(ptsIn, mIn, yZeroIn);
  const pathsOut = buildCubicPaths(ptsOut, mOut, yZeroOut);

  inAreaEl.setAttribute('d', pathsIn.area);
  outAreaEl.setAttribute('d', pathsOut.area);
  inLineEl.setAttribute('d', pathsIn.line);
  outLineEl.setAttribute('d', pathsOut.line);
  if (inGlowEl) inGlowEl.setAttribute('d', pathsIn.line);
  if (outGlowEl) outGlowEl.setAttribute('d', pathsOut.line);

  const rightX = Math.max(0, Math.min(svgW, ptsIn[ptsIn.length - 1].x));
  const dotYIn = evalMonotoneYAtX(ptsIn, mIn, rightX);
  const dotYOut = evalMonotoneYAtX(ptsOut, mOut, rightX);

  if (inDotEl) {
    inDotEl.style.opacity = '1';
    inDotEl.style.left = `${(rightX / svgW) * 100}%`;
    inDotEl.style.top = `${(dotYIn / svgH) * 100}%`;
  }
  if (outDotEl) {
    outDotEl.style.opacity = '1';
    outDotEl.style.left = `${(rightX / svgW) * 100}%`;
    outDotEl.style.top = `${(dotYOut / svgH) * 100}%`;
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
        crossEl.style.display = 'block';
        crossEl.style.left = `${(hx / svgW) * 100}%`;
      } else {
        crossEl.style.display = 'none';
      }
      if (peakEl) {
        peakEl.textContent = `In ${formatRate(nearest.inboundBps)} • Out ${formatRate(nearest.outboundBps)}`;
      }
      setText(ids.inVal, formatRate(nearest.inboundBps));
      setText(ids.outVal, formatRate(nearest.outboundBps));
    }
  } else {
    if (crossEl) crossEl.style.display = 'none';
    const latest = samples[samples.length - 1];
    setText(ids.inVal, formatRate(latest.inboundBps));
    setText(ids.outVal, formatRate(latest.outboundBps));
    if (peakEl) peakEl.textContent = `Peak ${formatRate(rawPeak)}`;
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

  if (renderSmoothNetFrame(APP_NET_CHART_CFG, _netState, nowPerf)) {
    _netState.rafId = requestAnimationFrame(drawNetFrame);
  }
}

function startNetChartRaf() {
  if (_netState.rafId === null && _netState.running && state.currentView === 'deployments' && !document.hidden) {
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
  if (!entity || _netState.fetchInFlight) return;
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
  if (_netState.pollTimer !== null) return;
  _netState.pollTimer = setInterval(() => {
    if (state.currentView !== 'deployments' || document.hidden) {
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

export { loadAppUsageCards, resetAppUsageCards, formatBytesShort, formatRate, setText, computeMonotoneTangents, buildCubicPaths, evalMonotoneYAtX, syncPerfOffset, renderSmoothNetFrame };
