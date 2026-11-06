/**
 * Nexus Deploy 2.0 — Frontend Application Controller
 * Single-Page Reactive Client for Self-Hosted Multi-Website Deployment Platform
 */

// ============================================================================
// State Management
// ============================================================================
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
};

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
    health_url: 'http://127.0.0.1:3000/healthz',
  },
  express: {
    port: 3000,
    deploy_method: 'managed',
    install_cmd: 'npm ci',
    build_cmd: '',
    start_cmd: 'node app.js',
    health_url: 'http://127.0.0.1:3000/health',
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
// API Client
// ============================================================================
async function api(path, options = {}) {
  const headers = {
    'Accept': 'application/json',
    ...(options.headers || {}),
  };
  if (state.csrf && options.method && options.method !== 'GET') {
    headers['X-CSRF-Token'] = state.csrf;
  }
  if (options.body && typeof options.body === 'object' && !(options.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(options.body);
  }

  const res = await fetch(path, { credentials: 'same-origin', ...options, headers });
  
  if (res.status === 401 && !path.startsWith('/api/auth/login')) {
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
    onAuthenticated();
  } catch {
    showLogin();
  }
}

function showLogin() {
  document.getElementById('login-view').style.display = 'flex';
  document.getElementById('app').style.display = 'none';
}

function onAuthenticated() {
  document.getElementById('login-view').style.display = 'none';
  document.getElementById('app').style.display = 'flex';

  document.getElementById('current-user-name').textContent = state.user.username;
  document.getElementById('current-user-role').textContent = state.user.role;
  document.getElementById('current-user-avatar').textContent = (state.user.username || 'AD').slice(0, 2).toUpperCase();

  // Load projects & overview
  loadProjects().then(() => {
    handleHashRoute();
    startPolling();
  });
}

// ============================================================================
// Router & Navigation
// ============================================================================
function navigateTo(viewName, projectId = null) {
  state.currentView = viewName;
  if (projectId !== null) {
    state.selectedProjectId = projectId;
    const sel = document.getElementById('global-project-select');
    if (sel) sel.value = String(projectId);
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
  const sectionName = state.currentView.charAt(0).toUpperCase() + state.currentView.slice(1);
  const secEl = document.getElementById('breadcrumb-section');
  const sepEl = document.getElementById('breadcrumb-sep');
  const projEl = document.getElementById('breadcrumb-project');
  
  if (secEl) secEl.textContent = sectionName;
  
  const p = getSelectedProject();
  if (p && sepEl && projEl) {
    sepEl.style.display = 'inline';
    projEl.style.display = 'inline';
    projEl.textContent = p.name;
  } else if (sepEl && projEl) {
    sepEl.style.display = 'none';
    projEl.style.display = 'none';
  }
}

function renderCurrentView() {
  updateBreadcrumbs();

  // Close mobile sidebar if open
  document.querySelector('.sidebar')?.classList.remove('mobile-open');
  document.getElementById('sidebar-backdrop')?.classList.remove('active');

  // Update sidebar active classes
  document.querySelectorAll('.nav-item').forEach((item) => {
    item.classList.toggle('active', item.getAttribute('data-view') === state.currentView);
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
    state.projects = await api('/api/projects');
    document.getElementById('badge-projects-count').textContent = state.projects.length;

    const select = document.getElementById('global-project-select');
    select.innerHTML = '<option value="">All Projects (Global)</option>' +
      state.projects.map((p) => `<option value="${p.id}" ${state.selectedProjectId === p.id ? 'selected' : ''}>${escapeHtml(p.name)} (${p.slug})</option>`).join('');

    if (state.projects.length > 0 && !state.selectedProjectId) {
      state.selectedProjectId = state.projects[0].id;
      select.value = String(state.projects[0].id);
    }
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
    if (active && active.active) {
      actBox.style.display = 'block';
      document.getElementById('active-dep-project-name').textContent = active.project.name;
      document.getElementById('active-dep-kind').textContent = active.active.kind.toUpperCase();
      renderPipelineStages('overview-pipeline-track', active.active.stage, active.active.status);
    } else {
      actBox.style.display = 'none';
    }

    // Websites Table & Recent Deployments with change-detection cache
    const sig = `${data.projects.map((x) => `${x.project.id}:${x.project.updated_at}:${x.app?.running}:${x.behind}:${x.project.deployed_sha}`).join('|')}_${data.recent?.map((x) => `${x.id}:${x.status}:${x.stage}`).join('|')}`;
    if (state.lastOverviewSig !== sig) {
      state.lastOverviewSig = sig;

      // Websites Table
      const tbody = document.getElementById('overview-projects-table');
      if (!data.projects.length) {
        tbody.innerHTML = '<tr><td colspan="7" style="text-align: center; padding: 24px;">No websites created yet. Click "Add Website" to get started.</td></tr>';
      } else {
        tbody.innerHTML = data.projects.map((item) => {
          const p = item.project;
          const isOnline = item.app?.running;
          const domains = p.domains && p.domains.length ? p.domains : [];
          const domainLinks = domains.map((d) => `<a class="domain-badge" href="http://${escapeHtml(d)}" target="_blank">${escapeHtml(d)}</a>`).join(' ') || '<span style="color:var(--text-dim)">Local only</span>';
          const sha = p.deployed_sha ? `<span class="sha-pill">${p.deployed_sha.slice(0, 7)}</span>` : '<span style="color:var(--text-dim)">None</span>';
          
          let behindAhead = '--';
          if (item.behind != null && item.ahead != null) {
            behindAhead = item.behind > 0 ? `<span style="color:var(--warning); font-weight:600;">${item.behind} behind</span>` : '<span style="color:var(--success);">Up to date</span>';
          }

          const lastDep = item.lastSuccess ? `<span style="font-size:12px;">${formatRelativeTime(item.lastSuccess.finished_at || item.lastSuccess.started_at)}</span>` : '<span style="color:var(--text-dim)">Never</span>';

          return `
            <tr>
              <td>
                <strong style="color: var(--text-main); font-size: 14px; cursor: pointer;" onclick="navigateTo('projects', ${p.id})">${escapeHtml(p.name)}</strong>
                <div style="font-size: 11px; color: var(--text-dim);">${escapeHtml(p.slug)} &bull; ${p.project_type}</div>
              </td>
              <td>${domainLinks}</td>
              <td>
                <span class="status-dot ${isOnline ? 'online' : 'offline'}"></span>
                <span style="font-weight: 500; font-size: 12px; margin-left: 6px;">${isOnline ? 'Online' : 'Stopped'}</span>
              </td>
              <td>${sha}</td>
              <td>${behindAhead}</td>
              <td>${lastDep}</td>
              <td>
                <div style="display: flex; gap: 6px;">
                  <button class="btn btn-primary btn-sm" onclick="deployProject(${p.id})">Deploy</button>
                  <button class="btn btn-secondary btn-sm" onclick="openLogsForProject(${p.id})">Logs</button>
                  <button class="btn btn-secondary btn-sm" onclick="navigateTo('projects', ${p.id})">Manage</button>
                </div>
              </td>
            </tr>
          `;
        }).join('');
      }

      // Recent Deployments
      const recBody = document.getElementById('overview-recent-table');
      if (!data.recent || !data.recent.length) {
        recBody.innerHTML = '<tr><td colspan="9" style="text-align: center; padding: 24px;">No recent deployments recorded.</td></tr>';
      } else {
        recBody.innerHTML = data.recent.map((d) => renderDeploymentRow(d)).join('');
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
    const domains = p.domains && p.domains.length ? p.domains : [];
    const domainBadges = domains.map((d) => `<a class="domain-badge" href="http://${escapeHtml(d)}" target="_blank">${escapeHtml(d)} &nearr;</a>`).join(' ') ||
      (p.port ? `<span class="domain-badge">http://127.0.0.1:${p.port}</span>` : '<span style="color:var(--text-dim); font-size:11px;">No domain assigned</span>');

    const sha = p.deployed_sha ? `<span class="sha-pill">${p.deployed_sha.slice(0, 7)}</span>` : '<span style="color:var(--text-dim)">Not deployed</span>';

    return `
      <div class="project-card">
        <div class="project-card-header">
          <div>
            <div class="project-info-title">
              <span class="status-dot ${isOnline ? 'online' : 'offline'}"></span>
              <span>${escapeHtml(p.name)}</span>
            </div>
            <div class="project-info-domains">
              ${domainBadges}
            </div>
          </div>
          <span class="badge ${isOnline ? 'badge-success' : 'badge-neutral'}">${isOnline ? 'Running' : 'Stopped'}</span>
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
            <span>Method: <strong>${p.deploy_method}</strong></span>
          </div>
          ${p.port ? `<div class="project-meta-item"><span>Port: <strong>${p.port}</strong></span></div>` : ''}
        </div>

        <div class="project-card-actions">
          <button class="btn btn-primary btn-sm" onclick="deployProject(${p.id})">Deploy</button>
          <button class="btn btn-secondary btn-sm" onclick="fetchProjectUpdates(${p.id})">Fetch</button>
          ${isOnline
            ? `<button class="btn btn-danger btn-sm" onclick="stopProject(${p.id})">Stop</button>`
            : `<button class="btn btn-success btn-sm" onclick="startProject(${p.id})">Start</button>`
          }
          <button class="btn btn-secondary btn-sm" onclick="restartProject(${p.id})">Restart</button>
          <button class="btn btn-secondary btn-sm" onclick="openLogsForProject(${p.id})">Logs</button>
          <button class="btn btn-secondary btn-sm" onclick="openEditWebsiteModal(${p.id})">Edit</button>
          <button class="btn btn-secondary btn-sm" onclick="openNginxModal(${p.id})" title="Caddy / Auto-SSL">Caddy</button>
          <button class="btn btn-secondary btn-sm" onclick="navigateTo('env', ${p.id})" title="Environment">Env</button>
          <button class="btn btn-danger btn-sm" onclick="deleteProject(${p.id}, '${escapeHtml(p.slug)}')" title="Delete Website">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
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
  document.getElementById('website-deploy-dir').value = p.deploy_dir || '';
  document.getElementById('website-deploy-method').value = p.deploy_method || 'managed';
  document.getElementById('website-health-url').value = p.health_url || '';
  document.getElementById('website-install-cmd').value = p.install_cmd || '';
  document.getElementById('website-build-cmd').value = p.build_cmd || '';
  document.getElementById('website-start-cmd').value = p.start_cmd || '';
  document.getElementById('website-auto-deploy').checked = Boolean(p.auto_deploy);
  document.getElementById('website-auto-backup').checked = Boolean(p.auto_backup);

  const detectBtn = document.getElementById('website-detect-btn');
  if (detectBtn) detectBtn.style.display = 'inline-flex';

  document.querySelectorAll('.preset-chip').forEach((c) => {
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
      document.querySelectorAll('.preset-chip').forEach((c) => {
        c.classList.toggle('active', c.getAttribute('data-type') === res.type);
      });
    }
    toast(`Detected ${res.type} application configuration!`, 'success');
  } catch (err) {
    toast(`Detection failed: ${err.message}`, 'error');
  }
}
window.detectProjectConfiguration = detectProjectConfiguration;

function applyPreset(type) {
  const conf = PRESETS[type] || PRESETS.node;
  document.querySelectorAll('.preset-chip').forEach((c) => {
    c.classList.toggle('active', c.getAttribute('data-type') === type);
  });

  document.getElementById('website-port').value = conf.port || '';
  document.getElementById('website-deploy-method').value = conf.deploy_method || 'managed';
  document.getElementById('website-install-cmd').value = conf.install_cmd || '';
  document.getElementById('website-build-cmd').value = conf.build_cmd || '';
  document.getElementById('website-start-cmd').value = conf.start_cmd || '';
  document.getElementById('website-health-url').value = conf.health_url || '';
}

// Preset chips click
document.querySelectorAll('.preset-chip').forEach((chip) => {
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
    dirInput.value = slug ? `/var/www/${slug}` : '';
  }
});

// Submit Add/Edit Website Form
document.getElementById('save-website-submit-btn')?.addEventListener('click', async (e) => {
  e.preventDefault();
  const form = document.getElementById('website-form');
  if (!form.reportValidity()) return;

  const id = document.getElementById('website-form-id').value;
  const domainsStr = document.getElementById('website-domains').value;
  const domains = domainsStr.split(/[\n,]/).map((s) => s.trim().toLowerCase()).filter(Boolean);

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
    auto_deploy: document.getElementById('website-auto-deploy').checked ? 1 : 0,
    auto_backup: document.getElementById('website-auto-backup').checked ? 1 : 0,
  };

  try {
    if (id) {
      await api(`/api/projects/${id}`, { method: 'PUT', body: payload });
      toast('Website updated successfully', 'success');
    } else {
      const res = await api('/api/projects', { method: 'POST', body: payload });
      toast(`Website "${payload.name}" created!`, 'success');
      state.selectedProjectId = res.project.id;
    }
    closeModal('modal-website');
    await loadProjects();
    renderProjectsList();
  } catch (err) {
    toast(`Save failed: ${err.message}`, 'error');
  }
});

// Delete Project
async function deleteProject(id, slug) {
  const confirmSlug = prompt(`CAUTION: Deleting this website will remove its configuration and stop its running process.\n\nType the project slug "${slug}" to confirm:`);
  if (!confirmSlug) return;
  if (confirmSlug.trim() !== slug) {
    toast('Slug confirmation did not match. Deletion cancelled.', 'warning');
    return;
  }

  try {
    await api(`/api/projects/${id}`, { method: 'DELETE', body: { confirm: slug } });
    toast(`Website "${slug}" deleted.`, 'success');
    if (state.selectedProjectId === id) state.selectedProjectId = null;
    await loadProjects();
    renderProjectsList();
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
  tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; padding: 24px;">Loading commits from mirror...</td></tr>';
  try {
    const commits = await api(`/api/projects/${p.id}/commits`);
    if (!commits.length) {
      tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; padding: 24px;">No commits found. Click "Fetch Updates" above to sync with GitHub.</td></tr>';
      return;
    }
    tbody.innerHTML = commits.map((c) => {
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
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="6" style="text-align: center; color: var(--danger); padding: 24px;">${escapeHtml(err.message)}</td></tr>`;
  }
}

async function generateDeployKey(projectId) {
  try {
    const res = await api(`/api/projects/${projectId}/deploy-key`, { method: 'POST' });
    prompt('Add this Deploy Key to your GitHub repository Settings -> Deploy Keys (allow read access only):', res.publicKey);
  } catch (err) {
    toast(`Failed to generate deploy key: ${err.message}`, 'error');
  }
}
window.generateDeployKey = generateDeployKey;

async function rotateWebhookSecret(projectId) {
  if (!confirm('Rotate the GitHub webhook secret? You will need to update the secret in your GitHub webhook settings.')) return;
  try {
    const res = await api(`/api/projects/${projectId}/webhook-secret/rotate`, { method: 'POST' });
    prompt('New Webhook Secret (paste into GitHub webhook secret field):', res.webhookSecret);
    toast('Webhook secret rotated.', 'success');
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
  try {
    await api(`/api/projects/${projectId}/fetch`, { method: 'POST' });
    toast('Fetch updates queued.', 'info');
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
  const query = p ? `?project=${p.id}&limit=50` : '?limit=50';
  const tbody = document.getElementById('deployments-table-body');

  try {
    const deployments = await api(`/api/deployments${query}`);
    if (!deployments.length) {
      tbody.innerHTML = '<tr><td colspan="9" style="text-align: center; padding: 24px;">No deployments found.</td></tr>';
      return;
    }

    // Check if any deployment is active
    const active = deployments.find((d) => d.status === 'running' || d.status === 'pending');
    state.activeDeployment = active || null;
    const badge = document.getElementById('pipeline-status-badge');
    if (active) {
      badge.textContent = `${active.kind.toUpperCase()} (${active.stage.toUpperCase()})`;
      badge.className = 'badge badge-warning';
      renderPipelineStages('main-pipeline-track', active.stage, active.status);
    } else {
      badge.textContent = 'Idle';
      badge.className = 'badge badge-neutral';
      renderPipelineStages('main-pipeline-track', 'idle', 'idle');
    }

    tbody.innerHTML = deployments.map((d) => renderDeploymentRow(d)).join('');
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="9" style="text-align: center; color: var(--danger); padding: 24px;">${escapeHtml(err.message)}</td></tr>`;
  }
}

function renderPipelineStages(containerId, currentStage, currentStatus) {
  const container = document.getElementById(containerId);
  if (!container) return;

  const currentIndex = PIPELINE_STAGES.findIndex((s) => s.id === currentStage);

  container.innerHTML = PIPELINE_STAGES.map((s, idx) => {
    let cls = '';
    if (currentStatus === 'idle') {
      cls = '';
    } else if (currentStatus === 'failed' && idx === currentIndex) {
      cls = 'failed';
    } else if (idx < currentIndex || currentStatus === 'success') {
      cls = 'completed';
    } else if (idx === currentIndex) {
      cls = 'active';
    }

    return `
      <div class="stage-step ${cls}">
        <div class="stage-circle">${idx + 1}</div>
        <div class="stage-name">${s.label}</div>
        ${idx < PIPELINE_STAGES.length - 1 ? '<div class="stage-line"></div>' : ''}
      </div>
    `;
  }).join('');
}

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
    const releases = await api(`/api/projects/${p.id}/releases`);
    if (!releases.length) {
      tbody.innerHTML = '<tr><td colspan="9" style="text-align: center; padding: 24px;">No releases created yet.</td></tr>';
      return;
    }

    tbody.innerHTML = releases.map((r) => {
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
            </div>
          </td>
        </tr>
      `;
    }).join('');
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="9" style="text-align: center; color: var(--danger); padding: 24px;">${escapeHtml(err.message)}</td></tr>`;
  }
}

// ============================================================================
// View 6: Instant Rollback Cockpit
// ============================================================================
async function loadRollbacksView() {
  const p = getSelectedProject();
  if (!p) return;

  const liveInfo = document.getElementById('rollback-live-info');
  const tbody = document.getElementById('rollbacks-table-body');

  try {
    const releases = await api(`/api/projects/${p.id}/releases`);
    const live = releases.find((r) => r.live);

    if (live) {
      liveInfo.innerHTML = `Release #${live.id} &bull; Commit <span class="sha-pill">${live.sha.slice(0, 7)}</span> &bull; <em>"${escapeHtml(live.message || 'No commit message')}"</em> &bull; Deployed ${formatRelativeTime(live.deployed_at || live.created_at)}`;
    } else {
      liveInfo.textContent = 'No live release active currently.';
    }

    const eligible = releases.filter((r) => !r.live && r.status === 'succeeded' && r.available);

    if (!eligible.length) {
      tbody.innerHTML = '<tr><td colspan="7" style="text-align: center; padding: 24px;">No earlier successful releases available for rollback yet. Releases are retained automatically.</td></tr>';
      return;
    }

    tbody.innerHTML = eligible.map((r) => `
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
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="7" style="text-align: center; color: var(--danger); padding: 24px;">${escapeHtml(err.message)}</td></tr>`;
  }
}

async function rollbackToRelease(projectId, releaseId) {
  if (!confirm(`Are you sure you want to rollback to Release #${releaseId}?\n\nThe platform will atomically switch the symlink to this release, preserve your environment variables, and perform immediate health checks.`)) return;

  try {
    const res = await api(`/api/projects/${projectId}/rollback`, { method: 'POST', body: { releaseId } });
    toast(`Rollback #${res.deploymentId} initiated!`, 'info');
    navigateTo('deployments', projectId);
  } catch (err) {
    toast(`Rollback failed: ${err.message}`, 'error');
  }
}
window.rollbackToRelease = rollbackToRelease;

// ============================================================================
// View 7: Real-Time Live Logs
// ============================================================================
function loadLogsView() {
  const terminal = document.getElementById('log-terminal-output');
  if (!state.logEventSource) {
    startLogStream();
  }
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
        state.logLines.push(...data);
        if (state.logLines.length > 2000) state.logLines.splice(0, state.logLines.length - 2000);
        appendTerminalLogs(data);
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
    if (q && !l.message.toLowerCase().includes(q)) return false;
    return true;
  });

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
  document.getElementById(id)?.addEventListener('input', renderTerminalLogs);
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
  navigateTo('logs', projectId);
  startLogStream();
}
window.openLogsForProject = openLogsForProject;

// ============================================================================
// View 8: Environment Variables
// ============================================================================
async function loadEnvView() {
  const p = getSelectedProject();
  const tbody = document.getElementById('env-vars-table-body');
  if (!p) return;

  try {
    const vars = await api(`/api/projects/${p.id}/env`);
    if (!vars.length) {
      tbody.innerHTML = '<tr><td colspan="5" style="text-align: center; padding: 24px;">No environment variables configured. Click "Add Variable" to set secrets or config.</td></tr>';
      return;
    }

    tbody.innerHTML = vars.map((v) => `
      <tr>
        <td><code>${escapeHtml(v.key)}</code></td>
        <td id="env-val-${v.key}">
          <span style="font-family: var(--font-mono); color: var(--text-dim);">&bull;&bull;&bull;&bull;&bull;&bull;&bull;&bull;&bull;&bull;</span>
        </td>
        <td>${v.secret ? '<span class="badge badge-warning">Secret</span>' : '<span class="badge badge-neutral">Public</span>'}</td>
        <td>${formatDate(v.updated_at)}</td>
        <td>
          <div style="display: flex; gap: 6px;">
            <button class="btn btn-secondary btn-sm" onclick="promptRevealEnv('${escapeHtml(v.key)}')">Reveal</button>
            <button class="btn btn-danger btn-sm" onclick="deleteEnvVar('${escapeHtml(v.key)}')">Delete</button>
          </div>
        </td>
      </tr>
    `).join('');
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="5" style="text-align: center; color: var(--danger); padding: 24px;">${escapeHtml(err.message)}</td></tr>`;
  }
}

document.getElementById('add-env-btn')?.addEventListener('click', () => {
  document.getElementById('add-env-form').reset();
  openModal('modal-env');
});

document.getElementById('save-env-btn')?.addEventListener('click', async (e) => {
  e.preventDefault();
  const p = getSelectedProject();
  if (!p) return;

  const key = document.getElementById('env-key-input').value.trim();
  const value = document.getElementById('env-value-input').value;
  const secret = document.getElementById('env-secret-checkbox').checked;

  if (!key) return;

  try {
    await api(`/api/projects/${p.id}/env`, { method: 'PUT', body: { key, value, secret } });
    toast(`Variable "${key}" saved. Restart application for it to take effect.`, 'success');
    closeModal('modal-env');
    loadEnvView();
  } catch (err) {
    toast(`Save failed: ${err.message}`, 'error');
  }
});

async function deleteEnvVar(key) {
  const p = getSelectedProject();
  if (!p || !confirm(`Delete environment variable "${key}"?`)) return;

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

document.getElementById('env-restart-app-btn')?.addEventListener('click', () => {
  const p = getSelectedProject();
  if (p) restartProject(p.id);
});

// ============================================================================
// View 9: Application Backups
// ============================================================================
async function loadBackupsView() {
  const p = getSelectedProject();
  const tbody = document.getElementById('backups-table-body');
  if (!p) return;

  try {
    const backups = await api(`/api/projects/${p.id}/backups`);
    if (!backups.length) {
      tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; padding: 24px;">No backups taken yet. Automatic backups occur before deployments.</td></tr>';
      return;
    }

    tbody.innerHTML = backups.map((b) => `
      <tr>
        <td><strong>#${b.id}</strong></td>
        <td>${formatDate(b.ts)}</td>
        <td><span class="badge badge-neutral">${b.kind}</span></td>
        <td>${(b.size / 1048576).toFixed(2)} MB</td>
        <td>${escapeHtml(b.note || 'None')}</td>
        <td>
          <button class="btn btn-primary btn-sm" onclick="restoreBackup(${p.id}, ${b.id})">Restore</button>
        </td>
      </tr>
    `).join('');
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="6" style="text-align: center; color: var(--danger); padding: 24px;">${escapeHtml(err.message)}</td></tr>`;
  }
}

document.getElementById('create-backup-btn')?.addEventListener('click', async () => {
  const p = getSelectedProject();
  if (!p) return;
  const note = prompt('Optional backup note:');
  if (note === null) return;

  try {
    await api(`/api/projects/${p.id}/backup`, { method: 'POST', body: { note } });
    toast('Backup job enqueued.', 'info');
    loadBackupsView();
  } catch (err) {
    toast(`Backup failed: ${err.message}`, 'error');
  }
});

async function restoreBackup(projectId, backupId) {
  if (!confirm(`Restore from backup #${backupId}?\nThis will restore application state and restart the service.`)) return;

  try {
    await api(`/api/projects/${projectId}/backups/restore`, { method: 'POST', body: { backupId } });
    toast('Restore operation enqueued.', 'info');
  } catch (err) {
    toast(`Restore failed: ${err.message}`, 'error');
  }
}
window.restoreBackup = restoreBackup;

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

    // Projects table
    const tbody = document.getElementById('monitor-projects-table');
    tbody.innerHTML = (data.projects || []).map((p) => `
      <tr>
        <td><strong>${escapeHtml(p.name)}</strong></td>
        <td>
          <span class="status-dot ${p.status?.running ? 'online' : 'offline'}"></span>
          <span style="font-size:12px; font-weight:600; margin-left:6px;">${p.status?.running ? 'Running' : 'Stopped'}</span>
        </td>
        <td>${p.status?.uptimeMs ? formatDuration(p.status.uptimeMs / 1000) : '--'}</td>
        <td>${p.deployedSha ? `<span class="sha-pill">${p.deployedSha.slice(0, 7)}</span>` : '--'}</td>
        <td>${p.disk ? `${(p.disk.used / 1048576).toFixed(1)} MB` : '--'}</td>
        <td><span class="badge ${p.deployStatus?.status === 'success' ? 'badge-success' : 'badge-neutral'}">${p.deployStatus?.status || 'idle'}</span></td>
      </tr>
    `).join('');
  } catch (err) {
    console.error('Monitor view error:', err);
  }
}

// ============================================================================
// View 11: Settings
// ============================================================================
async function loadSettingsView() {
  try {
    const s = await api('/api/settings');
    document.getElementById('setting-min-free-mb').value = s.min_free_mb || 500;
    document.getElementById('setting-default-retention').value = s.default_retention || 10;
    document.getElementById('setting-step-timeout').value = s.step_timeout_s || 900;
    document.getElementById('setting-deploy-timeout').value = s.deploy_timeout_s || 1800;

    // Users list
    if (state.user.role === 'admin') {
      const users = await api('/api/users');
      const tbody = document.getElementById('users-table-body');
      tbody.innerHTML = users.map((u) => `
        <tr>
          <td><strong>${escapeHtml(u.username)}</strong></td>
          <td><span class="badge badge-neutral">${u.role}</span></td>
          <td>${u.disabled ? '<span class="badge badge-danger">Disabled</span>' : '<span class="badge badge-success">Active</span>'}</td>
          <td>
            ${u.id !== state.user.id ? `
              <button class="btn btn-secondary btn-sm" onclick="toggleUserDisabled(${u.id}, ${u.disabled ? 0 : 1})">
                ${u.disabled ? 'Enable' : 'Disable'}
              </button>
            ` : '<span style="color:var(--text-dim)">You</span>'}
          </td>
        </tr>
      `).join('');
    }
  } catch (err) {
    toast(`Failed to load settings: ${err.message}`, 'error');
  }
}

document.getElementById('settings-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const payload = {
    min_free_mb: Number(document.getElementById('setting-min-free-mb').value),
    default_retention: Number(document.getElementById('setting-default-retention').value),
    step_timeout_s: Number(document.getElementById('setting-step-timeout').value),
    deploy_timeout_s: Number(document.getElementById('setting-deploy-timeout').value),
  };
  const token = document.getElementById('setting-github-token').value.trim();
  if (token) payload.github_token = token;

  try {
    await api('/api/settings', { method: 'PUT', body: payload });
    toast('Settings saved successfully.', 'success');
  } catch (err) {
    toast(`Save failed: ${err.message}`, 'error');
  }
});

