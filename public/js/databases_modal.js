/**
 * WebDep Database Modals & Connection Subsystem
 * Creation wizard, connection details viewer, logs modal, and network allowlist access dialogs.
 */

import { state, showConfirmDialog, copyTextToClipboard, setBtnLoading } from './state.js';
import { api, toast } from './api.js';

let currentViewedDbId = null;

export function openCreateDatabaseModal() {
  const modal = document.getElementById('modal-create-database');
  if (!modal) return;

  const getPort = window.getNextAvailablePort || ((p) => p);
  const portInput = document.getElementById('db-create-port');
  if (portInput) {
    portInput.value = getPort(5432);
  }

  generateRandomDbPassword('db-create-password');

  const nameEl = document.getElementById('db-create-name');
  if (nameEl) nameEl.value = '';
  const dbNameEl = document.getElementById('db-create-dbname');
  if (dbNameEl) dbNameEl.value = '';
  const userEl = document.getElementById('db-create-user');
  if (userEl) userEl.value = 'app_user';
  const domCreateInput = document.getElementById('db-create-domain');
  if (domCreateInput) domCreateInput.value = '';
  const suEl = document.getElementById('db-create-superuser');
  if (suEl) suEl.checked = false;
  const accessEl = document.getElementById('db-create-access-mode');
  if (accessEl) accessEl.value = 'local';
  const ipsEl = document.getElementById('db-create-allowed-ips');
  if (ipsEl) ipsEl.value = '';
  toggleDatabaseAccessIpFields('db-create-access-mode', 'db-create-allowed-ips-wrap');

  modal.classList.add('active');
}

