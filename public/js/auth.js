/**
 * WebDep Authentication & Security Subsystem
 * Auth lifecycle, login/2FA challenges, session state, and password security.
 */

import {
  state,
  openModal,
  closeModal,
  showConfirmDialog,
  escapeHtml,
  invalidateClientCache,
} from './state.js';
import { api, toast } from './api.js';
import { loadProjects } from './websites.js';
import { loadDatabases } from './databases.js';
import { navigateTo, handleHashRoute } from './workspace.js';
import { renderSecurityStatusSummary, loadSettingsView } from './settings.js';

// Re-export passkeys & QR code generation modules for 100% backward compatibility
export * from './auth_passkeys.js';
export * from './qrcode.js';

import {
  detectDefaultPasskeyDeviceName,
  loadPasskeysList,
} from './auth_passkeys.js';
import { renderTotpQrSvg } from './qrcode.js';

// ============================================================================
// Auth & Lifecycle
// ============================================================================
export function resetCleanUrl() {
  try {
    if (window.location.hash || window.location.search) {
      window.history.replaceState(null, '', window.location.pathname || '/');
    }
  } catch (_) {}
}

let presenceTimer = null;
let presenceListenersBound = false;
let lastUserInteractionAt = Date.now();
let lastReportedPresence = null;
let lastMouseTouchAt = 0;

function computePresenceState() {
  if (!state.user || !state.csrf) return null;
  if (document.hidden) return 'idle';
  return Date.now() - lastUserInteractionAt < 60_000 ? 'online' : 'idle';
}

async function sendPresenceUpdate(nextState, useKeepalive = false) {
  if (!state.user || !state.csrf || !nextState) return;
  lastReportedPresence = nextState;
  try {
    if (useKeepalive) {
      await fetch('/api/auth/presence', {
        method: 'POST',
        credentials: 'same-origin',
        keepalive: true,
        headers: {
          'Content-Type': 'application/json',
          'x-csrf-token': state.csrf,
        },
        body: JSON.stringify({ state: nextState }),
      });
    } else {
      await api('/api/auth/presence', {
        method: 'POST',
        body: { state: nextState },
      });
    }
  } catch (_) {}
}

function recordUserInteraction(throttled = false) {
  const now = Date.now();
  if (throttled && now - lastMouseTouchAt < 5000) return;
  lastMouseTouchAt = now;
  lastUserInteractionAt = now;
  if (state.user && !document.hidden && lastReportedPresence !== 'online') {
    void sendPresenceUpdate('online');
  }
}

export function stopPresenceHeartbeat() {
  if (presenceTimer) {
    clearInterval(presenceTimer);
    presenceTimer = null;
  }
  lastReportedPresence = null;
}

export function startPresenceHeartbeat() {
  lastUserInteractionAt = Date.now();
  if (!presenceListenersBound) {
    presenceListenersBound = true;
    window.addEventListener('pointerdown', () => recordUserInteraction(false), { passive: true });
    window.addEventListener('keydown', () => recordUserInteraction(false), { passive: true });
    window.addEventListener('mousemove', () => recordUserInteraction(true), { passive: true });
    window.addEventListener('scroll', () => recordUserInteraction(true), { passive: true });
    document.addEventListener('visibilitychange', () => {
      if (!state.user || !state.csrf) return;
      if (document.hidden) {
        void sendPresenceUpdate('idle', true);
      } else {
        lastUserInteractionAt = Date.now();
        void sendPresenceUpdate('online');
      }
    });
    window.addEventListener('pagehide', () => {
      if (state.user && state.csrf) {
        void sendPresenceUpdate('offline', true);
      }
    });
  }

  if (presenceTimer) clearInterval(presenceTimer);
  void sendPresenceUpdate(computePresenceState() || 'online');
  presenceTimer = setInterval(() => {
    const nextState = computePresenceState();
    if (nextState) void sendPresenceUpdate(nextState);
  }, 20_000);
}