document.getElementById('create-user-modal-btn')?.addEventListener('click', () => {
  document.getElementById('create-user-form').reset();
  openModal('modal-create-user');
});

document.getElementById('save-new-user-btn')?.addEventListener('click', async (e) => {
  e.preventDefault();
  const username = document.getElementById('user-new-username').value.trim();
  const password = document.getElementById('user-new-password').value;
  const role = document.getElementById('user-new-role').value;

  if (!username || password.length < 10) {
    toast('Username required and password must be >= 10 chars.', 'warning');
    return;
  }

  try {
    await api('/api/users', { method: 'POST', body: { username, password, role } });
    toast(`User "${username}" created.`, 'success');
    closeModal('modal-create-user');
    loadSettingsView();
  } catch (err) {
    toast(`Failed to create user: ${err.message}`, 'error');
  }
});

async function toggleUserDisabled(userId, disabled) {
  try {
    await api(`/api/users/${userId}`, { method: 'PUT', body: { disabled } });
    toast('User status updated.', 'success');
    loadSettingsView();
  } catch (err) {
    toast(`Update failed: ${err.message}`, 'error');
  }
}
window.toggleUserDisabled = toggleUserDisabled;

// ============================================================================
// View 12: Activity & Audit Logs
// ============================================================================
async function loadAuditView() {
  const tbody = document.getElementById('audit-table-body');
  try {
    const logs = await api('/api/audit?limit=150');
    if (!logs.length) {
      tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; padding: 24px;">No audit records found.</td></tr>';
      return;
    }

    const q = (document.getElementById('audit-search-input')?.value || '').toLowerCase();
    const filtered = logs.filter((l) => {
      return !q || (l.action && l.action.toLowerCase().includes(q)) ||
        (l.actor && l.actor.toLowerCase().includes(q)) ||
        (l.target && l.target.toLowerCase().includes(q));
    });

    tbody.innerHTML = filtered.map((l) => `
      <tr>
        <td>${formatDate(l.ts)}</td>
        <td><strong>${escapeHtml(l.actor)}</strong></td>
        <td><code>${escapeHtml(l.action)}</code></td>
        <td>${escapeHtml(l.target || '--')}</td>
        <td style="max-width: 280px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHtml(l.detail || '')}</td>
        <td><span style="font-size:11px; color:var(--text-dim);">${escapeHtml(l.ip || '--')}</span></td>
      </tr>
    `).join('');
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="6" style="text-align: center; color: var(--danger); padding: 24px;">${escapeHtml(err.message)}</td></tr>`;
  }
}
document.getElementById('audit-search-input')?.addEventListener('input', loadAuditView);

// ============================================================================
// Caddy & Reverse Proxy Modal
// ============================================================================
let activeNginxProjectId = null;

async function openNginxModal(projectId) {
  activeNginxProjectId = projectId;
  const p = state.projects.find((x) => x.id === projectId);
  if (!p) return;

  const preview = document.getElementById('nginx-config-preview');
  const banner = document.getElementById('nginx-modal-status-banner');
  preview.value = 'Generating Caddyfile configuration...';
  openModal('modal-nginx');

  try {
    const data = await api(`/api/projects/${projectId}/caddy`);
    preview.value = data.config;

    const domains = p.domains && p.domains.length ? p.domains : ['Local only'];
    banner.innerHTML = `
      <div style="background: var(--bg-card); padding: 12px; border-radius: var(--radius-md); font-size: 13px; border: 1px solid var(--border-subtle);">
        <div><strong>Reverse Proxy:</strong> <span class="badge badge-success">Caddy</span> &bull; <code>Port ${p.port || 3000}</code></div>
        <div style="margin-top: 4px;"><strong>Domains:</strong> ${domains.join(', ')}</div>
        <div style="margin-top: 4px;"><strong>Automatic HTTPS:</strong> <span class="badge badge-success">Let's Encrypt / ZeroSSL (Active)</span></div>
      </div>
    `;
  } catch (err) {
    preview.value = `Failed to generate configuration: ${err.message}`;
  }
}
window.openNginxModal = openNginxModal;

document.getElementById('nginx-apply-btn')?.addEventListener('click', async () => {
  if (!activeNginxProjectId) return;
  try {
    await api(`/api/projects/${activeNginxProjectId}/caddy/apply`, { method: 'POST' });
    toast('Caddy configuration written and reloaded!', 'success');
    closeModal('modal-nginx');
  } catch (err) {
    toast(`Caddy apply: ${err.message}`, 'error');
  }
});

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
    await api(`/api/projects/${projectId}/start`, { method: 'POST' });
    toast('Process started.', 'success');
    await loadProjects();
    if (state.currentView === 'projects') renderProjectsList();
    if (state.currentView === 'overview') loadOverview();
  } catch (err) {
    toast(`Start failed: ${err.message}`, 'error');
  }
}
window.startProject = startProject;

async function stopProject(projectId) {
  if (!confirm('Stop this application process?')) return;
  try {
    await api(`/api/projects/${projectId}/stop`, { method: 'POST' });
    toast('Process stopped.', 'info');
    await loadProjects();
    if (state.currentView === 'projects') renderProjectsList();
    if (state.currentView === 'overview') loadOverview();
  } catch (err) {
    toast(`Stop failed: ${err.message}`, 'error');
  }
}
window.stopProject = stopProject;

async function restartProject(projectId) {
  try {
    await api(`/api/projects/${projectId}/restart`, { method: 'POST' });
    toast('Restart initiated.', 'info');
    await loadProjects();
    if (state.currentView === 'projects') renderProjectsList();
  } catch (err) {
    toast(`Restart failed: ${err.message}`, 'error');
  }
}
window.restartProject = restartProject;

// ============================================================================
// Global Polling & Live Updates
// ============================================================================
function startPolling() {
  if (state.overviewTimer) clearInterval(state.overviewTimer);

  state.overviewTimer = setInterval(async () => {
    if (state.currentView === 'overview') {
      loadOverview();
    } else if (state.currentView === 'deployments') {
      loadDeploymentsView();
    } else if (state.currentView === 'monitor') {
      loadMonitorView();
    }
  }, 4000);
}

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

// Login Form
document.getElementById('login-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = document.getElementById('login-username').value.trim();
  const password = document.getElementById('login-password').value;
  const btn = document.getElementById('login-btn');

  btn.disabled = true;
  btn.textContent = 'Signing in...';

  try {
    const res = await api('/api/auth/login', { method: 'POST', body: { username, password } });
    state.user = res.user;
    state.csrf = res.csrf;
    onAuthenticated();
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Sign In';
  }
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

function closeModal(modalId) {
  document.getElementById(modalId)?.classList.remove('active');
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

// Change Password modal bindings
document.getElementById('user-profile-snippet')?.addEventListener('click', () => {
  document.getElementById('change-password-form')?.reset();
  openModal('modal-change-password');
});

document.getElementById('save-change-password-btn')?.addEventListener('click', async (e) => {
  e.preventDefault();
  const current = document.getElementById('pwd-current').value;
  const next = document.getElementById('pwd-next').value;
  const confirm = document.getElementById('pwd-confirm').value;

  if (next !== confirm) {
    toast('New passwords do not match.', 'warning');
    return;
  }
  if (next.length < 10) {
    toast('New password must be at least 10 characters.', 'warning');
    return;
  }

  try {
    await api('/api/auth/password', { method: 'POST', body: { current, next } });
    toast('Password changed successfully.', 'success');
    closeModal('modal-change-password');
  } catch (err) {
    toast(`Failed to change password: ${err.message}`, 'error');
  }
});

// Start application
initAuth();

