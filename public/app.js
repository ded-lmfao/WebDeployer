/**
 * WebDep — Frontend Application Controller
 * Single-Page Reactive Client for Self-Hosted Multi-Website Deployment Platform
 */

// ============================================================================
// State Management
// ============================================================================
const PAGE_SIZE = 20;

const state = {
  user: null,
  csrf: null,
  currentView: 'overview',
  selectedProjectId: null,
  projects: [],
  overview: null,
  activeDeployment: null,
  activeDepPollTimer: null,
  overviewTimer: null,
  logEventSource: null,
  logLines: [],
  revealingEnvKey: null,
  projectStatusFilter: 'all',
  pages: {
    overviewRecent: 1,
    commits: 1,
    deployments: 1,
    releases: 1,
    rollbacks: 1,
    envVars: 1,
    backups: 1,
    users: 1,
    audit: 1,
  },
  pageRenderers: {},
};

function paginateAndRender(items, pageKey, paginationElId, renderPageFn) {
  const list = Array.isArray(items) ? items : [];
  const total = list.length;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  let curPage = state.pages[pageKey] || 1;
  if (curPage > totalPages) curPage = totalPages;
  if (curPage < 1) curPage = 1;
  state.pages[pageKey] = curPage;

  const startIdx = (curPage - 1) * PAGE_SIZE;
  const slice = list.slice(startIdx, startIdx + PAGE_SIZE);
  renderPageFn(slice, total, startIdx);

  state.pageRenderers[pageKey] = () => paginateAndRender(list, pageKey, paginationElId, renderPageFn);

  const bar = document.getElementById(paginationElId);
  if (!bar) return;

  if (total === 0) {
    bar.innerHTML = '';
    return;
  }

  const endIdx = Math.min(startIdx + PAGE_SIZE, total);
  const pagesToShow = [];
  const startPage = Math.max(1, curPage - 2);
  const endPage = Math.min(totalPages, startPage + 4);
  for (let p = Math.max(1, endPage - 4); p <= endPage; p++) {
    pagesToShow.push(p);
  }

  bar.innerHTML = `
    <div class="pagination-info">
      Showing <strong>${startIdx + 1}&ndash;${endIdx}</strong> of <strong>${total}</strong> <span style="opacity:0.65;">(${PAGE_SIZE} per page)</span>
    </div>
    <div class="pagination-controls">
      <button type="button" class="page-btn" ${curPage <= 1 ? 'disabled' : ''} onclick="goToTablePage('${pageKey}', ${curPage - 1})">&lsaquo; Prev</button>
      ${pagesToShow.map((p) => `
        <button type="button" class="page-btn ${p === curPage ? 'active' : ''}" onclick="goToTablePage('${pageKey}', ${p})">${p}</button>
      `).join('')}
      <button type="button" class="page-btn" ${curPage >= totalPages ? 'disabled' : ''} onclick="goToTablePage('${pageKey}', ${curPage + 1})">Next &rsaquo;</button>
    </div>
  `;
}

function goToTablePage(pageKey, pageNum) {
  state.pages[pageKey] = Number(pageNum) || 1;
  if (typeof state.pageRenderers[pageKey] === 'function') {
    state.pageRenderers[pageKey]();
  }
}
window.goToTablePage = goToTablePage;

// Pipeline stages in order
const PIPELINE_STAGES = [
  { id: 'pending', label: 'Pending' },
  { id: 'fetching', label: 'Fetching' },
  { id: 'pulling', label: 'Pulling' },
  { id: 'installing', label: 'Installing' },
  { id: 'building', label: 'Building' },
  { id: 'deploying', label: 'Deploying' },
  { id: 'health_checking', label: 'Health Checking' },
];

// Application Presets
const PRESETS = {
  node: {
    port: 3000,
    deploy_method: 'managed',
    install_cmd: 'npm ci',
    build_cmd: '',
    start_cmd: 'node server.js',
    health_url: 'http://127.0.0.1:3000/',
  },
  express: {
    port: 3000,
    deploy_method: 'managed',
    install_cmd: 'npm ci',
    build_cmd: '',
    start_cmd: 'node app.js',
    health_url: 'http://127.0.0.1:3000/',
  },
  nextjs: {
    port: 3000,
    deploy_method: 'managed',
    install_cmd: 'npm ci',
    build_cmd: 'npm run build',
    start_cmd: 'npm run start -- -p {{PORT}}',
    health_url: 'http://127.0.0.1:3000/',
  },
  vite: {
    port: 4173,
    deploy_method: 'managed',
    install_cmd: 'npm ci',
    build_cmd: 'npm run build',
    start_cmd: 'npx vite preview --port {{PORT}} --host 127.0.0.1',
    health_url: 'http://127.0.0.1:4173/',
  },
  python: {
    port: 8000,
    deploy_method: 'managed',
    install_cmd: 'pip install -r requirements.txt',
    build_cmd: '',
    start_cmd: 'uvicorn main:app --host 127.0.0.1 --port {{PORT}}',
    health_url: 'http://127.0.0.1:8000/health',
  },
  java: {
    port: 8080,
    deploy_method: 'managed',
    install_cmd: 'mvn clean package -DskipTests',
    build_cmd: '',
    start_cmd: 'java -jar target/*.jar --server.port={{PORT}}',
    health_url: 'http://127.0.0.1:8080/',
  },
  docker: {
    port: 8080,
    deploy_method: 'docker',
    install_cmd: '',
    build_cmd: '',
    start_cmd: '',
    health_url: 'http://127.0.0.1:8080/',
  },
  'docker-compose': {
    port: 8080,
    deploy_method: 'compose',
    install_cmd: '',
    build_cmd: '',
    start_cmd: '',
    health_url: 'http://127.0.0.1:8080/',
  },
  custom: {
    port: 5000,
    deploy_method: 'managed',
    install_cmd: '',
    build_cmd: '',
    start_cmd: '',
    health_url: '',
  },
};

// ============================================================================
// High-Speed Multi-Tier Client Cache (RAM + sessionStorage + Stale-While-Revalidate)
// ============================================================================
const clientCache = new Map();
const inflightGets = new Map();
const SESSION_CACHE_KEY = 'webdep_fast_cache_v3';

try {
  sessionStorage.removeItem('webdep_fast_cache_v1');
  sessionStorage.removeItem('webdep_fast_cache_v2');
} catch (_) {}

// Hydrate warm cache from sessionStorage on startup
try {
  const raw = sessionStorage.getItem(SESSION_CACHE_KEY);
  if (raw) {
    const parsed = JSON.parse(raw);
    const now = Date.now();
    if (Array.isArray(parsed)) {
      for (const [k, v] of parsed) {
        if (v && typeof v.ts === 'number' && now - v.ts < 60000) {
          clientCache.set(k, v);
        }
      }
    }
  }
} catch (_) {}

function persistCacheToSession() {
  try {
    const entries = Array.from(clientCache.entries()).slice(-60);
    sessionStorage.setItem(SESSION_CACHE_KEY, JSON.stringify(entries));
  } catch (_) {}
}

function getCacheTtlMs(path) {
  if (path.startsWith('/api/logs')) return 0; // Live logs use SSE stream
  if (path.startsWith('/api/overview') || path.startsWith('/api/monitor')) return 2500;
  if (path.startsWith('/api/deployments')) return 4000;
  if (path.startsWith('/api/audit')) return 8000;
  if (path.includes('/commits')) return 45000;
  if (path.includes('/releases') || path.includes('/backups') || path.includes('/env')) return 20000;
  if (path.includes('/caddy') || path.includes('/nginx')) return 60000;
  if (path.startsWith('/api/projects') || path.startsWith('/api/settings') || path.startsWith('/api/users')) return 12000;
  if (path.startsWith('/api/auth/me')) return 15000;
  return 8000;
}

function hasCachedApi(path) {
  return clientCache.has(path);
}
window.hasCachedApi = hasCachedApi;

function invalidateClientCache(prefix = '') {
  if (!prefix) {
    clientCache.clear();
  } else {
    for (const k of clientCache.keys()) {
      if (k.startsWith(prefix) || k.includes(prefix)) {
        clientCache.delete(k);
      }
    }
  }
  try {
    sessionStorage.removeItem(SESSION_CACHE_KEY);
  } catch (_) {}
}
window.invalidateClientCache = invalidateClientCache;

async function networkFetch(path, options = {}) {
  const headers = {
    'Accept': 'application/json',
    ...(options.headers || {}),
  };
  if (state.csrf && options.method && options.method !== 'GET') {
    headers['X-CSRF-Token'] = state.csrf;
  }
  const fetchOpts = { ...options };
  if (fetchOpts.body && typeof fetchOpts.body === 'object' && !(fetchOpts.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
    fetchOpts.body = JSON.stringify(fetchOpts.body);
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), fetchOpts.timeoutMs || 15000);

  let res;
  try {
    res = await fetch(path, {
      credentials: 'same-origin',
      signal: controller.signal,
      ...fetchOpts,
      headers,
    });
  } finally {
    clearTimeout(timeoutId);
  }

  if (res.status === 401 && !path.startsWith('/api/auth/login') && !path.startsWith('/api/auth/2fa/verify-login')) {
    invalidateClientCache();
    showLogin();
    throw new Error('Session expired. Please log in again.');
  }

  const contentType = res.headers.get('content-type') || '';
  let data;
  if (contentType.includes('application/json')) {
    data = await res.json();
  } else {
    data = await res.text();
  }

  if (!res.ok) {
    const errorMsg = (typeof data === 'object' && data.error) ? data.error : (data || res.statusText);
    throw new Error(errorMsg);
  }

  return data;
}

async function api(path, options = {}) {
  const method = (options.method || 'GET').toUpperCase();

  // Any mutation immediately invalidates client cache so subsequent reads are 100% fresh
  if (method !== 'GET') {
    const result = await networkFetch(path, options);
    invalidateClientCache();
    return result;
  }

  const ttl = options.noCache ? 0 : getCacheTtlMs(path);
  const now = Date.now();

  if (ttl > 0 && clientCache.has(path)) {
    const entry = clientCache.get(path);
    const age = now - entry.ts;
    if (age <= ttl) {
      // Fresh cache hit -> 0ms instant return
      return entry.data;
    }
    if (age <= ttl * 6) {
      // Stale-While-Revalidate -> return cached data in 0ms and refresh silently in background
      if (!inflightGets.has(path)) {
        const bgPromise = networkFetch(path, options)
          .then((fresh) => {
            clientCache.set(path, { data: fresh, ts: Date.now(), ttl });
            persistCacheToSession();
            return fresh;
          })
          .catch(() => {})
          .finally(() => inflightGets.delete(path));
        inflightGets.set(path, bgPromise);
      }
      return entry.data;
    }
  }

  // Deduplicate concurrent identical GET requests
  if (inflightGets.has(path)) {
    return inflightGets.get(path);
  }

  const reqPromise = networkFetch(path, options)
    .then((data) => {
      if (ttl > 0) {
        clientCache.set(path, { data, ts: Date.now(), ttl });
        persistCacheToSession();
      }
      return data;
    })
    .finally(() => {
      inflightGets.delete(path);
    });

  inflightGets.set(path, reqPromise);
  return reqPromise;
}

function prefetchWebsiteWorkspace(projectId) {
  const pid = Number(projectId);
  if (!pid) return;
  const endpoints = [
    `/api/deployments?project=${pid}&limit=200`,
    `/api/projects/${pid}/commits`,
    `/api/projects/${pid}/releases`,
    `/api/audit?projectId=${pid}&limit=500`,
  ];
  if (hasPower('env')) endpoints.push(`/api/projects/${pid}/env`);
  if (hasPower('backups')) endpoints.push(`/api/projects/${pid}/backups`);

  // Run non-blocking background warm-up
  setTimeout(() => {
    for (const url of endpoints) {
      if (!clientCache.has(url)) {
        api(url).catch(() => {});
      }
    }
  }, 10);
}
window.prefetchWebsiteWorkspace = prefetchWebsiteWorkspace;

// ============================================================================
// Toasts
// ============================================================================
export function toast(message, type = 'info', duration = 4000) {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.textContent = message;
  container.appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transform = 'translateY(8px)';
    el.style.transition = 'all 0.2s ease';
    setTimeout(() => el.remove(), 250);
  }, duration);
}

// ============================================================================
// Auth & Lifecycle
// ============================================================================
async function initAuth() {
  try {
    const me = await api('/api/auth/me');
    state.user = me.user;
    state.csrf = me.csrf;
    state.activeSessions = me.activeSessions || 1;
    onAuthenticated();
  } catch {
    showLogin();
  }
}

function showLogin() {
  state.pendingMfaToken = null;
  document.getElementById('login-view').style.display = 'flex';
  document.getElementById('app').style.display = 'none';
  const lf = document.getElementById('login-form');
  const mf = document.getElementById('login-2fa-form');
  if (lf) lf.style.display = 'block';
  if (mf) mf.style.display = 'none';
}

function hasPower(power) {
  if (!state.user) return false;
  if (state.user.isMainAdmin) return true;
  const perms = state.user.permissions || [];
  return perms.includes('*') || perms.includes(power);
}
window.hasPower = hasPower;

function onAuthenticated() {
  document.getElementById('login-view').style.display = 'none';
  document.getElementById('app').style.display = 'flex';

  document.getElementById('current-user-name').textContent = state.user.username;
  document.getElementById('current-user-role').textContent = state.user.isMainAdmin ? 'MAIN ADMIN' : (state.user.role || 'operator').toUpperCase();
  document.getElementById('current-user-avatar').textContent = (state.user.username || 'AD').slice(0, 2).toUpperCase();

  // Adapt UI controls to user's granted powers
  const addSiteBtn = document.getElementById('global-add-website-btn');
  if (addSiteBtn) addSiteBtn.style.display = hasPower('projects_manage') ? '' : 'none';

  const navPowerMap = {
    env: 'env',
    domains: 'domains',
    backups: 'backups',
  };
  Object.entries(navPowerMap).forEach(([view, pwr]) => {
    const navEl = document.querySelector(`.nav-item[data-view="${view}"]`);
    if (navEl) navEl.style.display = hasPower(pwr) ? '' : 'none';
  });

  // Load projects & overview
  loadProjects().then(() => {
    handleHashRoute();
    startPolling();
  });
}

// ============================================================================
// Router, Website Card Workspace & Navigation
// ============================================================================
const WEBSITE_WORKSPACE_TABS = new Set([
  'deployments',
  'github',
  'logs',
  'env',
  'releases',
  'rollbacks',
  'backups',
  'monitor',
  'audit',
]);