export function stopPolling() {
  stopPresenceHeartbeat();
  if (state.overviewTimer) {
    clearInterval(state.overviewTimer);
    state.overviewTimer = null;
  }
  if (state.activeDepPollTimer) {
    clearInterval(state.activeDepPollTimer);
    state.activeDepPollTimer = null;
  }
  if (state.logEventSource) {
    try { state.logEventSource.close(); } catch (_) {}
    state.logEventSource = null;
  }
}

export async function initAuth() {
  document.body.classList.remove('auth-verified');
  const appEl = document.getElementById('app');
  if (appEl) {
    appEl.style.display = 'none';
    appEl.setAttribute('aria-hidden', 'true');
  }
  try {
    const me = await api('/api/auth/me', { noCache: true });
    if (!me || !me.user || !me.csrf) {
      showLogin();
      return;
    }
    state.user = me.user;
    state.csrf = me.csrf;
    state.activeSessions = me.activeSessions || 1;
    state.passkeyCount = me.passkeyCount || 0;
    await onAuthenticated(false);
  } catch {
    showLogin();
  }
}

export function showLogin() {
  stopPolling();
  document.body.classList.remove('auth-verified');

  state.user = null;
  state.csrf = null;
  state.pendingMfaToken = null;
  state.projects = [];
  state.overview = null;
  state.selectedProjectId = null;
  state.currentView = 'overview';
  state.lastOverviewSig = null;
  invalidateClientCache();
  try { sessionStorage.clear(); } catch (_) {}

  resetCleanUrl();
  document.querySelectorAll('.modal-overlay.active').forEach((m) => m.classList.remove('active'));

  const appEl = document.getElementById('app');
  if (appEl) {
    appEl.style.display = 'none';
    appEl.setAttribute('aria-hidden', 'true');
  }

  const loginView = document.getElementById('login-view');
  if (loginView) {
    loginView.style.display = 'flex';
    startLoginCanvasAnimation();
  }

  const lf = document.getElementById('login-form');
  const mf = document.getElementById('login-2fa-form');
  if (lf) lf.style.display = 'block';
  if (mf) mf.style.display = 'none';

  const passInput = document.getElementById('login-password');
  if (passInput) {
    passInput.value = '';
    passInput.type = 'password';
  }
  const toggleBtn = document.getElementById('toggle-pw-visibility');
  if (toggleBtn) toggleBtn.textContent = 'Show';
  const codeInput = document.getElementById('login-2fa-code');
  if (codeInput) codeInput.value = '';
}

let loginCanvasAnimId = null;
let loginCanvasCleanup = null;

export function startLoginCanvasAnimation() {
  stopLoginCanvasAnimation();
}

export function stopLoginCanvasAnimation() {
  if (loginCanvasAnimId) {
    cancelAnimationFrame(loginCanvasAnimId);
    loginCanvasAnimId = null;
  }
  if (loginCanvasCleanup) {
    loginCanvasCleanup();
    loginCanvasCleanup = null;
  }
}

export function togglePasswordField(inputId, btn) {
  const el = typeof inputId === 'string' ? document.getElementById(inputId) : inputId;
  if (!el || !btn) return;
  const isPass = el.type === 'password';
  el.type = isPass ? 'text' : 'password';
  btn.textContent = isPass ? 'Hide' : 'Show';
}

export function toggleLoginPasswordVisibility() {
  togglePasswordField('login-password', document.getElementById('toggle-pw-visibility'));
}

export function hasPower(power) {
  if (!state.user) return false;
  if (state.user.isMainAdmin) return true;
  const perms = state.user.permissions || [];
  return perms.includes('*') || perms.includes(power);
}

export function hasAnyPower(powers) {
  return Array.isArray(powers) && powers.some((p) => hasPower(p));
}

