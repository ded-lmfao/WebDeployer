/**
 * WebDep Platform Settings, Monitoring & Self-Updater Subsystem
 * Server monitoring, security overview, SQLite system settings, audit logs, and self-updater pipeline.
 */

import {
  state,
  paginateAndRender,
  escapeHtml,
  formatDate,
  formatRelativeTime,
  formatDuration,
  setHtmlIfChanged,
  openModal,
  showConfirmDialog,
  AUDIT_ACTION_META,
  invalidateClientCache,
} from './state.js';
import { api, toast } from './api.js';
import { hasPower } from './auth.js';
import { renderThemePicker, applyTheme, THEME_STORAGE_KEY } from './themes.js';

// Re-export submodules so consumers importing from './settings.js' have full API parity
export * from './settings_users.js';
export * from './settings_caddy.js';

import {
  syncGithubTokensDomToDraft,
  renderGithubTokensRows,
  renderUsersTable,
} from './settings_users.js';

// ============================================================================
// View 10: Server Monitoring
// ============================================================================
export async function loadMonitorView() {
  try {
    const data = await api('/api/monitor');
    const sys = data.system || {};

    const monHost = document.getElementById('mon-hostname');
    if (monHost) monHost.textContent = sys.hostname || 'Local Host';
    const monPlat = document.getElementById('mon-platform');
    if (monPlat) monPlat.textContent = sys.platform || '--';
    const monUp = document.getElementById('mon-uptime');
    if (monUp) monUp.textContent = formatDuration(sys.uptime);
    const monCores = document.getElementById('mon-cpu-cores');
    if (monCores) monCores.textContent = `${sys.cpu?.cores || 1} Cores (${sys.cpu?.pct || 0}% used)`;
    const monLoad = document.getElementById('mon-cpu-load');
    if (monLoad) monLoad.textContent = `Load avg: ${(sys.cpu?.load || []).map((x) => x.toFixed(2)).join(', ')}`;

    // Nginx status
    try {
      const ng = await api('/api/nginx/status');
      const ngStatus = document.getElementById('mon-nginx-status');
      if (ngStatus) {
        ngStatus.textContent = ng.running ? 'Active (Running)' : (ng.installed ? 'Stopped' : 'Not Installed');
        ngStatus.style.color = ng.running ? 'var(--success)' : 'var(--danger)';
      }
      const ngVer = document.getElementById('mon-nginx-version');
      if (ngVer) ngVer.textContent = `nginx/${ng.version}`;
    } catch { /* ignore */ }

    // Projects table (scoped to the active website card when inside a website workspace)
    const activeProject = window.getSelectedProject?.();
    const monProjects = activeProject
      ? (data.projects || []).filter((p) => p.id === activeProject.id)
      : (data.projects || []);
    const tbody = document.getElementById('monitor-projects-table');
    if (tbody) {
      setHtmlIfChanged(tbody, monProjects.map((p) => {
        const appSt = p.status?.appStatus || (p.status?.running ? 'running' : 'stopped');
        const isOnline = appSt === 'running';
        const isMaint = appSt === 'maintenance';
        return `
        <tr>
          <td><strong>${escapeHtml(p.name)}</strong></td>
          <td>
            <span class="status-dot ${isOnline ? 'online' : isMaint ? 'maintenance' : 'offline'}"></span>
            <span style="font-size:12px; font-weight:600; margin-left:6px; color:${isOnline ? 'var(--success)' : isMaint ? 'var(--warning)' : 'var(--text-muted)'};">${isOnline ? 'Online' : isMaint ? 'Maintenance' : 'Stopped'}</span>
          </td>
          <td>${p.status?.uptimeMs ? formatDuration(p.status.uptimeMs / 1000) : '--'}</td>
          <td>${p.deployedSha ? `<span class="sha-pill">${p.deployedSha.slice(0, 7)}</span>` : '--'}</td>
          <td>${p.disk ? `${(p.disk.used / 1048576).toFixed(1)} MB` : '--'}</td>
          <td><span class="badge ${p.deployStatus?.status === 'success' ? 'badge-success' : 'badge-neutral'}">${p.deployStatus?.status ? escapeHtml(p.deployStatus.status.charAt(0).toUpperCase() + p.deployStatus.status.slice(1)) : 'Idle'}</span></td>
        </tr>
      `;
      }).join(''));
    }
  } catch (err) {
    console.error('Monitor view error:', err);
  }
}

