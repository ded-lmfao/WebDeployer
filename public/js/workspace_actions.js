/**
 * WebDep Workspace Process Controls & Lifecycle Actions Subsystem
 * Start, stop, restart, auto-deployment redirects, and maintenance mode toggling.
 */

import { state } from './state.js';
import { api, toast } from './api.js';

export async function refreshCurrentViewsAfterLifecycle() {
  if (window.loadProjects) await window.loadProjects();
  if (state.currentView === 'projects' && window.renderProjectsList) window.renderProjectsList();
  if (state.currentView === 'services' && window.renderServicesList) window.renderServicesList();
  if (state.currentView === 'overview' && window.loadOverview) await window.loadOverview();
  const wsTabs = window.WEBSITE_WORKSPACE_TABS || new Set(['overview', 'deployments', 'releases', 'env', 'files', 'domains', 'backups', 'logs', 'audit', 'settings']);
  if (wsTabs.has(state.currentView) && window.renderWebsiteWorkspaceHeader) {
    state.lastWsBannerSig = null;
    window.renderWebsiteWorkspaceHeader();
  }
}

export function handleAutoDeployedRedirect(res, projectId) {
  if (res && res.autoDeployed) {
    toast(`No release built yet — initial deployment #${res.deploymentId} started automatically!`, 'info');
    if (window.navigateTo) window.navigateTo('deployments', projectId);
    return true;
  }
  return false;
}

export async function startProject(projectId) {
  const btns = document.querySelectorAll(`button[onclick*="startProject(${projectId})"], button[onclick*="stopProject(${projectId})"]`);
  btns.forEach((b) => {
    b.disabled = true;
    b.innerHTML = '<span class="btn-spinner"></span> Starting...';
  });

  const proj = state.projects.find((x) => x.id === projectId);
  if (proj) {
    proj.app_status = 'starting';
    if (proj.project_kind === 'service' && window.renderSingleServicePipeline) {
      window.renderSingleServicePipeline(projectId, 'source', 'running', 'CHECKING FILES & PORT');
      setTimeout(() => {
        if (proj.app_status === 'starting') window.renderSingleServicePipeline(projectId, 'deps', 'running', 'ENVIRONMENT & DEPS');
      }, 700);
      setTimeout(() => {
        if (proj.app_status === 'starting') window.renderSingleServicePipeline(projectId, 'daemon', 'running', 'SPAWNING DAEMON');
      }, 1400);
    }
  }

  try {
    const res = await api(`/api/projects/${projectId}/start`, { method: 'POST' });
    if (handleAutoDeployedRedirect(res, projectId)) return;
    if (proj) {
      proj.app_status = 'running';
      if (proj.project_kind === 'service' && window.renderSingleServicePipeline) {
        window.renderSingleServicePipeline(projectId, 'online', 'success', '');
      }
    }
    toast('Process started successfully.', 'success');
  } catch (err) {
    if (proj) {
      proj.app_status = 'stopped';
      if (proj.project_kind === 'service' && window.renderSingleServicePipeline) {
        window.renderSingleServicePipeline(projectId, 'daemon', 'failed', 'START FAILED');
      }
    }
    toast(`Start failed: ${err.message}`, 'error');
  } finally {
    state.lastWsBannerSig = null;
    await refreshCurrentViewsAfterLifecycle();
  }
}

export async function stopProject(projectId) {
  const btns = document.querySelectorAll(`button[onclick*="startProject(${projectId})"], button[onclick*="stopProject(${projectId})"]`);
  btns.forEach((b) => {
    b.disabled = true;
    b.innerHTML = '<span class="btn-spinner"></span> Stopping...';
  });

  const proj = state.projects.find((x) => x.id === projectId);
  if (proj) {
    proj.app_status = 'stopping';
    if (proj.project_kind === 'service' && window.renderSingleServicePipeline) {
      window.renderSingleServicePipeline(projectId, 'daemon', 'running', 'STOPPING...');
    }
  }

  try {
    await api(`/api/projects/${projectId}/stop`, { method: 'POST' });
    if (proj) {
      proj.app_status = 'stopped';
      if (proj.project_kind === 'service' && window.renderSingleServicePipeline) {
        window.renderSingleServicePipeline(projectId, 'source', 'idle', 'STOPPED');
      }
    }
    toast('Process stopped successfully.', 'info');
  } catch (err) {
    if (proj) {
      proj.app_status = 'running';
      if (proj.project_kind === 'service' && window.renderSingleServicePipeline) {
        window.renderSingleServicePipeline(projectId, 'online', 'success', '');
      }
    }
    toast(`Stop failed: ${err.message}`, 'error');
  } finally {
    state.lastWsBannerSig = null;
    await refreshCurrentViewsAfterLifecycle();
  }
}

export async function toggleMaintenanceMode(projectId) {
  try {
    const res = await api(`/api/projects/${projectId}/maintenance`, { method: 'POST', body: {} });
    if (res && res.maintenance) {
      toast('Maintenance Mode enabled — visitors now see the Under Maintenance page.', 'warning');
    } else {
      toast('Maintenance Mode disabled — live website resumed!', 'success');
    }
    state.lastWsBannerSig = null;
    await refreshCurrentViewsAfterLifecycle();
  } catch (err) {
    toast(`Maintenance toggle failed: ${err.message}`, 'error');
  }
}

export async function restartProject(projectId) {
  const btns = document.querySelectorAll(`button[onclick*="restartProject(${projectId})"]`);
  btns.forEach((b) => {
    b.disabled = true;
    b.innerHTML = '<span class="btn-spinner"></span> Restarting...';
  });

  const proj = state.projects.find((x) => x.id === projectId);
  if (proj) proj.app_status = 'starting';

  try {
    const res = await api(`/api/projects/${projectId}/restart`, { method: 'POST' });
    if (handleAutoDeployedRedirect(res, projectId)) return;
    if (proj) proj.app_status = 'running';
    toast('Application restarted successfully.', 'success');
  } catch (err) {
    toast(`Restart failed: ${err.message}`, 'error');
  } finally {
    state.lastWsBannerSig = null;
    await refreshCurrentViewsAfterLifecycle();
  }
}

// Bind globals for inline HTML event handlers
window.startProject = startProject;
window.stopProject = stopProject;
window.toggleMaintenanceMode = toggleMaintenanceMode;
window.restartProject = restartProject;
window.refreshCurrentViewsAfterLifecycle = refreshCurrentViewsAfterLifecycle;

