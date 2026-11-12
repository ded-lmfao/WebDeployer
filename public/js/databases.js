/**
 * WebDep Managed PostgreSQL Databases Subsystem
 * Database lifecycle, user credentials, access IP restrictions, backups, and live metrics
 */

import { icon } from './icons.js';
import {
  state,
  PAGE_SIZE,
  paginateAndRender,
  escapeHtml,
  formatRelativeTime,
  openModal,
  closeModal,
  showConfirmDialog,
  copyTextToClipboard,
  setHtmlIfChanged,
  PIPELINE_STAGES,
} from './state.js';
import { api, toast } from './api.js';
import { renderPipelineStages, setBtnLoading } from './deployments.js';

// ============================================================================
// Managed Databases (PostgreSQL)
// ============================================================================
async function loadDatabases() {
  try {
    state.databases = await api('/api/databases');
    const badge = document.getElementById('badge-databases-count');
    if (badge) badge.textContent = state.databases.length;
  } catch (err) {
    console.error('Failed to load databases:', err);
  }
}

// Managed Databases (PostgreSQL) Pipeline Stages (Compact 5-Step Pipeline)
const DB_PIPELINE_STAGES = [
  { id: 'sandbox', label: 'Port' },
  { id: 'initdb', label: 'Cluster' },
  { id: 'security', label: 'Security' },
  { id: 'spawning', label: 'Engine' },
  { id: 'healthy', label: 'Ready' },
];

function renderSingleDatabasePipeline(dbId, currentStage, currentStatus, detailText = '') {
  const containerId = `db-pipeline-track-${dbId}`;
  const container = document.getElementById(containerId);
  const badge = document.getElementById(`db-pipeline-badge-${dbId}`);
  if (!container) return;

  if (badge) {
    if (currentStatus === 'idle') {
      badge.textContent = 'IDLE';
      badge.className = 'badge badge-neutral';
      badge.onclick = null;
      badge.style.cursor = 'default';
    } else if (currentStatus === 'failed') {
      badge.textContent = `FAILED (${currentStage.toUpperCase()}) — Click to View Logs`;
      badge.className = 'badge badge-danger';
      badge.style.cursor = 'pointer';
      badge.onclick = () => showDatabaseLogs(dbId);
    } else if (currentStatus === 'success') {
      badge.textContent = detailText ? detailText.toUpperCase() : 'ONLINE (READY)';
      badge.className = 'badge badge-success';
      badge.onclick = null;
      badge.style.cursor = 'default';
    } else {
      badge.textContent = detailText ? detailText.toUpperCase() : `STARTING (${currentStage.toUpperCase()})`;
      badge.className = 'badge badge-warning';
      badge.onclick = null;
      badge.style.cursor = 'default';
    }
  }

  renderPipelineStages(containerId, currentStage, currentStatus, dbId, DB_PIPELINE_STAGES);
}
window.renderSingleDatabasePipeline = renderSingleDatabasePipeline;
const renderDatabasePipeline = (stage, status, text, id) => {
window.renderDatabasePipeline = renderDatabasePipeline;
  if (id) renderSingleDatabasePipeline(id, stage, status, text);
};

async function loadDatabasesView() {
  await loadDatabases();
  renderDatabasesList();
}
window.loadDatabases = loadDatabases;
window.loadDatabasesView = loadDatabasesView;

