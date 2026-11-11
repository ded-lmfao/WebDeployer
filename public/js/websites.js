/**
 * WebDep Websites / Projects Management Subsystem
 * Hosted websites list, configuration detector, port allocator, and website modal workflows
 */

import {
  state,
  PAGE_SIZE,
  paginateAndRender,
  escapeHtml,
  formatRelativeTime,
  openModal,
  closeModal,
  showConfirmDialog,
  showPromptDialog,
  invalidateClientCache,
} from './state.js';
import { api, toast, prefetchWebsiteWorkspace } from './api.js';

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

    const resItem = (state.overview?.resources || []).find((x) => (x.projectId === p.id || x.project_id === p.id));
    const diskStr = resItem?.diskFormatted || resItem?.disk_formatted;

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
          ${diskStr ? `<div class="project-meta-item"><span>Disk <strong>${diskStr}</strong></span></div>` : ''}
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

  const portInput = document.getElementById('website-port');
  if (portInput) portInput.value = getNextAvailablePort(3000);

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
  document.getElementById('website-port').value = p.port || getNextAvailablePort(3000);
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
    port: document.getElementById('website-port').value ? Number(document.getElementById('website-port').value) : getNextAvailablePort(3000),
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
