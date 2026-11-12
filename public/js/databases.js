/**
 * WebDep Managed Databases & Storage Engines Subsystem
 * PostgreSQL provisioning, connection management, status sync, and lifecycle controls.
 */

import { icon } from './icons.js';
import { state, escapeHtml } from './state.js';
import { api, toast } from './api.js';
import { renderPipelineStages } from './deployments.js';

// Re-export database modals submodule for 100% backward compatibility
export * from './databases_modal.js';

export const DB_PIPELINE_STAGES = [
  { id: 'sandbox', label: 'Sandbox' },
  { id: 'initdb', label: 'Cluster' },
  { id: 'security', label: 'Security' },
  { id: 'spawning', label: 'Engine' },
  { id: 'healthy', label: 'Online' },
];

export async function loadDatabases() {
  try {
    const list = await api('/api/databases');
    state.databases = Array.isArray(list) ? list : [];
    const badge = document.getElementById('badge-databases-count');
    if (badge) badge.textContent = state.databases.length;
  } catch (err) {
    console.warn('Failed to load databases:', err);
    state.databases = [];
    const badge = document.getElementById('badge-databases-count');
    if (badge) badge.textContent = 0;
  }
}

export function renderSingleDatabasePipeline(dbId, currentStage, currentStatus, detailText = '') {
  const containerId = `db-pipeline-track-${dbId}`;
  let el = document.getElementById(containerId) || document.getElementById(`db-pipeline-container-${dbId}`);
  if (!el) return;
  if (el.id !== containerId) {
    el.id = containerId;
  }

  renderPipelineStages(containerId, currentStage, currentStatus, null, DB_PIPELINE_STAGES);

  if (currentStatus === 'success') {
    const subs = el.querySelectorAll('.water-node-sub');
    if (subs && subs.length > 0) {
      subs[subs.length - 1].textContent = 'Online';
    }
  } else if (detailText) {
    const activeSub = el.querySelector('.water-node-vial.active')?.closest('.water-stage-unit')?.querySelector('.water-node-sub');
    if (activeSub) activeSub.textContent = detailText;
  }
}

export function renderDatabasePipeline(stage, status, detailText = '') {
  renderSingleDatabasePipeline('track', stage, status, detailText);
}

export async function loadDatabasesView() {
  await loadDatabases();
  renderDatabasesList();
}