function openWebsiteWorkspace(projectId, tab = 'deployments') {
  state.selectedProjectId = Number(projectId);
  prefetchWebsiteWorkspace(state.selectedProjectId);
  navigateTo(tab, state.selectedProjectId);
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

function navigateTo(viewName, projectId = null) {
  state.currentView = viewName;
  if (projectId !== null) {
    state.selectedProjectId = Number(projectId);
  }

  window.location.hash = projectId ? `#/${viewName}/${projectId}` : `#/${viewName}`;
  renderCurrentView();
}
window.navigateTo = navigateTo;

function handleHashRoute() {
  const hash = window.location.hash.replace(/^#\/?/, '') || 'overview';
  const parts = hash.split('/');
  const view = parts[0] || 'overview';
  const pid = parts[1] ? Number(parts[1]) : null;

  state.currentView = view;
  if (pid) state.selectedProjectId = pid;
  renderCurrentView();
}

window.addEventListener('hashchange', handleHashRoute);

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
    releases: 'Releases',
    rollbacks: 'Rollbacks',
    backups: 'Backups',
    monitor: 'Monitoring',
    audit: 'Activity',
  };

  if (isInsideCard && p) {
    secEl.innerHTML = `<span style="cursor:pointer; color:var(--text-muted);" onclick="navigateTo('projects')">Websites</span> &rsaquo; <strong style="color:var(--text-main);">${escapeHtml(p.name)}</strong> &rsaquo; <span style="color:var(--accent-light);">${escapeHtml(tabLabels[state.currentView] || state.currentView)}</span>`;
  } else {
    const globalLabels = {
      overview: 'System Overview',
      projects: 'Hosted Websites',
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

  const dot = document.getElementById('ws-status-dot');
  if (dot) dot.className = `status-dot ${isOnline ? 'online' : isMaintenance ? 'maintenance' : 'offline'}`;

  const title = document.getElementById('ws-project-title');
  if (title) title.textContent = p.name;

  const breadcrumbSlug = document.getElementById('ws-breadcrumb-slug');
  if (breadcrumbSlug) breadcrumbSlug.textContent = p.name;

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

  const links = document.getElementById('ws-project-links');
  if (links) {
    const url = p.port ? `http://127.0.0.1:${p.port}` : null;
    const sha = p.deployed_sha ? p.deployed_sha.slice(0, 7) : 'Not deployed';
    const customDomains = Array.isArray(p.domains) ? p.domains.filter(Boolean) : [];
    const domainLinksHtml = customDomains.map((d) => `
      <a class="ws-meta-link active" href="https://${escapeHtml(d)}" target="_blank" style="color:var(--accent-light); font-weight:600;" title="Open custom domain https://${escapeHtml(d)}">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="12" cy="12" r="10"></circle><line x1="2" y1="12" x2="22" y2="12"></line><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path></svg>
        <span>${escapeHtml(d)}</span>
      </a>
      <span class="ws-meta-sep">&bull;</span>
    `).join('');

    links.innerHTML = `
      ${domainLinksHtml}
      ${url ? (isOnline
        ? `<a class="ws-meta-link active" href="${url}" target="_blank" title="Open live website in new tab">
             <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line></svg>
             <span>${url} (Online)</span>
           </a>`
        : isMaintenance
          ? `<a class="ws-meta-link active" href="${url}" target="_blank" style="color:#fbbf24;" title="Open live Maintenance Page in new tab">
               <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"></path></svg>
               <span>${url} (Maintenance)</span>
             </a>`
          : `<span class="ws-meta-link offline" title="Website is offline">
               <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><line x1="1" y1="1" x2="23" y2="23"></line></svg>
               <span>${url} (Offline)</span>
             </span>`
      ) : ''}
      <span class="ws-meta-sep">&bull;</span>
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
      <span class="ws-meta-sep">&bull;</span>
      <span class="ws-meta-item" style="color:var(--text-dim);" title="Container ID">ctr-${escapeHtml(p.slug)}</span>
    `;
  }

  const actions = document.getElementById('ws-project-actions');
  if (actions) {
    actions.innerHTML = `
      <div class="ws-actions-group">
        ${hasPower('deploy') ? `
          <button class="btn btn-primary btn-sm" onclick="deployProject(${p.id})">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polyline points="13 2 13 9 20 9"></polyline><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"></path></svg>
            <span>Deploy</span>
          </button>
          <button class="btn btn-secondary btn-sm" onclick="fetchProjectUpdates(${p.id})" title="Fetch updates from GitHub">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polyline points="23 4 23 10 17 10"></polyline><polyline points="1 20 1 14 7 14"></polyline><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path></svg>
            <span>Fetch</span>
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
            ? `<button class="btn btn-secondary btn-sm ws-btn-stop" onclick="stopProject(${p.id})" title="Completely stop website and release port">
                 <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><rect x="6" y="6" width="12" height="12"></rect></svg>
                 <span>Stop</span>
               </button>`
            : ''
          }
          <button class="btn btn-secondary btn-sm" onclick="restartProject(${p.id})" title="Restart process">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-1.19"></path></svg>
            <span>Restart</span>
          </button>
          <button class="btn btn-secondary btn-sm" onclick="toggleMaintenanceMode(${p.id})" title="${isMaintenance ? 'Exit Maintenance Mode and resume live website' : 'Enable Maintenance Mode (serves Maintenance Page on IP & domain)'}" style="${isMaintenance ? 'background: rgba(245, 158, 11, 0.16); border-color: rgba(245, 158, 11, 0.45); color: #fbbf24;' : ''}">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"></path></svg>
            <span>${isMaintenance ? 'Exit Maintenance' : 'Maintenance'}</span>
          </button>
        ` : ''}
      </div>

      <div class="ws-actions-group">
        ${hasPower('domains') ? `
          <button class="btn btn-secondary btn-sm" onclick="openNginxModal(${p.id})">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="12" cy="12" r="10"></circle><line x1="2" y1="12" x2="22" y2="12"></line><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path></svg>
            <span>Domains &amp; SSL</span>
          </button>
        ` : ''}
        ${hasPower('projects_manage') ? `
          <button class="btn btn-secondary btn-sm" onclick="openEditWebsiteModal(${p.id})">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>
            <span>Settings</span>
          </button>
          <button class="btn btn-sm ws-btn-delete" onclick="deleteProject(${p.id}, '${escapeHtml(p.slug)}')" title="Delete Website">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
          </button>
        ` : ''}
      </div>
    `;
  }

  const tabPowerMap = {
    env: 'env',
    backups: 'backups',
  };

  document.querySelectorAll('#ws-tabs-bar .ws-tab-item').forEach((btn) => {
    const tab = btn.getAttribute('data-ws-tab');
    const reqPower = tabPowerMap[tab];
    if (reqPower && !hasPower(reqPower)) {
      btn.style.display = 'none';
    } else {
      btn.style.display = '';
    }
    btn.classList.toggle('active', tab === state.currentView);
  });
}

function syncProjectSelectors() {
  renderWebsiteWorkspaceHeader();
}

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

  // Update sidebar active classes (highlight 'projects' when inside a website card workspace)
  const activeSidebarView = WEBSITE_WORKSPACE_TABS.has(state.currentView) ? 'projects' : state.currentView;
  document.querySelectorAll('.nav-item').forEach((item) => {
    item.classList.toggle('active', item.getAttribute('data-view') === activeSidebarView);
  });

  // Switch view section visibility
  document.querySelectorAll('.view-section').forEach((sec) => {
    sec.classList.remove('active');
  });

  const activeSection = document.getElementById(`view-${state.currentView}`);
  if (activeSection) activeSection.classList.add('active');

  // Load relevant view data
  switch (state.currentView) {
    case 'overview': loadOverview(); break;
    case 'projects': renderProjectsList(); break;
    case 'github': loadGithubView(); break;
    case 'deployments': loadDeploymentsView(); break;
    case 'releases': loadReleasesView(); break;
    case 'rollbacks': loadRollbacksView(); break;
    case 'logs': loadLogsView(); break;
    case 'env': loadEnvView(); break;
    case 'backups': loadBackupsView(); break;
    case 'monitor': loadMonitorView(); break;
    case 'settings': loadSettingsView(); break;
    case 'audit': loadAuditView(); break;
  }
}

// ============================================================================
// Projects Management
// ============================================================================
async function loadProjects() {
  try {
    state.projects = await api('/api/projects', { noCache: true });
    const badgeEl = document.getElementById('badge-projects-count');
    if (badgeEl) badgeEl.textContent = state.projects.length;

    if (state.projects.length > 0 && !state.selectedProjectId) {
      state.selectedProjectId = state.projects[0].id;
    }
    renderWebsiteWorkspaceHeader();
  } catch (err) {
    toast(`Failed to load projects: ${err.message}`, 'error');
  }
}

function getSelectedProject() {
  return state.projects.find((p) => p.id === state.selectedProjectId) || state.projects[0] || null;
}

// ============================================================================
// View 1: Overview
// ============================================================================
async function loadOverview() {
  try {
    const data = await api('/api/overview');
    state.overview = data;

    // Server Stats
    const m = data.monitor || {};
    document.getElementById('stat-total-projects').textContent = data.projects.length;
    
    let online = 0;
    let offline = 0;
    data.projects.forEach((item) => {
      if (item.app?.running) online++; else offline++;
    });
    document.getElementById('stat-online-count').textContent = online;
    document.getElementById('stat-offline-count').textContent = offline;

    const cpuPct = m.cpu?.pct || 0;
    document.getElementById('stat-cpu-pct').textContent = `${cpuPct}%`;
    const cpuBar = document.getElementById('stat-cpu-bar');
    cpuBar.style.width = `${Math.min(100, cpuPct)}%`;
    cpuBar.className = `progress-fill ${cpuPct > 80 ? 'rose' : cpuPct > 50 ? 'amber' : 'green'}`;

    const memPct = m.memory?.pct || 0;
    document.getElementById('stat-mem-pct').textContent = `${memPct}%`;
    const memBar = document.getElementById('stat-mem-bar');
    memBar.style.width = `${Math.min(100, memPct)}%`;
    memBar.className = `progress-fill ${memPct > 85 ? 'rose' : memPct > 65 ? 'amber' : 'green'}`;

    if (m.disk) {
      const freeGb = (m.disk.free / 1073741824).toFixed(1);
      const totalGb = (m.disk.total / 1073741824).toFixed(1);
      document.getElementById('stat-disk-free').textContent = `${freeGb} GB`;
      document.getElementById('stat-disk-meta').textContent = `${totalGb} GB total (${m.disk.pct}% used)`;
    }

    // Active deployment box
    const active = data.projects.find((x) => x.active);
    const actBox = document.getElementById('overview-active-deployment-box');
    const pOverview = waterPipelines['overview-pipeline-track'];
    if (active && active.active) {
      actBox.style.display = 'block';
      document.getElementById('active-dep-project-name').textContent = active.project.name;
      document.getElementById('active-dep-kind').textContent = active.active.kind.toUpperCase();
      renderPipelineStages('overview-pipeline-track', active.active.stage, active.active.status, active.active.id);
    } else if (pOverview && pOverview.isLooping && pOverview.currentProgress < 6.95) {
      actBox.style.display = 'block';
      document.getElementById('active-dep-kind').textContent = 'DEPLOYED';
      renderPipelineStages('overview-pipeline-track', 'health_checking', 'success', pOverview.lastDeploymentId);
    } else {
      actBox.style.display = 'none';
    }

    // Websites Table & Recent Deployments with change-detection cache
    const sig = `${data.projects.map((x) => `${x.project.id}:${x.project.updated_at}:${x.project.app_status}:${x.app?.running}:${x.behind}:${x.project.deployed_sha}`).join('|')}_${data.recent?.map((x) => `${x.id}:${x.status}:${x.stage}`).join('|')}`;
    if (state.lastOverviewSig !== sig) {
      state.lastOverviewSig = sig;

      // Websites Table
      const tbody = document.getElementById('overview-projects-table');
      if (!data.projects.length) {
        tbody.innerHTML = '<tr><td colspan="7" style="text-align: center; padding: 24px;">No websites created yet. Click "Add Website" to get started.</td></tr>';
      } else {
        tbody.innerHTML = data.projects.map((item) => {
          const p = item.project;
          const isOnline = p.app_status === 'running';
          const isMaintenance = p.app_status === 'maintenance';
          const domains = p.domains && p.domains.length ? p.domains : [];
          const domainLinks = domains.map((d) => `<a class="domain-badge" href="http://${escapeHtml(d)}" target="_blank">${escapeHtml(d)}</a>`).join(' ') ||
            (p.port ? `<a class="domain-badge" href="http://127.0.0.1:${p.port}" target="_blank">http://127.0.0.1:${p.port}</a>` : '<span style="color:var(--text-dim)">Local only</span>');
          const sha = p.deployed_sha ? `<span class="sha-pill">${p.deployed_sha.slice(0, 7)}</span>` : '<span style="color:var(--text-dim)">None</span>';
          
          let behindAhead = '--';
          if (item.behind != null && item.ahead != null) {
            behindAhead = item.behind > 0 ? `<span style="color:var(--warning); font-weight:600;">${item.behind} behind</span>` : '<span style="color:var(--success);">Up to date</span>';
          }

          const lastDep = item.lastSuccess ? `<span style="font-size:12px;">${formatRelativeTime(item.lastSuccess.finished_at || item.lastSuccess.started_at)}</span>` : '<span style="color:var(--text-dim)">Never</span>';

          return `
            <tr style="cursor: pointer;" onclick="openWebsiteWorkspace(${p.id}, 'deployments')">
              <td>
                <strong style="color: var(--accent-light); font-size: 14px;">${escapeHtml(p.name)}</strong>
                <div style="font-size: 11px; color: var(--text-dim);">${escapeHtml(p.slug)} &bull; ${p.project_type}</div>
              </td>
              <td onclick="event.stopPropagation()">${domainLinks}</td>
              <td>
                <span class="status-dot ${isOnline ? 'online' : isMaintenance ? 'maintenance' : 'offline'}"></span>
                <span style="font-weight: 600; font-size: 12px; margin-left: 6px; color: ${isOnline ? 'var(--success)' : isMaintenance ? 'var(--warning)' : 'var(--text-muted)'};">${isOnline ? 'Online' : isMaintenance ? 'Maintenance' : 'Offline'}</span>
              </td>
              <td>${sha}</td>
              <td>${behindAhead}</td>
              <td>${lastDep}</td>
              <td onclick="event.stopPropagation()">
                <div style="display: flex; gap: 6px;">
                  <button class="btn btn-primary btn-sm" onclick="openWebsiteWorkspace(${p.id}, 'deployments')">Open Website &rarr;</button>
                </div>
              </td>
            </tr>
          `;
        }).join('');
      }

      // Recent Deployments (paginated max 20 per page)
      const recBody = document.getElementById('overview-recent-table');
      if (!data.recent || !data.recent.length) {
        recBody.innerHTML = '<tr><td colspan="9" style="text-align: center; padding: 24px;">No recent deployments recorded.</td></tr>';
        const bar = document.getElementById('overview-recent-pagination');
        if (bar) bar.innerHTML = '';
      } else {
        paginateAndRender(data.recent, 'overviewRecent', 'overview-recent-pagination', (slice) => {
          recBody.innerHTML = slice.map((d) => renderDeploymentRow(d)).join('');
        });
      }
    }

  } catch (err) {
    console.error('Overview load error:', err);
  }
}

// ============================================================================
// View 2: Hosted Websites (Projects)
// ============================================================================
function renderProjectsList() {
  const container = document.getElementById('projects-cards-container');
  if (!container) return;

  // Update filter pill counts
  const countAll = state.projects.length;
  const countRunning = state.projects.filter((p) => p.app_status === 'running').length;
  const countStopped = countAll - countRunning;
  const elAll = document.getElementById('filter-count-all');
  const elRunning = document.getElementById('filter-count-running');
  const elStopped = document.getElementById('filter-count-stopped');
  if (elAll) elAll.textContent = countAll;
  if (elRunning) elRunning.textContent = countRunning;
  if (elStopped) elStopped.textContent = countStopped;

  // Sync active pill state
  document.querySelectorAll('#projects-status-filters .pill').forEach((btn) => {
    btn.classList.toggle('active', btn.getAttribute('data-filter') === state.projectStatusFilter);
  });

  const search = (document.getElementById('projects-search-input')?.value || '').toLowerCase();
  const filtered = state.projects.filter((p) => {
    const isOnline = p.app_status === 'running';
    if (state.projectStatusFilter === 'running' && !isOnline) return false;
    if (state.projectStatusFilter === 'stopped' && isOnline) return false;
    return p.name.toLowerCase().includes(search) ||
      p.slug.toLowerCase().includes(search) ||
      (p.domains && p.domains.some((d) => d.toLowerCase().includes(search)));
  });

  if (!filtered.length) {
    container.innerHTML = `
      <div style="grid-column: 1 / -1; text-align: center; padding: 48px; background: var(--bg-card); border-radius: var(--radius-lg); border: 1px dashed var(--border-medium);">
        <p style="font-size: 16px; font-weight: 600; margin-bottom: 8px;">No hosted websites found</p>
        <p style="color: var(--text-muted); font-size: 13px; margin-bottom: 20px;">Add your first website to deploy it directly to your VM.</p>
        <button class="btn btn-primary" onclick="openAddWebsiteModal()">Add New Website</button>
      </div>
    `;
    return;
  }

  container.innerHTML = filtered.map((p) => {
    const isOnline = p.app_status === 'running';
    const isMaintenance = p.app_status === 'maintenance';
    const domains = p.domains && p.domains.length ? p.domains : [];
    const domainBadges = domains.map((d) => `<a class="domain-badge" href="http://${escapeHtml(d)}" target="_blank" onclick="event.stopPropagation()">${escapeHtml(d)} &nearr;</a>`).join(' ') ||
      (p.port ? `<a class="domain-badge" href="http://127.0.0.1:${p.port}" target="_blank" onclick="event.stopPropagation()">http://127.0.0.1:${p.port} &nearr;</a>` : '<span style="color:var(--text-dim); font-size:11px;">No domain assigned</span>');

    const sha = p.deployed_sha ? `<span class="sha-pill">${p.deployed_sha.slice(0, 7)}</span>` : '<span style="color:var(--text-dim)">Not deployed</span>';

    return `
      <div class="project-card" style="cursor: pointer; transition: transform 0.15s ease, border-color 0.15s ease;" onclick="openWebsiteWorkspace(${p.id}, 'deployments')">
        <div class="project-card-header">
          <div>
            <div class="project-info-title">
              <span class="status-dot ${isOnline ? 'online' : isMaintenance ? 'maintenance' : 'offline'}"></span>
              <span>${escapeHtml(p.name)}</span>
            </div>
            <div class="project-info-domains">
              ${domainBadges}
            </div>
          </div>
          <span class="badge ${isOnline ? 'badge-success' : isMaintenance ? 'badge-warning' : 'badge-danger'}">${isOnline ? 'ONLINE' : isMaintenance ? 'MAINTENANCE' : 'OFFLINE'}</span>
        </div>

        <div class="project-meta-row">
          <div class="project-meta-item">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>
            <span>Branch: <strong>${escapeHtml(p.branch)}</strong></span>
          </div>
          <div class="project-meta-item">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><polyline points="16 18 22 12 16 6"></polyline><polyline points="8 6 2 12 8 18"></polyline></svg>
            <span>SHA: ${sha}</span>
          </div>
        </div>

        <div class="project-meta-row" style="margin-top: -6px;">
          <div class="project-meta-item">
            <span>Container: <code>ctr-${escapeHtml(p.slug)}</code></span>
          </div>
          ${p.port ? `<div class="project-meta-item"><span>Port: <strong>${p.port}</strong></span></div>` : ''}
        </div>

        <div class="project-card-actions" onclick="event.stopPropagation()" style="display: flex; justify-content: space-between; align-items: center; width: 100%;">
          <div style="display: flex; gap: 6px;">
            ${isOnline
              ? `<button class="btn btn-danger btn-sm" onclick="stopProject(${p.id})">Stop</button>`
              : `<button class="btn btn-success btn-sm" onclick="startProject(${p.id})">Start</button>`
            }
            <button class="btn btn-secondary btn-sm" onclick="deployProject(${p.id})">Deploy</button>
          </div>
          <button class="btn btn-primary btn-sm" onclick="openWebsiteWorkspace(${p.id}, 'deployments')">
            Manage Website &rarr;
          </button>
        </div>
      </div>
    `;
  }).join('');
}

// Search filter binding
document.getElementById('projects-search-input')?.addEventListener('input', renderProjectsList);

// Status filter pill bindings
document.querySelectorAll('#projects-status-filters .pill').forEach((btn) => {
  btn.addEventListener('click', () => {
    state.projectStatusFilter = btn.getAttribute('data-filter') || 'all';
    renderProjectsList();
  });
});

