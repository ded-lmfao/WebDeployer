/**
 * WebDep Overview & Real-Time Monitoring Subsystem
 * Resource usage breakdowns, CPU/RAM/Disk metrics, and live workloads table
 */

import { icon } from './icons.js';
import { state, PAGE_SIZE, paginateAndRender, setHtmlIfChanged, escapeHtml, formatDate } from './state.js';
import { api, toast } from './api.js';
import { loadDatabases } from './databases.js';
import { renderPipelineStages } from './deployments.js';

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
      emptyAction = '<button class="btn btn-primary btn-sm" style="margin-top: 10px;" onclick="openAddWebsiteModal()">+ Add Website</button>';
    } else if (filter === 'service') {
      emptyMsg = 'No backend services or bots created yet.';
      emptyAction = '<button class="btn btn-primary btn-sm" style="margin-top: 10px;" onclick="openAddServiceModal()">+ Add Service</button>';
    } else if (filter === 'database') {
      emptyMsg = 'No managed databases created yet.';
      emptyAction = '<button class="btn btn-primary btn-sm" style="margin-top: 10px;" onclick="navigateTo(\'databases\')">Go to Databases &rarr;</button>';
    } else if (filter === 'all') {
      emptyMsg = 'No workloads created yet. Deploy websites, backend services or databases to monitor their live resource usage.';
      emptyAction = '<div style="margin-top: 12px; display: flex; gap: 8px; justify-content: center;"><button class="btn btn-primary btn-sm" onclick="openAddWebsiteModal()">+ Add Website</button><button class="btn btn-secondary btn-sm" onclick="openAddServiceModal()">+ Add Service</button><button class="btn btn-secondary btn-sm" onclick="navigateTo(\'databases\')">Go to Databases &rarr;</button></div>';
    }
    setHtmlIfChanged(tbody, `<tr><td colspan="8" style="text-align: center; padding: 32px 16px; color: var(--text-dim);"><div style="font-size: 13.5px;">${emptyMsg}</div>${emptyAction}</td></tr>`);
    return;
  }

  setHtmlIfChanged(tbody, filtered.map((r) => {
    const isRunning = r.status === 'running';
    const isMaintenance = r.status === 'maintenance';
    const kindUpper = r.kind.toUpperCase();
    const kindBadgeClass = `badge-res-${r.kind}`;
    const kindIconName = r.kind === 'panel' ? 'zap' : r.kind === 'database' ? 'database' : r.kind === 'service' ? 'bot' : 'globe';
    const kindIconSvg = icon(kindIconName, { size: 16, cls: `res-icon-${r.kind}` });
    
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

    const portPid = [
      r.port ? `:${r.port}` : null,
      r.pid ? `<span class="res-pid-chip">PID ${r.pid}</span>` : null,
    ].filter(Boolean).join(' ') || '<span style="color:var(--text-dim)">--</span>';

    const cpuVal = (r.cpuPct || 0).toFixed(1);
    const cpuWarm = r.cpuPct > 40 ? 'hot' : r.cpuPct > 15 ? 'warm' : '';
    const memVal = r.memoryFormatted || '0 MB';
    const memPctVal = (r.memoryPct || 0).toFixed(1);
    const memWarm = r.memoryPct > 30 ? 'hot' : r.memoryPct > 15 ? 'warm' : '';
    const diskVal = r.diskFormatted || '0 MB';
    const diskPctVal = (r.diskPct || 0).toFixed(1);
    const diskWarm = (r.diskPct || 0) > 20 ? 'hot' : (r.diskPct || 0) > 5 ? 'warm' : '';

    const pId = r.projectId ?? r.project_id;
    let actionBtn = '';
    if (r.kind === 'panel') {
      actionBtn = '<button class="btn btn-secondary btn-sm" onclick="navigateTo(\'settings\')">Settings &rarr;</button>';
    } else if (r.kind === 'database') {
      actionBtn = '<button class="btn btn-secondary btn-sm" onclick="navigateTo(\'databases\')">Databases &rarr;</button>';
    } else if (r.kind === 'service') {
      actionBtn = '<button class="btn btn-secondary btn-sm" onclick="navigateTo(\'services\')">Services &rarr;</button>';
    } else {
      actionBtn = '<button class="btn btn-secondary btn-sm" onclick="navigateTo(\'projects\')">Websites &rarr;</button>';
    }

    const rowClick = pId
      ? `style="cursor: pointer;" onclick="openWebsiteWorkspace(${pId})"`
      : (r.kind === 'database'
        ? 'style="cursor: pointer;" onclick="navigateTo(\'databases\')"'
        : 'style="cursor: pointer;" onclick="navigateTo(\'settings\')"');

    return `
      <tr ${rowClick}>
        <td>
          <div class="res-workload-title">
            <div class="res-workload-icon">${kindIconSvg}</div>
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

    // Server Stats
    const m = data.monitor || {};
    const ovWeb = (data.projects || []).filter((x) => x.project.project_kind !== 'service');
    const ovSvc = (data.projects || []).filter((x) => x.project.project_kind === 'service');
    document.getElementById('stat-total-projects').textContent = ovWeb.length;
    document.getElementById('stat-total-services').textContent = ovSvc.length;

    // Keep navigation sidebar counts updated immediately without extra network calls
    const badgeWebEl = document.getElementById('badge-projects-count');
    if (badgeWebEl) badgeWebEl.textContent = ovWeb.length;
    const badgeSvcEl = document.getElementById('badge-services-count');
    if (badgeSvcEl) badgeSvcEl.textContent = ovSvc.length;
    const badgeDbEl = document.getElementById('badge-databases-count');
    if (badgeDbEl && Array.isArray(data.resources)) {
      badgeDbEl.textContent = data.resources.filter((r) => r.kind === 'database').length;
    }

    const svcOnline = ovSvc.filter((x) => x.app?.running).length;
    document.getElementById('stat-services-online').textContent = svcOnline;
    document.getElementById('stat-services-offline').textContent = ovSvc.length - svcOnline;
    
    let online = 0;
    let offline = 0;
    ovWeb.forEach((item) => {
      if (item.app?.running) online++; else offline++;
    });
    document.getElementById('stat-online-count').textContent = online;
    document.getElementById('stat-offline-count').textContent = offline;

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
      const freeGb = (m.disk.free / 1073741824).toFixed(1);
      const totalGb = (m.disk.total / 1073741824).toFixed(1);
      document.getElementById('stat-disk-free').textContent = `${freeGb} GB`;
      document.getElementById('stat-disk-meta').textContent = `${totalGb} GB total (${m.disk.pct}% used)`;
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

export {
  loadOverview,
  renderResourceBreakdown,
  filterResourceBreakdown,
};