export function renderDatabasesList() {
  const container = document.getElementById('databases-cards-container') || document.getElementById('databases-list');
  if (!container) return;

  const list = state.databases || [];
  if (!state.databaseStatusFilter) state.databaseStatusFilter = 'all';

  const countAll = list.length;
  const countRunning = list.filter((d) => d.status === 'running').length;
  const countStopped = countAll - countRunning;

  const badge = document.getElementById('badge-databases-count');
  if (badge) {
    badge.textContent = countAll;
  }
  const countBadge = document.getElementById('databases-count-badge');
  if (countBadge) {
    countBadge.textContent = `${countAll} Instance${countAll === 1 ? '' : 's'}`;
  }

  const elAll = document.getElementById('databases-filter-count-all');
  const elRunning = document.getElementById('databases-filter-count-running');
  const elStopped = document.getElementById('databases-filter-count-stopped');
  if (elAll) elAll.textContent = countAll;
  if (elRunning) elRunning.textContent = countRunning;
  if (elStopped) elStopped.textContent = countStopped;

  document.querySelectorAll('#databases-status-filters .pill').forEach((btn) => {
    btn.classList.toggle('active', btn.getAttribute('data-filter') === state.databaseStatusFilter);
  });

  const q = (document.getElementById('databases-search-input')?.value || '').toLowerCase().trim();
  const filter = state.databaseStatusFilter || 'all';

  const filtered = list.filter((d) => {
    const isOnline = d.status === 'running';
    if (filter === 'running' && !isOnline) return false;
    if (filter === 'stopped' && isOnline) return false;
    if (!q) return true;
    return (d.name || '').toLowerCase().includes(q) ||
      (d.domain || '').toLowerCase().includes(q) ||
      (d.host || '').toLowerCase().includes(q) ||
      String(d.port || '').includes(q) ||
      (d.db_name || '').toLowerCase().includes(q) ||
      (d.db_user || '').toLowerCase().includes(q);
  });

  if (!filtered.length) {
    container.innerHTML = `
      <div style="grid-column: 1 / -1; text-align: center; padding: 48px; background: var(--bg-card); border-radius: var(--radius-lg); border: 1px dashed var(--border-medium);">
        <p style="font-size: 16px; font-weight: 600; margin-bottom: 8px;">No databases found</p>
        <p style="color: var(--text-muted); font-size: 13px; margin-bottom: 20px;">
          ${q || filter !== 'all' ? 'No databases match your search or status filter.' : 'Deploy an isolated PostgreSQL database directly on your VM.'}
        </p>
        <button class="btn btn-primary" onclick="openCreateDatabaseModal()">Add New Database</button>
      </div>
    `;
    return;
  }

  container.innerHTML = filtered.map((d) => {
    const isRunning = d.status === 'running';
    const isStarting = d.status === 'starting';
    const isStopping = d.status === 'stopping';
    const isError = d.status === 'error';

    let statusBadgeCls = 'badge-neutral';
    let statusText = 'STOPPED';
    if (isRunning) {
      statusBadgeCls = 'badge-success';
      statusText = 'ONLINE';
    } else if (isStarting) {
      statusBadgeCls = 'badge-warning';
      statusText = 'STARTING';
    } else if (isStopping) {
      statusBadgeCls = 'badge-warning';
      statusText = 'STOPPING';
    } else if (isError) {
      statusBadgeCls = 'badge-danger';
      statusText = 'ERROR';
    }

    const accessMode = d.accessMode || d.access_mode || 'local';
    let accessLabel = 'LOCALHOST ONLY';
    let accessBadgeCls = 'badge-neutral';
    if (accessMode === 'public') {
      accessLabel = 'PUBLIC INTERNET';
      accessBadgeCls = 'badge-warning';
    } else if (accessMode === 'allowlist') {
      accessLabel = 'IP WHITELIST';
      accessBadgeCls = 'badge-info';
    }

    const hostOrDomain = d.domain ? d.domain : (d.host || '127.0.0.1');
    const resItem = (state.overview?.resources || []).find((x) => (x.databaseId === d.id || x.database_id === d.id));
    const diskStr = resItem?.diskFormatted || resItem?.disk_formatted;

    return `
      <div class="project-card database-card" id="database-card-${d.id}">
        <!-- Header -->
        <div class="project-card-header" style="min-height: 40px; display: flex; justify-content: space-between; align-items: center;">
          <div style="display: flex; align-items: center; gap: 11px; min-width: 0;">
            <div class="project-card-icon" style="color: #336791;">
              ${icon('postgres', { size: 28 })}
            </div>
            <div style="min-width: 0;">
              <div class="project-info-title" style="font-size: 15px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">
                <span class="status-dot ${isRunning ? 'online' : 'offline'}"></span>
                <span>${escapeHtml(d.name)}</span>
              </div>
              <div style="font-size: 11.5px; color: var(--text-muted); font-family: var(--font-mono); margin-top: 2px;">
                PostgreSQL Cluster &bull; :${d.port || 5432}
              </div>
            </div>
          </div>
          <div style="display: flex; align-items: center; gap: 6px; flex-shrink: 0;">
            ${d.pid ? `<span class="badge badge-neutral" style="font-size: 9.5px; padding: 1px 6px;">PID ${d.pid}</span>` : ''}
            <span class="badge ${statusBadgeCls}" id="db-card-status-badge-${d.id}" style="font-size: 10.5px; font-weight: 600; padding: 2px 8px;">${statusText}</span>
          </div>
        </div>

        <!-- Lifecycle Pipeline Track (Replaces connection string) -->
        <div class="card-pipeline-track" id="db-pipeline-track-${d.id}" style="background: var(--bg-alt); padding: 8px 10px; border-radius: var(--radius-sm); border: 1px solid var(--border-subtle); margin: 2px 0;"></div>

        <!-- Badges & Telemetry Row -->
        <div style="display: flex; align-items: center; flex-wrap: wrap; gap: 6px; min-height: 24px;">
          <span class="badge ${accessBadgeCls}" style="font-size: 10px;">${icon('lock', { size: 10 })} ${accessLabel}</span>
          <span class="badge badge-neutral" style="font-size: 10px; font-family: var(--font-mono);">DB: ${escapeHtml(d.dbName || d.db_name || 'app')}</span>
          <span class="badge badge-neutral" style="font-size: 10px; font-family: var(--font-mono);">USER: ${escapeHtml(d.dbUser || d.db_user || 'app_user')}</span>
          ${d.domain ? `<span class="badge badge-primary" style="font-size: 10px; font-family: var(--font-mono);">${escapeHtml(d.domain)}</span>` : ''}
          ${diskStr ? `<span class="badge badge-neutral" style="font-size: 10px; padding: 2px 7px; font-family: var(--font-mono);" title="On-Disk Storage">${icon('hard-drive', { size: 10 })} ${diskStr}</span>` : ''}
        </div>

        <!-- Actions Footer -->
        <div class="project-card-actions" onclick="event.stopPropagation()" style="display: flex; justify-content: space-between; align-items: center; width: 100%; margin-top: auto;">
          <div style="display: flex; gap: 6px; align-items: center;">
            <button class="btn ${isRunning ? 'btn-danger' : 'btn-success'} btn-sm" id="btn-db-toggle-${d.id}" onclick="toggleDatabaseState(${d.id})" style="padding: 4px 10px; font-size: 11.5px;" title="${isRunning ? 'Stop Database' : 'Start Database'}">
              <span>${isRunning ? 'Stop' : 'Start'}</span>
            </button>
            <button class="btn btn-secondary btn-sm" onclick="showDatabaseDetails(${d.id})" style="padding: 4px 10px; font-size: 11.5px;" title="Connection Strings & Password">Connection</button>
            <button class="btn btn-secondary btn-sm" onclick="showDatabaseLogs(${d.id})" style="padding: 4px 10px; font-size: 11.5px;" title="View PostgreSQL Server Logs">Logs</button>
            <button class="btn btn-secondary btn-sm" onclick="openDatabaseAccessModal(${d.id})" style="padding: 4px 10px; font-size: 11.5px;" title="Network Access & Domain">Access</button>
          </div>
          <button class="btn btn-danger btn-sm btn-icon" onclick="deleteDatabase(${d.id}, '${escapeHtml(d.name)}')" style="padding: 4px 8px; font-size: 11.5px; display: inline-flex; align-items: center; justify-content: center;" title="Delete Database">
            ${icon('trash', { size: 12 })}
          </button>
        </div>
      </div>
    `;
  }).join('');

  // Synchronize pipelines for all rendered database cards
  filtered.forEach((d) => {
    const isRunning = d.status === 'running';
    const isStarting = d.status === 'starting';
    const isStopping = d.status === 'stopping';
    const isError = d.status === 'error';

    let stage = 'sandbox';
    let status = 'idle';
    let detail = '';

    if (isRunning) {
      stage = 'healthy';
      status = 'success';
      detail = 'Online';
    } else if (isStarting) {
      stage = 'spawning';
      status = 'running';
      detail = 'Starting';
    } else if (isStopping) {
      stage = 'spawning';
      status = 'running';
      detail = 'Stopping';
    } else if (isError) {
      stage = 'spawning';
      status = 'failed';
      detail = 'Error';
    }

    renderSingleDatabasePipeline(d.id, stage, status, detail);
  });
}

