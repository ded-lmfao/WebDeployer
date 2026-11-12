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

export const ROLE_PRESET_POWERS = {
  admin: ['deploy', 'process', 'logs', 'env', 'domains', 'backups', 'projects_manage', 'settings_manage'],
  operator: ['deploy', 'process', 'logs', 'backups'],
  developer: ['deploy', 'process', 'logs', 'env'],
  viewer: ['logs'],
};

export const POWER_LABELS = {
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
      <input type="${item.revealed ? 'text' : 'password'}" class="form-control env-mono-input gh-token-value-input" value="${escapeHtml(item.token || '')}" placeholder="ghp_... or github_pat_...">
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
// User Roles & Access Control
// ============================================================================
export function applyRolePresetToCheckboxes(role) {
  const powers = ROLE_PRESET_POWERS[role];
  if (!powers) return;
  document.querySelectorAll('.user-power-check').forEach((cb) => {
    cb.checked = powers.includes(cb.value);
  });
}

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
        <span>${escapeHtml(p.name)} <code style="font-size:11px;">(:${p.port || 3000})</code></span>
      </label>
    `;
  }).join('');
}

export function renderUsersTable(users) {
  const tbody = document.getElementById('users-table-body');
  if (!tbody) return;

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
        ? perms.map((p) => `<span class="badge badge-neutral" style="margin:2px; font-size:10px;">${escapeHtml(POWER_LABELS[p] || p)}</span>`).join(' ')
        : '<span style="color:var(--text-dim); font-size:12px;">Read-Only</span>';

      const tfaBadge = u.totpEnabled
        ? '<span class="badge badge-success">2FA ON</span>'
        : '<span class="badge badge-neutral">OFF</span>';

      return `
        <tr>
          <td>
            <strong>${escapeHtml(u.username)}</strong>
            ${isMain ? '<span class="badge badge-info" style="margin-left:6px; font-size:10px;">MAIN ADMIN</span>' : ''}
            ${u.id === state.user?.id ? '<span style="color:var(--text-dim); font-size:11px; margin-left:4px;">(You)</span>' : ''}
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
                ${u.totpEnabled && state.user?.isMainAdmin ? `
                  <button class="btn btn-secondary btn-sm" onclick="adminResetUser2fa(${u.id}, '${escapeHtml(u.username)}')">Reset 2FA</button>
                ` : ''}
                ${u.id !== state.user?.id ? `
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

  const roleEl = document.getElementById('user-new-role');
  if (roleEl) roleEl.value = u.role || 'custom';

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
document.getElementById('user-new-role')?.addEventListener('change', (e) => {
  applyRolePresetToCheckboxes(e.target.value);
});

document.getElementById('user-all-projects-check')?.addEventListener('change', (e) => {
  const isAll = e.target.checked;
  const currentSelected = Array.from(document.querySelectorAll('.user-project-check:checked')).map((cb) => Number(cb.value));
  renderUserProjectsChecklist(currentSelected, isAll);
});

document.getElementById('create-user-modal-btn')?.addEventListener('click', () => {
  document.getElementById('create-user-form')?.reset();
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
  const roleEl = document.getElementById('user-new-role');
  if (roleEl) roleEl.value = 'operator';
  applyRolePresetToCheckboxes('operator');
  renderUserProjectsChecklist([], true);
  openModal('modal-create-user');
});

document.getElementById('save-new-user-btn')?.addEventListener('click', async (e) => {
  e.preventDefault();
  const editId = document.getElementById('user-edit-id')?.value.trim();
  const username = document.getElementById('user-new-username')?.value.trim();
  const password = document.getElementById('user-new-password')?.value;
  const role = document.getElementById('user-new-role')?.value;
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
window.toggleUserDisabled = toggleUserDisabled;
window.deleteUser = deleteUser;