// ============================================================================
// View 11: Settings & Security Overview
// ============================================================================
export function renderSecurityStatusSummary() {
  if (!state.user) return;
  const is2fa = Boolean(state.user.totpEnabled);
  const pkCount = Number(state.passkeyCount || (state.passkeysList && state.passkeysList.length) || 0);
  const badge = document.getElementById('settings-2fa-status-badge');
  if (badge) {
    const isProtected = is2fa || pkCount > 0;
    badge.className = `badge ${isProtected ? 'badge-success' : 'badge-warning'}`;
    badge.textContent = isProtected ? 'Protected' : 'Unprotected';
  }
  const unameEl = document.getElementById('settings-sec-username');
  if (unameEl) unameEl.textContent = `${state.user.username} (${state.user.isMainAdmin ? 'Main admin' : 'User'})`;

  const pkText = document.getElementById('settings-sec-passkeys-text');
  if (pkText) {
    pkText.textContent = pkCount > 0 ? `${pkCount} registered` : 'None';
    pkText.style.color = pkCount > 0 ? 'var(--text-main)' : 'var(--text-dim)';
  }

  const pkModalBadge = document.getElementById('sec-passkey-modal-badge');
  if (pkModalBadge) {
    pkModalBadge.className = `badge ${pkCount > 0 ? 'badge-success' : 'badge-neutral'}`;
    pkModalBadge.textContent = `${pkCount} registered`;
  }

  const tfaText = document.getElementById('settings-sec-2fa-text');
  if (tfaText) {
    tfaText.textContent = is2fa ? 'Enabled' : 'Not enabled';
    tfaText.style.color = is2fa ? 'var(--text-main)' : 'var(--warning-light)';
  }

  const sessText = document.getElementById('settings-sec-sessions');
  const count = state.activeSessions || 1;
  if (sessText) sessText.textContent = `${count} active`;

  const modalSess = document.getElementById('sec-modal-sessions-summary');
  if (modalSess) modalSess.textContent = `Your account currently has ${count} active authenticated session${count === 1 ? '' : 's'}.`;

  const open2faBtn = document.getElementById('settings-open-2fa-btn');
  if (open2faBtn) open2faBtn.textContent = is2fa ? 'Manage 2FA' : 'Enable 2FA';
}

export async function loadSettingsView() {
  renderSecurityStatusSummary();
  renderThemePicker();
  if (window.loadPasskeysList) window.loadPasskeysList().catch(() => {});

  const isMain = Boolean(state.user && state.user.isMainAdmin);
  const canSettings = hasPower('settings_manage');
  const canSystem = hasPower('system_manage');

  const globalCard = document.getElementById('settings-global-config-card');
  const usersCard = document.getElementById('settings-users-card');
  const panelCard = document.getElementById('settings-panel-card');
  const updateCard = document.getElementById('settings-update-card');
  const restartBtn = document.getElementById('restart-panel-btn');
  const clearCacheBtn = document.getElementById('clear-cache-btn');

  if (globalCard) globalCard.style.display = canSettings ? '' : 'none';
  if (panelCard) panelCard.style.display = (canSettings || canSystem) ? '' : 'none';
  if (restartBtn) restartBtn.style.display = canSystem ? '' : 'none';
  if (clearCacheBtn) clearCacheBtn.style.display = canSettings ? '' : 'none';
  if (updateCard) updateCard.style.display = canSystem ? '' : 'none';
  if (usersCard) usersCard.style.display = isMain ? '' : 'none';
  if (canSystem) loadSystemVersionInfo(true).catch(() => {});

  if (!canSettings && !isMain) return;

  try {
    if (canSettings) {
      const s = await api('/api/settings');
      if (s.panel_theme) {
        state.platformTheme = s.panel_theme;
        let hasLocalTheme = false;
        try { hasLocalTheme = Boolean(localStorage.getItem(THEME_STORAGE_KEY)); } catch (_) {}
        if (!hasLocalTheme) {
          applyTheme(s.panel_theme, true);
        } else {
          renderThemePicker();
        }
      }
      const freeMb = document.getElementById('setting-min-free-mb');
      if (freeMb) freeMb.value = s.min_free_mb || 500;
      const defRet = document.getElementById('setting-default-retention');
      if (defRet) defRet.value = s.default_retention || 10;
      const stepTo = document.getElementById('setting-step-timeout');
      if (stepTo) stepTo.value = s.step_timeout_s || 900;
      const depTo = document.getElementById('setting-deploy-timeout');
      if (depTo) depTo.value = s.deploy_timeout_s || 1800;

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
          const maskedTip = s.github_token_masked ? ` title="${escapeHtml(s.github_token_masked)}"` : '';
          tokBadge.innerHTML = `<span class="badge badge-success"${maskedTip}>${activeCount} active</span>`;
        }
      } else {
        if (tokBadge) tokBadge.innerHTML = '<span class="badge badge-neutral">Not set</span>';
      }
      renderGithubTokensRows();
    }

    // Users list
    if (isMain) {
      const users = await api('/api/users', { noCache: true });
      state.usersList = users;
      renderUsersTable(users);
    }
  } catch (err) {
    toast(`Failed to load settings: ${err.message}`, 'error');
  }
}