export function generateRandomDbPassword(targetInputId) {
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

export function togglePasswordVisibility(inputId) {
  const input = document.getElementById(inputId);
  if (!input) return;
  input.type = input.type === 'password' ? 'text' : 'password';
}

export function toggleDatabaseAccessIpFields(selectId, wrapId) {
  const sel = document.getElementById(selectId);
  const wrap = document.getElementById(wrapId);
  if (!sel || !wrap) return;
  wrap.style.display = sel.value === 'allowlist' ? 'block' : 'none';
}

export async function handleCreateDatabaseSubmit(e) {
  e.preventDefault();
  const btn = document.getElementById('db-create-submit-btn');
  const name = document.getElementById('db-create-name')?.value.trim();
  const db_name = document.getElementById('db-create-dbname')?.value.trim();
  const db_user = document.getElementById('db-create-user')?.value.trim();
  const db_password = document.getElementById('db-create-password')?.value.trim();
  const port = Number(document.getElementById('db-create-port')?.value);
  const is_superuser = document.getElementById('db-create-superuser')?.checked;
  const access_mode = document.getElementById('db-create-access-mode')?.value;
  const allowed_ips = document.getElementById('db-create-allowed-ips')?.value.trim();
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

  const renderPipeline = window.renderDatabasePipeline || (() => {});
  renderPipeline('sandbox', 'running', 'Allocating Port & Sandbox');

  const t1 = setTimeout(() => {
    renderPipeline('initdb', 'running', 'Running initdb');
    if (progressBar) progressBar.style.width = '45%';
    if (progressStep) progressStep.textContent = 'Stage 2/5';
    if (progressDetail) progressDetail.textContent = 'Initializing cluster via initdb with SCRAM-SHA-256 credentials...';
  }, 750);

  const t2 = setTimeout(() => {
    renderPipeline('security', 'running', 'Applying HBA Rules');
    if (progressBar) progressBar.style.width = '70%';
    if (progressStep) progressStep.textContent = 'Stage 3/5';
    if (progressDetail) progressDetail.textContent = 'Configuring pg_hba.conf client auth & UFW firewall rules...';
  }, 1600);

  const t3 = setTimeout(() => {
    renderPipeline('spawning', 'running', 'Spawning pg_ctl Engine');
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

    renderPipeline('healthy', 'success', `ONLINE (${created.name.toUpperCase()})`);
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

    if (window.loadDatabases) await window.loadDatabases();
    if (window.renderDatabasesList) window.renderDatabasesList();
  } catch (err) {
    clearTimeout(t1);
    clearTimeout(t2);
    clearTimeout(t3);
    renderPipeline('initdb', 'failed', 'PROVISIONING FAILED');
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

export function showDatabaseDetails(id) {
  const db = (state.databases || []).find((d) => d.id === Number(id));
  if (!db) return;

  const modal = document.getElementById('modal-database-details');
  if (!modal) return;

  const accessMode = db.accessMode || db.access_mode || 'local';
  const title = document.getElementById('db-details-title');
  if (title) title.textContent = `Connection Details — ${db.name}`;
  const intUrl = document.getElementById('db-detail-internal-url');
  if (intUrl) intUrl.value = db.internalUrl || db.internal_url || '';
  const extUrl = document.getElementById('db-detail-external-url');
  if (extUrl) extUrl.value = db.externalUrl || db.external_url || '';
  const nameEl = document.getElementById('db-detail-dbname');
  if (nameEl) nameEl.value = db.dbName || db.db_name || '';
  const userEl = document.getElementById('db-detail-user');
  if (userEl) userEl.value = db.dbUser || db.db_user || '';
  const portEl = document.getElementById('db-detail-port');
  if (portEl) portEl.value = db.port || 5432;
  const passEl = document.getElementById('db-detail-password');
  if (passEl) passEl.value = db.dbPassword || db.db_password || '';
  const psqlEl = document.getElementById('db-detail-psql');
  if (psqlEl) psqlEl.value = db.psqlCommand || db.psql_command || '';

  const extWrap = document.getElementById('db-detail-external-url-wrap');
  if (extWrap) {
    const isLocalOnly = accessMode === 'local' && !db.domain;
    extWrap.style.display = isLocalOnly ? 'none' : 'block';
  }

  modal.classList.add('active');
}

export async function showDatabaseLogs(id) {
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

export async function refreshCurrentDatabaseLogs() {
  if (currentViewedDbId) {
    await showDatabaseLogs(currentViewedDbId);
  }
}

export function copyDatabaseLogs() {
  const pre = document.getElementById('db-logs-content');
  if (pre) {
    void copyTextToClipboard(pre.textContent, 'Database logs copied to clipboard!');
  }
}

export function openDatabaseAccessModal(id) {
  const db = (state.databases || []).find((d) => d.id === Number(id));
  if (!db) return;

  const modal = document.getElementById('modal-database-access');
  if (!modal) return;

  const idEl = document.getElementById('db-access-id');
  if (idEl) idEl.value = db.id;
  const domInput = document.getElementById('db-access-domain');
  if (domInput) domInput.value = db.domain || '';
  const accInput = document.getElementById('db-access-mode');
  if (accInput) accInput.value = db.accessMode || db.access_mode || 'local';
  const ipsInput = document.getElementById('db-access-allowed-ips');
  if (ipsInput) ipsInput.value = db.allowedIps || db.allowed_ips || '';
  toggleDatabaseAccessIpFields('db-access-mode', 'db-access-allowed-ips-wrap');

  modal.classList.add('active');
}

export async function handleUpdateDatabaseAccessSubmit(e) {
  e.preventDefault();
  const id = Number(document.getElementById('db-access-id')?.value);
  const domain = document.getElementById('db-access-domain')?.value.trim() || '';
  const access_mode = document.getElementById('db-access-mode')?.value || 'local';
  const allowed_ips = document.getElementById('db-access-allowed-ips')?.value.trim() || '';

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
    if (window.loadDatabases) await window.loadDatabases();
    if (window.renderDatabasesList) window.renderDatabasesList();
  } catch (err) {
    toast(`Failed to update access: ${err.message}`, 'error');
  }
}

export async function deleteDatabase(id, name) {
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
    if (window.loadDatabases) await window.loadDatabases();
    if (window.renderDatabasesList) window.renderDatabasesList();
  } catch (err) {
    toast(`Failed to delete database: ${err.message}`, 'error');
  }
}

export function copyElementValue(elemId) {
  const el = document.getElementById(elemId);
  if (!el) return;
  void copyTextToClipboard(el.value, 'Copied to clipboard!');
}

// Bind globals for inline HTML event handlers
window.openCreateDatabaseModal = openCreateDatabaseModal;
window.generateRandomDbPassword = generateRandomDbPassword;
window.togglePasswordVisibility = togglePasswordVisibility;
window.toggleDatabaseAccessIpFields = toggleDatabaseAccessIpFields;
window.handleCreateDatabaseSubmit = handleCreateDatabaseSubmit;
window.showDatabaseDetails = showDatabaseDetails;
window.showDatabaseLogs = showDatabaseLogs;
window.refreshCurrentDatabaseLogs = refreshCurrentDatabaseLogs;
window.copyDatabaseLogs = copyDatabaseLogs;
window.openDatabaseAccessModal = openDatabaseAccessModal;
window.handleUpdateDatabaseAccessSubmit = handleUpdateDatabaseAccessSubmit;
window.deleteDatabase = deleteDatabase;
window.copyElementValue = copyElementValue;

