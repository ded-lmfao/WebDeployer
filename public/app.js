/**
 * WebDep — Frontend Application Controller (Modular ES6 Entrypoint)
 * Single-Page Reactive Client for Self-Hosted Multi-Website Deployment Platform
 */

// Core Services & Shared Reactive State
import './js/icons.js';
import { state, WEBSITE_WORKSPACE_TABS } from './js/state.js';
import {
  animateModalClose,
  animateMobileDrawer,
  initGlobalMotionInteractions,
} from './js/motion_ui.js';
import { syncThemeFromServer } from './js/themes.js';
import { initAuth } from './js/auth.js';

// Domain Views & Subsystems
import { loadOverview } from './js/overview.js';
import { loadProjects, renderProjectsList, openAddWebsiteModal } from './js/websites.js';
import { renderServicesList } from './js/services.js';
import { navigateTo, renderCurrentView, renderWebsiteWorkspaceHeader } from './js/workspace.js';
import { loadDatabases, renderDatabasesList } from './js/databases.js';
import { loadDeploymentsView, loadReleasesView, loadRollbacksView, waterPipelines } from './js/deployments.js';
import { loadMonitorView } from './js/settings.js';

// Explorer & Logs Subsystems (Initialize listeners & exports)
import './js/files.js';
import './js/logs.js';

// ============================================================================
// Global Polling & Live Updates (Low Resource & Page Visibility Aware)
// ============================================================================
let pollInFlight = false;

async function pollTick() {
  if (pollInFlight || document.hidden || state.filesOpenPath) return;
  pollInFlight = true;
  try {
    if (state.currentView === 'overview') {
      await loadOverview();
      return;
    }

    // Keep sidebar badges (databases & projects & services) up-to-date on non-overview tabs
    await Promise.all([
      loadProjects().catch(() => {}),
      loadDatabases().catch(() => {})
    ]);

    if (state.currentView === 'services') {
      renderServicesList();
    } else if (state.currentView === 'projects') {
      renderProjectsList();
    } else if (state.currentView === 'deployments') {
      renderWebsiteWorkspaceHeader();
      await loadDeploymentsView();
    } else if (state.currentView === 'monitor') {
      renderWebsiteWorkspaceHeader();
      await loadMonitorView();
    } else if (state.currentView === 'releases') {
      renderWebsiteWorkspaceHeader();
      await loadReleasesView();
    } else if (state.currentView === 'rollbacks') {
      renderWebsiteWorkspaceHeader();
      await loadRollbacksView();
    } else if (state.currentView === 'databases') {
      const anyLooping = Object.values(waterPipelines).some((p) => p && p.isLooping);
      if (!anyLooping) {
        renderDatabasesList();
      }
    } else if (WEBSITE_WORKSPACE_TABS.has(state.currentView)) {
      renderWebsiteWorkspaceHeader();
    }
  } finally {
    pollInFlight = false;
  }
}

function startPolling() {
  if (state.overviewTimer) clearInterval(state.overviewTimer);
  state.overviewTimer = setInterval(pollTick, 4500);
}
window.startPolling = startPolling;

// Low-power background mode: instantly resume fresh data when user re-focuses tab
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    void pollTick();
  }
});

window.addEventListener('beforeunload', () => {
  if (state.logEventSource) {
    state.logEventSource.close();
    state.logEventSource = null;
  }
});


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
document.getElementById('add-website-btn')?.addEventListener('click', openAddWebsiteModal);


// Mobile navigation drawer toggle
const mobileToggle = document.getElementById('mobile-sidebar-toggle');
const sidebarEl = document.querySelector('.sidebar');
const backdropEl = document.getElementById('sidebar-backdrop');
if (mobileToggle && sidebarEl && backdropEl) {
  mobileToggle.addEventListener('click', () => {
    const nextOpen = !sidebarEl.classList.contains('mobile-open');
    animateMobileDrawer(sidebarEl, backdropEl, nextOpen);
  });
  backdropEl.addEventListener('click', () => {
    animateMobileDrawer(sidebarEl, backdropEl, false);
  });
}


document.querySelectorAll('[data-close-modal]').forEach((btn) => {
  btn.addEventListener('click', (e) => {
    const modal = e.target.closest('.modal-overlay');
    if (modal) animateModalClose(modal);
  });
});

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    document.querySelectorAll('.modal-overlay.active').forEach((m) => animateModalClose(m));
  }
});


// Start application
initGlobalMotionInteractions();
void syncThemeFromServer();
void initAuth();
