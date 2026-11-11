/**
 * WebDep Deployments, Releases & Pipelines Subsystem
 * Git integrations, Organic Fluid Water Pipeline engine, release history, rollbacks & .env editor
 */

import { icon } from './icons.js';
import {
  state,
  PAGE_SIZE,
  paginateAndRender,
  escapeHtml,
  formatDate,
  formatRelativeTime,
  setHtmlIfChanged,
  openModal,
  closeModal,
  showConfirmDialog,
  showPromptDialog,
  showCopyDialog,
  copyTextToClipboard,
  PIPELINE_STAGES,
} from './state.js';
import { api, toast } from './api.js';
import { formatLogLine } from './logs.js';

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

  const isService = p && p.project_kind === 'service';
  const depTitle = document.getElementById('deployments-view-title');
  const depDesc = document.getElementById('deployments-view-desc');
  if (depTitle) {
    depTitle.textContent = isService ? 'Service Lifecycle & Pipeline' : 'Deployments Pipeline';
  }
  if (depDesc) {
    depDesc.textContent = isService
      ? 'Automated service daemon lifecycle, health verification, and deployment history'
      : 'Automated zero-downtime deployment pipelines and operation history';
  }

  try {
    const deployments = await api(`/api/deployments${query}`);

    // Check if any deployment is active
    const active = deployments.find((d) => d.status === 'running' || d.status === 'pending');
    state.activeDeployment = active || null;
    const badge = document.getElementById('pipeline-status-badge');
    const latest = deployments.length ? deployments[0] : null;

    if (active) {
      if (badge) {
        badge.textContent = `${active.kind.toUpperCase()} (${active.stage.toUpperCase()})`;
        badge.className = 'badge badge-warning';
      }
      renderPipelineStages('main-pipeline-track', active.stage, active.status, active.id);
    } else if (latest) {
      const pWater = waterPipelines['main-pipeline-track'];
      if (latest.status === 'success') {
        if (pWater && pWater.currentProgress < 6.95 && pWater.lastDeploymentId === latest.id) {
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

    if (!deployments.length) {
      const emptyMsg = isService
        ? 'No deployment records yet. Service is supervised and managed via daemon lifecycle.'
        : 'No deployments found.';
      tbody.innerHTML = `<tr><td colspan="7" style="text-align: center; padding: 24px;">${emptyMsg}</td></tr>`;
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
window.loadDeploymentsView = loadDeploymentsView;

// ============================================================================
// Organic Fluid Water Pipeline Engine
// ============================================================================
const waterPipelines = {};

function initWaterPipelineDOM(container, containerId, stages = PIPELINE_STAGES) {
  const isCompact = container.classList.contains('card-pipeline-track') || containerId.startsWith('db-pipeline-track') || containerId.startsWith('service-pipeline-track') || container.closest('.card') !== null;
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
    const svcMatch = pipeline.containerId.match(/^service-pipeline-track-(\d+)$/);
    if (svcMatch) {
      const sBadge = document.getElementById(`service-pipeline-badge-${svcMatch[1]}`);
      if (sBadge && !sBadge.textContent.includes('ONLINE')) {
        sBadge.textContent = 'ONLINE (READY)';
        sBadge.className = 'badge badge-success';
      }
    }
  } else if (isDraining && P > 0.1) {
    if (pipeline.containerId === 'main-pipeline-track' || pipeline.containerId === 'overview-pipeline-track') {
      const badge = document.getElementById('pipeline-status-badge');
      if (badge && !badge.textContent.includes('STOPPING')) {
        badge.textContent = 'STOPPING...';
        badge.className = 'badge badge-warning';
      }
    }
    const svcMatch = pipeline.containerId.match(/^service-pipeline-track-(\d+)$/);
    if (svcMatch) {
      const sBadge = document.getElementById(`service-pipeline-badge-${svcMatch[1]}`);
      if (sBadge && !sBadge.textContent.includes('STOPPING')) {
        sBadge.textContent = 'STOPPING...';
        sBadge.className = 'badge badge-warning';
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
    const svcMatch = pipeline.containerId.match(/^service-pipeline-track-(\d+)$/);
    if (svcMatch) {
      const sBadge = document.getElementById(`service-pipeline-badge-${svcMatch[1]}`);
      if (sBadge && sBadge.textContent !== 'STOPPED' && sBadge.textContent !== 'IDLE') {
        sBadge.textContent = 'STOPPED';
        sBadge.className = 'badge badge-neutral';
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
    if (p.project_kind === 'service') {
      resetWaterPipeline(`service-pipeline-track-${p.id}`);
      renderSingleServicePipeline(p.id, 'source', 'running', 'DEPLOY (SOURCE)');
    }
    const res = await api(`/api/projects/${p.id}/deploy`, { method: 'POST', body: sha ? { sha } : {} });
    toast(`Deployment #${res.deploymentId} started for ${p.name}!`, 'success');
    navigateTo('deployments', p.id);
  } catch (err) {
    if (p.project_kind === 'service') {
      renderSingleServicePipeline(p.id, 'source', 'failed', 'DEPLOY FAILED');
    }
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



window.waterPipelines = waterPipelines;
window.loadGithubView = loadGithubView;
window.loadEnvView = loadEnvView;
window.renderPipelineStages = renderPipelineStages;
window.setBtnLoading = setBtnLoading;

export {
  renderPipelineStages,
  setBtnLoading,
  loadGithubView,
  generateDeployKey,
  rotateWebhookSecret,
  fetchProjectUpdates,
  loadDeploymentsView,
  waterPipelines,
  resetWaterPipeline,
  deployProject,
  openDeploymentDetails,
  loadReleasesView,
  openCreateReleaseModal,
  confirmCreateRelease,
  loadRollbacksView,
  rollbackToRelease,
  deleteRelease,
  loadEnvView,
  setEnvViewMode,
};