// Global settings form submit
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
    min_free_mb: Number(document.getElementById('setting-min-free-mb')?.value) || 500,
    default_retention: Number(document.getElementById('setting-default-retention')?.value) || 10,
    step_timeout_s: Number(document.getElementById('setting-step-timeout')?.value) || 900,
    deploy_timeout_s: Number(document.getElementById('setting-deploy-timeout')?.value) || 1800,
    github_tokens: cleanTokens,
  };

  try {
    await api('/api/settings', { method: 'PUT', body: payload });
    toast(`Global settings and ${cleanTokens.length} GitHub token(s) saved in SQLite.`, 'success');
    await loadSettingsView();
  } catch (err) {
    toast(`Save failed: ${err.message}`, 'error');
  }
});

// ============================================================================
// Activity & Audit Logs
// ============================================================================
export async function loadAuditView() {
  const tbody = document.getElementById('audit-table-body');
  const titleEl = document.getElementById('audit-view-title');
  const subEl = document.getElementById('audit-view-subtitle');
  const isDb = state.selectedEntityKind === 'database';
  const activeDb = isDb ? window.getSelectedDatabase?.() : null;
  const activeProject = !isDb ? window.getSelectedProject?.() : null;

  if (titleEl && subEl) {
    if (isDb && activeDb) {
      titleEl.textContent = `${activeDb.name} — Activity`;
      subEl.textContent = `Complete timeline of start/stop, restarts, access policies, file edits, and app links on ${activeDb.name}`;
    } else if (isDb) {
      titleEl.textContent = 'Database Activity';
      subEl.textContent = 'Select a database to view its complete activity timeline';
    } else if (activeProject) {
      titleEl.textContent = `${activeProject.name} — Activity`;
      subEl.textContent = `Complete timeline of who deployed, started/stopped, edited .env, or took snapshots on ${activeProject.name}`;
    } else {
      titleEl.textContent = 'Website Activity';
      subEl.textContent = 'Select a website to view its complete activity timeline';
    }
  }

  if (isDb && !activeDb) {
    if (tbody) tbody.innerHTML = '<tr><td colspan="5" style="text-align: center; padding: 24px;">Select a database first.</td></tr>';
    return;
  }
  if (!isDb && !activeProject) {
    if (tbody) tbody.innerHTML = '<tr><td colspan="5" style="text-align: center; padding: 24px;">Select a website first.</td></tr>';
    return;
  }

  try {
    const endpoint = isDb
      ? `/api/audit?databaseId=${activeDb.id}&limit=500`
      : `/api/audit?projectId=${activeProject.id}&limit=500`;
    const logs = await api(endpoint);
    state.auditLogs = Array.isArray(logs) ? logs : [];
    renderFilteredAuditLogs();
  } catch (err) {
    if (tbody) tbody.innerHTML = `<tr><td colspan="5" style="text-align: center; color: var(--danger); padding: 24px;">${escapeHtml(err.message)}</td></tr>`;
  }
}