export function syncDatabaseCardState(id, status) {
  const isRunning = status === 'running';
  const isStarting = status === 'starting';
  const isStopping = status === 'stopping';
  const isError = status === 'error';

  const cardBadge = document.getElementById(`db-card-status-badge-${id}`);
  if (cardBadge) {
    if (isRunning) {
      cardBadge.textContent = 'RUNNING';
      cardBadge.className = 'badge badge-success';
    } else if (isStarting) {
      cardBadge.textContent = 'STARTING...';
      cardBadge.className = 'badge badge-warning';
    } else if (isStopping) {
      cardBadge.textContent = 'STOPPING...';
      cardBadge.className = 'badge badge-warning';
    } else if (isError) {
      cardBadge.textContent = 'ERROR';
      cardBadge.className = 'badge badge-danger';
    } else {
      cardBadge.textContent = 'STOPPED';
      cardBadge.className = 'badge badge-neutral';
    }
  }

  const toggleBtn = document.getElementById(`btn-db-toggle-${id}`);
  if (toggleBtn) {
    toggleBtn.disabled = isStarting || isStopping;
    const span = toggleBtn.querySelector('span') || toggleBtn;
    if (isRunning) {
      span.textContent = 'Stop';
      toggleBtn.title = 'Stop Database';
      toggleBtn.className = 'btn btn-danger btn-sm';
    } else if (isStarting) {
      span.innerHTML = '<span class="btn-spinner"></span> Starting...';
      toggleBtn.title = 'Starting Database...';
      toggleBtn.className = 'btn btn-secondary btn-sm';
    } else if (isStopping) {
      span.innerHTML = '<span class="btn-spinner"></span> Stopping...';
      toggleBtn.title = 'Stopping Database...';
      toggleBtn.className = 'btn btn-secondary btn-sm';
    } else {
      span.textContent = 'Start';
      toggleBtn.title = 'Start Database';
      toggleBtn.className = 'btn btn-success btn-sm';
    }
  }

  if (isRunning) {
    renderSingleDatabasePipeline(id, 'healthy', 'success', 'Online');
  } else if (isStarting) {
    renderSingleDatabasePipeline(id, 'spawning', 'running', 'Starting');
  } else if (isStopping) {
    renderSingleDatabasePipeline(id, 'spawning', 'running', 'Stopping');
  } else if (isError) {
    renderSingleDatabasePipeline(id, 'spawning', 'failed', 'Error');
  } else {
    renderSingleDatabasePipeline(id, 'sandbox', 'idle', 'Idle');
  }
}

