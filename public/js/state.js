/**
 * WebDep State & Utilities Module
 * Shared reactive state, constants, formatters, pagination, client-side cache and dialogs
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

let persistTimer = null;
function persistCacheToSession() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    try {
      // Bound in-memory cache size to prevent unbounded growth in long-running tabs
      if (clientCache.size > 80) {
        const dropCount = clientCache.size - 60;
        let i = 0;
        for (const k of clientCache.keys()) {
          clientCache.delete(k);
          if (++i >= dropCount) break;
        }
      }
      const entries = [];
      for (const [k, v] of clientCache.entries()) {
        if (!k.startsWith('/api/auth/') && !k.includes('/files/content') && !k.startsWith('/api/logs')) {
          entries.push([k, v]);
        }
      }
      sessionStorage.setItem(SESSION_CACHE_KEY, JSON.stringify(entries.slice(-45)));
    } catch (_) {}
  }, 800);
}

function getCacheTtlMs(path) {
  if (path.startsWith('/api/auth/')) return 0; // Always verify live authentication state with server
  if (path.startsWith('/api/logs') || path.includes('/files/content')) return 0; // Live logs / raw file contents
  if (path.startsWith('/api/databases')) return 3500; // Live database status
  if (path.startsWith('/api/overview') || path.startsWith('/api/monitor')) return 3000;
  if (path.startsWith('/api/deployments')) return 4000;
  if (path.startsWith('/api/audit')) return 8000;
  if (path.includes('/commits')) return 45000;
  if (path.includes('/releases') || path.includes('/backups') || path.includes('/env')) return 20000;
  if (path.includes('/caddy') || path.includes('/nginx')) return 60000;
  if (path.startsWith('/api/projects') || path.startsWith('/api/settings') || path.startsWith('/api/users')) return 4000;
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
    if (typeof window.toast === 'function') window.toast(msg, 'success');
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    if (typeof window.toast === 'function') window.toast(msg, 'success');
  }
}
window.copyTextToClipboard = copyTextToClipboard;

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



function setBtnLoading(btn, loading, defaultText, loadingText = 'Saving...') {
  if (!btn) return;
  btn.disabled = loading;
  if (loading) {
    btn.dataset.originalText = defaultText || btn.textContent;
    btn.innerHTML = `<span class="spinner-border spinner-border-sm" role="status" aria-hidden="true" style="width: 12px; height: 12px; border-width: 2px; margin-right: 6px; display: inline-block; vertical-align: middle; border-radius: 50%; border: 2px solid currentColor; border-right-color: transparent; animation: spin 0.75s linear infinite;"></span> ${loadingText}`;
  } else {
    btn.innerHTML = btn.dataset.originalText || defaultText;
  }
}

function getSelectedProject() {
  const list = state.projects || [];
  return list.find((p) => p.id === state.selectedProjectId) || list[0] || null;
}

window.state = state;
window.PAGE_SIZE = PAGE_SIZE;
window.goToTablePage = goToTablePage;
window.hasCachedApi = hasCachedApi;
window.invalidateClientCache = invalidateClientCache;
window.copyTextToClipboard = copyTextToClipboard;
window.openModal = openModal;
window.closeModal = closeModal;
window.showConfirmDialog = showConfirmDialog;
window.showPromptDialog = showPromptDialog;
window.showCopyDialog = showCopyDialog;
window.escapeHtml = escapeHtml;
window.formatDate = formatDate;
window.formatRelativeTime = formatRelativeTime;
window.formatDuration = formatDuration;
window.setHtmlIfChanged = setHtmlIfChanged;
window.setBtnLoading = setBtnLoading;
window.getSelectedProject = getSelectedProject;

export {
  PAGE_SIZE,
  state,
  setHtmlIfChanged,
  paginateAndRender,
  goToTablePage,
  PIPELINE_STAGES,
  PRESETS,
  WEBSITE_WORKSPACE_TABS,
  AUDIT_ACTION_META,
  clientCache,
  inflightGets,
  SESSION_CACHE_KEY,
  persistCacheToSession,
  getCacheTtlMs,
  hasCachedApi,
  invalidateClientCache,
  copyTextToClipboard,
  openModal,
  closeModal,
  getDialogElements,
  prepareDialogModal,
  showConfirmDialog,
  showPromptDialog,
  showCopyDialog,
  escapeHtml,
  formatDate,
  formatRelativeTime,
  formatDuration,
  setBtnLoading,
  getSelectedProject,
};
