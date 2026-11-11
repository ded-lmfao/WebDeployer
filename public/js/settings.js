/**
 * WebDep Platform Settings, Reverse Proxy & Self-Updater Subsystem
 * Server monitoring, RBAC user administration, Caddy proxy domains, audit logs, and self-updater
 */

import {
  state,
  PAGE_SIZE,
  paginateAndRender,
  escapeHtml,
  formatDate,
  formatRelativeTime,
  openModal,
  closeModal,
  showConfirmDialog,
  showPromptDialog,
  copyTextToClipboard,
  AUDIT_ACTION_META,
  invalidateClientCache,
} from './state.js';
import { api, toast } from './api.js';

// ============================================================================
// View 10: Server Monitoring
// ============================================================================
async function loadMonitorView() {
  try {
    const data = await api('/api/monitor');
    const sys = data.system || {};

    document.getElementById('mon-hostname').textContent = sys.hostname || 'Local Host';
    document.getElementById('mon-platform').textContent = sys.platform || '--';
    document.getElementById('mon-uptime').textContent = formatDuration(sys.uptime);
    document.getElementById('mon-cpu-cores').textContent = `${sys.cpu?.cores || 1} Cores (${sys.cpu?.pct || 0}% used)`;
    document.getElementById('mon-cpu-load').textContent = `Load avg: ${(sys.cpu?.load || []).map((x) => x.toFixed(2)).join(', ')}`;

    // Nginx
    try {
      const ng = await api('/api/nginx/status');
      document.getElementById('mon-nginx-status').textContent = ng.running ? 'Active (Running)' : (ng.installed ? 'Stopped' : 'Not Installed');
      document.getElementById('mon-nginx-status').style.color = ng.running ? 'var(--success)' : 'var(--danger)';
      document.getElementById('mon-nginx-version').textContent = `nginx/${ng.version}`;
    } catch { /* ignore */ }

    // Projects table (scoped to the active website card when inside a website workspace)
    const activeProject = getSelectedProject();
    const monProjects = activeProject
      ? (data.projects || []).filter((p) => p.id === activeProject.id)
      : (data.projects || []);
    const tbody = document.getElementById('monitor-projects-table');
    setHtmlIfChanged(tbody, monProjects.map((p) => {
      const appSt = p.status?.appStatus || (p.status?.running ? 'running' : 'stopped');
      const isOnline = appSt === 'running';
      const isMaint = appSt === 'maintenance';
      return `
      <tr>
        <td><strong>${escapeHtml(p.name)}</strong></td>
        <td>
          <span class="status-dot ${isOnline ? 'online' : isMaint ? 'maintenance' : 'offline'}"></span>
          <span style="font-size:12px; font-weight:600; margin-left:6px; color:${isOnline ? 'var(--success)' : isMaint ? 'var(--warning)' : 'var(--text-muted)'};">${isOnline ? 'Online' : isMaint ? 'Maintenance' : 'Offline'}</span>
        </td>
        <td>${p.status?.uptimeMs ? formatDuration(p.status.uptimeMs / 1000) : '--'}</td>
        <td>${p.deployedSha ? `<span class="sha-pill">${p.deployedSha.slice(0, 7)}</span>` : '--'}</td>
        <td>${p.disk ? `${(p.disk.used / 1048576).toFixed(1)} MB` : '--'}</td>
        <td><span class="badge ${p.deployStatus?.status === 'success' ? 'badge-success' : 'badge-neutral'}">${p.deployStatus?.status || 'idle'}</span></td>
      </tr>
    `;
    }).join(''));
  } catch (err) {
    console.error('Monitor view error:', err);
  }
}

// ============================================================================
// View 11: Settings & Security
// ============================================================================
function renderSecurityStatusSummary() {
  if (!state.user) return;
  const is2fa = Boolean(state.user.totpEnabled);
  const pkCount = Number(state.passkeyCount || (state.passkeysList && state.passkeysList.length) || 0);
  const badge = document.getElementById('settings-2fa-status-badge');
  if (badge) {
    const isProtected = is2fa || pkCount > 0;
    badge.className = `badge ${isProtected ? 'badge-success' : 'badge-warning'}`;
    if (pkCount > 0 && is2fa) {
      badge.textContent = `PASSKEY + 2FA ACTIVE`;
    } else if (pkCount > 0) {
      badge.textContent = `${pkCount} PASSKEY${pkCount === 1 ? '' : 'S'} ACTIVE`;
    } else {
      badge.textContent = is2fa ? '2FA ENABLED' : '2FA NOT ENABLED';
    }
  }
  const unameEl = document.getElementById('settings-sec-username');
  if (unameEl) unameEl.textContent = `${state.user.username} (${state.user.isMainAdmin ? 'Main Admin' : state.user.role})`;

  const pkText = document.getElementById('settings-sec-passkeys-text');
  if (pkText) {
    pkText.textContent = pkCount > 0 ? `${pkCount} Registered (Face ID / Fingerprint)` : 'None Registered';
    pkText.style.color = pkCount > 0 ? 'var(--success-light)' : 'var(--text-dim)';
  }

  const pkModalBadge = document.getElementById('sec-passkey-modal-badge');
  if (pkModalBadge) {
    pkModalBadge.className = `badge ${pkCount > 0 ? 'badge-success' : 'badge-neutral'}`;
    pkModalBadge.textContent = `${pkCount} Registered`;
  }

  const tfaText = document.getElementById('settings-sec-2fa-text');
  if (tfaText) {
    tfaText.textContent = is2fa ? 'Protected (TOTP Active)' : 'Not Enabled';
    tfaText.style.color = is2fa ? 'var(--success-light)' : 'var(--warning-light)';
  }

  const sessText = document.getElementById('settings-sec-sessions');
  const count = state.activeSessions || 1;
  if (sessText) sessText.textContent = `${count} active session${count === 1 ? '' : 's'}`;

  const modalSess = document.getElementById('sec-modal-sessions-summary');
  if (modalSess) modalSess.textContent = `Your account currently has ${count} active authenticated session${count === 1 ? '' : 's'}.`;

  const open2faBtn = document.getElementById('settings-open-2fa-btn');
  if (open2faBtn) open2faBtn.textContent = is2fa ? 'Manage 2FA' : 'Enable 2FA';
}

