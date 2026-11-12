/**
 * WebDep Backend Service Modal & Presets Subsystem
 * Create/edit service dialogs, presets (Lavalink, Discord bots, Python/Node daemons), and GitHub repo binding.
 */

import { state, escapeHtml, openModal, closeModal } from './state.js';
import { api, toast } from './api.js';

export function setServiceSourceMode(mode) {
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

export function openAddServiceModal() {
  const form = document.getElementById('service-form');
  if (form) form.reset();
  const idEl = document.getElementById('service-form-id');
  if (idEl) idEl.value = '';
  const titleEl = document.getElementById('modal-service-title');
  if (titleEl) titleEl.textContent = 'Add Backend Service';
  const saveBtn = document.getElementById('save-service-submit-btn');
  if (saveBtn) saveBtn.textContent = 'Create Service';

  const nameEl = document.getElementById('service-name');
  if (nameEl) nameEl.value = '';
  const slugEl = document.getElementById('service-slug');
  if (slugEl) slugEl.value = '';
  const dirEl = document.getElementById('service-deploy-dir');
  if (dirEl) dirEl.value = '';
  const repoEl = document.getElementById('service-repo');
  if (repoEl) repoEl.value = '';
  const branchEl = document.getElementById('service-branch');
  if (branchEl) {
    branchEl.value = 'main';
    branchEl.dataset.touched = '';
  }
  const instEl = document.getElementById('service-install-cmd');
  if (instEl) instEl.value = '';
  const startEl = document.getElementById('service-start-cmd');
  if (startEl) startEl.value = '';

  const getPort = window.getNextAvailablePort || ((p) => p);
  const portInput = document.getElementById('service-port');
  if (portInput) portInput.value = getPort(8000);
  const domainInput = document.getElementById('service-domain');
  if (domainInput) domainInput.value = '';
  const accessInput = document.getElementById('service-access-mode');
  if (accessInput) accessInput.value = 'local';
  const ipsInput = document.getElementById('service-allowed-ips');
  if (ipsInput) ipsInput.value = '';

  if (window.toggleDatabaseAccessIpFields) {
    window.toggleDatabaseAccessIpFields('service-access-mode', 'service-allowed-ips-wrap');
  }

  applyServicePreset('lavalink');
  openModal('modal-service');
}

export function applyServicePreset(preset) {
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
  const getPort = window.getNextAvailablePort || ((p) => p);

  switch (preset) {
    case 'lavalink':
      setServiceSourceMode('manual');
      if (nameInput) {
        nameInput.value = 'Lavalink';
        nameInput.dispatchEvent(new Event('input'));
      }
      if (installInput) installInput.value = '';
      if (startInput) startInput.value = 'java -jar Lavalink.jar';
      if (portInput) portInput.value = (isEditing && currentPort) ? currentPort : getPort(1112);
      break;
    case 'node-service':
    case 'discord-node':
      setServiceSourceMode('git');
      if (nameInput) {
        nameInput.value = 'Node.js Service';
        nameInput.dispatchEvent(new Event('input'));
      }
      if (installInput) installInput.value = 'npm ci';
      if (startInput) startInput.value = 'node index.js';
      if (portInput) portInput.value = (isEditing && currentPort) ? currentPort : getPort(8000);
      break;
    case 'python-service':
    case 'discord-py':
    case 'telegram-py':
      setServiceSourceMode('git');
      if (nameInput) {
        nameInput.value = 'Python Service';
        nameInput.dispatchEvent(new Event('input'));
      }
      if (installInput) installInput.value = 'pip install -r requirements.txt --break-system-packages --ignore-installed';
      if (startInput) startInput.value = 'python3 -u main.py';
      if (portInput) portInput.value = (isEditing && currentPort) ? currentPort : getPort(8000);
      break;
    case 'worker-py':
      setServiceSourceMode('manual');
      if (nameInput) {
        nameInput.value = 'Queue Worker';
        nameInput.dispatchEvent(new Event('input'));
      }
      if (installInput) installInput.value = 'pip install -r requirements.txt --break-system-packages --ignore-installed';
      if (startInput) startInput.value = 'python3 -u worker.py';
      if (portInput) portInput.value = (isEditing && currentPort) ? currentPort : getPort(8000);
      break;
    case 'custom':
      if (nameInput && ['Lavalink', 'Node.js Service', 'Python Service', 'Queue Worker'].includes(nameInput.value)) {
        nameInput.value = '';
        nameInput.dispatchEvent(new Event('input'));
      }
      if (installInput) installInput.value = '';
      if (startInput) startInput.value = '';
      if (portInput) portInput.value = (isEditing && currentPort) ? currentPort : getPort(8000);
      break;
  }
}

export function openEditServiceModal(id) {
  const p = state.projects.find((x) => x.id === id);
  if (!p) return;

  const idEl = document.getElementById('service-form-id');
  if (idEl) idEl.value = p.id;
  const titleEl = document.getElementById('modal-service-title');
  if (titleEl) titleEl.textContent = 'Edit Backend Service';
  const saveBtn = document.getElementById('save-service-submit-btn');
  if (saveBtn) saveBtn.textContent = 'Update Service';

  const nameEl = document.getElementById('service-name');
  if (nameEl) nameEl.value = p.name || '';
  const slugEl = document.getElementById('service-slug');
  if (slugEl) slugEl.value = p.slug || '';
  const branchEl = document.getElementById('service-branch');
  if (branchEl) branchEl.value = p.branch || 'main';
  const repoEl = document.getElementById('service-repo');
  if (repoEl) repoEl.value = p.repo_url === 'local' ? '' : (p.repo_url || '');
  const dirEl = document.getElementById('service-deploy-dir');
  if (dirEl) dirEl.value = p.deploy_dir || '';
  const instEl = document.getElementById('service-install-cmd');
  if (instEl) instEl.value = p.install_cmd || '';
  const startEl = document.getElementById('service-start-cmd');
  if (startEl) startEl.value = p.start_cmd || '';

  const isLocal = !p.repo_url || p.repo_url === 'local';
  setServiceSourceMode(isLocal ? 'manual' : 'git');

  const getPort = window.getNextAvailablePort || ((prt) => prt);
  const portInput = document.getElementById('service-port');
  if (portInput) portInput.value = p.port || getPort(8000);
  const domainInput = document.getElementById('service-domain');
  if (domainInput) domainInput.value = (p.domains && p.domains[0]) || '';
  const accessInput = document.getElementById('service-access-mode');
  if (accessInput) accessInput.value = p.access_mode || 'local';
  const ipsInput = document.getElementById('service-allowed-ips');
  if (ipsInput) ipsInput.value = p.allowed_ips || '';

  if (window.toggleDatabaseAccessIpFields) {
    window.toggleDatabaseAccessIpFields('service-access-mode', 'service-allowed-ips-wrap');
  }

  const pt = p.project_type || 'custom';
  document.querySelectorAll('#service-preset-buttons .preset-chip').forEach((c) => {
    c.classList.toggle('active', c.getAttribute('data-service-preset') === pt);
  });

  openModal('modal-service');
}

// Bind modal listeners
document.querySelectorAll('#service-preset-buttons .preset-chip').forEach((chip) => {
  chip.addEventListener('click', () => {
    const preset = chip.getAttribute('data-service-preset');
    if (preset) applyServicePreset(preset);
  });
});

document.getElementById('service-name')?.addEventListener('input', (e) => {
  if (!document.getElementById('service-form-id')?.value) {
    const slug = e.target.value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
    const slugEl = document.getElementById('service-slug');
    if (slugEl) slugEl.value = slug;
    const dirEl = document.getElementById('service-deploy-dir');
    if (dirEl) dirEl.value = slug ? `./data/services/${slug}` : '';
  }
});

document.getElementById('service-browse-github-repos-btn')?.addEventListener('click', async () => {
  const sel = document.getElementById('service-github-repos-select');
  const input = document.getElementById('service-repo');
  if (!sel || !input) return;
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
          const brEl = document.getElementById('service-branch');
          if (brEl && brEl.dataset.touched !== '1') brEl.value = selected.default_branch || 'main';
          const nameEl = document.getElementById('service-name');
          if (nameEl && !nameEl.value) {
            const shortName = selected.full_name.split('/')[1] || selected.full_name;
            nameEl.value = shortName;
            nameEl.dispatchEvent(new Event('input'));
          }
        }
      }
    };
  } catch (err) {
    toast(`Could not load repos: ${err.message}. Configure your GitHub token in Settings.`, 'warning');
  }
});