// ============================================================================
// Add Website Workflow Modal
// ============================================================================
function openAddWebsiteModal() {
  const form = document.getElementById('website-form');
  form.reset();
  document.getElementById('website-form-id').value = '';
  document.getElementById('modal-website-title').textContent = 'Add New Website';
  document.getElementById('save-website-submit-btn').textContent = 'Create Website';
  document.getElementById('website-slug').readOnly = false;
  const detectBtn = document.getElementById('website-detect-btn');
  if (detectBtn) detectBtn.style.display = 'none';

  // Apply default preset (node)
  applyPreset('node');

  openModal('modal-website');
}
window.openAddWebsiteModal = openAddWebsiteModal;

async function openEditWebsiteModal(projectId) {
  const p = state.projects.find((x) => x.id === projectId);
  if (!p) return;

  const form = document.getElementById('website-form');
  form.reset();
  document.getElementById('website-form-id').value = String(p.id);
  document.getElementById('modal-website-title').textContent = `Edit Website: ${p.name}`;
  document.getElementById('save-website-submit-btn').textContent = 'Update Website';

  document.getElementById('website-name').value = p.name || '';
  document.getElementById('website-slug').value = p.slug || '';
  document.getElementById('website-slug').readOnly = true;
  document.getElementById('website-repo').value = p.repo_url || '';
  document.getElementById('website-branch').value = p.branch || 'main';
  document.getElementById('website-domains').value = (p.domains || []).join(', ');
  document.getElementById('website-port').value = p.port || '';
  const cleanDeployDir = (!p.deploy_dir || p.deploy_dir.includes('/var/www/') || p.deploy_dir.includes('\\var\\www\\'))
    ? `./data/sites/${p.slug}`
    : p.deploy_dir;
  document.getElementById('website-deploy-dir').value = cleanDeployDir;
  document.getElementById('website-deploy-method').value = p.deploy_method || 'managed';
  document.getElementById('website-health-url').value = p.health_url || '';
  document.getElementById('website-install-cmd').value = p.install_cmd || '';
  document.getElementById('website-build-cmd').value = p.build_cmd || '';
  document.getElementById('website-start-cmd').value = p.start_cmd || '';
  document.getElementById('website-auto-deploy').checked = Boolean(p.auto_deploy);
  document.getElementById('website-auto-backup').checked = Boolean(p.auto_backup);

  const detectBtn = document.getElementById('website-detect-btn');
  if (detectBtn) detectBtn.style.display = 'inline-flex';

  document.querySelectorAll('#preset-buttons .preset-chip').forEach((c) => {
    c.classList.toggle('active', c.getAttribute('data-type') === p.project_type);
  });

  openModal('modal-website');
}
window.openEditWebsiteModal = openEditWebsiteModal;

async function detectProjectConfiguration() {
  const id = document.getElementById('website-form-id').value;
  if (!id) return;
  toast('Analyzing repository for build & start commands...', 'info');
  try {
    const res = await api(`/api/projects/${id}/detect`, { method: 'POST' });
    if (res.install) document.getElementById('website-install-cmd').value = res.install;
    if (res.build) document.getElementById('website-build-cmd').value = res.build;
    if (res.start) document.getElementById('website-start-cmd').value = res.start;
    if (res.type) {
      document.querySelectorAll('#preset-buttons .preset-chip').forEach((c) => {
        c.classList.toggle('active', c.getAttribute('data-type') === res.type);
      });
    }
    toast(`Detected ${res.type} application configuration!`, 'success');
  } catch (err) {
    toast(`Detection failed: ${err.message}`, 'error');
  }
}
window.detectProjectConfiguration = detectProjectConfiguration;

function getNextAvailablePort(basePort = 3000) {
  const used = new Set((state.projects || []).map((p) => Number(p.port)).filter(Boolean));
  used.add(4600); // Reserve WebDep dashboard port
  let port = Number(basePort) || 3000;
  while (used.has(port)) {
    port++;
  }
  return port;
}

function applyPreset(type) {
  const conf = PRESETS[type] || PRESETS.node;
  document.querySelectorAll('#preset-buttons .preset-chip').forEach((c) => {
    c.classList.toggle('active', c.getAttribute('data-type') === type);
  });

  const isEditing = Boolean(document.getElementById('website-form-id')?.value);
  const assignedPort = isEditing ? (conf.port || 3000) : getNextAvailablePort(conf.port || 3000);
  const healthUrl = (conf.health_url || '').replace(`:${conf.port}`, `:${assignedPort}`);

  document.getElementById('website-port').value = assignedPort || '';
  document.getElementById('website-deploy-method').value = conf.deploy_method || 'managed';
  document.getElementById('website-install-cmd').value = conf.install_cmd || '';
  document.getElementById('website-build-cmd').value = conf.build_cmd || '';
  document.getElementById('website-start-cmd').value = conf.start_cmd || '';
  document.getElementById('website-health-url').value = healthUrl;
}

// Preset chips click
document.querySelectorAll('#preset-buttons .preset-chip').forEach((chip) => {
  chip.addEventListener('click', () => applyPreset(chip.getAttribute('data-type')));
});

// Browse GitHub Repos button
document.getElementById('browse-github-repos-btn')?.addEventListener('click', async () => {
  const sel = document.getElementById('github-repos-select');
  const input = document.getElementById('website-repo');
  try {
    toast('Fetching visible GitHub repositories...', 'info');
    const repos = await api('/api/github/repos');
    if (!repos.length) {
      toast('No repositories found for configured token.', 'info');
      return;
    }
    sel.innerHTML = '<option value="">-- Choose a repository --</option>' +
      repos.map((r) => `<option value="${r.clone_url}">${r.full_name} (${r.private ? 'Private' : 'Public'})</option>`).join('');
    sel.style.display = 'block';
    sel.onchange = () => {
      if (sel.value) {
        input.value = sel.value;
        const selected = repos.find((r) => r.clone_url === sel.value);
        if (selected) {
          document.getElementById('website-branch').value = selected.default_branch || 'main';
          if (!document.getElementById('website-name').value) {
            const shortName = selected.full_name.split('/')[1] || selected.full_name;
            document.getElementById('website-name').value = shortName;
            document.getElementById('website-name').dispatchEvent(new Event('input'));
          }
        }
      }
    };
  } catch (err) {
    toast(`Could not load repos: ${err.message}. Configure your GitHub token in Settings.`, 'warning');
  }
});

// Auto-derive slug and deploy dir
document.getElementById('website-name')?.addEventListener('input', (e) => {
  const name = e.target.value;
  const slugInput = document.getElementById('website-slug');
  const dirInput = document.getElementById('website-deploy-dir');
  if (!document.getElementById('website-form-id').value) {
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
    slugInput.value = slug;
    dirInput.value = slug ? `./data/sites/${slug}` : '';
  }
});

// Submit Add/Edit Website Form
document.getElementById('save-website-submit-btn')?.addEventListener('click', async (e) => {
  e.preventDefault();
  const form = document.getElementById('website-form');
  if (!form.reportValidity()) return;

  const id = document.getElementById('website-form-id').value;
  const domainsStr = document.getElementById('website-domains').value;
  const domains = cleanDomainList(domainsStr);

  const payload = {
    name: document.getElementById('website-name').value.trim(),
    slug: document.getElementById('website-slug').value.trim(),
    repo_url: document.getElementById('website-repo').value.trim(),
    branch: document.getElementById('website-branch').value.trim() || 'main',
    domains,
    port: document.getElementById('website-port').value ? Number(document.getElementById('website-port').value) : null,
    deploy_dir: document.getElementById('website-deploy-dir').value.trim(),
    deploy_method: document.getElementById('website-deploy-method').value,
    health_url: document.getElementById('website-health-url').value.trim(),
    install_cmd: document.getElementById('website-install-cmd').value.trim(),
    build_cmd: document.getElementById('website-build-cmd').value.trim(),
    start_cmd: document.getElementById('website-start-cmd').value.trim(),
    auto_deploy: Boolean(document.getElementById('website-auto-deploy').checked),
    auto_backup: Boolean(document.getElementById('website-auto-backup').checked),
  };

  try {
    if (id) {
      await api(`/api/projects/${id}`, { method: 'PUT', body: payload });
      toast('Website updated in SQLite', 'success');
    } else {
      const res = await api('/api/projects', { method: 'POST', body: payload });
      toast(`Website "${payload.name}" saved in SQLite!`, 'success');
      state.selectedProjectId = res.project ? res.project.id : res.id;
    }
    closeModal('modal-website');
    await loadProjects();
    renderProjectsList();
    if (WEBSITE_WORKSPACE_TABS.has(state.currentView)) {
      renderWebsiteWorkspaceHeader();
    }
  } catch (err) {
    toast(`Save failed: ${err.message}`, 'error');
  }
});

// Delete Project
async function deleteProject(id, slug) {
  const confirmSlug = await showPromptDialog({
    title: 'Delete Website',
    message: `CAUTION: Deleting this website will remove its configuration from SQLite and stop its running process.\n\nType the website slug "${slug}" below to confirm deletion:`,
    placeholder: slug,
    confirmText: 'Delete Website',
    danger: true,
  });
  if (confirmSlug === null) return;
  if (confirmSlug.trim() !== slug) {
    toast('Slug confirmation did not match. Deletion cancelled.', 'warning');
    return;
  }

  try {
    await api(`/api/projects/${id}`, { method: 'DELETE', body: { confirm: slug } });
    toast(`Website "${slug}" deleted.`, 'success');
    if (state.selectedProjectId === id) state.selectedProjectId = null;
    await loadProjects();
    navigateTo('projects');
  } catch (err) {
    toast(`Delete failed: ${err.message}`, 'error');
  }
}
window.deleteProject = deleteProject;

// ============================================================================
// View 3: GitHub View
// ============================================================================
async function loadGithubView() {
  const p = getSelectedProject();
  if (!p) return;

  const repoBox = document.getElementById('github-repo-details');
  repoBox.innerHTML = `
    <div style="display: flex; flex-direction: column; gap: 8px;">
      <div><strong>Repository:</strong> <a href="${escapeHtml(p.repo_url)}" target="_blank" style="color: var(--accent-light);">${escapeHtml(p.repo_url)}</a></div>
      <div><strong>Branch:</strong> <code>${escapeHtml(p.branch)}</code></div>
      <div><strong>Mirror Location:</strong> <code>${escapeHtml(p.deploy_dir)}/repo.git</code></div>
      <div><strong>Auto-Deploy on Push:</strong> ${p.auto_deploy ? '<span class="badge badge-success">Enabled</span>' : '<span class="badge badge-neutral">Disabled</span>'}</div>
      <div style="margin-top: 6px;">
        <button class="btn btn-secondary btn-sm" onclick="generateDeployKey(${p.id})">Generate SSH Deploy Key</button>
      </div>
    </div>
  `;

  const webhookBox = document.getElementById('github-webhook-details');
  const webhookUrl = `${window.location.origin}/api/webhooks/github/${p.slug}`;
  webhookBox.innerHTML = `
    <div style="display: flex; flex-direction: column; gap: 8px;">
      <div><strong>Payload URL:</strong></div>
      <div style="display: flex; gap: 6px;">
        <input type="text" class="form-control" value="${webhookUrl}" readonly style="font-size: 11px;">
        <button class="btn btn-secondary btn-sm" onclick="navigator.clipboard.writeText('${webhookUrl}'); toast('Webhook URL copied!', 'success');">Copy</button>
      </div>
      <div style="font-size: 12px; color: var(--text-dim);">Content type: <code>application/json</code>, Secret: Configured securely</div>
      <div>
        <button class="btn btn-secondary btn-sm" onclick="rotateWebhookSecret(${p.id})">Rotate Webhook Secret</button>
      </div>
    </div>
  `;

  document.getElementById('github-branch-badge').textContent = p.branch;

  // Load Commits
  const tbody = document.getElementById('github-commits-table');
  const commitsPath = `/api/projects/${p.id}/commits`;
  if (!hasCachedApi(commitsPath)) {
    tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; padding: 24px;">Loading commits from mirror...</td></tr>';
  }
  try {
    const commits = await api(commitsPath);
    if (!commits.length) {
      tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; padding: 24px;">No commits found. Click "Fetch Updates" above to sync with GitHub.</td></tr>';
      const bar = document.getElementById('github-commits-pagination');
      if (bar) bar.innerHTML = '';
      return;
    }
    paginateAndRender(commits, 'commits', 'github-commits-pagination', (slice) => {
      tbody.innerHTML = slice.map((c) => {
        const isLive = c.live;
        return `
          <tr>
            <td><span class="sha-pill">${c.shortSha || c.sha.slice(0, 7)}</span></td>
            <td style="max-width: 320px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-weight: 500;">
              ${escapeHtml(c.message)}
            </td>
            <td>${escapeHtml(c.author || 'Unknown')}</td>
            <td>${formatDate(c.date)}</td>
            <td>
              ${isLive ? '<span class="badge badge-success">LIVE</span>' : c.deployedBefore ? '<span class="badge badge-neutral">Previously Deployed</span>' : '<span style="color:var(--text-dim)">-</span>'}
            </td>
            <td>
              <button class="btn btn-primary btn-sm" onclick="deployProject(${p.id}, '${c.sha}')" ${isLive ? 'disabled' : ''}>
                Deploy Commit
              </button>
            </td>
          </tr>
        `;
      }).join('');
    });
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="6" style="text-align: center; color: var(--danger); padding: 24px;">${escapeHtml(err.message)}</td></tr>`;
  }
}

async function generateDeployKey(projectId) {
  try {
    const res = await api(`/api/projects/${projectId}/deploy-key`, { method: 'POST' });
    await showCopyDialog({
      title: 'SSH Deploy Key (Saved in SQLite)',
      message: 'Add this public key to your GitHub repository under Settings -> Deploy Keys (allow read access):',
      value: res.publicKey,
    });
  } catch (err) {
    toast(`Failed to generate deploy key: ${err.message}`, 'error');
  }
}
window.generateDeployKey = generateDeployKey;

async function rotateWebhookSecret(projectId) {
  const ok = await showConfirmDialog({
    title: 'Rotate GitHub Webhook Secret',
    message: 'Rotate the GitHub webhook secret for this website? You will need to update the secret in your GitHub repository webhook settings.',
    confirmText: 'Rotate Secret',
  });
  if (!ok) return;
  try {
    const res = await api(`/api/projects/${projectId}/webhook-secret/rotate`, { method: 'POST' });
    toast('Webhook secret rotated and saved in SQLite.', 'success');
    await showCopyDialog({
      title: 'New GitHub Webhook Secret',
      message: 'Paste this secret into your GitHub repository Webhook Secret field:',
      value: res.webhookSecret,
    });
  } catch (err) {
    toast(`Failed to rotate secret: ${err.message}`, 'error');
  }
}
window.rotateWebhookSecret = rotateWebhookSecret;

// Check GitHub button
document.getElementById('github-check-btn')?.addEventListener('click', async () => {
  const p = getSelectedProject();
  if (!p) return;
  try {
    const res = await api(`/api/projects/${p.id}/check`, { method: 'POST' });
    if (res.needsFetch) {
      toast(`New commits detected on remote (${res.remote_sha.slice(0, 7)})! Fetching...`, 'info');
      await api(`/api/projects/${p.id}/fetch`, { method: 'POST' });
      await loadGithubView();
    } else {
      toast('Repository is up to date with remote.', 'success');
    }
  } catch (err) {
    toast(`Check failed: ${err.message}`, 'error');
  }
});

// Fetch Updates button
document.getElementById('github-fetch-btn')?.addEventListener('click', async () => {
  const p = getSelectedProject();
  if (!p) return;
  fetchProjectUpdates(p.id);
});

async function fetchProjectUpdates(projectId) {
  toast('Fetching latest commits from GitHub...', 'info');
  try {
    const res = await api(`/api/projects/${projectId}/fetch`, { method: 'POST', timeoutMs: 30000 });
    const shortSha = res.sha ? res.sha.slice(0, 7) : 'latest';
    toast(`Fetched latest updates (${shortSha}) from GitHub!`, 'success');
    await loadProjects();
    if (state.currentView === 'projects') renderProjectsList();
    if (state.currentView === 'github') loadGithubView();
    if (state.currentView === 'overview') loadOverview();
  } catch (err) {
    toast(`Fetch failed: ${err.message}`, 'error');
  }
}
window.fetchProjectUpdates = fetchProjectUpdates;

// ============================================================================
// View 4: Deployments Pipeline
// ============================================================================
async function loadDeploymentsView() {
  const p = getSelectedProject();
  const query = p ? `?project=${p.id}&limit=200` : '?limit=200';
  const tbody = document.getElementById('deployments-table-body');

  try {
    const deployments = await api(`/api/deployments${query}`);
    if (!deployments.length) {
      tbody.innerHTML = '<tr><td colspan="9" style="text-align: center; padding: 24px;">No deployments found.</td></tr>';
      const bar = document.getElementById('deployments-pagination');
      if (bar) bar.innerHTML = '';
      return;
    }

    // Check if any deployment is active
    const active = deployments.find((d) => d.status === 'running' || d.status === 'pending');
    state.activeDeployment = active || null;
    const badge = document.getElementById('pipeline-status-badge');
    const latest = deployments.length ? deployments[0] : null;

    if (active) {
      badge.textContent = `${active.kind.toUpperCase()} (${active.stage.toUpperCase()})`;
      badge.className = 'badge badge-warning';
      renderPipelineStages('main-pipeline-track', active.stage, active.status, active.id);
    } else if (latest) {
      const p = waterPipelines['main-pipeline-track'];
      if (latest.status === 'success') {
        if (p && p.currentProgress < 6.95 && p.lastDeploymentId === latest.id) {
          badge.textContent = 'FINALIZING DEPLOYMENT...';
          badge.className = 'badge badge-warning';
          renderPipelineStages('main-pipeline-track', 'health_checking', 'success', latest.id);
        } else {
          badge.textContent = 'DEPLOYED (LIVE)';
          badge.className = 'badge badge-success';
          renderPipelineStages('main-pipeline-track', 'health_checking', 'success', latest.id);
        }
      } else if (latest.status === 'failed') {
        badge.textContent = `FAILED (${latest.stage.toUpperCase()})`;
        badge.className = 'badge badge-danger';
        renderPipelineStages('main-pipeline-track', latest.stage, 'failed', latest.id);
      } else {
        badge.textContent = 'IDLE';
        badge.className = 'badge badge-neutral';
        renderPipelineStages('main-pipeline-track', 'idle', 'idle');
      }
    } else {
      badge.textContent = 'IDLE';
      badge.className = 'badge badge-neutral';
      renderPipelineStages('main-pipeline-track', 'idle', 'idle');
    }

    paginateAndRender(deployments, 'deployments', 'deployments-pagination', (slice) => {
      tbody.innerHTML = slice.map((d) => renderDeploymentRow(d)).join('');
    });
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="9" style="text-align: center; color: var(--danger); padding: 24px;">${escapeHtml(err.message)}</td></tr>`;
  }
}
window.loadDeploymentsView = loadDeploymentsView;