async function loadSettingsView() {
  renderSecurityStatusSummary();
  loadPasskeysList().catch(() => {});

  const canManagePlatform = hasPower('settings_manage');
  const isMain = Boolean(state.user && state.user.isMainAdmin);
  const globalCard = document.getElementById('settings-global-config-card');
  const usersCard = document.getElementById('settings-users-card');
  const panelCard = document.getElementById('settings-panel-card');
  const updateCard = document.getElementById('settings-update-card');
  if (globalCard) globalCard.style.display = canManagePlatform ? '' : 'none';
  if (usersCard) usersCard.style.display = isMain ? '' : 'none';
  if (panelCard) panelCard.style.display = isMain ? '' : 'none';
  if (updateCard) updateCard.style.display = isMain ? '' : 'none';
  if (isMain) loadSystemVersionInfo(true).catch(() => {});
  if (!canManagePlatform && !isMain) return;

  try {
    const s = await api('/api/settings');
    document.getElementById('setting-min-free-mb').value = s.min_free_mb || 500;
    document.getElementById('setting-default-retention').value = s.default_retention || 10;
    document.getElementById('setting-step-timeout').value = s.step_timeout_s || 900;
    document.getElementById('setting-deploy-timeout').value = s.deploy_timeout_s || 1800;

    const tokBadge = document.getElementById('github-token-status-badge');
    let parsedTokens = [];
    if (s.github_tokens) {
      try {
        parsedTokens = JSON.parse(s.github_tokens);
      } catch (_) {}
    }
    if ((!Array.isArray(parsedTokens) || !parsedTokens.length) && s.github_token) {
      parsedTokens = String(s.github_token)
        .split(/[\n,;]+/)
        .map((t) => t.trim())
        .filter(Boolean)
        .map((token, idx) => ({ label: `Account #${idx + 1}`, token }));
    }
    state.githubTokensDraft = Array.isArray(parsedTokens) && parsedTokens.length
      ? parsedTokens.map((t, i) => ({
          label: t.label || `Account #${i + 1}`,
          token: t.token || '',
          revealed: false,
        }))
      : [{ label: 'Primary Account', token: '', revealed: false }];

    const activeCount = state.githubTokensDraft.filter((t) => (t.token || '').trim().length > 0).length;
    if (activeCount > 0) {
      if (tokBadge) {
        tokBadge.innerHTML = `<span class="badge badge-success">${activeCount} Token${activeCount === 1 ? '' : 's'} Saved (${escapeHtml(s.github_token_masked || 'Configured')})</span>`;
      }
    } else {
      if (tokBadge) tokBadge.innerHTML = '<span class="badge badge-neutral">Not Configured</span>';
    }
    renderGithubTokensRows();

    // Users list
    if (isMain) {
      const users = await api('/api/users');
      state.usersList = users;
      const tbody = document.getElementById('users-table-body');
      const powerLabels = {
        '*': 'All Powers (*)',
        deploy: 'Deploy',
        process: 'Start/Stop',
        logs: 'Logs',
        env: 'Env (.env)',
        domains: 'Domains/SSL',
        backups: 'Backups',
        projects_manage: 'Manage Sites',
        settings_manage: 'Settings/Users',
      };

      paginateAndRender(users, 'users', 'users-pagination', (slice) => {
        tbody.innerHTML = slice.map((u) => {
          const isMain = u.isMainAdmin || u.username.toLowerCase() === 'admin' || u.id === 1;
          const projHtml = (isMain || u.allProjects)
            ? '<span class="badge badge-info">All Websites (*)</span>'
            : (u.allowedProjects && u.allowedProjects.length
                ? u.allowedProjects.map((pid) => {
                    const proj = state.projects.find((p) => p.id === pid);
                    return `<span class="badge badge-neutral" style="margin:2px;">${escapeHtml(proj ? proj.name : `#${pid}`)}</span>`;
                  }).join(' ')
                : '<span class="badge badge-warning">No Websites Assigned</span>');

          const perms = isMain || (u.permissions && u.permissions.includes('*'))
            ? ['*']
            : (u.permissions || []);
          const permsHtml = perms.length
            ? perms.map((p) => `<span class="badge badge-neutral" style="margin:2px; font-size:10px;">${escapeHtml(powerLabels[p] || p)}</span>`).join(' ')
            : '<span style="color:var(--text-dim); font-size:12px;">Read-Only</span>';

          const tfaBadge = u.totpEnabled
            ? '<span class="badge badge-success">2FA ON</span>'
            : '<span class="badge badge-neutral">OFF</span>';

          return `
            <tr>
              <td>
                <strong>${escapeHtml(u.username)}</strong>
                ${isMain ? '<span class="badge badge-info" style="margin-left:6px; font-size:10px;">MAIN ADMIN</span>' : ''}
                ${u.id === state.user.id ? '<span style="color:var(--text-dim); font-size:11px; margin-left:4px;">(You)</span>' : ''}
              </td>
              <td><span class="badge badge-neutral">${escapeHtml((u.role || 'operator').toUpperCase())}</span></td>
              <td>${tfaBadge}</td>
              <td>${projHtml}</td>
              <td style="max-width: 260px;">${permsHtml}</td>
              <td>${u.disabled ? '<span class="badge badge-danger">Disabled</span>' : '<span class="badge badge-success">Active</span>'}</td>
              <td>
                <div style="display:flex; gap:6px; flex-wrap:wrap;">
                  ${!isMain ? `
                    <button class="btn btn-secondary btn-sm" onclick="openEditUserModal(${u.id})">Edit Access</button>
                    <button class="btn btn-secondary btn-sm" onclick="toggleUserDisabled(${u.id}, ${u.disabled ? 0 : 1})">
                      ${u.disabled ? 'Enable' : 'Disable'}
                    </button>
                    ${u.totpEnabled && state.user.isMainAdmin ? `
                      <button class="btn btn-secondary btn-sm" onclick="adminResetUser2fa(${u.id}, '${escapeHtml(u.username)}')">Reset 2FA</button>
                    ` : ''}
                    ${u.id !== state.user.id ? `
                      <button class="btn btn-danger btn-sm" onclick="deleteUser(${u.id}, '${escapeHtml(u.username)}')">Remove</button>
                    ` : ''}
                  ` : '<span style="color:var(--text-dim); font-size:12px;">Full Root Access</span>'}
                </div>
              </td>
            </tr>
          `;
        }).join('');
      });
    }
  } catch (err) {
    toast(`Failed to load settings: ${err.message}`, 'error');
  }
}

