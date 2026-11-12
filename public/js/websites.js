/**
 * WebDep Websites / Projects Management Subsystem
 * Hosted websites list, configuration detector, port allocator, and website modal workflows
 */

import { icon } from './icons.js';
import {
  state,
  getSelectedProject,
  PAGE_SIZE,
  paginateAndRender,
  setHtmlIfChanged,
  escapeHtml,
  formatRelativeTime,
  openModal,
  closeModal,
  showConfirmDialog,
  showPromptDialog,
  invalidateClientCache,
  WEBSITE_WORKSPACE_TABS,
  PRESETS,
} from './state.js';
import { api, toast, prefetchWebsiteWorkspace } from './api.js';
import { cleanDomainList } from './settings.js';
import { toggleDatabaseAccessIpFields } from './databases_modal.js';
import { renderWebsiteWorkspaceHeader, navigateTo, openWebsiteWorkspace } from './workspace.js';
import { renderServicesList } from './services.js';
import { startProject, stopProject, restartProject } from './workspace_actions.js';
import { deployProject } from './deployments.js';

// ============================================================================
// Projects Management
// ============================================================================
async function loadProjects(force = false) {
  try {
    state.projects = await api('/api/projects', force ? { noCache: true } : {});
    const websites = (state.projects || []).filter((p) => p.project_kind !== 'service');
    const services = (state.projects || []).filter((p) => p.project_kind === 'service');

    const badgeEl = document.getElementById('badge-projects-count');
    if (badgeEl) badgeEl.textContent = websites.length;

    const badgeServicesEl = document.getElementById('badge-services-count');
    if (badgeServicesEl) badgeServicesEl.textContent = services.length;

    if (state.projects.length > 0 && !state.selectedProjectId) {
      state.selectedProjectId = state.projects[0].id;
    }
    if (typeof renderWebsiteWorkspaceHeader === 'function') {
      renderWebsiteWorkspaceHeader();
    }
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
    const resItem = (state.overview?.resources || []).find((x) => (x.projectId === p.id || x.project_id === p.id));
    const isOnline = p.app_status === 'running' || p.status?.running || resItem?.status === 'running';
    if (state.projectStatusFilter === 'running' && !isOnline) return false;
    if (state.projectStatusFilter === 'stopped' && isOnline) return false;
    return p.name.toLowerCase().includes(search) ||
      p.slug.toLowerCase().includes(search) ||
      (p.domains && p.domains.some((d) => d.toLowerCase().includes(search)));
  });

  if (!filtered.length) {
    setHtmlIfChanged(container, `
      <div style="grid-column: 1 / -1; text-align: center; padding: 48px; background: var(--bg-card); border-radius: var(--radius-lg); border: 1px dashed var(--border-medium);">
        <p style="font-size: 16px; font-weight: 600; margin-bottom: 8px;">No hosted websites found</p>
        <p style="color: var(--text-muted); font-size: 13px; margin-bottom: 20px;">Add your first website to deploy it directly to your VM.</p>
        <button class="btn btn-primary" onclick="openAddWebsiteModal()">Add New Website</button>
      </div>
    `);
    return;
  }

  setHtmlIfChanged(container, filtered.map((p) => {
    const resItem = (state.overview?.resources || []).find((x) => (x.projectId === p.id || x.project_id === p.id));
    const isOnline = p.app_status === 'running' || p.status?.running || resItem?.status === 'running';
    const isMaintenance = p.app_status === 'maintenance' || resItem?.status === 'maintenance';

    const shaText = p.deployed_sha ? p.deployed_sha.slice(0, 7).toUpperCase() : (p.deployedSha ? p.deployedSha.slice(0, 7).toUpperCase() : '');
    const branchText = (p.branch || 'main').toUpperCase();

    const diskStr = resItem?.diskFormatted || resItem?.disk_formatted;
    const pidVal = (isOnline && (p.app_pid || p.status?.pid || resItem?.pid)) ? (p.app_pid || p.status?.pid || resItem?.pid) : null;

    let accessBadge = `<span class="badge badge-neutral" style="font-size: 10px;">${icon('lock', { size: 10 })} Localhost</span>`;
    if (p.access_mode === 'allowlist') {
      const ipList = p.allowed_ips ? p.allowed_ips.split(/[,;\n]/).filter(Boolean).length : 0;
      accessBadge = `<span class="badge badge-primary" style="font-size: 10px;">${icon('shield', { size: 10 })} Allowlist (${ipList})</span>`;
    } else if (p.access_mode === 'public') {
      accessBadge = `<span class="badge badge-warning" style="font-size: 10px;">${icon('globe', { size: 10 })} Public</span>`;
    }

    const pt = (p.project_type || '').toLowerCase();
    const sc = (p.start_cmd || '').toLowerCase();
    let typeIconName = 'globe';
    let typeName = 'Website Application';
    let iconColor = 'var(--accent-light)';

    if (pt.includes('node') || pt.includes('express') || sc.includes('node') || sc.includes('npm') || sc.includes('yarn') || sc.includes('pnpm') || sc.includes('bun')) {
      typeIconName = 'nodejs';
      typeName = 'Node.js App';
      iconColor = '#22c55e';
    } else if (pt.includes('next')) {
      typeIconName = 'typescript';
      typeName = 'Next.js App';
      iconColor = '#3b82f6';
    } else if (pt.includes('react') || pt.includes('typescript')) {
      typeIconName = 'typescript';
      typeName = 'React / TS App';
      iconColor = '#3b82f6';
    } else if (pt.includes('python') || sc.includes('python') || sc.includes('.py')) {
      typeIconName = 'python';
      typeName = 'Python Web';
      iconColor = '#38bdf8';
    } else if (pt.includes('go') || sc.includes('go run') || sc.includes('.go')) {
      typeIconName = 'go';
      typeName = 'Go Web App';
      iconColor = '#00add8';
    } else if (pt.includes('rust') || sc.includes('cargo') || sc.includes('.rs')) {
      typeIconName = 'rust';
      typeName = 'Rust Web App';
      iconColor = '#dea584';
    } else if (pt.includes('php') || sc.includes('php')) {
      typeIconName = 'php';
      typeName = 'PHP Site';
      iconColor = '#777bb4';
    } else if (pt.includes('ruby') || sc.includes('ruby') || sc.includes('rails')) {
      typeIconName = 'ruby';
      typeName = 'Ruby Web App';
      iconColor = '#cc342d';
    } else if (pt.includes('docker') || sc.includes('docker')) {
      typeIconName = 'docker';
      typeName = 'Docker Container';
      iconColor = '#2496ed';
    } else if (p.project_type) {
      typeName = p.project_type;
    }

    let subTitle = typeName;
    if (p.slug && p.slug !== p.name.toLowerCase()) {
      subTitle = `${typeName} &bull; ${escapeHtml(p.slug)}`;
    } else if (p.branch) {
      subTitle = `${typeName} &bull; ${escapeHtml(p.branch)}`;
    }

    return `
      <div class="project-card website-card" id="project-card-${p.id}" style="cursor: pointer;" onclick="openWebsiteWorkspace(${p.id}, 'deployments')">
        <!-- Header -->
        <div class="project-card-header" style="min-height: 40px; display: flex; justify-content: space-between; align-items: center;">
          <div style="display: flex; align-items: center; gap: 11px; min-width: 0;">
            <div class="project-card-icon" style="color: ${iconColor};">
              ${icon(typeIconName, { size: 28 })}
            </div>
            <div style="min-width: 0;">
              <div class="project-info-title" style="font-size: 15px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">
                <span class="status-dot ${isOnline ? 'online' : isMaintenance ? 'maintenance' : 'offline'}"></span>
                <span>${escapeHtml(p.name)}</span>
              </div>
              <div style="font-size: 11.5px; color: var(--text-muted); font-family: var(--font-mono); margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 240px;" title="${escapeHtml(subTitle)}">
                ${subTitle}
              </div>
            </div>
          </div>
          <span class="badge ${isOnline ? 'badge-success' : isMaintenance ? 'badge-warning' : 'badge-danger'}" style="flex-shrink: 0; font-size: 10.5px; font-weight: 600; padding: 2px 8px;">
            ${isOnline ? 'ONLINE' : isMaintenance ? 'MAINTENANCE' : 'OFFLINE'}
          </span>
        </div>

        <!-- Command Line -->
        <div style="background: var(--bg-alt); padding: 7px 12px; border-radius: var(--radius-sm); border: 1px solid var(--border-subtle); font-size: 11.5px; font-family: var(--font-mono); margin: 2px 0 0 0; display: flex; justify-content: space-between; align-items: center; overflow: hidden; height: 34px; box-sizing: border-box;">
          <span style="color: var(--text-dim); text-overflow: ellipsis; white-space: nowrap; overflow: hidden; max-width: 78%;" title="${escapeHtml(p.start_cmd || 'npm start')}">
            $ ${escapeHtml(p.start_cmd || 'npm start')}
          </span>
          ${pidVal ? `<span class="badge badge-neutral" style="font-size: 9.5px; padding: 1px 6px; flex-shrink: 0;">PID ${pidVal}</span>` : ''}
        </div>

        <!-- Badges & Telemetry Row -->
        <div style="display: flex; align-items: center; flex-wrap: wrap; gap: 6px; min-height: 24px;">
          <span class="badge badge-neutral" style="font-size: 10px; padding: 2px 7px; font-family: var(--font-mono);">
            ${icon('git-branch', { size: 10 })} ${escapeHtml(branchText)}${shaText ? ' &bull; ' + escapeHtml(shaText) : ''}
          </span>
          ${p.port ? `<span class="badge badge-neutral" style="font-size: 10px; padding: 2px 7px; font-family: var(--font-mono);">PORT ${p.port}</span>` : ''}
          ${accessBadge}
          ${diskStr ? `<span class="badge badge-neutral" style="font-size: 10px; padding: 2px 7px; font-family: var(--font-mono);" title="On-Disk Storage">${icon('hard-drive', { size: 10 })} ${diskStr}</span>` : ''}
          ${p.app_started_at && isOnline ? `<span class="badge badge-neutral" style="font-size: 10px; font-family: var(--font-mono);">${icon('clock', { size: 10 })} Started ${formatRelativeTime(p.app_started_at)}</span>` : ''}
        </div>

        <!-- Actions Footer -->
        <div class="project-card-actions" onclick="event.stopPropagation()" style="display: flex; justify-content: space-between; align-items: center; width: 100%; margin-top: 2px;">
          <div style="display: flex; gap: 6px; align-items: center; flex-wrap: wrap;">
            ${isOnline
              ? `<button class="btn btn-danger btn-sm" onclick="stopProject(${p.id})" style="padding: 4px 10px; font-size: 11.5px;">Stop</button>`
              : `<button class="btn btn-success btn-sm" onclick="startProject(${p.id})" style="padding: 4px 10px; font-size: 11.5px;">Start</button>`
            }
            <button class="btn btn-secondary btn-sm" onclick="openWebsiteWorkspace(${p.id}, 'files')" style="padding: 4px 10px; font-size: 11.5px;" title="Manage files">Files</button>
            <button class="btn btn-secondary btn-sm" onclick="openWebsiteWorkspace(${p.id}, 'logs')" style="padding: 4px 10px; font-size: 11.5px;" title="Live console logs">Logs</button>
            <button class="btn btn-secondary btn-sm" onclick="openEditWebsiteModal(${p.id})" style="padding: 4px 8px; font-size: 11.5px; display: inline-flex; align-items: center; justify-content: center;" title="Website Settings">
              ${icon('settings', { size: 12 })}
            </button>
          </div>
          <button class="btn btn-primary btn-sm" onclick="openWebsiteWorkspace(${p.id}, 'deployments')" style="padding: 4px 14px; font-size: 11.5px; font-weight: 500; white-space: nowrap; flex-shrink: 0;">
            Manage &rarr;
          </button>
        </div>
      </div>
    `;
  }).join(''));
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
  if (form) form.reset();
  const branchInput = document.getElementById('website-branch');
  if (branchInput) {
    branchInput.value = 'main';
    branchInput.dataset.touched = '';
  }
  const idInput = document.getElementById('website-form-id');
  if (idInput) idInput.value = '';
  const titleEl = document.getElementById('modal-website-title');
  if (titleEl) titleEl.textContent = 'Add New Website';
  const submitBtn = document.getElementById('save-website-submit-btn');
  if (submitBtn) submitBtn.textContent = 'Create Website';
  const slugInput = document.getElementById('website-slug');
  if (slugInput) {
    slugInput.value = '';
    slugInput.readOnly = false;
  }
  const detectBtn = document.getElementById('website-detect-btn');
  if (detectBtn) detectBtn.style.display = 'none';

  const accessInput = document.getElementById('website-access-mode');
  if (accessInput) accessInput.value = 'local';
  const ipsInput = document.getElementById('website-allowed-ips');
  if (ipsInput) ipsInput.value = '';
  if (typeof toggleDatabaseAccessIpFields === 'function') {
    toggleDatabaseAccessIpFields('website-access-mode', 'website-allowed-ips-wrap');
  } else if (window.toggleDatabaseAccessIpFields) {
    window.toggleDatabaseAccessIpFields('website-access-mode', 'website-allowed-ips-wrap');
  }

  // Apply default preset (node)
  applyPreset('node');

  const portInput = document.getElementById('website-port');
  if (portInput) portInput.value = getNextAvailablePort(3000);

  openModal('modal-website');
}
window.openAddWebsiteModal = openAddWebsiteModal;