function renderDatabasesList() {
  const container = document.getElementById('databases-cards-container');
  if (!container) return;

  if (!state.databases || state.databases.length === 0) {
    setHtmlIfChanged(container, `
      <div class="empty-state" style="grid-column: 1 / -1; padding: 48px 24px; text-align: center; background: var(--surface); border: 1px dashed var(--border); border-radius: var(--radius-lg);">
        <div style="margin-bottom: 12px; color: var(--text-dim);">${icon('database', { size: 40, stroke: 1.5 })}</div>
        <h3 style="font-size: 16px; font-weight: 600; margin-bottom: 6px;">No PostgreSQL Databases Yet</h3>
        <p style="font-size: 13.5px; color: var(--text-muted); max-width: 440px; margin: 0 auto 18px auto; line-height: 1.5;">
          Deploy a fast, isolated PostgreSQL database on this VPS with customized database names, passwords, and remote IP access controls.
        </p>
        <button class="btn btn-primary" onclick="openCreateDatabaseModal()">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
          <span>Create First Database</span>
        </button>
      </div>
    `);
    return;
  }

  setHtmlIfChanged(container, state.databases.map((db) => {
    const isRunning = db.status === 'running';
    const isError = db.status === 'error';
    const statusClass = isRunning ? 'badge-success' : (isError ? 'badge-danger' : 'badge-neutral');
    const statusText = isRunning ? 'RUNNING' : (isError ? 'ERROR' : 'STOPPED');

    const accessMode = db.accessMode || db.access_mode || 'local';
    const allowedIps = db.allowedIps || db.allowed_ips || '';
    const resItem = (state.overview?.resources || []).find((x) => (x.databaseId === db.id || x.database_id === db.id));
    const diskStr = resItem?.diskFormatted || resItem?.disk_formatted;

    let accessBadge = `<span class="badge badge-neutral" style="font-size: 11px;">${icon('lock', { size: 11 })} Localhost Only (127.0.0.1)</span>`;
    if (accessMode === 'allowlist') {
      const ipList = allowedIps ? allowedIps.split(/[,;\n]/).filter(Boolean).length : 0;
      accessBadge = `<span class="badge badge-primary" style="font-size: 11px;">${icon('shield', { size: 11 })} Remote Allowlist (${ipList} IP${ipList === 1 ? '' : 's'})</span>`;
    } else if (accessMode === 'public') {
      accessBadge = `<span class="badge badge-warning" style="font-size: 11px;">${icon('globe', { size: 11 })} Public (0.0.0.0)</span>`;
    }

    return `
      <div class="card project-card" id="db-card-${db.id}" style="display: flex; flex-direction: column; justify-content: space-between; position: relative;">
        <div>
          <div class="project-header" style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 8px;">
            <div style="display: flex; align-items: center; gap: 10px;">
              <div style="width: 36px; height: 36px; border-radius: 8px; background: rgba(51, 103, 145, 0.15); color: #38bdf8; display: flex; align-items: center; justify-content: center;">
                ${icon('database', { size: 20 })}
              </div>
              <div>
                <h3 style="font-size: 15px; font-weight: 600; margin: 0;">${escapeHtml(db.name)}</h3>
                <span style="font-size: 12px; color: var(--text-muted); font-family: var(--font-mono);">${escapeHtml(db.dbName || db.db_name || '')} (${escapeHtml(db.dbUser || db.db_user || '')})</span>
              </div>
            </div>
            <span class="badge ${statusClass}" id="db-card-status-badge-${db.id}">${statusText}</span>
          </div>

          <!-- Per-Database Dedicated Organic Fluid Water Pipeline Track -->
          <div style="margin: 6px 0 10px 0; padding: 8px 10px; background: var(--bg-alt); border-radius: var(--radius-md); border: 1px solid var(--border);">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
              <span style="font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-dim);">Lifecycle Pipeline</span>
              <span class="badge ${isRunning ? 'badge-success' : (isError ? 'badge-danger' : 'badge-neutral')}" id="db-pipeline-badge-${db.id}" style="font-size: 9.5px; padding: 2px 7px;">
                ${isRunning ? 'ONLINE (READY)' : (isError ? 'FAILED — VIEW LOGS' : 'IDLE')}
              </span>
            </div>
            <div class="pipeline-track card-pipeline-track" id="db-pipeline-track-${db.id}" style="min-height: auto;">
              <!-- Rendered with fluid animated water vials and pipes -->
            </div>
          </div>

          <div style="display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 12px;">
            ${accessBadge}
            ${db.domain ? `<span class="badge badge-primary" style="font-size: 11px; font-family: var(--font-mono);">${icon('globe', { size: 11 })} ${escapeHtml(db.domain)}:${db.port}</span>` : `<span class="badge badge-neutral" style="font-size: 11px; font-family: var(--font-mono);">Port ${db.port}</span>`}
            ${db.isSuperuser ? '<span class="badge badge-primary" style="font-size: 11px;">Superuser</span>' : ''}
            ${diskStr ? `<span class="badge badge-neutral" style="font-size: 11px; font-family: var(--font-mono);" title="On-Disk PostgreSQL Storage">${icon('hard-drive', { size: 11 })} ${diskStr}</span>` : ''}
          </div>

          <div style="background: var(--bg-alt); padding: 8px 10px; border-radius: var(--radius-sm); border: 1px solid var(--border); font-size: 11.5px; font-family: var(--font-mono); margin-bottom: 8px; word-break: break-all;">
            <span style="color: var(--text-dim);">Internal:</span> <span style="color: var(--text-main); font-weight: 500;">postgresql://${escapeHtml(db.dbUser || db.db_user || '')}:••••@127.0.0.1:${db.port}/${escapeHtml(db.dbName || db.db_name || '')}</span>
          </div>
          ${(db.domain || accessMode !== 'local') ? `
            <div style="background: var(--bg-alt); padding: 8px 10px; border-radius: var(--radius-sm); border: 1px solid var(--border); font-size: 11.5px; font-family: var(--font-mono); margin-bottom: 14px; word-break: break-all;">
              <span style="color: var(--text-dim);">${db.domain ? 'Domain:' : 'External:'}</span> <span style="color: var(--accent-light); font-weight: 500;">${escapeHtml(db.externalUrl || db.external_url || '')}</span>
            </div>
          ` : '<div style="margin-bottom: 6px;"></div>'}
        </div>

        <div style="display: flex; flex-direction: column; gap: 8px; border-top: 1px solid var(--border); padding-top: 12px; margin-top: 4px;">
          <div style="display: flex; gap: 6px;">
            <button class="btn btn-primary btn-sm" style="flex: 1;" onclick="showDatabaseDetails(${db.id})">
              <span>Details</span>
            </button>
            <button class="btn btn-secondary btn-sm" onclick="showDatabaseLogs(${db.id})" title="View PostgreSQL server output logs">
              <span>Logs</span>
            </button>
            <button class="btn ${isRunning ? 'btn-danger' : 'btn-success'} btn-sm" id="btn-db-toggle-${db.id}" onclick="toggleDatabaseState(${db.id})" title="${isRunning ? 'Stop Database' : 'Start Database'}">
              <span>${isRunning ? 'Stop' : 'Start'}</span>
            </button>
          </div>
          <div style="display: flex; gap: 6px;">
            <button class="btn btn-secondary btn-sm" style="flex: 1;" onclick="openDatabaseAccessModal(${db.id})">
              <span>Access & IPs</span>
            </button>
            <button class="btn btn-danger btn-sm" onclick="deleteDatabase(${db.id}, '${escapeHtml(db.name)}')" title="Delete Database">
              <span>Delete</span>
            </button>
          </div>
        </div>
      </div>
    `;
  }).join(''));

  // Hydrate each card's dedicated water pipeline
  (state.databases || []).forEach((db) => {
    const isRunning = db.status === 'running';
    const isError = db.status === 'error';
    if (isRunning) {
      renderSingleDatabasePipeline(db.id, 'healthy', 'success', 'ONLINE (READY)');
    } else if (isError) {
      renderSingleDatabasePipeline(db.id, 'spawning', 'failed', 'ERROR');
    } else {
      renderSingleDatabasePipeline(db.id, 'sandbox', 'idle');
    }
  });
}
window.renderDatabasesList = renderDatabasesList;

