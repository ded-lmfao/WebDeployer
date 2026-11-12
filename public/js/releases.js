/**
 * WebDep Releases & Rollbacks Cockpit
 * Historical release points, atomic rollback execution, and release snapshot creation
 */

import {
  state,
  getSelectedProject,
  paginateAndRender,
  escapeHtml,
  formatDate,
  formatRelativeTime,
  setHtmlIfChanged,
  openModal,
  closeModal,
  showConfirmDialog,
} from './state.js';
import { api, toast } from './api.js';

export function syncReleasesHeaderControls() {
  const createBtn = document.getElementById('create-release-btn');
  if (createBtn) createBtn.style.display = hasPower('deploy') ? '' : 'none';
}

async function loadReleasesView() {
  syncReleasesHeaderControls();
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
                ${hasPower('deploy') && !isLive && r.status === 'succeeded' ? `<button class="btn btn-primary btn-sm" onclick="rollbackToRelease(${p.id}, ${r.id})">Rollback</button>` : ''}
                ${hasPower('logs') && r.deployment_id ? `<button class="btn btn-secondary btn-sm" onclick="openDeploymentDetails(${r.deployment_id})">Logs</button>` : ''}
                ${hasPower('deploy') && !isLive ? `<button class="btn btn-danger btn-sm" onclick="deleteRelease(${p.id}, ${r.id})">Delete</button>` : ''}
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
            ${hasPower('deploy') ? `<button class="btn btn-danger btn-sm" onclick="rollbackToRelease(${p.id}, ${r.id})">Instant Rollback</button>` : '<span style="color:var(--text-dim); font-size:12px;">Read-only</span>'}
          </td>
        </tr>
      `).join(''));
    });
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="7" style="text-align: center; color: var(--danger); padding: 24px;">${escapeHtml(err.message)}</td></tr>`;
  }
}

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
    if (typeof window.navigateTo === 'function') {
      window.navigateTo('deployments', projectId);
    }
  } catch (err) {
    toast(`Rollback failed: ${err.message}`, 'error');
  }
}

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
            noteInput.value = `Snapshot release for ${sel.name} - ${d.toLocaleDateString()}`;
          }
        }
      };
    }
  } else {
    if (projGroup) projGroup.style.display = 'none';
    if (targetLabel) {
      targetLabel.style.display = 'block';
      targetLabel.textContent = `${p.name} (${p.slug})`;
    }
  }

  const noteInput = document.getElementById('release-note-input');
  if (noteInput) {
    const d = new Date();
    noteInput.value = `Snapshot release for ${p.name} - ${d.toLocaleDateString()}`;
  }

  openModal('modal-create-release');
}

async function confirmCreateRelease() {
  let p = getSelectedProject();
  const projSelect = document.getElementById('release-project-select');
  if (projSelect && projSelect.value) {
    const override = state.projects.find((x) => x.id === Number(projSelect.value));
    if (override) p = override;
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
      if (typeof window.navigateTo === 'function') {
        window.navigateTo('deployments', p.id);
      }
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

// Window bindings
window.loadReleasesView = loadReleasesView;
window.loadRollbacksView = loadRollbacksView;
window.rollbackToRelease = rollbackToRelease;
window.deleteRelease = deleteRelease;
window.openCreateReleaseModal = openCreateReleaseModal;
window.confirmCreateRelease = confirmCreateRelease;

document.getElementById('create-release-btn')?.addEventListener('click', openCreateReleaseModal);
document.getElementById('confirm-create-release-btn')?.addEventListener('click', confirmCreateRelease);

export {
  loadReleasesView,
  loadRollbacksView,
  rollbackToRelease,
  deleteRelease,
  openCreateReleaseModal,
  confirmCreateRelease,
};