// ============================================================================
// Organic Fluid Water Pipeline Engine
// ============================================================================
const waterPipelines = {};

function initWaterPipelineDOM(container, containerId) {
  container.innerHTML = `
    <div class="water-pipeline-wrapper" id="water-wrapper-${containerId}">
      ${PIPELINE_STAGES.map((s, idx) => `
        <div class="water-stage-unit" data-unit-idx="${idx}">
          <div class="water-node-vial" data-vial-idx="${idx}">
            <div class="water-vial-bg"></div>
            <div class="water-vial-liquid" style="height: 0%;">
              <div class="water-wave-surface"></div>
            </div>
            <div class="water-vial-content">
              <span class="water-vial-num">${idx + 1}</span>
              <svg class="water-vial-icon water-vial-check" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3">
                <polyline points="20 6 9 17 4 12"></polyline>
              </svg>
              <svg class="water-vial-icon water-vial-cross" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3">
                <line x1="18" y1="6" x2="6" y2="18"></line>
                <line x1="6" y1="6" x2="18" y2="18"></line>
              </svg>
            </div>
          </div>
          <div class="water-node-info">
            <div class="water-node-name">${s.label}</div>
            <div class="water-node-sub">Queued</div>
          </div>
          ${idx < PIPELINE_STAGES.length - 1 ? `
            <div class="water-pipe-segment" data-pipe-idx="${idx}">
              <div class="water-pipe-glass">
                <div class="water-pipe-liquid" style="width: 0%;">
                  <div class="water-pipe-meniscus"></div>
                </div>
              </div>
            </div>
          ` : ''}
        </div>
      `).join('')}
    </div>
  `;
}

function updateWaterDOM(pipeline) {
  const container = document.getElementById(pipeline.containerId);
  if (!container) return;

  const P = pipeline.currentProgress;
  const isFailed = pipeline.status === 'failed';
  const isSuccess = pipeline.status === 'success';
  const activeIdx = pipeline.activeStageIdx ?? -1;
  const failedIdx = isFailed ? pipeline.failedStageIdx : -1;

  PIPELINE_STAGES.forEach((s, idx) => {
    const unit = container.querySelector(`.water-stage-unit[data-unit-idx="${idx}"]`);
    if (!unit) return;

    const vial = unit.querySelector('.water-node-vial');
    const liquid = unit.querySelector('.water-vial-liquid');
    const num = unit.querySelector('.water-vial-num');
    const check = unit.querySelector('.water-vial-check');
    const cross = unit.querySelector('.water-vial-cross');
    const name = unit.querySelector('.water-node-name');
    const sub = unit.querySelector('.water-node-sub');

    // Stage fill level: fills between P = idx and P = idx + 0.6
    let vialHeight = 0;
    if (P >= idx + 0.6) {
      vialHeight = 100;
    } else if (P > idx) {
      vialHeight = Math.min(100, Math.max(0, ((P - idx) / 0.6) * 100));
    }

    if (liquid) liquid.style.height = `${vialHeight.toFixed(1)}%`;

    // 1. Failed Stage
    if (isFailed && idx === failedIdx && P >= idx + 0.5) {
      if (vial) vial.className = 'water-node-vial failed';
      if (num) num.style.display = 'none';
      if (check) check.style.display = 'none';
      if (cross) cross.style.display = 'block';
      if (sub) { sub.textContent = 'Failed'; sub.className = 'water-node-sub failed'; }
      if (name) name.className = 'water-node-name failed';
    }
    // 2. Completed Stage:
    // Past stage already completed by backend AND water has poured through it,
    // OR entire pipeline is successful and water reached this stage!
    else if ((idx < activeIdx && P >= idx + 0.6) || (isSuccess && P >= idx + 0.6)) {
      if (vial) vial.className = 'water-node-vial completed';
      if (num) num.style.display = 'none';
      if (check) check.style.display = 'block';
      if (cross) cross.style.display = 'none';
      if (sub) { sub.textContent = 'Done'; sub.className = 'water-node-sub completed'; }
      if (name) name.className = 'water-node-name completed';
    }
    // 3. Active Stage: currently filling or holding water while running
    else if (P > idx) {
      if (vial) vial.className = 'water-node-vial active';
      if (num) num.style.display = 'block';
      if (check) check.style.display = 'none';
      if (cross) cross.style.display = 'none';
      if (sub) {
        if (vialHeight >= 99) {
          sub.textContent = `${s.label}...`;
        } else {
          sub.textContent = 'Filling...';
        }
        sub.className = 'water-node-sub active';
      }
      if (name) name.className = 'water-node-name active';
    }
    // 4. Queued / Idle Stage
    else {
      if (vial) vial.className = 'water-node-vial queued';
      if (num) num.style.display = 'block';
      if (check) check.style.display = 'none';
      if (cross) cross.style.display = 'none';
      if (sub) {
        sub.textContent = pipeline.status === 'idle' ? 'Idle' : 'Queued';
        sub.className = 'water-node-sub queued';
      }
      if (name) name.className = 'water-node-name queued';
    }

    // Pipe fill level (pipe idx connects stage idx to stage idx + 1):
    // Pipe idx fills between P = idx + 0.6 and P = idx + 1.0
    if (idx < PIPELINE_STAGES.length - 1) {
      const pipeLiquid = unit.querySelector('.water-pipe-liquid');
      const meniscus = unit.querySelector('.water-pipe-meniscus');
      if (pipeLiquid) {
        let pipeWidth = 0;
        if (P >= idx + 1.0) {
          pipeWidth = 100;
          pipeLiquid.className = 'water-pipe-liquid filled';
          if (meniscus) meniscus.style.opacity = '0';
        } else if (P > idx + 0.6) {
          pipeWidth = Math.min(100, Math.max(0, ((P - (idx + 0.6)) / 0.4) * 100));
          pipeLiquid.className = 'water-pipe-liquid flowing';
          if (meniscus) meniscus.style.opacity = '1';
        } else {
          pipeWidth = 0;
          pipeLiquid.className = 'water-pipe-liquid empty';
          if (meniscus) meniscus.style.opacity = '0';
        }
        pipeLiquid.style.width = `${pipeWidth.toFixed(1)}%`;
      }
    }
  });

  // When all 7 stages are filled and deployment succeeded, mark pipeline status deployed!
  if (isSuccess && P >= 6.95) {
    const badge = document.getElementById('pipeline-status-badge');
    if (badge && !badge.textContent.includes('DEPLOYED')) {
      badge.textContent = 'DEPLOYED (LIVE)';
      badge.className = 'badge badge-success';
    }
    const overviewBadge = document.getElementById('active-dep-kind');
    if (overviewBadge && !overviewBadge.textContent.includes('LIVE')) {
      overviewBadge.textContent = 'DEPLOYED';
      overviewBadge.className = 'badge badge-success';
    }
    renderWebsiteWorkspaceHeader();
  }
}

function startWaterLoop(pipeline) {
  if (pipeline.isLooping) return;
  pipeline.isLooping = true;

  function step() {
    const container = document.getElementById(pipeline.containerId);
    if (!container) {
      pipeline.isLooping = false;
      return;
    }

    const diff = pipeline.targetProgress - pipeline.currentProgress;

    // Organic, steady water pouring pace (~2.3s per stage at 60fps)
    const speed = 0.007;

    if (Math.abs(diff) > 0.0005) {
      if (diff > 0) {
        pipeline.currentProgress = Math.min(pipeline.targetProgress, pipeline.currentProgress + speed);
      } else {
        pipeline.currentProgress = Math.max(pipeline.targetProgress, pipeline.currentProgress - speed * 3);
      }
      updateWaterDOM(pipeline);
      requestAnimationFrame(step);
    } else {
      pipeline.currentProgress = pipeline.targetProgress;
      updateWaterDOM(pipeline);
      pipeline.isLooping = false;
    }
  }

  requestAnimationFrame(step);
}

function renderPipelineStages(containerId, currentStage, currentStatus, depId = null) {
  const container = document.getElementById(containerId);
  if (!container) return;

  // Initialize persistent DOM structure once (never destroy innerHTML on polling ticks!)
  if (!container.querySelector('.water-pipeline-wrapper')) {
    initWaterPipelineDOM(container, containerId);
    waterPipelines[containerId] = {
      containerId,
      currentProgress: (currentStatus === 'success' ? 7.0 : 0.0),
      targetProgress: (currentStatus === 'success' ? 7.0 : 0.0),
      status: currentStatus,
      activeStageIdx: -1,
      failedStageIdx: -1,
      lastDeploymentId: depId,
      isLooping: false,
    };
  }

  let pipeline = waterPipelines[containerId];
  if (!pipeline) {
    pipeline = {
      containerId,
      currentProgress: (currentStatus === 'success' ? 7.0 : 0.0),
      targetProgress: (currentStatus === 'success' ? 7.0 : 0.0),
      status: currentStatus,
      activeStageIdx: -1,
      failedStageIdx: -1,
      lastDeploymentId: depId,
      isLooping: false,
    };
    waterPipelines[containerId] = pipeline;
  }

  // If a new deployment started with different depId, reset water to start
  if (depId && pipeline.lastDeploymentId && pipeline.lastDeploymentId !== depId && (currentStatus === 'running' || currentStatus === 'pending')) {
    pipeline.currentProgress = 0.0;
    pipeline.lastDeploymentId = depId;
  } else if (depId && !pipeline.lastDeploymentId) {
    pipeline.lastDeploymentId = depId;
  }

  pipeline.status = currentStatus;
  const currentIndex = PIPELINE_STAGES.findIndex((s) => s.id === currentStage);

  if (currentStatus === 'idle') {
    pipeline.targetProgress = 0.0;
    pipeline.activeStageIdx = -1;
    pipeline.failedStageIdx = -1;
  } else if (currentStatus === 'failed') {
    pipeline.failedStageIdx = currentIndex >= 0 ? currentIndex : 0;
    pipeline.activeStageIdx = pipeline.failedStageIdx;
    pipeline.targetProgress = pipeline.failedStageIdx + 0.6;
  } else if (currentStatus === 'success') {
    pipeline.activeStageIdx = PIPELINE_STAGES.length - 1;
    pipeline.failedStageIdx = -1;
    pipeline.targetProgress = 7.0;
  } else {
    // Stage in progress: water flows smoothly up to this stage and holds firmly in its vial!
    pipeline.activeStageIdx = currentIndex >= 0 ? currentIndex : 0;
    pipeline.failedStageIdx = -1;
    pipeline.targetProgress = pipeline.activeStageIdx + 0.6;
  }

  startWaterLoop(pipeline);
}

function resetWaterPipeline(containerId) {
  const p = waterPipelines[containerId];
  if (p) {
    p.currentProgress = 0.0;
    p.targetProgress = 0.6;
    p.status = 'running';
    p.activeStageIdx = 0;
    p.failedStageIdx = -1;
    p.lastDeploymentId = null;
    updateWaterDOM(p);
    startWaterLoop(p);
  }
}
window.resetWaterPipeline = resetWaterPipeline;

window.simulateWaterDeploy = function() {
  const stages = ['pending', 'fetching', 'pulling', 'installing', 'building', 'deploying', 'health_checking'];
  let sIdx = 0;
  const track = document.getElementById('main-pipeline-track') ? 'main-pipeline-track' : 'overview-pipeline-track';
  const badge = document.getElementById('pipeline-status-badge');
  if (badge) {
    badge.textContent = `DEPLOY (${stages[0].toUpperCase()})`;
    badge.className = 'badge badge-warning';
  }
  if (waterPipelines[track]) {
    waterPipelines[track].currentProgress = 0;
  }
  renderPipelineStages(track, stages[0], 'running', Date.now());

  const interval = setInterval(() => {
    sIdx++;
    if (sIdx < stages.length) {
      if (badge) badge.textContent = `DEPLOY (${stages[sIdx].toUpperCase()})`;
      renderPipelineStages(track, stages[sIdx], 'running', Date.now());
    } else {
      clearInterval(interval);
      if (badge) badge.textContent = 'FINALIZING DEPLOYMENT...';
      renderPipelineStages(track, 'health_checking', 'success', Date.now());
    }
  }, 2600);
};

function renderDeploymentRow(d) {
  let badgeClass = 'badge-neutral';
  if (d.status === 'success') badgeClass = 'badge-success';
  else if (d.status === 'failed') badgeClass = 'badge-danger';
  else if (d.status === 'running' || d.status === 'pending') badgeClass = 'badge-warning';

  const sha = d.sha ? `<span class="sha-pill">${d.sha.slice(0, 7)}</span>` : '--';
  const duration = d.finished_at && d.started_at ? `${Math.round((d.finished_at - d.started_at) / 1000)}s` : (d.status === 'running' ? 'In progress...' : '--');

  return `
    <tr>
      <td><strong>#${d.id}</strong></td>
      <td><strong>${escapeHtml(d.project_name || 'Project')}</strong></td>
      <td><span class="badge badge-neutral">${d.kind}</span></td>
      <td><span style="font-size:12px;">${escapeHtml(d.trigger || 'manual')} (${escapeHtml(d.actor || 'system')})</span></td>
      <td>${sha}</td>
      <td>${duration}</td>
      <td><span class="badge ${badgeClass}">${d.status}</span></td>
      <td><span style="font-size:12px;">${formatRelativeTime(d.started_at)}</span></td>
      <td>
        <button class="btn btn-secondary btn-sm" onclick="openDeploymentDetails(${d.id})">Details & Logs</button>
      </td>
    </tr>
  `;
}

// Deploy button trigger
async function deployProject(projectId, sha = null) {
  const p = state.projects.find((x) => x.id === projectId) || getSelectedProject();
  if (!p) return;

  try {
    resetWaterPipeline('main-pipeline-track');
    resetWaterPipeline('overview-pipeline-track');
    const res = await api(`/api/projects/${p.id}/deploy`, { method: 'POST', body: sha ? { sha } : {} });
    toast(`Deployment #${res.deploymentId} started for ${p.name}!`, 'success');
    navigateTo('deployments', p.id);
  } catch (err) {
    toast(`Deployment failed to start: ${err.message}`, 'error');
  }
}
window.deployProject = deployProject;

document.getElementById('trigger-deploy-btn')?.addEventListener('click', () => {
  const p = getSelectedProject();
  if (p) deployProject(p.id);
});

// Deployment Details Modal
async function openDeploymentDetails(depId) {
  const title = document.getElementById('dep-details-title');
  const meta = document.getElementById('dep-details-meta');
  const logsDiv = document.getElementById('dep-details-logs');

  title.textContent = `Deployment #${depId} Details`;
  meta.innerHTML = '<span style="color:var(--text-dim)">Loading deployment record...</span>';
  logsDiv.innerHTML = '<span style="color:var(--text-dim)">Fetching logs...</span>';
  openModal('modal-dep-details');

  try {
    const data = await api(`/api/deployments/${depId}`);
    const d = data.deployment;
    const dur = d.finished_at ? `${Math.round((d.finished_at - d.started_at) / 1000)} seconds` : 'Still running...';

    meta.innerHTML = `
      <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; font-size: 13px; margin-bottom: 12px; background: var(--bg-card); padding: 12px; border-radius: var(--radius-md);">
        <div><strong>Status:</strong> <span class="badge ${d.status === 'success' ? 'badge-success' : d.status === 'failed' ? 'badge-danger' : 'badge-warning'}">${d.status}</span></div>
        <div><strong>Kind:</strong> ${d.kind}</div>
        <div><strong>Trigger:</strong> ${d.trigger} (${d.actor})</div>
        <div><strong>Commit:</strong> ${d.sha ? `<span class="sha-pill">${d.sha.slice(0, 7)}</span>` : '--'}</div>
        <div><strong>Duration:</strong> ${dur}</div>
        <div><strong>Date:</strong> ${new Date(d.started_at).toLocaleString()}</div>
      </div>
      ${d.error ? `<div style="background: var(--danger-bg); border: 1px solid var(--danger-border); padding: 10px; border-radius: var(--radius-md); color: var(--danger); font-size: 13px; margin-bottom: 12px;"><strong>Error:</strong> ${escapeHtml(d.error)}</div>` : ''}
    `;

    if (!data.logs || !data.logs.length) {
      logsDiv.innerHTML = '<div class="log-line"><span class="log-lvl-info">No logs recorded for this deployment.</span></div>';
    } else {
      logsDiv.innerHTML = data.logs.map((l) => formatLogLine(l)).join('');
      logsDiv.scrollTop = logsDiv.scrollHeight;
    }
  } catch (err) {
    meta.innerHTML = `<span style="color:var(--danger);">${escapeHtml(err.message)}</span>`;
  }
}
window.openDeploymentDetails = openDeploymentDetails;