export async function onAuthenticated(isFreshLogin = false) {
  if (!state.user || !state.csrf || state.pendingMfaToken) {
    showLogin();
    return;
  }

  const curUserEl = document.getElementById('current-user-name');
  if (curUserEl) curUserEl.textContent = state.user.username;
  const curRoleEl = document.getElementById('current-user-role');
  if (curRoleEl) curRoleEl.textContent = state.user.isMainAdmin ? 'Main admin' : 'User';
  const curAvatarEl = document.getElementById('current-user-avatar');
  if (curAvatarEl) curAvatarEl.textContent = (state.user.username || 'AD').slice(0, 2).toUpperCase();

  const navPowerMap = {
    env: ['env'],
    domains: ['domains'],
    backups: ['backups'],
    databases: ['databases', 'databases_manage'],
  };
  Object.entries(navPowerMap).forEach(([view, pwrs]) => {
    const navEl = document.querySelector(`.nav-item[data-view="${view}"]`);
    if (navEl) navEl.style.display = hasAnyPower(pwrs) ? '' : 'none';
  });

  const addSiteBtn = document.getElementById('add-website-header-btn');
  if (addSiteBtn) addSiteBtn.style.display = hasPower('projects_manage') ? '' : 'none';
  const addSvcBtn = document.getElementById('add-service-header-btn');
  if (addSvcBtn) addSvcBtn.style.display = hasPower('services_manage') ? '' : 'none';
  const addDbBtn = document.getElementById('add-database-header-btn');
  if (addDbBtn) addDbBtn.style.display = hasPower('databases_manage') ? '' : 'none';

  const shouldLoadDbs = hasAnyPower(['databases', 'databases_manage']);
  await Promise.all([
    typeof loadProjects === 'function' ? loadProjects() : (window.loadProjects ? window.loadProjects() : Promise.resolve()),
    shouldLoadDbs
      ? (typeof loadDatabases === 'function' ? loadDatabases() : (window.loadDatabases ? window.loadDatabases() : Promise.resolve()))
      : Promise.resolve(),
  ]).catch((err) => {
    console.warn('Initial project/db load warning:', err);
  });

  const loginView = document.getElementById('login-view');
  if (loginView) loginView.style.display = 'none';
  stopLoginCanvasAnimation();
  const appEl = document.getElementById('app');
  if (appEl) {
    appEl.style.display = 'flex';
    appEl.setAttribute('aria-hidden', 'false');
  }
  document.body.classList.add('auth-verified');

  if (isFreshLogin) {
    if (typeof navigateTo === 'function') navigateTo('overview');
    else if (window.navigateTo) window.navigateTo('overview');
  } else {
    if (typeof handleHashRoute === 'function') handleHashRoute();
    else if (window.handleHashRoute) window.handleHashRoute();
  }
  startPresenceHeartbeat();
  if (typeof window.startPolling === 'function') window.startPolling();
}

export async function applyAuthSuccess(res) {
  state.pendingMfaToken = null;
  state.user = res.user;
  state.csrf = res.csrf;
  state.activeSessions = res.activeSessions || 1;
  state.passkeyCount = res.passkeyCount || 0;
  await onAuthenticated(true);
}

// Login Form & Two-Factor Challenge Listeners
document.getElementById('login-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = document.getElementById('login-username')?.value.trim();
  const password = document.getElementById('login-password')?.value;
  const btn = document.getElementById('login-btn');

  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Signing in';
  }

  try {
    const res = await api('/api/auth/login', { method: 'POST', body: { username, password } });
    if (res.requires2fa && res.mfaToken) {
      document.body.classList.remove('auth-verified');
      state.user = null;
      state.csrf = null;
      state.pendingMfaToken = res.mfaToken;
      resetCleanUrl();
      const lf = document.getElementById('login-form');
      if (lf) lf.style.display = 'none';
      const mf = document.getElementById('login-2fa-form');
      if (mf) mf.style.display = 'block';
      const unameLabel = document.getElementById('login-2fa-username');
      if (unameLabel) unameLabel.textContent = res.username || username;
      const codeInput = document.getElementById('login-2fa-code');
      if (codeInput) {
        codeInput.value = '';
        setTimeout(() => codeInput.focus(), 50);
      }
      toast('Enter your 6-digit authenticator code to complete sign-in.', 'info');
      return;
    }

    await applyAuthSuccess(res);
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Sign In';
    }
  }
});