function openCreateDatabaseModal() {
  const modal = document.getElementById('modal-create-database');
  if (!modal) return;

  const portInput = document.getElementById('db-create-port');
  if (portInput) {
    portInput.value = getNextAvailablePort(5432);
  }

  generateRandomDbPassword('db-create-password');

  document.getElementById('db-create-name').value = '';
  document.getElementById('db-create-dbname').value = '';
  document.getElementById('db-create-user').value = 'app_user';
  const domCreateInput = document.getElementById('db-create-domain');
  if (domCreateInput) domCreateInput.value = '';
  document.getElementById('db-create-superuser').checked = false;
  document.getElementById('db-create-access-mode').value = 'local';
  document.getElementById('db-create-allowed-ips').value = '';
  toggleDatabaseAccessIpFields('db-create-access-mode', 'db-create-allowed-ips-wrap');

  modal.classList.add('active');
}
window.openCreateDatabaseModal = openCreateDatabaseModal;

function generateRandomDbPassword(targetInputId) {
  const chars = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!@#$%^&*-_=+';
  const array = new Uint8Array(24);
  window.crypto.getRandomValues(array);
  let pass = '';
  for (let i = 0; i < array.length; i++) {
    pass += chars[array[i] % chars.length];
  }
  const input = document.getElementById(targetInputId);
  if (input) {
    input.value = pass;
    input.type = 'text';
    setTimeout(() => { input.type = 'password'; }, 3000);
  }
}
window.generateRandomDbPassword = generateRandomDbPassword;

