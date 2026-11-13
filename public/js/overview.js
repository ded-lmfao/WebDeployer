/**
 * WebDep Overview & Real-Time Monitoring Subsystem
 * Resource usage breakdowns, CPU/RAM/Disk metrics, and live workloads table
 */

import { icon } from './icons.js';
import { state, PAGE_SIZE, paginateAndRender, setHtmlIfChanged, escapeHtml, formatDate } from './state.js';
import { api, toast } from './api.js';
import { loadDatabases } from './databases.js';
import { renderPipelineStages, waterPipelines } from './deployments.js';
import {
  formatBytesShort,
  formatRate,
  setText,
  syncPerfOffset,
  renderSmoothNetFrame,
} from './app_usage.js';

const OV_NET_WINDOW_MS = 45000;
const OV_NET_LAG_MS = 1250;
const OV_NET_SVG_W = 420;
const OV_NET_SVG_H = 56;
const OV_NET_TOP = 7;
const OV_NET_BOTTOM = 50;
const OV_NET_Y_ZERO_IN = 48.2;
const OV_NET_Y_ZERO_OUT = OV_NET_BOTTOM;
const OV_NET_POLL_MS = 1000;

const _ovNetState = {
  samples: [],
  perfToServerOffset: 0,
  hasOffset: false,
  playheadTs: null,
  displayMaxRate: 1024,
  hoverRatio: null,
  rafId: null,
  pollTimer: null,
  pollInFlight: false,
  lastFetchAt: 0,
  lastDrawPerf: 0,
  lastLiveServerTs: 0,
  hasDrawnInitial: false,
};

const OV_NET_CHART_CFG = {
  svgW: OV_NET_SVG_W,
  svgH: OV_NET_SVG_H,
  topPad: OV_NET_TOP,
  yZeroIn: OV_NET_Y_ZERO_IN,
  yZeroOut: OV_NET_Y_ZERO_OUT,
  windowMs: OV_NET_WINDOW_MS,
  lagMs: OV_NET_LAG_MS,
  minRawPeak: 0,
  singleSamplePeakText: 'Peak 0 B/s',
  ids: {
    inArea: 'ov-net-in-area',
    outArea: 'ov-net-out-area',
    inGlow: 'ov-net-in-glow',
    outGlow: 'ov-net-out-glow',
    inLine: 'ov-net-in-line',
    outLine: 'ov-net-out-line',
    inDot: 'ov-net-in-dot',
    outDot: 'ov-net-out-dot',
    crosshair: 'ov-net-crosshair',
    peak: 'ov-net-peak-label',
    inVal: 'overview-net-in-val',
    outVal: 'overview-net-out-val',
  },
};

function stopOverviewNetRaf() {
  if (_ovNetState.rafId !== null && typeof cancelAnimationFrame === 'function') {
    cancelAnimationFrame(_ovNetState.rafId);
  }
  _ovNetState.rafId = null;
  _ovNetState.lastDrawPerf = 0;
}

function stopOverviewNetPoller() {
  if (_ovNetState.pollTimer !== null) {
    clearInterval(_ovNetState.pollTimer);
    _ovNetState.pollTimer = null;
  }
  stopOverviewNetRaf();
}