document.getElementById('login-2fa-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const code = (document.getElementById('login-2fa-code')?.value || '').trim();
  const btn = document.getElementById('login-2fa-btn');
  if (!state.pendingMfaToken || !code) return;

  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Verifying 2FA';
  }

  try {
    const res = await api('/api/auth/2fa/verify-login', {
      method: 'POST',
      body: { mfaToken: state.pendingMfaToken, code },
    });
    await applyAuthSuccess(res);
    toast('Two-Factor Authentication verified.', 'success');
  } catch (err) {
    toast(err.message, 'error');
    if (err.message && (err.message.includes('expired') || err.message.includes('Locked'))) {
      showLogin();
    }
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Verify & Sign In';
    }
  }
});

document.getElementById('login-2fa-back-btn')?.addEventListener('click', () => {
  showLogin();
});

// Logout
document.getElementById('logout-btn')?.addEventListener('click', async () => {
  try {
    await api('/api/auth/logout', { method: 'POST' });
  } catch { /* ignore */ }
  showLogin();
});

// ============================================================================
// Account Security Modal (Password, TOTP 2FA & Active Sessions)
// ============================================================================
export function openSecurityModal(tab = 'password') {
  document.getElementById('change-password-form')?.reset();
  const pwdBar = document.getElementById('pwd-strength-bar');
  const pwdLbl = document.getElementById('pwd-strength-label');
  if (pwdBar) pwdBar.style.width = '0%';
  if (pwdLbl) pwdLbl.textContent = '';

  const is2fa = Boolean(state.user?.totpEnabled);
  const pwd2faGrp = document.getElementById('pwd-2fa-group');
  if (pwd2faGrp) pwd2faGrp.style.display = is2fa ? 'block' : 'none';

  const disBox = document.getElementById('sec-2fa-disabled-box');
  const enBox = document.getElementById('sec-2fa-enabled-box');
  if (disBox) disBox.style.display = is2fa ? 'none' : 'block';
  if (enBox) enBox.style.display = is2fa ? 'block' : 'none';

  const s1 = document.getElementById('sec-2fa-step1-password');
  if (s1) s1.style.display = 'block';
  const s2 = document.getElementById('sec-2fa-step2-verify');
  if (s2) s2.style.display = 'none';
  const s3 = document.getElementById('sec-2fa-step3-recovery');
  if (s3) s3.style.display = 'none';

  const setupPwd = document.getElementById('tfa-setup-password');
  if (setupPwd) setupPwd.value = '';
  const disPwd = document.getElementById('tfa-disable-password');
  if (disPwd) disPwd.value = '';
  const disCode = document.getElementById('tfa-disable-code');
  if (disCode) disCode.value = '';

  renderSecurityStatusSummary();
  switchSecurityTab(tab);
  openModal('modal-change-password');
}

export function switchSecurityTab(tab) {
  ['passkeys', 'password', '2fa', 'sessions'].forEach((t) => {
    const btn = document.getElementById(`sec-tab-btn-${t}`);
    const pane = document.getElementById(`sec-pane-${t}`);
    if (btn) btn.classList.toggle('active', t === tab);
    if (pane) pane.style.display = t === tab ? 'block' : 'none';
  });
  if (tab === 'passkeys') {
    const nameInput = document.getElementById('passkey-device-name');
    if (nameInput && !nameInput.value.trim()) {
      nameInput.value = detectDefaultPasskeyDeviceName();
    }
    const httpsHint = document.getElementById('passkey-https-hint');
    if (httpsHint) {
      httpsHint.style.display = window.PublicKeyCredential ? 'none' : 'block';
    }
    void loadPasskeysList();
  }
}

// Password strength meter
document.getElementById('pwd-next')?.addEventListener('input', (e) => {
  const val = e.target.value || '';
  const bar = document.getElementById('pwd-strength-bar');
  const lbl = document.getElementById('pwd-strength-label');
  if (!bar || !lbl) return;

  let score = 0;
  if (val.length >= 8) score += 25;
  if (val.length >= 12) score += 25;
  if (/[A-Z]/.test(val) && /[a-z]/.test(val)) score += 25;
  if (/[0-9]/.test(val) || /[^A-Za-z0-9]/.test(val)) score += 25;

  bar.style.width = `${score}%`;
  if (!val.length) {
    lbl.textContent = '';
  } else if (score <= 25) {
    bar.className = 'progress-fill rose';
    lbl.textContent = 'Weak';
    lbl.style.color = 'var(--danger-light)';
  } else if (score <= 50) {
    bar.className = 'progress-fill amber';
    lbl.textContent = 'Fair';
    lbl.style.color = 'var(--warning-light)';
  } else if (score <= 75) {
    bar.className = 'progress-fill green';
    lbl.textContent = 'Good';
    lbl.style.color = 'var(--success-light)';
  } else {
    bar.className = 'progress-fill green';
    lbl.textContent = 'Strong';
    lbl.style.color = 'var(--success-light)';
  }
});

