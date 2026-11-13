/**
 * WebDep Managed Databases & Storage Engines Subsystem
 * PostgreSQL provisioning, connection management, status sync, and lifecycle controls.
 */

import { icon } from './icons.js';
import { state, escapeHtml, DB_PIPELINE_STAGES, syncOverviewResourceStatus } from './state.js';
import { api, toast } from './api.js';
import { renderPipelineStages } from './deployments.js';

// Re-export database modals submodule for 100% backward compatibility
export * from './databases_modal.js';
export { DB_PIPELINE_STAGES };

export async function loadDatabases(force = false) {
  if (typeof window.hasAnyPower === 'function' && !window.hasAnyPower(['databases', 'databases_manage'])) {
    state.databases = [];
    const badge = document.getElementById('badge-databases-count');
    if (badge) badge.textContent = 0;
    return;
  }
  try {
    const list = await api('/api/databases', force ? { noCache: true } : {});
    const incoming = Array.isArray(list) ? list : [];
    const pendingSet = state.pendingLifecycleDatabases;
    if (!force && pendingSet && pendingSet.size > 0 && Array.isArray(state.databases)) {
      const prevById = new Map(state.databases.map((d) => [d.id, d]));
      state.databases = incoming.map((d) => {
        if (pendingSet.has(d.id) && prevById.has(d.id)) {
          return { ...d, status: prevById.get(d.id).status };
        }
        return d;
      });
    } else {
      state.databases = incoming;
    }
    for (const d of state.databases) {
      syncOverviewResourceStatus('database', d.id, d.status, d.status === 'running' ? (d.pid ?? null) : null);
    }
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
  const numericId = Number(dbId);
  const targets = [`db-pipeline-track-${dbId}`, `db-pipeline-container-${dbId}`];
  if (
    state.selectedEntityKind === 'database' &&
    Number(state.selectedDatabaseId) === numericId &&
    state.currentView === 'deployments'
  ) {
    targets.push('main-pipeline-track');
  }

  for (const targetId of targets) {
    const el = document.getElementById(targetId);
    if (!el) continue;

    renderPipelineStages(targetId, currentStage, currentStatus, null, DB_PIPELINE_STAGES);

    if (currentStatus === 'success') {
      const subs = el.querySelectorAll('.water-node-sub');
      if (subs && subs.length > 0) {
        subs[subs.length - 1].textContent = 'Online';
      }
    } else if (detailText) {
      const activeSub = el.querySelector('.water-node-vial.active')?.closest('.water-stage-unit')?.querySelector('.water-node-sub');
      if (activeSub) activeSub.textContent = detailText;
    }

    if (targetId === 'main-pipeline-track') {
      const pBadge = document.getElementById('pipeline-status-badge');
      if (pBadge) {
        if (currentStatus === 'success') {
          pBadge.textContent = 'Online (live)';
          pBadge.className = 'badge badge-success';
        } else if (currentStatus === 'failed') {
          pBadge.textContent = detailText || 'Failed';
          pBadge.className = 'badge badge-danger';
        } else if (currentStatus === 'running') {
          pBadge.textContent = detailText || 'Running';
          pBadge.className = 'badge badge-warning';
        } else {
          pBadge.textContent = 'Idle';
          pBadge.className = 'badge badge-neutral';
        }
      }
    }
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
    countBadge.textContent = `${countAll} instance${countAll === 1 ? '' : 's'}`;
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
        ${hasPower('databases_manage') ? '<button class="btn btn-primary" onclick="openCreateDatabaseModal()">Add New Database</button>' : ''}
      </div>
    `;
    return;
  }

  container.innerHTML = filtered.map((d) => {
    const isRunning = d.status === 'running';
    const isStarting = d.status === 'starting';
    const isStopping = d.status === 'stopping';
    const isError = d.status === 'error';

    let statusBadgeCls = 'badge-danger';
    let statusText = 'Stopped';
    if (isRunning) {
      statusBadgeCls = 'badge-success';
      statusText = 'Online';
    } else if (isStarting) {
      statusBadgeCls = 'badge-warning';
      statusText = 'Starting';
    } else if (isStopping) {
      statusBadgeCls = 'badge-warning';
      statusText = 'Stopping';
    } else if (isError) {
      statusBadgeCls = 'badge-danger';
      statusText = 'Error';
    }

    const accessMode = d.accessMode || d.access_mode || 'local';
    let accessLabel = 'Localhost only';
    let accessBadgeCls = 'badge-neutral';
    let accessIconName = 'lock';
    if (accessMode === 'public') {
      accessLabel = 'Public internet';
      accessBadgeCls = 'badge-warning';
      accessIconName = 'globe';
    } else if (accessMode === 'allowlist') {
      accessLabel = 'IP whitelist';
      accessBadgeCls = 'badge-info';
      accessIconName = 'shield';
    }

    const dbName = d.dbName || d.db_name || 'app';
    const dbUser = d.dbUser || d.db_user || 'app_user';
    const hostOrDomain = d.domain ? d.domain : (d.host || '127.0.0.1');
    const psqlCmd = d.psqlCommand || d.psql_command || `psql -h ${hostOrDomain} -p ${d.port || 5432} -U ${dbUser} -d ${dbName}`;
    const resItem = (state.overview?.resources || []).find((x) => (x.databaseId === d.id || x.database_id === d.id));
    const diskStr = d.diskFormatted || d.disk_formatted || resItem?.diskFormatted || resItem?.disk_formatted;
    const pidFromContainer = (d.containerId || d.container_id || '').startsWith('pid-')
      ? Number((d.containerId || d.container_id).slice(4))
      : null;
    const pidVal = isRunning ? (d.pid || resItem?.pid || pidFromContainer || null) : null;
    const subTitle = 'PostgreSQL Cluster';

    return `
      <div class="project-card database-card" id="database-card-${d.id}" style="cursor: pointer;" onclick="openDatabaseWorkspace(${d.id}, 'deployments')">
        <!-- Header -->
        <div class="project-card-header" style="min-height: 40px; display: flex; justify-content: space-between; align-items: center;">
          <div style="display: flex; align-items: center; gap: 12px; min-width: 0;">
            <div class="project-card-icon">
              ${icon('postgres', { size: 28 })}
            </div>
            <div style="min-width: 0;">
              <div class="project-info-title" style="font-size: 15px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">
                <span class="status-dot ${isRunning ? 'online' : (isStarting || isStopping) ? 'maintenance' : 'offline'}" id="db-card-status-dot-${d.id}"></span>
                <span>${escapeHtml(d.name)}</span>
              </div>
              <div style="font-size: 11.5px; color: var(--text-muted); font-family: var(--font-mono); margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 240px;" title="${escapeHtml(subTitle)}">
                ${subTitle}
              </div>
            </div>
          </div>
          <span class="badge ${statusBadgeCls}" id="db-card-status-badge-${d.id}" style="flex-shrink: 0; font-size: 11px; font-weight: 500; padding: 2px 8px;">${statusText}</span>
        </div>

        <!-- Command / Endpoint Line -->
        <div style="background: var(--bg-alt); padding: 6px 12px; border-radius: var(--radius-sm); border: 1px solid var(--border-subtle); font-size: 11.5px; font-family: var(--font-mono); margin: 2px 0 0 0; display: flex; justify-content: space-between; align-items: center; overflow: hidden; height: 34px; box-sizing: border-box;">
          <span style="color: var(--text-dim); text-overflow: ellipsis; white-space: nowrap; overflow: hidden; max-width: 78%;" title="${escapeHtml(psqlCmd)}">
            $ ${escapeHtml(psqlCmd)}
          </span>
          ${pidVal ? `<span class="badge badge-neutral" style="font-size: 9.5px; padding: 1px 6px; flex-shrink: 0;">PID ${pidVal}</span>` : ''}
        </div>

        <!-- Badges & Telemetry Row -->
        <div style="display: flex; align-items: center; flex-wrap: wrap; gap: 6px; min-height: 24px;">
          <span class="badge badge-neutral" style="font-size: 10px; padding: 2px 8px; font-family: var(--font-mono);">Port ${d.port || 5432}</span>
          <span class="badge ${accessBadgeCls}" style="font-size: 10px; padding: 2px 8px;">${icon(accessIconName, { size: 10 })} ${accessLabel}</span>
          ${d.domain ? `<span class="badge badge-primary" style="font-size: 10px; padding: 2px 8px; font-family: var(--font-mono);">${escapeHtml(d.domain)}</span>` : ''}
          ${diskStr ? `<span class="badge badge-neutral" style="font-size: 10px; padding: 2px 8px; font-family: var(--font-mono);" title="On-Disk Storage">${icon('hard-drive', { size: 10 })} ${diskStr}</span>` : ''}
        </div>

        <!-- Actions Footer -->
        <div class="project-card-actions" onclick="event.stopPropagation()" style="display: flex; justify-content: space-between; align-items: center; gap: 8px; width: 100%; margin-top: 2px;">
          <div style="display: flex; gap: 6px; align-items: center; flex-wrap: wrap;">
            ${hasAnyPower(['databases', 'databases_manage']) ? `
              <button class="btn ${isRunning ? 'btn-danger' : 'btn-success'} btn-sm" id="btn-db-toggle-${d.id}" onclick="toggleDatabaseState(${d.id})" ${(isStarting || isStopping) ? 'disabled' : ''} style="padding: 4px 10px; font-size: 11.5px;" title="${isRunning ? 'Stop Database' : 'Start Database'}">
                <span>${isRunning ? 'Stop' : isStarting ? 'Starting' : isStopping ? 'Stopping' : 'Start'}</span>
              </button>
              <button class="btn btn-secondary btn-sm" onclick="openDatabaseWorkspace(${d.id}, 'files')" style="padding: 4px 10px; font-size: 11.5px;" title="Cluster Files (Read-Only)">Files</button>
              <button class="btn btn-secondary btn-sm" onclick="openDatabaseWorkspace(${d.id}, 'logs')" style="padding: 4px 10px; font-size: 11.5px;" title="PostgreSQL Logs">Logs</button>
            ` : ''}
            ${hasAnyPower(['databases_manage', 'env']) ? `<button class="btn btn-secondary btn-sm" onclick="showDatabaseDetails(${d.id})" style="padding: 4px 10px; font-size: 11.5px;" title="Connection Strings &amp; Credentials">Creds</button>` : ''}
          </div>
          <button class="btn btn-primary btn-sm" onclick="openDatabaseWorkspace(${d.id}, 'deployments')" style="padding: 4px 12px; font-size: 11.5px; font-weight: 500; white-space: nowrap; flex-shrink: 0;">
            Manage &rarr;
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

  const cardDot = document.getElementById(`db-card-status-dot-${id}`);
  if (cardDot) {
    cardDot.className = `status-dot ${isRunning ? 'online' : (isStarting || isStopping) ? 'maintenance' : 'offline'}`;
  }

  const cardBadge = document.getElementById(`db-card-status-badge-${id}`);
  if (cardBadge) {
    if (isRunning) {
      cardBadge.textContent = 'Online';
      cardBadge.className = 'badge badge-success';
    } else if (isStarting) {
      cardBadge.textContent = 'Starting';
      cardBadge.className = 'badge badge-warning';
    } else if (isStopping) {
      cardBadge.textContent = 'Stopping';
      cardBadge.className = 'badge badge-warning';
    } else if (isError) {
      cardBadge.textContent = 'Error';
      cardBadge.className = 'badge badge-danger';
    } else {
      cardBadge.textContent = 'Stopped';
      cardBadge.className = 'badge badge-danger';
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
      span.innerHTML = '<span class="btn-spinner"></span> Starting';
      toggleBtn.title = 'Starting Database';
      toggleBtn.className = 'btn btn-secondary btn-sm';
    } else if (isStopping) {
      span.innerHTML = '<span class="btn-spinner"></span> Stopping';
      toggleBtn.title = 'Stopping Database';
      toggleBtn.className = 'btn btn-secondary btn-sm';
    } else {
      span.textContent = 'Start';
      toggleBtn.title = 'Start Database';
      toggleBtn.className = 'btn btn-success btn-sm';
    }
  }

  if (state.selectedEntityKind === 'database' && Number(state.selectedDatabaseId) === Number(id)) {
    state.lastWsBannerSig = null;
    if (typeof window.renderWebsiteWorkspaceHeader === 'function') {
      window.renderWebsiteWorkspaceHeader();
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
  const numId = Number(id);
  const currentDb = (state.databases || []).find((d) => d.id === numId);
  if (!currentDb) return;

  const isCurrentlyRunning = currentDb.status === 'running';
  state.pendingLifecycleDatabases?.add(numId);

  if (!isCurrentlyRunning) {
    currentDb.status = 'starting';
    syncOverviewResourceStatus('database', numId, 'starting');
    syncDatabaseCardState(numId, 'starting');

    const startPromise = api(`/api/databases/${numId}/start`, { method: 'POST', timeoutMs: 25000 });

    renderSingleDatabasePipeline(numId, 'sandbox', 'running', 'Checking port');
    let t1, t2, t3, t4, t5;
    t1 = setTimeout(() => renderSingleDatabasePipeline(numId, 'initdb', 'running', 'Data cluster'), 1400);
    t2 = setTimeout(() => renderSingleDatabasePipeline(numId, 'security', 'running', 'Security rules'), 2800);
    t3 = setTimeout(() => renderSingleDatabasePipeline(numId, 'spawning', 'running', 'Spawning engine'), 4200);

    try {
      const updatedDb = await startPromise;
      const latestDb = (state.databases || []).find((d) => d.id === numId) || currentDb;
      if (updatedDb && updatedDb.id) {
        Object.assign(latestDb, updatedDb);
      }
      latestDb.status = updatedDb?.status || 'running';
      syncOverviewResourceStatus('database', numId, latestDb.status, latestDb.pid ?? null);
      syncDatabaseCardState(numId, latestDb.status);

      t4 = setTimeout(() => {
        renderSingleDatabasePipeline(numId, 'healthy', 'running', 'Verifying health');
      }, 5600);

      t5 = setTimeout(() => {
        const activeDb = (state.databases || []).find((d) => d.id === numId);
        if (activeDb) activeDb.status = 'running';
        syncOverviewResourceStatus('database', numId, 'running');
        syncDatabaseCardState(numId, 'running');
        renderSingleDatabasePipeline(numId, 'healthy', 'success', 'Online (ready)');
        toast(`PostgreSQL database '${(activeDb || latestDb).name || '#' + numId}' is online.`, 'success');
      }, 7000);
    } catch (err) {
      clearTimeout(t1);
      clearTimeout(t2);
      clearTimeout(t3);
      clearTimeout(t4);
      clearTimeout(t5);
      currentDb.status = 'error';
      syncOverviewResourceStatus('database', numId, 'error', null);
      syncDatabaseCardState(numId, 'error');
      renderSingleDatabasePipeline(numId, 'spawning', 'failed', 'Start failed');
      toast(`Failed to start database: ${err.message}`, 'error');
    }
  } else {
    currentDb.status = 'stopping';
    syncOverviewResourceStatus('database', numId, 'stopping');
    syncDatabaseCardState(numId, 'stopping');
    renderSingleDatabasePipeline(numId, 'spawning', 'running', 'Stopping engine');

    try {
      const updatedDb = await api(`/api/databases/${numId}/stop`, { method: 'POST', timeoutMs: 15000 });
      const latestDb = (state.databases || []).find((d) => d.id === numId) || currentDb;
      if (updatedDb && updatedDb.id) {
        Object.assign(latestDb, updatedDb);
      }
      latestDb.status = updatedDb?.status || 'stopped';
      syncOverviewResourceStatus('database', numId, latestDb.status, null);
      syncDatabaseCardState(numId, latestDb.status);
      renderSingleDatabasePipeline(numId, 'sandbox', 'idle', 'Idle');
      toast(`Database '${latestDb.name || '#' + numId}' stopped.`, 'info');
    } catch (err) {
      currentDb.status = 'error';
      syncOverviewResourceStatus('database', numId, 'error', null);
      syncDatabaseCardState(numId, 'error');
      renderSingleDatabasePipeline(numId, 'spawning', 'failed', 'Stop failed');
      toast(`Failed to stop database: ${err.message}`, 'error');
    }
  }

  state.pendingLifecycleDatabases?.delete(numId);
  await loadDatabases(true);
  if (state.currentView === 'databases') {
    renderDatabasesList();
  }
  if (state.selectedEntityKind === 'database' && Number(state.selectedDatabaseId) === numId) {
    state.lastWsBannerSig = null;
    if (typeof window.renderWebsiteWorkspaceHeader === 'function') window.renderWebsiteWorkspaceHeader();
    if (state.currentView === 'deployments' && typeof window.loadDeploymentsView === 'function') {
      void window.loadDeploymentsView();
    }
  }
}

export async function restartDatabase(id) {
  const numId = Number(id);
  const currentDb = (state.databases || []).find((d) => d.id === numId);
  if (!currentDb) return;

  state.pendingLifecycleDatabases?.add(numId);
  currentDb.status = 'starting';
  syncOverviewResourceStatus('database', numId, 'starting');
  syncDatabaseCardState(numId, 'starting');
  renderSingleDatabasePipeline(numId, 'spawning', 'running', 'Restarting engine');

  try {
    const updatedDb = await api(`/api/databases/${numId}/restart`, { method: 'POST', timeoutMs: 25000 });
    const latestDb = (state.databases || []).find((d) => d.id === numId) || currentDb;
    if (updatedDb && updatedDb.id) {
      Object.assign(latestDb, updatedDb);
    }
    latestDb.status = updatedDb?.status || 'running';
    syncOverviewResourceStatus('database', numId, latestDb.status, latestDb.pid ?? null);
    syncDatabaseCardState(numId, latestDb.status);
    toast(`PostgreSQL database '${latestDb.name || '#' + numId}' restarted.`, 'success');
  } catch (err) {
    currentDb.status = 'error';
    syncOverviewResourceStatus('database', numId, 'error', null);
    syncDatabaseCardState(numId, 'error');
    renderSingleDatabasePipeline(numId, 'spawning', 'failed', 'Restart failed');
    toast(`Failed to restart database: ${err.message}`, 'error');
  }

  state.pendingLifecycleDatabases?.delete(numId);
  await loadDatabases(true);
  if (state.currentView === 'databases') {
    renderDatabasesList();
  }
  if (state.selectedEntityKind === 'database' && Number(state.selectedDatabaseId) === numId) {
    state.lastWsBannerSig = null;
    if (typeof window.renderWebsiteWorkspaceHeader === 'function') window.renderWebsiteWorkspaceHeader();
    if (state.currentView === 'deployments' && typeof window.loadDeploymentsView === 'function') {
      void window.loadDeploymentsView();
    }
  }
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
window.restartDatabase = restartDatabase;