function syncGithubTokensDomToDraft() {
  if (!Array.isArray(state.githubTokensDraft)) state.githubTokensDraft = [];
  document.querySelectorAll('#github-tokens-list .gh-token-row').forEach((row) => {
    const idx = Number(row.getAttribute('data-gh-idx'));
    if (!state.githubTokensDraft[idx]) return;
    const lblEl = row.querySelector('.gh-token-label-input');
    const tokEl = row.querySelector('.gh-token-value-input');
    if (lblEl) state.githubTokensDraft[idx].label = lblEl.value;
    if (tokEl) state.githubTokensDraft[idx].token = tokEl.value;
  });
}

function renderGithubTokensRows() {
  const container = document.getElementById('github-tokens-list');
  if (!container) return;
  const list = state.githubTokensDraft || [{ label: 'Primary Account', token: '', revealed: false }];
  container.innerHTML = list.map((item, idx) => `
    <div class="gh-token-row" data-gh-idx="${idx}" style="display: grid; grid-template-columns: 200px 1fr auto auto; gap: 8px; align-items: center;">
      <input type="text" class="form-control gh-token-label-input" value="${escapeHtml(item.label || '')}" placeholder="Account label (e.g. Personal, Org)">
      <input type="${item.revealed ? 'text' : 'password'}" class="form-control env-mono-input gh-token-value-input" value="${escapeHtml(item.token || '')}" placeholder="ghp_... or github_pat_...">
      <button type="button" class="btn btn-secondary btn-sm" onclick="toggleGithubTokenRowReveal(${idx})" style="min-width: 62px;">
        ${item.revealed ? 'Hide' : 'Show'}
      </button>
      <button type="button" class="btn btn-danger btn-sm" onclick="removeGithubTokenRow(${idx})" title="Remove token">&times;</button>
    </div>
  `).join('');
}

function addGithubTokenRow() {
  syncGithubTokensDomToDraft();
  if (!Array.isArray(state.githubTokensDraft)) state.githubTokensDraft = [];
  state.githubTokensDraft.push({
    label: `Account #${state.githubTokensDraft.length + 1}`,
    token: '',
    revealed: false,
  });
  renderGithubTokensRows();
}
window.addGithubTokenRow = addGithubTokenRow;

function removeGithubTokenRow(idx) {
  syncGithubTokensDomToDraft();
  if (!Array.isArray(state.githubTokensDraft)) return;
  state.githubTokensDraft.splice(idx, 1);
  if (state.githubTokensDraft.length === 0) {
    state.githubTokensDraft.push({ label: 'Primary Account', token: '', revealed: false });
  }
  renderGithubTokensRows();
}
window.removeGithubTokenRow = removeGithubTokenRow;

function toggleGithubTokenRowReveal(idx) {
  syncGithubTokensDomToDraft();
  if (state.githubTokensDraft && state.githubTokensDraft[idx]) {
    state.githubTokensDraft[idx].revealed = !state.githubTokensDraft[idx].revealed;
    renderGithubTokensRows();
  }
}
window.toggleGithubTokenRowReveal = toggleGithubTokenRowReveal;

document.getElementById('settings-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  syncGithubTokensDomToDraft();
  const cleanTokens = (state.githubTokensDraft || [])
    .map((t, i) => ({
      label: (t.label || '').trim() || `Account #${i + 1}`,
      token: (t.token || '').trim(),
    }))
    .filter((t) => t.token.length > 0);

  const payload = {
    min_free_mb: Number(document.getElementById('setting-min-free-mb').value) || 500,
    default_retention: Number(document.getElementById('setting-default-retention').value) || 10,
    step_timeout_s: Number(document.getElementById('setting-step-timeout').value) || 900,
    deploy_timeout_s: Number(document.getElementById('setting-deploy-timeout').value) || 1800,
    github_tokens: cleanTokens,
  };

  try {
    await api('/api/settings', { method: 'PUT', body: payload });
    toast(`Global settings & ${cleanTokens.length} GitHub token(s) saved in SQLite!`, 'success');
    await loadSettingsView();
  } catch (err) {
    toast(`Save failed: ${err.message}`, 'error');
  }
});

const ROLE_PRESET_POWERS = {
  admin: ['deploy', 'process', 'logs', 'env', 'domains', 'backups', 'projects_manage', 'settings_manage'],
  operator: ['deploy', 'process', 'logs', 'backups'],
  developer: ['deploy', 'process', 'logs', 'env'],
  viewer: ['logs'],
};

function applyRolePresetToCheckboxes(role) {
  const powers = ROLE_PRESET_POWERS[role];
  if (!powers) return;
  document.querySelectorAll('.user-power-check').forEach((cb) => {
    cb.checked = powers.includes(cb.value);
  });
}

function renderUserProjectsChecklist(selectedIds = [], allProjects = true) {
  const allCheck = document.getElementById('user-all-projects-check');
  const container = document.getElementById('user-projects-checklist');
  if (allCheck) allCheck.checked = allProjects;
  if (!container) return;

  if (!state.projects.length) {
    container.innerHTML = '<div style="color:var(--text-dim); font-size:12px; grid-column: 1 / -1;">No websites created yet.</div>';
    return;
  }

  container.innerHTML = state.projects.map((p) => {
    const checked = allProjects || selectedIds.includes(p.id);
    return `
      <label style="display:flex; align-items:center; gap:8px; font-size:13px; cursor:pointer; opacity:${allProjects ? '0.6' : '1'};">
        <input type="checkbox" class="user-project-check" value="${p.id}" ${checked ? 'checked' : ''} ${allProjects ? 'disabled' : ''}>
        <span>${escapeHtml(p.name)} <code style="font-size:11px;">(:${p.port || 3000})</code></span>
      </label>
    `;
  }).join('');
}

document.getElementById('user-new-role')?.addEventListener('change', (e) => {
  applyRolePresetToCheckboxes(e.target.value);
});

