/**
 * WebDep Backend Services & Standalone Daemons Subsystem
 * Discord bots, Lavalink audio servers, background python workers, and pipeline status sync.
 */

import { icon } from './icons.js';
import { state, escapeHtml } from './state.js';
import { api, toast } from './api.js';
import { loadProjects } from './websites.js';
import { openWebsiteWorkspace, navigateTo } from './workspace.js';

// Re-export modal submodule so consumers have full backward compatibility
export * from './services_modal.js';

export async function loadServicesView() {
  const container = document.getElementById('services-list');
  if (!container) return;

  try {
    const list = await api('/api/projects');
    state.projects = Array.isArray(list) ? list : [];
    renderServicesList();
  } catch (err) {
    container.innerHTML = `<div style="grid-column: 1 / -1; color: var(--danger-light); padding: 20px;">Failed to load services: ${escapeHtml(err.message)}</div>`;
  }
}

export function renderSingleServicePipeline(serviceId, currentStage, currentStatus, detailText = '') {
  const el = document.getElementById(`service-pipeline-${serviceId}`);
  if (!el) return;

  const stages = [
    { key: 'prepare', label: 'Fetch' },
    { key: 'build', label: 'Build' },
    { key: 'deploy', label: 'Deploy' },
    { key: 'health', label: 'Online' },
  ];

  const stageOrder = ['prepare', 'build', 'deploy', 'health'];
  const curIdx = stageOrder.indexOf(currentStage);

  const dotsHtml = stages.map((st, idx) => {
    let cls = 'dot-idle';
    let iconStr = idx + 1;

    if (idx < curIdx) {
      cls = 'dot-done';
      iconStr = '✓';
    } else if (idx === curIdx) {
      if (currentStatus === 'building' || currentStatus === 'running' || currentStatus === 'in_progress') {
        cls = 'dot-active';
        iconStr = '↻';
      } else if (currentStatus === 'success') {
        cls = 'dot-done';
        iconStr = '✓';
      } else if (currentStatus === 'error' || currentStatus === 'failed') {
        cls = 'dot-error';
        iconStr = '✕';
      }
    }

    return `
      <div class="pipeline-step ${cls}">
        <div class="pipeline-dot">${iconStr}</div>
        <span class="pipeline-label">${st.label}</span>
      </div>
    `;
  }).join('<div class="pipeline-pipe"></div>');

  el.innerHTML = `
    <div class="service-pipeline-container">
      <div class="pipeline-stepper-row">${dotsHtml}</div>
      ${detailText ? `<div class="pipeline-detail-text">${escapeHtml(detailText)}</div>` : ''}
    </div>
  `;
}

export function syncServiceCardPipeline(p) {
  const dep = p.deployStatus;
  const isDeploying = dep && (dep.status === 'in_progress' || dep.status === 'building' || dep.status === 'pending');
  const pipeEl = document.getElementById(`service-pipeline-${p.id}`);
  const fluidEl = document.getElementById(`service-fluid-${p.id}`);

  if (isDeploying) {
    if (pipeEl) pipeEl.style.display = 'block';
    renderSingleServicePipeline(p.id, dep.stage || 'prepare', dep.status, dep.message || 'Building service...');
    if (fluidEl) {
      fluidEl.style.display = 'block';
      if (window.renderOrganicFluidPipeline) {
        window.renderOrganicFluidPipeline(`service-fluid-canvas-${p.id}`, dep.stage || 'build', 45, dep.status);
      }
    }
  } else {
    if (pipeEl) pipeEl.style.display = 'none';
    if (fluidEl) fluidEl.style.display = 'none';
  }
}