// ============================================================================
// View 5: Releases
// ============================================================================
async function loadReleasesView() {
  const p = getSelectedProject();
  const tbody = document.getElementById('releases-table-body');
  if (!p) return;

  try {
    const releases = await api(`/api/projects/${p.id}/releases`, { noCache: true });
    if (!releases.length) {
      tbody.innerHTML = '<tr><td colspan="9" style="text-align: center; padding: 24px;">No releases created yet.</td></tr>';
      const bar = document.getElementById('releases-pagination');
      if (bar) bar.innerHTML = '';
      return;
    }

    paginateAndRender(releases, 'releases', 'releases-pagination', (slice) => {
      tbody.innerHTML = slice.map((r) => {
        const isLive = r.live;
        return `
          <tr>
            <td><strong>Release #${r.id}</strong></td>
            <td><span class="sha-pill">${r.short_sha || r.sha.slice(0, 7)}</span></td>
            <td style="max-width: 240px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${escapeHtml(r.message || '')}</td>
            <td>${escapeHtml(r.author || 'Unknown')}</td>
            <td>${formatDate(r.deployed_at || r.created_at)}</td>
            <td><span class="badge ${r.build_status === 'success' ? 'badge-success' : 'badge-neutral'}">${r.build_status}</span></td>
            <td><span class="badge ${r.health_status === 'ok' ? 'badge-success' : 'badge-neutral'}">${r.health_status}</span></td>
            <td>${isLive ? '<span class="badge badge-success">LIVE</span>' : '<span class="badge badge-neutral">Retained</span>'}</td>
            <td>
              <div style="display: flex; gap: 6px;">
                ${!isLive && r.status === 'succeeded' ? `<button class="btn btn-primary btn-sm" onclick="rollbackToRelease(${p.id}, ${r.id})">Rollback</button>` : ''}
                ${r.deployment_id ? `<button class="btn btn-secondary btn-sm" onclick="openDeploymentDetails(${r.deployment_id})">Logs</button>` : ''}
                ${!isLive ? `<button class="btn btn-danger btn-sm" onclick="deleteRelease(${p.id}, ${r.id})">Delete</button>` : ''}
              </div>
            </td>
          </tr>
        `;
      }).join('');
    });
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="9" style="text-align: center; color: var(--danger); padding: 24px;">${escapeHtml(err.message)}</td></tr>`;
  }
}
window.loadReleasesView = loadReleasesView;

// ============================================================================
// View 6: Instant Rollback Cockpit
// ============================================================================
async function loadRollbacksView() {
  const p = getSelectedProject();
  if (!p) return;

  const liveInfo = document.getElementById('rollback-live-info');
  const tbody = document.getElementById('rollbacks-table-body');

  try {
    const releases = await api(`/api/projects/${p.id}/releases`, { noCache: true });
    const live = releases.find((r) => r.live);

    if (live) {
      liveInfo.innerHTML = `Release #${live.id} &bull; Commit <span class="sha-pill">${live.sha.slice(0, 7)}</span> &bull; <em>"${escapeHtml(live.message || 'No commit message')}"</em> &bull; Deployed ${formatRelativeTime(live.deployed_at || live.created_at)}`;
    } else {
      liveInfo.textContent = 'No live release active currently.';
    }

    const eligible = releases.filter((r) => !r.live && r.status === 'succeeded' && r.available);

    if (!eligible.length) {
      tbody.innerHTML = '<tr><td colspan="7" style="text-align: center; padding: 24px;">No earlier successful releases available for rollback yet. Releases are retained automatically.</td></tr>';
      const bar = document.getElementById('rollbacks-pagination');
      if (bar) bar.innerHTML = '';
      return;
    }

    paginateAndRender(eligible, 'rollbacks', 'rollbacks-pagination', (slice) => {
      tbody.innerHTML = slice.map((r) => `
        <tr>
          <td><strong>Release #${r.id}</strong></td>
          <td><span class="sha-pill">${r.sha.slice(0, 7)}</span></td>
          <td style="max-width: 260px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${escapeHtml(r.message || '')}</td>
          <td>${escapeHtml(r.author || 'Unknown')}</td>
          <td>${formatDate(r.deployed_at || r.created_at)}</td>
          <td><span class="badge badge-success">Files Verified</span></td>
          <td>
            <button class="btn btn-danger btn-sm" onclick="rollbackToRelease(${p.id}, ${r.id})">Instant Rollback</button>
          </td>
        </tr>
      `).join('');
    });
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="7" style="text-align: center; color: var(--danger); padding: 24px;">${escapeHtml(err.message)}</td></tr>`;
  }
}
window.loadRollbacksView = loadRollbacksView;

async function rollbackToRelease(projectId, releaseId) {
  const ok = await showConfirmDialog({
    title: `Instant Rollback to Release #${releaseId}`,
    message: `Are you sure you want to rollback to Release #${releaseId}?\n\nWebDep will atomically switch the active release junction, preserve your environment variables, and restart the website.`,
    confirmText: `Rollback to #${releaseId}`,
    danger: true,
  });
  if (!ok) return;

  try {
    const res = await api(`/api/projects/${projectId}/rollback`, { method: 'POST', body: { releaseId } });
    toast(`Rollback #${res.deploymentId} initiated!`, 'info');
    navigateTo('deployments', projectId);
  } catch (err) {
    toast(`Rollback failed: ${err.message}`, 'error');
  }
}
window.rollbackToRelease = rollbackToRelease;

async function deleteRelease(projectId, releaseId) {
  const ok = await showConfirmDialog({
    title: `Delete Release #${releaseId}`,
    message: `Permanently delete Release #${releaseId} from disk and SQLite?\n\nThis release artifact and rollback point will be removed.`,
    confirmText: 'Delete Release',
    danger: true,
  });
  if (!ok) return;

  try {
    await api(`/api/projects/${projectId}/releases/${releaseId}`, { method: 'DELETE' });
    toast(`Release #${releaseId} deleted.`, 'info');
    loadReleasesView();
  } catch (err) {
    toast(`Delete failed: ${err.message}`, 'error');
  }
}
window.deleteRelease = deleteRelease;

// ============================================================================
// View 7: Real-Time Live Logs
// ============================================================================
async function loadLogsView() {
  startLogStream();
  try {
    const p = getSelectedProject();
    let url = '/api/logs?limit=300';
    if (p) url += `&project=${p.id}`;
    const history = await api(url);
    if (Array.isArray(history)) {
      state.logLines = history;
    }
  } catch (_) {}
  renderTerminalLogs();
}

function startLogStream() {
  if (state.logEventSource) {
    state.logEventSource.close();
  }

  const p = getSelectedProject();
  let url = '/api/logs/stream?backlog=200';
  if (p) url += `&project=${p.id}`;

  const es = new EventSource(url);
  es.onmessage = (e) => {
    try {
      const data = JSON.parse(e.data);
      if (Array.isArray(data)) {
        const existingIds = new Set(state.logLines.map((x) => x.id));
        const fresh = data.filter((x) => !x.id || !existingIds.has(x.id));
        if (fresh.length) {
          state.logLines.push(...fresh);
          if (state.logLines.length > 2000) state.logLines.splice(0, state.logLines.length - 2000);
          appendTerminalLogs(fresh);
        }
      }
    } catch { /* keepalive or malformed */ }
  };
  es.onerror = () => {
    // EventSource automatically retries
  };
  state.logEventSource = es;
}

function renderTerminalLogs() {
  const terminal = document.getElementById('log-terminal-output');
  if (!terminal) return;

  const chanFilter = document.getElementById('log-channel-filter')?.value || '';
  const lvlFilter = document.getElementById('log-level-filter')?.value || '';
  const q = (document.getElementById('log-search-input')?.value || '').toLowerCase();

  const filtered = state.logLines.filter((l) => {
    if (chanFilter && l.channel !== chanFilter) return false;
    if (lvlFilter && l.level !== lvlFilter) return false;
    if (q && !(l.message || '').toLowerCase().includes(q)) return false;
    return true;
  });

  if (!filtered.length) {
    const filterNote = (chanFilter || lvlFilter || q)
      ? `No log entries match filter (${[chanFilter, lvlFilter, q].filter(Boolean).join(', ')}). Switch filters to "All Channels" / "All Levels" to view all ${state.logLines.length} logs.`
      : 'WebDep real-time log stream connected. Waiting for log events...';
    terminal.innerHTML = `<div class="log-line"><span class="log-ts">${new Date().toLocaleTimeString()}</span><span class="log-chan">[system]</span><span class="log-lvl-info">${escapeHtml(filterNote)}</span></div>`;
    return;
  }

  terminal.innerHTML = filtered.map((l) => formatLogLine(l)).join('');
  if (document.getElementById('log-autoscroll')?.checked) {
    terminal.scrollTop = terminal.scrollHeight;
  }
}

function appendTerminalLogs(newLines) {
  const terminal = document.getElementById('log-terminal-output');
  if (!terminal) return;

  const chanFilter = document.getElementById('log-channel-filter')?.value || '';
  const lvlFilter = document.getElementById('log-level-filter')?.value || '';
  const q = (document.getElementById('log-search-input')?.value || '').toLowerCase();

  let batchHtml = '';
  for (const l of newLines) {
    if (chanFilter && l.channel !== chanFilter) continue;
    if (lvlFilter && l.level !== lvlFilter) continue;
    if (q && !l.message.toLowerCase().includes(q)) continue;
    batchHtml += formatLogLine(l);
  }

  if (batchHtml) {
    terminal.insertAdjacentHTML('beforeend', batchHtml);

    // Memory optimization: cap terminal DOM nodes to 1,000 max
    const excess = terminal.childElementCount - 1000;
    if (excess > 0) {
      for (let i = 0; i < excess; i++) {
        if (terminal.firstChild) terminal.removeChild(terminal.firstChild);
      }
    }
  }

  if (document.getElementById('log-autoscroll')?.checked) {
    terminal.scrollTop = terminal.scrollHeight;
  }
}

function formatLogLine(l) {
  const time = l.ts ? new Date(l.ts).toLocaleTimeString() : '--:--:--';
  const lvlClass = `log-lvl-${l.level || 'info'}`;
  return `<div class="log-line"><span class="log-ts">${time}</span><span class="log-chan">[${l.channel}]</span><span class="${lvlClass}">${escapeHtml(l.message)}</span></div>`;
}

// Log filters bindings
['log-channel-filter', 'log-level-filter', 'log-search-input'].forEach((id) => {
  const el = document.getElementById(id);
  el?.addEventListener('input', renderTerminalLogs);
  el?.addEventListener('change', renderTerminalLogs);
});
document.getElementById('log-clear-btn')?.addEventListener('click', () => {
  state.logLines = [];
  document.getElementById('log-terminal-output').innerHTML = '';
});

// Copy logs to clipboard
document.getElementById('logs-copy-btn')?.addEventListener('click', async () => {
  if (!state.logLines.length) {
    toast('No log lines to copy.', 'info');
    return;
  }
  const text = state.logLines.map((l) => `[${l.ts ? new Date(l.ts).toLocaleTimeString() : '--:--:--'}] [${(l.channel || 'SYSTEM').toUpperCase()}] [${(l.level || 'INFO').toUpperCase()}] ${l.message}`).join('\n');
  try {
    await navigator.clipboard.writeText(text);
    toast('Logs copied to clipboard', 'success');
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    toast('Logs copied to clipboard', 'success');
  }
});

// Download logs
document.getElementById('logs-download-btn')?.addEventListener('click', () => {
  const p = getSelectedProject();
  let url = '/api/logs/download';
  if (p) url += `?project=${p.id}`;
  window.open(url, '_blank');
});

// Tail application supervisor logs
document.getElementById('logs-app-tail-btn')?.addEventListener('click', async () => {
  const p = getSelectedProject();
  if (!p) return;
  try {
    const res = await api(`/api/projects/${p.id}/app-logs?lines=300`);
    const terminal = document.getElementById('log-terminal-output');
    terminal.innerHTML = `\n===== Application Runtime Logs for ${escapeHtml(p.name)} (${res.lines.length} lines) =====\n` +
      res.lines.map((l) => `<div class="log-line"><span class="log-lvl-info">${escapeHtml(l)}</span></div>`).join('');
    terminal.scrollTop = terminal.scrollHeight;
  } catch (err) {
    toast(`Failed to load app logs: ${err.message}`, 'error');
  }
});

function openLogsForProject(projectId) {
  const chanSel = document.getElementById('log-channel-filter');
  const lvlSel = document.getElementById('log-level-filter');
  if (chanSel) chanSel.value = '';
  if (lvlSel) lvlSel.value = '';
  navigateTo('logs', projectId);
}
window.openLogsForProject = openLogsForProject;

// ============================================================================
// View 8: Environment Variables
// ============================================================================
async function loadEnvView() {
  if (!state.projects || state.projects.length === 0) {
    try {
      state.projects = await api('/api/projects');
    } catch (_) {}
  }

  const p = getSelectedProject();
  const projLabel = document.getElementById('env-active-project-label');
  if (projLabel) {
    projLabel.textContent = p ? `${p.name} (${p.slug})` : 'None';
  }
  const tbody = document.getElementById('env-vars-table-body');
  if (!p) {
    if (tbody) tbody.innerHTML = '<tr><td colspan="5" style="text-align: center; padding: 24px;">No website found. Create a website first.</td></tr>';
    return;
  }

  try {
    const vars = await api(`/api/projects/${p.id}/env`);
    if (!vars.length) {
      tbody.innerHTML = '<tr><td colspan="5" style="text-align: center; padding: 24px;">No environment variables configured. Click "Add Variable" or "Bulk / .env File" above to add.</td></tr>';
      const bar = document.getElementById('env-vars-pagination');
      if (bar) bar.innerHTML = '';
      return;
    }

    paginateAndRender(vars, 'envVars', 'env-vars-pagination', (slice) => {
      tbody.innerHTML = slice.map((v) => {
        const isSecret = Boolean(v.is_secret ?? v.secret);
        return `
        <tr>
          <td><code>${escapeHtml(v.key)}</code></td>
          <td id="env-val-${v.key}">
            ${isSecret
              ? '<span style="font-family: var(--font-mono); color: var(--text-dim);">&bull;&bull;&bull;&bull;&bull;&bull;&bull;&bull;&bull;&bull;</span>'
              : `<code style="color: var(--text-main);">${escapeHtml(v.value)}</code>`
            }
          </td>
          <td>${isSecret ? '<span class="badge badge-warning">Secret</span>' : '<span class="badge badge-neutral">Public</span>'}</td>
          <td><span class="badge badge-success">Saved in SQLite</span></td>
          <td>
            <div style="display: flex; gap: 6px;">
              <button class="btn btn-secondary btn-sm" onclick="promptRevealEnv('${escapeHtml(v.key)}')">Reveal</button>
              <button class="btn btn-danger btn-sm" onclick="deleteEnvVar('${escapeHtml(v.key)}')">Delete</button>
            </div>
          </td>
        </tr>
      `;
      }).join('');
    });
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="5" style="text-align: center; color: var(--danger); padding: 24px;">${escapeHtml(err.message)}</td></tr>`;
  }
}

function onEnvProjectChange(projectId) {
  state.selectedProjectId = Number(projectId);
  const globalSel = document.getElementById('global-project-select');
  if (globalSel) globalSel.value = String(projectId);
  syncProjectSelectors();
  renderCurrentView();
}
window.onEnvProjectChange = onEnvProjectChange;

function restartCurrentProject() {
  const p = getSelectedProject();
  if (p) restartProject(p.id);
}
window.restartCurrentProject = restartCurrentProject;

// Environment modal state & tab switching
let activeEnvTab = 'single';

function switchEnvModalTab(tab) {
  activeEnvTab = tab;
  const singleTab = document.getElementById('tab-env-single');
  const bulkTab = document.getElementById('tab-env-bulk');
  const singleSec = document.getElementById('env-section-single');
  const bulkSec = document.getElementById('env-section-bulk');
  const title = document.getElementById('env-modal-title');
  const saveBtn = document.getElementById('save-env-btn');

  if (tab === 'single') {
    if (singleTab) {
      singleTab.style.background = 'var(--bg-card)';
      singleTab.style.borderColor = 'var(--accent)';
      singleTab.style.color = 'var(--accent-light)';
    }
    if (bulkTab) {
      bulkTab.style.background = 'transparent';
      bulkTab.style.borderColor = 'transparent';
      bulkTab.style.color = 'var(--text-muted)';
    }
    if (singleSec) singleSec.style.display = 'block';
    if (bulkSec) bulkSec.style.display = 'none';
    if (title) title.textContent = 'Add Environment Variable';
    if (saveBtn) saveBtn.textContent = 'Save Variable';
  } else {
    if (singleTab) {
      singleTab.style.background = 'transparent';
      singleTab.style.borderColor = 'transparent';
      singleTab.style.color = 'var(--text-muted)';
    }
    if (bulkTab) {
      bulkTab.style.background = 'var(--bg-card)';
      bulkTab.style.borderColor = 'var(--accent)';
      bulkTab.style.color = 'var(--accent-light)';
    }
    if (singleSec) singleSec.style.display = 'none';
    if (bulkSec) bulkSec.style.display = 'block';
    if (title) title.textContent = 'Bulk / .env File Import';
    if (saveBtn) saveBtn.textContent = 'Import & Save .env';
  }
}
window.switchEnvModalTab = switchEnvModalTab;

function openAddEnvModal() {
  const p = getSelectedProject();
  if (!p) {
    toast('Please select or create a website first.', 'warning');
    return;
  }
  const targetLabel = document.getElementById('env-modal-target-project');
  if (targetLabel) targetLabel.textContent = `${p.name} (${p.slug})`;
  document.getElementById('add-env-form')?.reset();
  switchEnvModalTab('single');
  openModal('modal-env');
}
window.openAddEnvModal = openAddEnvModal;

function openBulkEnvModal() {
  const p = getSelectedProject();
  if (!p) {
    toast('Please select or create a website first.', 'warning');
    return;
  }
  const targetLabel = document.getElementById('env-modal-target-project');
  if (targetLabel) targetLabel.textContent = `${p.name} (${p.slug})`;
  switchEnvModalTab('bulk');
  openModal('modal-env');
}
window.openBulkEnvModal = openBulkEnvModal;

async function loadCurrentEnv() {
  const p = getSelectedProject();
  if (!p) {
    toast('No website selected.', 'error');
    return;
  }
  try {
    const res = await api(`/api/projects/${p.id}/env/raw`);
    const bulkInput = document.getElementById('env-bulk-input');
    if (bulkInput) {
      bulkInput.value = res.content || '';
      toast(`Current .env loaded for "${p.name}".`, 'info');
    }
  } catch (err) {
    toast(`Failed to load .env: ${err.message}`, 'error');
  }
}
window.loadCurrentEnv = loadCurrentEnv;

async function exportEnvFile() {
  const p = getSelectedProject();
  if (!p) {
    toast('No website selected.', 'error');
    return;
  }
  try {
    const res = await api(`/api/projects/${p.id}/env/raw`);
    if (!res.content || !res.content.trim()) {
      toast('No environment variables to export.', 'info');
      return;
    }
    const blob = new Blob([res.content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${p.slug || 'app'}.env`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    toast(`Exported ${p.slug || 'app'}.env!`, 'success');
  } catch (err) {
    toast(`Export failed: ${err.message}`, 'error');
  }
}
window.exportEnvFile = exportEnvFile;