document.getElementById('save-change-password-btn')?.addEventListener('click', async (e) => {
  e.preventDefault();
  const current = document.getElementById('pwd-current')?.value;
  const next = document.getElementById('pwd-next')?.value;
  const confirm = document.getElementById('pwd-confirm')?.value;
  const totpCode = document.getElementById('pwd-2fa-code')?.value || '';
  const revokeOtherSessions = Boolean(document.getElementById('pwd-revoke-others')?.checked ?? true);

  if (!current) {
    toast('Please enter your current password.', 'warning');
    return;
  }
  if (next !== confirm) {
    toast('New passwords do not match.', 'warning');
    return;
  }
  if (next.length < 8) {
    toast('New password must be at least 8 characters long.', 'warning');
    return;
  }

  try {
    const res = await api('/api/auth/password', {
      method: 'POST',
      body: { current, next, totpCode, revokeOtherSessions },
    });
    if (revokeOtherSessions) state.activeSessions = 1;
    renderSecurityStatusSummary();
    toast(
      res.revokedSessions
        ? `Password updated and ${res.revokedSessions} other session(s) signed out.`
        : 'Password updated in SQLite.',
      'success'
    );
    closeModal('modal-change-password');
  } catch (err) {
    toast(`Failed to change password: ${err.message}`, 'error');
  }
});

export async function start2faSetup() {
  const password = document.getElementById('tfa-setup-password')?.value || '';
  if (!password) {
    toast('Please enter your current password to begin 2FA setup.', 'warning');
    return;
  }
  try {
    const res = await api('/api/auth/2fa/setup', { method: 'POST', body: { password } });
    state.pending2faSecret = res.secret;
    const formattedSecret = (res.secret || '').replace(/(.{4})/g, '$1 ').trim();
    const secretEl = document.getElementById('tfa-secret-display');
    if (secretEl) secretEl.value = formattedSecret;

    const qrBox = document.getElementById('tfa-qr-container');
    if (qrBox) {
      qrBox.innerHTML = renderTotpQrSvg(res.otpauthUrl || res.secret);
    }

    const s1 = document.getElementById('sec-2fa-step1-password');
    if (s1) s1.style.display = 'none';
    const s2 = document.getElementById('sec-2fa-step2-verify');
    if (s2) s2.style.display = 'block';
    const verifyInput = document.getElementById('tfa-verify-code');
    if (verifyInput) {
      verifyInput.value = '';
      setTimeout(() => verifyInput.focus(), 50);
    }
    toast('Scan the QR code or copy the setup key into your authenticator app.', 'info');
  } catch (err) {
    toast(`2FA setup failed: ${err.message}`, 'error');
  }
}

export function copy2faSecret() {
  const raw = state.pending2faSecret || document.getElementById('tfa-secret-display')?.value || '';
  navigator.clipboard.writeText(raw.replace(/\s+/g, '')).then(() => {
    toast('2FA Base32 secret copied to clipboard.', 'success');
  }).catch((err) => {
    toast(`Failed to copy to clipboard: ${err.message}`, 'error');
  });
}

