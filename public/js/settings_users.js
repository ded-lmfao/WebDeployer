/**
 * WebDep User Administration, RBAC & Access Control Subsystem
 * Handles user creation, role assignment, project permissions, and GitHub personal access token vault.
 */

import {
  state,
  paginateAndRender,
  escapeHtml,
  openModal,
  closeModal,
  showConfirmDialog,
} from './state.js';
import { api, toast } from './api.js';

export const POWER_LABELS = {
  '*': 'All powers (*)',
  deploy: 'Deploy',
  process: 'Start/stop',
  logs: 'Logs',
  files: 'Files (read)',
  files_write: 'Files (write)',
  env: 'Env (.env)',
  domains: 'Domains/SSL',
  backups: 'Backups',
  projects_manage: 'Manage sites',
  services_manage: 'Manage services',
  databases: 'Databases (ctrl)',
  databases_manage: 'Manage DBs',
  audit: 'Audit logs',
  monitor: 'Telemetry',
  settings_manage: 'Settings/cache',
  system_manage: 'System/update',
};

const POWER_PRESETS = {
  all: null,
  defaults: ['deploy', 'process', 'logs', 'files', 'backups'],
  readonly: ['logs', 'files', 'audit', 'monitor', 'databases'],
  none: [],
};

export function setUserPowerPreset(preset) {
  const list = POWER_PRESETS[preset];
  document.querySelectorAll('.user-power-check').forEach((cb) => {
    cb.checked = list === null ? true : list.includes(cb.value);
  });
}