async function openEditWebsiteModal(projectId) {
  const p = state.projects.find((x) => x.id === projectId);
  if (!p) return;

  const form = document.getElementById('website-form');
  if (form) form.reset();
  document.getElementById('website-form-id').value = String(p.id);
  document.getElementById('modal-website-title').textContent = `Edit Website: ${p.name}`;
  document.getElementById('save-website-submit-btn').textContent = 'Update Website';

  document.getElementById('website-name').value = p.name || '';
  document.getElementById('website-slug').value = p.slug || '';
  document.getElementById('website-slug').readOnly = true;
  document.getElementById('website-repo').value = p.repo_url || '';
  document.getElementById('website-branch').value = p.branch || 'main';
  document.getElementById('website-domains').value = (p.domains || []).join(', ');
  document.getElementById('website-port').value = p.port || getNextAvailablePort(3000);
  const accessInput = document.getElementById('website-access-mode');
  if (accessInput) accessInput.value = p.access_mode || 'local';
  const ipsInput = document.getElementById('website-allowed-ips');
  if (ipsInput) ipsInput.value = p.allowed_ips || '';
  if (typeof toggleDatabaseAccessIpFields === 'function') {
    toggleDatabaseAccessIpFields('website-access-mode', 'website-allowed-ips-wrap');
  } else if (window.toggleDatabaseAccessIpFields) {
    window.toggleDatabaseAccessIpFields('website-access-mode', 'website-allowed-ips-wrap');
  }

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

  const id = document.getElementById('website-form-id')?.value;
  const name = document.getElementById('website-name')?.value.trim() || '';
  if (!name) {
    toast('Please enter a Website Name', 'warning');
    document.getElementById('website-name')?.focus();
    return;
  }

  let slug = document.getElementById('website-slug')?.value.trim();
  if (!slug) {
    slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'site-' + Date.now();
  }

  let deployDir = document.getElementById('website-deploy-dir')?.value.trim();
  if (!deployDir) {
    deployDir = `./data/sites/${slug}`;
  }

  let repoUrl = document.getElementById('website-repo')?.value.trim() || '';
  if (!repoUrl) {
    repoUrl = 'local';
  }

  const portInput = document.getElementById('website-port');
  let port = portInput?.value ? Number(portInput.value) : Number.NaN;
  if (!port || Number.isNaN(port) || port < 1 || port > 65535) {
    port = getNextAvailablePort(3000);
    if (portInput) portInput.value = port;
  }

  const startInput = document.getElementById('website-start-cmd');
  let startCmd = startInput?.value.trim() || '';
  if (!startCmd) {
    startCmd = 'node server.js';
    if (startInput) startInput.value = startCmd;
  }

  const domainsStr = document.getElementById('website-domains')?.value || '';
  const domains = cleanDomainList(domainsStr);
  const accessMode = document.getElementById('website-access-mode')?.value || 'local';
  const allowedIps = document.getElementById('website-allowed-ips')?.value.trim() || '';

  const payload = {
    name,
    slug,
    repo_url: repoUrl,
    branch: document.getElementById('website-branch')?.value.trim() || 'main',
    domains,
    port,
    access_mode: accessMode,
    allowed_ips: allowedIps,
    deploy_dir: deployDir,
    deploy_method: document.getElementById('website-deploy-method')?.value || 'managed',
    health_url: document.getElementById('website-health-url')?.value.trim() || '',
    install_cmd: document.getElementById('website-install-cmd')?.value.trim() || '',
    build_cmd: document.getElementById('website-build-cmd')?.value.trim() || '',
    start_cmd: startCmd,
    auto_deploy: Boolean(document.getElementById('website-auto-deploy')?.checked),
    auto_backup: Boolean(document.getElementById('website-auto-backup')?.checked),
  };

  const submitBtn = document.getElementById('save-website-submit-btn');
  const oldText = submitBtn ? submitBtn.textContent : '';
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.innerHTML = '<span class="btn-spinner"></span> Saving...';
  }

  try {
    if (id) {
      await api(`/api/projects/${id}`, { method: 'PUT', body: payload });
      toast('Website updated successfully', 'success');
    } else {
      const res = await api('/api/projects', { method: 'POST', body: payload });
      toast(`Website "${payload.name}" created successfully!`, 'success');
      state.selectedProjectId = res.project ? res.project.id : res.id;
    }
    closeModal('modal-website');
    await loadProjects();
    renderProjectsList();
    if (typeof WEBSITE_WORKSPACE_TABS !== 'undefined' && WEBSITE_WORKSPACE_TABS.has(state.currentView)) {
      if (typeof renderWebsiteWorkspaceHeader === 'function') {
        renderWebsiteWorkspaceHeader();
      }
    }
  } catch (err) {
    toast(`Save failed: ${err.message}`, 'error');
  } finally {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = oldText;
    }
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



window.loadProjects = loadProjects;
window.loadProjectsView = loadProjectsView;
window.renderProjectsList = renderProjectsList;
window.getSelectedProject = getSelectedProject;

export {
  loadProjects,
  loadProjectsView,
  renderProjectsList,
  getSelectedProject,
  openAddWebsiteModal,
  openEditWebsiteModal,
  detectProjectConfiguration,
  getNextAvailablePort,
  deleteProject,
};
