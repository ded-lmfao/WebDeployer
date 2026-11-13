/**
 * WebDep Workspace Process Controls & Lifecycle Actions Subsystem
 * Start, stop, restart, auto-deployment redirects, and maintenance mode toggling.
 */

import { state, syncOverviewResourceStatus } from './state.js';
import { api, toast } from './api.js';

function applyProjectLifecycleState(proj, status, pid = undefined) {
  if (!proj) return;
  proj.app_status = status;
  if (status === 'stopped' || status === 'maintenance') {
    proj.app_pid = null;
    if (proj.status && typeof proj.status === 'object') {
      proj.status = { ...proj.status, running: false, pid: null };
    }
  } else if (status === 'running') {
    if (pid !== undefined) proj.app_pid = pid;
    if (proj.status && typeof proj.status === 'object') {
      proj.status = { ...proj.status, running: true, pid: pid !== undefined ? pid : proj.status.pid };
    }
  }
  syncOverviewResourceStatus('project', proj.id, status, pid);
}

function renderLifecycleViewsNow() {
  state.lastWsBannerSig = null;
  if (state.currentView === 'projects' && window.renderProjectsList) window.renderProjectsList();
  if (state.currentView === 'services' && window.renderServicesList) window.renderServicesList();
  if (state.currentView === 'databases' && window.renderDatabasesList) window.renderDatabasesList();
  const wsTabs = window.WEBSITE_WORKSPACE_TABS || new Set(['overview', 'deployments', 'releases', 'env', 'files', 'domains', 'backups', 'logs', 'audit', 'settings']);
  if (wsTabs.has(state.currentView) && window.renderWebsiteWorkspaceHeader) {
    state.lastWsBannerSig = null;
    window.renderWebsiteWorkspaceHeader();
  }
}