export function renderServicesList() {
  const container = document.getElementById('services-list');
  if (!container) return;

  const allProjects = state.projects || [];
  const services = allProjects.filter((p) => p.project_kind === 'service');

  const countBadge = document.getElementById('services-count-badge');
  if (countBadge) {
    countBadge.textContent = `${services.length} Total Service${services.length === 1 ? '' : 's'}`;
  }

  const q = (document.getElementById('services-search-input')?.value || '').toLowerCase().trim();
  const filter = state.serviceStatusFilter || 'all';

  const filtered = services.filter((s) => {
    const isOnline = s.status?.appStatus === 'running' || s.status?.running;
    if (filter === 'online' && !isOnline) return false;
    if (filter === 'stopped' && isOnline) return false;
    if (!q) return true;
    return (s.name || '').toLowerCase().includes(q) || (s.slug || '').toLowerCase().includes(q) || (s.start_cmd || '').toLowerCase().includes(q);
  });

  if (!filtered.length) {
    container.innerHTML = `
      <div class="empty-state-card" style="grid-column: 1 / -1; padding: 48px; text-align: center; background: var(--bg-card); border-radius: var(--radius-lg); border: 1px dashed var(--border-subtle);">
        <div style="font-size: 36px; margin-bottom: 12px; opacity: 0.6;">🤖</div>
        <h3 style="margin-bottom: 6px; font-size: 16px;">No backend services found</h3>
        <p style="color: var(--text-muted); font-size: 13px; max-width: 420px; margin: 0 auto 16px;">
          ${q ? 'No services match your search query.' : 'Deploy Discord bots, Lavalink nodes, or queue workers with zero downtime and automatic crash recovery.'}
        </p>
        <button class="btn btn-primary" onclick="openAddServiceModal()">
          ${icon('plus', { size: 14 })} Add Backend Service
        </button>
      </div>
    `;
    return;
  }

  container.innerHTML = filtered.map((s) => {
    const isOnline = s.status?.appStatus === 'running' || s.status?.running;
    const isBuilding = s.deployStatus?.status === 'in_progress' || s.deployStatus?.status === 'building';
    const statusText = isBuilding ? 'BUILDING' : (isOnline ? 'ONLINE' : 'STOPPED');
    const statusBadgeClass = isBuilding ? 'badge-warning' : (isOnline ? 'badge-success' : 'badge-neutral');

    const pt = s.project_type || 'custom';
    let iconName = 'terminal';
    let typeLabel = 'Backend Service';
    if (pt === 'lavalink') {
      iconName = 'coffee';
      typeLabel = 'Audio Daemon';
    } else if (pt === 'python') {
      iconName = 'terminal';
      typeLabel = 'Python Daemon';
    } else if (pt === 'node') {
      iconName = 'layers';
      typeLabel = 'Node.js Daemon';
    } else if (pt === 'discord-node' || pt === 'discord-py') {
      iconName = 'message-square';
      typeLabel = 'Discord Bot';
    } else if (pt === 'telegram-py') {
      iconName = 'send';
      typeLabel = 'Telegram Bot';
    } else if (pt === 'worker-py') {
      iconName = 'cpu';
      typeLabel = 'Queue Worker';
    }

    const sha = s.deployedSha ? s.deployedSha.slice(0, 7).toUpperCase() : (s.repo_url === 'local' ? 'MANUAL' : 'AUTO');
    const portText = s.port ? `PORT ${s.port}` : 'NO PORT';
    const accessText = s.access_mode === 'public' ? 'PUBLIC REVERSE PROXY' : (s.access_mode === 'allowed_ips' ? 'IP WHITELIST' : 'LOCALHOST ONLY');

    return `
      <div class="service-card" id="service-card-${s.id}">
        <div class="service-card-header">
          <div class="service-avatar-box">
            ${icon(iconName, { size: 18 })}
          </div>
          <div class="service-title-col">
            <div class="service-name-row">
              <span class="status-dot ${isOnline ? 'online' : 'offline'}"></span>
              <strong class="service-name">${escapeHtml(s.name)}</strong>
            </div>
            <div class="service-subtitle">
              <span>${typeLabel}</span>
              ${s.slug && s.slug !== s.name.toLowerCase() ? `<span class="service-slug-pill">• ${escapeHtml(s.slug)}</span>` : ''}
            </div>
          </div>
          <div class="service-header-status">
            <span class="badge ${statusBadgeClass}">${statusText}</span>
          </div>
        </div>

        <div class="service-command-preview">
          <code><span class="prompt-sig">$</span> ${escapeHtml(s.start_cmd || './start.sh')}</code>
          ${s.status?.pid ? `<span class="pid-badge">PID ${s.status.pid}</span>` : ''}
        </div>

        <div class="service-meta-chips">
          <span class="meta-chip meta-chip-sha">${sha}</span>
          <span class="meta-chip">${portText}</span>
          <span class="meta-chip meta-chip-access">${accessText}</span>
        </div>

        <div id="service-pipeline-${s.id}" style="display:none; margin: 12px 0 6px 0;"></div>
        <div id="service-fluid-${s.id}" class="organic-fluid-container" style="display:none; margin-bottom: 8px;">
          <canvas id="service-fluid-canvas-${s.id}" class="organic-fluid-canvas" width="400" height="42"></canvas>
        </div>

        <div class="service-actions-row">
          <div class="service-left-actions">
            ${isOnline ? `
              <button class="btn btn-danger btn-sm" onclick="stopProject(${s.id})" title="Stop Service">Stop</button>
              <button class="btn btn-secondary btn-sm" onclick="restartProject(${s.id})" title="Restart Service">Restart</button>
            ` : `
              <button class="btn btn-success btn-sm" onclick="startProject(${s.id})" title="Start Service">Start</button>
            `}
            ${s.repo_url !== 'local' ? `
              <button class="btn btn-secondary btn-sm" onclick="deployProject(${s.id})" title="Deploy Latest Commit">Deploy</button>
            ` : ''}
            <button class="btn btn-secondary btn-sm" onclick="openWebsiteWorkspace(${s.id}, 'files')" title="Manage Files">Files</button>
            <button class="btn btn-secondary btn-sm" onclick="openWebsiteWorkspace(${s.id}, 'logs')" title="Live Console Logs">Logs</button>
            <button class="btn btn-icon btn-sm" onclick="openEditServiceModal(${s.id})" title="Edit Service Settings">${icon('settings', { size: 14 })}</button>
          </div>
          <button class="btn btn-primary btn-sm service-manage-btn" onclick="openWebsiteWorkspace(${s.id}, 'overview')">
            Manage &rarr;
          </button>
        </div>
      </div>
    `;
  }).join('');

  filtered.forEach(syncServiceCardPipeline);
}

// Bind search and status filters
document.getElementById('services-search-input')?.addEventListener('input', renderServicesList);
document.querySelectorAll('#services-status-filters .pill').forEach((btn) => {
  btn.addEventListener('click', () => {
    state.serviceStatusFilter = btn.getAttribute('data-filter') || 'all';
    renderServicesList();
  });
});

window.loadServicesView = loadServicesView;
window.renderServicesList = renderServicesList;
window.renderSingleServicePipeline = renderSingleServicePipeline;
window.syncServiceCardPipeline = syncServiceCardPipeline;