async function handleSaveEnv(e) {
  if (e) e.preventDefault();
  const p = getSelectedProject();
  if (!p) {
    toast('No website selected. Please select a website first.', 'error');
    return;
  }

  if (activeEnvTab === 'single') {
    const key = (document.getElementById('env-key-input')?.value || '').trim();
    const value = document.getElementById('env-value-input')?.value || '';
    const is_secret = document.getElementById('env-secret-checkbox')?.checked ?? true;

    if (!key) {
      toast('Variable key is required.', 'error');
      return;
    }

    try {
      await api(`/api/projects/${p.id}/env`, { method: 'PUT', body: { key, value, is_secret } });
      toast(`Variable "${key}" saved. Restart application for it to take effect.`, 'success');
      closeModal('modal-env');
      loadEnvView();
    } catch (err) {
      toast(`Save failed: ${err.message}`, 'error');
    }
  } else {
    const content = document.getElementById('env-bulk-input')?.value || '';
    if (!content.trim()) {
      toast('Please enter or paste .env file contents.', 'error');
      return;
    }
    const is_secret = document.getElementById('env-bulk-secret-checkbox')?.checked ?? true;
    const replace_all = document.getElementById('env-bulk-replace-checkbox')?.checked ?? false;

    try {
      const res = await api(`/api/projects/${p.id}/env/bulk`, {
        method: 'POST',
        body: { content, is_secret, replace_all },
      });
      toast(`Successfully saved ${res.count || 0} variables for ${p.name}! Restart app to apply.`, 'success');
      closeModal('modal-env');
      loadEnvView();
    } catch (err) {
      toast(`Bulk save failed: ${err.message}`, 'error');
    }
  }
}
window.handleSaveEnv = handleSaveEnv;

async function deleteEnvVar(key) {
  const p = getSelectedProject();
  if (!p) return;
  const ok = await showConfirmDialog({
    title: 'Delete Environment Variable',
    message: `Delete environment variable "${key}" from ${p.name}?`,
    confirmText: 'Delete Variable',
    danger: true,
  });
  if (!ok) return;

  try {
    await api(`/api/projects/${p.id}/env/${encodeURIComponent(key)}`, { method: 'DELETE' });
    toast(`Variable "${key}" deleted.`, 'success');
    loadEnvView();
  } catch (err) {
    toast(`Delete failed: ${err.message}`, 'error');
  }
}
window.deleteEnvVar = deleteEnvVar;

function promptRevealEnv(key) {
  state.revealingEnvKey = key;
  document.getElementById('reveal-password-input').value = '';
  openModal('modal-reveal');
}
window.promptRevealEnv = promptRevealEnv;

document.getElementById('confirm-reveal-btn')?.addEventListener('click', async () => {
  const p = getSelectedProject();
  const key = state.revealingEnvKey;
  const password = document.getElementById('reveal-password-input').value;
  if (!password || !key || !p) return;

  try {
    const res = await api(`/api/projects/${p.id}/env/reveal`, { method: 'POST', body: { key, password } });
    closeModal('modal-reveal');
    const td = document.getElementById(`env-val-${key}`);
    if (td) {
      td.innerHTML = `<code style="color:var(--success); font-weight:600;">${escapeHtml(res.value)}</code>`;
    }
    toast(`Revealed "${key}".`, 'info');
  } catch (err) {
    toast(`Reveal failed: ${err.message}`, 'error');
  }
});

// ============================================================================
// View 9: Application Backups
// ============================================================================
async function loadBackupsView() {
  const p = getSelectedProject();
  const tbody = document.getElementById('backups-table-body');
  if (!p) {
    if (tbody) tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; padding: 24px;">Select or create a website to view backups.</td></tr>';
    return;
  }

  try {
    const backups = await api(`/api/projects/${p.id}/backups`, { noCache: true });
    if (!backups.length) {
      tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; padding: 24px;">No backups taken yet. Click "Create Backup" above to snapshot your website & .env.</td></tr>';
      const bar = document.getElementById('backups-pagination');
      if (bar) bar.innerHTML = '';
      return;
    }

    paginateAndRender(backups, 'backups', 'backups-pagination', (slice) => {
      tbody.innerHTML = slice.map((b) => {
        const sizeStr = b.size >= 1048576
          ? `${(b.size / 1048576).toFixed(2)} MB`
          : `${Math.max(1, Math.round((b.size || 4096) / 1024))} KB`;
        return `
          <tr>
            <td><strong>#${b.id}</strong></td>
            <td>${formatDate(b.ts)}</td>
            <td><span class="badge badge-info">${escapeHtml(b.kind || 'full-snapshot')}</span></td>
            <td>${sizeStr}</td>
            <td>${escapeHtml(b.note || 'Snapshot')}</td>
            <td>
              <div style="display:flex; gap:6px;">
                <button class="btn btn-primary btn-sm" onclick="restoreBackup(${p.id}, ${b.id})">Restore</button>
                <button class="btn btn-danger btn-sm" onclick="deleteBackup(${p.id}, ${b.id})">Delete</button>
              </div>
            </td>
          </tr>
        `;
      }).join('');
    });
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="6" style="text-align: center; color: var(--danger); padding: 24px;">${escapeHtml(err.message)}</td></tr>`;
  }
}

document.getElementById('create-backup-btn')?.addEventListener('click', () => {
  const p = getSelectedProject();
  if (!p) {
    toast('Please select or create a website first.', 'warning');
    return;
  }
  document.getElementById('create-backup-form')?.reset();
  const noteInput = document.getElementById('backup-note-input');
  if (noteInput) noteInput.value = `${p.name} snapshot (${new Date().toLocaleDateString()})`;
  openModal('modal-create-backup');
});

document.getElementById('confirm-create-backup-btn')?.addEventListener('click', async (e) => {
  e.preventDefault();
  const p = getSelectedProject();
  if (!p) return;
  const kind = document.getElementById('backup-kind-select')?.value || 'full-snapshot';
  const note = (document.getElementById('backup-note-input')?.value || '').trim() || 'Manual snapshot';
  const btn = document.getElementById('confirm-create-backup-btn');
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Creating Snapshot...';
  }

  try {
    const res = await api(`/api/projects/${p.id}/backup`, { method: 'POST', body: { note, kind }, timeoutMs: 30000 });
    toast(`Backup snapshot & Release #${res.releaseId || res.backupId} created successfully!`, 'success');
    closeModal('modal-create-backup');
    loadBackupsView();
  } catch (err) {
    toast(`Backup failed: ${err.message}`, 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Create Snapshot';
    }
  }
});

// Create Release Modal & Triggers
function openCreateReleaseModal() {
  let p = getSelectedProject();
  if (!p && state.projects && state.projects.length > 0) {
    p = state.projects[0];
    state.selectedProjectId = p.id;
  }
  if (!p) {
    toast('Please create a website first before creating a release.', 'warning');
    if (typeof window.openAddWebsiteModal === 'function') {
      window.openAddWebsiteModal();
    }
    return;
  }

  const targetLabel = document.getElementById('release-modal-target-project');
  const projSelect = document.getElementById('release-project-select');
  const projGroup = document.getElementById('release-project-select-group');

  if (state.projects && state.projects.length > 1) {
    if (projGroup) projGroup.style.display = 'block';
    if (targetLabel) targetLabel.style.display = 'none';
    if (projSelect) {
      projSelect.innerHTML = state.projects.map((proj) => 
        `<option value="${proj.id}" ${p && p.id === proj.id ? 'selected' : ''}>${escapeHtml(proj.name)} (${escapeHtml(proj.slug)})</option>`
      ).join('');
      projSelect.onchange = (e) => {
        const sel = state.projects.find((item) => item.id === Number(e.target.value));
        if (sel) {
          const noteInput = document.getElementById('release-note-input');
          if (noteInput) {
            const d = new Date();
            const dateStr = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
            noteInput.value = `Release ${sel.name} - ${dateStr}`;
          }
        }
      };
    }
  } else {
    if (projGroup) projGroup.style.display = 'none';
    if (targetLabel) {
      targetLabel.style.display = 'block';
      targetLabel.innerHTML = `Target Website: <strong style="color: var(--text-normal);">${escapeHtml(p.name)}</strong> <span style="font-size: 11px; opacity: 0.7;">(${escapeHtml(p.slug)})</span>`;
    }
  }

  const noteInput = document.getElementById('release-note-input');
  if (noteInput && p) {
    const d = new Date();
    const dateStr = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    noteInput.value = `Release ${p.name} - ${dateStr}`;
  }

  openModal('modal-create-release');
}
window.openCreateReleaseModal = openCreateReleaseModal;

async function confirmCreateRelease(e) {
  if (e && e.preventDefault) e.preventDefault();
  let p = getSelectedProject();
  const projSelect = document.getElementById('release-project-select');
  if (projSelect && projSelect.value) {
    const found = state.projects.find((item) => item.id === Number(projSelect.value));
    if (found) p = found;
  }
  if (!p) {
    toast('Please select a website first.', 'warning');
    return;
  }

  const source = document.getElementById('release-source-select')?.value || 'deploy';
  const note = (document.getElementById('release-note-input')?.value || '').trim() || `Manual release for ${p.name}`;
  const btn = document.getElementById('confirm-create-release-btn');
  if (btn) {
    btn.disabled = true;
    btn.textContent = source === 'deploy' ? 'Deploying Release...' : 'Creating Snapshot...';
  }

  try {
    const res = await api(`/api/projects/${p.id}/releases`, { method: 'POST', body: { source, note } });
    if (source === 'deploy') {
      toast(`Release deployment #${res.deploymentId} started for ${p.name}!`, 'success');
      closeModal('modal-create-release');
      navigateTo('deployments', p.id);
    } else {
      toast(`Release #${res.releaseId} created successfully!`, 'success');
      closeModal('modal-create-release');
      loadReleasesView();
    }
  } catch (err) {
    toast(`Create release failed: ${err.message}`, 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Build & Create Release';
    }
  }
}
window.confirmCreateRelease = confirmCreateRelease;

document.getElementById('create-release-btn')?.addEventListener('click', openCreateReleaseModal);
document.getElementById('confirm-create-release-btn')?.addEventListener('click', confirmCreateRelease);

async function restoreBackup(projectId, backupId) {
  const ok = await showConfirmDialog({
    title: `Restore Backup #${backupId}`,
    message: `Restore website files and environment variables from Backup #${backupId}?\n\nThis will restore the snapshot state and restart the website service.`,
    confirmText: `Restore Backup #${backupId}`,
  });
  if (!ok) return;

  try {
    await api(`/api/projects/${projectId}/backups/restore`, { method: 'POST', body: { backupId }, timeoutMs: 30000 });
    toast(`Backup #${backupId} restored successfully!`, 'success');
    loadBackupsView();
  } catch (err) {
    toast(`Restore failed: ${err.message}`, 'error');
  }
}
window.restoreBackup = restoreBackup;

async function deleteBackup(projectId, backupId) {
  const ok = await showConfirmDialog({
    title: `Delete Backup #${backupId}`,
    message: `Permanently delete Backup #${backupId} from disk and SQLite?`,
    confirmText: 'Delete Backup',
    danger: true,
  });
  if (!ok) return;

  try {
    await api(`/api/projects/${projectId}/backups/${backupId}`, { method: 'DELETE' });
    toast(`Backup #${backupId} deleted.`, 'info');
    loadBackupsView();
  } catch (err) {
    toast(`Delete failed: ${err.message}`, 'error');
  }
}
window.deleteBackup = deleteBackup;

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
    tbody.innerHTML = monProjects.map((p) => {
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
    }).join('');
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
  const badge = document.getElementById('settings-2fa-status-badge');
  if (badge) {
    badge.className = `badge ${is2fa ? 'badge-success' : 'badge-warning'}`;
    badge.textContent = is2fa ? '2FA ENABLED' : '2FA NOT ENABLED';
  }
  const unameEl = document.getElementById('settings-sec-username');
  if (unameEl) unameEl.textContent = `${state.user.username} (${state.user.isMainAdmin ? 'Main Admin' : state.user.role})`;

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

  const canManagePlatform = hasPower('settings_manage');
  const isMain = Boolean(state.user && state.user.isMainAdmin);
  const globalCard = document.getElementById('settings-global-config-card');
  const usersCard = document.getElementById('settings-users-card');
  const panelCard = document.getElementById('settings-panel-card');
  if (globalCard) globalCard.style.display = canManagePlatform ? '' : 'none';
  if (usersCard) usersCard.style.display = isMain ? '' : 'none';
  if (panelCard) panelCard.style.display = isMain ? '' : 'none';
  if (!canManagePlatform && !isMain) return;

  try {
    const s = await api('/api/settings');
    document.getElementById('setting-min-free-mb').value = s.min_free_mb || 500;
    document.getElementById('setting-default-retention').value = s.default_retention || 10;
    document.getElementById('setting-step-timeout').value = s.step_timeout_s || 900;
    document.getElementById('setting-deploy-timeout').value = s.deploy_timeout_s || 1800;

    const tokBadge = document.getElementById('github-token-status-badge');
    const tokInput = document.getElementById('setting-github-token');
    if (s.github_token_configured === 'true') {
      if (tokBadge) tokBadge.innerHTML = `<span class="badge badge-success">Saved in SQLite (${escapeHtml(s.github_token_masked || 'Configured')})</span>`;
      if (tokInput) {
        tokInput.value = s.github_token || '';
        tokInput.placeholder = `${s.github_token_masked || 'Token saved in SQLite'}`;
      }
    } else {
      if (tokBadge) tokBadge.innerHTML = '<span class="badge badge-neutral">Not Configured</span>';
      if (tokInput) {
        tokInput.value = '';
        tokInput.placeholder = 'github_pat_...';
      }
    }

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

document.getElementById('toggle-github-token-btn')?.addEventListener('click', () => {
  const input = document.getElementById('setting-github-token');
  const btn = document.getElementById('toggle-github-token-btn');
  if (!input || !btn) return;
  if (input.type === 'password') {
    input.type = 'text';
    btn.textContent = 'Hide';
  } else {
    input.type = 'password';
    btn.textContent = 'Show';
  }
});

document.getElementById('settings-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const payload = {
    min_free_mb: Number(document.getElementById('setting-min-free-mb').value) || 500,
    default_retention: Number(document.getElementById('setting-default-retention').value) || 10,
    step_timeout_s: Number(document.getElementById('setting-step-timeout').value) || 900,
    deploy_timeout_s: Number(document.getElementById('setting-deploy-timeout').value) || 1800,
  };
  const token = document.getElementById('setting-github-token').value.trim();
  if (token) payload.github_token = token;

  try {
    await api('/api/settings', { method: 'PUT', body: payload });
    toast('Global settings & GitHub token saved in SQLite!', 'success');
    loadSettingsView();
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
    loadSettingsView();
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
    loadSettingsView();
  } catch (err) {
    toast(`Delete failed: ${err.message}`, 'error');
  }
}
window.deleteUser = deleteUser;

