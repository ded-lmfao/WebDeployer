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
  databases: [],
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

function setHtmlIfChanged(el, html) {
  if (!el) return;
  if (el._lastHtml === html) return;
  el._lastHtml = html;
  el.innerHTML = html;
}

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

  const nextBarHtml = `
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
  if (bar.getAttribute('data-sig') !== `${startIdx}:${endIdx}:${total}:${curPage}`) {
    bar.setAttribute('data-sig', `${startIdx}:${endIdx}:${total}:${curPage}`);
    bar.innerHTML = nextBarHtml;
  }
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
    install_cmd: 'pip install -r requirements.txt --break-system-packages --ignore-installed',
    build_cmd: '',
    start_cmd: 'python3 -m uvicorn main:app --host 127.0.0.1 --port {{PORT}}',
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

// Hydrate warm cache from sessionStorage on startup (never cache /api/auth/*)
try {
  const raw = sessionStorage.getItem(SESSION_CACHE_KEY);
  if (raw) {
    const parsed = JSON.parse(raw);
    const now = Date.now();
    if (Array.isArray(parsed)) {
      for (const [k, v] of parsed) {
        if (typeof k === 'string' && !k.startsWith('/api/auth/') && v && typeof v.ts === 'number' && now - v.ts < 60000) {
          clientCache.set(k, v);
        }
      }
    }
  }
} catch (_) {}

function persistCacheToSession() {
  try {
    const entries = Array.from(clientCache.entries())
      .filter(([k]) => !k.startsWith('/api/auth/'))
      .slice(-60);
    sessionStorage.setItem(SESSION_CACHE_KEY, JSON.stringify(entries));
  } catch (_) {}
}

function getCacheTtlMs(path) {
  if (path.startsWith('/api/auth/')) return 0; // Always verify live authentication state with server
  if (path.startsWith('/api/logs')) return 0; // Live logs use SSE stream
  if (path.startsWith('/api/databases')) return 0; // Live database status
  if (path.startsWith('/api/overview') || path.startsWith('/api/monitor')) return 2500;
  if (path.startsWith('/api/deployments')) return 4000;
  if (path.startsWith('/api/audit')) return 8000;
  if (path.includes('/commits')) return 45000;
  if (path.includes('/releases') || path.includes('/backups') || path.includes('/env')) return 20000;
  if (path.includes('/caddy') || path.includes('/nginx')) return 60000;
  if (path.startsWith('/api/projects') || path.startsWith('/api/settings') || path.startsWith('/api/users')) return 12000;
  return 8000;
}

function hasCachedApi(path) {
  return clientCache.has(path);
}
window.hasCachedApi = hasCachedApi;

function invalidateClientCache(prefix = '') {
  if (!prefix) {
    clientCache.clear();
    inflightGets.clear();
  } else {
    for (const k of clientCache.keys()) {
      if (k.startsWith(prefix) || k.includes(prefix)) {
        clientCache.delete(k);
      }
    }
    for (const k of inflightGets.keys()) {
      if (k.startsWith(prefix) || k.includes(prefix)) {
        inflightGets.delete(k);
      }
    }
  }
  try {
    sessionStorage.removeItem(SESSION_CACHE_KEY);
  } catch (_) {}
}
window.invalidateClientCache = invalidateClientCache;

async function copyTextToClipboard(text, msg = 'Copied to clipboard') {
  try {
    await navigator.clipboard.writeText(text);
    toast(msg, 'success');
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    toast(msg, 'success');
  }
}
window.copyTextToClipboard = copyTextToClipboard;

async function networkFetch(path, options = {}) {
  const headers = {
    'Accept': 'application/json',
    ...(options.headers || {}),
  };
  if (state.csrf && options.method && options.method !== 'GET') {
    headers['X-CSRF-Token'] = state.csrf;
  }
  const fetchOpts = { ...options };
  if (fetchOpts.noCache) {
    fetchOpts.cache = 'no-store';
  }
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

  if (
    res.status === 401
    && !path.startsWith('/api/auth/login')
    && !path.startsWith('/api/auth/2fa/verify-login')
    && !path.startsWith('/api/auth/passkeys/login/')
  ) {
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
function resetCleanUrl() {
  try {
    if (window.location.hash || window.location.search) {
      window.history.replaceState(null, '', window.location.pathname || '/');
    }
  } catch (_) {}
}

function stopPolling() {
  if (state.overviewTimer) {
    clearInterval(state.overviewTimer);
    state.overviewTimer = null;
  }
  if (state.activeDepPollTimer) {
    clearInterval(state.activeDepPollTimer);
    state.activeDepPollTimer = null;
  }
  if (state.logEventSource) {
    try { state.logEventSource.close(); } catch (_) {}
    state.logEventSource = null;
  }
}

async function initAuth() {
  document.body.classList.remove('auth-verified');
  const appEl = document.getElementById('app');
  if (appEl) {
    appEl.style.display = 'none';
    appEl.setAttribute('aria-hidden', 'true');
  }
  try {
    const me = await api('/api/auth/me', { noCache: true });
    if (!me || !me.user || !me.csrf) {
      showLogin();
      return;
    }
    state.user = me.user;
    state.csrf = me.csrf;
    state.activeSessions = me.activeSessions || 1;
    state.passkeyCount = me.passkeyCount || 0;
    await onAuthenticated(false);
  } catch {
    showLogin();
  }
}

function showLogin() {
  stopPolling();
  document.body.classList.remove('auth-verified');

  state.user = null;
  state.csrf = null;
  state.pendingMfaToken = null;
  state.projects = [];
  state.overview = null;
  state.selectedProjectId = null;
  state.currentView = 'overview';
  state.lastOverviewSig = null;
  invalidateClientCache();
  try { sessionStorage.clear(); } catch (_) {}

  // Reset URL to clean root (strip #/settings, #/projects, query params, etc.)
  resetCleanUrl();

  // Close any open modals
  document.querySelectorAll('.modal-overlay.active').forEach((m) => m.classList.remove('active'));

  const appEl = document.getElementById('app');
  if (appEl) {
    appEl.style.display = 'none';
    appEl.setAttribute('aria-hidden', 'true');
  }
  const loginView = document.getElementById('login-view');
  if (loginView) {
    loginView.style.display = 'flex';
    startLoginCanvasAnimation();
  }

  const lf = document.getElementById('login-form');
  const mf = document.getElementById('login-2fa-form');
  if (lf) lf.style.display = 'block';
  if (mf) mf.style.display = 'none';

  const passInput = document.getElementById('login-password');
  if (passInput) {
    passInput.value = '';
    passInput.type = 'password';
  }
  const toggleBtn = document.getElementById('toggle-pw-visibility');
  if (toggleBtn) toggleBtn.textContent = 'Show';
  const codeInput = document.getElementById('login-2fa-code');
  if (codeInput) codeInput.value = '';
}

let loginCanvasAnimId = null;
let loginCanvasCleanup = null;

function startLoginCanvasAnimation() {
  // Clean, minimalist pre-auth: 0% CPU, no heavy background animation loops
  stopLoginCanvasAnimation();
}

function stopLoginCanvasAnimation() {
  if (loginCanvasAnimId) {
    cancelAnimationFrame(loginCanvasAnimId);
    loginCanvasAnimId = null;
  }
  if (loginCanvasCleanup) {
    loginCanvasCleanup();
    loginCanvasCleanup = null;
  }
}
window.startLoginCanvasAnimation = startLoginCanvasAnimation;
window.stopLoginCanvasAnimation = stopLoginCanvasAnimation;

function togglePasswordField(inputId, btn) {
  const el = typeof inputId === 'string' ? document.getElementById(inputId) : inputId;
  if (!el || !btn) return;
  const isPass = el.type === 'password';
  el.type = isPass ? 'text' : 'password';
  btn.textContent = isPass ? 'Hide' : 'Show';
}
window.togglePasswordField = togglePasswordField;

function toggleLoginPasswordVisibility() {
  togglePasswordField('login-password', document.getElementById('toggle-pw-visibility'));
}
window.toggleLoginPasswordVisibility = toggleLoginPasswordVisibility;

function hasPower(power) {
  if (!state.user) return false;
  if (state.user.isMainAdmin) return true;
  const perms = state.user.permissions || [];
  return perms.includes('*') || perms.includes(power);
}
window.hasPower = hasPower;

async function onAuthenticated(isFreshLogin = false) {
  if (!state.user || !state.csrf || state.pendingMfaToken) {
    showLogin();
    return;
  }

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

  // Load projects and databases before revealing the main application shell
  await Promise.all([loadProjects(), loadDatabases()]);

  document.getElementById('login-view').style.display = 'none';
  stopLoginCanvasAnimation();
  const appEl = document.getElementById('app');
  if (appEl) {
    appEl.style.display = 'flex';
    appEl.setAttribute('aria-hidden', 'false');
  }
  document.body.classList.add('auth-verified');

  if (isFreshLogin) {
    navigateTo('overview');
  } else {
    handleHashRoute();
  }
  startPolling();
}

async function applyAuthSuccess(res) {
  state.pendingMfaToken = null;
  state.user = res.user;
  state.csrf = res.csrf;
  state.activeSessions = res.activeSessions || 1;
  state.passkeyCount = res.passkeyCount || 0;
  await onAuthenticated(true);
}

// ============================================================================
// Router, Website Card Workspace & Navigation
// ============================================================================
const WEBSITE_WORKSPACE_TABS = new Set([
  'deployments',
  'github',
  'logs',
  'env',
  'files',
  'releases',
  'rollbacks',
  'monitor',
  'audit',
]);

function openWebsiteWorkspace(projectId, tab = null) {
  state.selectedProjectId = Number(projectId);
  prefetchWebsiteWorkspace(state.selectedProjectId);
  const p = state.projects.find((x) => x.id === state.selectedProjectId);
  const isLocalService = p && p.project_kind === 'service' && (!p.repo_url || p.repo_url === 'local' || (p.project_type && p.project_type.includes('lavalink')));
  const targetTab = tab || (isLocalService ? 'files' : 'deployments');
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

  window.location.hash = projectId ? `#/${viewName}/${projectId}` : `#/${viewName}`;
  renderCurrentView();
}
window.navigateTo = navigateTo;