document.getElementById('user-all-projects-check')?.addEventListener('change', (e) => {
  const isAll = e.target.checked;
  const currentSelected = Array.from(document.querySelectorAll('.user-project-check:checked')).map((cb) => Number(cb.value));
  renderUserProjectsChecklist(currentSelected, isAll);
});

document.getElementById('create-user-modal-btn')?.addEventListener('click', () => {
  document.getElementById('create-user-form').reset();
  document.getElementById('user-edit-id').value = '';
  document.getElementById('user-modal-title').textContent = 'Create Platform User';
  document.getElementById('save-new-user-btn').textContent = 'Create User';
  const unameInput = document.getElementById('user-new-username');
  unameInput.disabled = false;
  document.getElementById('user-password-label').textContent = 'Password (min 6 chars) *';
  document.getElementById('user-new-password').placeholder = '••••••••';
  document.getElementById('user-new-role').value = 'operator';
  applyRolePresetToCheckboxes('operator');
  renderUserProjectsChecklist([], true);
  openModal('modal-create-user');
});

function openEditUserModal(userId) {
  const u = (state.usersList || []).find((x) => x.id === userId);
  if (!u) return;

  document.getElementById('create-user-form').reset();
  document.getElementById('user-edit-id').value = String(u.id);
  document.getElementById('user-modal-title').textContent = `Edit Access & Powers: ${u.username}`;
  document.getElementById('save-new-user-btn').textContent = 'Save Access & Powers';

  const unameInput = document.getElementById('user-new-username');
  unameInput.value = u.username;
  unameInput.disabled = true;

  document.getElementById('user-password-label').textContent = 'Reset Password (Optional)';
  document.getElementById('user-new-password').value = '';
  document.getElementById('user-new-password').placeholder = 'Leave blank to keep current password';

  document.getElementById('user-new-role').value = u.role || 'custom';

  const hasWildcard = (u.permissions || []).includes('*');
  document.querySelectorAll('.user-power-check').forEach((cb) => {
    cb.checked = hasWildcard || (u.permissions || []).includes(cb.value);
  });

  renderUserProjectsChecklist(u.allowedProjects || [], Boolean(u.allProjects));
  openModal('modal-create-user');
}
window.openEditUserModal = openEditUserModal;

document.getElementById('save-new-user-btn')?.addEventListener('click', async (e) => {
  e.preventDefault();
  const editId = document.getElementById('user-edit-id').value.trim();
  const username = document.getElementById('user-new-username').value.trim();
  const password = document.getElementById('user-new-password').value;
  const role = document.getElementById('user-new-role').value;
  const permissions = Array.from(document.querySelectorAll('.user-power-check:checked')).map((cb) => cb.value);
  const allProjects = document.getElementById('user-all-projects-check').checked;
  const allowedProjects = allProjects
    ? []
    : Array.from(document.querySelectorAll('.user-project-check:checked')).map((cb) => Number(cb.value));

  if (!editId && (!username || password.length < 6)) {
    toast('Username required and password must be at least 6 characters.', 'warning');
    return;
  }
  if (editId && password && password.length < 6) {
    toast('New password must be at least 6 characters.', 'warning');
    return;
  }

  try {
    if (editId) {
      const body = { role, permissions, allProjects, allowedProjects };
      if (password) body.password = password;
      await api(`/api/users/${editId}`, { method: 'PUT', body });
      toast(`Updated permissions & website access for "${username}".`, 'success');
    } else {
      await api('/api/users', {
        method: 'POST',
        body: { username, password, role, permissions, allProjects, allowedProjects },
      });
      toast(`User "${username}" created in SQLite.`, 'success');
    }
    closeModal('modal-create-user');
    await loadSettingsView();
  } catch (err) {
    toast(`Failed to save user: ${err.message}`, 'error');
  }
});

async function toggleUserDisabled(userId, disabled) {
  try {
    await api(`/api/users/${userId}`, { method: 'PUT', body: { disabled: Boolean(disabled) } });
    toast(disabled ? 'User account disabled.' : 'User account enabled.', 'success');
    await loadSettingsView();
  } catch (err) {
    toast(`Update failed: ${err.message}`, 'error');
  }
}
window.toggleUserDisabled = toggleUserDisabled;

async function deleteUser(userId, username) {
  const ok = await showConfirmDialog({
    title: 'Remove Platform User',
    message: `Are you sure you want to permanently remove user "${username}" and revoke all of their sessions?`,
    confirmText: 'Remove User',
    danger: true,
  });
  if (!ok) return;
  try {
    await api(`/api/users/${userId}`, { method: 'DELETE' });
    toast(`User "${username}" removed from SQLite.`, 'success');
    await loadSettingsView();
  } catch (err) {
    toast(`Delete failed: ${err.message}`, 'error');
  }
}
window.deleteUser = deleteUser;



