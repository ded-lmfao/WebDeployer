/**
 * WebDep Caddy Reverse Proxy & Domain Management Subsystem
 * Handles custom domain routing, SSL automation via Let's Encrypt / ZeroSSL, and Caddyfile generation.
 */

import { state, escapeHtml, openModal } from './state.js';
import { api, toast } from './api.js';

let activeNginxProjectId = null;

export function renderCaddyModalBanner(p) {
  const banner = document.getElementById('nginx-modal-status-banner');
  if (!banner || !p) return;
  const activeDomains = Array.isArray(p.domains) ? p.domains.filter(Boolean) : [];
  const domainsHtml = activeDomains.length
    ? activeDomains.map((d) => `
        <span style="display:inline-flex; align-items:center; gap:6px; background:var(--bg-card-hover); border:1px solid var(--border-medium); border-radius:var(--radius-sm); padding:2px 8px; margin-right:4px;">
          <a href="https://${escapeHtml(d)}" target="_blank" style="color:var(--accent-light); font-family:var(--font-mono); font-weight:500; text-decoration:none;">${escapeHtml(d)} &nearr;</a>
          <button type="button" onclick="removeSingleCaddyDomain('${escapeHtml(d)}')" title="Remove domain" style="background:none; border:none; color:var(--text-muted); cursor:pointer; font-size:13px; line-height:1; padding:0 2px;">&times;</button>
        </span>
      `).join('')
    : '<code style="color:var(--text-muted); font-weight:500;">Local only (127.0.0.1:' + (p.port || 3000) + ')</code>';

  banner.innerHTML = `
    <div style="background: var(--bg-card); padding: 12px; border-radius: var(--radius-md); font-size: 13px; border: 1px solid var(--border-subtle);">
      <div><strong>Reverse Proxy:</strong> <span class="badge badge-success">Caddy</span> &bull; <code>Port ${p.port || 3000}</code></div>
      <div style="margin-top: 6px; display:flex; align-items:center; flex-wrap:wrap; gap:4px;"><strong>Domains:</strong> ${domainsHtml}</div>
      <div style="margin-top: 6px;"><strong>Automatic HTTPS:</strong> <span class="badge badge-success">Let's Encrypt / ZeroSSL (Active)</span></div>
    </div>
  `;
}

export async function openNginxModal(projectId) {
  activeNginxProjectId = projectId;
  const p = state.projects.find((x) => x.id === projectId);
  if (!p) return;

  const domainInput = document.getElementById('caddy-domains-input');
  if (domainInput) {
    domainInput.value = (p.domains || []).join(', ');
    domainInput.onkeydown = (ev) => {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        void saveCaddyDomains();
      }
    };
  }

  const preview = document.getElementById('nginx-config-preview');
  renderCaddyModalBanner(p);
  if (preview) preview.value = 'Generating Caddyfile configuration';
  openModal('modal-nginx');

  try {
    const data = await api(`/api/projects/${projectId}/caddy`, { noCache: true });
    if (preview && data.config) preview.value = data.config;
    if (Array.isArray(data.domains)) {
      p.domains = data.domains;
      if (domainInput) domainInput.value = data.domains.join(', ');
    }
    renderCaddyModalBanner(p);
  } catch (err) {
    if (preview) preview.value = `Failed to generate configuration: ${err.message}`;
  }
}

export function cleanDomainList(rawStr) {
  if (!rawStr) return [];
  return rawStr
    .split(/[\n,;]+/)
    .map((s) => s.trim().replace(/^https?:\/\//i, '').split('/')[0].trim().toLowerCase())
    .filter(Boolean);
}

export async function removeSingleCaddyDomain(domainToRemove) {
  const p = state.projects.find((x) => x.id === activeNginxProjectId);
  if (!p) return;
  const remaining = (p.domains || []).filter((d) => d !== domainToRemove);
  const input = document.getElementById('caddy-domains-input');
  if (input) input.value = remaining.join(', ');
  await saveCaddyDomains();
}

export async function saveCaddyDomains() {
  if (!activeNginxProjectId) return;
  const input = document.getElementById('caddy-domains-input');
  const domains = cleanDomainList(input?.value || '');
  if (input) input.value = domains.join(', ');

  const btn = document.getElementById('caddy-save-domains-btn');
  const applyBtn = document.getElementById('nginx-apply-btn');
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Saving';
  }
  if (applyBtn) {
    applyBtn.disabled = true;
    applyBtn.textContent = 'Applying Caddy';
  }

  try {
    const res = await api(`/api/projects/${activeNginxProjectId}/caddy/apply`, {
      method: 'POST',
      body: { domains },
    });
    const savedDomains = (res && Array.isArray(res.domains)) ? res.domains : domains;
    const p = state.projects.find((x) => x.id === activeNginxProjectId);
    if (p) {
      p.domains = savedDomains;
      renderCaddyModalBanner(p);
    }
    const preview = document.getElementById('nginx-config-preview');
    if (preview && res && res.config) {
      preview.value = res.config;
    }

    toast(
      savedDomains.length
        ? `Custom domain(s) saved & applied: ${savedDomains.join(', ')}`
        : 'Cleared custom domains (Local-only mode).',
      'success'
    );

    if (window.loadProjects) await window.loadProjects();
    if (window.renderWebsiteWorkspaceHeader) window.renderWebsiteWorkspaceHeader();
    if (state.currentView === 'projects' && window.renderProjectsList) window.renderProjectsList();
    if (state.currentView === 'overview' && window.loadOverview) await window.loadOverview();
  } catch (err) {
    toast(`Failed to update domains: ${err.message}`, 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Save & Apply';
    }
    if (applyBtn) {
      applyBtn.disabled = false;
      applyBtn.textContent = 'Apply & Reload Caddy';
    }
  }
}

// Attach event listeners
document.getElementById('nginx-certbot-btn')?.addEventListener('click', async () => {
  if (!activeNginxProjectId) return;
  toast('Running Let\'s Encrypt Certbot. This may take up to 30 seconds.', 'info');
  try {
    await api(`/api/projects/${activeNginxProjectId}/nginx/certbot`, { method: 'POST' });
    toast('SSL certificate provisioned with Let\'s Encrypt.', 'success');
    await openNginxModal(activeNginxProjectId);
  } catch (err) {
    toast(`Certbot failed: ${err.message}`, 'error');
  }
});

// Bind globals for onclick inline HTML handlers
window.openNginxModal = openNginxModal;
window.cleanDomainList = cleanDomainList;
window.removeSingleCaddyDomain = removeSingleCaddyDomain;
window.saveCaddyDomains = saveCaddyDomains;