export async function toggleDatabaseState(id) {
  const dbIndex = (state.databases || []).findIndex((d) => d.id === Number(id));
  const currentDb = dbIndex !== -1 ? state.databases[dbIndex] : null;
  if (!currentDb) return;

  const isCurrentlyRunning = currentDb.status === 'running';

  if (!isCurrentlyRunning) {
    currentDb.status = 'starting';
    syncDatabaseCardState(id, 'starting');

    const startPromise = api(`/api/databases/${id}/start`, { method: 'POST', timeoutMs: 25000 });

    renderSingleDatabasePipeline(id, 'sandbox', 'running', 'CHECKING PORT');
    let t1, t2, t3, t4, t5;
    t1 = setTimeout(() => renderSingleDatabasePipeline(id, 'initdb', 'running', 'DATA CLUSTER'), 1400);
    t2 = setTimeout(() => renderSingleDatabasePipeline(id, 'security', 'running', 'SECURITY RULES'), 2800);
    t3 = setTimeout(() => renderSingleDatabasePipeline(id, 'spawning', 'running', 'SPAWNING ENGINE'), 4200);

    try {
      const updatedDb = await startPromise;
      if (updatedDb && updatedDb.id) {
        Object.assign(currentDb, updatedDb);
      }

      t4 = setTimeout(() => {
        renderSingleDatabasePipeline(id, 'healthy', 'running', 'VERIFYING HEALTH');
      }, 5600);

      t5 = setTimeout(() => {
        currentDb.status = 'running';
        syncDatabaseCardState(id, 'running');
        renderSingleDatabasePipeline(id, 'healthy', 'success', 'ONLINE (READY)');
        toast(`PostgreSQL database '${currentDb.name || '#' + id}' is online and ready!`, 'success');
      }, 7000);

    } catch (err) {
      clearTimeout(t1);
      clearTimeout(t2);
      clearTimeout(t3);
      clearTimeout(t4);
      clearTimeout(t5);
      currentDb.status = 'error';
      syncDatabaseCardState(id, 'error');
      renderSingleDatabasePipeline(id, 'spawning', 'failed', 'START FAILED');
      toast(`Failed to start database: ${err.message}`, 'error');
    }
  } else {
    currentDb.status = 'stopping';
    syncDatabaseCardState(id, 'stopping');
    renderSingleDatabasePipeline(id, 'spawning', 'running', 'STOPPING ENGINE');

    try {
      const updatedDb = await api(`/api/databases/${id}/stop`, { method: 'POST', timeoutMs: 15000 });
      if (updatedDb && updatedDb.id) {
        Object.assign(currentDb, updatedDb);
      }

      setTimeout(() => {
        currentDb.status = 'stopped';
        syncDatabaseCardState(id, 'stopped');
        renderSingleDatabasePipeline(id, 'sandbox', 'idle', 'IDLE');
        toast(`Database '${currentDb.name || '#' + id}' stopped successfully!`, 'info');
      }, 1400);

    } catch (err) {
      currentDb.status = 'error';
      syncDatabaseCardState(id, 'error');
      renderSingleDatabasePipeline(id, 'spawning', 'failed', 'STOP FAILED');
      toast(`Failed to stop database: ${err.message}`, 'error');
    }
  }

  await loadDatabases();
}

// Bind search and status filters
document.getElementById('databases-search-input')?.addEventListener('input', renderDatabasesList);
document.querySelectorAll('#databases-status-filters .pill').forEach((btn) => {
  btn.addEventListener('click', () => {
    state.databaseStatusFilter = btn.getAttribute('data-filter') || 'all';
    renderDatabasesList();
  });
});

window.loadDatabases = loadDatabases;
window.loadDatabasesView = loadDatabasesView;
window.renderDatabasesList = renderDatabasesList;
window.renderSingleDatabasePipeline = renderSingleDatabasePipeline;
window.renderDatabasePipeline = renderDatabasePipeline;
window.syncDatabaseCardState = syncDatabaseCardState;
window.toggleDatabaseState = toggleDatabaseState;