async function loadAuditView() {
  const tbody = document.getElementById('audit-table-body');
  const titleEl = document.getElementById('audit-view-title');
  const subEl = document.getElementById('audit-view-subtitle');
  const activeProject = getSelectedProject();

  if (titleEl && subEl) {
    if (activeProject) {
      titleEl.textContent = `${activeProject.name} — Activity`;
      subEl.textContent = `Complete timeline of who deployed, started/stopped, edited .env, or took snapshots on ${activeProject.name}`;
    } else {
      titleEl.textContent = 'Website Activity';
      subEl.textContent = 'Select a website to view its complete activity timeline';
    }
  }

  if (!activeProject) {
    if (tbody) tbody.innerHTML = '<tr><td colspan="5" style="text-align: center; padding: 24px;">Select a website first.</td></tr>';
    return;
  }

  try {
    const logs = await api(`/api/audit?projectId=${activeProject.id}&limit=500`);
    state.auditLogs = Array.isArray(logs) ? logs : [];
    renderFilteredAuditLogs();
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="5" style="text-align: center; color: var(--danger); padding: 24px;">${escapeHtml(err.message)}</td></tr>`;
  }
}
window.loadAuditView = loadAuditView;

function renderFilteredAuditLogs() {
  const tbody = document.getElementById('audit-table-body');
  if (!tbody) return;
  const logs = state.auditLogs || [];
  const cat = (document.getElementById('audit-category-filter')?.value || '').toLowerCase();
  const q = (document.getElementById('audit-search-input')?.value || '').toLowerCase();

  const filtered = logs.filter((l) => {
    const action = (l.action || '').toLowerCase();
    if (cat) {
      if (cat === 'website' && !(action.startsWith('website') || action.startsWith('project.create') || action.startsWith('project.update') || action.startsWith('project.delete'))) {
        return false;
      } else if (cat === 'container' && !(action.startsWith('container') || action.startsWith('project.start') || action.startsWith('project.stop') || action.startsWith('project.restart'))) {
        return false;
      } else if (cat !== 'website' && cat !== 'container' && !action.startsWith(cat)) {
        return false;
      }
    }
    if (!q) return true;
    const hay = `${l.actor || ''} ${l.action || ''} ${l.target || ''} ${l.detail || ''} ${l.ip || ''}`.toLowerCase();
    return hay.includes(q);
  });

  if (!filtered.length) {
    tbody.innerHTML = '<tr><td colspan="5" style="text-align: center; padding: 28px; color: var(--text-dim);">No activity records match the current filter.</td></tr>';
    const bar = document.getElementById('audit-pagination');
    if (bar) bar.innerHTML = '';
    return;
  }

  paginateAndRender(filtered, 'audit', 'audit-pagination', (slice) => {
    tbody.innerHTML = slice.map((l) => {
      const actor = l.actor || 'system';
      const initials = actor.slice(0, 2).toUpperCase();
      const meta = AUDIT_ACTION_META[l.action] || { label: l.action, cls: 'badge-neutral' };

      return `
        <tr>
          <td style="white-space: nowrap;">
            <div style="font-size: 12.5px; color: var(--text-main); font-weight: 500;">${formatRelativeTime(l.ts)}</div>
            <div style="font-size: 11px; color: var(--text-dim);">${formatDate(l.ts)}</div>
          </td>
          <td>
            <span class="audit-actor-pill">
              <span class="audit-actor-dot">${escapeHtml(initials)}</span>
              <span>${escapeHtml(actor)}</span>
            </span>
          </td>
          <td>
            <span class="badge ${meta.cls}">${escapeHtml(meta.label)}</span>
          </td>
          <td style="max-width: 440px; white-space: normal; line-height: 1.45; color: var(--text-muted); font-size: 12.5px;">
            ${escapeHtml(l.detail || '--')}
          </td>
          <td><code style="font-size:11px; color:var(--text-dim);">${escapeHtml(l.ip || 'local')}</code></td>
        </tr>
      `;
    }).join('');
  });
}

document.getElementById('audit-search-input')?.addEventListener('input', () => {
  state.pages.audit = 1;
  renderFilteredAuditLogs();
});
document.getElementById('audit-category-filter')?.addEventListener('change', () => {
  state.pages.audit = 1;
  renderFilteredAuditLogs();
});

// ============================================================================
// Caddy & Reverse Proxy Modal
// ============================================================================
let activeNginxProjectId = null;

function renderCaddyModalBanner(p) {
  const banner = document.getElementById('nginx-modal-status-banner');
  if (!banner || !p) return;
  const activeDomains = Array.isArray(p.domains) ? p.domains.filter(Boolean) : [];
  const domainsHtml = activeDomains.length
    ? activeDomains.map((d) => `
        <span style="display:inline-flex; align-items:center; gap:6px; background:rgba(37,99,235,0.16); border:1px solid rgba(59,130,246,0.4); border-radius:5px; padding:2px 8px; margin-right:4px;">
          <a href="https://${escapeHtml(d)}" target="_blank" style="color:#60a5fa; font-family:monospace; font-weight:600; text-decoration:none;">${escapeHtml(d)} &nearr;</a>
          <button type="button" onclick="removeSingleCaddyDomain('${escapeHtml(d)}')" title="Remove domain" style="background:none; border:none; color:#94a3b8; cursor:pointer; font-size:13px; line-height:1; padding:0 2px;">&times;</button>
        </span>
      `).join('')
    : '<code style="color:var(--text-muted); font-weight:600;">Local only (127.0.0.1:' + (p.port || 3000) + ')</code>';

  banner.innerHTML = `
    <div style="background: var(--bg-card); padding: 12px; border-radius: var(--radius-md); font-size: 13px; border: 1px solid var(--border-subtle);">
      <div><strong>Reverse Proxy:</strong> <span class="badge badge-success">Caddy</span> &bull; <code>Port ${p.port || 3000}</code></div>
      <div style="margin-top: 6px; display:flex; align-items:center; flex-wrap:wrap; gap:4px;"><strong>Domains:</strong> ${domainsHtml}</div>
      <div style="margin-top: 6px;"><strong>Automatic HTTPS:</strong> <span class="badge badge-success">Let's Encrypt / ZeroSSL (Active)</span></div>
    </div>
  `;
}

async function openNginxModal(projectId) {
  activeNginxProjectId = projectId;
  const p = state.projects.find((x) => x.id === projectId);
  if (!p) return;

  const domainInput = document.getElementById('caddy-domains-input');
  if (domainInput) {
    domainInput.value = (p.domains || []).join(', ');
    domainInput.onkeydown = (ev) => {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        void saveCaddyDomains();
      }
    };
  }

  const preview = document.getElementById('nginx-config-preview');
  renderCaddyModalBanner(p);
  if (preview) preview.value = 'Generating Caddyfile configuration...';
  openModal('modal-nginx');

  try {
    const data = await api(`/api/projects/${projectId}/caddy`, { noCache: true });
    if (preview && data.config) preview.value = data.config;
    if (Array.isArray(data.domains)) {
      p.domains = data.domains;
      if (domainInput) domainInput.value = data.domains.join(', ');
    }
    renderCaddyModalBanner(p);
  } catch (err) {
    if (preview) preview.value = `Failed to generate configuration: ${err.message}`;
  }
}
window.openNginxModal = openNginxModal;

function cleanDomainList(rawStr) {
  if (!rawStr) return [];
  return rawStr
    .split(/[\n,;]+/)
    .map((s) => s.trim().replace(/^https?:\/\//i, '').split('/')[0].trim().toLowerCase())
    .filter(Boolean);
}

async function removeSingleCaddyDomain(domainToRemove) {
  const p = state.projects.find((x) => x.id === activeNginxProjectId);
  if (!p) return;
  const remaining = (p.domains || []).filter((d) => d !== domainToRemove);
  const input = document.getElementById('caddy-domains-input');
  if (input) input.value = remaining.join(', ');
  await saveCaddyDomains();
}
window.removeSingleCaddyDomain = removeSingleCaddyDomain;

async function saveCaddyDomains() {
  if (!activeNginxProjectId) return;
  const input = document.getElementById('caddy-domains-input');
  const domains = cleanDomainList(input?.value || '');
  if (input) input.value = domains.join(', ');

  const btn = document.getElementById('caddy-save-domains-btn');
  const applyBtn = document.getElementById('nginx-apply-btn');
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Saving...';
  }
  if (applyBtn) {
    applyBtn.disabled = true;
    applyBtn.textContent = 'Applying Caddy...';
  }

  try {
    const res = await api(`/api/projects/${activeNginxProjectId}/caddy/apply`, {
      method: 'POST',
      body: { domains },
    });
    const savedDomains = (res && Array.isArray(res.domains)) ? res.domains : domains;
    const p = state.projects.find((x) => x.id === activeNginxProjectId);
    if (p) {
      p.domains = savedDomains;
      renderCaddyModalBanner(p);
    }
    const preview = document.getElementById('nginx-config-preview');
    if (preview && res && res.config) {
      preview.value = res.config;
    }

    toast(
      savedDomains.length
        ? `Custom domain(s) saved & applied: ${savedDomains.join(', ')}`
        : 'Cleared custom domains (Local-only mode).',
      'success'
    );

    await loadProjects();
    renderWebsiteWorkspaceHeader();
    if (state.currentView === 'projects') renderProjectsList();
    if (state.currentView === 'overview') await loadOverview();
  } catch (err) {
    toast(`Failed to update domains: ${err.message}`, 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Save & Apply';
    }
    if (applyBtn) {
      applyBtn.disabled = false;
      applyBtn.textContent = 'Apply & Reload Caddy';
    }
  }
}
window.saveCaddyDomains = saveCaddyDomains;

document.getElementById('nginx-certbot-btn')?.addEventListener('click', async () => {
  if (!activeNginxProjectId) return;
  toast('Running Let\'s Encrypt Certbot... This may take up to 30 seconds.', 'info');
  try {
    await api(`/api/projects/${activeNginxProjectId}/nginx/certbot`, { method: 'POST' });
    toast('SSL certificate provisioned successfully with Let\'s Encrypt!', 'success');
    await openNginxModal(activeNginxProjectId);
  } catch (err) {
    toast(`Certbot failed: ${err.message}`, 'error');
  }
});


// ============================================================================
// Panel Control (Restart Panel / Clear Server Cache)
// ============================================================================
document.getElementById('restart-panel-btn')?.addEventListener('click', async () => {
  const ok = await showConfirmDialog({
    title: 'Restart WebDep Panel',
    message: 'Restart the panel now? The dashboard will be unavailable for a few seconds. Websites marked running will be resumed automatically.',
    confirmText: 'Restart Panel',
    danger: true,
  });
  if (!ok) return;

  try {
    await api('/api/system/restart', { method: 'POST' });
  } catch (err) {
    toast(`Restart failed: ${err.message}`, 'error');
    return;
  }

  toast('Panel is restarting... reconnecting', 'info', 8000);
  // Wait for the old instance to go down, then poll until the new one answers
  await new Promise((r) => setTimeout(r, 1500));
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch('/healthz', { cache: 'no-store' });
      if (res.ok) {
        window.location.reload();
        return;
      }
    } catch (_) { /* still down */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  toast('Panel did not come back within 60s. Start it manually.', 'error', 10000);
});

document.getElementById('clear-cache-btn')?.addEventListener('click', async () => {
  try {
    await api('/api/cache/clear', { method: 'POST' });
    invalidateClientCache();
    toast('Server and browser caches cleared.', 'success');
  } catch (err) {
    toast(`Failed to clear cache: ${err.message}`, 'error');
  }
});

// ============================================================================
// WebDep Platform 1-Click Self-Update & Git Synchronization
// ============================================================================
let updatePollTimer = null;

async function loadSystemVersionInfo(quiet = false) {
  try {
    const v = await api('/api/system/version');
    const branchEl = document.getElementById('platform-branch-name');
    const hashEl = document.getElementById('platform-commit-hash');
    const msgEl = document.getElementById('platform-commit-msg');
    const remoteBranchEl = document.getElementById('platform-remote-branch');
    const remoteHashEl = document.getElementById('platform-remote-hash');
    const remoteStatusEl = document.getElementById('platform-remote-status-text');
    const badgeEl = document.getElementById('platform-version-badge');
    const updateBtn = document.getElementById('trigger-platform-update-btn');
    const restartBanner = document.getElementById('platform-restart-alert-banner');

    if (branchEl) branchEl.textContent = v.current_branch || 'main';
    if (hashEl) hashEl.textContent = v.current_commit || 'unknown';
    if (msgEl) msgEl.textContent = v.commit_message || 'Self-hosted WebDep deployment platform';
    if (remoteBranchEl) remoteBranchEl.textContent = v.current_branch || 'main';
    if (remoteHashEl) remoteHashEl.textContent = v.remote_commit ? v.remote_commit : 'Up to date';

    if (remoteStatusEl) {
      if (v.has_update) {
        remoteStatusEl.innerHTML = `<span style="color:var(--accent-light); font-weight:600;">Update available (${v.remote_commit})</span>`;
      } else {
        remoteStatusEl.innerHTML = '<span style="color:var(--success); font-weight:600;">Up to date</span>';
      }
    }

    if (badgeEl) {
      if (v.update_in_progress) {
        badgeEl.textContent = '● Update in Progress';
        badgeEl.style.background = 'rgba(234, 179, 8, 0.15)';
        badgeEl.style.color = '#eab308';
      } else if (v.ready_to_restart) {
        badgeEl.textContent = '⚠️ Restart Required';
        badgeEl.style.background = 'rgba(245, 158, 11, 0.15)';
        badgeEl.style.color = '#fbbf24';
      } else if (v.has_update) {
        badgeEl.textContent = `🚀 Update Available (${v.remote_commit})`;
        badgeEl.style.background = 'rgba(16, 185, 129, 0.15)';
        badgeEl.style.color = 'var(--success)';
        if (updateBtn) {
          updateBtn.classList.remove('btn-secondary');
          updateBtn.classList.add('btn-primary');
        }
      } else {
        badgeEl.textContent = '● Up to Date';
        badgeEl.style.background = 'rgba(99, 102, 241, 0.15)';
        badgeEl.style.color = 'var(--accent-light)';
      }
    }
    return v;
  } catch (err) {
    if (!quiet) toast(`Could not load version info: ${err.message}`, 'warning');
    return null;
  }
}
window.loadSystemVersionInfo = loadSystemVersionInfo;

async function checkPlatformUpdates(manual = false) {
  const btn = document.getElementById('check-platform-update-btn');
  if (btn) btn.disabled = true;
  if (manual) toast('Checking remote repository for latest commits...', 'info', 2500);

  const v = await loadSystemVersionInfo(!manual);
  if (btn) btn.disabled = false;

  if (manual && v) {
    if (v.ready_to_restart) {
      toast('A new release is already compiled and waiting! Click Restart Panel to activate it.', 'warning', 6000);
    } else if (v.has_update) {
      toast(`New commit ${v.remote_commit} available on origin/${v.current_branch}! Click Update to apply.`, 'success', 5000);
    } else {
      toast(`WebDep is already up to date with origin/${v.current_branch} (${v.current_commit})`, 'success');
    }
  }
}
window.checkPlatformUpdates = checkPlatformUpdates;

function updatePipelineStepIndicators(progress, isError = false) {
  const dot1 = document.getElementById('step-dot-1');
  const dot2 = document.getElementById('step-dot-2');
  const dot3 = document.getElementById('step-dot-3');
  const dot4 = document.getElementById('step-dot-4');

  const card1 = document.getElementById('step-card-1');
  const card2 = document.getElementById('step-card-2');
  const card3 = document.getElementById('step-card-3');
  const card4 = document.getElementById('step-card-4');

  if (progress >= 10 && dot1) {
    dot1.textContent = '✅';
    if (card1) card1.style.borderColor = 'rgba(16, 185, 129, 0.4)';
  }
  if (progress >= 35 && dot2) {
    dot2.textContent = '✅';
    if (card2) card2.style.borderColor = 'rgba(16, 185, 129, 0.4)';
  }
  if (progress >= 45 && dot3) {
    if (progress >= 95) {
      dot3.textContent = '✅';
      if (card3) card3.style.borderColor = 'rgba(16, 185, 129, 0.4)';
    } else {
      dot3.textContent = '🔄';
      if (card3) card3.style.borderColor = 'var(--accent-light)';
    }
  }
  if (progress >= 100 && dot4) {
    dot4.textContent = isError ? '❌' : '🚀';
    if (card4) card4.style.borderColor = isError ? 'var(--danger)' : 'rgba(16, 185, 129, 0.6)';
  }
}

async function startPlatformUpdate() {
  const v = await loadSystemVersionInfo(true);
  const branchName = v?.current_branch || 'main';

  const ok = await showConfirmDialog({
    title: 'Update WebDep to Latest Commit',
    message: `Fetch latest commits from <strong>origin/${escapeHtml(branchName)}</strong> and recompile WebDep?<br><br>
    &bull; <strong style="color:var(--success);">Safe & Non-Destructive:</strong> Your <code>data/</code> folder (SQLite databases, hosted websites, services, logs) and <code>.env</code> file are completely untouched.<br>
    &bull; <strong style="color:var(--accent-light);">Resource-Safe:</strong> Compiled in low-RAM mode (<code>CARGO_BUILD_JOBS=1</code>) to prevent VPS out-of-memory errors.<br>
    &bull; <strong style="color:var(--text-main);">Zero Unplanned Downtime:</strong> Once compilation finishes, WebDep will pause and ask for your confirmation before restarting.`,
    confirmText: '🚀 Fetch & Compile WebDep',
    danger: false,
  });
  if (!ok) return;

  const stepText = document.getElementById('update-step-text');
  const pctText = document.getElementById('update-pct-text');
  const progressBar = document.getElementById('update-progress-bar');
  const consoleLogs = document.getElementById('update-console-logs');
  const bannerMsg = document.getElementById('update-banner-msg');
  const spinner = document.getElementById('update-active-spinner');
  const statusBanner = document.getElementById('update-status-banner');
  const restartPrompt = document.getElementById('update-restart-prompt');
  const dismissBtn = document.getElementById('update-dismiss-btn');
  const closeBtn = document.getElementById('modal-platform-update-close');

  // Reset steps
  ['1', '2', '3', '4'].forEach((num) => {
    const dot = document.getElementById(`step-dot-${num}`);
    const card = document.getElementById(`step-card-${num}`);
    if (dot) dot.textContent = num === '1' ? '🛡️' : num === '2' ? '🐙' : num === '3' ? '⚙️' : '🚀';
    if (card) card.style.borderColor = 'var(--border)';
  });

  if (stepText) stepText.textContent = 'Initializing update pipeline...';
  if (pctText) pctText.textContent = '5%';
  if (progressBar) {
    progressBar.style.width = '5%';
    progressBar.style.background = 'var(--accent-primary)';
  }
  if (consoleLogs) consoleLogs.textContent = 'Connecting to backend update service...\n';
  if (bannerMsg) bannerMsg.textContent = 'Preserving your databases and environment settings while building the latest release.';
  if (statusBanner) statusBanner.style.display = 'flex';
  if (restartPrompt) restartPrompt.style.display = 'none';
  if (spinner) spinner.style.display = 'block';
  if (dismissBtn) dismissBtn.disabled = true;
  if (closeBtn) closeBtn.style.display = 'none';

  openModal('modal-platform-update');

  try {
    await api('/api/system/update', { method: 'POST', body: { branch: branchName } });
  } catch (err) {
    if (stepText) stepText.textContent = 'Failed to start update';
    if (bannerMsg) bannerMsg.textContent = `Error: ${err.message}`;
    if (spinner) spinner.style.display = 'none';
    if (dismissBtn) dismissBtn.disabled = false;
    if (closeBtn) closeBtn.style.display = 'block';
    toast(`Update could not start: ${err.message}`, 'error');
    return;
  }

  // Poll update progress
  if (updatePollTimer) clearInterval(updatePollTimer);
  updatePollTimer = setInterval(async () => {
    try {
      const st = await api('/api/system/update/status');
      if (stepText) stepText.textContent = st.step || 'Building...';
      if (pctText) pctText.textContent = `${st.progress || 0}%`;
      if (progressBar) progressBar.style.width = `${st.progress || 0}%`;

      updatePipelineStepIndicators(st.progress || 0, st.status === 'error');

      if (consoleLogs && Array.isArray(st.logs)) {
        consoleLogs.textContent = st.logs.join('\n');
        consoleLogs.scrollTop = consoleLogs.scrollHeight;
      }

      if (st.status === 'error') {
        clearInterval(updatePollTimer);
        updatePollTimer = null;
        if (progressBar) progressBar.style.background = 'var(--danger)';
        if (spinner) spinner.style.display = 'none';
        if (bannerMsg) bannerMsg.textContent = `Update halted: ${st.error || 'Review build logs above'}. Previous binary kept intact.`;
        if (dismissBtn) dismissBtn.disabled = false;
        if (closeBtn) closeBtn.style.display = 'block';
        toast('Update failed! Previous version was restored with zero downtime.', 'error', 8000);
      } else if (st.status === 'restarting' || st.status === 'ready_to_restart' || st.status === 'success') {
        clearInterval(updatePollTimer);
        updatePollTimer = null;
        if (stepText) stepText.textContent = 'Update complete! Restarting WebDep panel...';
        if (progressBar) {
          progressBar.style.width = '100%';
          progressBar.style.background = 'var(--success)';
        }
        if (spinner) spinner.style.display = 'block';
        if (bannerMsg) bannerMsg.textContent = 'Restarting WebDep panel now. Reconnecting automatically...';

        pollReconnectionAfterUpdate();
      }
    } catch (_) {
      // transient network poll error
    }
  }, 900);
}
window.startPlatformUpdate = startPlatformUpdate;

async function executePostUpdateRestart() {
  const ok = await showConfirmDialog({
    title: 'Restart WebDep Panel',
    message: 'Restart the WebDep panel now to activate the new version? The dashboard will briefly reconnect in ~3 seconds.',
    confirmText: '🚀 Restart Now',
    danger: false,
  });
  if (!ok) return;

  const stepText = document.getElementById('update-step-text');
  const bannerMsg = document.getElementById('update-banner-msg');
  const statusBanner = document.getElementById('update-status-banner');
  const restartPrompt = document.getElementById('update-restart-prompt');
  const spinner = document.getElementById('update-active-spinner');
  const dismissBtn = document.getElementById('update-dismiss-btn');
  const closeBtn = document.getElementById('modal-platform-update-close');

  openModal('modal-platform-update');
  if (restartPrompt) restartPrompt.style.display = 'none';
  if (statusBanner) statusBanner.style.display = 'flex';
  if (spinner) spinner.style.display = 'block';
  if (stepText) stepText.textContent = 'Restarting WebDep service...';
  if (bannerMsg) bannerMsg.textContent = 'Triggering service restart. Waiting for WebDep to come back online...';
  if (dismissBtn) dismissBtn.disabled = true;
  if (closeBtn) closeBtn.style.display = 'none';

  try {
    await api('/api/system/restart', { method: 'POST' });
  } catch (err) {
    toast(`Restart trigger returned: ${err.message}`, 'info');
  }

  pollReconnectionAfterUpdate();
}
window.executePostUpdateRestart = executePostUpdateRestart;

function copyUpdateLogs() {
  const el = document.getElementById('update-console-logs');
  if (!el) return;
  navigator.clipboard.writeText(el.textContent || '').then(() => {
    toast('Build logs copied to clipboard', 'success');
  }).catch(() => {
    toast('Could not copy logs to clipboard', 'warning');
  });
}
window.copyUpdateLogs = copyUpdateLogs;

async function pollReconnectionAfterUpdate() {
  const stepText = document.getElementById('update-step-text');
  const bannerMsg = document.getElementById('update-banner-msg');
  const progressBar = document.getElementById('update-progress-bar');
  const spinner = document.getElementById('update-active-spinner');

  if (progressBar) {
    progressBar.style.width = '100%';
    progressBar.style.background = 'var(--success)';
  }

  // Wait 2s for the process to exit
  await new Promise((r) => setTimeout(r, 2000));

  for (let attempt = 1; attempt <= 90; attempt++) {
    if (bannerMsg) bannerMsg.textContent = `Probing WebDep service (Attempt ${attempt}/90)...`;
    try {
      const res = await fetch('/healthz', { cache: 'no-store' });
      if (res.ok) {
        if (stepText) stepText.textContent = 'WebDep is back online!';
        if (bannerMsg) bannerMsg.textContent = 'Updated release verified live! Reloading dashboard in 1.5s...';
        if (spinner) spinner.style.display = 'none';
        toast('WebDep updated and restarted successfully!', 'success', 4000);
        setTimeout(() => window.location.reload(), 1500);
        return;
      }
    } catch (_) {
      // Still restarting
    }
    await new Promise((r) => setTimeout(r, 1000));
  }

  if (bannerMsg) bannerMsg.textContent = 'Panel took longer than expected to reconnect. Please refresh your browser or check terminal status: sudo systemctl status webdep';
  const dismissBtn = document.getElementById('update-dismiss-btn');
  if (dismissBtn) dismissBtn.disabled = false;
  const closeBtn = document.getElementById('modal-platform-update-close');
  if (closeBtn) closeBtn.style.display = 'block';
}



window.loadMonitorView = loadMonitorView;
window.loadSettingsView = loadSettingsView;

export {
  loadMonitorView,
  loadSettingsView,
  renderSecurityStatusSummary,
  loadAuditView,
  openNginxModal,
  removeSingleCaddyDomain,
  saveCaddyDomains,
  loadSystemVersionInfo,
  checkPlatformUpdates,
  startPlatformUpdate,
  executePostUpdateRestart,
  copyUpdateLogs,
  pollReconnectionAfterUpdate,
};
