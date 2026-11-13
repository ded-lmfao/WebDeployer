/**
 * WebDep Workspace Router & Controls Subsystem
 * Workspace tabs navigation, breadcrumbs, banner, and direct process lifecycle controls
 */

import { icon } from './icons.js';
import {
  state,
  WEBSITE_WORKSPACE_TABS,
  DATABASE_WORKSPACE_TABS,
  escapeHtml,
  getSelectedProject,
  getSelectedDatabase,
  isProjectOnline,
  isProjectMaintenance,
  isDatabaseRunning,
} from './state.js';
import { toast, prefetchWebsiteWorkspace, prefetchDatabaseWorkspace } from './api.js';

// Re-export process controls and lifecycle actions submodule
export * from './workspace_actions.js';

function openWebsiteWorkspace(projectId, tab = null) {
  state.selectedEntityKind = 'project';
  state.selectedProjectId = Number(projectId);
  prefetchWebsiteWorkspace(state.selectedProjectId);
  let targetTab = tab || 'deployments';
  if (targetTab === 'overview') targetTab = 'deployments';
  navigateTo(targetTab, state.selectedProjectId);
}
window.openWebsiteWorkspace = openWebsiteWorkspace;

function openDatabaseWorkspace(dbId, tab = null) {
  state.selectedEntityKind = 'database';
  state.selectedDatabaseId = Number(dbId);
  prefetchDatabaseWorkspace(state.selectedDatabaseId);
  let targetTab = tab || 'deployments';
  if (targetTab === 'overview') targetTab = 'deployments';
  if (!DATABASE_WORKSPACE_TABS.has(targetTab)) targetTab = 'deployments';
  navigateTo(targetTab, `db-${state.selectedDatabaseId}`);
}
window.openDatabaseWorkspace = openDatabaseWorkspace;

function switchWebsiteTab(tab) {
  if (state.selectedEntityKind === 'database') {
    const db = getSelectedDatabase();
    if (!db) {
      navigateTo('databases');
      return;
    }
    const targetTab = DATABASE_WORKSPACE_TABS.has(tab) ? tab : 'deployments';
    navigateTo(targetTab, `db-${db.id}`);
    return;
  }
  const p = getSelectedProject();
  if (!p) {
    navigateTo('projects');
    return;
  }
  navigateTo(tab, p.id);
}
window.switchWebsiteTab = switchWebsiteTab;

let isInternalNavigation = false;

function navigateTo(viewName, entityParam = null) {
  if (!state.user || !state.csrf || state.pendingMfaToken) {
    showLogin();
    return;
  }
  if (viewName === 'backups') viewName = 'releases';
  state.currentView = viewName;

  if (typeof entityParam === 'string' && entityParam.startsWith('db-')) {
    const dbId = Number(entityParam.slice(3));
    if (dbId) {
      state.selectedEntityKind = 'database';
      state.selectedDatabaseId = dbId;
    }
  } else if (entityParam !== null && entityParam !== undefined) {
    state.selectedEntityKind = 'project';
    state.selectedProjectId = Number(entityParam);
  } else if (!WEBSITE_WORKSPACE_TABS.has(viewName)) {
    // Switching back to a top-level view clears database workspace scope
    state.selectedEntityKind = 'project';
  }

  let hashParam = entityParam;
  if (!hashParam && WEBSITE_WORKSPACE_TABS.has(viewName) && state.selectedEntityKind === 'database' && state.selectedDatabaseId) {
    hashParam = `db-${state.selectedDatabaseId}`;
  }
  const targetHash = hashParam ? `#/${viewName}/${hashParam}` : `#/${viewName}`;
  if (window.location.hash !== targetHash) {
    isInternalNavigation = true;
    window.location.hash = targetHash;
  }
  renderCurrentView();
}
window.navigateTo = navigateTo;