function togglePasswordVisibility(inputId) {
  const input = document.getElementById(inputId);
  if (!input) return;
  input.type = input.type === 'password' ? 'text' : 'password';
}
window.togglePasswordVisibility = togglePasswordVisibility;

function toggleDatabaseAccessIpFields(selectId, wrapId) {
  const sel = document.getElementById(selectId);
  const wrap = document.getElementById(wrapId);
  if (!sel || !wrap) return;
  wrap.style.display = sel.value === 'allowlist' ? 'block' : 'none';
}
window.toggleDatabaseAccessIpFields = toggleDatabaseAccessIpFields;

async function handleCreateDatabaseSubmit(e) {
  e.preventDefault();
  const btn = document.getElementById('db-create-submit-btn');
  const name = document.getElementById('db-create-name').value.trim();
  const db_name = document.getElementById('db-create-dbname').value.trim();
  const db_user = document.getElementById('db-create-user').value.trim();
  const db_password = document.getElementById('db-create-password').value.trim();
  const port = Number(document.getElementById('db-create-port').value);
  const is_superuser = document.getElementById('db-create-superuser').checked;
  const access_mode = document.getElementById('db-create-access-mode').value;
  const allowed_ips = document.getElementById('db-create-allowed-ips').value.trim();
  const domain = document.getElementById('db-create-domain')?.value.trim() || null;

  if (access_mode === 'allowlist' && !allowed_ips) {
    toast('Please specify at least one remote IP or CIDR for the allowlist.', 'warning');
    return;
  }

  const progressBox = document.getElementById('db-create-progress-container');
  const progressStep = document.getElementById('db-create-progress-step');
  const progressBar = document.getElementById('db-create-progress-bar');
  const progressDetail = document.getElementById('db-create-progress-detail');

  if (progressBox) {
    progressBox.style.display = 'block';
    if (progressBar) {
      progressBar.className = 'progress-fill green';
      progressBar.style.width = '20%';
    }
    if (progressStep) progressStep.textContent = 'Stage 1/5';
    if (progressDetail) progressDetail.textContent = 'Allocating dedicated TCP port and preparing cluster directory...';
  }

  const pPipe = waterPipelines['database-pipeline-track'];
  if (pPipe) pPipe.currentProgress = 0.0;
  renderDatabasePipeline('sandbox', 'running', 'Allocating Port & Sandbox');

  const t1 = setTimeout(() => {
    renderDatabasePipeline('initdb', 'running', 'Running initdb');
    if (progressBar) progressBar.style.width = '45%';
    if (progressStep) progressStep.textContent = 'Stage 2/5';
    if (progressDetail) progressDetail.textContent = 'Initializing cluster via initdb with SCRAM-SHA-256 credentials...';
  }, 750);

  const t2 = setTimeout(() => {
    renderDatabasePipeline('security', 'running', 'Applying HBA Rules');
    if (progressBar) progressBar.style.width = '70%';
    if (progressStep) progressStep.textContent = 'Stage 3/5';
    if (progressDetail) progressDetail.textContent = 'Configuring pg_hba.conf client auth & UFW firewall rules...';
  }, 1600);

  const t3 = setTimeout(() => {
    renderDatabasePipeline('spawning', 'running', 'Spawning pg_ctl Engine');
    if (progressBar) progressBar.style.width = '90%';
    if (progressStep) progressStep.textContent = 'Stage 4/5';
    if (progressDetail) progressDetail.textContent = 'Spawning isolated PostgreSQL process container via pg_ctl...';
  }, 2500);

  setBtnLoading(btn, true, 'Create & Start Database', 'Provisioning...');
  try {
    const created = await api('/api/databases', {
      method: 'POST',
      timeoutMs: 60000,
      body: {
        name,
        dbName: db_name,
        dbUser: db_user,
        dbPassword: db_password,
        port,
        isSuperuser: is_superuser,
        accessMode: access_mode,
        allowedIps: allowed_ips,
        domain: domain || undefined,
      },
    });

    clearTimeout(t1);
    clearTimeout(t2);
    clearTimeout(t3);

    renderDatabasePipeline('healthy', 'success', `ONLINE (${created.name.toUpperCase()})`);
    if (progressBar) progressBar.style.width = '100%';
    if (progressStep) {
      progressStep.textContent = 'Ready (5/5)';
      progressStep.className = 'badge badge-success';
    }
    if (progressDetail) progressDetail.textContent = `PostgreSQL database '${created.name}' listening on port ${created.port}!`;

    toast(`PostgreSQL database '${created.name}' provisioned and started on port ${created.port}!`, 'success');

    setTimeout(() => {
      document.getElementById('modal-create-database')?.classList.remove('active');
      if (progressBox) progressBox.style.display = 'none';
    }, 700);

    await loadDatabases();
    renderDatabasesList();
  } catch (err) {
    clearTimeout(t1);
    clearTimeout(t2);
    clearTimeout(t3);
    renderDatabasePipeline('initdb', 'failed', 'PROVISIONING FAILED');
    if (progressBar) {
      progressBar.style.width = '100%';
      progressBar.className = 'progress-fill red';
    }
    if (progressStep) {
      progressStep.textContent = 'Failed';
      progressStep.className = 'badge badge-danger';
    }
    if (progressDetail) progressDetail.textContent = `Error: ${err.message}`;
    toast(`Database creation failed: ${err.message}`, 'error');
  } finally {
    setBtnLoading(btn, false, 'Create & Start Database');
  }
}
window.handleCreateDatabaseSubmit = handleCreateDatabaseSubmit;

