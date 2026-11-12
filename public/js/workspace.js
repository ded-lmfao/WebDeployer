/**
 * WebDep Workspace Router & Controls Subsystem
 * Workspace tabs navigation, breadcrumbs, banner, and direct process lifecycle controls
 */

import { icon } from './icons.js';
import { state, WEBSITE_WORKSPACE_TABS, invalidateClientCache } from './state.js';
import { api, toast, prefetchWebsiteWorkspace } from './api.js';

// Re-export process controls and lifecycle actions submodule
export * from './workspace_actions.js';


function openWebsiteWorkspace(projectId, tab = null) {
  state.selectedProjectId = Number(projectId);
  prefetchWebsiteWorkspace(state.selectedProjectId);
  let targetTab = tab || 'deployments';
  if (targetTab === 'overview') targetTab = 'deployments';
  navigateTo(targetTab, state.selectedProjectId);
}
window.openWebsiteWorkspace = openWebsiteWorkspace;

function switchWebsiteTab(tab) {
  const p = getSelectedProject();
  if (!p) {
    navigateTo('projects');
    return;
  }
  navigateTo(tab, p.id);
}
window.switchWebsiteTab = switchWebsiteTab;

let isInternalNavigation = false;

function navigateTo(viewName, projectId = null) {
  if (!state.user || !state.csrf || state.pendingMfaToken) {
    showLogin();
    return;
  }
  if (viewName === 'backups') viewName = 'releases';
  state.currentView = viewName;
  if (projectId !== null) {
    state.selectedProjectId = Number(projectId);
  }

  const targetHash = projectId ? `#/${viewName}/${projectId}` : `#/${viewName}`;
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
  const pid = parts[1] ? Number(parts[1]) : null;

  state.currentView = view;
  if (pid) state.selectedProjectId = pid;
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
  const p = getSelectedProject();
  const tabLabels = {
    deployments: 'Deployments',
    github: 'GitHub & Commits',
    logs: 'Live Logs',
    env: 'Environment (.env)',
    files: 'Files',
    releases: 'Releases',
    rollbacks: 'Rollbacks',
    monitor: 'Monitoring',
    audit: 'Activity',
  };

  if (isInsideCard && p) {
    const parentView = p.project_kind === 'service' ? 'services' : 'projects';
    const parentLabel = p.project_kind === 'service' ? 'Services' : 'Websites';
    secEl.innerHTML = `<span style="cursor:pointer; color:var(--text-muted);" onclick="navigateTo('${parentView}')">${parentLabel}</span> &rsaquo; <strong style="color:var(--text-main);">${escapeHtml(p.name)}</strong> &rsaquo; <span style="color:var(--accent-light);">${escapeHtml(tabLabels[state.currentView] || state.currentView)}</span>`;
  } else {
    const globalLabels = {
      overview: 'System Overview',
      projects: 'Hosted Websites',
      services: 'Backend Services & Bots',
      databases: 'Managed Databases',
      settings: 'Platform Settings',
    };
    secEl.textContent = globalLabels[state.currentView] || state.currentView;
  }
}