// ============================================================================
// View 12: Per-Website Activity Tab
// ============================================================================
const AUDIT_ACTION_META = {
  'deploy.trigger': { label: 'Deploy Triggered', cls: 'badge-info' },
  'deploy.start': { label: 'Deploy Triggered', cls: 'badge-info' },
  'deploy.auto_initial': { label: 'Initial Deploy', cls: 'badge-info' },
  'deploy.success': { label: 'Deploy Succeeded', cls: 'badge-success' },
  'deploy.failed': { label: 'Deploy Failed', cls: 'badge-danger' },
  'rollback.trigger': { label: 'Rollback Started', cls: 'badge-warning' },
  'rollback.start': { label: 'Rollback Started', cls: 'badge-warning' },
  'rollback.success': { label: 'Rollback Succeeded', cls: 'badge-success' },
  'rollback.failed': { label: 'Rollback Failed', cls: 'badge-danger' },
  'container.start': { label: 'Container Started', cls: 'badge-success' },
  'project.start': { label: 'Container Started', cls: 'badge-success' },
  'container.stop': { label: 'Container Stopped', cls: 'badge-danger' },
  'project.stop': { label: 'Container Stopped', cls: 'badge-danger' },
  'container.restart': { label: 'Container Restarted', cls: 'badge-warning' },
  'project.restart': { label: 'Container Restarted', cls: 'badge-warning' },
  'env.set': { label: 'Env Variable Saved', cls: 'badge-info' },
  'env.add': { label: 'Env Variable Saved', cls: 'badge-info' },
  'env.bulk_import': { label: 'Bulk .env Imported', cls: 'badge-info' },
  'env.reveal': { label: 'Secret Revealed', cls: 'badge-warning' },
  'env.delete': { label: 'Env Variable Deleted', cls: 'badge-danger' },
  'env.remove': { label: 'Env Variable Deleted', cls: 'badge-danger' },
  'backup.create': { label: 'Snapshot Created', cls: 'badge-info' },
  'backup.restore': { label: 'Backup Restored', cls: 'badge-warning' },
  'backup.delete': { label: 'Backup Deleted', cls: 'badge-danger' },
  'website.create': { label: 'Website Created', cls: 'badge-success' },
  'project.create': { label: 'Website Created', cls: 'badge-success' },
  'website.update': { label: 'Website Updated', cls: 'badge-info' },
  'project.update': { label: 'Website Updated', cls: 'badge-info' },
  'website.delete': { label: 'Website Deleted', cls: 'badge-danger' },
  'project.delete': { label: 'Website Deleted', cls: 'badge-danger' },
  'git.fetch': { label: 'Git Fetched', cls: 'badge-neutral' },
  'git.deploy_key': { label: 'SSH Key Generated', cls: 'badge-info' },
  'git.webhook_rotate': { label: 'Webhook Secret Rotated', cls: 'badge-warning' },
  'git.webhook_push': { label: 'GitHub Push Webhook', cls: 'badge-info' },
  'domains.caddy_apply': { label: 'Caddy Applied', cls: 'badge-success' },
  'domains.ssl_certbot': { label: 'SSL Provisioned', cls: 'badge-success' },
  'settings.update': { label: 'Settings Updated', cls: 'badge-info' },
  'user.create': { label: 'User Created', cls: 'badge-success' },
  'user.update': { label: 'User Access Updated', cls: 'badge-warning' },
  'user.delete': { label: 'User Removed', cls: 'badge-danger' },
  'auth.login': { label: 'User Signed In', cls: 'badge-neutral' },
};

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
        saveCaddyDomains();
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
    .map((s) => s.trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '').trim().toLowerCase())
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
    if (state.currentView === 'overview') loadOverview();
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
    openNginxModal(activeNginxProjectId);
  } catch (err) {
    toast(`Certbot failed: ${err.message}`, 'error');
  }
});

// ============================================================================
// Direct Process Controls (Start / Stop / Restart)
// ============================================================================
async function startProject(projectId) {
  try {
    const res = await api(`/api/projects/${projectId}/start`, { method: 'POST' });
    if (res && res.autoDeployed) {
      toast(`No release built yet — initial deployment #${res.deploymentId} started automatically!`, 'info');
      navigateTo('deployments', projectId);
      return;
    }
    toast('Process started.', 'success');
    await loadProjects();
    if (state.currentView === 'projects') renderProjectsList();
    if (state.currentView === 'overview') loadOverview();
    if (WEBSITE_WORKSPACE_TABS.has(state.currentView)) renderWebsiteWorkspaceHeader();
  } catch (err) {
    toast(`Start failed: ${err.message}`, 'error');
  }
}
window.startProject = startProject;

async function stopProject(projectId) {
  try {
    await api(`/api/projects/${projectId}/stop`, { method: 'POST' });
    toast('Process stopped.', 'info');
    await loadProjects();
    if (state.currentView === 'projects') renderProjectsList();
    if (state.currentView === 'overview') loadOverview();
    if (WEBSITE_WORKSPACE_TABS.has(state.currentView)) renderWebsiteWorkspaceHeader();
  } catch (err) {
    toast(`Stop failed: ${err.message}`, 'error');
  }
}
window.stopProject = stopProject;

async function toggleMaintenanceMode(projectId) {
  try {
    const res = await api(`/api/projects/${projectId}/maintenance`, { method: 'POST', body: {} });
    if (res && res.maintenance) {
      toast('Maintenance Mode enabled — visitors now see the Under Maintenance page.', 'warning');
    } else {
      toast('Maintenance Mode disabled — live website resumed!', 'success');
    }
    await loadProjects();
    if (state.currentView === 'projects') renderProjectsList();
    if (state.currentView === 'overview') loadOverview();
    if (WEBSITE_WORKSPACE_TABS.has(state.currentView)) renderWebsiteWorkspaceHeader();
  } catch (err) {
    toast(`Maintenance toggle failed: ${err.message}`, 'error');
  }
}
window.toggleMaintenanceMode = toggleMaintenanceMode;

async function restartProject(projectId) {
  try {
    const res = await api(`/api/projects/${projectId}/restart`, { method: 'POST' });
    if (res && res.autoDeployed) {
      toast(`No release built yet — initial deployment #${res.deploymentId} started automatically!`, 'info');
      navigateTo('deployments', projectId);
      return;
    }
    toast('Application restarted.', 'success');
    await loadProjects();
    if (state.currentView === 'projects') renderProjectsList();
    if (state.currentView === 'overview') loadOverview();
    if (WEBSITE_WORKSPACE_TABS.has(state.currentView)) renderWebsiteWorkspaceHeader();
  } catch (err) {
    toast(`Restart failed: ${err.message}`, 'error');
  }
}
window.restartProject = restartProject;

// ============================================================================
// Global Polling & Live Updates
// ============================================================================
let pollInFlight = false;
function startPolling() {
  if (state.overviewTimer) clearInterval(state.overviewTimer);

  state.overviewTimer = setInterval(async () => {
    if (pollInFlight) return;
    pollInFlight = true;
    try {
      if (state.currentView === 'overview') {
        await loadOverview();
      } else if (state.currentView === 'deployments') {
        await loadProjects();
        renderWebsiteWorkspaceHeader();
        await loadDeploymentsView();
      } else if (state.currentView === 'monitor') {
        await loadProjects();
        renderWebsiteWorkspaceHeader();
        await loadMonitorView();
      } else if (state.currentView === 'releases') {
        await loadProjects();
        renderWebsiteWorkspaceHeader();
        await loadReleasesView();
      } else if (state.currentView === 'rollbacks') {
        await loadProjects();
        renderWebsiteWorkspaceHeader();
        await loadRollbacksView();
      } else if (state.currentView === 'backups') {
        await loadProjects();
        renderWebsiteWorkspaceHeader();
        await loadBackupsView();
      } else if (WEBSITE_WORKSPACE_TABS.has(state.currentView)) {
        await loadProjects();
        renderWebsiteWorkspaceHeader();
      }
    } finally {
      pollInFlight = false;
    }
  }, 4000);
}

window.addEventListener('beforeunload', () => {
  if (state.logEventSource) {
    state.logEventSource.close();
    state.logEventSource = null;
  }
});

// Global project selector binding
document.getElementById('global-project-select')?.addEventListener('change', (e) => {
  const val = e.target.value;
  state.selectedProjectId = val ? Number(val) : null;
  renderCurrentView();
});

// Sidebar navigation items
document.querySelectorAll('.nav-item').forEach((item) => {
  item.addEventListener('click', () => {
    const view = item.getAttribute('data-view');
    if (view) navigateTo(view);
  });
});

document.getElementById('overview-refresh-btn')?.addEventListener('click', loadOverview);
document.getElementById('global-add-website-btn')?.addEventListener('click', openAddWebsiteModal);
document.getElementById('add-website-btn')?.addEventListener('click', openAddWebsiteModal);

// Login Form & Two-Factor Challenge
document.getElementById('login-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = document.getElementById('login-username').value.trim();
  const password = document.getElementById('login-password').value;
  const btn = document.getElementById('login-btn');

  btn.disabled = true;
  btn.textContent = 'Signing in...';

  try {
    const res = await api('/api/auth/login', { method: 'POST', body: { username, password } });
    if (res.requires2fa && res.mfaToken) {
      state.pendingMfaToken = res.mfaToken;
      document.getElementById('login-form').style.display = 'none';
      document.getElementById('login-2fa-form').style.display = 'block';
      const unameLabel = document.getElementById('login-2fa-username');
      if (unameLabel) unameLabel.textContent = res.username || username;
      const codeInput = document.getElementById('login-2fa-code');
      if (codeInput) {
        codeInput.value = '';
        setTimeout(() => codeInput.focus(), 50);
      }
      toast('Enter your 6-digit authenticator code to complete sign-in.', 'info');
      return;
    }

    state.user = res.user;
    state.csrf = res.csrf;
    state.activeSessions = res.activeSessions || 1;
    onAuthenticated();
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Sign In';
  }
});

document.getElementById('login-2fa-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const code = (document.getElementById('login-2fa-code')?.value || '').trim();
  const btn = document.getElementById('login-2fa-btn');
  if (!state.pendingMfaToken || !code) return;

  btn.disabled = true;
  btn.textContent = 'Verifying 2FA...';

  try {
    const res = await api('/api/auth/2fa/verify-login', {
      method: 'POST',
      body: { mfaToken: state.pendingMfaToken, code },
    });
    state.pendingMfaToken = null;
    state.user = res.user;
    state.csrf = res.csrf;
    state.activeSessions = res.activeSessions || 1;
    onAuthenticated();
    toast('Two-Factor Authentication verified!', 'success');
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Verify & Sign In';
  }
});

document.getElementById('login-2fa-back-btn')?.addEventListener('click', () => {
  state.pendingMfaToken = null;
  document.getElementById('login-2fa-form').style.display = 'none';
  document.getElementById('login-form').style.display = 'block';
});

// Logout
document.getElementById('logout-btn')?.addEventListener('click', async () => {
  try {
    await api('/api/auth/logout', { method: 'POST' });
  } catch { /* ignore */ }
  state.user = null;
  state.csrf = null;
  showLogin();
});

// Mobile navigation drawer toggle
const mobileToggle = document.getElementById('mobile-sidebar-toggle');
const sidebarEl = document.querySelector('.sidebar');
const backdropEl = document.getElementById('sidebar-backdrop');
if (mobileToggle && sidebarEl && backdropEl) {
  mobileToggle.addEventListener('click', () => {
    sidebarEl.classList.toggle('mobile-open');
    backdropEl.classList.toggle('active');
  });
  backdropEl.addEventListener('click', () => {
    sidebarEl.classList.remove('mobile-open');
    backdropEl.classList.remove('active');
  });
}

// Modal Helpers
function openModal(modalId) {
  document.getElementById(modalId)?.classList.add('active');
}
window.openModal = openModal;

function closeModal(modalId) {
  document.getElementById(modalId)?.classList.remove('active');
}
window.closeModal = closeModal;

function showConfirmDialog({ title = 'Confirm Action', message = '', confirmText = 'Confirm', danger = false } = {}) {
  return new Promise((resolve) => {
    const modal = document.getElementById('modal-dialog');
    const titleEl = document.getElementById('dialog-modal-title');
    const msgEl = document.getElementById('dialog-modal-message');
    const inputWrap = document.getElementById('dialog-input-wrapper');
    const confirmBtn = document.getElementById('dialog-confirm-btn');
    const cancelBtn = document.getElementById('dialog-cancel-btn');
    const closeBtn = document.getElementById('dialog-modal-close');

    titleEl.textContent = title;
    msgEl.textContent = message;
    inputWrap.style.display = 'none';
    cancelBtn.style.display = '';
    cancelBtn.textContent = 'Cancel';
    confirmBtn.textContent = confirmText;
    confirmBtn.className = `btn ${danger ? 'btn-danger' : 'btn-primary'}`;

    const cleanup = (result) => {
      modal.classList.remove('active');
      confirmBtn.onclick = null;
      cancelBtn.onclick = null;
      closeBtn.onclick = null;
      resolve(result);
    };

    confirmBtn.onclick = () => cleanup(true);
    cancelBtn.onclick = () => cleanup(false);
    closeBtn.onclick = () => cleanup(false);
    modal.classList.add('active');
  });
}

function showPromptDialog({ title = 'Input Required', message = '', placeholder = '', defaultValue = '', confirmText = 'Confirm', danger = false } = {}) {
  return new Promise((resolve) => {
    const modal = document.getElementById('modal-dialog');
    const titleEl = document.getElementById('dialog-modal-title');
    const msgEl = document.getElementById('dialog-modal-message');
    const inputWrap = document.getElementById('dialog-input-wrapper');
    const inputEl = document.getElementById('dialog-modal-input');
    const confirmBtn = document.getElementById('dialog-confirm-btn');
    const cancelBtn = document.getElementById('dialog-cancel-btn');
    const closeBtn = document.getElementById('dialog-modal-close');

    titleEl.textContent = title;
    msgEl.textContent = message;
    inputWrap.style.display = 'block';
    inputEl.readOnly = false;
    inputEl.value = defaultValue;
    inputEl.placeholder = placeholder;
    cancelBtn.style.display = '';
    cancelBtn.textContent = 'Cancel';
    confirmBtn.textContent = confirmText;
    confirmBtn.className = `btn ${danger ? 'btn-danger' : 'btn-primary'}`;

    const cleanup = (result) => {
      modal.classList.remove('active');
      confirmBtn.onclick = null;
      cancelBtn.onclick = null;
      closeBtn.onclick = null;
      inputEl.onkeydown = null;
      resolve(result);
    };

    confirmBtn.onclick = () => cleanup(inputEl.value);
    cancelBtn.onclick = () => cleanup(null);
    closeBtn.onclick = () => cleanup(null);
    inputEl.onkeydown = (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        cleanup(inputEl.value);
      }
    };
    modal.classList.add('active');
    setTimeout(() => inputEl.focus(), 50);
  });
}

function showCopyDialog({ title = 'Copy Value', message = '', value = '' } = {}) {
  return new Promise((resolve) => {
    const modal = document.getElementById('modal-dialog');
    const titleEl = document.getElementById('dialog-modal-title');
    const msgEl = document.getElementById('dialog-modal-message');
    const inputWrap = document.getElementById('dialog-input-wrapper');
    const inputEl = document.getElementById('dialog-modal-input');
    const confirmBtn = document.getElementById('dialog-confirm-btn');
    const cancelBtn = document.getElementById('dialog-cancel-btn');
    const closeBtn = document.getElementById('dialog-modal-close');

    titleEl.textContent = title;
    msgEl.textContent = message;
    inputWrap.style.display = 'block';
    inputEl.readOnly = true;
    inputEl.value = value;
    cancelBtn.style.display = '';
    cancelBtn.textContent = 'Close';
    confirmBtn.textContent = 'Copy to Clipboard';
    confirmBtn.className = 'btn btn-primary';

    const cleanup = () => {
      modal.classList.remove('active');
      confirmBtn.onclick = null;
      cancelBtn.onclick = null;
      closeBtn.onclick = null;
      resolve();
    };

    confirmBtn.onclick = async () => {
      try {
        await navigator.clipboard.writeText(value);
        toast('Copied to clipboard!', 'success');
      } catch {
        inputEl.select();
        document.execCommand('copy');
        toast('Copied to clipboard!', 'success');
      }
      cleanup();
    };
    cancelBtn.onclick = () => cleanup();
    closeBtn.onclick = () => cleanup();
    modal.classList.add('active');
  });
}

document.querySelectorAll('[data-close-modal]').forEach((btn) => {
  btn.addEventListener('click', (e) => {
    const modal = e.target.closest('.modal-overlay');
    if (modal) modal.classList.remove('active');
  });
});

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    document.querySelectorAll('.modal-overlay.active').forEach((m) => m.classList.remove('active'));
  }
});