function showDatabaseDetails(id) {
  const db = (state.databases || []).find((d) => d.id === Number(id));
  if (!db) return;

  const modal = document.getElementById('modal-database-details');
  if (!modal) return;

  const accessMode = db.accessMode || db.access_mode || 'local';
  document.getElementById('db-details-title').textContent = `Connection Details — ${db.name}`;
  document.getElementById('db-detail-internal-url').value = db.internalUrl || db.internal_url || '';
  document.getElementById('db-detail-external-url').value = db.externalUrl || db.external_url || '';
  document.getElementById('db-detail-dbname').value = db.dbName || db.db_name || '';
  document.getElementById('db-detail-user').value = db.dbUser || db.db_user || '';
  document.getElementById('db-detail-port').value = db.port || 5432;
  document.getElementById('db-detail-password').value = db.dbPassword || db.db_password || '';
  document.getElementById('db-detail-psql').value = db.psqlCommand || db.psql_command || '';

  const extWrap = document.getElementById('db-detail-external-url-wrap');
  if (extWrap) {
    const isLocalOnly = accessMode === 'local' && !db.domain;
    extWrap.style.display = isLocalOnly ? 'none' : 'block';
  }

  modal.classList.add('active');
}
window.showDatabaseDetails = showDatabaseDetails;

let currentViewedDbId = null;

async function showDatabaseLogs(id) {
  currentViewedDbId = id;
  const modal = document.getElementById('modal-database-logs');
  const title = document.getElementById('db-logs-title');
  const badge = document.getElementById('db-logs-badge');
  const pre = document.getElementById('db-logs-content');
  if (!modal || !pre) return;

  const db = (state.databases || []).find((d) => d.id === Number(id));
  if (title) title.textContent = db ? `${db.name} — Server Logs` : `Database #${id} Logs`;
  if (badge) {
    badge.textContent = db ? db.status.toUpperCase() : 'LOGS';
    badge.className = db?.status === 'running' ? 'badge badge-success' : (db?.status === 'error' ? 'badge badge-danger' : 'badge badge-neutral');
  }

  pre.textContent = 'Loading PostgreSQL server logs...';
  modal.classList.add('active');

  try {
    const data = await api(`/api/databases/${id}/logs`, { noCache: true });
    pre.textContent = data.logs || 'Log file is empty.';
    pre.scrollTop = pre.scrollHeight;
  } catch (err) {
    pre.textContent = `Failed to load logs: ${err.message}`;
  }
}
window.showDatabaseLogs = showDatabaseLogs;

async function refreshCurrentDatabaseLogs() {
  if (currentViewedDbId) {
    await showDatabaseLogs(currentViewedDbId);
  }
}
window.refreshCurrentDatabaseLogs = refreshCurrentDatabaseLogs;

function copyDatabaseLogs() {
  const pre = document.getElementById('db-logs-content');
  if (pre) {
    copyTextToClipboard(pre.textContent, 'Database logs copied to clipboard!');
  }
}
window.copyDatabaseLogs = copyDatabaseLogs;