function handleHashRoute() {
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

  const bannerSig = `${p.id}:${p.name}:${p.slug}:${p.app_status}:${p.port}:${p.branch}:${p.deployed_sha}:${(p.domains || []).join(',')}:${p.project_kind}:${p.project_type}`;
  if (state.lastWsBannerSig !== bannerSig) {
    state.lastWsBannerSig = bannerSig;

    const links = document.getElementById('ws-project-links');
    if (links) {
      const sha = p.deployed_sha ? p.deployed_sha.slice(0, 7) : 'Not deployed';
      if (isService) {
        let typeLabel = '🤖 Service';
        const pt = (p.project_type || '').toLowerCase();
        if (pt.includes('lavalink') || (p.start_cmd && p.start_cmd.toLowerCase().includes('lavalink'))) typeLabel = '☕ Lavalink Audio Server';
        else if (pt.includes('discord')) typeLabel = '🤖 Discord Bot';
        else if (pt.includes('telegram')) typeLabel = '✈️ Telegram Bot';
        else if (pt.includes('python') || (p.start_cmd && p.start_cmd.includes('python'))) typeLabel = '🐍 Python Daemon';
        else if (pt.includes('node') || (p.start_cmd && p.start_cmd.includes('node'))) typeLabel = '⚡ Node.js Worker';
        else if (pt.includes('worker')) typeLabel = '⚙️ Queue Worker';

        const isLocal = !p.repo_url || p.repo_url === 'local' || pt.includes('lavalink');
        const serviceDomainLink = (p.domains && p.domains.length > 0)
          ? `<a class="ws-meta-link active" href="https://${escapeHtml(p.domains[0])}" target="_blank" style="color:var(--accent-light); font-weight:600;" title="Custom Domain: https://${escapeHtml(p.domains[0])}">
               <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="12" cy="12" r="10"></circle><line x1="2" y1="12" x2="22" y2="12"></line><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path></svg>
               <span>${escapeHtml(p.domains[0])}</span>
             </a><span class="ws-meta-sep">&bull;</span>`
          : '';

        let accessText = '🔒 Localhost';
        if (p.access_mode === 'allowlist') accessText = '🛡️ Allowlist';
        else if (p.access_mode === 'public') accessText = '🌐 Public';

        links.innerHTML = `
          ${serviceDomainLink}
          <span class="ws-meta-item" style="color:var(--accent-light); font-weight:600;">
            ${escapeHtml(typeLabel)}
          </span>
          <span class="ws-meta-sep">&bull;</span>
          ${isLocal ? `
            <span class="ws-meta-item" title="Deployment Mode">
              <span class="badge badge-neutral" style="font-size:11px; padding: 2px 7px;">📁 Manual Upload</span>
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
               <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="12" cy="12" r="10"></circle><line x1="2" y1="12" x2="22" y2="12"></line><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path></svg>
               <span>${escapeHtml(customDomains[0])}</span>
             </a>`
          : url
            ? `<a class="ws-meta-link active" href="${url}" target="_blank" title="Open ${url}">
                 <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line></svg>
                 <span>${url}</span>
               </a>`
            : '';

        let accessText = '🔒 Localhost';
        if (p.access_mode === 'allowlist') accessText = '🛡️ Allowlist';
        else if (p.access_mode === 'public') accessText = '🌐 Public';

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

  const tabsBar = document.getElementById('ws-tabs-bar');
  let activeBtn = null;
  document.querySelectorAll('#ws-tabs-bar .ws-tab-item').forEach((btn) => {
    const tab = btn.getAttribute('data-ws-tab');
    const reqPower = tabPowerMap[tab];
    const isActive = tab === state.currentView;
    const isLocalService = isService && (!p.repo_url || p.repo_url === 'local' || (p.project_type && p.project_type.includes('lavalink')));
    if (tab === 'files' && !isService) {
      btn.style.display = 'none';
    } else if (isLocalService && (tab === 'github' || tab === 'deployments' || tab === 'releases' || tab === 'rollbacks')) {
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

// ============================================================================
// Projects Management
// ============================================================================
async function loadProjects() {
  try {
    state.projects = await api('/api/projects', { noCache: true });
    const websites = (state.projects || []).filter((p) => p.project_kind !== 'service');
    const services = (state.projects || []).filter((p) => p.project_kind === 'service');

    const badgeEl = document.getElementById('badge-projects-count');
    if (badgeEl) badgeEl.textContent = websites.length;

    const badgeServicesEl = document.getElementById('badge-services-count');
    if (badgeServicesEl) badgeServicesEl.textContent = services.length;

    // Keep databases count badge continuously synchronized
    loadDatabases().catch(() => {});

    if (state.projects.length > 0 && !state.selectedProjectId) {
      state.selectedProjectId = state.projects[0].id;
    }
    renderWebsiteWorkspaceHeader();
  } catch (err) {
    toast(`Failed to load projects: ${err.message}`, 'error');
  }
}

async function loadProjectsView() {
  await loadProjects();
  renderProjectsList();
}
window.loadProjectsView = loadProjectsView;

async function loadServicesView() {
  await loadProjects();
  renderServicesList();
}
window.loadServicesView = loadServicesView;

function getSelectedProject() {
  return state.projects.find((p) => p.id === state.selectedProjectId) || state.projects[0] || null;
}

// ============================================================================
// View 1: Overview & Live Resource Consumption
// ============================================================================
function renderResourceBreakdown(resources) {
  const tbody = document.getElementById('resource-breakdown-table');
  if (!tbody) return;
  const list = resources || state.overview?.resources || [];
  const filter = state.resourceFilter || 'all';
  const filtered = filter === 'all' ? list : list.filter((r) => r.kind === filter);

  if (!filtered.length) {
    let emptyMsg = 'No active workloads found.';
    let emptyAction = '';
    if (filter === 'website') {
      emptyMsg = 'No hosted websites created yet.';
      emptyAction = '<button class="btn btn-primary btn-sm" style="margin-top: 10px;" onclick="openAddWebsiteModal()">+ Add Website</button>';
    } else if (filter === 'service') {
      emptyMsg = 'No backend services or bots created yet.';
      emptyAction = '<button class="btn btn-primary btn-sm" style="margin-top: 10px;" onclick="openAddServiceModal()">+ Add Service</button>';
    } else if (filter === 'database') {
      emptyMsg = 'No managed databases created yet.';
      emptyAction = '<button class="btn btn-primary btn-sm" style="margin-top: 10px;" onclick="navigateTo(\'databases\')">Go to Databases &rarr;</button>';
    }
    tbody.innerHTML = `<tr><td colspan="7" style="text-align: center; padding: 32px 16px; color: var(--text-dim);"><div style="font-size: 13.5px;">${emptyMsg}</div>${emptyAction}</td></tr>`;
    return;
  }

  tbody.innerHTML = filtered.map((r) => {
    const isRunning = r.status === 'running';
    const isMaintenance = r.status === 'maintenance';
    const kindUpper = r.kind.toUpperCase();
    const kindBadgeClass = `badge-res-${r.kind}`;
    const icon = r.kind === 'panel' ? '⚡' : r.kind === 'database' ? '🗄️' : r.kind === 'service' ? '🤖' : '🌐';
    
    let subtitle = '';
    if (r.kind === 'panel') {
      subtitle = '<span style="color:var(--text-dim)">Core Platform Daemon</span>';
    } else if (r.kind === 'database') {
      subtitle = '<span style="color:var(--text-dim)">PostgreSQL Instance</span>';
    } else if (r.kind === 'service') {
      const sha = r.commitSha ? `<span class="sha-pill" style="font-size:10px; margin-left:4px;">${r.commitSha.slice(0, 7)}</span>` : '';
      subtitle = `<span style="color:var(--text-dim)">Backend Service</span>${sha}`;
    } else {
      const dom = r.domain ? `<a href="http://${escapeHtml(r.domain)}" target="_blank" class="domain-badge" style="font-size:11px;" onclick="event.stopPropagation()">${escapeHtml(r.domain)}</a>` : (r.port ? `<span style="color:var(--text-dim)">:${r.port}</span>` : '<span style="color:var(--text-dim)">Local only</span>');
      const sha = r.commitSha ? `<span class="sha-pill" style="font-size:10px; margin-left:4px;">${r.commitSha.slice(0, 7)}</span>` : '';
      subtitle = `${dom}${sha}`;
    }

    const portPid = [
      r.port ? `:${r.port}` : null,
      r.pid ? `<span class="res-pid-chip">PID ${r.pid}</span>` : null,
    ].filter(Boolean).join(' ') || '<span style="color:var(--text-dim)">--</span>';

    const cpuVal = (r.cpuPct || 0).toFixed(1);
    const cpuWarm = r.cpuPct > 40 ? 'hot' : r.cpuPct > 15 ? 'warm' : '';
    const memVal = r.memoryFormatted || '0 MB';
    const memPctVal = (r.memoryPct || 0).toFixed(1);
    const memWarm = r.memoryPct > 30 ? 'hot' : r.memoryPct > 15 ? 'warm' : '';

    let actionBtn = '';
    if (r.kind === 'panel') {
      actionBtn = '<button class="btn btn-secondary btn-sm" onclick="navigateTo(\'settings\')">Settings &rarr;</button>';
    } else if (r.kind === 'database') {
      actionBtn = '<button class="btn btn-secondary btn-sm" onclick="navigateTo(\'databases\')">Databases &rarr;</button>';
    } else if (r.project_id) {
      actionBtn = `<button class="btn btn-primary btn-sm" onclick="openWebsiteWorkspace(${r.project_id}, 'deployments')">Manage &rarr;</button>`;
    }

    const rowClick = r.project_id ? `style="cursor: pointer;" onclick="openWebsiteWorkspace(${r.project_id}, 'deployments')"` : '';

    return `
      <tr ${rowClick}>
        <td>
          <div class="res-workload-title">
            <div class="res-workload-icon">${icon}</div>
            <div>
              <div class="res-workload-name">${escapeHtml(r.name)}</div>
              <div class="res-workload-sub">${subtitle}</div>
            </div>
          </div>
        </td>
        <td><span class="${kindBadgeClass}">${kindUpper}</span></td>
        <td>${portPid}</td>
        <td>
          <span class="status-dot ${isRunning ? 'online' : isMaintenance ? 'maintenance' : 'offline'}"></span>
          <span style="font-size: 12px; font-weight: 600; margin-left: 5px; color: ${isRunning ? 'var(--success)' : isMaintenance ? 'var(--warning)' : 'var(--text-muted)'};">${isRunning ? 'Running' : isMaintenance ? 'Maintenance' : 'Stopped'}</span>
        </td>
        <td>
          <div class="res-metric-cell">
            <div class="res-metric-head">
              <span style="color: ${isRunning ? 'var(--text-main)' : 'var(--text-dim)'}; font-weight: 600;">${isRunning ? `${cpuVal}%` : '0%'}</span>
              <span style="color: var(--text-dim); font-size: 11px;">CPU</span>
            </div>
            <div class="res-mini-bar">
              <div class="res-mini-fill res-cpu-fill ${cpuWarm}" style="width: ${isRunning ? Math.min(100, Math.max(2, r.cpuPct * 2)) : 0}%;"></div>
            </div>
          </div>
        </td>
        <td>
          <div class="res-metric-cell">
            <div class="res-metric-head">
              <span style="color: ${isRunning ? 'var(--text-main)' : 'var(--text-dim)'}; font-weight: 600;">${isRunning ? memVal : '0 MB'}</span>
              <span style="color: var(--text-dim); font-size: 11px;">${isRunning ? `${memPctVal}% VPS` : '--'}</span>
            </div>
            <div class="res-mini-bar">
              <div class="res-mini-fill res-mem-fill ${memWarm}" style="width: ${isRunning ? Math.min(100, Math.max(2, r.memoryPct)) : 0}%;"></div>
            </div>
          </div>
        </td>
        <td style="text-align: right;" onclick="event.stopPropagation()">
          ${actionBtn}
        </td>
      </tr>
    `;
  }).join('');
}

window.filterResourceBreakdown = function(filter) {
  state.resourceFilter = filter;
  document.querySelectorAll('#resource-filter-pills .pill').forEach((btn) => {
    btn.classList.toggle('active', btn.getAttribute('data-res-filter') === filter);
  });
  renderResourceBreakdown();
};

async function loadOverview() {
  try {
    const data = await api('/api/overview');
    state.overview = data;

    // Server Stats
    const m = data.monitor || {};
    const ovWeb = (data.projects || []).filter((x) => x.project.project_kind !== 'service');
    const ovSvc = (data.projects || []).filter((x) => x.project.project_kind === 'service');
    document.getElementById('stat-total-projects').textContent = ovWeb.length;
    document.getElementById('stat-total-services').textContent = ovSvc.length;

    // Keep navigation sidebar counts updated immediately
    const badgeWebEl = document.getElementById('badge-projects-count');
    if (badgeWebEl) badgeWebEl.textContent = ovWeb.length;
    const badgeSvcEl = document.getElementById('badge-services-count');
    if (badgeSvcEl) badgeSvcEl.textContent = ovSvc.length;
    loadDatabases().catch(() => {});

    const svcOnline = ovSvc.filter((x) => x.app?.running).length;
    document.getElementById('stat-services-online').textContent = svcOnline;
    document.getElementById('stat-services-offline').textContent = ovSvc.length - svcOnline;
    
    let online = 0;
    let offline = 0;
    ovWeb.forEach((item) => {
      if (item.app?.running) online++; else offline++;
    });
    document.getElementById('stat-online-count').textContent = online;
    document.getElementById('stat-offline-count').textContent = offline;

    const cpuPct = m.cpu?.pct || 0;
    const cpuCores = m.cpu?.cores || 1;
    document.getElementById('stat-cpu-pct').textContent = `${cpuPct}%`;
    const cpuBar = document.getElementById('stat-cpu-bar');
    if (cpuBar) {
      cpuBar.style.width = `${Math.min(100, cpuPct)}%`;
      cpuBar.className = `progress-fill ${cpuPct > 80 ? 'rose' : cpuPct > 50 ? 'amber' : 'green'}`;
    }
    const cpuMeta = document.getElementById('stat-cpu-meta');
    if (cpuMeta) cpuMeta.textContent = `${cpuCores} Core${cpuCores === 1 ? '' : 's'} (${cpuPct}% total)`;

    const memPct = m.memory?.pct || 0;
    const usedMb = ((m.memory?.used || 0) / 1048576).toFixed(0);
    const totalMb = ((m.memory?.total || 0) / 1048576).toFixed(0);
    document.getElementById('stat-mem-pct').textContent = `${memPct}%`;
    const memBar = document.getElementById('stat-mem-bar');
    if (memBar) {
      memBar.style.width = `${Math.min(100, memPct)}%`;
      memBar.className = `progress-fill ${memPct > 85 ? 'rose' : memPct > 65 ? 'amber' : 'green'}`;
    }
    const memMeta = document.getElementById('stat-mem-meta');
    if (memMeta) memMeta.textContent = `${usedMb} MB / ${totalMb} MB`;

    if (m.disk) {
      const freeGb = (m.disk.free / 1073741824).toFixed(1);
      const totalGb = (m.disk.total / 1073741824).toFixed(1);
      document.getElementById('stat-disk-free').textContent = `${freeGb} GB`;
      document.getElementById('stat-disk-meta').textContent = `${totalGb} GB total (${m.disk.pct}% used)`;
    }

    // Active resource summary bar
    const sum = data.summary || {};
    const panelUsageEl = document.getElementById('res-panel-usage');
    if (panelUsageEl) {
      panelUsageEl.textContent = `${sum.panelMemoryFormatted || '--'} • ${(sum.panelCpu || 0).toFixed(1)}% CPU`;
    }
    const workloadsUsageEl = document.getElementById('res-workloads-usage');
    if (workloadsUsageEl) {
      workloadsUsageEl.textContent = `${sum.totalManagedMemoryFormatted || '--'} • ${(sum.totalManagedCpu || 0).toFixed(1)}% CPU`;
    }
    const sysUsageEl = document.getElementById('res-system-usage');
    if (sysUsageEl) {
      sysUsageEl.textContent = sum.systemOverheadMemoryFormatted || '--';
    }
    const freeMemEl = document.getElementById('res-free-memory');
    if (freeMemEl) {
      const freeMb = ((m.memory?.free || 0) / 1048576).toFixed(0);
      freeMemEl.textContent = `${freeMb} MB free`;
    }
    const countBadgeEl = document.getElementById('res-workloads-count-badge');
    if (countBadgeEl) {
      countBadgeEl.textContent = `${sum.runningWorkloadsCount || 0} / ${sum.totalWorkloadsCount || 0} Running`;
    }

    // Render active resources telemetry table
    renderResourceBreakdown(data.resources);

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

  const websites = (state.projects || []).filter((p) => p.project_kind !== 'service');

  // Update filter pill counts
  const countAll = websites.length;
  const countRunning = websites.filter((p) => p.app_status === 'running').length;
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
  const filtered = websites.filter((p) => {
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
    const primaryDomain = domains.length
      ? `<a class="domain-badge" href="https://${escapeHtml(domains[0])}" target="_blank" onclick="event.stopPropagation()">${escapeHtml(domains[0])} &nearr;</a>`
      : (p.port ? `<a class="domain-badge" href="http://127.0.0.1:${p.port}" target="_blank" onclick="event.stopPropagation()">127.0.0.1:${p.port} &nearr;</a>` : '');

    const sha = p.deployed_sha ? `<span class="sha-pill">${p.deployed_sha.slice(0, 7)}</span>` : '<span style="color:var(--text-dim)">Not deployed</span>';

    let accessBadge = '<span class="badge badge-neutral" style="font-size: 10px;">🔒 Localhost</span>';
    if (p.access_mode === 'allowlist') {
      const ipList = p.allowed_ips ? p.allowed_ips.split(/[,;\n]/).filter(Boolean).length : 0;
      accessBadge = `<span class="badge badge-primary" style="font-size: 10px;">🛡️ Allowlist (${ipList})</span>`;
    } else if (p.access_mode === 'public') {
      accessBadge = '<span class="badge badge-warning" style="font-size: 10px;">🌐 Public</span>';
    }

    return `
      <div class="project-card" style="cursor: pointer; transition: transform 0.15s ease, border-color 0.15s ease;" onclick="openWebsiteWorkspace(${p.id}, 'deployments')">
        <div class="project-card-header">
          <div>
            <div class="project-info-title">
              <span class="status-dot ${isOnline ? 'online' : isMaintenance ? 'maintenance' : 'offline'}"></span>
              <span>${escapeHtml(p.name)}</span>
            </div>
            ${primaryDomain ? `<div class="project-info-domains">${primaryDomain}</div>` : ''}
          </div>
          <span class="badge ${isOnline ? 'badge-success' : isMaintenance ? 'badge-warning' : 'badge-danger'}">${isOnline ? 'ONLINE' : isMaintenance ? 'MAINTENANCE' : 'OFFLINE'}</span>
        </div>

        <div class="project-meta-row">
          <div class="project-meta-item">
            <span><strong>${escapeHtml(p.branch || 'main')}</strong></span>
          </div>
          <div class="project-meta-item">
            <span>${sha}</span>
          </div>
          ${p.port ? `<div class="project-meta-item"><span>Port <strong>${p.port}</strong></span></div>` : ''}
          <div class="project-meta-item">
            ${accessBadge}
          </div>
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
            Manage &rarr;
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
// View 2.5: Backend Services & Bots
// ============================================================================
function renderServicesList() {
  const container = document.getElementById('services-cards-container');
  if (!container) return;

  const services = (state.projects || []).filter((p) => p.project_kind === 'service');

  if (!state.serviceStatusFilter) state.serviceStatusFilter = 'all';

  const countAll = services.length;
  const countRunning = services.filter((p) => p.app_status === 'running').length;
  const countStopped = countAll - countRunning;
  const elAll = document.getElementById('services-filter-count-all');
  const elRunning = document.getElementById('services-filter-count-running');
  const elStopped = document.getElementById('services-filter-count-stopped');
  if (elAll) elAll.textContent = countAll;
  if (elRunning) elRunning.textContent = countRunning;
  if (elStopped) elStopped.textContent = countStopped;

  document.querySelectorAll('#services-status-filters .pill').forEach((btn) => {
    btn.classList.toggle('active', btn.getAttribute('data-filter') === state.serviceStatusFilter);
  });

  const search = (document.getElementById('services-search-input')?.value || '').toLowerCase();
  const filtered = services.filter((p) => {
    const isOnline = p.app_status === 'running';
    if (state.serviceStatusFilter === 'running' && !isOnline) return false;
    if (state.serviceStatusFilter === 'stopped' && isOnline) return false;
    return p.name.toLowerCase().includes(search) ||
      p.slug.toLowerCase().includes(search) ||
      (p.start_cmd && p.start_cmd.toLowerCase().includes(search)) ||
      (p.project_type && p.project_type.toLowerCase().includes(search));
  });

  if (!filtered.length) {
    container.innerHTML = `
      <div style="grid-column: 1 / -1; text-align: center; padding: 48px; background: var(--bg-card); border-radius: var(--radius-lg); border: 1px dashed var(--border-medium);">
        <div style="font-size: 38px; margin-bottom: 12px;">🤖</div>
        <p style="font-size: 16px; font-weight: 600; margin-bottom: 8px;">No backend services or bots yet</p>
        <p style="color: var(--text-muted); font-size: 13.5px; max-width: 460px; margin: 0 auto 20px auto; line-height: 1.5;">
          Deploy 24/7 Discord bots, Telegram bots, queue workers, and background scripts directly on your server with automatic process supervision.
        </p>
        <button class="btn btn-primary" onclick="openAddServiceModal()">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
          <span>New Service / Bot</span>
        </button>
      </div>
    `;
    return;
  }

  container.innerHTML = filtered.map((p) => {
    const isOnline = p.app_status === 'running';
    const sha = p.deployed_sha ? `<span class="sha-pill">${p.deployed_sha.slice(0, 7)}</span>` : '<span style="color:var(--text-dim)">Not deployed</span>';

    let typeIcon = '🤖';
    let typeName = 'Backend Service';
    const pt = (p.project_type || '').toLowerCase();
    if (pt.includes('discord')) {
      typeIcon = '🤖';
      typeName = 'Discord Bot';
    } else if (pt.includes('telegram')) {
      typeIcon = '✈️';
      typeName = 'Telegram Bot';
    } else if (pt.includes('lavalink') || (p.start_cmd && p.start_cmd.toLowerCase().includes('lavalink'))) {
      typeIcon = '☕';
      typeName = 'Lavalink Audio Server';
    } else if (pt.includes('python') || (p.start_cmd && p.start_cmd.includes('python'))) {
      typeIcon = '🐍';
      typeName = 'Python Daemon';
    } else if (pt.includes('node') || (p.start_cmd && p.start_cmd.includes('node'))) {
      typeIcon = '⚡';
      typeName = 'Node.js Worker';
    } else if (pt.includes('worker')) {
      typeIcon = '⚙️';
      typeName = 'Queue Worker';
    }

    const uptimeText = isOnline && p.app_started_at
      ? `Started ${formatRelativeTime(p.app_started_at)}`
      : (isOnline ? 'Active process' : 'Process inactive');

    const isLocal = !p.repo_url || p.repo_url === 'local' || (p.project_type && p.project_type.includes('lavalink'));
    const defaultTab = isLocal ? 'files' : 'deployments';

        let accessBadge = '<span class="badge badge-neutral" style="font-size: 10px;">🔒 Localhost Only</span>';
        if (p.access_mode === 'allowlist') {
          const ipList = p.allowed_ips ? p.allowed_ips.split(/[,;\n]/).filter(Boolean).length : 0;
          accessBadge = `<span class="badge badge-primary" style="font-size: 10px;">🛡️ Allowlist (${ipList} IP${ipList === 1 ? '' : 's'})</span>`;
        } else if (p.access_mode === 'public') {
          accessBadge = '<span class="badge badge-warning" style="font-size: 10px;">🌐 Public</span>';
        }

        const domainBadge = (p.domains && p.domains.length > 0)
          ? `<span class="badge badge-primary" style="font-size: 10px; font-family: var(--font-mono);">🌐 ${escapeHtml(p.domains[0])}</span>`
          : '';
        const portBadge = p.port ? `<span class="badge badge-neutral" style="font-size: 10px; font-family: var(--font-mono);">Port ${p.port}</span>` : '';

        return `
      <div class="project-card" style="cursor: pointer; transition: transform 0.15s ease, border-color 0.15s ease;" onclick="openWebsiteWorkspace(${p.id}, '${defaultTab}')">
        <div class="project-card-header">
          <div style="display: flex; align-items: center; gap: 10px;">
            <div style="width: 38px; height: 38px; border-radius: 8px; background: rgba(99, 102, 241, 0.15); color: var(--accent-light); display: flex; align-items: center; justify-content: center; font-size: 20px;">
              ${typeIcon}
            </div>
            <div>
              <div class="project-info-title" style="font-size: 15px; font-weight: 600;">
                <span class="status-dot ${isOnline ? 'online' : 'offline'}"></span>
                <span>${escapeHtml(p.name)}</span>
              </div>
              <div style="font-size: 11.5px; color: var(--text-muted); font-family: var(--font-mono); margin-top: 2px;">
                ${escapeHtml(typeName)} &bull; ${isLocal ? '📁 Manual Files' : escapeHtml(p.branch || 'main')}
              </div>
            </div>
          </div>
          <span class="badge ${isOnline ? 'badge-success' : 'badge-neutral'}">${isOnline ? 'ONLINE' : 'STOPPED'}</span>
        </div>

        <div style="background: var(--bg-alt); padding: 8px 10px; border-radius: var(--radius-sm); border: 1px solid var(--border); font-size: 11.5px; font-family: var(--font-mono); margin: 12px 0 8px 0; display: flex; justify-content: space-between; align-items: center; overflow: hidden;">
          <span style="color: var(--text-dim); text-overflow: ellipsis; white-space: nowrap; overflow: hidden; max-width: 75%;">
            $ ${escapeHtml(p.start_cmd || 'node index.js')}
          </span>
          ${p.app_pid ? `<span class="badge badge-neutral" style="font-size: 10px; padding: 2px 6px;">PID ${p.app_pid}</span>` : ''}
        </div>

        <div style="display: flex; flex-wrap: wrap; gap: 5px; margin-bottom: 8px;">
          ${accessBadge}
          ${domainBadge}
          ${portBadge}
        </div>

        <div class="project-meta-row" style="margin-bottom: 12px;">
          <div class="project-meta-item">
            <span>${isLocal ? 'Source: <strong style="color:var(--text-main);">📁 Manual Upload</strong>' : `Commit: <strong>${sha}</strong>`}</span>
          </div>
          <div class="project-meta-item">
            <span style="font-size: 11.5px; color: var(--text-muted);">${uptimeText}</span>
          </div>
        </div>

        <div class="project-card-actions" onclick="event.stopPropagation()" style="display: flex; justify-content: space-between; align-items: center; width: 100%; border-top: 1px solid var(--border); padding-top: 10px; margin-top: 4px;">
          <div style="display: flex; gap: 6px;">
            ${isOnline
              ? `<button class="btn btn-danger btn-sm" onclick="stopProject(${p.id})">Stop</button>`
              : `<button class="btn btn-success btn-sm" onclick="startProject(${p.id})">Start</button>`
            }
            ${!isLocal ? `<button class="btn btn-secondary btn-sm" onclick="deployProject(${p.id})">Deploy</button>` : ''}
            <button class="btn btn-secondary btn-sm" onclick="openWebsiteWorkspace(${p.id}, 'files')" title="Upload and manage service files">Files</button>
            <button class="btn btn-secondary btn-sm" onclick="openWebsiteWorkspace(${p.id}, 'logs')" title="View live logs">Logs</button>
            <button class="btn btn-secondary btn-sm" onclick="openEditServiceModal(${p.id})" title="Service, Network &amp; Domain Settings">⚙️</button>
          </div>
          <button class="btn btn-primary btn-sm" onclick="openWebsiteWorkspace(${p.id}, '${defaultTab}')">
            Manage &rarr;
          </button>
        </div>
      </div>
    `;
  }).join('');
}
window.renderServicesList = renderServicesList;

// Services search & filter bindings
document.getElementById('services-search-input')?.addEventListener('input', renderServicesList);
document.querySelectorAll('#services-status-filters .pill').forEach((btn) => {
  btn.addEventListener('click', () => {
    state.serviceStatusFilter = btn.getAttribute('data-filter') || 'all';
    renderServicesList();
  });
});

// ============================================================================
// Add / Edit Backend Service Modal
// ============================================================================
function setServiceSourceMode(mode) {
  const hiddenInput = document.getElementById('service-source-mode');
  if (hiddenInput) hiddenInput.value = mode;

  const btnManual = document.getElementById('service-source-mode-manual');
  const btnGit = document.getElementById('service-source-mode-git');
  if (btnManual) btnManual.classList.toggle('active', mode === 'manual');
  if (btnGit) btnGit.classList.toggle('active', mode === 'git');

  const repoGroup = document.getElementById('service-repo-group');
  const branchGroup = document.getElementById('service-branch-group');
  const infoBox = document.getElementById('service-manual-info-box');
  const gridRow = document.getElementById('service-name-branch-row');

  if (mode === 'manual') {
    if (repoGroup) repoGroup.style.display = 'none';
    if (branchGroup) branchGroup.style.display = 'none';
    if (infoBox) infoBox.style.display = 'block';
    if (gridRow) gridRow.style.gridTemplateColumns = '1fr';
    const repoInput = document.getElementById('service-repo');
    if (repoInput) repoInput.value = '';
  } else {
    if (repoGroup) repoGroup.style.display = 'block';
    if (branchGroup) branchGroup.style.display = 'block';
    if (infoBox) infoBox.style.display = 'none';
    if (gridRow) gridRow.style.gridTemplateColumns = '2fr 1fr';
  }
}
window.setServiceSourceMode = setServiceSourceMode;

function openAddServiceModal() {
  const form = document.getElementById('service-form');
  if (form) form.reset();
  document.getElementById('service-form-id').value = '';
  document.getElementById('modal-service-title').textContent = 'Add Backend Service / Bot';
  document.getElementById('save-service-submit-btn').textContent = 'Create Service';
  document.getElementById('service-name').value = '';
  document.getElementById('service-slug').value = '';
  document.getElementById('service-deploy-dir').value = '';
  document.getElementById('service-repo').value = '';
  document.getElementById('service-branch').value = 'main';
  document.getElementById('service-branch').dataset.touched = '';
  document.getElementById('service-install-cmd').value = '';
  document.getElementById('service-start-cmd').value = '';

  const portInput = document.getElementById('service-port');
  if (portInput) portInput.value = getNextAvailablePort(1112);
  const domainInput = document.getElementById('service-domain');
  if (domainInput) domainInput.value = '';
  const accessInput = document.getElementById('service-access-mode');
  if (accessInput) accessInput.value = 'local';
  const ipsInput = document.getElementById('service-allowed-ips');
  if (ipsInput) ipsInput.value = '';
  toggleDatabaseAccessIpFields('service-access-mode', 'service-allowed-ips-wrap');

  applyServicePreset('lavalink');
  openModal('modal-service');
}
window.openAddServiceModal = openAddServiceModal;

function applyServicePreset(preset) {
  const hiddenPreset = document.getElementById('service-preset-type');
  if (hiddenPreset) hiddenPreset.value = preset;

  document.querySelectorAll('#service-preset-buttons .preset-chip').forEach((c) => {
    c.classList.toggle('active', c.getAttribute('data-service-preset') === preset);
  });

  const nameInput = document.getElementById('service-name');
  const installInput = document.getElementById('service-install-cmd');
  const startInput = document.getElementById('service-start-cmd');
  const portInput = document.getElementById('service-port');
  const isEditing = Boolean(document.getElementById('service-form-id')?.value);
  const currentPort = portInput ? portInput.value : '';

  switch (preset) {
    case 'lavalink':
      setServiceSourceMode('manual');
      if (nameInput) {
        nameInput.value = 'Lavalink';
        nameInput.dispatchEvent(new Event('input'));
      }
      if (installInput) installInput.value = '';
      if (startInput) startInput.value = 'java -jar Lavalink.jar';
      if (portInput) portInput.value = (isEditing && currentPort) ? currentPort : getNextAvailablePort(1112);
      break;
    case 'discord-node':
      setServiceSourceMode('git');
      if (nameInput) {
        nameInput.value = 'Discord Bot';
        nameInput.dispatchEvent(new Event('input'));
      }
      if (installInput) installInput.value = 'npm ci';
      if (startInput) startInput.value = 'node index.js';
      if (portInput) portInput.value = (isEditing && currentPort) ? currentPort : getNextAvailablePort(8000);
      break;
    case 'discord-py':
      setServiceSourceMode('git');
      if (nameInput) {
        nameInput.value = 'Discord Bot';
        nameInput.dispatchEvent(new Event('input'));
      }
      if (installInput) installInput.value = 'pip install -r requirements.txt --break-system-packages --ignore-installed';
      if (startInput) startInput.value = 'python3 -u bot.py';
      if (portInput) portInput.value = (isEditing && currentPort) ? currentPort : getNextAvailablePort(8000);
      break;
    case 'telegram-py':
      setServiceSourceMode('git');
      if (nameInput) {
        nameInput.value = 'Telegram Bot';
        nameInput.dispatchEvent(new Event('input'));
      }
      if (installInput) installInput.value = 'pip install -r requirements.txt --break-system-packages --ignore-installed';
      if (startInput) startInput.value = 'python3 -u main.py';
      if (portInput) portInput.value = (isEditing && currentPort) ? currentPort : getNextAvailablePort(8000);
      break;
    case 'worker-py':
      setServiceSourceMode('manual');
      if (nameInput) {
        nameInput.value = 'Queue Worker';
        nameInput.dispatchEvent(new Event('input'));
      }
      if (installInput) installInput.value = 'pip install -r requirements.txt --break-system-packages --ignore-installed';
      if (startInput) startInput.value = 'python3 -u worker.py';
      if (portInput) portInput.value = (isEditing && currentPort) ? currentPort : getNextAvailablePort(8000);
      break;
    case 'custom':
      if (nameInput && ['Lavalink', 'Discord Bot', 'Telegram Bot', 'Queue Worker'].includes(nameInput.value)) {
        nameInput.value = '';
        nameInput.dispatchEvent(new Event('input'));
      }
      if (installInput) installInput.value = '';
      if (startInput) startInput.value = '';
      if (portInput) portInput.value = (isEditing && currentPort) ? currentPort : getNextAvailablePort(8000);
      break;
  }
}
window.applyServicePreset = applyServicePreset;

function openEditServiceModal(id) {
  const p = state.projects.find((x) => x.id === id);
  if (!p) return;

  document.getElementById('service-form-id').value = p.id;
  document.getElementById('modal-service-title').textContent = 'Edit Backend Service / Bot';
  document.getElementById('save-service-submit-btn').textContent = 'Update Service';
  document.getElementById('service-name').value = p.name || '';
  document.getElementById('service-slug').value = p.slug || '';
  document.getElementById('service-branch').value = p.branch || 'main';
  document.getElementById('service-repo').value = p.repo_url === 'local' ? '' : (p.repo_url || '');
  document.getElementById('service-deploy-dir').value = p.deploy_dir || '';
  document.getElementById('service-install-cmd').value = p.install_cmd || '';
  document.getElementById('service-start-cmd').value = p.start_cmd || '';

  const isLocal = !p.repo_url || p.repo_url === 'local';
  setServiceSourceMode(isLocal ? 'manual' : 'git');

  const portInput = document.getElementById('service-port');
  if (portInput) portInput.value = p.port || getNextAvailablePort(8000);
  const domainInput = document.getElementById('service-domain');
  if (domainInput) domainInput.value = (p.domains && p.domains[0]) || '';
  const accessInput = document.getElementById('service-access-mode');
  if (accessInput) accessInput.value = p.access_mode || 'local';
  const ipsInput = document.getElementById('service-allowed-ips');
  if (ipsInput) ipsInput.value = p.allowed_ips || '';
  toggleDatabaseAccessIpFields('service-access-mode', 'service-allowed-ips-wrap');

  const pt = p.project_type || 'custom';
  document.querySelectorAll('#service-preset-buttons .preset-chip').forEach((c) => {
    c.classList.toggle('active', c.getAttribute('data-service-preset') === pt);
  });

  openModal('modal-service');
}
window.openEditServiceModal = openEditServiceModal;

// Service Preset Chips Click
document.querySelectorAll('#service-preset-buttons .preset-chip').forEach((chip) => {
  chip.addEventListener('click', () => {
    const preset = chip.getAttribute('data-service-preset');
    if (preset) applyServicePreset(preset);
  });
});

// Auto-derive service slug
document.getElementById('service-name')?.addEventListener('input', (e) => {
  if (!document.getElementById('service-form-id').value) {
    const slug = e.target.value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
    document.getElementById('service-slug').value = slug;
    document.getElementById('service-deploy-dir').value = slug ? `./data/services/${slug}` : '';
  }
});

// Browse GitHub repos for service
document.getElementById('service-browse-github-repos-btn')?.addEventListener('click', async () => {
  const sel = document.getElementById('service-github-repos-select');
  const input = document.getElementById('service-repo');
  try {
    toast('Fetching visible GitHub repositories...', 'info');
    const repos = await api('/api/github/repos');
    if (!repos.length) {
      toast('No repositories found for configured token.', 'info');
      return;
    }
    sel.innerHTML = '<option value="">-- Choose a repository --</option>' +
      repos.map((r) => {
        const prefix = r.token_label ? `[${escapeHtml(r.token_label)}] ` : '';
        return `<option value="${escapeHtml(r.clone_url)}">${prefix}${escapeHtml(r.full_name)} (${r.private ? 'Private' : 'Public'})</option>`;
      }).join('');
    sel.style.display = 'block';
    sel.onchange = () => {
      if (sel.value) {
        input.value = sel.value;
        const selected = repos.find((r) => r.clone_url === sel.value);
        if (selected) {
          if (document.getElementById('service-branch').dataset.touched !== '1') document.getElementById('service-branch').value = selected.default_branch || 'main';
          if (!document.getElementById('service-name').value) {
            const shortName = selected.full_name.split('/')[1] || selected.full_name;
            document.getElementById('service-name').value = shortName;
            document.getElementById('service-name').dispatchEvent(new Event('input'));
          }
        }
      }
    };
  } catch (err) {
    toast(`Could not load repos: ${err.message}. Configure your GitHub token in Settings.`, 'warning');
  }
});

// Remember when the user typed a branch so GitHub repo selection never overwrites it
['service-branch', 'website-branch'].forEach((bid) => {
  document.getElementById(bid)?.addEventListener('input', (ev) => { ev.target.dataset.touched = '1'; });
});

// Submit Add / Edit Service Form
document.getElementById('save-service-submit-btn')?.addEventListener('click', async (e) => {
  e.preventDefault();
  const form = document.getElementById('service-form');
  if (!form.reportValidity()) return;

  const submitBtn = document.getElementById('save-service-submit-btn');
  const originalText = submitBtn.textContent;
  submitBtn.disabled = true;
  submitBtn.innerHTML = '<span class="status-dot online" style="display:inline-block; margin-right:6px; animation: pulse 1s infinite;"></span> Saving...';

  const id = document.getElementById('service-form-id').value;
  const name = document.getElementById('service-name').value.trim();
  const startCmd = document.getElementById('service-start-cmd').value.trim();
  let slug = document.getElementById('service-slug').value.trim();
  if (!slug) {
    slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
  }

  let projectType = 'custom';
  const scLower = startCmd.toLowerCase();
  if (scLower.includes('lavalink') || scLower.includes('.jar')) {
    projectType = 'lavalink';
  } else if (scLower.includes('python') || scLower.includes('.py')) {
    projectType = 'python';
  } else if (scLower.includes('node') || scLower.includes('.js')) {
    projectType = 'node';
  }

  const sourceMode = document.getElementById('service-source-mode')?.value || 'manual';
  const repoVal = document.getElementById('service-repo')?.value.trim() || '';
  const isManual = sourceMode === 'manual' || !repoVal;

  const portVal = document.getElementById('service-port')?.value.trim();
  const domainVal = document.getElementById('service-domain')?.value.trim();
  const accessMode = document.getElementById('service-access-mode')?.value || 'local';
  const allowedIps = document.getElementById('service-allowed-ips')?.value.trim() || '';

  const payload = {
    name,
    slug,
    repo_url: isManual ? 'local' : repoVal,
    branch: isManual ? 'local' : (document.getElementById('service-branch').value.trim() || 'main'),
    project_kind: 'service',
    project_type: projectType,
    deploy_method: 'managed',
    deploy_dir: document.getElementById('service-deploy-dir').value.trim() || `./data/services/${slug}`,
    install_cmd: document.getElementById('service-install-cmd').value.trim(),
    build_cmd: '',
    start_cmd: document.getElementById('service-start-cmd').value.trim(),
    health_url: '',
    port: portVal ? Number(portVal) : null,
    domains: domainVal ? [domainVal] : [],
    access_mode: accessMode,
    allowed_ips: allowedIps,
    auto_deploy: false,
  };

  try {
    let targetId = id;
    if (id) {
      await api(`/api/projects/${id}`, { method: 'PUT', body: payload });
      toast('Service updated!', 'success');
    } else {
      const res = await api('/api/projects', { method: 'POST', body: payload });
      targetId = res.project ? res.project.id : res.id;
      toast(`Service "${payload.name}" created!`, 'success');
      state.selectedProjectId = targetId;
    }
    closeModal('modal-service');
    await loadProjects();
    if (isManual) {
      toast(`Service "${payload.name}" ready! Upload your files in the Files tab.`, 'info');
      openWebsiteWorkspace(targetId, 'files');
    } else {
      navigateTo('services');
    }
  } catch (err) {
    toast(`Save failed: ${err.message}`, 'error');
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = originalText;
  }
});

// ============================================================================
// Backend Service File Browser
// ============================================================================
state.filesPath = '';
state.filesOpenPath = null;
state.filesProjectId = null;

function filesJoin(dir, name) {
  return dir ? `${dir}/${name}` : name;
}

async function loadFilesView() {
  const p = getSelectedProject();
  if (!p) return;
  if (state.filesProjectId !== p.id) {
    state.filesProjectId = p.id;
    state.filesPath = '';
    filesCloseEditor();
  }
  const listEl = document.getElementById('files-list');
  const crumbEl = document.getElementById('files-breadcrumb');
  if (!listEl) return;

  const parts = state.filesPath ? state.filesPath.split('/') : [];
  let acc = '';
  crumbEl.innerHTML = `<a href="javascript:void(0)" onclick="filesGo('')">app</a>` + parts.map((seg) => {
    acc = filesJoin(acc, seg);
    return ` / <a href="javascript:void(0)" onclick="filesGo('${escapeHtml(acc).replace(/'/g, '&#39;')}')">${escapeHtml(seg)}</a>`;
  }).join('');

  try {
    const res = await api(`/api/projects/${p.id}/files?path=${encodeURIComponent(state.filesPath)}`, { noCache: true });
    const rows = [];
    if (state.filesPath) {
      const up = parts.slice(0, -1).join('/');
      rows.push(`<div class="files-row" style="padding:9px 14px; cursor:pointer; border-bottom:1px solid var(--border);" onclick="filesGo('${escapeHtml(up)}')">📁 ..</div>`);
    }
    if (!res.entries.length && !state.filesPath) {
      rows.push(`<div style="padding:24px; text-align:center; color:var(--text-muted); font-size:13px;">Folder is empty. Deploy from GitHub or create files here.</div>`);
    }
    res.entries.forEach((e) => {
      const full = filesJoin(state.filesPath, e.name);
      const safe = escapeHtml(full).replace(/'/g, '&#39;');
      const size = e.is_dir ? '' : (e.size < 1024 ? `${e.size} B` : `${(e.size / 1024).toFixed(1)} KB`);
      rows.push(`
        <div class="files-row" style="display:flex; align-items:center; justify-content:space-between; padding:9px 14px; border-bottom:1px solid var(--border);">
          <span style="cursor:pointer; flex:1; font-family:var(--font-mono); font-size:13px;" onclick="${e.is_dir ? `filesGo('${safe}')` : `filesOpen('${safe}')`}">${e.is_dir ? '📁' : '📄'} ${escapeHtml(e.name)}</span>
          <span style="color:var(--text-dim); font-size:11.5px; margin-right:14px;">${size}</span>
          <button class="btn btn-danger btn-sm" onclick="filesDelete('${safe}')">Delete</button>
        </div>`);
    });
    listEl.innerHTML = rows.join('');
  } catch (err) {
    listEl.innerHTML = `<div style="padding:20px; color:var(--text-muted);">${escapeHtml(err.message)}</div>`;
  }
}
window.loadFilesView = loadFilesView;

function filesGo(path) {
  state.filesPath = path;
  void loadFilesView();
}
window.filesGo = filesGo;

async function filesOpen(path) {
  const p = getSelectedProject();
  if (!p) return;
  try {
    const res = await api(`/api/projects/${p.id}/files/content?path=${encodeURIComponent(path)}`, { noCache: true });
    state.filesOpenPath = path;
    document.getElementById('files-editor-name').textContent = path;
    document.getElementById('files-editor').value = res.content;
    document.getElementById('files-editor-card').style.display = 'block';
    document.getElementById('files-editor-card').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch (err) {
    toast(err.message, 'error');
  }
}
window.filesOpen = filesOpen;

function filesCloseEditor() {
  state.filesOpenPath = null;
  const card = document.getElementById('files-editor-card');
  if (card) card.style.display = 'none';
}
window.filesCloseEditor = filesCloseEditor;

async function filesSaveCurrent() {
  const p = getSelectedProject();
  if (!p || !state.filesOpenPath) return;
  const btn = document.getElementById('files-save-btn');
  btn.disabled = true;
  try {
    await api(`/api/projects/${p.id}/files/content`, {
      method: 'PUT',
      body: { path: state.filesOpenPath, content: document.getElementById('files-editor').value },
    });
    toast(`Saved ${state.filesOpenPath}. Restart the service to apply changes.`, 'success');
  } catch (err) {
    toast(`Save failed: ${err.message}`, 'error');
  } finally {
    btn.disabled = false;
  }
}
window.filesSaveCurrent = filesSaveCurrent;

async function filesNewFile() {
  const p = getSelectedProject();
  if (!p) return;
  const input = await showPromptDialog({
    title: 'New File',
    message: 'Create a file in the current folder.',
    placeholder: 'e.g. .env or config.json',
    confirmText: 'Create File',
  });
  const name = (input || '').trim();
  if (!name) return;
  const path = filesJoin(state.filesPath, name);
  try {
    await api(`/api/projects/${p.id}/files/content`, { method: 'PUT', body: { path, content: '' } });
    await loadFilesView();
    await filesOpen(path);
  } catch (err) {
    toast(err.message, 'error');
  }
}
window.filesNewFile = filesNewFile;

async function filesNewFolder() {
  const p = getSelectedProject();
  if (!p) return;
  const input = await showPromptDialog({
    title: 'New Folder',
    message: 'Create a folder in the current location.',
    placeholder: 'e.g. src',
    confirmText: 'Create Folder',
  });
  const name = (input || '').trim();
  if (!name) return;
  try {
    await api(`/api/projects/${p.id}/files/mkdir`, { method: 'POST', body: { path: filesJoin(state.filesPath, name) } });
    await loadFilesView();
  } catch (err) {
    toast(err.message, 'error');
  }
}
window.filesNewFolder = filesNewFolder;

async function filesDelete(path) {
  const p = getSelectedProject();
  if (!p) return;
  const ok = await showConfirmDialog({
    title: 'Delete File or Folder',
    message: `Delete "${path}"? This cannot be undone.`,
    confirmText: 'Delete',
    danger: true,
  });
  if (!ok) return;
  try {
    await api(`/api/projects/${p.id}/files?path=${encodeURIComponent(path)}`, { method: 'DELETE' });
    if (state.filesOpenPath === path) filesCloseEditor();
    await loadFilesView();
  } catch (err) {
    toast(err.message, 'error');
  }
}
window.filesDelete = filesDelete;

async function handleFilesUpload(e) {
  const p = getSelectedProject();
  if (!p) return;
  const files = e.target?.files;
  if (!files || !files.length) return;

  const formData = new FormData();
  for (let i = 0; i < files.length; i++) {
    formData.append('file', files[i]);
  }

  try {
    toast(`Uploading ${files.length} file(s)...`, 'info');
    const pathParam = encodeURIComponent(state.filesPath || '');
    const res = await fetch(`/api/projects/${p.id}/files/upload?path=${pathParam}`, {
      method: 'POST',
      headers: {
        'x-csrf-token': state.csrf || '',
      },
      body: formData,
    });
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(errText || 'Upload failed');
    }
    toast(`Uploaded ${files.length} file(s) successfully!`, 'success');
    await loadFilesView();
  } catch (err) {
    toast(`Upload failed: ${err.message}`, 'error');
  } finally {
    if (e.target) e.target.value = '';
  }
}
window.handleFilesUpload = handleFilesUpload;

// ============================================================================
// Add Website Workflow Modal
// ============================================================================
function openAddWebsiteModal() {
  const form = document.getElementById('website-form');
  form.reset();
  document.getElementById('website-branch').dataset.touched = '';
  document.getElementById('website-form-id').value = '';
  document.getElementById('modal-website-title').textContent = 'Add New Website';
  document.getElementById('save-website-submit-btn').textContent = 'Create Website';
  document.getElementById('website-slug').readOnly = false;
  const detectBtn = document.getElementById('website-detect-btn');
  if (detectBtn) detectBtn.style.display = 'none';

  const accessInput = document.getElementById('website-access-mode');
  if (accessInput) accessInput.value = 'local';
  const ipsInput = document.getElementById('website-allowed-ips');
  if (ipsInput) ipsInput.value = '';
  toggleDatabaseAccessIpFields('website-access-mode', 'website-allowed-ips-wrap');

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
  const accessInput = document.getElementById('website-access-mode');
  if (accessInput) accessInput.value = p.access_mode || 'local';
  const ipsInput = document.getElementById('website-allowed-ips');
  if (ipsInput) ipsInput.value = p.allowed_ips || '';
  toggleDatabaseAccessIpFields('website-access-mode', 'website-allowed-ips-wrap');

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
  const used = new Set();
  // Reserve system & platform daemon ports
  [22, 80, 443, 4600].forEach((p) => used.add(p));

  // Collect ports from all websites & backend services
  (state.projects || []).forEach((p) => {
    if (p.port) used.add(Number(p.port));
  });

  // Collect ports from all databases
  (state.databases || []).forEach((d) => {
    if (d.port) used.add(Number(d.port));
  });

  let port = Math.max(1024, Number(basePort) || 3000);
  while (used.has(port) && port < 65535) {
    port++;
  }
  return port;
}
window.getNextAvailablePort = getNextAvailablePort;

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
      repos.map((r) => {
        const prefix = r.token_label ? `[${escapeHtml(r.token_label)}] ` : '';
        return `<option value="${escapeHtml(r.clone_url)}">${prefix}${escapeHtml(r.full_name)} (${r.private ? 'Private' : 'Public'})</option>`;
      }).join('');
    sel.style.display = 'block';
    sel.onchange = () => {
      if (sel.value) {
        input.value = sel.value;
        const selected = repos.find((r) => r.clone_url === sel.value);
        if (selected) {
          if (document.getElementById('website-branch').dataset.touched !== '1') document.getElementById('website-branch').value = selected.default_branch || 'main';
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
  const accessMode = document.getElementById('website-access-mode')?.value || 'local';
  const allowedIps = document.getElementById('website-allowed-ips')?.value.trim() || '';

  const payload = {
    name: document.getElementById('website-name').value.trim(),
    slug: document.getElementById('website-slug').value.trim(),
    repo_url: document.getElementById('website-repo').value.trim(),
    branch: document.getElementById('website-branch').value.trim() || 'main',
    domains,
    port: document.getElementById('website-port').value ? Number(document.getElementById('website-port').value) : null,
    access_mode: accessMode,
    allowed_ips: allowedIps,
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
  const delProj = (state.projects || []).find((x) => x.id === id);
  const delIsService = !!delProj && delProj.project_kind === 'service';
  const delNoun = delIsService ? 'service' : 'website';
  const delNounCap = delIsService ? 'Service' : 'Website';
  const confirmSlug = await showPromptDialog({
    title: `Delete ${delNounCap}`,
    message: `CAUTION: Deleting this ${delNoun} will remove its configuration and stop its running process.\n\nType the ${delNoun} slug "${slug}" below to confirm deletion:`,
    placeholder: slug,
    confirmText: `Delete ${delNounCap}`,
    danger: true,
  });
  if (confirmSlug === null) return;
  if (confirmSlug.trim() !== slug) {
    toast('Slug confirmation did not match. Deletion cancelled.', 'warning');
    return;
  }

  try {
    await api(`/api/projects/${id}`, { method: 'DELETE', body: { confirm: slug } });
    toast(`${delNounCap} "${slug}" deleted.`, 'success');
    if (state.selectedProjectId === id) state.selectedProjectId = null;
    await loadProjects();
    navigateTo(delIsService ? 'services' : 'projects');
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

  const branchBadge = document.getElementById('github-branch-badge');
  if (branchBadge) branchBadge.textContent = p.branch;

  // Load Commits
  const tbody = document.getElementById('github-commits-table');
  const commitsPath = `/api/projects/${p.id}/commits`;
  if (!hasCachedApi(commitsPath)) {
    tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; padding: 24px;">Loading commits from mirror...</td></tr>';
  }
  try {
    const commits = await api(commitsPath, { noCache: true });
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

// Fetch Updates button
document.getElementById('github-fetch-btn')?.addEventListener('click', async () => {
  const p = getSelectedProject();
  if (!p) return;
  await fetchProjectUpdates(p.id);
});

async function fetchProjectUpdates(projectId) {
  const fetchBtn = document.getElementById('github-fetch-btn');
  if (fetchBtn) {
    fetchBtn.disabled = true;
    fetchBtn.classList.add('loading');
  }
  toast('Fetching latest commits from GitHub...', 'info');
  try {
    const res = await api(`/api/projects/${projectId}/fetch`, { method: 'POST', timeoutMs: 30000 });
    const shortSha = res.sha ? res.sha.slice(0, 7) : 'latest';
    if (res.hasNewCommits) {
      toast(`Fetched new commits (${shortSha}) from GitHub! Ready to deploy.`, 'success');
    } else if (res.needsDeploy) {
      toast(`Already up to date with GitHub (${shortSha}). Ready to deploy!`, 'success');
    } else {
      toast(`Already up to date with GitHub (${shortSha}). Live deployment matches.`, 'success');
    }
    await loadProjects();
    if (state.currentView === 'projects') renderProjectsList();
    if (state.currentView === 'github') await loadGithubView();
    if (state.currentView === 'overview') await loadOverview();
  } catch (err) {
    toast(`Fetch failed: ${err.message}`, 'error');
  } finally {
    if (fetchBtn) {
      fetchBtn.disabled = false;
      fetchBtn.classList.remove('loading');
    }
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
      tbody.innerHTML = '<tr><td colspan="7" style="text-align: center; padding: 24px;">No deployments found.</td></tr>';
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
      setHtmlIfChanged(tbody, slice.map((d) => renderDeploymentRow(d, false)).join(''));
    });
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="7" style="text-align: center; color: var(--danger); padding: 24px;">${escapeHtml(err.message)}</td></tr>`;
  }
}
window.loadDeploymentsView = loadDeploymentsView;

// ============================================================================
// Organic Fluid Water Pipeline Engine
// ============================================================================
const waterPipelines = {};

function initWaterPipelineDOM(container, containerId, stages = PIPELINE_STAGES) {
  const isCompact = container.classList.contains('card-pipeline-track') || containerId.startsWith('db-pipeline-track') || container.closest('.card') !== null;
  const wrapperClass = isCompact ? 'water-pipeline-wrapper compact' : 'water-pipeline-wrapper';
  container.innerHTML = `
    <div class="${wrapperClass}" id="water-wrapper-${containerId}">
      ${stages.map((s, idx) => `
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
          ${idx < stages.length - 1 ? `
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

  const stages = pipeline.stages || PIPELINE_STAGES;
  const maxP = stages.length;
  const P = pipeline.currentProgress;
  const isFailed = pipeline.status === 'failed';
  const isSuccess = pipeline.status === 'success';
  const activeIdx = pipeline.activeStageIdx ?? -1;
  const failedIdx = isFailed ? pipeline.failedStageIdx : -1;
  const isDraining = (pipeline.targetProgress < pipeline.currentProgress) || (pipeline.status === 'idle' && P > 0);
  const drainStageIdx = isDraining ? Math.min(stages.length - 1, Math.max(0, Math.floor(P))) : -1;

  stages.forEach((s, idx) => {
    const unit = container.querySelector(`.water-stage-unit[data-unit-idx="${idx}"]`);
    if (!unit) return;

    const vial = unit.querySelector('.water-node-vial');
    const liquid = unit.querySelector('.water-vial-liquid');
    const num = unit.querySelector('.water-vial-num');
    const check = unit.querySelector('.water-vial-check');
    const cross = unit.querySelector('.water-vial-cross');
    const name = unit.querySelector('.water-node-name');
    const sub = unit.querySelector('.water-node-sub');
    const pipeLiquid = unit.querySelector('.water-pipe-liquid');
    const meniscus = unit.querySelector('.water-pipe-meniscus');

    let vialHeight = 0;

    // ========================================================================
    // A. EMPTYING / DRAINING (Exact mirror opposite of filling progression)
    // ========================================================================
    if (isDraining) {
      if (idx > drainStageIdx) {
        // Stage already completely drained: 0% liquid, queued/idle
        vialHeight = 0;
        if (vial) vial.className = 'water-node-vial queued';
        if (num) num.style.display = 'block';
        if (check) check.style.display = 'none';
        if (cross) cross.style.display = 'none';
        if (sub) {
          sub.textContent = pipeline.status === 'idle' ? 'Idle' : 'Queued';
          sub.className = 'water-node-sub queued';
        }
        if (name) name.className = 'water-node-name queued';
        if (pipeLiquid) {
          pipeLiquid.style.width = '0%';
          pipeLiquid.className = 'water-pipe-liquid empty';
          if (meniscus) meniscus.style.opacity = '0';
        }
      } else if (idx < drainStageIdx) {
        // Stage has not drained yet: remains 100% full, holding liquid with checkmark!
        vialHeight = 100;
        if (vial) vial.className = 'water-node-vial completed';
        if (num) num.style.display = 'none';
        if (check) check.style.display = 'block';
        if (cross) cross.style.display = 'none';
        if (sub) {
          sub.textContent = 'Done';
          sub.className = 'water-node-sub completed';
        }
        if (name) name.className = 'water-node-name completed';
        if (pipeLiquid) {
          pipeLiquid.style.width = '100%';
          pipeLiquid.className = 'water-pipe-liquid filled';
          if (meniscus) meniscus.style.opacity = '0';
        }
      } else {
        // Actively draining stage: idx === drainStageIdx
        const fraction = Math.max(0, Math.min(1.0, P - idx));

        if (idx < stages.length - 1) {
          // Has an outgoing pipe to the next stage
          if (fraction >= 0.6) {
            // Step 1 of draining: Outgoing pipe empties backward from 100% to 0%
            const pipeFrac = (fraction - 0.6) / 0.4;
            const pipeWidth = Math.min(100, Math.max(0, pipeFrac * 100));
            if (pipeLiquid) {
              pipeLiquid.style.width = `${pipeWidth.toFixed(1)}%`;
              pipeLiquid.className = 'water-pipe-liquid draining';
              if (meniscus) meniscus.style.opacity = '0';
            }
            // Vial remains 100% full while pipe liquid recedes
            vialHeight = 100;
            if (vial) vial.className = 'water-node-vial active';
            if (num) num.style.display = 'block';
            if (check) check.style.display = 'none';
            if (cross) cross.style.display = 'none';
            if (sub) {
              sub.textContent = 'Emptying...';
              sub.className = 'water-node-sub draining active';
            }
            if (name) name.className = 'water-node-name active';
          } else {
            // Step 2 of draining: Pipe has emptied (0%), now vial liquid level drops 100% -> 0%
            if (pipeLiquid) {
              pipeLiquid.style.width = '0%';
              pipeLiquid.className = 'water-pipe-liquid empty';
              if (meniscus) meniscus.style.opacity = '0';
            }
            vialHeight = Math.min(100, Math.max(0, (fraction / 0.6) * 100));
            if (vial) vial.className = 'water-node-vial draining';
            if (num) num.style.display = 'block';
            if (check) check.style.display = 'none';
            if (cross) cross.style.display = 'none';
            if (sub) {
              sub.textContent = 'Emptying...';
              sub.className = 'water-node-sub draining';
            }
            if (name) name.className = 'water-node-name active';
          }
        } else {
          // Last stage (no outgoing pipe): Vial liquid level drops smoothly 100% -> 0%
          vialHeight = Math.min(100, Math.max(0, (fraction / 0.8) * 100));
          if (vial) vial.className = 'water-node-vial draining';
          if (num) num.style.display = 'block';
          if (check) check.style.display = 'none';
          if (cross) cross.style.display = 'none';
          if (sub) {
            sub.textContent = 'Emptying...';
            sub.className = 'water-node-sub draining';
          }
          if (name) name.className = 'water-node-name active';
        }
      }
    }
    // ========================================================================
    // B. FORWARD FILLING (Poured left-to-right)
    // ========================================================================
    else {
      // Stage fill level: fills between P = idx and P = idx + 0.6
      if (P >= idx + 0.6) {
        vialHeight = 100;
      } else if (P > idx) {
        vialHeight = Math.min(100, Math.max(0, ((P - idx) / 0.6) * 100));
      }

      // 1. Failed Stage
      if (isFailed && idx === failedIdx && P >= idx + 0.5) {
        if (vial) vial.className = 'water-node-vial failed';
        if (num) num.style.display = 'none';
        if (check) check.style.display = 'none';
        if (cross) cross.style.display = 'block';
        if (sub) { sub.textContent = 'Failed'; sub.className = 'water-node-sub failed'; }
        if (name) name.className = 'water-node-name failed';
      }
      // 2. Completed Stage
      else if ((idx < activeIdx && P >= idx + 0.6) || (isSuccess && P >= idx + 0.6)) {
        if (vial) vial.className = 'water-node-vial completed';
        if (num) num.style.display = 'none';
        if (check) check.style.display = 'block';
        if (cross) cross.style.display = 'none';
        if (sub) { sub.textContent = 'Done'; sub.className = 'water-node-sub completed'; }
        if (name) name.className = 'water-node-name completed';
      }
      // 3. Active Stage: currently filling
      else if (P > idx) {
        if (vial) vial.className = 'water-node-vial active';
        if (num) num.style.display = 'block';
        if (check) check.style.display = 'none';
        if (cross) cross.style.display = 'none';
        if (sub) {
          sub.textContent = vialHeight >= 99 ? `${s.label}...` : 'Filling...';
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
      // Fills between P = idx + 0.6 and P = idx + 1.0
      if (idx < stages.length - 1 && pipeLiquid) {
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

    if (liquid) liquid.style.height = `${vialHeight.toFixed(1)}%`;
  });

  // When all stages are filled and operation succeeded, mark pipeline status deployed!
  if (isSuccess && P >= maxP - 0.05) {
    if (pipeline.containerId === 'main-pipeline-track' || pipeline.containerId === 'overview-pipeline-track') {
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
  } else if (isDraining && P > 0.1) {
    if (pipeline.containerId === 'main-pipeline-track' || pipeline.containerId === 'overview-pipeline-track') {
      const badge = document.getElementById('pipeline-status-badge');
      if (badge && !badge.textContent.includes('STOPPING')) {
        badge.textContent = 'STOPPING...';
        badge.className = 'badge badge-warning';
      }
    }
  } else if (pipeline.status === 'idle' && P <= 0.05) {
    if (pipeline.containerId === 'main-pipeline-track' || pipeline.containerId === 'overview-pipeline-track') {
      const badge = document.getElementById('pipeline-status-badge');
      if (badge && badge.textContent !== 'IDLE') {
        badge.textContent = 'IDLE';
        badge.className = 'badge badge-neutral';
      }
    }
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

    // Organic, steady water pouring/draining pace (~2.3s per stage at 60fps)
    const speed = 0.007;

    if (Math.abs(diff) > 0.0005) {
      if (diff > 0) {
        pipeline.currentProgress = Math.min(pipeline.targetProgress, pipeline.currentProgress + speed);
      } else {
        // Draining uses the same steady, organic pace as filling (exact mirror opposite)
        pipeline.currentProgress = Math.max(pipeline.targetProgress, pipeline.currentProgress - speed);
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

function renderPipelineStages(containerId, currentStage, currentStatus, depId = null, stages = PIPELINE_STAGES) {
  const container = document.getElementById(containerId);
  if (!container) return;

  const maxP = stages.length;

  // Initialize persistent DOM structure once (never destroy innerHTML on polling ticks!)
  const createPipelineObj = () => ({
    containerId,
    stages,
    currentProgress: (currentStatus === 'success' ? maxP : 0.0),
    targetProgress: (currentStatus === 'success' ? maxP : 0.0),
    status: currentStatus,
    activeStageIdx: -1,
    failedStageIdx: -1,
    lastDeploymentId: depId,
    isLooping: false,
  });

  const existingWrapper = container.querySelector('.water-pipeline-wrapper');
  if (!existingWrapper || waterPipelines[containerId]?.stages !== stages) {
    initWaterPipelineDOM(container, containerId, stages);
    waterPipelines[containerId] = createPipelineObj();
  }

  let pipeline = waterPipelines[containerId];
  if (!pipeline) {
    pipeline = createPipelineObj();
    waterPipelines[containerId] = pipeline;
  }
  pipeline.stages = stages;

  // If a new deployment started with different depId, reset water to start
  if (depId && pipeline.lastDeploymentId && pipeline.lastDeploymentId !== depId && (currentStatus === 'running' || currentStatus === 'pending')) {
    pipeline.currentProgress = 0.0;
    pipeline.lastDeploymentId = depId;
  } else if (depId && !pipeline.lastDeploymentId) {
    pipeline.lastDeploymentId = depId;
  }

  pipeline.status = currentStatus;
  const currentIndex = stages.findIndex((s) => s.id === currentStage);

  if (currentStatus === 'idle') {
    pipeline.targetProgress = 0.0;
    pipeline.activeStageIdx = -1;
    pipeline.failedStageIdx = -1;
  } else if (currentStatus === 'failed') {
    pipeline.failedStageIdx = currentIndex >= 0 ? currentIndex : 0;
    pipeline.activeStageIdx = pipeline.failedStageIdx;
    pipeline.targetProgress = pipeline.failedStageIdx + 0.6;
  } else if (currentStatus === 'success') {
    pipeline.activeStageIdx = stages.length - 1;
    pipeline.failedStageIdx = -1;
    pipeline.targetProgress = maxP;
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

window.simulateWaterDrain = function() {
  const track = document.getElementById('main-pipeline-track') ? 'main-pipeline-track' : 'overview-pipeline-track';
  const badge = document.getElementById('pipeline-status-badge');
  if (badge) {
    badge.textContent = 'STOPPING...';
    badge.className = 'badge badge-warning';
  }
  const p = waterPipelines[track];
  if (p) {
    p.targetProgress = 0.0;
    p.status = 'idle';
    p.activeStageIdx = -1;
    p.failedStageIdx = -1;
    startWaterLoop(p);
  }
};

function renderDeploymentRow(d, isOverview = false) {
  let badgeClass = 'badge-neutral';
  if (d.status === 'success') badgeClass = 'badge-success';
  else if (d.status === 'failed') badgeClass = 'badge-danger';
  else if (d.status === 'running' || d.status === 'pending') badgeClass = 'badge-warning';

  const sha = d.sha ? `<span class="sha-pill">${d.sha.slice(0, 7)}</span>` : '<span style="color:var(--text-dim)">--</span>';
  const duration = d.finished_at && d.started_at ? `${Math.round((d.finished_at - d.started_at) / 1000)}s` : (d.status === 'running' ? 'Running...' : '--');
  const secondCol = isOverview
    ? `<td><strong>${escapeHtml(d.project_name || 'Website')}</strong></td>`
    : `<td><span class="badge badge-neutral">${escapeHtml((d.kind || 'deploy').toUpperCase())}</span></td>`;

  return `
    <tr>
      <td><strong>#${d.id}</strong></td>
      ${secondCol}
      <td>${sha}</td>
      <td>${duration}</td>
      <td><span class="badge ${badgeClass}">${escapeHtml((d.status || '').toUpperCase())}</span></td>
      <td><span style="font-size:12px; color:var(--text-muted);">${formatRelativeTime(d.started_at)}</span></td>
      <td>
        <button class="btn btn-secondary btn-sm" onclick="openDeploymentDetails(${d.id})">Logs</button>
      </td>
    </tr>
  `;
}

// Deploy button trigger
async function deployProject(projectId, sha = null) {
  const p = state.projects.find((x) => x.id === projectId) || getSelectedProject();
  if (!p) return;

  const btns = document.querySelectorAll(`button[onclick*="deployProject(${p.id})"]`);
  btns.forEach((b) => {
    b.disabled = true;
    b.innerHTML = '<span class="btn-spinner"></span> Deploying...';
  });

  try {
    resetWaterPipeline('main-pipeline-track');
    resetWaterPipeline('overview-pipeline-track');
    const res = await api(`/api/projects/${p.id}/deploy`, { method: 'POST', body: sha ? { sha } : {} });
    toast(`Deployment #${res.deploymentId} started for ${p.name}!`, 'success');
    navigateTo('deployments', p.id);
  } catch (err) {
    toast(`Deployment failed to start: ${err.message}`, 'error');
    btns.forEach((b) => {
      b.disabled = false;
      b.innerHTML = 'Deploy';
    });
  }
}
window.deployProject = deployProject;

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
      <div class="modal-grid-3" style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; font-size: 13px; margin-bottom: 12px; background: var(--bg-card); padding: 12px; border-radius: var(--radius-md);">
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
      setHtmlIfChanged(tbody, slice.map((r) => {
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
      }).join(''));
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
      setHtmlIfChanged(tbody, slice.map((r) => `
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
      `).join(''));
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
    await loadReleasesView();
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

function ansiToHtml(str) {
  if (!str) return '';
  const escaped = escapeHtml(str);
  const ansiRegex = /(?:\x1b|\u001b)\[([0-9;]*)m/g;
  const colors = {
    '30': 'var(--text-dim)',
    '31': '#ef4444',
    '32': '#10b981',
    '33': '#f59e0b',
    '34': '#3b82f6',
    '35': '#ec4899',
    '36': '#06b6d4',
    '37': '#f3f4f6',
    '90': '#6b7280',
    '91': '#f87171',
    '92': '#34d399',
    '93': '#fbbf24',
    '94': '#60a5fa',
    '95': '#f472b6',
    '96': '#22d3ee',
    '97': '#ffffff',
  };

  let openSpan = false;
  let converted = escaped.replace(ansiRegex, (_, code) => {
    if (!code || code === '0') {
      if (openSpan) {
        openSpan = false;
        return '</span>';
      }
      return '';
    }
    const color = colors[code];
    if (color) {
      const prefix = openSpan ? '</span>' : '';
      openSpan = true;
      return `${prefix}<span style="color:${color}">`;
    }
    if (code === '1') {
      const prefix = openSpan ? '</span>' : '';
      openSpan = true;
      return `${prefix}<span style="font-weight:600">`;
    }
    return '';
  });

  return openSpan ? converted + '</span>' : converted;
}

function formatLogLine(l) {
  const time = l.ts ? new Date(l.ts).toLocaleTimeString() : '--:--:--';
  const lvlClass = `log-lvl-${l.level || 'info'}`;
  return `<div class="log-line"><span class="log-ts">${time}</span><span class="log-chan">[${l.channel}]</span><span class="${lvlClass}">${ansiToHtml(l.message)}</span></div>`;
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
  await copyTextToClipboard(text, 'Logs copied to clipboard');
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
// View 8: Environment Variables (Single Inline Edit, Multi-Row Edit & Raw .env)
// ============================================================================
const envUiState = {
  vars: [],
  viewMode: 'list', // 'list' | 'multi' | 'raw'
  editingKey: null,
  editDraft: { key: '', value: '', is_secret: true },
  revealedKeys: new Set(),
  revealAll: false,
  selectedKeys: new Set(),
  quickAddSecret: true,
  multiRows: [],
};

function getRealEnvValue(v) {
  if (!v) return '';
  if (typeof v.real_value === 'string' && v.real_value.length > 0) return v.real_value;
  if (v.value && v.value !== '********') return v.value;
  return v.real_value ?? '';
}

function formatEnvVarsToRaw(vars) {
  return (vars || []).map((v) => {
    const k = v.key || '';
    const val = getRealEnvValue(v);
    if (val.includes(' ') || val.includes('\n') || val.includes('"') || val.includes('#')) {
      return `${k}="${val.replace(/"/g, '\\"')}"`;
    }
    return `${k}=${val}`;
  }).join('\n');
}

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
    const vars = await api(`/api/projects/${p.id}/env`, { noCache: true });
    // If any secret variable lacks real_value (e.g. older backend), hydrate from /env/raw
    const needsRawHydration = vars.some((v) => (v.is_secret ?? v.secret) && typeof v.real_value !== 'string');
    if (needsRawHydration) {
      try {
        const rawRes = await api(`/api/projects/${p.id}/env/raw`, { noCache: true });
        const map = parseDotenvClient(rawRes.content || '');
        vars.forEach((v) => {
          if (map.has(v.key)) v.real_value = map.get(v.key);
        });
      } catch (_) {}
    }

    envUiState.vars = Array.isArray(vars) ? vars : [];
    // Clean up selectedKeys that no longer exist
    const existingKeySet = new Set(envUiState.vars.map((v) => v.key));
    for (const k of Array.from(envUiState.selectedKeys)) {
      if (!existingKeySet.has(k)) envUiState.selectedKeys.delete(k);
    }

    const countBadge = document.getElementById('env-count-badge');
    if (countBadge) countBadge.textContent = String(envUiState.vars.length);

    if (envUiState.viewMode === 'multi') {
      initMultiEditRows();
      renderMultiEditTable();
    } else if (envUiState.viewMode === 'raw') {
      populateRawEditorFromState();
    } else {
      renderEnvTableFromState();
    }
  } catch (err) {
    if (tbody) {
      tbody.innerHTML = `<tr><td colspan="5" style="text-align: center; color: var(--danger); padding: 24px;">${escapeHtml(err.message)}</td></tr>`;
    }
  }
}

function parseDotenvClient(input) {
  const map = new Map();
  for (const rawLine of (input || '').split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('export ')) line = line.slice(7).trim();
    const eqIdx = line.indexOf('=');
    if (eqIdx <= 0) continue;
    const key = line.slice(0, eqIdx).trim();
    let val = line.slice(eqIdx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"') && val.length >= 2) ||
        (val.startsWith("'") && val.endsWith("'") && val.length >= 2)) {
      val = val.slice(1, -1).replace(/\\"/g, '"');
    } else {
      const commentIdx = val.indexOf(' #');
      if (commentIdx !== -1) val = val.slice(0, commentIdx).trimEnd();
    }
    if (key) map.set(key, val);
  }
  return map;
}

function setEnvViewMode(mode) {
  envUiState.viewMode = mode;
  envUiState.editingKey = null;

  const pillList = document.getElementById('env-pill-list');
  const pillMulti = document.getElementById('env-pill-multi');
  const pillRaw = document.getElementById('env-pill-raw');
  pillList?.classList.toggle('active', mode === 'list');
  pillMulti?.classList.toggle('active', mode === 'multi');
  pillRaw?.classList.toggle('active', mode === 'raw');

  const paneList = document.getElementById('env-pane-list');
  const paneMulti = document.getElementById('env-pane-multi');
  const paneRaw = document.getElementById('env-pane-raw');
  if (paneList) paneList.style.display = mode === 'list' ? 'block' : 'none';
  if (paneMulti) paneMulti.style.display = mode === 'multi' ? 'block' : 'none';
  if (paneRaw) paneRaw.style.display = mode === 'raw' ? 'block' : 'none';

  const tbList = document.getElementById('env-list-toolbar');
  const tbMulti = document.getElementById('env-multi-toolbar');
  const tbRaw = document.getElementById('env-raw-toolbar');
  if (tbList) tbList.style.display = mode === 'list' ? 'flex' : 'none';
  if (tbMulti) tbMulti.style.display = mode === 'multi' ? 'flex' : 'none';
  if (tbRaw) tbRaw.style.display = mode === 'raw' ? 'flex' : 'none';

  const quickCard = document.getElementById('env-quick-add-card');
  if (quickCard) quickCard.style.display = mode === 'list' ? 'block' : 'none';

  if (mode === 'multi') {
    initMultiEditRows();
    renderMultiEditTable();
  } else if (mode === 'raw') {
    populateRawEditorFromState();
  } else {
    renderEnvTableFromState();
  }
}
window.setEnvViewMode = setEnvViewMode;

function renderEnvTableFromState() {
  const tbody = document.getElementById('env-vars-table-body');
  if (!tbody) return;

  const q = (document.getElementById('env-search-input')?.value || '').trim().toLowerCase();
  const filtered = envUiState.vars.filter((v) => {
    if (!q) return true;
    const keyMatch = (v.key || '').toLowerCase().includes(q);
    const valMatch = getRealEnvValue(v).toLowerCase().includes(q);
    return keyMatch || valMatch;
  });

  updateSelectedEnvToolbar();

  if (!envUiState.vars.length) {
    tbody.innerHTML = '<tr><td colspan="5" style="text-align: center; padding: 28px; color: var(--text-muted);">No environment variables yet. Use the quick-add bar above, click <strong>Raw .env Editor</strong>, or <strong>Import .env</strong>.</td></tr>';
    const bar = document.getElementById('env-vars-pagination');
    if (bar) bar.innerHTML = '';
    return;
  }

  if (!filtered.length) {
    tbody.innerHTML = `<tr><td colspan="5" style="text-align: center; padding: 24px; color: var(--text-muted);">No variables match filter "${escapeHtml(q)}".</td></tr>`;
    const bar = document.getElementById('env-vars-pagination');
    if (bar) bar.innerHTML = '';
    return;
  }

  paginateAndRender(filtered, 'envVars', 'env-vars-pagination', (slice) => {
    tbody.innerHTML = slice.map((v) => {
      const isSecret = Boolean(v.is_secret ?? v.secret);
      const realVal = getRealEnvValue(v);
      const isRevealed = !isSecret || envUiState.revealAll || envUiState.revealedKeys.has(v.key);
      const isEditing = envUiState.editingKey === v.key;
      const isChecked = envUiState.selectedKeys.has(v.key);
      const keyEsc = escapeHtml(v.key);
      const keyJs = escapeHtml(JSON.stringify(v.key));

      if (isEditing) {
        const draftSecret = Boolean(envUiState.editDraft.is_secret);
        return `
          <tr class="env-row-editing">
            <td style="text-align: center;">
              <input type="checkbox" ${isChecked ? 'checked' : ''} onchange="toggleSelectEnvVar(${keyJs}, this.checked)">
            </td>
            <td>
              <input type="text" id="env-inline-edit-key" class="form-control env-mono-input" value="${escapeHtml(envUiState.editDraft.key)}" placeholder="KEY_NAME" onkeydown="handleInlineEditKeydown(event, ${keyJs})">
            </td>
            <td>
              <input type="text" id="env-inline-edit-val" class="form-control env-mono-input" value="${escapeHtml(envUiState.editDraft.value)}" placeholder="Variable value..." onkeydown="handleInlineEditKeydown(event, ${keyJs})">
            </td>
            <td>
              <button type="button" id="env-inline-edit-secret" class="env-visibility-btn ${draftSecret ? 'is-secret' : 'is-public'}" onclick="toggleInlineEditSecret()">
                ${draftSecret ? 'Secret' : 'Public'}
              </button>
            </td>
            <td style="text-align: right;">
              <div style="display: inline-flex; gap: 6px; justify-content: flex-end;">
                <button type="button" class="btn btn-primary btn-sm" onclick="saveInlineEnvEdit(${keyJs})">Save</button>
                <button type="button" class="btn btn-secondary btn-sm" onclick="cancelInlineEnvEdit()">Cancel</button>
              </div>
            </td>
          </tr>
        `;
      }

      return `
        <tr>
          <td style="text-align: center;">
            <input type="checkbox" ${isChecked ? 'checked' : ''} onchange="toggleSelectEnvVar(${keyJs}, this.checked)">
          </td>
          <td>
            <span class="env-key-badge" onclick="copyTextToClipboard(${keyJs}, 'Copied key ' + ${keyJs})" title="Click to copy key">${keyEsc}</span>
          </td>
          <td>
            ${isRevealed
              ? `<span class="env-val-box" title="${escapeHtml(realVal)}">${escapeHtml(realVal) || '<em style="color:var(--text-dim);">(empty)</em>'}</span>`
              : `<span class="env-val-box masked" onclick="toggleRevealSingleEnv(${keyJs})" title="Click to show value">&bull;&bull;&bull;&bull;&bull;&bull;&bull;&bull;&bull;&bull;&bull;&bull;</span>`
            }
          </td>
          <td>
            ${isSecret
              ? '<span class="badge badge-warning">Secret</span>'
              : '<span class="badge badge-neutral">Public</span>'
            }
          </td>
          <td style="text-align: right;">
            <div style="display: inline-flex; gap: 6px; justify-content: flex-end;">
              ${isSecret ? `
                <button type="button" class="btn btn-secondary btn-sm" onclick="toggleRevealSingleEnv(${keyJs})" title="${isRevealed ? 'Hide value' : 'Show value'}">
                  ${isRevealed ? 'Hide' : 'Show'}
                </button>
              ` : ''}
              <button type="button" class="btn btn-secondary btn-sm" onclick="copyEnvVarValue(${keyJs})" title="Copy value to clipboard">Copy</button>
              <button type="button" class="btn btn-secondary btn-sm" onclick="startInlineEnvEdit(${keyJs})" title="Edit this variable">Edit</button>
              <button type="button" class="btn btn-danger btn-sm" onclick="deleteEnvVar(${keyJs})" title="Delete variable">Delete</button>
            </div>
          </td>
        </tr>
      `;
    }).join('');
  });
}
window.renderEnvTableFromState = renderEnvTableFromState;

// --- Single Variable Inline Edit ---
function startInlineEnvEdit(key) {
  const found = envUiState.vars.find((v) => v.key === key);
  if (!found) return;
  envUiState.editingKey = key;
  envUiState.editDraft = {
    key: found.key,
    value: getRealEnvValue(found),
    is_secret: Boolean(found.is_secret ?? found.secret),
  };
  renderEnvTableFromState();
  setTimeout(() => {
    const valInput = document.getElementById('env-inline-edit-val');
    if (valInput) {
      valInput.focus();
      valInput.select();
    }
  }, 20);
}
window.startInlineEnvEdit = startInlineEnvEdit;

function toggleInlineEditSecret() {
  const keyInput = document.getElementById('env-inline-edit-key');
  const valInput = document.getElementById('env-inline-edit-val');
  if (keyInput) envUiState.editDraft.key = keyInput.value;
  if (valInput) envUiState.editDraft.value = valInput.value;
  envUiState.editDraft.is_secret = !envUiState.editDraft.is_secret;
  const btn = document.getElementById('env-inline-edit-secret');
  if (btn) {
    btn.className = `env-visibility-btn ${envUiState.editDraft.is_secret ? 'is-secret' : 'is-public'}`;
    btn.textContent = envUiState.editDraft.is_secret ? 'Secret' : 'Public';
  }
}
window.toggleInlineEditSecret = toggleInlineEditSecret;

function cancelInlineEnvEdit() {
  envUiState.editingKey = null;
  renderEnvTableFromState();
}
window.cancelInlineEnvEdit = cancelInlineEnvEdit;

function handleInlineEditKeydown(e, originalKey) {
  if (e.key === 'Enter') {
    e.preventDefault();
    void saveInlineEnvEdit(originalKey);
  } else if (e.key === 'Escape') {
    e.preventDefault();
    cancelInlineEnvEdit();
  }
}
window.handleInlineEditKeydown = handleInlineEditKeydown;

async function saveInlineEnvEdit(originalKey) {
  const p = getSelectedProject();
  if (!p) return;
  const newKey = (document.getElementById('env-inline-edit-key')?.value || '').trim();
  const newVal = document.getElementById('env-inline-edit-val')?.value ?? '';
  const isSecret = Boolean(envUiState.editDraft.is_secret);

  if (!newKey) {
    toast('Variable key cannot be empty.', 'error');
    return;
  }

  try {
    await api(`/api/projects/${p.id}/env`, {
      method: 'PUT',
      body: {
        key: newKey,
        value: newVal,
        is_secret: isSecret,
        previous_key: originalKey,
      },
    });
    envUiState.editingKey = null;
    toast(`Updated "${newKey}".`, 'success');
    await loadEnvView();
  } catch (err) {
    toast(`Failed to update variable: ${err.message}`, 'error');
  }
}
window.saveInlineEnvEdit = saveInlineEnvEdit;

// --- Quick-Add Single Variable Bar ---
function toggleQuickAddSecret() {
  envUiState.quickAddSecret = !envUiState.quickAddSecret;
  const btn = document.getElementById('env-quick-secret-toggle');
  const lbl = document.getElementById('env-quick-secret-label');
  if (btn) {
    btn.className = `env-visibility-btn ${envUiState.quickAddSecret ? 'is-secret' : 'is-public'}`;
  }
  if (lbl) {
    lbl.textContent = envUiState.quickAddSecret ? 'Secret (Masked)' : 'Public (Plaintext)';
  }
}
window.toggleQuickAddSecret = toggleQuickAddSecret;

async function handleInlineQuickAddEnv(e) {
  if (e) e.preventDefault();
  const p = getSelectedProject();
  if (!p) {
    toast('Please select or create a website first.', 'warning');
    return;
  }

  const keyInput = document.getElementById('env-quick-key-input');
  const valInput = document.getElementById('env-quick-val-input');
  let key = (keyInput?.value || '').trim();
  let value = valInput?.value ?? '';

  // Support typing/pasting KEY=VALUE directly into the Key field
  if (key.includes('=') && !value) {
    const eq = key.indexOf('=');
    const extractedKey = key.slice(0, eq).replace(/^export\s+/, '').trim();
    let extractedVal = key.slice(eq + 1).trim();
    if ((extractedVal.startsWith('"') && extractedVal.endsWith('"')) ||
        (extractedVal.startsWith("'") && extractedVal.endsWith("'"))) {
      extractedVal = extractedVal.slice(1, -1);
    }
    key = extractedKey;
    value = extractedVal;
  }

  if (!key) {
    toast('Please enter a variable key (e.g. DATABASE_URL).', 'error');
    keyInput?.focus();
    return;
  }

  try {
    await api(`/api/projects/${p.id}/env`, {
      method: 'PUT',
      body: {
        key,
        value,
        is_secret: envUiState.quickAddSecret,
      },
    });
    if (keyInput) keyInput.value = '';
    if (valInput) valInput.value = '';
    toast(`Saved variable "${key}".`, 'success');
    await loadEnvView();
    keyInput?.focus();
  } catch (err) {
    toast(`Save failed: ${err.message}`, 'error');
  }
}
window.handleInlineQuickAddEnv = handleInlineQuickAddEnv;

// Smart paste handler on Quick-Add Key input: if user pastes KEY=VALUE or multiple lines
document.addEventListener('paste', (e) => {
  const target = e.target;
  if (!target || target.id !== 'env-quick-key-input') return;
  const text = (e.clipboardData || window.clipboardData)?.getData('text') || '';
  if (!text.includes('=')) return;

  const lines = text.split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith('#') && l.includes('='));
  if (lines.length > 1) {
    e.preventDefault();
    setEnvViewMode('raw');
    const rawTa = document.getElementById('env-raw-editor-textarea');
    if (rawTa) {
      const existing = rawTa.value.trim();
      rawTa.value = existing ? `${existing}\n${text.trim()}` : text.trim();
      updateRawEnvLineStats();
    }
    toast(`Pasted ${lines.length} variables into Raw .env Editor — click "Save .env" to apply.`, 'info');
  } else if (lines.length === 1) {
    e.preventDefault();
    const line = lines[0].trim().replace(/^export\s+/, '');
    const eq = line.indexOf('=');
    const k = line.slice(0, eq).trim();
    let v = line.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    target.value = k;
    const valInput = document.getElementById('env-quick-val-input');
    if (valInput) {
      valInput.value = v;
      valInput.focus();
    }
  }
});

// --- Show / Hide & Copy Helpers (Zero Password Friction) ---
function toggleRevealSingleEnv(key) {
  if (envUiState.revealedKeys.has(key)) {
    envUiState.revealedKeys.delete(key);
  } else {
    envUiState.revealedKeys.add(key);
  }
  renderEnvTableFromState();
}
window.toggleRevealSingleEnv = toggleRevealSingleEnv;

function toggleRevealAllEnv() {
  envUiState.revealAll = !envUiState.revealAll;
  if (!envUiState.revealAll) {
    envUiState.revealedKeys.clear();
  }
  const btn = document.getElementById('env-toggle-all-reveal-btn');
  if (btn) {
    btn.textContent = envUiState.revealAll ? 'Hide All Values' : 'Show All Values';
  }
  renderEnvTableFromState();
}
window.toggleRevealAllEnv = toggleRevealAllEnv;

function copyEnvVarValue(key) {
  const found = envUiState.vars.find((v) => v.key === key);
  if (!found) return;
  void copyTextToClipboard(getRealEnvValue(found), `Copied value for "${key}"`);
}
window.copyEnvVarValue = copyEnvVarValue;

// --- Multi-Select & Bulk Delete ---
function toggleSelectEnvVar(key, checked) {
  if (checked) {
    envUiState.selectedKeys.add(key);
  } else {
    envUiState.selectedKeys.delete(key);
  }
  updateSelectedEnvToolbar();
}
window.toggleSelectEnvVar = toggleSelectEnvVar;

function toggleSelectAllEnvVars(checked) {
  if (checked) {
    envUiState.vars.forEach((v) => envUiState.selectedKeys.add(v.key));
  } else {
    envUiState.selectedKeys.clear();
  }
  renderEnvTableFromState();
}
window.toggleSelectAllEnvVars = toggleSelectAllEnvVars;

function updateSelectedEnvToolbar() {
  const count = envUiState.selectedKeys.size;
  const delBtn = document.getElementById('env-delete-selected-btn');
  const countSpan = document.getElementById('env-selected-count');
  const selectAllCheck = document.getElementById('env-select-all-check');
  if (delBtn) delBtn.style.display = count > 0 ? 'inline-flex' : 'none';
  if (countSpan) countSpan.textContent = String(count);
  if (selectAllCheck) {
    selectAllCheck.checked = envUiState.vars.length > 0 && count === envUiState.vars.length;
  }
}

async function deleteSelectedEnvVars() {
  const p = getSelectedProject();
  if (!p || !envUiState.selectedKeys.size) return;
  const keys = Array.from(envUiState.selectedKeys);
  const ok = await showConfirmDialog({
    title: `Delete ${keys.length} Selected Variable(s)`,
    message: `Are you sure you want to delete ${keys.length} selected variable(s) (${keys.slice(0, 5).join(', ')}${keys.length > 5 ? '...' : ''}) from ${p.name}?`,
    confirmText: `Delete ${keys.length} Variable(s)`,
    danger: true,
  });
  if (!ok) return;

  try {
    for (const k of keys) {
      await api(`/api/projects/${p.id}/env/${encodeURIComponent(k)}`, { method: 'DELETE' });
    }
    envUiState.selectedKeys.clear();
    toast(`Deleted ${keys.length} variable(s).`, 'success');
    await loadEnvView();
  } catch (err) {
    toast(`Delete failed: ${err.message}`, 'error');
  }
}
window.deleteSelectedEnvVars = deleteSelectedEnvVars;

// --- Mode 2: Multi-Row Table Editor (Edit Multiple Variables at Once) ---
function initMultiEditRows() {
  envUiState.multiRows = envUiState.vars.map((v) => ({
    key: v.key,
    value: getRealEnvValue(v),
    is_secret: Boolean(v.is_secret ?? v.secret),
  }));
  if (envUiState.multiRows.length === 0) {
    envUiState.multiRows.push({ key: '', value: '', is_secret: true });
  }
}

function syncMultiEditDomToState() {
  const rows = document.querySelectorAll('#env-multi-edit-tbody tr[data-multi-idx]');
  rows.forEach((tr) => {
    const idx = Number(tr.getAttribute('data-multi-idx'));
    if (!envUiState.multiRows[idx]) return;
    const kEl = tr.querySelector('.multi-env-key');
    const vEl = tr.querySelector('.multi-env-val');
    if (kEl) envUiState.multiRows[idx].key = kEl.value;
    if (vEl) envUiState.multiRows[idx].value = vEl.value;
  });
}

function renderMultiEditTable() {
  const tbody = document.getElementById('env-multi-edit-tbody');
  if (!tbody) return;
  tbody.innerHTML = envUiState.multiRows.map((row, idx) => `
    <tr data-multi-idx="${idx}">
      <td>
        <input type="text" class="form-control env-mono-input multi-env-key" value="${escapeHtml(row.key)}" placeholder="KEY_NAME">
      </td>
      <td>
        <input type="text" class="form-control env-mono-input multi-env-val" value="${escapeHtml(row.value)}" placeholder="Value...">
      </td>
      <td>
        <button type="button" class="env-visibility-btn ${row.is_secret ? 'is-secret' : 'is-public'}" onclick="toggleMultiEditRowSecret(${idx})">
          ${row.is_secret ? 'Secret' : 'Public'}
        </button>
      </td>
      <td style="text-align: right;">
        <button type="button" class="btn btn-danger btn-sm" onclick="removeMultiEditEnvRow(${idx})" title="Remove this variable">&times;</button>
      </td>
    </tr>
  `).join('');
}

function addMultiEditEnvRow() {
  syncMultiEditDomToState();
  envUiState.multiRows.push({ key: '', value: '', is_secret: true });
  renderMultiEditTable();
  const inputs = document.querySelectorAll('#env-multi-edit-tbody .multi-env-key');
  const last = inputs[inputs.length - 1];
  if (last) last.focus();
}
window.addMultiEditEnvRow = addMultiEditEnvRow;

function removeMultiEditEnvRow(idx) {
  syncMultiEditDomToState();
  envUiState.multiRows.splice(idx, 1);
  if (envUiState.multiRows.length === 0) {
    envUiState.multiRows.push({ key: '', value: '', is_secret: true });
  }
  renderMultiEditTable();
}
window.removeMultiEditEnvRow = removeMultiEditEnvRow;

function toggleMultiEditRowSecret(idx) {
  syncMultiEditDomToState();
  if (envUiState.multiRows[idx]) {
    envUiState.multiRows[idx].is_secret = !envUiState.multiRows[idx].is_secret;
    renderMultiEditTable();
  }
}
window.toggleMultiEditRowSecret = toggleMultiEditRowSecret;

async function finishEnvSave(p, countMsg, andRestart) {
  toast(countMsg, 'success');
  setEnvViewMode('list');
  await loadEnvView();
  if (andRestart) {
    await restartProject(p.id);
  }
}

function setBtnLoading(btn, loading, defaultText, loadingText = 'Saving...') {
  if (!btn) return;
  btn.disabled = loading;
  btn.textContent = loading ? loadingText : defaultText;
}

async function saveMultiEditEnv(andRestart = false) {
  const p = getSelectedProject();
  if (!p) return;
  syncMultiEditDomToState();

  const items = envUiState.multiRows
    .map((r) => ({
      key: (r.key || '').trim(),
      value: r.value ?? '',
      is_secret: Boolean(r.is_secret),
    }))
    .filter((r) => r.key.length > 0);

  const btn = document.getElementById('env-multi-save-btn');
  setBtnLoading(btn, true, 'Save All Changes');

  try {
    const res = await api(`/api/projects/${p.id}/env/bulk`, {
      method: 'POST',
      body: {
        items,
        replace_all: true,
      },
    });
    await finishEnvSave(p, `Saved ${res.count ?? items.length} environment variable(s) for ${p.name}!`, andRestart);
  } catch (err) {
    toast(`Failed to save variables: ${err.message}`, 'error');
  } finally {
    setBtnLoading(btn, false, 'Save All Changes');
  }
}
window.saveMultiEditEnv = saveMultiEditEnv;

// --- Mode 3: Inline Raw .env Editor ---
function populateRawEditorFromState() {
  const ta = document.getElementById('env-raw-editor-textarea');
  if (!ta) return;
  ta.value = formatEnvVarsToRaw(envUiState.vars);
  updateRawEnvLineStats();
}

function updateRawEnvLineStats() {
  const ta = document.getElementById('env-raw-editor-textarea');
  const stats = document.getElementById('env-raw-line-stats');
  if (!ta || !stats) return;
  const parsed = parseDotenvClient(ta.value);
  stats.textContent = `${parsed.size} variable${parsed.size === 1 ? '' : 's'} detected`;
}

document.getElementById('env-raw-editor-textarea')?.addEventListener('input', updateRawEnvLineStats);

async function saveInlineRawEnv(andRestart = false) {
  const p = getSelectedProject();
  if (!p) return;
  const content = document.getElementById('env-raw-editor-textarea')?.value || '';
  const replace_all = document.getElementById('env-raw-sync-delete-check')?.checked ?? true;
  const is_secret = document.getElementById('env-raw-secret-check')?.checked ?? true;

  const btn = document.getElementById('env-raw-save-btn');
  setBtnLoading(btn, true, 'Save .env');

  try {
    const res = await api(`/api/projects/${p.id}/env/bulk`, {
      method: 'POST',
      body: { content, is_secret, replace_all },
    });
    await finishEnvSave(p, `Saved ${res.count || 0} variables from .env editor!`, andRestart);
  } catch (err) {
    toast(`Failed to save .env: ${err.message}`, 'error');
  } finally {
    setBtnLoading(btn, false, 'Save .env');
  }
}
window.saveInlineRawEnv = saveInlineRawEnv;

function copyRawEnvToClipboard() {
  const ta = document.getElementById('env-raw-editor-textarea');
  const content = ta ? ta.value : formatEnvVarsToRaw(envUiState.vars);
  if (!content.trim()) {
    toast('No variables to copy.', 'info');
    return;
  }
  void copyTextToClipboard(content, 'Copied .env contents to clipboard');
}
window.copyRawEnvToClipboard = copyRawEnvToClipboard;

function handleEnvFileUpload(event) {
  const file = event?.target?.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    const content = String(e.target?.result || '');
    setEnvViewMode('raw');
    const ta = document.getElementById('env-raw-editor-textarea');
    if (ta) {
      ta.value = content;
      updateRawEnvLineStats();
    }
    toast(`Loaded "${file.name}" into Raw .env Editor — review and click "Save .env".`, 'info');
  };
  reader.readAsText(file);
  event.target.value = '';
}
window.handleEnvFileUpload = handleEnvFileUpload;

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
  if (p) void restartProject(p.id);
}
window.restartCurrentProject = restartCurrentProject;

// Keep legacy modal functions working seamlessly if invoked anywhere
let activeEnvTab = 'single';

function switchEnvModalTab(tab) {
  activeEnvTab = tab;
  const singleSec = document.getElementById('env-section-single');
  const bulkSec = document.getElementById('env-section-bulk');
  if (singleSec) singleSec.style.display = tab === 'single' ? 'block' : 'none';
  if (bulkSec) bulkSec.style.display = tab === 'bulk' ? 'block' : 'none';
}
window.switchEnvModalTab = switchEnvModalTab;

function openAddEnvModal() {
  setEnvViewMode('list');
  document.getElementById('env-quick-key-input')?.focus();
}
window.openAddEnvModal = openAddEnvModal;

function openBulkEnvModal() {
  setEnvViewMode('raw');
}
window.openBulkEnvModal = openBulkEnvModal;

async function loadCurrentEnv() {
  const p = getSelectedProject();
  if (!p) return;
  try {
    const res = await api(`/api/projects/${p.id}/env/raw`, { noCache: true });
    const bulkInput = document.getElementById('env-bulk-input');
    if (bulkInput) bulkInput.value = res.content || '';
    const rawTa = document.getElementById('env-raw-editor-textarea');
    if (rawTa) {
      rawTa.value = res.content || '';
      updateRawEnvLineStats();
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
    const res = await api(`/api/projects/${p.id}/env/raw`, { noCache: true });
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
  return handleInlineQuickAddEnv(e);
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
    envUiState.selectedKeys.delete(key);
    toast(`Variable "${key}" deleted.`, 'success');
    await loadEnvView();
  } catch (err) {
    toast(`Delete failed: ${err.message}`, 'error');
  }
}
window.deleteEnvVar = deleteEnvVar;

function promptRevealEnv(key) {
  toggleRevealSingleEnv(key);
}
window.promptRevealEnv = promptRevealEnv;

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
      await loadReleasesView();
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
// Direct Process Controls (Start / Stop / Restart)
// ============================================================================
async function refreshCurrentViewsAfterLifecycle() {
  await loadProjects();
  renderProjectsList();
  renderServicesList();
  if (state.currentView === 'overview') await loadOverview();
  if (WEBSITE_WORKSPACE_TABS.has(state.currentView)) {
    state.lastWsBannerSig = null;
    renderWebsiteWorkspaceHeader();
  }
}

function handleAutoDeployedRedirect(res, projectId) {
  if (res && res.autoDeployed) {
    toast(`No release built yet — initial deployment #${res.deploymentId} started automatically!`, 'info');
    navigateTo('deployments', projectId);
    return true;
  }
  return false;
}

async function startProject(projectId) {
  const btns = document.querySelectorAll(`button[onclick*="startProject(${projectId})"], button[onclick*="stopProject(${projectId})"]`);
  btns.forEach((b) => {
    b.disabled = true;
    b.innerHTML = '<span class="btn-spinner"></span> Starting...';
  });

  const proj = state.projects.find((x) => x.id === projectId);
  if (proj) proj.app_status = 'starting';

  try {
    const res = await api(`/api/projects/${projectId}/start`, { method: 'POST' });
    if (handleAutoDeployedRedirect(res, projectId)) return;
    if (proj) proj.app_status = 'running';
    toast('Process started successfully.', 'success');
  } catch (err) {
    if (proj) proj.app_status = 'stopped';
    toast(`Start failed: ${err.message}`, 'error');
  } finally {
    state.lastWsBannerSig = null;
    await refreshCurrentViewsAfterLifecycle();
  }
}
window.startProject = startProject;

async function stopProject(projectId) {
  const btns = document.querySelectorAll(`button[onclick*="startProject(${projectId})"], button[onclick*="stopProject(${projectId})"]`);
  btns.forEach((b) => {
    b.disabled = true;
    b.innerHTML = '<span class="btn-spinner"></span> Stopping...';
  });

  const proj = state.projects.find((x) => x.id === projectId);
  if (proj) proj.app_status = 'stopping';

  try {
    await api(`/api/projects/${projectId}/stop`, { method: 'POST' });
    if (proj) proj.app_status = 'stopped';
    toast('Process stopped successfully.', 'info');
  } catch (err) {
    if (proj) proj.app_status = 'running';
    toast(`Stop failed: ${err.message}`, 'error');
  } finally {
    state.lastWsBannerSig = null;
    await refreshCurrentViewsAfterLifecycle();
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
    state.lastWsBannerSig = null;
    await refreshCurrentViewsAfterLifecycle();
  } catch (err) {
    toast(`Maintenance toggle failed: ${err.message}`, 'error');
  }
}
window.toggleMaintenanceMode = toggleMaintenanceMode;

async function restartProject(projectId) {
  const btns = document.querySelectorAll(`button[onclick*="restartProject(${projectId})"]`);
  btns.forEach((b) => {
    b.disabled = true;
    b.innerHTML = '<span class="btn-spinner"></span> Restarting...';
  });

  const proj = state.projects.find((x) => x.id === projectId);
  if (proj) proj.app_status = 'starting';

  try {
    const res = await api(`/api/projects/${projectId}/restart`, { method: 'POST' });
    if (handleAutoDeployedRedirect(res, projectId)) return;
    if (proj) proj.app_status = 'running';
    toast('Application restarted successfully.', 'success');
  } catch (err) {
    toast(`Restart failed: ${err.message}`, 'error');
  } finally {
    state.lastWsBannerSig = null;
    await refreshCurrentViewsAfterLifecycle();
  }
}
window.restartProject = restartProject;

// ============================================================================
// Managed Databases (PostgreSQL)
// ============================================================================
async function loadDatabases() {
  try {
    state.databases = await api(`/api/databases?_t=${Date.now()}`, { noCache: true });
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
window.renderDatabasePipeline = (stage, status, text, id) => {
  if (id) renderSingleDatabasePipeline(id, stage, status, text);
};

async function loadDatabasesView() {
  await loadDatabases();
  renderDatabasesList();
}
window.loadDatabasesView = loadDatabasesView;

function renderDatabasesList() {
  const container = document.getElementById('databases-cards-container');
  if (!container) return;

  if (!state.databases || state.databases.length === 0) {
    container.innerHTML = `
      <div class="empty-state" style="grid-column: 1 / -1; padding: 48px 24px; text-align: center; background: var(--surface); border: 1px dashed var(--border); border-radius: var(--radius-lg);">
        <div style="font-size: 38px; margin-bottom: 12px;">🐘</div>
        <h3 style="font-size: 16px; font-weight: 600; margin-bottom: 6px;">No PostgreSQL Databases Yet</h3>
        <p style="font-size: 13.5px; color: var(--text-muted); max-width: 440px; margin: 0 auto 18px auto; line-height: 1.5;">
          Deploy a fast, isolated PostgreSQL database on this VPS with customized database names, passwords, and remote IP access controls.
        </p>
        <button class="btn btn-primary" onclick="openCreateDatabaseModal()">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
          <span>Create First Database</span>
        </button>
      </div>
    `;
    return;
  }

  container.innerHTML = state.databases.map((db) => {
    const isRunning = db.status === 'running';
    const isError = db.status === 'error';
    const statusClass = isRunning ? 'badge-success' : (isError ? 'badge-danger' : 'badge-neutral');
    const statusText = isRunning ? 'RUNNING' : (isError ? 'ERROR' : 'STOPPED');

    const accessMode = db.accessMode || db.access_mode || 'local';
    const allowedIps = db.allowedIps || db.allowed_ips || '';
    let accessBadge = '<span class="badge badge-neutral" style="font-size: 11px;">🔒 Localhost Only (127.0.0.1)</span>';
    if (accessMode === 'allowlist') {
      const ipList = allowedIps ? allowedIps.split(/[,;\n]/).filter(Boolean).length : 0;
      accessBadge = `<span class="badge badge-primary" style="font-size: 11px;">🛡️ Remote Allowlist (${ipList} IP${ipList === 1 ? '' : 's'})</span>`;
    } else if (accessMode === 'public') {
      accessBadge = '<span class="badge badge-warning" style="font-size: 11px;">🌐 Public (0.0.0.0)</span>';
    }

    return `
      <div class="card project-card" id="db-card-${db.id}" style="display: flex; flex-direction: column; justify-content: space-between; position: relative;">
        <div>
          <div class="project-header" style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 8px;">
            <div style="display: flex; align-items: center; gap: 10px;">
              <div style="width: 36px; height: 36px; border-radius: 8px; background: rgba(51, 103, 145, 0.15); color: #336791; display: flex; align-items: center; justify-content: center; font-size: 18px;">
                🐘
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
            ${db.domain ? `<span class="badge badge-primary" style="font-size: 11px; font-family: var(--font-mono);">🌐 ${escapeHtml(db.domain)}:${db.port}</span>` : `<span class="badge badge-neutral" style="font-size: 11px; font-family: var(--font-mono);">Port ${db.port}</span>`}
            ${db.isSuperuser ? '<span class="badge badge-primary" style="font-size: 11px;">Superuser</span>' : ''}
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
  }).join('');

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
  if (title) title.textContent = db ? `🐘 ${db.name} — Server Logs` : `Database #${id} Logs`;
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
      // Keep sidebar badges (databases & projects & services) constantly up-to-date across all tabs
      await Promise.all([
        loadProjects().catch(() => {}),
        loadDatabases().catch(() => {})
      ]);

      if (state.currentView === 'overview') {
        await loadOverview();
      } else if (state.currentView === 'services') {
        renderServicesList();
      } else if (state.currentView === 'projects') {
        renderProjectsList();
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
      } else if (state.currentView === 'databases') {
        const anyLooping = Object.values(waterPipelines).some((p) => p && p.isLooping);
        if (!anyLooping) {
          const oldSig = (state.databases || []).map((d) => `${d.id}:${d.status}:${d.updated_at}`).join('|');
          await loadDatabases();
          const newSig = (state.databases || []).map((d) => `${d.id}:${d.status}:${d.updated_at}`).join('|');
          if (oldSig !== newSig) {
            renderDatabasesList();
          }
        }
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
document.getElementById('global-add-website-btn')?.addEventListener('click', globalAddAction);
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
      document.body.classList.remove('auth-verified');
      state.user = null;
      state.csrf = null;
      state.pendingMfaToken = res.mfaToken;
      resetCleanUrl();
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

    await applyAuthSuccess(res);
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
    await applyAuthSuccess(res);
    toast('Two-Factor Authentication verified!', 'success');
  } catch (err) {
    toast(err.message, 'error');
    if (err.message && (err.message.includes('expired') || err.message.includes('Locked'))) {
      showLogin();
    }
  } finally {
    btn.disabled = false;
    btn.textContent = 'Verify & Sign In';
  }
});

document.getElementById('login-2fa-back-btn')?.addEventListener('click', () => {
  showLogin();
});

// Logout
document.getElementById('logout-btn')?.addEventListener('click', async () => {
  try {
    await api('/api/auth/logout', { method: 'POST' });
  } catch { /* ignore */ }
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

function getDialogElements() {
  return {
    modal: document.getElementById('modal-dialog'),
    titleEl: document.getElementById('dialog-modal-title'),
    msgEl: document.getElementById('dialog-modal-message'),
    inputWrap: document.getElementById('dialog-input-wrapper'),
    inputEl: document.getElementById('dialog-modal-input'),
    confirmBtn: document.getElementById('dialog-confirm-btn'),
    cancelBtn: document.getElementById('dialog-cancel-btn'),
    closeBtn: document.getElementById('dialog-modal-close'),
  };
}

function prepareDialogModal({ title, message, confirmText = 'Confirm', danger = false }) {
  const elems = getDialogElements();
  elems.titleEl.textContent = title;
  elems.msgEl.textContent = message;
  elems.cancelBtn.style.display = '';
  elems.cancelBtn.textContent = 'Cancel';
  elems.confirmBtn.textContent = confirmText;
  elems.confirmBtn.className = `btn ${danger ? 'btn-danger' : 'btn-primary'}`;
  return elems;
}

function showConfirmDialog({ title = 'Confirm Action', message = '', confirmText = 'Confirm', danger = false } = {}) {
  return new Promise((resolve) => {
    const { modal, inputWrap, confirmBtn, cancelBtn, closeBtn } = prepareDialogModal({ title, message, confirmText, danger });
    inputWrap.style.display = 'none';

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
    const { modal, inputWrap, inputEl, confirmBtn, cancelBtn, closeBtn } = prepareDialogModal({ title, message, confirmText, danger });
    inputWrap.style.display = 'block';
    inputEl.readOnly = false;
    inputEl.value = defaultValue;
    inputEl.placeholder = placeholder;

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
    const { modal, titleEl, msgEl, inputWrap, inputEl, confirmBtn, cancelBtn, closeBtn } = getDialogElements();

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
      await copyTextToClipboard(value, 'Copied to clipboard!');
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
  ['passkeys', 'password', '2fa', 'sessions'].forEach((t) => {
    const btn = document.getElementById(`sec-tab-btn-${t}`);
    const pane = document.getElementById(`sec-pane-${t}`);
    if (btn) btn.classList.toggle('active', t === tab);
    if (pane) pane.style.display = t === tab ? 'block' : 'none';
  });
  if (tab === 'passkeys') {
    const nameInput = document.getElementById('passkey-device-name');
    if (nameInput && !nameInput.value.trim()) {
      nameInput.value = detectDefaultPasskeyDeviceName();
    }
    const httpsHint = document.getElementById('passkey-https-hint');
    if (httpsHint) {
      httpsHint.style.display = window.PublicKeyCredential ? 'none' : 'block';
    }
    void loadPasskeysList();
  }
}
window.switchSecurityTab = switchSecurityTab;

function base64UrlToUint8Array(base64Url) {
  const padding = '='.repeat((4 - (base64Url.length % 4)) % 4);
  const base64 = (base64Url + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

function bufferToBase64Url(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  let b64 = window.btoa(binary).replace(/\+/g, '-').replace(/\//g, '_');
  while (b64.endsWith('=')) {
    b64 = b64.slice(0, -1);
  }
  return b64;
}

function detectDefaultPasskeyDeviceName() {
  const ua = navigator.userAgent || '';
  if (/iPhone/i.test(ua)) return 'iPhone Face ID';
  if (/iPad/i.test(ua)) return 'iPad Face ID / Touch ID';
  if (/Android/i.test(ua)) return 'Android Fingerprint';
  if (/Macintosh|Mac OS X/i.test(ua)) return 'Mac Touch ID';
  if (/Windows/i.test(ua)) return 'Windows Hello';
  return 'Passkey / Biometric Device';
}

async function loadPasskeysList() {
  const container = document.getElementById('passkeys-list-container');
  try {
    const res = await api('/api/auth/passkeys', { noCache: true });
    const list = Array.isArray(res?.passkeys) ? res.passkeys : [];
    state.passkeysList = list;
    state.passkeyCount = list.length;
    renderSecurityStatusSummary();
    if (!container) return;
    if (!list.length) {
      container.innerHTML = `
        <div style="font-size: 12.5px; color: var(--text-dim); padding: 14px; text-align: center; border: 1px dashed var(--border-subtle); border-radius: var(--radius-md);">
          No passkeys or biometric devices registered yet. Add your phone or laptop above to sign in with Face ID or Fingerprint.
        </div>
      `;
      return;
    }
    container.innerHTML = list.map((pk) => {
      const addedText = pk.createdAt ? formatDate(pk.createdAt) : '--';
      const usedText = pk.lastUsedAt ? `Last used ${formatRelativeTime(pk.lastUsedAt)}` : 'Never used yet';
      return `
        <div style="display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 10px 12px; background: var(--bg-surface-elevated); border: 1px solid var(--border-subtle); border-radius: var(--radius-md);">
          <div style="display: flex; align-items: center; gap: 10px; min-width: 0;">
            <div style="width: 32px; height: 32px; border-radius: 6px; background: var(--info-bg); border: 1px solid var(--info-border); color: var(--accent-light); display: flex; align-items: center; justify-content: center; flex-shrink: 0;">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 10a2 2 0 0 0-2 2c0 1.02-.1 2.51-.26 4"/><path d="M14 13.12c0 2.38 0 6.38-1 8.88"/><path d="M2 12a10 10 0 0 1 18-6"/><path d="M5 19.5C5.5 18 6 15 6 12a6 6 0 0 1 .34-2"/><path d="M9 6.8a6 6 0 0 1 9 5.2v2"/></svg>
            </div>
            <div style="min-width: 0;">
              <div style="font-size: 13px; font-weight: 600; color: var(--text-main); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${escapeHtml(pk.name)}</div>
              <div style="font-size: 11px; color: var(--text-dim);">Added ${escapeHtml(addedText)} &bull; ${escapeHtml(usedText)}</div>
            </div>
          </div>
          <button type="button" class="btn btn-danger btn-xs" onclick="deletePasskey(${pk.id}, '${escapeHtml(pk.name)}')">Remove</button>
        </div>
      `;
    }).join('');
  } catch (err) {
    if (container) {
      container.innerHTML = `<div style="font-size: 12px; color: var(--danger-light); padding: 10px;">${escapeHtml(err.message)}</div>`;
    }
  }
}
window.loadPasskeysList = loadPasskeysList;

async function registerNewPasskey() {
  if (!window.isSecureContext || !window.PublicKeyCredential || !navigator.credentials?.create) {
    const origin = window.location.origin;
    toast(
      `Passkeys / Biometrics require HTTPS (https://your-domain.com) or localhost. Current URL (${origin}) is plain HTTP.`,
      'warning'
    );
    await showCopyDialog({
      title: 'HTTPS Required for Face ID / Fingerprint (WebAuthn)',
      message: `Browsers block Face ID, Touch ID, and Fingerprint on plain HTTP IP URLs (${origin}).\n\n• On iPhone / Android: Open this panel via your HTTPS domain (https://...).\n• On Desktop Chrome / Brave / Edge (for testing over HTTP IP): Open chrome://flags/#unsafely-treat-insecure-origin-as-secure and paste this origin:`,
      value: origin,
    });
    return;
  }
  const nameInput = document.getElementById('passkey-device-name');
  const label = (nameInput?.value || '').trim() || detectDefaultPasskeyDeviceName();
  const btn = document.getElementById('register-passkey-btn');
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<span>Waiting for Face ID / Fingerprint...</span>';
  }
  try {
    const start = await api('/api/auth/passkeys/register/start', { method: 'POST', body: {} });
    const buildOptions = (usePlatformAttachment) => {
      const authenticatorSelection = {
        userVerification: 'preferred',
        residentKey: 'preferred',
      };
      if (usePlatformAttachment) {
        authenticatorSelection.authenticatorAttachment = 'platform';
      }
      return {
        challenge: base64UrlToUint8Array(start.challenge),
        rp: {
          name: 'WebDep Deployment Platform',
        },
        user: {
          id: base64UrlToUint8Array(start.user.id),
          name: start.user.name,
          displayName: start.user.displayName,
        },
        pubKeyCredParams: [
          { type: 'public-key', alg: -7 },   // ES256 (NIST P-256)
          { type: 'public-key', alg: -257 }, // RS256 fallback for spec compliance
        ],
        authenticatorSelection,
        timeout: 60000,
        attestation: 'none',
        excludeCredentials: (start.excludeCredentials || []).map((cid) => ({
          type: 'public-key',
          id: base64UrlToUint8Array(cid),
        })),
      };
    };

    let cred;
    try {
      cred = await navigator.credentials.create({ publicKey: buildOptions(true) });
    } catch (platformErr) {
      if (platformErr && (platformErr.name === 'NotSupportedError' || platformErr.name === 'InvalidStateError')) {
        cred = await navigator.credentials.create({ publicKey: buildOptions(false) });
      } else {
        throw platformErr;
      }
    }

    if (!cred || !cred.response) {
      throw new Error('Passkey registration was cancelled.');
    }

    let publicKeySpki = null;
    try {
      if (typeof cred.response.getPublicKey === 'function') {
        const spkiBuf = cred.response.getPublicKey();
        if (spkiBuf) publicKeySpki = bufferToBase64Url(spkiBuf);
      }
    } catch (_) {}

    let authenticatorData = null;
    try {
      if (typeof cred.response.getAuthenticatorData === 'function') {
        const adBuf = cred.response.getAuthenticatorData();
        if (adBuf) authenticatorData = bufferToBase64Url(adBuf);
      }
    } catch (_) {}

    const finishRes = await api('/api/auth/passkeys/register/finish', {
      method: 'POST',
      body: {
        challengeId: start.challengeId,
        name: label,
        credentialId: bufferToBase64Url(cred.rawId),
        publicKeySpki,
        authenticatorData,
        attestationObject: bufferToBase64Url(cred.response.attestationObject),
        clientDataJSON: bufferToBase64Url(cred.response.clientDataJSON),
      },
    });

    state.passkeysList = finishRes.passkeys || [];
    state.passkeyCount = state.passkeysList.length;
    renderSecurityStatusSummary();
    await loadPasskeysList();
    toast(`Passkey "${label}" registered! You can now sign in with Face ID / Fingerprint.`, 'success');
  } catch (err) {
    if (err.name === 'NotAllowedError') {
      toast('Biometric / Passkey prompt was cancelled or timed out.', 'info');
    } else if (err.name === 'InvalidStateError') {
      toast('This device passkey is already registered on your account.', 'info');
    } else {
      toast(`Passkey registration failed: ${err.message}`, 'error');
    }
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = `
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 10a2 2 0 0 0-2 2c0 1.02-.1 2.51-.26 4"/><path d="M14 13.12c0 2.38 0 6.38-1 8.88"/><path d="M2 12a10 10 0 0 1 18-6"/><path d="M5 19.5C5.5 18 6 15 6 12a6 6 0 0 1 .34-2"/><path d="M9 6.8a6 6 0 0 1 9 5.2v2"/></svg>
        <span>Register Passkey / Biometric</span>
      `;
    }
  }
}
window.registerNewPasskey = registerNewPasskey;

async function deletePasskey(id, name) {
  const ok = await showConfirmDialog({
    title: 'Remove Passkey / Biometric Device',
    message: `Remove "${name}" from your account? You will no longer be able to sign in with this passkey unless you register it again.`,
    confirmText: 'Remove Passkey',
    danger: true,
  });
  if (!ok) return;
  try {
    const res = await api(`/api/auth/passkeys/${id}`, { method: 'DELETE' });
    state.passkeysList = res.passkeys || [];
    state.passkeyCount = state.passkeysList.length;
    renderSecurityStatusSummary();
    await loadPasskeysList();
    toast(`Removed passkey "${name}".`, 'info');
  } catch (err) {
    toast(`Failed to remove passkey: ${err.message}`, 'error');
  }
}
window.deletePasskey = deletePasskey;

async function loginWithPasskey() {
  if (!window.isSecureContext || !window.PublicKeyCredential || !navigator.credentials?.get) {
    toast(
      `Passkeys / Biometrics require HTTPS (https://your-domain.com) or localhost. Current URL (${window.location.origin}) is plain HTTP.`,
      'warning'
    );
    return;
  }
  const username = (document.getElementById('login-username')?.value || '').trim();
  const btn = document.getElementById('login-passkey-btn');
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<span>Verifying Face ID / Fingerprint...</span>';
  }
  try {
    const start = await api('/api/auth/passkeys/login/start', {
      method: 'POST',
      body: { username: username || null },
    });
    const allowCredentials = (start.allowCredentials || []).map((cid) => ({
      type: 'public-key',
      id: base64UrlToUint8Array(cid),
    }));
    const publicKey = {
      challenge: base64UrlToUint8Array(start.challenge),
      userVerification: 'preferred',
      timeout: 60000,
    };
    if (allowCredentials.length > 0) {
      publicKey.allowCredentials = allowCredentials;
    }

    const assertion = await navigator.credentials.get({ publicKey });
    if (!assertion || !assertion.response) {
      throw new Error('Passkey sign-in was cancelled.');
    }

    const res = await api('/api/auth/passkeys/login/finish', {
      method: 'POST',
      body: {
        challengeId: start.challengeId,
        credentialId: bufferToBase64Url(assertion.rawId),
        authenticatorData: bufferToBase64Url(assertion.response.authenticatorData),
        clientDataJSON: bufferToBase64Url(assertion.response.clientDataJSON),
        signature: bufferToBase64Url(assertion.response.signature),
      },
    });

    await applyAuthSuccess(res);
    toast('Signed in with Passkey / Biometrics!', 'success');
  } catch (err) {
    if (err.name === 'NotAllowedError') {
      toast('Biometric / Passkey sign-in was cancelled.', 'info');
    } else {
      toast(err.message || 'Passkey sign-in failed', 'error');
    }
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = `
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 10a2 2 0 0 0-2 2c0 1.02-.1 2.51-.26 4"/><path d="M14 13.12c0 2.38 0 6.38-1 8.88"/><path d="M17.29 21.02c.12-.6.43-2.3.5-3.02"/><path d="M2 12a10 10 0 0 1 18-6"/><path d="M2 16h.01"/><path d="M21.8 16c.2-2 .131-5.354 0-6"/><path d="M5 19.5C5.5 18 6 15 6 12a6 6 0 0 1 .34-2"/><path d="M8.65 22c.21-.66.45-1.32.57-2"/><path d="M9 6.8a6 6 0 0 1 9 5.2v2"/></svg>
        <span>Sign in with Passkey / Biometrics</span>
      `;
    }
  }
}
window.loginWithPasskey = loginWithPasskey;



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
  }).catch((err) => {
    toast(`Failed to copy to clipboard: ${err.message}`, 'error');
  });
}
window.copy2faSecret = copy2faSecret;

async function confirmEnable2fa() {
  const raw = (document.getElementById('tfa-verify-code')?.value || '').trim();
  const code = raw.replace(/\D/g, '');
  if (code.length !== 6) {
    toast('Please enter the 6-digit code from your authenticator app.', 'warning');
    return;
  }
  try {
    const res = await api('/api/auth/2fa/enable', { method: 'POST', body: { code } });
    state.user.totpEnabled = true;
    state.lastRecoveryCodes = res.backupCodes || [];
    renderSecurityStatusSummary();
    if (state.currentView === 'settings') await loadSettingsView();

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

document.getElementById('tfa-setup-password')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    void start2faSetup();
  }
});

document.getElementById('tfa-verify-code')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    void confirmEnable2fa();
  }
});

document.getElementById('tfa-disable-code')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    void disable2fa();
  }
});

function copyRecoveryCodes() {
  const codes = (state.lastRecoveryCodes || []).join('\n');
  if (!codes) return;
  navigator.clipboard.writeText(codes).then(() => {
    toast('Recovery codes copied to clipboard!', 'success');
  }).catch((err) => {
    toast(`Failed to copy to clipboard: ${err.message}`, 'error');
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
    await loadSettingsView();
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
    const quiet = 4;
    const total = n + quiet * 2;
    let paths = '';
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        if (matrix[r][c]) {
          paths += `M${c + quiet},${r + quiet}h1v1h-1z`;
        }
      }
    }
    return `<svg viewBox="0 0 ${total} ${total}" width="144" height="144" shape-rendering="crispEdges" xmlns="http://www.w3.org/2000/svg"><rect width="${total}" height="${total}" fill="#ffffff"/><path d="${paths}" fill="#0f172a"/></svg>`;
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

  for (let i = 8; i < size - 8; i++) {
    if (!reserved[6][i]) {
      grid[6][i] = i % 2 === 0 ? 1 : 0;
      reserved[6][i] = 1;
    }
    if (!reserved[i][6]) {
      grid[i][6] = i % 2 === 0 ? 1 : 0;
      reserved[i][6] = 1;
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
  for (let rawCol = size - 1; rawCol >= 1; rawCol -= 2) {
    const col = rawCol <= 6 ? rawCol - 1 : rawCol;
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

  // Format info for ECC Level L (01) + Mask 0 (000) -> 0x77c4 (MSB bit 14 down to LSB bit 0)
  const fmtBits = 0x77c4;
  const fPos1 = [
    [8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8],
    [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8],
  ];
  for (let i = 0; i < 15; i++) {
    const bit = (fmtBits >>> (14 - i)) & 1;
    const [r1, c1] = fPos1[i];
    grid[r1][c1] = bit;
    if (i < 7) grid[size - 1 - i][8] = bit;
    else grid[8][size - 15 + i] = bit;
  }

  return grid;
}

// Start application
void initAuth();


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

