/**
 * WebDep Deployments Subsystem
 * Git integrations, deployments list view, execution triggers, and modal details
 */

import { icon } from './icons.js';
import {
  state,
  getSelectedProject,
  paginateAndRender,
  escapeHtml,
  formatDate,
  formatRelativeTime,
  setHtmlIfChanged,
  openModal,
  showConfirmDialog,
  showCopyDialog,
  hasCachedApi,
} from './state.js';
import { api, toast } from './api.js';
import { formatLogLine } from './logs.js';
import { loadOverview } from './overview.js';
import { loadProjects, renderProjectsList } from './websites.js';

// Re-export Modular Subsystems
export * from './pipeline_engine.js';
export * from './releases.js';
export * from './env_vars.js';

import { waterPipelines, renderPipelineStages, resetWaterPipeline } from './pipeline_engine.js';
import { loadAppUsageCards } from './app_usage.js';

// ============================================================================
// View 3: GitHub View
// ============================================================================
async function loadGithubView() {
  const p = getSelectedProject();
  if (!p) return;

  const fetchBtn = document.getElementById('github-fetch-btn');
  if (fetchBtn) fetchBtn.style.display = hasPower('deploy') ? '' : 'none';

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
              ${hasPower('deploy') ? `
                <button class="btn btn-primary btn-sm" onclick="deployProject(${p.id}, '${c.sha}')" ${isLive ? 'disabled' : ''}>
                  Deploy Commit
                </button>
              ` : '<span style="color:var(--text-dim); font-size:12px;">Read-only</span>'}
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

// ============================================================================
// View 4: Deployments Pipeline
// ============================================================================
let deploymentPollTimer = null;

async function loadDeploymentsView() {
  const p = getSelectedProject();
  const query = p ? `?project=${p.id}&limit=5` : '?limit=50';
  const tbody = document.getElementById('deployments-table-body');

  const isService = p && p.project_kind === 'service';
  const depTitle = document.getElementById('deployments-view-title');
  const depDesc = document.getElementById('deployments-view-desc');
  if (depTitle) {
    depTitle.textContent = 'Overview';
  }
  if (depDesc) {
    depDesc.textContent = isService
      ?'Live resource usage, service lifecycle pipeline, and last 5 deployment records'
      : 'Live resource usage, deployment pipeline, and last 5 deployment records';
  }

  // Load 4 app usage cards (CPU, RAM, Network Inbound/Outbound graph, Disk) concurrently
  void loadAppUsageCards(p);

  try {
    const deployments = await api(`/api/deployments${query}`, { noCache: true });

    const active = deployments.find((d) => d.status === 'running' || d.status === 'pending' || d.status === 'in_progress');
    state.activeDeployment = active || null;
    const badge = document.getElementById('pipeline-status-badge');
    const latest = deployments.length ? deployments[0] : null;

    if (active) {
      if (badge) {
        badge.textContent = `${active.kind.toUpperCase()} (${active.stage.toUpperCase()})`;
        badge.className = 'badge badge-warning';
      }
      renderPipelineStages('main-pipeline-track', active.stage, active.status, active.id);

      // Auto-poll while deployment is in flight so the UI updates live in real-time
      if (deploymentPollTimer) clearTimeout(deploymentPollTimer);
      deploymentPollTimer = setTimeout(() => {
        if (state.currentView === 'deployments') {
          void loadDeploymentsView();
        }
      }, 1500);
    } else {
      if (deploymentPollTimer) {
        clearTimeout(deploymentPollTimer);
        deploymentPollTimer = null;
      }
      // Re-enable any deploy buttons that were in "Deploying..." spinner state
      const btns = document.querySelectorAll(`button[onclick*="deployProject"]`);
      btns.forEach((b) => {
        if (b.disabled && b.innerHTML.includes('Deploying...')) {
          b.disabled = false;
          b.innerHTML = 'Deploy';
        }
      });

      if (latest) {
        const pWater = waterPipelines['main-pipeline-track'];
        if (latest.status === 'success') {
          if (pWater && pWater.isLooping && pWater.currentProgress < 6.95 && pWater.lastDeploymentId === latest.id) {
            if (badge) {
              badge.textContent = 'FINALIZING DEPLOYMENT...';
              badge.className = 'badge badge-warning';
            }
            renderPipelineStages('main-pipeline-track', 'health_checking', 'success', latest.id);
          } else {
            if (badge) {
              badge.textContent = 'DEPLOYED (LIVE)';
              badge.className = 'badge badge-success';
            }
            renderPipelineStages('main-pipeline-track', 'health_checking', 'success', latest.id);
          }
        } else if (latest.status === 'failed') {
          if (badge) {
            badge.textContent = `FAILED (${latest.stage.toUpperCase()})`;
            badge.className = 'badge badge-danger';
          }
          renderPipelineStages('main-pipeline-track', latest.stage, 'failed', latest.id);
        } else {
          if (badge) {
            badge.textContent = 'IDLE';
            badge.className = 'badge badge-neutral';
          }
          renderPipelineStages('main-pipeline-track', 'idle', 'idle');
        }
      } else if (p && p.app_status === 'running') {
        if (badge) {
          badge.textContent = 'ONLINE (LIVE)';
          badge.className = 'badge badge-success';
        }
        renderPipelineStages('main-pipeline-track', 'health_checking', 'success', null);
      } else {
        if (badge) {
          badge.textContent = 'IDLE';
          badge.className = 'badge badge-neutral';
        }
        renderPipelineStages('main-pipeline-track', 'idle', 'idle');
      }
    }

    const countBadge = document.getElementById('deployments-count-badge');
    if (countBadge) {
      countBadge.textContent = `${deployments.length} / 5 kept`;
    }

    if (!deployments.length) {
      const emptyDesc = isService
        ? 'Service is supervised and managed via daemon lifecycle. New builds or rollbacks will appear here.'
        : 'No deployments triggered yet. Deploy from GitHub or click Deploy to record build history.';
      tbody.innerHTML = `
        <tr class="deployments-empty-row">
          <td colspan="7">
            <div class="deployments-empty-state">
              <div class="deployments-empty-icon">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
                  <path d="M12 2L2 7l10 5 10-5-10-5z"></path>
                  <path d="M2 17l10 5 10-5"></path>
                  <path d="M2 12l10 5 10-5"></path>
                </svg>
              </div>
              <div class="deployments-empty-title">No deployment records yet</div>
              <div class="deployments-empty-desc">${emptyDesc}</div>
            </div>
          </td>
        </tr>
      `;
      const bar = document.getElementById('deployments-pagination');
      if (bar) bar.innerHTML = '';
      return;
    }

    paginateAndRender(deployments, 'deployments', 'deployments-pagination', (slice) => {
      setHtmlIfChanged(tbody, slice.map((d) => renderDeploymentRow(d, false)).join(''));
    });
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="7" style="text-align: center; color: var(--danger); padding: 24px;">${escapeHtml(err.message)}</td></tr>`;
  }
}

function renderDeploymentRow(d, isOverview = false) {
  let badgeClass = 'badge-neutral';
  const isRunning = d.status === 'running' || d.status === 'pending' || d.status === 'in_progress';
  if (d.status === 'success') badgeClass = 'badge-success';
  else if (d.status === 'failed') badgeClass = 'badge-danger';
  else if (isRunning) badgeClass = 'badge-warning';

  const sha = d.sha ? `<span class="sha-pill">${d.sha.slice(0, 7)}</span>` : '<span style="color:var(--text-dim)">--</span>';
  const duration = d.finished_at && d.started_at ? `${Math.round((d.finished_at - d.started_at) / 1000)}s` : (isRunning ? 'Running...' : '--');
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
        ${hasPower('logs') ? `<button class="btn btn-secondary btn-sm" onclick="openDeploymentDetails(${d.id})">Logs</button>` : '<span style="color:var(--text-dim); font-size:11.5px;">--</span>'}
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

  resetWaterPipeline('main-pipeline-track');
  const badge = document.getElementById('pipeline-status-badge');
  if (badge) {
    badge.textContent = 'STARTING DEPLOYMENT...';
    badge.className = 'badge badge-warning';
  }

  try {
    if (p.project_kind === 'service' && typeof window.renderSingleServicePipeline === 'function') {
      window.renderSingleServicePipeline(p.id, 'source', 'running', 'DEPLOY (SOURCE)');
    }
    const res = await api(`/api/projects/${p.id}/deploy`, { method: 'POST', body: sha ? { sha } : {} });
    toast(`Deployment #${res.deploymentId} started for ${p.name}!`, 'success');
    if (typeof window.navigateTo === 'function') {
      window.navigateTo('deployments', p.id);
    }
  } catch (err) {
    if (p.project_kind === 'service' && typeof window.renderSingleServicePipeline === 'function') {
      window.renderSingleServicePipeline(p.id, 'source', 'failed', 'DEPLOY FAILED');
    }
    toast(`Deployment failed to start: ${err.message}`, 'error');
    btns.forEach((b) => {
      b.disabled = false;
      b.innerHTML = 'Deploy';
    });
  }
}

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
    meta.innerHTML = `
      <div class="dep-details-meta-row">
        <div><strong>Status:</strong> <span class="badge ${data.status === 'success' ? 'badge-success' : data.status === 'failed' ? 'badge-danger' : 'badge-warning'}">${data.status.toUpperCase()}</span></div>
        <div><strong>Commit:</strong> ${data.sha ? `<span class="sha-pill">${data.sha.slice(0, 7)}</span>` : '--'}</div>
        <div><strong>Started:</strong> ${formatDate(data.started_at)}</div>
        <div><strong>Duration:</strong> ${data.finished_at && data.started_at ? Math.round((data.finished_at - data.started_at) / 1000) + 's' : '--'}</div>
      </div>
      ${data.error_message ? `<div class="dep-details-error">${escapeHtml(data.error_message)}</div>` : ''}
    `;

    if (!data.logs || !data.logs.length) {
      logsDiv.innerHTML = '<span style="color:var(--text-dim)">No log output recorded for this deployment.</span>';
    } else {
      logsDiv.innerHTML = data.logs.map((l) => formatLogLine(l)).join('');
      logsDiv.scrollTop = logsDiv.scrollHeight;
    }
  } catch (err) {
    meta.innerHTML = `<span style="color:var(--danger);">${escapeHtml(err.message)}</span>`;
  }
}

// Window bindings
window.loadGithubView = loadGithubView;
window.generateDeployKey = generateDeployKey;
window.rotateWebhookSecret = rotateWebhookSecret;
window.fetchProjectUpdates = fetchProjectUpdates;
window.loadDeploymentsView = loadDeploymentsView;
window.renderDeploymentRow = renderDeploymentRow;
window.deployProject = deployProject;
window.openDeploymentDetails = openDeploymentDetails;

export {
  loadGithubView,
  generateDeployKey,
  rotateWebhookSecret,
  fetchProjectUpdates,
  loadDeploymentsView,
  renderDeploymentRow,
  deployProject,
  openDeploymentDetails,
  renderPipelineStages,
};