function syncDatabaseCardState(id, status) {
  const isRunning = status === 'running';
  const isStarting = status === 'starting';
  const isStopping = status === 'stopping';
  const isError = status === 'error';

  // 1. Card Status Badge
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

  // 2. Toggle Start/Stop Button
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
window.syncDatabaseCardState = syncDatabaseCardState;

async function toggleDatabaseState(id) {
  const dbIndex = (state.databases || []).findIndex((d) => d.id === Number(id));
  const currentDb = dbIndex !== -1 ? state.databases[dbIndex] : null;
  if (!currentDb) return;

  const isCurrentlyRunning = currentDb.status === 'running';

  if (!isCurrentlyRunning) {
    // STARTING FLOW
    currentDb.status = 'starting';
    syncDatabaseCardState(id, 'starting');

    const trackId = `db-pipeline-track-${id}`;
    if (waterPipelines[trackId]) {
      waterPipelines[trackId].currentProgress = 0.0;
    }
    // Launch backend start in background
    const startPromise = api(`/api/databases/${id}/start`, { method: 'POST', timeoutMs: 25000 });

    // Smooth, organic 5-stage fluid progression (~1400ms per stage, ~7s total)
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

      // Smooth step through verifying health to complete online ready
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
    // STOPPING FLOW
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
window.toggleDatabaseState = toggleDatabaseState;

function openDatabaseAccessModal(id) {
  const db = (state.databases || []).find((d) => d.id === Number(id));
  if (!db) return;

  const modal = document.getElementById('modal-database-access');
  if (!modal) return;

  document.getElementById('db-access-id').value = db.id;
  const domInput = document.getElementById('db-access-domain');
  if (domInput) domInput.value = db.domain || '';
  document.getElementById('db-access-mode').value = db.accessMode || db.access_mode || 'local';
  document.getElementById('db-access-allowed-ips').value = db.allowedIps || db.allowed_ips || '';
  toggleDatabaseAccessIpFields('db-access-mode', 'db-access-allowed-ips-wrap');

  modal.classList.add('active');
}
window.openDatabaseAccessModal = openDatabaseAccessModal;

async function handleUpdateDatabaseAccessSubmit(e) {
  e.preventDefault();
  const id = Number(document.getElementById('db-access-id').value);
  const domain = document.getElementById('db-access-domain')?.value.trim() || '';
  const access_mode = document.getElementById('db-access-mode').value;
  const allowed_ips = document.getElementById('db-access-allowed-ips').value.trim();

  try {
    await api(`/api/databases/${id}/access`, {
      method: 'PUT',
      body: {
        accessMode: access_mode,
        allowedIps: allowed_ips,
        domain: domain,
      },
    });
    toast('Network access and domain settings updated successfully!', 'success');
    document.getElementById('modal-database-access')?.classList.remove('active');
    await loadDatabases();
    renderDatabasesList();
  } catch (err) {
    toast(`Failed to update access: ${err.message}`, 'error');
  }
}
window.handleUpdateDatabaseAccessSubmit = handleUpdateDatabaseAccessSubmit;

async function deleteDatabase(id, name) {
  const ok = await showConfirmDialog({
    title: 'Delete PostgreSQL Database',
    message: `Are you sure you want to delete database '${name}' (#${id})?\n\nThis will stop and remove its container, delete all its physical data on disk, and revoke associated firewall rules. This action CANNOT be undone!`,
    confirmText: 'Delete Database',
    danger: true,
  });
  if (!ok) return;

  try {
    toast(`Deleting database '${name}'...`, 'info');
    await api(`/api/databases/${id}`, { method: 'DELETE' });
    toast(`Database '${name}' deleted successfully!`, 'success');
    await loadDatabases();
    renderDatabasesList();
  } catch (err) {
    toast(`Failed to delete database: ${err.message}`, 'error');
  }
}
window.deleteDatabase = deleteDatabase;

function copyElementValue(elemId) {
  const el = document.getElementById(elemId);
  if (!el) return;
  copyTextToClipboard(el.value, 'Copied to clipboard!');
}
window.copyElementValue = copyElementValue;



export {
  loadDatabases,
  loadDatabasesView,
  renderDatabasesList,
  openCreateDatabaseModal,
  generateRandomDbPassword,
  togglePasswordVisibility,
  toggleDatabaseAccessIpFields,
  handleCreateDatabaseSubmit,
  showDatabaseDetails,
  showDatabaseLogs,
  refreshCurrentDatabaseLogs,
  copyDatabaseLogs,
  syncDatabaseCardState,
  toggleDatabaseState,
  openDatabaseAccessModal,
  handleUpdateDatabaseAccessSubmit,
  deleteDatabase,
  renderSingleDatabasePipeline,
  renderDatabasePipeline,
};