function setActionButtonsLoading(projectId, activeAction) {
  const allBtns = document.querySelectorAll(
    `button[onclick*="(${projectId})"], button[onclick*="(${projectId},"]`
  );
  allBtns.forEach((b) => {
    const oc = b.getAttribute('onclick') || '';
    const isStart = /(?:^|\s|;)(?:window\.)?startProject\(/.test(oc);
    const isStop = /(?:^|\s|;)(?:window\.)?stopProject\(/.test(oc);
    const isRestart = /(?:^|\s|;)(?:window\.)?restartProject\(/.test(oc);
    const isDeploy = /(?:^|\s|;)(?:window\.)?deployProject\(/.test(oc);

    if (isStart || isStop || isRestart || isDeploy) {
      b.disabled = true;
      if (activeAction === 'start' && isStart) {
        b.innerHTML = '<span class="btn-spinner"></span> Starting';
      } else if (activeAction === 'stop' && isStop) {
        b.innerHTML = '<span class="btn-spinner"></span> Stopping';
      } else if (activeAction === 'restart' && isRestart) {
        b.innerHTML = '<span class="btn-spinner"></span> Restarting';
      }
    }
  });
}

export async function refreshCurrentViewsAfterLifecycle() {
  renderLifecycleViewsNow();
  if (window.loadProjects) await window.loadProjects(true);
  renderLifecycleViewsNow();
  if (state.currentView === 'overview' && window.loadOverview) {
    await window.loadOverview();
  } else if (state.currentView === 'deployments' && window.loadDeploymentsView) {
    await window.loadDeploymentsView();
  }
}

export function handleAutoDeployedRedirect(res, projectId) {
  if (res && res.autoDeployed) {
    toast(`No release built yet — initial deployment #${res.deploymentId} started automatically.`, 'info');
    if (window.navigateTo) window.navigateTo('deployments', projectId);
    return true;
  }
  return false;
}

export async function startProject(projectId) {
  setActionButtonsLoading(projectId, 'start');
  state.pendingLifecycleProjects?.add(projectId);

  const proj = state.projects.find((x) => x.id === projectId);
  if (proj) {
    applyProjectLifecycleState(proj, 'starting');
    if (proj.project_kind === 'service' && window.renderSingleServicePipeline) {
      window.renderSingleServicePipeline(projectId, 'source', 'running', 'Checking files and port');
      setTimeout(() => {
        if (proj.app_status === 'starting') window.renderSingleServicePipeline(projectId, 'deps', 'running', 'Environment and deps');
      }, 700);
      setTimeout(() => {
        if (proj.app_status === 'starting') window.renderSingleServicePipeline(projectId, 'daemon', 'running', 'Spawning daemon');
      }, 1400);
    }
  }

  try {
    const res = await api(`/api/projects/${projectId}/start`, { method: 'POST' });
    if (handleAutoDeployedRedirect(res, projectId)) return;
    if (proj) {
      applyProjectLifecycleState(proj, 'running', res?.pid);
      if (proj.project_kind === 'service' && window.renderSingleServicePipeline) {
        window.renderSingleServicePipeline(projectId, 'online', 'success', '');
      }
    }
    toast('Process started.', 'success');
  } catch (err) {
    if (proj) {
      applyProjectLifecycleState(proj, 'stopped', null);
      if (proj.project_kind === 'service' && window.renderSingleServicePipeline) {
        window.renderSingleServicePipeline(projectId, 'daemon', 'failed', 'Start failed');
      }
    }
    toast(`Start failed: ${err.message}`, 'error');
  } finally {
    state.pendingLifecycleProjects?.delete(projectId);
    await refreshCurrentViewsAfterLifecycle();
  }
}

export async function stopProject(projectId) {
  setActionButtonsLoading(projectId, 'stop');
  state.pendingLifecycleProjects?.add(projectId);

  const proj = state.projects.find((x) => x.id === projectId);
  const prevStatus = proj?.app_status || 'running';
  const prevPid = proj?.app_pid ?? null;
  if (proj) {
    applyProjectLifecycleState(proj, 'stopping');
    if (proj.project_kind === 'service' && window.renderSingleServicePipeline) {
      window.renderSingleServicePipeline(projectId, 'daemon', 'running', 'Stopping');
    }
  }

  try {
    await api(`/api/projects/${projectId}/stop`, { method: 'POST' });
    if (proj) {
      applyProjectLifecycleState(proj, 'stopped', null);
      if (proj.project_kind === 'service' && window.renderSingleServicePipeline) {
        window.renderSingleServicePipeline(projectId, 'source', 'idle', 'Stopped');
      }
    }
    toast('Process stopped.', 'info');
  } catch (err) {
    if (proj) {
      applyProjectLifecycleState(proj, prevStatus, prevPid);
      if (proj.project_kind === 'service' && window.renderSingleServicePipeline) {
        window.renderSingleServicePipeline(projectId, 'online', 'success', '');
      }
    }
    toast(`Stop failed: ${err.message}`, 'error');
  } finally {
    state.pendingLifecycleProjects?.delete(projectId);
    await refreshCurrentViewsAfterLifecycle();
  }
}

export async function toggleMaintenanceMode(projectId) {
  state.pendingLifecycleProjects?.add(projectId);
  try {
    const res = await api(`/api/projects/${projectId}/maintenance`, { method: 'POST', body: {} });
    const proj = state.projects.find((x) => x.id === projectId);
    const nextStatus = res?.app_status || (res?.maintenance ? 'maintenance' : 'stopped');
    if (proj) {
      applyProjectLifecycleState(proj, nextStatus, res?.pid ?? (nextStatus === 'running' ? proj.app_pid : null));
    }
    if (res && res.maintenance) {
      toast('Maintenance Mode enabled — visitors now see the Under Maintenance page.', 'warning');
    } else {
      toast('Maintenance Mode disabled — live website resumed.', 'success');
    }
  } catch (err) {
    toast(`Maintenance toggle failed: ${err.message}`, 'error');
  } finally {
    state.pendingLifecycleProjects?.delete(projectId);
    await refreshCurrentViewsAfterLifecycle();
  }
}

export async function restartProject(projectId) {
  setActionButtonsLoading(projectId, 'restart');
  state.pendingLifecycleProjects?.add(projectId);

  const proj = state.projects.find((x) => x.id === projectId);
  if (proj) applyProjectLifecycleState(proj, 'starting');

  try {
    const res = await api(`/api/projects/${projectId}/restart`, { method: 'POST' });
    if (handleAutoDeployedRedirect(res, projectId)) return;
    if (proj) applyProjectLifecycleState(proj, 'running', res?.pid);
    toast('Application restarted successfully.', 'success');
  } catch (err) {
    if (proj) applyProjectLifecycleState(proj, 'stopped', null);
    toast(`Restart failed: ${err.message}`, 'error');
  } finally {
    state.pendingLifecycleProjects?.delete(projectId);
    await refreshCurrentViewsAfterLifecycle();
  }
}

// Bind globals for inline HTML event handlers
window.startProject = startProject;
window.stopProject = stopProject;
window.toggleMaintenanceMode = toggleMaintenanceMode;
window.restartProject = restartProject;
window.refreshCurrentViewsAfterLifecycle = refreshCurrentViewsAfterLifecycle;