export async function confirmEnable2fa() {
  const raw = (document.getElementById('tfa-verify-code')?.value || '').trim();
  const code = raw.replace(/\D/g, '');
  if (code.length !== 6) {
    toast('Please enter the 6-digit code from your authenticator app.', 'warning');
    return;
  }
  try {
    const res = await api('/api/auth/2fa/enable', { method: 'POST', body: { code } });
    if (state.user) state.user.totpEnabled = true;
    state.lastRecoveryCodes = res.backupCodes || [];
    renderSecurityStatusSummary();
    if (state.currentView === 'settings') await loadSettingsView();

    const grid = document.getElementById('tfa-recovery-codes-grid');
    if (grid) {
      grid.innerHTML = (res.backupCodes || []).map((c) => `<div style="padding:4px; background:rgba(255,255,255,0.04); border-radius:4px;">${escapeHtml(c)}</div>`).join('');
    }
    const s2 = document.getElementById('sec-2fa-step2-verify');
    if (s2) s2.style.display = 'none';
    const s3 = document.getElementById('sec-2fa-step3-recovery');
    if (s3) s3.style.display = 'block';
    toast('Two-Factor Authentication enabled.', 'success');
  } catch (err) {
    toast(`Verification failed: ${err.message}`, 'error');
  }
}

document.getElementById('tfa-setup-password')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    void start2faSetup();
  }
});

document.getElementById('tfa-verify-code')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    void confirmEnable2fa();
  }
});

document.getElementById('tfa-disable-code')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    void disable2fa();
  }
});

export function copyRecoveryCodes() {
  const codes = (state.lastRecoveryCodes || []).join('\n');
  if (!codes) return;
  navigator.clipboard.writeText(codes).then(() => {
    toast('Recovery codes copied to clipboard.', 'success');
  }).catch((err) => {
    toast(`Failed to copy to clipboard: ${err.message}`, 'error');
  });
}

export async function disable2fa() {
  const password = document.getElementById('tfa-disable-password')?.value || '';
  const code = (document.getElementById('tfa-disable-code')?.value || '').trim();
  if (!password || !code) {
    toast('Please enter both your current password and a 6-digit 2FA or recovery code.', 'warning');
    return;
  }
  try {
    await api('/api/auth/2fa/disable', { method: 'POST', body: { password, code } });
    if (state.user) state.user.totpEnabled = false;
    renderSecurityStatusSummary();
    toast('Two-Factor Authentication has been disabled.', 'info');
    closeModal('modal-change-password');
  } catch (err) {
    toast(`Disable 2FA failed: ${err.message}`, 'error');
  }
}

export async function revokeOtherSessions() {
  try {
    const res = await api('/api/auth/sessions/revoke-others', { method: 'POST' });
    state.activeSessions = 1;
    renderSecurityStatusSummary();
    toast(`Signed out ${res.revoked || 0} other active session(s).`, 'success');
  } catch (err) {
    toast(`Failed to revoke sessions: ${err.message}`, 'error');
  }
}

export async function adminResetUser2fa(userId, username) {
  const ok = await showConfirmDialog({
    title: 'Reset User 2FA',
    message: `Are you sure you want to disable and reset Two-Factor Authentication for "${username}"?`,
    confirmText: 'Reset 2FA',
    danger: true,
  });
  if (!ok) return;
  try {
    await api(`/api/users/${userId}/reset-2fa`, { method: 'POST' });
    toast(`Reset 2FA for "${username}".`, 'success');
    await loadSettingsView();
  } catch (err) {
    toast(`Reset 2FA failed: ${err.message}`, 'error');
  }
}

// Bind globals for onclick inline HTML handlers
window.resetCleanUrl = resetCleanUrl;
window.stopPolling = stopPolling;
window.initAuth = initAuth;
window.showLogin = showLogin;
window.applyAuthSuccess = applyAuthSuccess;
window.onAuthenticated = onAuthenticated;
window.startLoginCanvasAnimation = startLoginCanvasAnimation;
window.stopLoginCanvasAnimation = stopLoginCanvasAnimation;
window.togglePasswordField = togglePasswordField;
window.toggleLoginPasswordVisibility = toggleLoginPasswordVisibility;
window.hasPower = hasPower;
window.hasAnyPower = hasAnyPower;
window.openSecurityModal = openSecurityModal;
window.switchSecurityTab = switchSecurityTab;
window.start2faSetup = start2faSetup;
window.copy2faSecret = copy2faSecret;
window.confirmEnable2fa = confirmEnable2fa;
window.copyRecoveryCodes = copyRecoveryCodes;
window.disable2fa = disable2fa;
window.revokeOtherSessions = revokeOtherSessions;
window.adminResetUser2fa = adminResetUser2fa;
