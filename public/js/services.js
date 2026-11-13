/**
 * WebDep Backend Services & Standalone Daemons Subsystem
 * Discord bots, Lavalink audio servers, background python workers, and pipeline status sync.
 */

import { icon } from './icons.js';
import { state, escapeHtml, formatRelativeTime } from './state.js';
import { api, toast } from './api.js';
import { loadProjects } from './websites.js';
import { openWebsiteWorkspace, navigateTo } from './workspace.js';

// Re-export modal submodule so consumers have full backward compatibility
export * from './services_modal.js';

export async function loadServicesView() {
  if (typeof loadProjects === 'function') {
    await loadProjects();
  }
  renderServicesList();
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
      iconStr = icon('check', { size: 12 });
    } else if (idx === curIdx) {
      if (currentStatus === 'building' || currentStatus === 'running' || currentStatus === 'in_progress') {
        cls = 'dot-active';
        iconStr = icon('refresh', { size: 12, cls: 'icon-spin' });
      } else if (currentStatus === 'success') {
        cls = 'dot-done';
        iconStr = icon('check', { size: 12 });
      } else if (currentStatus === 'error' || currentStatus === 'failed') {
        cls = 'dot-error';
        iconStr = icon('x', { size: 12 });
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
    renderSingleServicePipeline(p.id, dep.stage || 'prepare', dep.status, dep.message || 'Building service');
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
  const container = document.getElementById('services-cards-container') || document.getElementById('services-list');
  if (!container) return;

  const allProjects = state.projects || [];
  const services = allProjects.filter((p) => p.project_kind === 'service');

  if (!state.serviceStatusFilter) state.serviceStatusFilter = 'all';

  const countAll = services.length;
  const countRunning = services.filter((p) => p.app_status === 'running' || p.status?.running).length;
  const countStopped = countAll - countRunning;

  const elAll = document.getElementById('services-filter-count-all');
  const elRunning = document.getElementById('services-filter-count-running');
  const elStopped = document.getElementById('services-filter-count-stopped');
  if (elAll) elAll.textContent = countAll;
  if (elRunning) elRunning.textContent = countRunning;
  if (elStopped) elStopped.textContent = countStopped;

  document.querySelectorAll('#services-status-filters .pill').forEach((btn) => {
    btn.classList.toggle('active', btn.getAttribute('data-filter') === state.serviceStatusFilter);
  });

  const q = (document.getElementById('services-search-input')?.value || '').toLowerCase().trim();
  const filter = state.serviceStatusFilter || 'all';

  const filtered = services.filter((s) => {
    const isOnline = s.app_status === 'running' || s.status?.running;
    if (filter === 'running' && !isOnline) return false;
    if (filter === 'stopped' && isOnline) return false;
    if (!q) return true;
    return (s.name || '').toLowerCase().includes(q) ||
      (s.slug || '').toLowerCase().includes(q) ||
      (s.start_cmd || '').toLowerCase().includes(q) ||
      (s.project_type || '').toLowerCase().includes(q);
  });

  if (!filtered.length) {
    container.innerHTML = `
      <div style="grid-column: 1 / -1; text-align: center; padding: 48px; background: var(--bg-card); border-radius: var(--radius-lg); border: 1px dashed var(--border-medium);">
        <p style="font-size: 16px; font-weight: 600; margin-bottom: 8px;">No backend services found</p>
        <p style="color: var(--text-muted); font-size: 13px; margin-bottom: 20px;">
          ${q ? 'No services match your search filter.' : 'Add your first service to deploy it directly to your VM.'}
        </p>
        ${hasPower('services_manage') ? '<button class="btn btn-primary" onclick="openAddServiceModal()">Add New Service</button>' : ''}
      </div>
    `;
    return;
  }

  container.innerHTML = filtered.map((p) => {
    const isOnline = p.app_status === 'running' || p.status?.running;
    const isBuilding = p.deployStatus?.status === 'in_progress' || p.deployStatus?.status === 'building';
    const statusText = isBuilding ? 'Building' : (isOnline ? 'Online' : 'Stopped');
    const statusBadgeClass = isBuilding ? 'badge-warning' : (isOnline ? 'badge-success' : 'badge-neutral');

    const pt = (p.project_type || '').toLowerCase();
    const sc = (p.start_cmd || '').toLowerCase();
    let typeIconName = 'terminal';
    let typeName = 'Backend Service';
    let iconColor = 'var(--text-main)';

    if (pt.includes('lavalink') || sc.includes('lavalink') || sc.includes('.jar') || sc.includes('java')) {
      typeIconName = 'java';
      typeName = 'Java Daemon';
    } else if (pt.includes('python') || sc.includes('python') || sc.includes('.py')) {
      typeIconName = 'python';
      typeName = 'Python Daemon';
    } else if (pt.includes('rust') || sc.includes('cargo') || sc.includes('.rs')) {
      typeIconName = 'rust';
      typeName = 'Rust Daemon';
    } else if (pt.includes('go') || sc.includes('go run') || sc.includes('.go')) {
      typeIconName = 'go';
      typeName = 'Go Daemon';
    } else if (pt.includes('node') || sc.includes('node') || sc.includes('npm') || sc.includes('yarn') || sc.includes('pnpm') || sc.includes('bun')) {
      typeIconName = 'nodejs';
      typeName = 'Node.js Daemon';
    } else if (pt.includes('php') || sc.includes('php')) {
      typeIconName = 'php';
      typeName = 'PHP Daemon';
    } else if (pt.includes('ruby') || sc.includes('ruby') || sc.includes('rails') || sc.includes('puma')) {
      typeIconName = 'ruby';
      typeName = 'Ruby Daemon';
    } else if (pt.includes('docker') || sc.includes('docker')) {
      typeIconName = 'docker';
      typeName = 'Docker Container';
    } else if (pt.includes('worker')) {
      typeIconName = 'cpu';
      typeName = 'Queue Worker';
    }

    const isLocal = !p.repo_url || p.repo_url === 'local' || pt.includes('lavalink');
    const shaText = p.deployed_sha ? p.deployed_sha.slice(0, 7) : (p.deployedSha ? p.deployedSha.slice(0, 7) : (isLocal ? 'Manual' : 'Auto'));
    const portText = p.port ? `Port ${p.port}` : '';
    const accessText = p.access_mode === 'public' ? 'Public reverse proxy' : (p.access_mode === 'allowlist' || p.access_mode === 'allowed_ips' ? 'IP whitelist' : 'Localhost only');
    const resItem = (state.overview?.resources || []).find((x) => (x.projectId === p.id || x.project_id === p.id));
    const diskStr = resItem?.diskFormatted || resItem?.disk_formatted;
    const uptimeText = isOnline && p.app_started_at ? formatRelativeTime(p.app_started_at) : '';
    const pidVal = (isOnline && (p.app_pid || p.status?.pid || resItem?.pid)) ? (p.app_pid || p.status?.pid || resItem?.pid) : null;

    let subTitle = typeName;
    if (p.slug && p.slug !== p.name.toLowerCase()) {
      subTitle = `${typeName} &bull; ${escapeHtml(p.slug)}`;
    } else if (!isLocal && p.branch) {
      subTitle = `${typeName} &bull; ${escapeHtml(p.branch)}`;
    }

    return `
      <div class="project-card service-card" id="service-card-${p.id}" style="cursor: pointer;" onclick="openWebsiteWorkspace(${p.id}, 'deployments')">
        <!-- Header -->
        <div class="project-card-header" style="min-height: 40px; display: flex; justify-content: space-between; align-items: center;">
          <div style="display: flex; align-items: center; gap: 11px; min-width: 0;">
            <div class="project-card-icon" style="color: ${iconColor};">
              ${icon(typeIconName, { size: 28 })}
            </div>
            <div style="min-width: 0;">
              <div class="project-info-title" style="font-size: 15px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">
                <span class="status-dot ${isOnline ? 'online' : 'offline'}"></span>
                <span>${escapeHtml(p.name)}</span>
              </div>
              <div style="font-size: 11.5px; color: var(--text-muted); font-family: var(--font-mono); margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 220px;" title="${escapeHtml(subTitle)}">
                ${subTitle}
              </div>
            </div>
          </div>
          <span class="badge ${statusBadgeClass}" style="flex-shrink: 0; font-size: 11px; font-weight: 500; padding: 2px 8px;">${statusText}</span>
        </div>

        <!-- Command Line -->
        <div style="background: var(--bg-alt); padding: 7px 12px; border-radius: var(--radius-sm); border: 1px solid var(--border-subtle); font-size: 11.5px; font-family: var(--font-mono); margin: 2px 0 0 0; display: flex; justify-content: space-between; align-items: center; overflow: hidden; height: 34px; box-sizing: border-box;">
          <span style="color: var(--text-dim); text-overflow: ellipsis; white-space: nowrap; overflow: hidden; max-width: 78%;" title="${escapeHtml(p.start_cmd || '')}">
            $ ${escapeHtml(p.start_cmd || './start.sh')}
          </span>
          ${pidVal ? `<span class="badge badge-neutral" style="font-size: 9.5px; padding: 1px 6px; flex-shrink: 0;">PID ${pidVal}</span>` : ''}
        </div>

        <!-- Badges & Telemetry Row -->
        <div style="display: flex; align-items: center; flex-wrap: wrap; gap: 6px; min-height: 24px;">
          <span class="badge badge-neutral" style="font-size: 10px; padding: 2px 7px; font-family: var(--font-mono);">
            ${isLocal ? icon('folder', { size: 10 }) + ' ' + shaText : icon('git-branch', { size: 10 }) + ' ' + escapeHtml(shaText)}
          </span>
          ${portText ? `<span class="badge badge-neutral" style="font-size: 10px; font-family: var(--font-mono);">${portText}</span>` : ''}
          <span class="badge badge-neutral" style="font-size: 10px;">${icon('lock', { size: 10 })} ${accessText}</span>
          ${diskStr ? `<span class="badge badge-neutral" style="font-size: 10px; padding: 2px 7px; font-family: var(--font-mono);" title="On-Disk Storage">${icon('hard-drive', { size: 10 })} ${diskStr}</span>` : ''}
          ${uptimeText ? `<span class="badge badge-neutral" style="font-size: 10px; font-family: var(--font-mono);">${icon('clock', { size: 10 })} Started ${uptimeText}</span>` : ''}
        </div>

        <!-- Actions Footer -->
        <div class="project-card-actions" onclick="event.stopPropagation()" style="display: flex; justify-content: space-between; align-items: center; width: 100%; margin-top: 2px;">
          <div style="display: flex; gap: 6px; align-items: center;">
            ${hasPower('process') ? (isOnline
        ? `<button class="btn btn-danger btn-sm" onclick="stopProject(${p.id})" style="padding: 4px 10px; font-size: 11.5px;">Stop</button>`
        : `<button class="btn btn-success btn-sm" onclick="startProject(${p.id})" style="padding: 4px 10px; font-size: 11.5px;">Start</button>`
      ) : ''}
            ${hasAnyPower(['files', 'files_write']) ? `<button class="btn btn-secondary btn-sm" onclick="openWebsiteWorkspace(${p.id}, 'files')" style="padding: 4px 10px; font-size: 11.5px;" title="Manage files">Files</button>` : ''}
            ${hasPower('logs') ? `<button class="btn btn-secondary btn-sm" onclick="openWebsiteWorkspace(${p.id}, 'logs')" style="padding: 4px 10px; font-size: 11.5px;" title="Live console logs">Logs</button>` : ''}
            ${hasPower('services_manage') ? `
              <button class="btn btn-secondary btn-sm" onclick="openEditServiceModal(${p.id})" style="padding: 4px 8px; font-size: 11.5px; display: inline-flex; align-items: center; justify-content: center;" title="Settings">
                ${icon('settings', { size: 12 })}
              </button>
            ` : ''}
          </div>
          <button class="btn btn-primary btn-sm" onclick="openWebsiteWorkspace(${p.id}, 'deployments')" style="padding: 4px 14px; font-size: 11.5px; font-weight: 500; white-space: nowrap; flex-shrink: 0;">
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