// ============================================================================
// GitHub Deployment Tokens Multi-Account Management
// ============================================================================
export function syncGithubTokensDomToDraft() {
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

export function renderGithubTokensRows() {
  const container = document.getElementById('github-tokens-list');
  if (!container) return;
  const list = state.githubTokensDraft || [{ label: 'Primary Account', token: '', revealed: false }];
  container.innerHTML = list.map((item, idx) => `
    <div class="gh-token-row" data-gh-idx="${idx}" style="display: grid; grid-template-columns: 200px 1fr auto auto; gap: 8px; align-items: center;">
      <input type="text" class="form-control gh-token-label-input" value="${escapeHtml(item.label || '')}" placeholder="Account label (e.g. Personal, Org)">
      <input type="${item.revealed ? 'text' : 'password'}" class="form-control env-mono-input gh-token-value-input" value="${escapeHtml(item.token || '')}" placeholder="ghp_token or github_pat_token">
      <button type="button" class="btn btn-secondary btn-sm" onclick="toggleGithubTokenRowReveal(${idx})" style="min-width: 62px;">
        ${item.revealed ? 'Hide' : 'Show'}
      </button>
      <button type="button" class="btn btn-danger btn-sm" onclick="removeGithubTokenRow(${idx})" title="Remove token">&times;</button>
    </div>
  `).join('');
}

export function addGithubTokenRow() {
  syncGithubTokensDomToDraft();
  if (!Array.isArray(state.githubTokensDraft)) state.githubTokensDraft = [];
  state.githubTokensDraft.push({
    label: `Account #${state.githubTokensDraft.length + 1}`,
    token: '',
    revealed: false,
  });
  renderGithubTokensRows();
}

export function removeGithubTokenRow(idx) {
  syncGithubTokensDomToDraft();
  if (!Array.isArray(state.githubTokensDraft)) return;
  state.githubTokensDraft.splice(idx, 1);
  if (state.githubTokensDraft.length === 0) {
    state.githubTokensDraft.push({ label: 'Primary Account', token: '', revealed: false });
  }
  renderGithubTokensRows();
}

export function toggleGithubTokenRowReveal(idx) {
  syncGithubTokensDomToDraft();
  if (state.githubTokensDraft && state.githubTokensDraft[idx]) {
    state.githubTokensDraft[idx].revealed = !state.githubTokensDraft[idx].revealed;
    renderGithubTokensRows();
  }
}

// ============================================================================
// User Access Control
// ============================================================================
export function renderUserProjectsChecklist(selectedIds = [], allProjects = true) {
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
        <span>${escapeHtml(p.name)} <code style="font-size:11px;">(${p.port || 3000})</code></span>
      </label>
    `;
  }).join('');
}

function formatNeutralBadgesSummary(labels, fallbackHtml, maxVisible = 4) {
  if (!labels.length) return fallbackHtml;
  const fullTooltip = escapeHtml(labels.join(', '));
  const shown = labels
    .slice(0, maxVisible)
    .map((lbl) => `<span class="badge badge-neutral" style="font-size: 10px;">${escapeHtml(lbl)}</span>`)
    .join('');
  const overflow = labels.length > maxVisible
    ? `<span class="badge badge-neutral" style="font-size: 10px;" title="${fullTooltip}">+${labels.length - maxVisible} more</span>`
    : '';
  return shown + overflow;
}

function formatUserPowersHtml(u, isMain) {
  if (isMain || (u.permissions && u.permissions.includes('*'))) {
    return '<span class="badge badge-neutral" style="font-size: 10px;">All powers (*)</span>';
  }
  const perms = u.permissions || [];
  if (!perms.length) {
    return '<span class="badge badge-neutral" style="font-size: 10px;">Read-only</span>';
  }
  const allKeys = Object.keys(POWER_LABELS).filter((k) => k !== '*');
  if (allKeys.every((k) => perms.includes(k))) {
    const tip = escapeHtml(allKeys.map((k) => POWER_LABELS[k]).join(', '));
    return `<span class="badge badge-neutral" style="font-size: 10px;" title="${tip}">All powers (${allKeys.length})</span>`;
  }
  return formatNeutralBadgesSummary(
    perms.map((p) => POWER_LABELS[p] || p),
    '<span class="badge badge-neutral" style="font-size: 10px;">Read-only</span>',
    4,
  );
}

export function renderUsersTable(users) {
  const tbody = document.getElementById('users-table-body');
  if (!tbody) return;

  const countBadge = document.getElementById('settings-users-count-badge');
  if (countBadge) {
    const n = Array.isArray(users) ? users.length : 0;
    countBadge.textContent = `${n} user${n === 1 ? '' : 's'}`;
  }

  if (!users || !users.length) {
    tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; padding: 20px; color: var(--text-dim); font-size: 12px;">No users configured.</td></tr>';
    const pg = document.getElementById('users-pagination');
    if (pg) pg.innerHTML = '';
    return;
  }

  paginateAndRender(users, 'users', 'users-pagination', (slice) => {
    tbody.innerHTML = slice.map((u) => {
      const isMain = u.isMainAdmin || u.username.toLowerCase() === 'admin' || u.id === 1;
      const projHtml = (isMain || u.allProjects)
        ? '<span class="badge badge-neutral" style="font-size: 10px;">All websites (*)</span>'
        : formatNeutralBadgesSummary(
            (u.allowedProjects || []).map((pid) => {
              const proj = state.projects.find((p) => p.id === pid);
              return proj ? proj.name : `#${pid}`;
            }),
            '<span class="badge badge-warning" style="font-size: 10px;">No websites</span>',
            3,
          );

      const permsHtml = formatUserPowersHtml(u, isMain);

      const presence = u.disabled
        ? 'disabled'
        : String(u.presence || 'offline').toLowerCase();
      const statusBadge = presence === 'disabled'
        ? '<span class="badge badge-danger" style="font-size: 10px;">Disabled</span>'
        : presence === 'online'
          ? '<span class="badge badge-success" style="font-size: 10px;">Online</span>'
          : presence === 'idle'
            ? '<span class="badge badge-warning" style="font-size: 10px;">Idle</span>'
            : '<span class="badge badge-neutral" style="font-size: 10px;">Offline</span>';

      return `
        <tr>
          <td>
            <div style="display:flex; align-items:center; gap:8px;">
              <strong>${escapeHtml(u.username)}</strong>
              ${isMain ? '<span class="badge badge-neutral" style="font-size: 10px;">Main admin</span>' : ''}
              ${u.id === state.user?.id ? '<span style="color:var(--text-dim); font-size:11px;">(You)</span>' : ''}
            </div>
          </td>
          <td>
            ${u.totpEnabled
              ? '<span class="badge badge-success" style="font-size: 10px;">Enabled</span>'
              : '<span class="badge badge-neutral" style="font-size: 10px;">Off</span>'}
          </td>
          <td><div style="display:flex; flex-wrap:wrap; gap:4px;">${projHtml}</div></td>
          <td><div style="display:flex; flex-wrap:wrap; gap:4px;">${permsHtml}</div></td>
          <td>${statusBadge}</td>
          <td>
            <div style="display:flex; align-items:center; justify-content:flex-end; gap:6px; flex-wrap:wrap;">
              ${!isMain ? `
                <button class="btn btn-secondary btn-sm" onclick="openEditUserModal(${u.id})">Edit Access</button>
                <button class="btn btn-secondary btn-sm" onclick="toggleUserDisabled(${u.id}, ${u.disabled ? 0 : 1})">
                  ${u.disabled ? 'Enable' : 'Disable'}
                </button>
                ${u.totpEnabled && state.user?.isMainAdmin ? `
                  <button class="btn btn-secondary btn-sm" onclick="adminResetUser2fa(${u.id}, '${escapeHtml(u.username)}')">Reset 2FA</button>
                ` : ''}
                ${u.id !== state.user?.id ? `
                  <button class="btn btn-danger btn-sm" onclick="deleteUser(${u.id}, '${escapeHtml(u.username)}')">Remove</button>
                ` : ''}
              ` : '<span class="badge badge-neutral" style="font-size: 10px;">Full root access</span>'}
            </div>
          </td>
        </tr>
      `;
    }).join('');
  });
}