function ensureOverviewNetDom() {
  const chartEl = document.getElementById('overview-net-chart');
  if (!chartEl) return null;
  if (chartEl.querySelector('#ov-net-in-line')) return chartEl;

  chartEl.innerHTML = `
    <svg class="app-net-svg" viewBox="0 0 ${OV_NET_SVG_W} ${OV_NET_SVG_H}" preserveAspectRatio="none" aria-label="Whole VPS global inbound and outbound network traffic">
      <defs>
        <clipPath id="overview-net-clip">
          <rect x="0" y="0" width="${OV_NET_SVG_W}" height="${OV_NET_SVG_H}"></rect>
        </clipPath>
        <linearGradient id="overviewNetGradIn" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#34d399" stop-opacity="0.32"/>
          <stop offset="100%" stop-color="#34d399" stop-opacity="0.01"/>
        </linearGradient>
        <linearGradient id="overviewNetGradOut" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#60a5fa" stop-opacity="0.28"/>
          <stop offset="100%" stop-color="#60a5fa" stop-opacity="0.01"/>
        </linearGradient>
      </defs>
      <line x1="0" y1="18" x2="${OV_NET_SVG_W}" y2="18" stroke="rgba(255,255,255,0.045)" stroke-dasharray="3 4"/>
      <line x1="0" y1="34" x2="${OV_NET_SVG_W}" y2="34" stroke="rgba(255,255,255,0.045)" stroke-dasharray="3 4"/>
      <line x1="0" y1="${OV_NET_BOTTOM}" x2="${OV_NET_SVG_W}" y2="${OV_NET_BOTTOM}" stroke="rgba(255,255,255,0.08)"/>
      <g clip-path="url(#overview-net-clip)">
        <path id="ov-net-in-area" d="" fill="url(#overviewNetGradIn)"/>
        <path id="ov-net-out-area" d="" fill="url(#overviewNetGradOut)"/>
        <path id="ov-net-in-glow" d="" fill="none" stroke="rgba(52, 211, 153, 0.24)" stroke-width="5" vector-effect="non-scaling-stroke" stroke-linecap="round" stroke-linejoin="round"/>
        <path id="ov-net-out-glow" d="" fill="none" stroke="rgba(96, 165, 250, 0.24)" stroke-width="5" vector-effect="non-scaling-stroke" stroke-linecap="round" stroke-linejoin="round"/>
        <path id="ov-net-in-line" d="" fill="none" stroke="#34d399" stroke-width="2" vector-effect="non-scaling-stroke" stroke-linecap="round" stroke-linejoin="round"/>
        <path id="ov-net-out-line" d="" fill="none" stroke="#60a5fa" stroke-width="1.8" vector-effect="non-scaling-stroke" stroke-linecap="round" stroke-linejoin="round"/>
      </g>
    </svg>
    <div id="ov-net-in-dot" class="app-net-live-marker net-in" style="opacity:0;"></div>
    <div id="ov-net-out-dot" class="app-net-live-marker net-out" style="opacity:0;"></div>
    <div id="ov-net-crosshair" class="app-net-crosshair" style="display:none;"></div>
    <span id="ov-net-peak-label" class="app-net-scale-chip">Peak 0 B/s</span>`;

  chartEl.onmousemove = (ev) => {
    const rect = chartEl.getBoundingClientRect();
    if (!rect.width) return;
    _ovNetState.hoverRatio = Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width));
  };
  chartEl.onmouseleave = () => {
    _ovNetState.hoverRatio = null;
    const cross = document.getElementById('ov-net-crosshair');
    if (cross) cross.style.display = 'none';
  };

  return chartEl;
}

function drawOverviewNetFrame(nowPerf = 0) {
  _ovNetState.rafId = null;

  if (state.currentView !== 'overview' || (typeof document !== 'undefined' && document.hidden)) {
    _ovNetState.lastDrawPerf = 0;
    return;
  }

  const chartEl = ensureOverviewNetDom();
  if (!chartEl) return;

  if (renderSmoothNetFrame(OV_NET_CHART_CFG, _ovNetState, nowPerf)) {
    _ovNetState.hasDrawnInitial = true;
    startOverviewNetRaf();
  }
}

function startOverviewNetRaf() {
  if (_ovNetState.rafId !== null || state.currentView !== 'overview') return;
  if (typeof document !== 'undefined' && document.hidden) return;
  if (typeof requestAnimationFrame !== 'function') return;
  _ovNetState.rafId = requestAnimationFrame(drawOverviewNetFrame);
}