export function renderFilteredAuditLogs() {
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
      } else if (cat === 'container' && !(action.startsWith('container') || action.startsWith('project.start') || action.startsWith('project.stop') || action.startsWith('project.restart') || action === 'database.start' || action === 'database.stop' || action === 'database.restart')) {
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

  toast('Panel is restarting. Reconnecting', 'info', 8000);
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

export async function loadSystemVersionInfo(quiet = false, forceRefresh = false) {
  try {
    const endpoint = forceRefresh ? '/api/system/version?refresh=1' : '/api/system/version';
    const v = await api(endpoint);
    const branchEl = document.getElementById('platform-branch-name');
    const hashEl = document.getElementById('platform-commit-hash');
    const msgEl = document.getElementById('platform-commit-msg');
    const badgeEl = document.getElementById('platform-version-badge');
    const repoInput = document.getElementById('platform-update-repo-input');

    if (branchEl) branchEl.textContent = v.current_release_tag || v.current_branch || `v${v.current_version || '2.0.0'}`;
    if (hashEl) hashEl.textContent = v.current_commit || 'unknown';
    if (msgEl) msgEl.textContent = v.commit_message || 'Self-hosted WebDep deployment platform';
    if (repoInput && document.activeElement !== repoInput && v.remote_url) {
      repoInput.value = v.remote_url;
    }

    if (badgeEl) {
      badgeEl.style.background = '';
      badgeEl.style.color = '';
      if (v.update_in_progress) {
        badgeEl.className = 'badge badge-warning';
        badgeEl.textContent = 'Update in progress';
      } else if (v.ready_to_restart) {
        badgeEl.className = 'badge badge-warning';
        badgeEl.textContent = 'Restart required';
      } else if (v.has_update) {
        badgeEl.className = 'badge badge-success';
        const label = v.remote_commit || v.remote_tag || 'latest';
        badgeEl.textContent = `Update available (${label})`;
      } else if (v.check_error) {
        badgeEl.className = 'badge badge-neutral';
        badgeEl.textContent = 'No release checked';
      } else {
        badgeEl.className = 'badge badge-neutral';
        badgeEl.textContent = 'Up to date';
      }
    }
    return v;
  } catch (err) {
    if (!quiet) toast(`Could not load version info: ${err.message}`, 'warning');
    return null;
  }
}

export async function savePlatformUpdateRepo() {
  const input = document.getElementById('platform-update-repo-input');
  const btn = document.getElementById('save-platform-repo-btn');
  const repo = (input?.value || '').trim();
  if (!repo) {
    toast('Please enter a repository name (e.g. owner/repo) or GitHub URL.', 'warning');
    return;
  }

  if (btn) btn.disabled = true;
  try {
    const res = await api('/api/system/update/repo', {
      method: 'POST',
      body: { repo },
    });
    if (input && res.remote_url) input.value = res.remote_url;
    toast(`Platform update repository set to ${res.remote_url}`, 'success');
    await loadSystemVersionInfo(true, true);
  } catch (err) {
    toast(`Failed to update repository: ${err.message}`, 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}

export async function checkPlatformUpdates(manual = false) {
  const btn = document.getElementById('check-platform-update-btn');
  if (btn) btn.disabled = true;
  if (manual) toast('Checking GitHub Releases for latest prebuilt binary', 'info', 2500);

  const v = await loadSystemVersionInfo(!manual, manual);
  if (btn) btn.disabled = false;

  if (manual && v) {
    if (v.ready_to_restart) {
      toast('A new release is ready. Click Restart Panel to activate it.', 'warning', 6000);
    } else if (v.has_update) {
      const sizeMb = v.asset_size_bytes ? ` • ${(v.asset_size_bytes / (1024 * 1024)).toFixed(1)} MB` : '';
      toast(`Release ${v.remote_tag || v.remote_commit} is available${sizeMb}. Click Update to install.`, 'success', 5500);
    } else if (v.check_error) {
      toast(v.check_error, 'warning', 6500);
    } else {
      toast(`WebDep is already on the latest GitHub Release (${v.current_release_tag || v.current_commit}).`, 'success');
    }
  }
}

export async function startPlatformUpdate() {
  const v = await loadSystemVersionInfo(true, true);
  const targetLabel = v?.remote_tag || v?.remote_commit || 'latest';
  const assetMeta = v?.asset_name
    ? `${escapeHtml(v.asset_name)}${v.asset_size_bytes ? ` (${(v.asset_size_bytes / (1024 * 1024)).toFixed(1)} MB)` : ''}`
    : 'prebuilt Linux release binary';

  const ok = await showConfirmDialog({
    title: 'Update WebDep from GitHub Release',
    message: `Download and install release <strong>${escapeHtml(targetLabel)}</strong> (${assetMeta})?<br><br>
    &bull; <strong style="color:var(--success);">Preserves data:</strong> Your <code>data/</code> folder (SQLite databases, hosted websites, services, logs) and <code>.env</code> secrets stay untouched.<br>
    &bull; <strong style="color:var(--accent-light);">Instant binary update:</strong> Downloads prebuilt CI binary, verifies its SHA-256 checksum, and runs a smoke test before swapping (no on-server Rust compilation).<br>
    &bull; <strong style="color:var(--text-main);">Automatic restart:</strong> Swaps atomically with rollback protection and restarts the panel cleanly.`,
    confirmText: 'Download & Apply Release',
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
  const dismissBtn = document.getElementById('update-dismiss-btn');
  const closeBtn = document.getElementById('modal-platform-update-close');

  if (stepText) stepText.textContent = 'Initializing GitHub Release update';
  if (pctText) pctText.textContent = '5%';
  if (progressBar) {
    progressBar.style.width = '5%';
    progressBar.style.background = 'var(--accent)';
  }
  if (consoleLogs) consoleLogs.textContent = 'Connecting to GitHub Releases updater\n';
  if (bannerMsg) bannerMsg.textContent = 'Downloading prebuilt GitHub Release binary, verifying SHA-256, and swapping.';
  if (statusBanner) statusBanner.style.display = 'flex';
  if (spinner) spinner.style.display = 'block';
  if (dismissBtn) dismissBtn.disabled = true;
  if (closeBtn) closeBtn.style.display = 'none';

  openModal('modal-platform-update');

  try {
    await api('/api/system/update', { method: 'POST', body: { tag: v?.remote_tag || null } });
  } catch (err) {
    if (stepText) stepText.textContent = 'Failed to start update';
    if (bannerMsg) bannerMsg.textContent = `Error: ${err.message}`;
    if (spinner) spinner.style.display = 'none';
    if (dismissBtn) dismissBtn.disabled = false;
    if (closeBtn) closeBtn.style.display = 'block';
    toast(`Update could not start: ${err.message}`, 'error');
    return;
  }

  let lastLogText = '';
  if (updatePollTimer) clearInterval(updatePollTimer);
  updatePollTimer = setInterval(async () => {
    try {
      const st = await api('/api/system/update/status');
      const nextStep = st.step || 'Updating';
      const nextPct = `${st.progress || 0}%`;
      if (stepText && stepText.textContent !== nextStep) stepText.textContent = nextStep;
      if (pctText && pctText.textContent !== nextPct) pctText.textContent = nextPct;
      if (progressBar && progressBar.style.width !== nextPct) progressBar.style.width = nextPct;

      if (consoleLogs && Array.isArray(st.logs)) {
        const joined = st.logs.join('\n');
        if (joined !== lastLogText) {
          lastLogText = joined;
          consoleLogs.textContent = joined;
          consoleLogs.scrollTop = consoleLogs.scrollHeight;
        }
      }

      if (st.status === 'error') {
        clearInterval(updatePollTimer);
        updatePollTimer = null;
        if (progressBar) progressBar.style.background = 'var(--danger)';
        if (spinner) spinner.style.display = 'none';
        if (bannerMsg) bannerMsg.textContent = `Update halted: ${st.error || 'Review build logs above'}. Previous binary kept intact.`;
        if (dismissBtn) dismissBtn.disabled = false;
        if (closeBtn) closeBtn.style.display = 'block';
        toast('Update failed. Previous version remains active.', 'error', 8000);
      } else if (st.status === 'restarting' || st.status === 'ready_to_restart' || st.status === 'success') {
        clearInterval(updatePollTimer);
        updatePollTimer = null;
        if (stepText) stepText.textContent = 'Update complete. Restarting WebDep panel';
        if (progressBar) {
          progressBar.style.width = '100%';
          progressBar.style.background = 'var(--success)';
        }
        if (spinner) spinner.style.display = 'block';
        if (bannerMsg) bannerMsg.textContent = 'Restarting WebDep panel now. Reconnecting automatically.';

        void pollReconnectionAfterUpdate();
      }
    } catch (_) {
      // transient network poll error
    }
  }, 900);
}

export async function executePostUpdateRestart() {
  const ok = await showConfirmDialog({
    title: 'Restart WebDep Panel',
    message: 'Restart the WebDep panel now to activate the new version? The dashboard will reconnect in about 3 seconds.',
    confirmText: 'Restart Now',
    danger: false,
  });
  if (!ok) return;

  const stepText = document.getElementById('update-step-text');
  const bannerMsg = document.getElementById('update-banner-msg');
  const statusBanner = document.getElementById('update-status-banner');
  const spinner = document.getElementById('update-active-spinner');
  const dismissBtn = document.getElementById('update-dismiss-btn');
  const closeBtn = document.getElementById('modal-platform-update-close');

  openModal('modal-platform-update');
  if (statusBanner) statusBanner.style.display = 'flex';
  if (spinner) spinner.style.display = 'block';
  if (stepText) stepText.textContent = 'Restarting WebDep service';
  if (bannerMsg) bannerMsg.textContent = 'Triggering service restart. Waiting for WebDep to come back online';
  if (dismissBtn) dismissBtn.disabled = true;
  if (closeBtn) closeBtn.style.display = 'none';

  try {
    await api('/api/system/restart', { method: 'POST' });
  } catch (err) {
    toast(`Restart trigger returned: ${err.message}`, 'info');
  }

  void pollReconnectionAfterUpdate();
}

export function copyUpdateLogs() {
  const el = document.getElementById('update-console-logs');
  if (!el) return;
  navigator.clipboard.writeText(el.textContent || '').then(() => {
    toast('Build logs copied to clipboard', 'success');
  }).catch(() => {
    toast('Could not copy logs to clipboard', 'warning');
  });
}

export async function pollReconnectionAfterUpdate() {
  const stepText = document.getElementById('update-step-text');
  const bannerMsg = document.getElementById('update-banner-msg');
  const progressBar = document.getElementById('update-progress-bar');
  const spinner = document.getElementById('update-active-spinner');

  if (progressBar) {
    progressBar.style.width = '100%';
    progressBar.style.background = 'var(--success)';
  }

  await new Promise((r) => setTimeout(r, 2000));

  for (let attempt = 1; attempt <= 90; attempt++) {
    if (bannerMsg) bannerMsg.textContent = `Probing WebDep service (Attempt ${attempt}/90)`;
    try {
      const res = await fetch('/healthz', { cache: 'no-store' });
      if (res.ok) {
        if (stepText) stepText.textContent = 'WebDep is back online.';
        if (bannerMsg) bannerMsg.textContent = 'Updated release verified live. Reloading dashboard in 1.5s';
        if (spinner) spinner.style.display = 'none';
        toast('WebDep updated and restarted.', 'success', 4000);
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

// Bind globals for onclick inline HTML handlers
window.loadMonitorView = loadMonitorView;
window.loadSettingsView = loadSettingsView;
window.renderSecurityStatusSummary = renderSecurityStatusSummary;
window.loadAuditView = loadAuditView;
window.loadSystemVersionInfo = loadSystemVersionInfo;
window.savePlatformUpdateRepo = savePlatformUpdateRepo;
window.checkPlatformUpdates = checkPlatformUpdates;
window.startPlatformUpdate = startPlatformUpdate;
window.executePostUpdateRestart = executePostUpdateRestart;
window.copyUpdateLogs = copyUpdateLogs;
window.pollReconnectionAfterUpdate = pollReconnectionAfterUpdate;