function renderWebsiteWorkspaceHeader() {
  const banner = document.getElementById('website-workspace-banner');
  if (!banner) return;

  const isInsideCard = WEBSITE_WORKSPACE_TABS.has(state.currentView);
  const p = getSelectedProject();
  if (!isInsideCard || !p) {
    banner.style.display = 'none';
    return;
  }

  banner.style.display = 'block';
  const isOnline = p.app_status === 'running';
  const isMaintenance = p.app_status === 'maintenance';
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

  const resItem = (state.overview?.resources || []).find((x) => (x.projectId === p.id || x.project_id === p.id));
  const diskStr = resItem?.diskFormatted || resItem?.disk_formatted || '';

  const bannerSig = `${p.id}:${p.name}:${p.slug}:${p.app_status}:${p.port}:${p.branch}:${p.deployed_sha}:${(p.domains || []).join(',')}:${p.project_kind}:${p.project_type}:${diskStr}`;
  if (state.lastWsBannerSig !== bannerSig) {
    state.lastWsBannerSig = bannerSig;

    const links = document.getElementById('ws-project-links');
    if (links) {
      const sha = p.deployed_sha ? p.deployed_sha.slice(0, 7) : 'Not deployed';
      if (isService) {
        let typeLabel = `${icon('bot', { size: 14 })} Service`;
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
        else if (pt.includes('discord')) typeLabel = `${icon('message-square', { size: 14 })} Discord Bot`;
        else if (pt.includes('telegram')) typeLabel = `${icon('send', { size: 14 })} Telegram Bot`;
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
          ${p.app_pid ? `
            <span class="ws-meta-sep">&bull;</span>
            <span class="ws-meta-item" title="Process PID">PID <strong style="color:var(--text-main); font-weight:600;">${p.app_pid}</strong></span>
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
              ? `<button class="btn btn-success btn-sm" onclick="startProject(${p.id})">
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
            <button class="btn btn-secondary btn-sm" onclick="restartProject(${p.id})" title="Restart process">
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
          ${hasPower('projects_manage') ? `
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
    env: 'env',
  };
  const hiddenSecondaryTabs = new Set(['rollbacks', 'monitor']);

  const depTabLabel = document.getElementById('ws-tab-deployments-label');
  if (depTabLabel) {
    depTabLabel.textContent = isService ? 'Pipeline' : 'Deployments';
  }

  const tabsBar = document.getElementById('ws-tabs-bar');
  let activeBtn = null;
  document.querySelectorAll('#ws-tabs-bar .ws-tab-item').forEach((btn) => {
    const tab = btn.getAttribute('data-ws-tab');
    const reqPower = tabPowerMap[tab];
    const isActive = tab === state.currentView;
    const isLocalService = isService && (!p.repo_url || p.repo_url === 'local' || (p.project_type && p.project_type.includes('lavalink')));
    if (tab === 'files' && !isService) {
      btn.style.display = 'none';
    } else if (isLocalService && (tab === 'github' || tab === 'releases' || tab === 'rollbacks')) {
      btn.style.display = 'none';
    } else if (tab === 'env' && isService) {
      btn.style.display = 'none';
    } else if ((reqPower && !hasPower(reqPower)) || (hiddenSecondaryTabs.has(tab) && !isActive)) {
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
  if (v === 'services') return 'service';
  if (v === 'projects') return 'website';
  if (WEBSITE_WORKSPACE_TABS.has(v)) {
    const cur = getSelectedProject();
    return cur && cur.project_kind === 'service' ? 'service' : 'website';
  }
  return null;
}

function globalAddAction() {
  if (getGlobalAddKind() === 'service') openAddServiceModal();
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

  // Close mobile sidebar if open
  document.querySelector('.sidebar')?.classList.remove('mobile-open');
  document.getElementById('sidebar-backdrop')?.classList.remove('active');

  // Update sidebar active classes (highlight 'projects' or 'services' when inside a workspace)
  const isInsideCard = WEBSITE_WORKSPACE_TABS.has(state.currentView);
  const curP = isInsideCard ? getSelectedProject() : null;
  const activeSidebarView = isInsideCard
    ? (curP && curP.project_kind === 'service' ? 'services' : 'projects')
    : state.currentView;
  document.querySelectorAll('.nav-item').forEach((item) => {
    item.classList.toggle('active', item.getAttribute('data-view') === activeSidebarView);
  });
  document.querySelectorAll('#mobile-bottom-nav .mobile-nav-item[data-mobile-view]').forEach((item) => {
    item.classList.toggle('active', item.getAttribute('data-mobile-view') === activeSidebarView);
  });

  // Adapt global header action button to the active section (website vs backend service)
  const globalAddBtn = document.getElementById('global-add-website-btn');
  if (globalAddBtn) {
    const ctxKind = getGlobalAddKind();
    if (!ctxKind || !hasPower('projects_manage')) {
      globalAddBtn.style.display = 'none';
    } else {
      globalAddBtn.style.display = '';
      const label = ctxKind === 'service' ? 'Add Service' : 'Add Website';
      globalAddBtn.innerHTML = `
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
          <line x1="12" y1="5" x2="12" y2="19"></line>
          <line x1="5" y1="12" x2="19" y2="12"></line>
        </svg>
        <span>${label}</span>
      `;
    }
  }

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