// Formatters
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatDate(ts) {
  if (!ts) return '--';
  const d = new Date(ts);
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function formatRelativeTime(ts) {
  if (!ts) return '--';
  const diff = Math.floor((Date.now() - new Date(ts).getTime()) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function formatDuration(sec) {
  if (!sec || sec < 0) return '--';
  const s = Math.floor(sec);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${s % 60}s`;
}

// ============================================================================
// Account Security Modal (Password, TOTP 2FA & Active Sessions)
// ============================================================================
function openSecurityModal(tab = 'password') {
  document.getElementById('change-password-form')?.reset();
  const pwdBar = document.getElementById('pwd-strength-bar');
  const pwdLbl = document.getElementById('pwd-strength-label');
  if (pwdBar) pwdBar.style.width = '0%';
  if (pwdLbl) pwdLbl.textContent = '';

  const is2fa = Boolean(state.user?.totpEnabled);
  const pwd2faGrp = document.getElementById('pwd-2fa-group');
  if (pwd2faGrp) pwd2faGrp.style.display = is2fa ? 'block' : 'none';

  const disBox = document.getElementById('sec-2fa-disabled-box');
  const enBox = document.getElementById('sec-2fa-enabled-box');
  if (disBox) disBox.style.display = is2fa ? 'none' : 'block';
  if (enBox) enBox.style.display = is2fa ? 'block' : 'none';

  document.getElementById('sec-2fa-step1-password')?.style && (document.getElementById('sec-2fa-step1-password').style.display = 'block');
  document.getElementById('sec-2fa-step2-verify')?.style && (document.getElementById('sec-2fa-step2-verify').style.display = 'none');
  document.getElementById('sec-2fa-step3-recovery')?.style && (document.getElementById('sec-2fa-step3-recovery').style.display = 'none');
  const setupPwd = document.getElementById('tfa-setup-password');
  if (setupPwd) setupPwd.value = '';
  const disPwd = document.getElementById('tfa-disable-password');
  if (disPwd) disPwd.value = '';
  const disCode = document.getElementById('tfa-disable-code');
  if (disCode) disCode.value = '';

  renderSecurityStatusSummary();
  switchSecurityTab(tab);
  openModal('modal-change-password');
}
window.openSecurityModal = openSecurityModal;

function switchSecurityTab(tab) {
  ['password', '2fa', 'sessions'].forEach((t) => {
    const btn = document.getElementById(`sec-tab-btn-${t}`);
    const pane = document.getElementById(`sec-pane-${t}`);
    if (btn) btn.classList.toggle('active', t === tab);
    if (pane) pane.style.display = t === tab ? 'block' : 'none';
  });
}
window.switchSecurityTab = switchSecurityTab;

function togglePasswordField(inputId, btn) {
  const el = document.getElementById(inputId);
  if (!el || !btn) return;
  if (el.type === 'password') {
    el.type = 'text';
    btn.textContent = 'Hide';
  } else {
    el.type = 'password';
    btn.textContent = 'Show';
  }
}
window.togglePasswordField = togglePasswordField;

document.getElementById('pwd-next')?.addEventListener('input', (e) => {
  const val = e.target.value || '';
  const bar = document.getElementById('pwd-strength-bar');
  const lbl = document.getElementById('pwd-strength-label');
  if (!bar || !lbl) return;

  let score = 0;
  if (val.length >= 8) score += 25;
  if (val.length >= 12) score += 25;
  if (/[A-Z]/.test(val) && /[a-z]/.test(val)) score += 25;
  if (/[0-9]/.test(val) || /[^A-Za-z0-9]/.test(val)) score += 25;

  bar.style.width = `${score}%`;
  if (!val.length) {
    lbl.textContent = '';
  } else if (score <= 25) {
    bar.className = 'progress-fill rose';
    lbl.textContent = 'Weak';
    lbl.style.color = 'var(--danger-light)';
  } else if (score <= 50) {
    bar.className = 'progress-fill amber';
    lbl.textContent = 'Fair';
    lbl.style.color = 'var(--warning-light)';
  } else if (score <= 75) {
    bar.className = 'progress-fill green';
    lbl.textContent = 'Good';
    lbl.style.color = 'var(--success-light)';
  } else {
    bar.className = 'progress-fill green';
    lbl.textContent = 'Strong';
    lbl.style.color = 'var(--success-light)';
  }
});

document.getElementById('save-change-password-btn')?.addEventListener('click', async (e) => {
  e.preventDefault();
  const current = document.getElementById('pwd-current').value;
  const next = document.getElementById('pwd-next').value;
  const confirm = document.getElementById('pwd-confirm').value;
  const totpCode = document.getElementById('pwd-2fa-code')?.value || '';
  const revokeOtherSessions = Boolean(document.getElementById('pwd-revoke-others')?.checked ?? true);

  if (!current) {
    toast('Please enter your current password.', 'warning');
    return;
  }
  if (next !== confirm) {
    toast('New passwords do not match.', 'warning');
    return;
  }
  if (next.length < 8) {
    toast('New password must be at least 8 characters long.', 'warning');
    return;
  }

  try {
    const res = await api('/api/auth/password', {
      method: 'POST',
      body: { current, next, totpCode, revokeOtherSessions },
    });
    if (revokeOtherSessions) state.activeSessions = 1;
    renderSecurityStatusSummary();
    toast(
      res.revokedSessions
        ? `Password updated and ${res.revokedSessions} other session(s) signed out!`
        : 'Password updated in SQLite!',
      'success'
    );
    closeModal('modal-change-password');
  } catch (err) {
    toast(`Failed to change password: ${err.message}`, 'error');
  }
});

async function start2faSetup() {
  const password = document.getElementById('tfa-setup-password')?.value || '';
  if (!password) {
    toast('Please enter your current password to begin 2FA setup.', 'warning');
    return;
  }
  try {
    const res = await api('/api/auth/2fa/setup', { method: 'POST', body: { password } });
    state.pending2faSecret = res.secret;
    const formattedSecret = (res.secret || '').replace(/(.{4})/g, '$1 ').trim();
    const secretEl = document.getElementById('tfa-secret-display');
    if (secretEl) secretEl.value = formattedSecret;

    const qrBox = document.getElementById('tfa-qr-container');
    if (qrBox) {
      qrBox.innerHTML = renderTotpQrSvg(res.otpauthUrl || res.secret);
    }

    document.getElementById('sec-2fa-step1-password').style.display = 'none';
    document.getElementById('sec-2fa-step2-verify').style.display = 'block';
    const verifyInput = document.getElementById('tfa-verify-code');
    if (verifyInput) {
      verifyInput.value = '';
      setTimeout(() => verifyInput.focus(), 50);
    }
    toast('Scan the QR code or copy the setup key into your authenticator app.', 'info');
  } catch (err) {
    toast(`2FA setup failed: ${err.message}`, 'error');
  }
}
window.start2faSetup = start2faSetup;

function copy2faSecret() {
  const raw = state.pending2faSecret || document.getElementById('tfa-secret-display')?.value || '';
  navigator.clipboard.writeText(raw.replace(/\s+/g, '')).then(() => {
    toast('2FA Base32 secret copied to clipboard!', 'success');
  });
}
window.copy2faSecret = copy2faSecret;

async function confirmEnable2fa() {
  const code = (document.getElementById('tfa-verify-code')?.value || '').trim();
  if (code.length < 6) {
    toast('Please enter the 6-digit code from your authenticator app.', 'warning');
    return;
  }
  try {
    const res = await api('/api/auth/2fa/enable', { method: 'POST', body: { code } });
    state.user.totpEnabled = true;
    state.lastRecoveryCodes = res.backupCodes || [];
    renderSecurityStatusSummary();

    const grid = document.getElementById('tfa-recovery-codes-grid');
    if (grid) {
      grid.innerHTML = (res.backupCodes || []).map((c) => `<div style="padding:4px; background:rgba(255,255,255,0.04); border-radius:4px;">${escapeHtml(c)}</div>`).join('');
    }
    document.getElementById('sec-2fa-step2-verify').style.display = 'none';
    document.getElementById('sec-2fa-step3-recovery').style.display = 'block';
    toast('Two-Factor Authentication enabled!', 'success');
  } catch (err) {
    toast(`Verification failed: ${err.message}`, 'error');
  }
}
window.confirmEnable2fa = confirmEnable2fa;

function copyRecoveryCodes() {
  const codes = (state.lastRecoveryCodes || []).join('\n');
  if (!codes) return;
  navigator.clipboard.writeText(codes).then(() => {
    toast('Recovery codes copied to clipboard!', 'success');
  });
}
window.copyRecoveryCodes = copyRecoveryCodes;

async function disable2fa() {
  const password = document.getElementById('tfa-disable-password')?.value || '';
  const code = (document.getElementById('tfa-disable-code')?.value || '').trim();
  if (!password || !code) {
    toast('Please enter both your current password and a 6-digit 2FA or recovery code.', 'warning');
    return;
  }
  try {
    await api('/api/auth/2fa/disable', { method: 'POST', body: { password, code } });
    state.user.totpEnabled = false;
    renderSecurityStatusSummary();
    toast('Two-Factor Authentication has been disabled.', 'info');
    closeModal('modal-change-password');
  } catch (err) {
    toast(`Disable 2FA failed: ${err.message}`, 'error');
  }
}
window.disable2fa = disable2fa;

async function revokeOtherSessions() {
  try {
    const res = await api('/api/auth/sessions/revoke-others', { method: 'POST' });
    state.activeSessions = 1;
    renderSecurityStatusSummary();
    toast(`Signed out ${res.revoked || 0} other active session(s)!`, 'success');
  } catch (err) {
    toast(`Failed to revoke sessions: ${err.message}`, 'error');
  }
}
window.revokeOtherSessions = revokeOtherSessions;

async function adminResetUser2fa(userId, username) {
  const ok = await showConfirmDialog({
    title: 'Reset User 2FA',
    message: `Are you sure you want to disable and reset Two-Factor Authentication for "${username}"?`,
    confirmText: 'Reset 2FA',
    danger: true,
  });
  if (!ok) return;
  try {
    await api(`/api/users/${userId}/reset-2fa`, { method: 'POST' });
    toast(`Reset 2FA for "${username}".`, 'success');
    loadSettingsView();
  } catch (err) {
    toast(`Reset 2FA failed: ${err.message}`, 'error');
  }
}
window.adminResetUser2fa = adminResetUser2fa;

// ============================================================================
// Pure-JS ISO/IEC 18004 QR Code SVG Generator (Offline, Zero External Calls)
// ============================================================================
function renderTotpQrSvg(text) {
  try {
    const matrix = generateQrMatrix(text);
    const n = matrix.length;
    const quiet = 2;
    const total = n + quiet * 2;
    let paths = '';
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        if (matrix[r][c]) {
          paths += `M${c + quiet},${r + quiet}h1v1h-1z`;
        }
      }
    }
    return `<svg viewBox="0 0 ${total} ${total}" width="140" height="140" shape-rendering="crispEdges" xmlns="http://www.w3.org/2000/svg"><rect width="${total}" height="${total}" fill="#ffffff"/><path d="${paths}" fill="#0f172a"/></svg>`;
  } catch {
    return `<div style="font-size:11px; color:#0f172a; text-align:center; padding:8px;">Use Setup Key</div>`;
  }
}

function generateQrMatrix(text) {
  const dataBytes = new TextEncoder().encode(text);
  // Version table for ECC Level L (versions 1..10): [totalCodewords, ecCodewordsPerBlock, numBlocks]
  const V_TABLE = [
    null,
    [26, 7, 1],
    [44, 10, 1],
    [70, 15, 1],
    [100, 20, 1],
    [134, 26, 1],
    [172, 18, 2],
    [196, 20, 2],
    [242, 24, 2],
    [292, 30, 2],
    [346, 18, 4],
  ];
  let ver = 1;
  while (ver <= 10) {
    const [totalCw, ecCw, blocks] = V_TABLE[ver];
    const dataCw = totalCw - ecCw * blocks;
    const headerBytes = ver < 10 ? 2 : 3;
    if (dataBytes.length + headerBytes <= dataCw) break;
    ver++;
  }
  if (ver > 10) ver = 10;
  const [totalCw, ecCw, numBlocks] = V_TABLE[ver];
  const totalDataCw = totalCw - ecCw * numBlocks;

  // Build bit stream: Byte mode (0100), length (8 or 16 bits), payload, terminator
  const bits = [];
  const pushBits = (val, len) => {
    for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1);
  };
  pushBits(0b0100, 4);
  pushBits(dataBytes.length, ver < 10 ? 8 : 16);
  for (const b of dataBytes) pushBits(b, 8);
  const maxBits = totalDataCw * 8;
  for (let i = 0; i < 4 && bits.length < maxBits; i++) bits.push(0);
  while (bits.length % 8 !== 0) bits.push(0);

  const dataCw = [];
  for (let i = 0; i < bits.length; i += 8) {
    let b = 0;
    for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
    dataCw.push(b);
  }
  let padToggle = true;
  while (dataCw.length < totalDataCw) {
    dataCw.push(padToggle ? 0xec : 0x11);
    padToggle = !padToggle;
  }

  // GF(256) Reed-Solomon
  const gfExp = new Uint8Array(512);
  const gfLog = new Uint8Array(256);
  let x = 1;
  for (let i = 0; i < 255; i++) {
    gfExp[i] = x;
    gfLog[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) gfExp[i] = gfExp[i - 255];
  const gfMul = (a, b) => (a === 0 || b === 0 ? 0 : gfExp[gfLog[a] + gfLog[b]]);

  let gen = [1];
  for (let i = 0; i < ecCw; i++) {
    const next = new Array(gen.length + 1).fill(0);
    for (let j = 0; j < gen.length; j++) {
      next[j] ^= gen[j];
      next[j + 1] ^= gfMul(gen[j], gfExp[i]);
    }
    gen = next;
  }

  const rsEncode = (msg) => {
    const rem = new Uint8Array(ecCw);
    for (const b of msg) {
      const factor = b ^ rem[0];
      rem.copyWithin(0, 1);
      rem[ecCw - 1] = 0;
      for (let i = 0; i < ecCw; i++) rem[i] ^= gfMul(gen[i + 1], factor);
    }
    return Array.from(rem);
  };

  const dataBlocks = [];
  const ecBlocks = [];
  const baseBlockLen = Math.floor(totalDataCw / numBlocks);
  const extraBlocks = totalDataCw % numBlocks;
  let offset = 0;
  for (let b = 0; b < numBlocks; b++) {
    const len = baseBlockLen + (b >= numBlocks - extraBlocks ? 1 : 0);
    const blk = dataCw.slice(offset, offset + len);
    offset += len;
    dataBlocks.push(blk);
    ecBlocks.push(rsEncode(blk));
  }

  const finalCw = [];
  const maxDataLen = baseBlockLen + (extraBlocks > 0 ? 1 : 0);
  for (let i = 0; i < maxDataLen; i++) {
    for (let b = 0; b < numBlocks; b++) {
      if (i < dataBlocks[b].length) finalCw.push(dataBlocks[b][i]);
    }
  }
  for (let i = 0; i < ecCw; i++) {
    for (let b = 0; b < numBlocks; b++) finalCw.push(ecBlocks[b][i]);
  }

  const size = ver * 4 + 17;
  const grid = Array.from({ length: size }, () => new Uint8Array(size));
  const reserved = Array.from({ length: size }, () => new Uint8Array(size));

  const setFinder = (r0, c0) => {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const rr = r0 + r;
        const cc = c0 + c;
        if (rr < 0 || rr >= size || cc < 0 || cc >= size) continue;
        const on =
          (r >= 0 && r <= 6 && (c === 0 || c === 6)) ||
          (c >= 0 && c <= 6 && (r === 0 || r === 6)) ||
          (r >= 2 && r <= 4 && c >= 2 && c <= 4);
        grid[rr][cc] = on ? 1 : 0;
        reserved[rr][cc] = 1;
      }
    }
  };
  setFinder(0, 0);
  setFinder(0, size - 7);
  setFinder(size - 7, 0);

  for (let i = 8; i < size - 8; i++) {
    grid[6][i] = i % 2 === 0 ? 1 : 0;
    reserved[6][i] = 1;
    grid[i][6] = i % 2 === 0 ? 1 : 0;
    reserved[i][6] = 1;
  }

  const ALIGN_POS = [
    [],
    [],
    [6, 18],
    [6, 22],
    [6, 26],
    [6, 30],
    [6, 34],
    [6, 22, 38],
    [6, 24, 42],
    [6, 26, 46],
    [6, 28, 50],
  ];
  const apos = ALIGN_POS[ver];
  for (const ar of apos) {
    for (const ac of apos) {
      if (reserved[ar][ac]) continue;
      for (let r = -2; r <= 2; r++) {
        for (let c = -2; c <= 2; c++) {
          const on = Math.max(Math.abs(r), Math.abs(c)) !== 1;
          grid[ar + r][ac + c] = on ? 1 : 0;
          reserved[ar + r][ac + c] = 1;
        }
      }
    }
  }

  for (let i = 0; i < 9; i++) {
    if (i < size) {
      reserved[8][i] = 1;
      reserved[i][8] = 1;
    }
  }
  for (let i = 0; i < 8; i++) {
    reserved[8][size - 1 - i] = 1;
    reserved[size - 1 - i][8] = 1;
  }
  grid[size - 8][8] = 1;

  if (ver >= 7) {
    let vinfo = ver;
    for (let i = 0; i < 12; i++) vinfo = (vinfo << 1) ^ ((vinfo >>> 11) * 0x1f25);
    const vbits = (ver << 12) | vinfo;
    for (let i = 0; i < 18; i++) {
      const bit = (vbits >>> i) & 1;
      const r = Math.floor(i / 3);
      const c = size - 11 + (i % 3);
      grid[r][c] = bit;
      reserved[r][c] = 1;
      grid[c][r] = bit;
      reserved[c][r] = 1;
    }
  }

  let bitIdx = 0;
  const totalBits = finalCw.length * 8;
  let upward = true;
  for (let col = size - 1; col >= 1; col -= 2) {
    if (col === 6) col = 5;
    for (let step = 0; step < size; step++) {
      const r = upward ? size - 1 - step : step;
      for (let dc = 0; dc < 2; dc++) {
        const c = col - dc;
        if (reserved[r][c]) continue;
        let bit = 0;
        if (bitIdx < totalBits) {
          bit = (finalCw[bitIdx >>> 3] >>> (7 - (bitIdx & 7))) & 1;
          bitIdx++;
        }
        if ((r + c) % 2 === 0) bit ^= 1; // Mask 0
        grid[r][c] = bit;
      }
    }
    upward = !upward;
  }

  // Format info for ECC Level L (01) + Mask 0 (000) -> 0x77c4
  const fmtBits = 0x77c4;
  const fPos1 = [
    [8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8],
    [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8],
  ];
  for (let i = 0; i < 15; i++) {
    const bit = (fmtBits >>> i) & 1;
    const [r1, c1] = fPos1[i];
    grid[r1][c1] = bit;
    if (i < 7) grid[size - 1 - i][8] = bit;
    else grid[8][size - 15 + i] = bit;
  }

  return grid;
}

// Start application
initAuth();


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
