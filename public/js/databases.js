/**
 * WebDep Managed Databases & Storage Engines Subsystem
 * PostgreSQL provisioning, connection management, status sync, and lifecycle controls.
 */

import { icon } from './icons.js';
import { state, escapeHtml } from './state.js';
import { api, toast } from './api.js';

// Re-export database modals submodule for 100% backward compatibility
export * from './databases_modal.js';

export async function loadDatabases() {
  try {
    const list = await api('/api/databases');
    state.databases = Array.isArray(list) ? list : [];
  } catch (err) {
    console.warn('Failed to load databases:', err);
    state.databases = [];
  }
}

export function renderSingleDatabasePipeline(dbId, currentStage, currentStatus, detailText = '') {
  const el = document.getElementById(`db-pipeline-container-${dbId}`);
  if (!el) return;

  const stages = [
    { key: 'sandbox', label: 'Sandbox' },
    { key: 'initdb', label: 'Cluster' },
    { key: 'security', label: 'Security' },
    { key: 'spawning', label: 'Engine' },
    { key: 'healthy', label: 'Online' },
  ];

  const stageOrder = ['sandbox', 'initdb', 'security', 'spawning', 'healthy'];
  const curIdx = stageOrder.indexOf(currentStage);

  const dotsHtml = stages.map((st, idx) => {
    let cls = 'dot-idle';
    let iconStr = idx + 1;

    if (idx < curIdx) {
      cls = 'dot-done';
      iconStr = '✓';
    } else if (idx === curIdx) {
      if (currentStatus === 'running') {
        cls = 'dot-active';
        iconStr = '↻';
      } else if (currentStatus === 'success') {
        cls = 'dot-done';
        iconStr = '✓';
      } else if (currentStatus === 'failed') {
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
  const countBadge = document.getElementById('databases-count-badge');
  if (countBadge) {
    countBadge.textContent = `${list.length} Instance${list.length === 1 ? '' : 's'}`;
  }

  if (!list.length) {
    container.innerHTML = `
      <div style="grid-column: 1 / -1; text-align: center; padding: 48px; background: var(--bg-card); border-radius: var(--radius-lg); border: 1px dashed var(--border-medium);">
        <p style="font-size: 16px; font-weight: 600; margin-bottom: 8px;">No databases found</p>
        <p style="color: var(--text-muted); font-size: 13px; margin-bottom: 20px;">Deploy an isolated PostgreSQL database directly on your VM.</p>
        <button class="btn btn-primary" onclick="openCreateDatabaseModal()">Add New Database</button>
      </div>
    `;
    return;
  }

  container.innerHTML = list.map((d) => {
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

    return `
      <div class="project-card database-card" id="database-card-${d.id}">
        <div class="database-card-header">
          <div class="database-avatar-box">
            ${icon('database', { size: 18 })}
          </div>
          <div class="database-title-col">
            <div class="database-name-row">
              <span class="status-dot ${isRunning ? 'online' : 'offline'}"></span>
              <strong class="database-name">${escapeHtml(d.name)}</strong>
            </div>
            <div class="database-subtitle">
              <span>PostgreSQL Cluster</span>
              <span class="database-port-pill">• :${d.port || 5432}</span>
            </div>
          </div>
          <div class="database-header-status">
            <span class="badge ${statusBadgeCls}" id="db-card-status-badge-${d.id}">${statusText}</span>
          </div>
        </div>

        <div class="database-connection-preview">
          <code><span class="prompt-sig">&rarr;</span> postgresql://${escapeHtml(d.dbUser || d.db_user || 'app_user')}:••••@${escapeHtml(hostOrDomain)}:${d.port || 5432}/${escapeHtml(d.dbName || d.db_name || '')}</code>
          ${d.pid ? `<span class="pid-badge">PID ${d.pid}</span>` : ''}
        </div>

        <div class="database-meta-chips">
          <span class="meta-chip meta-chip-access ${accessBadgeCls}">${accessLabel}</span>
          <span class="meta-chip">DB: ${escapeHtml(d.dbName || d.db_name || 'app')}</span>
          <span class="meta-chip">USER: ${escapeHtml(d.dbUser || d.db_user || 'app_user')}</span>
          ${d.domain ? `<span class="meta-chip meta-chip-sha">${escapeHtml(d.domain)}</span>` : ''}
        </div>

        <div id="db-pipeline-container-${d.id}" style="display:none; margin: 12px 0 6px 0;"></div>

        <div class="database-actions-row">
          <div class="database-left-actions">
            <button class="btn ${isRunning ? 'btn-danger' : 'btn-success'} btn-sm" id="btn-db-toggle-${d.id}" onclick="toggleDatabaseState(${d.id})" title="${isRunning ? 'Stop Database' : 'Start Database'}">
              <span>${isRunning ? 'Stop' : 'Start'}</span>
            </button>
            <button class="btn btn-secondary btn-sm" onclick="showDatabaseDetails(${d.id})" title="Connection Strings & Password">Connection</button>
            <button class="btn btn-secondary btn-sm" onclick="showDatabaseLogs(${d.id})" title="View PostgreSQL Server Logs">Logs</button>
            <button class="btn btn-secondary btn-sm" onclick="openDatabaseAccessModal(${d.id})" title="Network Access & Domain">Access</button>
          </div>
          <button class="btn btn-danger btn-sm btn-icon" onclick="deleteDatabase(${d.id}, '${escapeHtml(d.name)}')" title="Delete Database">
            ${icon('trash', { size: 14 })}
          </button>
        </div>
      </div>
    `;
  }).join('');
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

window.loadDatabases = loadDatabases;
window.loadDatabasesView = loadDatabasesView;
window.renderDatabasesList = renderDatabasesList;
window.renderSingleDatabasePipeline = renderSingleDatabasePipeline;
window.renderDatabasePipeline = renderDatabasePipeline;
window.syncDatabaseCardState = syncDatabaseCardState;
window.toggleDatabaseState = toggleDatabaseState;