function updateOverviewNetwork(net, opts = {}) {
  if (!net || typeof net !== 'object') return;
  const rawHistory = Array.isArray(net.history) ? net.history : [];
  const normalized = rawHistory
    .filter((pt) => pt && typeof pt.ts === 'number')
    .map((pt) => ({
      ts: pt.ts,
      inboundBps: Math.max(0, Number(pt.inboundBps ?? pt.inbound_bps) || 0),
      outboundBps: Math.max(0, Number(pt.outboundBps ?? pt.outbound_bps) || 0),
    }))
    .sort((a, b) => a.ts - b.ts);

  const inBps = Math.max(0, Number(net.inboundBps ?? net.inbound_bps) || 0);
  const outBps = Math.max(0, Number(net.outboundBps ?? net.outbound_bps) || 0);
  if (normalized.length === 0) {
    normalized.push({ ts: Date.now(), inboundBps: inBps, outboundBps: outBps });
  }

  const latestServerTs = normalized[normalized.length - 1].ts;
  // Never let a 2s/3s-cached /api/overview snapshot overwrite or regress live 1s telemetry
  const staleSnapshot = Boolean(opts.fromSnapshot)
    && _ovNetState.lastLiveServerTs > 0
    && latestServerTs <= _ovNetState.lastLiveServerTs;

  if (!staleSnapshot) {
    if (!opts.fromSnapshot) {
      _ovNetState.lastLiveServerTs = Math.max(_ovNetState.lastLiveServerTs, latestServerTs);
    }

    const cutoff = latestServerTs - (OV_NET_WINDOW_MS + 12000);
    const merged = new Map();
    for (const s of _ovNetState.samples) {
      if (s.ts >= cutoff) merged.set(s.ts, s);
    }
    for (const s of normalized) {
      if (s.ts >= cutoff) merged.set(s.ts, s);
    }
    _ovNetState.samples = Array.from(merged.values()).sort((a, b) => a.ts - b.ts);
    syncPerfOffset(_ovNetState, _ovNetState.samples, 0.05);

    if (_ovNetState.hoverRatio === null) {
      setText('overview-net-in-val', formatRate(inBps));
      setText('overview-net-out-val', formatRate(outBps));
    }

    const ifaces = Number(net.interfaceCount ?? net.interface_count ?? 0);
    setText(
      'overview-net-iface',
      ifaces > 0 ? `Whole VPS • ${ifaces} NIC${ifaces === 1 ? '' : 's'}` : 'Whole VPS NIC'
    );

    const rxTotal = Number(net.totalRxBytes ?? net.total_rx_bytes ?? 0);
    const txTotal = Number(net.totalTxBytes ?? net.total_tx_bytes ?? 0);
    setText('overview-net-totals', `↓ ${formatBytesShort(rxTotal)}  ↑ ${formatBytesShort(txTotal)}`);
  }

  ensureOverviewNetDom();
  if (!_ovNetState.hasDrawnInitial) {
    drawOverviewNetFrame(typeof performance !== 'undefined' ? performance.now() : 0);
  } else {
    startOverviewNetRaf();
  }
}

async function fetchOverviewNetwork() {
  if (_ovNetState.pollInFlight || state.currentView !== 'overview') return;
  if (typeof document !== 'undefined' && document.hidden) return;
  _ovNetState.pollInFlight = true;
  _ovNetState.lastFetchAt = Date.now();
  try {
    const net = await api('/api/overview/network', { noCache: true });
    if (net && typeof net === 'object') {
      updateOverviewNetwork(net, { fromSnapshot: false });
    }
  } catch {
    // Keep last rendered global VPS network graph silently on transient network glitches
  } finally {
    _ovNetState.pollInFlight = false;
  }
}

function ensureOverviewNetPoller() {
  if (state.currentView !== 'overview') {
    stopOverviewNetPoller();
    return;
  }
  startOverviewNetRaf();
  if (_ovNetState.lastLiveServerTs === 0 && !_ovNetState.pollInFlight) {
    void fetchOverviewNetwork();
  }
  if (_ovNetState.pollTimer !== null) return;
  _ovNetState.pollTimer = setInterval(() => {
    if (state.currentView !== 'overview') {
      stopOverviewNetPoller();
      return;
    }
    if (typeof document !== 'undefined' && document.hidden) {
      stopOverviewNetRaf();
      return;
    }
    startOverviewNetRaf();
    if (Date.now() - _ovNetState.lastFetchAt >= OV_NET_POLL_MS - 120) {
      void fetchOverviewNetwork();
    }
  }, OV_NET_POLL_MS);
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      stopOverviewNetRaf();
    } else if (state.currentView === 'overview') {
      startOverviewNetRaf();
    }
  });
}