export function openEditUserModal(userId) {
  const u = (state.usersList || []).find((x) => x.id === userId);
  if (!u) return;

  document.getElementById('create-user-form')?.reset();
  const idEl = document.getElementById('user-edit-id');
  if (idEl) idEl.value = String(u.id);
  const titleEl = document.getElementById('user-modal-title');
  if (titleEl) titleEl.textContent = `Edit Access & Powers: ${u.username}`;
  const saveBtn = document.getElementById('save-new-user-btn');
  if (saveBtn) saveBtn.textContent = 'Save Access & Powers';

  const unameInput = document.getElementById('user-new-username');
  if (unameInput) {
    unameInput.value = u.username;
    unameInput.disabled = true;
  }

  const passLabel = document.getElementById('user-password-label');
  if (passLabel) passLabel.textContent = 'Reset Password (Optional)';
  const passInput = document.getElementById('user-new-password');
  if (passInput) {
    passInput.value = '';
    passInput.placeholder = 'Leave blank to keep current password';
  }

  const hasWildcard = (u.permissions || []).includes('*');
  document.querySelectorAll('.user-power-check').forEach((cb) => {
    cb.checked = hasWildcard || (u.permissions || []).includes(cb.value);
  });

  renderUserProjectsChecklist(u.allowedProjects || [], Boolean(u.allProjects));
  openModal('modal-create-user');
}

export async function toggleUserDisabled(userId, disabled) {
  try {
    await api(`/api/users/${userId}`, { method: 'PUT', body: { disabled: Boolean(disabled) } });
    toast(disabled ? 'User account disabled.' : 'User account enabled.', 'success');
    if (window.loadSettingsView) await window.loadSettingsView();
  } catch (err) {
    toast(`Update failed: ${err.message}`, 'error');
  }
}

export async function deleteUser(userId, username) {
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
    if (window.loadSettingsView) await window.loadSettingsView();
  } catch (err) {
    toast(`Delete failed: ${err.message}`, 'error');
  }
}

// Bind DOM event listeners
document.getElementById('user-all-projects-check')?.addEventListener('change', (e) => {
  const isAll = e.target.checked;
  const currentSelected = Array.from(document.querySelectorAll('.user-project-check:checked')).map((cb) => Number(cb.value));
  renderUserProjectsChecklist(currentSelected, isAll);
});

document.getElementById('create-user-modal-btn')?.addEventListener('click', () => {
  document.getElementById('create-user-form')?.reset();
  setUserPowerPreset('defaults');
  const idEl = document.getElementById('user-edit-id');
  if (idEl) idEl.value = '';
  const titleEl = document.getElementById('user-modal-title');
  if (titleEl) titleEl.textContent = 'Create Platform User';
  const saveBtn = document.getElementById('save-new-user-btn');
  if (saveBtn) saveBtn.textContent = 'Create User';
  const unameInput = document.getElementById('user-new-username');
  if (unameInput) unameInput.disabled = false;
  const passLabel = document.getElementById('user-password-label');
  if (passLabel) passLabel.textContent = 'Password (min 6 chars) *';
  const passInput = document.getElementById('user-new-password');
  if (passInput) passInput.placeholder = '••••••••';
  renderUserProjectsChecklist([], true);
  openModal('modal-create-user');
});

document.getElementById('save-new-user-btn')?.addEventListener('click', async (e) => {
  e.preventDefault();
  const editId = document.getElementById('user-edit-id')?.value.trim();
  const username = document.getElementById('user-new-username')?.value.trim();
  const password = document.getElementById('user-new-password')?.value;
  const permissions = Array.from(document.querySelectorAll('.user-power-check:checked')).map((cb) => cb.value);
  const allProjects = document.getElementById('user-all-projects-check')?.checked;
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
      const body = { permissions, allProjects, allowedProjects };
      if (password) body.password = password;
      await api(`/api/users/${editId}`, { method: 'PUT', body });
      toast(`Updated permissions & website access for "${username}".`, 'success');
    } else {
      await api('/api/users', {
        method: 'POST',
        body: { username, password, permissions, allProjects, allowedProjects },
      });
      toast(`User "${username}" created in SQLite.`, 'success');
    }
    closeModal('modal-create-user');
    if (window.loadSettingsView) await window.loadSettingsView();
  } catch (err) {
    toast(`Failed to save user: ${err.message}`, 'error');
  }
});

// Bind window globals for HTML inline event handlers
window.addGithubTokenRow = addGithubTokenRow;
window.removeGithubTokenRow = removeGithubTokenRow;
window.toggleGithubTokenRowReveal = toggleGithubTokenRowReveal;
window.openEditUserModal = openEditUserModal;
window.setUserPowerPreset = setUserPowerPreset;
window.toggleUserDisabled = toggleUserDisabled;
window.deleteUser = deleteUser;

// Keep user online / idle / offline presence live while viewing Settings as Main Admin
setInterval(async () => {
  if (state.currentView !== 'settings' || !state.user?.isMainAdmin || document.hidden) return;
  try {
    const users = await api('/api/users', { noCache: true });
    state.usersList = users;
    renderUsersTable(users);
  } catch (_) {}
}, 10_000);