document.getElementById('service-branch')?.addEventListener('input', (ev) => {
  ev.target.dataset.touched = '1';
});

document.getElementById('save-service-submit-btn')?.addEventListener('click', async (e) => {
  e.preventDefault();
  const form = document.getElementById('service-form');
  if (!form || !form.reportValidity()) return;

  const submitBtn = document.getElementById('save-service-submit-btn');
  const originalText = submitBtn ? submitBtn.textContent : 'Save';
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.innerHTML = '<span class="status-dot online" style="display:inline-block; margin-right:6px; animation: pulse 1s infinite;"></span> Saving...';
  }

  const id = document.getElementById('service-form-id')?.value;
  const name = document.getElementById('service-name')?.value.trim() || '';
  const startCmd = document.getElementById('service-start-cmd')?.value.trim() || '';
  let slug = document.getElementById('service-slug')?.value.trim() || '';
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

  const getPort = window.getNextAvailablePort || ((p) => p);
  const portVal = document.getElementById('service-port')?.value.trim();
  const domainVal = document.getElementById('service-domain')?.value.trim();
  const accessMode = document.getElementById('service-access-mode')?.value || 'local';
  const allowedIps = document.getElementById('service-allowed-ips')?.value.trim() || '';

  const payload = {
    name,
    slug,
    repo_url: isManual ? 'local' : repoVal,
    branch: isManual ? 'local' : (document.getElementById('service-branch')?.value.trim() || 'main'),
    project_kind: 'service',
    project_type: projectType,
    deploy_method: 'managed',
    deploy_dir: document.getElementById('service-deploy-dir')?.value.trim() || `./data/services/${slug}`,
    install_cmd: document.getElementById('service-install-cmd')?.value.trim() || '',
    build_cmd: '',
    start_cmd: startCmd,
    health_url: '',
    port: portVal ? Number(portVal) : getPort(8000),
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
    if (window.loadProjects) await window.loadProjects();
    if (isManual) {
      toast(`Service "${payload.name}" ready! Upload your files in the Files tab.`, 'info');
      if (window.openWebsiteWorkspace) window.openWebsiteWorkspace(targetId, 'files');
    } else {
      if (window.navigateTo) window.navigateTo('services');
    }
  } catch (err) {
    toast(`Save failed: ${err.message}`, 'error');
  } finally {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = originalText;
    }
  }
});

// Bind globals for inline HTML event handlers
window.setServiceSourceMode = setServiceSourceMode;
window.openAddServiceModal = openAddServiceModal;
window.applyServicePreset = applyServicePreset;
window.openEditServiceModal = openEditServiceModal;