function handleHashRoute() {
  if (isInternalNavigation) {
    isInternalNavigation = false;
    return;
  }
  if (!state.user || !state.csrf || state.pendingMfaToken) {
    resetCleanUrl();
    showLogin();
    return;
  }
  const hash = window.location.hash.replace(/^#\/?/, '') || 'overview';
  const parts = hash.split('/');
  let view = parts[0] || 'overview';
  if (view === 'backups') view = 'releases';

  if (parts[1] && parts[1].startsWith('db-')) {
    const dbId = Number(parts[1].slice(3));
    state.selectedEntityKind = 'database';
    if (dbId) state.selectedDatabaseId = dbId;
    if (!DATABASE_WORKSPACE_TABS.has(view)) view = 'deployments';
  } else {
    state.selectedEntityKind = 'project';
    const pid = parts[1] ? Number(parts[1]) : null;
    if (pid) state.selectedProjectId = pid;
  }

  state.currentView = view;
  renderCurrentView();
}
window.handleHashRoute = handleHashRoute;

window.addEventListener('hashchange', handleHashRoute);
window.addEventListener('pageshow', (e) => {
  if (e.persisted || !state.user || !state.csrf) {
    void initAuth();
  }
});

function updateBreadcrumbs() {
  const secEl = document.getElementById('breadcrumb-section');
  if (!secEl) return;

  const isInsideCard = WEBSITE_WORKSPACE_TABS.has(state.currentView);
  const tabLabels = {
    deployments: 'Overview',
    github: 'GitHub & Commits',
    logs: 'Live Logs',
    env: 'Environment (.env)',
    files: 'Files',
    releases: 'Releases',
    rollbacks: 'Rollbacks',
    monitor: 'Monitoring',
    audit: 'Activity',
  };

  if (isInsideCard && state.selectedEntityKind === 'database') {
    const db = getSelectedDatabase();
    if (db) {
      secEl.innerHTML = `<span style="cursor:pointer; color:var(--text-muted);" onclick="navigateTo('databases')">Databases</span> &rsaquo; <strong style="color:var(--text-main);">${escapeHtml(db.name)}</strong> &rsaquo; <span style="color:var(--accent-light);">${escapeHtml(tabLabels[state.currentView] || state.currentView)}</span>`;
      return;
    }
  }

  const p = getSelectedProject();
  if (isInsideCard && p) {
    const parentView = p.project_kind === 'service' ? 'services' : 'projects';
    const parentLabel = p.project_kind === 'service' ? 'Services' : 'Websites';
    secEl.innerHTML = `<span style="cursor:pointer; color:var(--text-muted);" onclick="navigateTo('${parentView}')">${parentLabel}</span> &rsaquo; <strong style="color:var(--text-main);">${escapeHtml(p.name)}</strong> &rsaquo; <span style="color:var(--accent-light);">${escapeHtml(tabLabels[state.currentView] || state.currentView)}</span>`;
  } else {
    const globalLabels = {
      overview: 'System Overview',
      projects: 'Hosted Websites',
      services: 'Backend Services',
      databases: 'Managed Databases',
      settings: 'Platform Settings',
    };
    secEl.textContent = globalLabels[state.currentView] || state.currentView;
  }
}

function renderDatabaseWorkspaceHeader(banner) {
  const d = getSelectedDatabase();
  if (!d) {
    banner.style.display = 'none';
    return;
  }

  banner.style.display = 'block';
  const resItem = (state.overview?.resources || []).find((x) => (x.databaseId === d.id || x.database_id === d.id));
  const isRunning = isDatabaseRunning(d, resItem);
  const isStarting = d.status === 'starting';
  const isStopping = d.status === 'stopping';
  const isError = d.status === 'error';

  const dot = document.getElementById('ws-status-dot');
  if (dot) dot.className = `status-dot ${isRunning ? 'online' : (isStarting || isStopping) ? 'maintenance' : 'offline'}`;

  const title = document.getElementById('ws-project-title');
  if (title) title.textContent = d.name;

  const breadcrumbSlug = document.getElementById('ws-breadcrumb-slug');
  if (breadcrumbSlug) breadcrumbSlug.textContent = d.name;

  const backCrumb = document.querySelector('.ws-back-crumb');
  if (backCrumb) {
    backCrumb.setAttribute('onclick', "navigateTo('databases')");
    backCrumb.setAttribute('title', 'Back to Managed Databases');
    const s = backCrumb.querySelector('span');
    if (s) s.textContent = 'Databases';
  }

  const badge = document.getElementById('ws-status-badge');
  if (badge) {
    if (isRunning) {
      badge.className = 'badge badge-success';
      badge.textContent = 'ONLINE';
    } else if (isStarting) {
      badge.className = 'badge badge-warning';
      badge.textContent = 'STARTING';
    } else if (isStopping) {
      badge.className = 'badge badge-warning';
      badge.textContent = 'STOPPING';
    } else if (isError) {
      badge.className = 'badge badge-danger';
      badge.textContent = 'ERROR';
    } else {
      badge.className = 'badge badge-neutral';
      badge.textContent = 'STOPPED';
    }
  }

  const pidFromContainer = (d.containerId || d.container_id || '').startsWith('pid-')
    ? Number((d.containerId || d.container_id).slice(4))
    : null;
  const effectivePid = d.pid || resItem?.pid || pidFromContainer;
  const diskStr = resItem?.diskFormatted || resItem?.disk_formatted || '';
  const accessMode = d.accessMode || d.access_mode || 'local';
  const dbName = d.dbName || d.db_name || 'app';
  const dbUser = d.dbUser || d.db_user || 'app_user';
  const linkedName = d.linkedProjectName || d.linked_project_name || '';

  const bannerSig = `db:${d.id}:${d.name}:${d.status}:${isRunning ? 1 : 0}:${d.port}:${accessMode}:${d.domain || ''}:${dbName}:${dbUser}:${linkedName}:${diskStr}:${effectivePid || ''}`;
  if (state.lastWsBannerSig !== bannerSig) {
    state.lastWsBannerSig = bannerSig;

    const links = document.getElementById('ws-project-links');
    if (links) {
      let accessText = `${icon('lock', { size: 11 })} Localhost`;
      if (accessMode === 'allowlist') accessText = `${icon('shield', { size: 11 })} IP Whitelist`;
      else if (accessMode === 'public') accessText = `${icon('globe', { size: 11 })} Public Internet`;

      links.innerHTML = `
        ${d.domain ? `
          <span class="ws-meta-item" style="color:var(--accent-light); font-weight:600; display:inline-flex; align-items:center; gap:4px;" title="Assigned Database Domain">
            ${icon('globe', { size: 12 })}
            <span>${escapeHtml(d.domain)}</span>
          </span>
          <span class="ws-meta-sep">&bull;</span>
        ` : ''}
        <span class="ws-meta-item" style="color:var(--accent-light); font-weight:600; display:inline-flex; align-items:center; gap:4px;">
          ${icon('postgres', { size: 14 })}
          <span>PostgreSQL Cluster</span>
        </span>
        <span class="ws-meta-sep">&bull;</span>
        <span class="ws-meta-item" title="Database &amp; Role">
          <code class="ws-meta-sha">${escapeHtml(dbUser)}@${escapeHtml(dbName)}</code>
        </span>
        ${d.port ? `
          <span class="ws-meta-sep">&bull;</span>
          <span class="ws-meta-item" title="Listening Port">Port <strong style="color:var(--text-main); font-weight:600;">${d.port}</strong></span>
        ` : ''}
        ${diskStr ? `
          <span class="ws-meta-sep">&bull;</span>
          <span class="ws-meta-item" title="On-Disk Storage">Disk <strong style="color:var(--text-main); font-weight:600;">${diskStr}</strong></span>
        ` : ''}
        <span class="ws-meta-sep">&bull;</span>
        <span class="ws-meta-item" title="Configure Network Access &amp; Domain" style="font-size:11px; cursor:pointer;" onclick="openDatabaseAccessModal(${d.id})">${accessText}</span>
        ${linkedName ? `
          <span class="ws-meta-sep">&bull;</span>
          <span class="ws-meta-item" title="Linked App">Linked <strong style="color:var(--text-main); font-weight:600;">${escapeHtml(linkedName)}</strong></span>
        ` : ''}
        ${(isRunning && effectivePid) ? `
          <span class="ws-meta-sep">&bull;</span>
          <span class="ws-meta-item" title="Master Postmaster PID">PID <strong style="color:var(--text-main); font-weight:600;">${effectivePid}</strong></span>
        ` : ''}
      `;
    }

    const actions = document.getElementById('ws-project-actions');
    if (actions) {
      const canManage = typeof window.hasPower === 'function' ? window.hasPower('databases_manage') : false;
      const canControl = typeof window.hasAnyPower === 'function' ? window.hasAnyPower(['databases', 'databases_manage']) : false;
      const canCreds = typeof window.hasAnyPower === 'function' ? window.hasAnyPower(['databases_manage', 'env']) : false;
      const safeName = escapeHtml(d.name).replace(/'/g, '&#39;');
      actions.innerHTML = `
        <div class="ws-actions-group">
          ${canControl ? `
            <button class="btn ${isRunning ? 'btn-secondary ws-btn-stop' : 'btn-success ws-btn-start'} btn-sm" id="ws-btn-db-toggle-${d.id}" onclick="toggleDatabaseState(${d.id})" ${(isStarting || isStopping) ? 'disabled' : ''}>
              ${isRunning
                ? `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><rect x="6" y="6" width="12" height="12"></rect></svg><span>Stop</span>`
                : isStarting
                  ? `<span class="btn-spinner"></span><span>Starting...</span>`
                  : isStopping
                    ? `<span class="btn-spinner"></span><span>Stopping...</span>`
                    : `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg><span>Start</span>`}
            </button>
            <button class="btn btn-secondary btn-sm ws-btn-restart" onclick="restartDatabase(${d.id})" title="Restart PostgreSQL cluster" ${(isStarting || isStopping) ? 'disabled' : ''}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-1.19"></path></svg>
              <span>Restart</span>
            </button>
          ` : ''}
        </div>

        <div class="ws-actions-group">
          ${canCreds ? `
            <button class="btn btn-secondary btn-sm" onclick="showDatabaseDetails(${d.id})" title="Connection Strings &amp; Credentials">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path></svg>
              <span>Connection</span>
            </button>
          ` : ''}
          ${canManage ? `
            <button class="btn btn-secondary btn-sm" onclick="openDatabaseAccessModal(${d.id})" title="Network Access &amp; Domain">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>
              <span>Access</span>
            </button>
            <button class="btn btn-sm ws-btn-delete" onclick="deleteDatabase(${d.id}, '${safeName}')" title="Delete Database">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
            </button>
          ` : ''}
        </div>
      `;
    }
  }

  const depTabLabel = document.getElementById('ws-tab-deployments-label');
  if (depTabLabel) depTabLabel.textContent = 'Overview';

  const dbTabPowerMap = {
    deployments: ['databases', 'databases_manage'],
    logs: ['databases', 'databases_manage', 'logs'],
    files: ['databases', 'databases_manage', 'files', 'files_write'],
    audit: ['databases', 'databases_manage', 'audit'],
  };

  const tabsBar = document.getElementById('ws-tabs-bar');
  let activeBtn = null;
  document.querySelectorAll('#ws-tabs-bar .ws-tab-item').forEach((btn) => {
    const tab = btn.getAttribute('data-ws-tab');
    const isAllowed = DATABASE_WORKSPACE_TABS.has(tab);
    const reqPowers = dbTabPowerMap[tab];
    const hasAccess = !reqPowers || (typeof window.hasAnyPower === 'function' ? window.hasAnyPower(reqPowers) : true);
    const isActive = tab === state.currentView;
    btn.style.display = (isAllowed && hasAccess) ? '' : 'none';
    btn.classList.toggle('active', isActive);
    if (isActive) activeBtn = btn;
  });

  const activeTabSig = `db:${d.id}:${state.currentView}`;
  if (tabsBar && activeBtn && state.lastCenteredWsTab !== activeTabSig) {
    requestAnimationFrame(() => {
      if (centerActiveWebsiteTab(true)) state.lastCenteredWsTab = activeTabSig;
      setTimeout(() => {
        if (centerActiveWebsiteTab(true)) state.lastCenteredWsTab = activeTabSig;
      }, 80);
    });
  }
}

function renderWebsiteWorkspaceHeader() {
  const banner = document.getElementById('website-workspace-banner');
  if (!banner) return;

  const isInsideCard = WEBSITE_WORKSPACE_TABS.has(state.currentView);
  if (!isInsideCard) {
    banner.style.display = 'none';
    return;
  }

  if (state.selectedEntityKind === 'database') {
    renderDatabaseWorkspaceHeader(banner);
    return;
  }

  const p = getSelectedProject();
  if (!p) {
    banner.style.display = 'none';
    return;
  }

  banner.style.display = 'block';
  const resItem = (state.overview?.resources || []).find((x) => (x.projectId === p.id || x.project_id === p.id));
  const isOnline = isProjectOnline(p, resItem);
  const isMaintenance = isProjectMaintenance(p, resItem);
  const isService = p.project_kind === 'service';

  const dot = document.getElementById('ws-status-dot');
  if (dot) dot.className = `status-dot ${isOnline ? 'online' : isMaintenance ? 'maintenance' : 'offline'}`;

  const title = document.getElementById('ws-project-title');
  if (title) title.textContent = p.name;

  const breadcrumbSlug = document.getElementById('ws-breadcrumb-slug');
  if (breadcrumbSlug) breadcrumbSlug.textContent = p.name;

  const backCrumb = document.querySelector('.ws-back-crumb');
  if (backCrumb) {
    if (isService) {
      backCrumb.setAttribute('onclick', "navigateTo('services')");
      backCrumb.setAttribute('title', 'Back to Backend Services');
      const s = backCrumb.querySelector('span');
      if (s) s.textContent = 'Services';
    } else {
      backCrumb.setAttribute('onclick', "navigateTo('projects')");
      backCrumb.setAttribute('title', 'Back to Hosted Websites');
      const s = backCrumb.querySelector('span');
      if (s) s.textContent = 'Websites';
    }
  }

  const badge = document.getElementById('ws-status-badge');
  if (badge) {
    if (isOnline) {
      badge.className = 'badge badge-success';
      badge.textContent = 'ONLINE';
    } else if (isMaintenance) {
      badge.className = 'badge badge-warning';
      badge.textContent = 'MAINTENANCE';
    } else {
      badge.className = 'badge badge-danger';
      badge.textContent = 'OFFLINE';
    }
  }

  const effectivePid = p.app_pid || p.status?.pid || resItem?.pid;
  const diskStr = resItem?.diskFormatted || resItem?.disk_formatted || '';

  const bannerSig = `${p.id}:${p.name}:${p.slug}:${p.app_status}:${isOnline ? 1 : 0}:${isMaintenance ? 1 : 0}:${effectivePid || ''}:${p.port}:${p.branch}:${p.deployed_sha}:${(p.domains || []).join(',')}:${p.project_kind}:${p.project_type}:${p.access_mode || ''}:${p.repo_url || ''}:${diskStr}`;
  if (state.lastWsBannerSig !== bannerSig) {
    state.lastWsBannerSig = bannerSig;

    const links = document.getElementById('ws-project-links');
    if (links) {
      const sha = p.deployed_sha ? p.deployed_sha.slice(0, 7) : 'Not deployed';
      if (isService) {
        let typeLabel = `${icon('server', { size: 14 })} Backend Service`;
        const pt = (p.project_type || '').toLowerCase();
        const sc = (p.start_cmd || '').toLowerCase();
        if (pt.includes('lavalink') || sc.includes('lavalink') || sc.includes('.jar') || sc.includes('java')) typeLabel = `${icon('java', { size: 14 })} Java Audio Server`;
        else if (pt.includes('python') || sc.includes('python') || sc.includes('.py')) typeLabel = `${icon('python', { size: 14 })} Python Daemon`;
        else if (pt.includes('rust') || sc.includes('cargo') || sc.includes('.rs')) typeLabel = `${icon('rust', { size: 14 })} Rust Daemon`;
        else if (pt.includes('go') || sc.includes('go run') || sc.includes('.go')) typeLabel = `${icon('go', { size: 14 })} Go Daemon`;
        else if (pt.includes('node') || sc.includes('node') || sc.includes('npm')) typeLabel = `${icon('nodejs', { size: 14 })} Node.js Worker`;
        else if (pt.includes('php') || sc.includes('php')) typeLabel = `${icon('php', { size: 14 })} PHP Service`;
        else if (pt.includes('ruby') || sc.includes('ruby') || sc.includes('rails')) typeLabel = `${icon('ruby', { size: 14 })} Ruby Daemon`;
        else if (pt.includes('docker') || sc.includes('docker')) typeLabel = `${icon('docker', { size: 14 })} Docker Container`;
        else if (pt.includes('worker')) typeLabel = `${icon('cpu', { size: 14 })} Queue Worker`;

        const isLocal = !p.repo_url || p.repo_url === 'local' || pt.includes('lavalink');
        const serviceDomainLink = (p.domains && p.domains.length > 0)
          ? `<a class="ws-meta-link active" href="https://${escapeHtml(p.domains[0])}" target="_blank" style="color:var(--accent-light); font-weight:600;" title="Custom Domain: https://${escapeHtml(p.domains[0])}">
               ${icon('globe', { size: 12 })}
               <span>${escapeHtml(p.domains[0])}</span>
             </a><span class="ws-meta-sep">&bull;</span>`
          : '';

        let accessText = `${icon('lock', { size: 11 })} Localhost`;
        if (p.access_mode === 'allowlist') accessText = `${icon('shield', { size: 11 })} Allowlist`;
        else if (p.access_mode === 'public') accessText = `${icon('globe', { size: 11 })} Public`;

        links.innerHTML = `
          ${serviceDomainLink}
          <span class="ws-meta-item" style="color:var(--accent-light); font-weight:600; display: inline-flex; align-items: center; gap: 4px;">
            ${typeLabel}
          </span>
          <span class="ws-meta-sep">&bull;</span>
          ${isLocal ? `
            <span class="ws-meta-item" title="Deployment Mode">
              <span class="badge badge-neutral" style="font-size:11px; padding: 2px 7px;">${icon('folder', { size: 11 })} Manual Upload</span>
            </span>
          ` : `
            <span class="ws-meta-item" title="Git Branch">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><line x1="6" y1="3" x2="6" y2="15"></line><circle cx="18" cy="6" r="3"></circle><circle cx="6" cy="18" r="3"></circle><path d="M18 9a9 9 0 0 1-9 9"></path></svg>
              <span style="color:var(--text-main); font-weight:600;">${escapeHtml(p.branch || 'main')}</span>
            </span>
            <span class="ws-meta-sep">&bull;</span>
            <span class="ws-meta-item" title="Deployed Commit SHA">
              <code class="ws-meta-sha">${escapeHtml(sha)}</code>
            </span>
          `}
          ${p.port ? `
            <span class="ws-meta-sep">&bull;</span>
            <span class="ws-meta-item" title="Listening Port">Port <strong style="color:var(--text-main); font-weight:600;">${p.port}</strong></span>
          ` : ''}
          ${diskStr ? `
            <span class="ws-meta-sep">&bull;</span>
            <span class="ws-meta-item" title="On-Disk Storage">Disk <strong style="color:var(--text-main); font-weight:600;">${diskStr}</strong></span>
          ` : ''}
          <span class="ws-meta-sep">&bull;</span>
          <span class="ws-meta-item" title="Click to configure Network Access Policy" style="font-size:11px; cursor:pointer;" onclick="openEditServiceModal(${p.id})">${accessText}</span>
          ${(isOnline && effectivePid) ? `
            <span class="ws-meta-sep">&bull;</span>
            <span class="ws-meta-item" title="Process PID">PID <strong style="color:var(--text-main); font-weight:600;">${effectivePid}</strong></span>
          ` : ''}
        `;
      } else {
        const url = p.port ? `http://127.0.0.1:${p.port}` : null;
        const customDomains = Array.isArray(p.domains) ? p.domains.filter(Boolean) : [];
        const primaryLinkHtml = customDomains.length
          ? `<a class="ws-meta-link active" href="https://${escapeHtml(customDomains[0])}" target="_blank" style="color:var(--accent-light); font-weight:600;" title="Open https://${escapeHtml(customDomains[0])}">
               ${icon('globe', { size: 12 })}
               <span>${escapeHtml(customDomains[0])}</span>
             </a>`
          : url
            ? `<a class="ws-meta-link active" href="${url}" target="_blank" title="Open ${url}">
                 <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line></svg>
                 <span>${url}</span>
               </a>`
            : '';

        let accessText = `${icon('lock', { size: 11 })} Localhost`;
        if (p.access_mode === 'allowlist') accessText = `${icon('shield', { size: 11 })} Allowlist`;
        else if (p.access_mode === 'public') accessText = `${icon('globe', { size: 11 })} Public`;

        links.innerHTML = `
          ${primaryLinkHtml ? `${primaryLinkHtml}<span class="ws-meta-sep">&bull;</span>` : ''}
          <span class="ws-meta-item" title="Git Branch">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><line x1="6" y1="3" x2="6" y2="15"></line><circle cx="18" cy="6" r="3"></circle><circle cx="6" cy="18" r="3"></circle><path d="M18 9a9 9 0 0 1-9 9"></path></svg>
            <span style="color:var(--text-main); font-weight:600;">${escapeHtml(p.branch || 'main')}</span>
          </span>
          <span class="ws-meta-sep">&bull;</span>
          <span class="ws-meta-item" title="Deployed Commit SHA">
            <code class="ws-meta-sha">${escapeHtml(sha)}</code>
          </span>
          ${p.port ? `
            <span class="ws-meta-sep">&bull;</span>
            <span class="ws-meta-item" title="Local Port">Port <strong style="color:var(--text-main); font-weight:600;">${p.port}</strong></span>
          ` : ''}
          ${diskStr ? `
            <span class="ws-meta-sep">&bull;</span>
            <span class="ws-meta-item" title="On-Disk Storage">Disk <strong style="color:var(--text-main); font-weight:600;">${diskStr}</strong></span>
          ` : ''}
          <span class="ws-meta-sep">&bull;</span>
          <span class="ws-meta-item" title="Click to configure Network Access Policy" style="font-size:11px; cursor:pointer;" onclick="openEditWebsiteModal(${p.id})">${accessText}</span>
          ${(isOnline && effectivePid) ? `
            <span class="ws-meta-sep">&bull;</span>
            <span class="ws-meta-item" title="Process PID">PID <strong style="color:var(--text-main); font-weight:600;">${effectivePid}</strong></span>
          ` : ''}
        `;
      }
    }

    const actions = document.getElementById('ws-project-actions');
    if (actions) {
      actions.innerHTML = `
        <div class="ws-actions-group">
          ${hasPower('deploy') && (!isService || (p.repo_url && p.repo_url !== 'local')) ? `
            <button class="btn btn-primary btn-sm" onclick="deployProject(${p.id})">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polyline points="13 2 13 9 20 9"></polyline><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"></path></svg>
              <span>Deploy</span>
            </button>
          ` : ''}
          ${hasPower('process') ? `
            ${!isOnline
              ? `<button class="btn btn-success btn-sm ws-btn-start" onclick="startProject(${p.id})">
                   <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>
                   <span>Start</span>
                 </button>`
              : ''
            }
            ${isOnline || isMaintenance
              ? `<button class="btn btn-secondary btn-sm ws-btn-stop" onclick="stopProject(${p.id})" title="Completely stop process">
                   <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><rect x="6" y="6" width="12" height="12"></rect></svg>
                   <span>Stop</span>
                 </button>`
              : ''
            }
            <button class="btn btn-secondary btn-sm ws-btn-restart" onclick="restartProject(${p.id})" title="Restart process">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-1.19"></path></svg>
              <span>Restart</span>
            </button>
            ${!isService ? `
              <button class="btn btn-secondary btn-sm" onclick="toggleMaintenanceMode(${p.id})" title="${isMaintenance ? 'Exit Maintenance Mode and resume live website' : 'Enable Maintenance Mode'}" style="${isMaintenance ? 'background: rgba(245, 158, 11, 0.16); border-color: rgba(245, 158, 11, 0.45); color: #fbbf24;' : ''}">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"></path></svg>
                <span>${isMaintenance ? 'Exit Maint.' : 'Maint.'}</span>
              </button>
            ` : ''}
          ` : ''}
        </div>

        <div class="ws-actions-group">
          ${!isService && hasPower('domains') ? `
            <button class="btn btn-secondary btn-sm" onclick="openNginxModal(${p.id})" title="Domains &amp; SSL">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="12" cy="12" r="10"></circle><line x1="2" y1="12" x2="22" y2="12"></line><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path></svg>
              <span>Domains</span>
            </button>
          ` : ''}
          ${hasPower(isService ? 'services_manage' : 'projects_manage') ? `
            <button class="btn btn-secondary btn-sm" onclick="${isService ? `openEditServiceModal(${p.id})` : `openEditWebsiteModal(${p.id})`}" title="${isService ? 'Service Settings' : 'Website Settings'}">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>
              <span>Settings</span>
            </button>
            <button class="btn btn-sm ws-btn-delete" onclick="deleteProject(${p.id}, '${escapeHtml(p.slug)}')" title="${isService ? 'Delete Service' : 'Delete Website'}">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
            </button>
          ` : ''}
        </div>
      `;
    }
  }

  const tabPowerMap = {
    logs: ['logs'],
    files: ['files', 'files_write'],
    env: ['env'],
    audit: ['audit'],
    monitor: ['monitor'],
  };
  const hiddenSecondaryTabs = new Set(['rollbacks', 'monitor']);

  const depTabLabel = document.getElementById('ws-tab-deployments-label');
  if (depTabLabel) {
    depTabLabel.textContent = 'Overview';
  }

  const tabsBar = document.getElementById('ws-tabs-bar');
  let activeBtn = null;
  document.querySelectorAll('#ws-tabs-bar .ws-tab-item').forEach((btn) => {
    const tab = btn.getAttribute('data-ws-tab');
    const reqPowers = tabPowerMap[tab];
    const isActive = tab === state.currentView;
    const isLocalService = isService && (!p.repo_url || p.repo_url === 'local' || (p.project_type && p.project_type.includes('lavalink')));
    if (isLocalService && (tab === 'github' || tab === 'releases' || tab === 'rollbacks')) {
      btn.style.display = 'none';
    } else if (tab === 'env' && isService) {
      btn.style.display = 'none';
    } else if ((reqPowers && !hasAnyPower(reqPowers)) || (hiddenSecondaryTabs.has(tab) && !isActive)) {
      btn.style.display = 'none';
    } else {
      btn.style.display = '';
    }
    btn.classList.toggle('active', isActive);
    if (isActive) activeBtn = btn;
  });

  const activeTabSig = `${p.id}:${state.currentView}`;
  if (tabsBar && activeBtn && state.lastCenteredWsTab !== activeTabSig) {
    requestAnimationFrame(() => {
      if (centerActiveWebsiteTab(true)) {
        state.lastCenteredWsTab = activeTabSig;
      }
      setTimeout(() => {
        if (centerActiveWebsiteTab(true)) {
          state.lastCenteredWsTab = activeTabSig;
        }
      }, 80);
    });
  }
}

function centerActiveWebsiteTab(smooth = true) {
  const tabsBar = document.getElementById('ws-tabs-bar');
  if (!tabsBar || tabsBar.clientWidth === 0) return false;
  const activeBtn = tabsBar.querySelector('.ws-tab-item.active');
  if (!activeBtn || activeBtn.offsetWidth === 0) return false;

  const barRect = tabsBar.getBoundingClientRect();
  const btnRect = activeBtn.getBoundingClientRect();
  const delta = (btnRect.left + btnRect.width / 2) - (barRect.left + barRect.width / 2);
  const maxScroll = Math.max(0, tabsBar.scrollWidth - tabsBar.clientWidth);
  const targetLeft = Math.min(maxScroll, Math.max(0, tabsBar.scrollLeft + delta));

  if (Math.abs(tabsBar.scrollLeft - targetLeft) > 2) {
    tabsBar.scrollTo({
      left: targetLeft,
      behavior: smooth ? 'smooth' : 'auto',
    });
  }
  return true;
}
window.addEventListener('resize', () => centerActiveWebsiteTab(false));

function syncProjectSelectors() {
  renderWebsiteWorkspaceHeader();
}

// Which kind of item the global "Add" button should create for the current view (null = hide it)
function getGlobalAddKind() {
  const v = state.currentView;
  if (v === 'databases') return 'database';
  if (v === 'services') return 'service';
  if (v === 'projects') return 'website';
  if (WEBSITE_WORKSPACE_TABS.has(v)) {
    if (state.selectedEntityKind === 'database') return 'database';
    const cur = getSelectedProject();
    return cur && cur.project_kind === 'service' ? 'service' : 'website';
  }
  return null;
}

function globalAddAction() {
  const kind = getGlobalAddKind();
  if (kind === 'database') openCreateDatabaseModal();
  else if (kind === 'service') openAddServiceModal();
  else openAddWebsiteModal();
}
window.globalAddAction = globalAddAction;

function renderCurrentView() {
  updateBreadcrumbs();
  renderWebsiteWorkspaceHeader();

  // Close SSE log stream when leaving the logs view so it never holds browser sockets open
  if (state.currentView !== 'logs' && state.logEventSource) {
    state.logEventSource.close();
    state.logEventSource = null;
  }
  if (state.currentView !== 'overview' && typeof window.stopOverviewNetPoller === 'function') {
    window.stopOverviewNetPoller();
  }

  // Close mobile sidebar if open
  document.querySelector('.sidebar')?.classList.remove('mobile-open');
  document.getElementById('sidebar-backdrop')?.classList.remove('active');

  // Update sidebar active classes (highlight 'projects', 'services', or 'databases' when inside a workspace)
  const isInsideCard = WEBSITE_WORKSPACE_TABS.has(state.currentView);
  let activeSidebarView = state.currentView;
  if (isInsideCard) {
    if (state.selectedEntityKind === 'database') {
      activeSidebarView = 'databases';
    } else {
      const curP = getSelectedProject();
      activeSidebarView = (curP && curP.project_kind === 'service') ? 'services' : 'projects';
    }
  }
  document.querySelectorAll('.nav-item').forEach((item) => {
    item.classList.toggle('active', item.getAttribute('data-view') === activeSidebarView);
  });
  document.querySelectorAll('#mobile-bottom-nav .mobile-nav-item[data-mobile-view]').forEach((item) => {
    item.classList.toggle('active', item.getAttribute('data-mobile-view') === activeSidebarView);
  });

  // Switch view section visibility
  document.querySelectorAll('.view-section').forEach((sec) => {
    sec.classList.remove('active');
  });

  const activeSection = document.getElementById(`view-${state.currentView}`);
  if (activeSection) activeSection.classList.add('active');

  // Load relevant view data
  switch (state.currentView) {
    case 'overview': void loadOverview(); break;
    case 'projects': void loadProjectsView(); break;
    case 'services': void loadServicesView(); break;
    case 'databases': void loadDatabasesView(); break;
    case 'github': void loadGithubView(); break;
    case 'deployments': void loadDeploymentsView(); break;
    case 'releases': void loadReleasesView(); break;
    case 'rollbacks': void loadRollbacksView(); break;
    case 'logs': void loadLogsView(); break;
    case 'env': void loadEnvView(); break;
    case 'files': void loadFilesView(); break;
    case 'monitor': void loadMonitorView(); break;
    case 'settings': void loadSettingsView(); break;
    case 'audit': void loadAuditView(); break;
  }
}


window.renderWebsiteWorkspaceHeader = renderWebsiteWorkspaceHeader;
window.updateBreadcrumbs = updateBreadcrumbs;
window.centerActiveWebsiteTab = centerActiveWebsiteTab;
window.syncProjectSelectors = syncProjectSelectors;
window.getGlobalAddKind = getGlobalAddKind;
window.renderCurrentView = renderCurrentView;

export {
  openWebsiteWorkspace,
  openDatabaseWorkspace,
  switchWebsiteTab,
  navigateTo,
  handleHashRoute,
  updateBreadcrumbs,
  renderWebsiteWorkspaceHeader,
  centerActiveWebsiteTab,
  syncProjectSelectors,
  getGlobalAddKind,
  globalAddAction,
  renderCurrentView,
};