function getWorkloadIconInfo(r) {
  if (r.kind === 'database') {
    return { name: 'postgres', color: '#336791', typeName: 'PostgreSQL Instance' };
  }
  if (r.kind === 'panel') {
    return { name: 'zap', color: '#38bdf8', typeName: 'Core Platform Daemon' };
  }

  const pId = r.projectId ?? r.project_id;
  const p = (state.projects || []).find((x) => String(x.id) === String(pId))
    || (state.overview?.projects || []).map((x) => x.project).find((x) => x && String(x.id) === String(pId))
    || {};

  const pt = ((r.projectType || r.project_type || p.project_type || '')).toLowerCase();
  const sc = ((r.startCmd || r.start_cmd || p.start_cmd || '')).toLowerCase();
  const name = ((r.name || p.name || '')).toLowerCase();
  const isService = r.kind === 'service' || p.project_kind === 'service';

  if (isService) {
    if (pt.includes('lavalink') || sc.includes('lavalink') || sc.includes('.jar') || sc.includes('java') || name.includes('lavalink')) {
      return { name: 'java', color: '#f97316', typeName: 'Java Daemon' };
    }
    if (pt.includes('python') || sc.includes('python') || sc.includes('.py') || sc.startsWith('py ') || name.includes('python')) {
      return { name: 'python', color: '#38bdf8', typeName: 'Python Daemon' };
    }
    if (pt.includes('rust') || sc.includes('cargo') || sc.includes('.rs')) {
      return { name: 'rust', color: '#dea584', typeName: 'Rust Daemon' };
    }
    if (pt.includes('go') || sc.includes('go run') || sc.includes('.go')) {
      return { name: 'go', color: '#00add8', typeName: 'Go Daemon' };
    }
    if (pt.includes('node') || sc.includes('node') || sc.includes('npm') || sc.includes('yarn') || sc.includes('pnpm') || sc.includes('bun')) {
      return { name: 'nodejs', color: '#22c55e', typeName: 'Node.js Daemon' };
    }
    if (pt.includes('php') || sc.includes('php')) {
      return { name: 'php', color: '#777bb4', typeName: 'PHP Daemon' };
    }
    if (pt.includes('ruby') || sc.includes('ruby') || sc.includes('rails') || sc.includes('puma')) {
      return { name: 'ruby', color: '#cc342d', typeName: 'Ruby Daemon' };
    }
    if (pt.includes('docker') || sc.includes('docker')) {
      return { name: 'docker', color: '#2496ed', typeName: 'Docker Daemon' };
    }
    if (pt.includes('discord') || sc.includes('discord') || name.includes('discord')) {
      return { name: 'nodejs', color: '#22c55e', typeName: 'Backend Service' };
    }
    if (pt.includes('telegram') || sc.includes('telegram') || name.includes('telegram')) {
      return { name: 'python', color: '#38bdf8', typeName: 'Backend Service' };
    }
    return { name: 'terminal', color: 'var(--accent-light)', typeName: 'Backend Service' };
  }

  // Website kind
  if (pt.includes('node') || pt.includes('express') || sc.includes('node') || sc.includes('npm') || sc.includes('yarn') || sc.includes('pnpm') || sc.includes('bun')) {
    return { name: 'nodejs', color: '#22c55e', typeName: 'Node.js App' };
  }
  if (pt.includes('next')) {
    return { name: 'typescript', color: '#3b82f6', typeName: 'Next.js App' };
  }
  if (pt.includes('react') || pt.includes('typescript')) {
    return { name: 'typescript', color: '#3b82f6', typeName: 'React / TS App' };
  }
  if (pt.includes('python') || sc.includes('python') || sc.includes('.py')) {
    return { name: 'python', color: '#38bdf8', typeName: 'Python Web' };
  }
  if (pt.includes('go') || sc.includes('go run') || sc.includes('.go')) {
    return { name: 'go', color: '#00add8', typeName: 'Go Web App' };
  }
  if (pt.includes('rust') || sc.includes('cargo') || sc.includes('.rs')) {
    return { name: 'rust', color: '#dea584', typeName: 'Rust Web App' };
  }
  if (pt.includes('php') || sc.includes('php')) {
    return { name: 'php', color: '#777bb4', typeName: 'PHP Site' };
  }
  if (pt.includes('ruby') || sc.includes('ruby') || sc.includes('rails')) {
    return { name: 'ruby', color: '#cc342d', typeName: 'Ruby Web App' };
  }
  if (pt.includes('docker') || sc.includes('docker')) {
    return { name: 'docker', color: '#2496ed', typeName: 'Docker Container' };
  }

  return { name: 'globe', color: 'var(--accent-light)', typeName: p.project_type || 'Website' };
}

