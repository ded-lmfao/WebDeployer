async function loadServicesView() {
  if (typeof window.loadProjects === 'function') {
    await window.loadProjects();
  }
  renderServicesList();
}
window.loadServicesView = loadServicesView;

/**
 * WebDep Backend Services & Daemons Subsystem
 * Background worker daemons, Telegram/Discord bots, and custom services
 */

import { icon } from './icons.js';
import {
  state,
  PAGE_SIZE,
  paginateAndRender,
  escapeHtml,
  formatRelativeTime,
  openModal,
  closeModal,
  showConfirmDialog,
  invalidateClientCache,
  setHtmlIfChanged,
  PRESETS,
} from './state.js';
import { api, toast } from './api.js';
import { renderPipelineStages } from './deployments.js';

// ============================================================================
// View 2.5: Backend Services & Bots
// ============================================================================

// Backend Services & Bots Pipeline Stages (5-Step Lifecycle & Deployment Pipeline)
const SERVICE_PIPELINE_STAGES = [
  { id: 'source', label: 'Source' },
  { id: 'deps', label: 'Deps' },
  { id: 'build', label: 'Build' },
  { id: 'daemon', label: 'Daemon' },
  { id: 'online', label: 'Online' },
];

const SERVICE_STAGE_MAP = {
  pending: 'source',
  fetching: 'source',
  pulling: 'source',
  source: 'source',
  sandbox: 'source',
  port: 'source',

  installing: 'deps',
  install: 'deps',
  deps: 'deps',

  building: 'build',
  build: 'build',
  config: 'build',

  deploying: 'daemon',
  deploy: 'daemon',
  spawning: 'daemon',
  daemon: 'daemon',

  health_checking: 'online',
  healthy: 'online',
  online: 'online',
  success: 'online',
};

function renderSingleServicePipeline(serviceId, currentStage, currentStatus, detailText = '') {
  const containerId = `service-pipeline-track-${serviceId}`;
  const container = document.getElementById(containerId);
  const badge = document.getElementById(`service-pipeline-badge-${serviceId}`);
  if (!container) return;

  const mappedStage = SERVICE_STAGE_MAP[currentStage] || 'source';

  if (badge) {
    if (currentStatus === 'idle') {
      badge.textContent = detailText ? detailText.toUpperCase() : 'IDLE';
      badge.className = 'badge badge-neutral';
      badge.onclick = null;
      badge.style.cursor = 'default';
    } else if (currentStatus === 'failed') {
      badge.textContent = detailText ? detailText.toUpperCase() : `FAILED (${currentStage.toUpperCase()}) — VIEW LOGS`;
      badge.className = 'badge badge-danger';
      badge.style.cursor = 'pointer';
      badge.onclick = (e) => {
        e.stopPropagation();
        openWebsiteWorkspace(serviceId, 'logs');
      };
    } else if (currentStatus === 'success') {
      badge.textContent = detailText ? detailText.toUpperCase() : 'ONLINE (READY)';
      badge.className = 'badge badge-success';
      badge.onclick = null;
      badge.style.cursor = 'default';
    } else {
      badge.textContent = detailText ? detailText.toUpperCase() : `RUNNING (${currentStage.toUpperCase()})`;
      badge.className = 'badge badge-warning';
      badge.onclick = null;
      badge.style.cursor = 'default';
    }
  }

  renderPipelineStages(containerId, mappedStage, currentStatus, serviceId, SERVICE_PIPELINE_STAGES);
}
window.renderSingleServicePipeline = renderSingleServicePipeline;