// ============================================================================
// View 1: Overview & Live Resource Consumption
// ============================================================================
function renderResourceBreakdown(resources) {
  const tbody = document.getElementById('resource-breakdown-table');
  if (!tbody) return;
  const list = resources || state.overview?.resources || [];
  const filter = state.resourceFilter || 'all';
  const filtered = filter === 'all' ? list.filter((r) => r.kind !== 'panel') : list.filter((r) => r.kind === filter);

  if (!filtered.length) {
    let emptyMsg = 'No active workloads found.';
    let emptyAction = '';
    if (filter === 'website') {
      emptyMsg = 'No hosted websites created yet.';
      emptyAction = hasPower('projects_manage') ? '<button class="btn btn-primary btn-sm" style="margin-top: 10px;" onclick="openAddWebsiteModal()">+ Add Website</button>' : '';
    } else if (filter === 'service') {
      emptyMsg = 'No backend services created yet.';
      emptyAction = hasPower('services_manage') ? '<button class="btn btn-primary btn-sm" style="margin-top: 10px;" onclick="openAddServiceModal()">+ Add Service</button>' : '';
    } else if (filter === 'database') {
      emptyMsg = 'No managed databases created yet.';
      emptyAction = hasAnyPower(['databases', 'databases_manage']) ? '<button class="btn btn-primary btn-sm" style="margin-top: 10px;" onclick="navigateTo(\'databases\')">Go to Databases &rarr;</button>' : '';
    } else if (filter === 'all') {
      emptyMsg = 'No workloads created yet. Deploy websites, backend services or databases to monitor their live resource usage.';
      const btns = [
        hasPower('projects_manage') ? '<button class="btn btn-primary btn-sm" onclick="openAddWebsiteModal()">+ Add Website</button>' : '',
        hasPower('services_manage') ? '<button class="btn btn-secondary btn-sm" onclick="openAddServiceModal()">+ Add Service</button>' : '',
        hasAnyPower(['databases', 'databases_manage']) ? '<button class="btn btn-secondary btn-sm" onclick="navigateTo(\'databases\')">Go to Databases &rarr;</button>' : '',
      ].filter(Boolean).join('');
      emptyAction = btns ? `<div style="margin-top: 12px; display: flex; gap: 8px; justify-content: center;">${btns}</div>` : '';
    }
    setHtmlIfChanged(tbody, `<tr><td colspan="8" style="text-align: center; padding: 32px 16px; color: var(--text-dim);"><div style="font-size: 13.5px;">${emptyMsg}</div>${emptyAction}</td></tr>`);
    return;
  }

  setHtmlIfChanged(tbody, filtered.map((r) => {
    const isRunning = r.status === 'running';
    const isMaintenance = r.status === 'maintenance';
    const kindUpper = r.kind.toUpperCase();
    const kindBadgeClass = `badge-res-${r.kind}`;
    const iconInfo = getWorkloadIconInfo(r);
    const kindIconSvg = icon(iconInfo.name, { size: 24, cls: `res-icon-${r.kind}` });
    
    let subtitle = '';
    if (r.kind === 'panel') {
      subtitle = '<span style="color:var(--text-dim)">Core Platform Daemon</span>';
    } else if (r.kind === 'database') {
      subtitle = '<span style="color:var(--text-dim)">PostgreSQL Instance</span>';
    } else if (r.kind === 'service') {
      const sha = r.commitSha ? `<span class="sha-pill" style="font-size:10px; margin-left:4px;">${r.commitSha.slice(0, 7)}</span>` : '';
      subtitle = `<span style="color:var(--text-dim)">Backend Service</span>${sha}`;
    } else {
      const dom = r.domain ? `<a href="http://${escapeHtml(r.domain)}" target="_blank" class="domain-badge" style="font-size:11px;" onclick="event.stopPropagation()">${escapeHtml(r.domain)}</a>` : (r.port ? `<span style="color:var(--text-dim)">:${r.port}</span>` : '<span style="color:var(--text-dim)">Local only</span>');
      const sha = r.commitSha ? `<span class="sha-pill" style="font-size:10px; margin-left:4px;">${r.commitSha.slice(0, 7)}</span>` : '';
      subtitle = `${dom}${sha}`;
    }

    const pId = r.projectId ?? r.project_id;
    const p = (state.projects || []).find((x) => x.id === pId)
      || (state.overview?.projects || []).map((x) => x.project).find((x) => x && x.id === pId)
      || {};
    const effectivePid = r.pid || p.app_pid || p.status?.pid;

    const portPid = [
      r.port ? `:${r.port}` : null,
      effectivePid ? `<span class="res-pid-chip">PID ${effectivePid}</span>` : null,
    ].filter(Boolean).join(' ') || '<span style="color:var(--text-dim)">--</span>';

    const cpuVal = (r.cpuPct || 0).toFixed(1);
    const cpuWarm = r.cpuPct > 40 ? 'hot' : r.cpuPct > 15 ? 'warm' : '';
    const memVal = r.memoryFormatted || '0 MB';
    const memPctVal = (r.memoryPct || 0).toFixed(1);
    const memWarm = r.memoryPct > 30 ? 'hot' : r.memoryPct > 15 ? 'warm' : '';
    const diskVal = r.diskFormatted || '0 MB';
    const diskPctVal = (r.diskPct || 0).toFixed(1);
    const diskWarm = (r.diskPct || 0) > 20 ? 'hot' : (r.diskPct || 0) > 5 ? 'warm' : '';

    const dbId = r.databaseId ?? r.database_id;
    let actionBtn = '';
    if (r.kind === 'panel') {
      actionBtn = '<button class="btn btn-secondary btn-sm" onclick="event.stopPropagation(); navigateTo(\'settings\')">Settings &rarr;</button>';
    } else if (r.kind === 'database') {
      actionBtn = dbId
        ? `<button class="btn btn-secondary btn-sm" onclick="event.stopPropagation(); openDatabaseWorkspace(${dbId}, 'deployments')">Manage &rarr;</button>`
        : '<button class="btn btn-secondary btn-sm" onclick="event.stopPropagation(); navigateTo(\'databases\')">Databases &rarr;</button>';
    } else if (r.kind === 'service') {
      actionBtn = '<button class="btn btn-secondary btn-sm" onclick="event.stopPropagation(); navigateTo(\'services\')">Services &rarr;</button>';
    } else {
      actionBtn = '<button class="btn btn-secondary btn-sm" onclick="event.stopPropagation(); navigateTo(\'projects\')">Websites &rarr;</button>';
    }

    const rowClick = pId
      ? `style="cursor: pointer;" onclick="openWebsiteWorkspace(${pId})"`
      : (r.kind === 'database'
        ? (dbId ? `style="cursor: pointer;" onclick="openDatabaseWorkspace(${dbId}, 'deployments')"` : 'style="cursor: pointer;" onclick="navigateTo(\'databases\')"')
        : 'style="cursor: pointer;" onclick="navigateTo(\'settings\')"');

    return `
      <tr ${rowClick}>
        <td>
          <div class="res-workload-title">
            <div class="res-workload-icon" style="color: ${iconInfo.color};">${kindIconSvg}</div>
            <div>
              <div class="res-workload-name">${escapeHtml(r.name)}</div>
              <div class="res-workload-sub">${subtitle}</div>
            </div>
          </div>
        </td>
        <td><span class="${kindBadgeClass}">${kindUpper}</span></td>
        <td>${portPid}</td>
        <td>
          <span class="status-dot ${isRunning ? 'online' : isMaintenance ? 'maintenance' : 'offline'}"></span>
          <span style="font-size: 12px; font-weight: 600; margin-left: 5px; color: ${isRunning ? 'var(--success)' : isMaintenance ? 'var(--warning)' : 'var(--text-muted)'};">${isRunning ? 'Running' : isMaintenance ? 'Maintenance' : 'Stopped'}</span>
        </td>
        <td>
          <div class="res-metric-cell">
            <div class="res-metric-head">
              <span style="color: ${isRunning ? 'var(--text-main)' : 'var(--text-dim)'}; font-weight: 600;">${isRunning ? `${cpuVal}%` : '0%'}</span>
              <span style="color: var(--text-dim); font-size: 11px;">CPU</span>
            </div>
            <div class="res-mini-bar">
              <div class="res-mini-fill res-cpu-fill ${cpuWarm}" style="width: ${isRunning ? Math.min(100, Math.max(2, r.cpuPct * 2)) : 0}%;"></div>
            </div>
          </div>
        </td>
        <td>
          <div class="res-metric-cell">
            <div class="res-metric-head">
              <span style="color: ${isRunning ? 'var(--text-main)' : 'var(--text-dim)'}; font-weight: 600;">${isRunning ? memVal : '0 MB'}</span>
              <span style="color: var(--text-dim); font-size: 11px;">${isRunning ? `${memPctVal}% VPS` : '--'}</span>
            </div>
            <div class="res-mini-bar">
              <div class="res-mini-fill res-mem-fill ${memWarm}" style="width: ${isRunning ? Math.min(100, Math.max(2, r.memoryPct)) : 0}%;"></div>
            </div>
          </div>
        </td>
        <td>
          <div class="res-metric-cell">
            <div class="res-metric-head">
              <span style="color: var(--text-main); font-weight: 600;">${diskVal}</span>
              <span style="color: var(--text-dim); font-size: 11px;">${diskPctVal}% Disk</span>
            </div>
            <div class="res-mini-bar">
              <div class="res-mini-fill res-disk-fill ${diskWarm}" style="width: ${Math.min(100, Math.max(2, (r.diskPct || 0) * 2))}%;"></div>
            </div>
          </div>
        </td>
        <td style="text-align: right;" onclick="event.stopPropagation()">
          ${actionBtn}
        </td>
      </tr>
    `;
  }).join(''));
}

function filterResourceBreakdown(filter) {

  state.resourceFilter = filter;
  document.querySelectorAll('#resource-filter-pills .pill').forEach((btn) => {
    btn.classList.toggle('active', btn.getAttribute('data-res-filter') === filter);
  });
  renderResourceBreakdown();
};

async function loadOverview() {
  try {
    const data = await api('/api/overview');
    state.overview = data;
    if (Array.isArray(data.projects)) {
      state.projects = data.projects.map((x) => x.project);
      if (state.projects.length > 0 && !state.selectedProjectId) {
        state.selectedProjectId = state.projects[0].id;
      }
    }

    // Server Stats & Sidebar Counts
    const m = data.monitor || {};
    const ovWeb = (data.projects || []).filter((x) => x.project.project_kind !== 'service');
    const ovSvc = (data.projects || []).filter((x) => x.project.project_kind === 'service');

    // Keep navigation sidebar counts updated immediately without extra network calls
    const badgeWebEl = document.getElementById('badge-projects-count');
    if (badgeWebEl) badgeWebEl.textContent = ovWeb.length;
    const badgeSvcEl = document.getElementById('badge-services-count');
    if (badgeSvcEl) badgeSvcEl.textContent = ovSvc.length;
    const badgeDbEl = document.getElementById('badge-databases-count');
    if (badgeDbEl) {
      const dbCountFromResources = Array.isArray(data.resources) ? data.resources.filter((r) => r.kind === 'database').length : 0;
      const dbCountFromState = Array.isArray(state.databases) ? state.databases.length : 0;
      badgeDbEl.textContent = Math.max(dbCountFromResources, dbCountFromState);
    }

    if (data.network) {
      updateOverviewNetwork(data.network, { fromSnapshot: true });
    }
    ensureOverviewNetPoller();

    const cpuPct = m.cpu?.pct || 0;
    const cpuCores = m.cpu?.cores || 1;
    document.getElementById('stat-cpu-pct').textContent = `${cpuPct}%`;
    const cpuBar = document.getElementById('stat-cpu-bar');
    if (cpuBar) {
      cpuBar.style.width = `${Math.min(100, cpuPct)}%`;
      cpuBar.className = `progress-fill ${cpuPct > 80 ? 'rose' : cpuPct > 50 ? 'amber' : 'green'}`;
    }
    const cpuMeta = document.getElementById('stat-cpu-meta');
    if (cpuMeta) cpuMeta.textContent = `${cpuCores} Core${cpuCores === 1 ? '' : 's'} (${cpuPct}% total)`;

    const memPct = m.memory?.pct || 0;
    const usedMb = ((m.memory?.used || 0) / 1048576).toFixed(0);
    const totalMb = ((m.memory?.total || 0) / 1048576).toFixed(0);
    document.getElementById('stat-mem-pct').textContent = `${memPct}%`;
    const memBar = document.getElementById('stat-mem-bar');
    if (memBar) {
      memBar.style.width = `${Math.min(100, memPct)}%`;
      memBar.className = `progress-fill ${memPct > 85 ? 'rose' : memPct > 65 ? 'amber' : 'green'}`;
    }
    const memMeta = document.getElementById('stat-mem-meta');
    if (memMeta) memMeta.textContent = `${usedMb} MB / ${totalMb} MB`;

    if (m.disk) {
      const diskPct = Math.min(100, Math.max(0, Number(m.disk.pct) || 0));
      const freeGb = (m.disk.free / 1073741824).toFixed(1);
      const totalGb = (m.disk.total / 1073741824).toFixed(1);
      setText('stat-disk-free', `${freeGb} GB`);
      const diskBar = document.getElementById('stat-disk-bar');
      if (diskBar) {
        diskBar.style.width = `${diskPct}%`;
        diskBar.className = `progress-fill ${diskPct > 85 ? 'rose' : diskPct > 70 ? 'amber' : 'green'}`;
      }
      setText('stat-disk-meta', `${totalGb} GB total (${diskPct}% used)`);
    }

    // Active resource summary bar
    const sum = data.summary || {};
    const panelUsageEl = document.getElementById('res-panel-usage');
    if (panelUsageEl) {
      panelUsageEl.textContent = `${sum.panelMemoryFormatted || '--'} • ${(sum.panelCpu || 0).toFixed(1)}% CPU`;
    }
    const workloadsUsageEl = document.getElementById('res-workloads-usage');
    if (workloadsUsageEl) {
      workloadsUsageEl.textContent = `${sum.totalManagedMemoryFormatted || '--'} • ${(sum.totalManagedCpu || 0).toFixed(1)}% CPU`;
    }
    const sysUsageEl = document.getElementById('res-system-usage');
    if (sysUsageEl) {
      sysUsageEl.textContent = `${sum.systemOverheadMemoryFormatted || '--'} • ${(sum.systemOverheadCpu || 0).toFixed(1)}% CPU`;
    }
    const freeMemEl = document.getElementById('res-free-memory');
    if (freeMemEl) {
      const totalMb = Math.round((m.memory?.total || 0) / 1048576);
      const usedMb = Math.round((m.memory?.used || 0) / 1048576);
      const availMb = Math.max(0, totalMb - usedMb);
      freeMemEl.textContent = `${availMb} MB available`;
    }
    const countBadgeEl = document.getElementById('res-workloads-count-badge');
    if (countBadgeEl) {
      countBadgeEl.textContent = `${sum.runningWorkloadsCount || 0} / ${sum.totalWorkloadsCount || 0} Running`;
    }

    // Render active resources telemetry table
    renderResourceBreakdown(data.resources);

    // Keep service pipelines synchronized with live telemetry & deployments
    if (state.currentView === 'services') {
      (state.projects || []).filter((p) => p.project_kind === 'service').forEach((p) => {
        if (typeof syncServiceCardPipeline === 'function') syncServiceCardPipeline(p);
      });
    }

    // Active deployment box
    const active = data.projects.find((x) => x.active);
    const actBox = document.getElementById('overview-active-deployment-box');
    const pOverview = waterPipelines['overview-pipeline-track'];
    if (active && active.active) {
      actBox.style.display = 'block';
      document.getElementById('active-dep-project-name').textContent = active.project.name;
      document.getElementById('active-dep-kind').textContent = active.active.kind.toUpperCase();
      renderPipelineStages('overview-pipeline-track', active.active.stage, active.active.status, active.active.id);
    } else if (pOverview && pOverview.isLooping && pOverview.currentProgress < 6.95) {
      actBox.style.display = 'block';
      document.getElementById('active-dep-kind').textContent = 'DEPLOYED';
      renderPipelineStages('overview-pipeline-track', 'health_checking', 'success', pOverview.lastDeploymentId);
    } else {
      actBox.style.display = 'none';
    }

  } catch (err) {
    console.error('Overview load error:', err);
  }
}



window.loadOverview = loadOverview;
window.renderResourceBreakdown = renderResourceBreakdown;
window.filterResourceBreakdown = filterResourceBreakdown;
window.stopOverviewNetPoller = stopOverviewNetPoller;

export {
  loadOverview,
  renderResourceBreakdown,
  filterResourceBreakdown,
  updateOverviewNetwork,
  stopOverviewNetPoller,
};