function syncServiceCardPipeline(p) {
  if (!p) return;
  const uptimeEl = document.getElementById(`service-uptime-${p.id}`);
  if (uptimeEl) {
    const isOnline = p.app_status === 'running';
    uptimeEl.textContent = isOnline && p.app_started_at
      ? `Started ${formatRelativeTime(p.app_started_at)}`
      : (isOnline ? 'Active process' : 'Process inactive');
  }

  const ovItem = (state.overview?.projects || []).find((x) => x.project?.id === p.id);
  const activeDep = ovItem?.active || (state.activeDeployment && state.activeDeployment.project_id === p.id ? state.activeDeployment : null);

  if (activeDep && (activeDep.status === 'running' || activeDep.status === 'pending')) {
    const stageLabel = activeDep.stage ? activeDep.stage.toUpperCase() : 'DEPLOYING';
    renderSingleServicePipeline(p.id, activeDep.stage, activeDep.status, `DEPLOY (${stageLabel})`);
    return;
  }

  if (p.app_status === 'starting') {
    renderSingleServicePipeline(p.id, 'daemon', 'running', 'STARTING DAEMON');
  } else if (p.app_status === 'stopping') {
    renderSingleServicePipeline(p.id, 'daemon', 'running', 'STOPPING...');
  } else if (p.app_status === 'running') {
    const pidText = p.app_pid ? `ONLINE (PID ${p.app_pid})` : 'ONLINE (READY)';
    renderSingleServicePipeline(p.id, 'online', 'success', pidText);
  } else if (p.app_status === 'error' || p.app_status === 'failed') {
    renderSingleServicePipeline(p.id, 'daemon', 'failed', 'FAILED — VIEW LOGS');
  } else {
    renderSingleServicePipeline(p.id, 'source', 'idle', 'STOPPED');
  }
}
window.syncServiceCardPipeline = syncServiceCardPipeline;

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
    setHtmlIfChanged(container, `
      <div style="grid-column: 1 / -1; text-align: center; padding: 48px; background: var(--bg-card); border-radius: var(--radius-lg); border: 1px dashed var(--border-medium);">
        <div style="margin-bottom: 12px; color: var(--text-dim);">${icon('bot', { size: 40, stroke: 1.5 })}</div>
        <p style="font-size: 16px; font-weight: 600; margin-bottom: 8px;">No backend services or bots yet</p>
        <p style="color: var(--text-muted); font-size: 13.5px; max-width: 460px; margin: 0 auto 20px auto; line-height: 1.5;">
          Deploy 24/7 Discord bots, Telegram bots, queue workers, and background scripts directly on your server with automatic process supervision.
        </p>
        <button class="btn btn-primary" onclick="openAddServiceModal()">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
          <span>New Service / Bot</span>
        </button>
      </div>
    `);
    return;
  }

  setHtmlIfChanged(container, filtered.map((p) => {
    const isOnline = p.app_status === 'running';
    const sha = p.deployed_sha ? `<span class="sha-pill">${p.deployed_sha.slice(0, 7)}</span>` : '<span style="color:var(--text-dim)">Not deployed</span>';

    let typeIconName = 'bot';
    let typeName = 'Backend Service';
    const pt = (p.project_type || '').toLowerCase();
    if (pt.includes('discord')) {
      typeIconName = 'bot';
      typeName = 'Discord Bot';
    } else if (pt.includes('telegram')) {
      typeIconName = 'send';
      typeName = 'Telegram Bot';
    } else if (pt.includes('lavalink') || (p.start_cmd && p.start_cmd.toLowerCase().includes('lavalink'))) {
      typeIconName = 'coffee';
      typeName = 'Audio Daemon';
    } else if (pt.includes('python') || (p.start_cmd && p.start_cmd.includes('python'))) {
      typeIconName = 'terminal';
      typeName = 'Python Daemon';
    } else if (pt.includes('node') || (p.start_cmd && p.start_cmd.includes('node'))) {
      typeIconName = 'zap';
      typeName = 'Node.js Worker';
    } else if (pt.includes('worker')) {
      typeIconName = 'settings';
      typeName = 'Queue Worker';
    }

    const uptimeText = isOnline ? 'Active process' : 'Process inactive';

    const isLocal = !p.repo_url || p.repo_url === 'local' || (p.project_type && p.project_type.includes('lavalink'));
    const defaultTab = 'deployments';

    const resItem = (state.overview?.resources || []).find((x) => (x.projectId === p.id || x.project_id === p.id));
    const diskStr = resItem?.diskFormatted || resItem?.disk_formatted;

    let accessBadge = `<span class="badge badge-neutral" style="font-size: 10px;">${icon('lock', { size: 10 })} Localhost Only</span>`;
    if (p.access_mode === 'allowlist') {
      const ipList = p.allowed_ips ? p.allowed_ips.split(/[,;\n]/).filter(Boolean).length : 0;
      accessBadge = `<span class="badge badge-primary" style="font-size: 10px;">${icon('shield', { size: 10 })} Allowlist (${ipList} IP${ipList === 1 ? '' : 's'})</span>`;
    } else if (p.access_mode === 'public') {
      accessBadge = `<span class="badge badge-warning" style="font-size: 10px;">${icon('globe', { size: 10 })} Public</span>`;
    }

    const domainBadge = (p.domains && p.domains.length > 0)
      ? `<span class="badge badge-primary" style="font-size: 10px; font-family: var(--font-mono);">${icon('globe', { size: 10 })} ${escapeHtml(p.domains[0])}</span>`
      : '';
    const portBadge = p.port ? `<span class="badge badge-neutral" style="font-size: 10px; font-family: var(--font-mono);">Port ${p.port}</span>` : '';

    let subTitle = typeName;
    if (!isLocal && p.branch) {
      subTitle = `${typeName} &bull; ${escapeHtml(p.branch)}`;
    } else if (p.name.toLowerCase() === typeName.toLowerCase()) {
      subTitle = isLocal ? 'Manual Files' : 'Service';
    }

    return `
      <div class="project-card service-card" style="cursor: pointer;" onclick="openWebsiteWorkspace(${p.id}, '${defaultTab}')">
        <div class="project-card-header" style="min-height: 38px; display: flex; justify-content: space-between; align-items: center;">
          <div style="display: flex; align-items: center; gap: 10px; min-width: 0;">
            <div style="width: 36px; height: 36px; min-width: 36px; border-radius: 8px; background: rgba(99, 102, 241, 0.12); color: #818cf8; display: flex; align-items: center; justify-content: center;">
              ${icon(typeIconName, { size: 18 })}
            </div>
            <div style="min-width: 0;">
              <div class="project-info-title" style="font-size: 15px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">
                <span class="status-dot ${isOnline ? 'online' : 'offline'}"></span>
                <span>${escapeHtml(p.name)}</span>
              </div>
              <div style="font-size: 11.5px; color: var(--text-muted); font-family: var(--font-mono); margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 220px;" title="${escapeHtml(subTitle)}">
                ${subTitle}
              </div>
            </div>
          </div>
          <span class="badge ${isOnline ? 'badge-success' : 'badge-neutral'}" style="flex-shrink: 0; font-size: 10.5px; font-weight: 600; padding: 2px 8px;">${isOnline ? 'ONLINE' : 'STOPPED'}</span>
        </div>

        <div style="background: var(--bg-alt); padding: 0 10px; border-radius: var(--radius-sm); border: 1px solid var(--border-subtle); font-size: 11.5px; font-family: var(--font-mono); height: 32px; min-height: 32px; display: flex; justify-content: space-between; align-items: center; overflow: hidden; box-sizing: border-box;">
          <span style="color: var(--text-dim); text-overflow: ellipsis; white-space: nowrap; overflow: hidden; max-width: 78%;" title="${escapeHtml(p.start_cmd || '')}">
            $ ${escapeHtml(p.start_cmd || 'node index.js')}
          </span>
          ${p.app_pid ? `<span class="badge badge-neutral" style="font-size: 9.5px; padding: 1px 5px; flex-shrink: 0;">PID ${p.app_pid}</span>` : ''}
        </div>

        <div style="display: flex; align-items: center; gap: 6px; height: 22px; min-height: 22px; overflow: hidden; font-size: 11px;">
          ${isLocal
        ? `<span class="badge badge-neutral" style="font-size: 10px; padding: 2px 6px;">${icon('folder', { size: 10 })} Manual</span>`
        : `<span class="badge badge-neutral" style="font-size: 10px; padding: 2px 6px;">${icon('git-branch', { size: 10 })} ${sha}</span>`
      }
          ${portBadge}
          ${domainBadge}
          ${accessBadge}
          ${diskStr ? `<span style="font-size: 10.5px; color: var(--text-dim); font-family: var(--font-mono); margin-left: auto;">${diskStr}</span>` : ''}
        </div>

        <!-- Hidden DOM hooks for runtime telemetry & pipeline updates (no function broken) -->
        <div id="service-pipeline-track-${p.id}" style="display: none;"></div>
        <span id="service-pipeline-badge-${p.id}" style="display: none;"></span>
        <span id="service-uptime-${p.id}" style="display: none;">${uptimeText}</span>

        <div class="project-card-actions" onclick="event.stopPropagation()" style="display: flex; justify-content: space-between; align-items: center; width: 100%; border-top: 1px solid var(--border-subtle); padding-top: 10px; margin-top: auto; height: 38px; box-sizing: border-box;">
          <div style="display: flex; gap: 5px; align-items: center;">
            ${isOnline
        ? `<button class="btn btn-danger btn-sm" onclick="stopProject(${p.id})" style="padding: 3px 9px; font-size: 11.5px;">Stop</button>`
        : `<button class="btn btn-success btn-sm" onclick="startProject(${p.id})" style="padding: 3px 9px; font-size: 11.5px;">Start</button>`
      }
            ${!isLocal ? `<button class="btn btn-secondary btn-sm" onclick="deployProject(${p.id})" style="padding: 3px 9px; font-size: 11.5px;">Deploy</button>` : ''}
            <button class="btn btn-secondary btn-sm" onclick="openWebsiteWorkspace(${p.id}, 'files')" style="padding: 3px 9px; font-size: 11.5px;" title="Upload and manage service files">Files</button>
            <button class="btn btn-secondary btn-sm" onclick="openWebsiteWorkspace(${p.id}, 'logs')" style="padding: 3px 9px; font-size: 11.5px;" title="View live logs">Logs</button>
            <button class="btn btn-secondary btn-sm" onclick="openEditServiceModal(${p.id})" style="padding: 3px 7px; font-size: 11.5px; display: inline-flex; align-items: center; justify-content: center;" title="Settings">
              ${icon('settings', { size: 12 })}
            </button>
          </div>
          <button class="btn btn-primary btn-sm" onclick="openWebsiteWorkspace(${p.id}, '${defaultTab}')" style="padding: 3px 10px; font-size: 11.5px; font-weight: 500;">
            Manage &rarr;
          </button>
        </div>
      </div>
    `;
  }).join(''));

  // Hydrate each service card's dedicated water pipeline
  filtered.forEach((p) => {
    syncServiceCardPipeline(p);
  });
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
  if (portInput) portInput.value = getNextAvailablePort(8000);
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
    port: portVal ? Number(portVal) : getNextAvailablePort(8000),
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



window.loadServicesView = loadServicesView;
window.renderServicesList = renderServicesList;

export {
  loadServicesView,
  renderServicesList,
  renderSingleServicePipeline,
  syncServiceCardPipeline,
  openAddServiceModal,
  openEditServiceModal,
  setServiceSourceMode,
  applyServicePreset,
};
