/**
 * WebDep Authentication & Security Subsystem
 * Auth lifecycle, login/2FA challenges, WebAuthn passkeys, and pure-JS QR code generator
 */

import {
  state,
  openModal,
  closeModal,
  showConfirmDialog,
  showPromptDialog,
  showCopyDialog,
  escapeHtml,
  formatDate,
  copyTextToClipboard,
} from './state.js';
import { api, toast } from './api.js';

// ============================================================================
// Auth & Lifecycle
// ============================================================================
function resetCleanUrl() {
  try {
    if (window.location.hash || window.location.search) {
      window.history.replaceState(null, '', window.location.pathname || '/');
    }
  } catch (_) {}
}

function stopPolling() {
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

async function initAuth() {
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

function showLogin() {
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

  // Reset URL to clean root (strip #/settings, #/projects, query params, etc.)
  resetCleanUrl();

  // Close any open modals
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

function startLoginCanvasAnimation() {
  // Clean, minimalist pre-auth: 0% CPU, no heavy background animation loops
  stopLoginCanvasAnimation();
}

function stopLoginCanvasAnimation() {
  if (loginCanvasAnimId) {
    cancelAnimationFrame(loginCanvasAnimId);
    loginCanvasAnimId = null;
  }
  if (loginCanvasCleanup) {
    loginCanvasCleanup();
    loginCanvasCleanup = null;
  }
}
window.startLoginCanvasAnimation = startLoginCanvasAnimation;
window.stopLoginCanvasAnimation = stopLoginCanvasAnimation;

function togglePasswordField(inputId, btn) {
  const el = typeof inputId === 'string' ? document.getElementById(inputId) : inputId;
  if (!el || !btn) return;
  const isPass = el.type === 'password';
  el.type = isPass ? 'text' : 'password';
  btn.textContent = isPass ? 'Hide' : 'Show';
}
window.togglePasswordField = togglePasswordField;

function toggleLoginPasswordVisibility() {
  togglePasswordField('login-password', document.getElementById('toggle-pw-visibility'));
}
window.toggleLoginPasswordVisibility = toggleLoginPasswordVisibility;

function hasPower(power) {
  if (!state.user) return false;
  if (state.user.isMainAdmin) return true;
  const perms = state.user.permissions || [];
  return perms.includes('*') || perms.includes(power);
}
window.hasPower = hasPower;

async function onAuthenticated(isFreshLogin = false) {
  if (!state.user || !state.csrf || state.pendingMfaToken) {
    showLogin();
    return;
  }

  document.getElementById('current-user-name').textContent = state.user.username;
  document.getElementById('current-user-role').textContent = state.user.isMainAdmin ? 'MAIN ADMIN' : (state.user.role || 'operator').toUpperCase();
  document.getElementById('current-user-avatar').textContent = (state.user.username || 'AD').slice(0, 2).toUpperCase();

  // Adapt UI controls to user's granted powers
  const addSiteBtn = document.getElementById('global-add-website-btn');
  if (addSiteBtn) addSiteBtn.style.display = hasPower('projects_manage') ? '' : 'none';

  const navPowerMap = {
    env: 'env',
    domains: 'domains',
    backups: 'backups',
  };
  Object.entries(navPowerMap).forEach(([view, pwr]) => {
    const navEl = document.querySelector(`.nav-item[data-view="${view}"]`);
    if (navEl) navEl.style.display = hasPower(pwr) ? '' : 'none';
  });

  // Load projects and databases before revealing the main application shell
  await Promise.all([loadProjects(), loadDatabases()]);

  document.getElementById('login-view').style.display = 'none';
  stopLoginCanvasAnimation();
  const appEl = document.getElementById('app');
  if (appEl) {
    appEl.style.display = 'flex';
    appEl.setAttribute('aria-hidden', 'false');
  }
  document.body.classList.add('auth-verified');

  if (isFreshLogin) {
    navigateTo('overview');
  } else {
    handleHashRoute();
  }
  startPolling();
}

async function applyAuthSuccess(res) {
  state.pendingMfaToken = null;
  state.user = res.user;
  state.csrf = res.csrf;
  state.activeSessions = res.activeSessions || 1;
  state.passkeyCount = res.passkeyCount || 0;
  await onAuthenticated(true);
}


// Login Form & Two-Factor Challenge
document.getElementById('login-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = document.getElementById('login-username').value.trim();
  const password = document.getElementById('login-password').value;
  const btn = document.getElementById('login-btn');

  btn.disabled = true;
  btn.textContent = 'Signing in...';

  try {
    const res = await api('/api/auth/login', { method: 'POST', body: { username, password } });
    if (res.requires2fa && res.mfaToken) {
      document.body.classList.remove('auth-verified');
      state.user = null;
      state.csrf = null;
      state.pendingMfaToken = res.mfaToken;
      resetCleanUrl();
      document.getElementById('login-form').style.display = 'none';
      document.getElementById('login-2fa-form').style.display = 'block';
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
    btn.disabled = false;
    btn.textContent = 'Sign In';
  }
});

document.getElementById('login-2fa-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const code = (document.getElementById('login-2fa-code')?.value || '').trim();
  const btn = document.getElementById('login-2fa-btn');
  if (!state.pendingMfaToken || !code) return;

  btn.disabled = true;
  btn.textContent = 'Verifying 2FA...';

  try {
    const res = await api('/api/auth/2fa/verify-login', {
      method: 'POST',
      body: { mfaToken: state.pendingMfaToken, code },
    });
    await applyAuthSuccess(res);
    toast('Two-Factor Authentication verified!', 'success');
  } catch (err) {
    toast(err.message, 'error');
    if (err.message && (err.message.includes('expired') || err.message.includes('Locked'))) {
      showLogin();
    }
  } finally {
    btn.disabled = false;
    btn.textContent = 'Verify & Sign In';
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
function openSecurityModal(tab = 'password') {
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

  document.getElementById('sec-2fa-step1-password')?.style && (document.getElementById('sec-2fa-step1-password').style.display = 'block');
  document.getElementById('sec-2fa-step2-verify')?.style && (document.getElementById('sec-2fa-step2-verify').style.display = 'none');
  document.getElementById('sec-2fa-step3-recovery')?.style && (document.getElementById('sec-2fa-step3-recovery').style.display = 'none');
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
window.openSecurityModal = openSecurityModal;

function switchSecurityTab(tab) {
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
window.switchSecurityTab = switchSecurityTab;

function base64UrlToUint8Array(base64Url) {
  const padding = '='.repeat((4 - (base64Url.length % 4)) % 4);
  const base64 = (base64Url + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

function bufferToBase64Url(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  let b64 = window.btoa(binary).replace(/\+/g, '-').replace(/\//g, '_');
  while (b64.endsWith('=')) {
    b64 = b64.slice(0, -1);
  }
  return b64;
}

function detectDefaultPasskeyDeviceName() {
  const ua = navigator.userAgent || '';
  if (/iPhone/i.test(ua)) return 'iPhone Face ID';
  if (/iPad/i.test(ua)) return 'iPad Face ID / Touch ID';
  if (/Android/i.test(ua)) return 'Android Fingerprint';
  if (/Macintosh|Mac OS X/i.test(ua)) return 'Mac Touch ID';
  if (/Windows/i.test(ua)) return 'Windows Hello';
  return 'Passkey / Biometric Device';
}

async function loadPasskeysList() {
  const container = document.getElementById('passkeys-list-container');
  try {
    const res = await api('/api/auth/passkeys', { noCache: true });
    const list = Array.isArray(res?.passkeys) ? res.passkeys : [];
    state.passkeysList = list;
    state.passkeyCount = list.length;
    renderSecurityStatusSummary();
    if (!container) return;
    if (!list.length) {
      container.innerHTML = `
        <div style="font-size: 12.5px; color: var(--text-dim); padding: 14px; text-align: center; border: 1px dashed var(--border-subtle); border-radius: var(--radius-md);">
          No passkeys or biometric devices registered yet. Add your phone or laptop above to sign in with Face ID or Fingerprint.
        </div>
      `;
      return;
    }
    container.innerHTML = list.map((pk) => {
      const addedText = pk.createdAt ? formatDate(pk.createdAt) : '--';
      const usedText = pk.lastUsedAt ? `Last used ${formatRelativeTime(pk.lastUsedAt)}` : 'Never used yet';
      return `
        <div style="display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 10px 12px; background: var(--bg-surface-elevated); border: 1px solid var(--border-subtle); border-radius: var(--radius-md);">
          <div style="display: flex; align-items: center; gap: 10px; min-width: 0;">
            <div style="width: 32px; height: 32px; border-radius: 6px; background: var(--info-bg); border: 1px solid var(--info-border); color: var(--accent-light); display: flex; align-items: center; justify-content: center; flex-shrink: 0;">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 10a2 2 0 0 0-2 2c0 1.02-.1 2.51-.26 4"/><path d="M14 13.12c0 2.38 0 6.38-1 8.88"/><path d="M2 12a10 10 0 0 1 18-6"/><path d="M5 19.5C5.5 18 6 15 6 12a6 6 0 0 1 .34-2"/><path d="M9 6.8a6 6 0 0 1 9 5.2v2"/></svg>
            </div>
            <div style="min-width: 0;">
              <div style="font-size: 13px; font-weight: 600; color: var(--text-main); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${escapeHtml(pk.name)}</div>
              <div style="font-size: 11px; color: var(--text-dim);">Added ${escapeHtml(addedText)} &bull; ${escapeHtml(usedText)}</div>
            </div>
          </div>
          <button type="button" class="btn btn-danger btn-xs" onclick="deletePasskey(${pk.id}, '${escapeHtml(pk.name)}')">Remove</button>
        </div>
      `;
    }).join('');
  } catch (err) {
    if (container) {
      container.innerHTML = `<div style="font-size: 12px; color: var(--danger-light); padding: 10px;">${escapeHtml(err.message)}</div>`;
    }
  }
}
window.loadPasskeysList = loadPasskeysList;

async function registerNewPasskey() {
  if (!window.isSecureContext || !window.PublicKeyCredential || !navigator.credentials?.create) {
    const origin = window.location.origin;
    toast(
      `Passkeys / Biometrics require HTTPS (https://your-domain.com) or localhost. Current URL (${origin}) is plain HTTP.`,
      'warning'
    );
    await showCopyDialog({
      title: 'HTTPS Required for Face ID / Fingerprint (WebAuthn)',
      message: `Browsers block Face ID, Touch ID, and Fingerprint on plain HTTP IP URLs (${origin}).\n\n• On iPhone / Android: Open this panel via your HTTPS domain (https://...).\n• On Desktop Chrome / Brave / Edge (for testing over HTTP IP): Open chrome://flags/#unsafely-treat-insecure-origin-as-secure and paste this origin:`,
      value: origin,
    });
    return;
  }
  const nameInput = document.getElementById('passkey-device-name');
  const label = (nameInput?.value || '').trim() || detectDefaultPasskeyDeviceName();
  const btn = document.getElementById('register-passkey-btn');
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<span>Waiting for Face ID / Fingerprint...</span>';
  }
  try {
    const start = await api('/api/auth/passkeys/register/start', { method: 'POST', body: {} });
    const buildOptions = (usePlatformAttachment) => {
      const authenticatorSelection = {
        userVerification: 'preferred',
        residentKey: 'preferred',
      };
      if (usePlatformAttachment) {
        authenticatorSelection.authenticatorAttachment = 'platform';
      }
      return {
        challenge: base64UrlToUint8Array(start.challenge),
        rp: {
          name: 'WebDep Deployment Platform',
        },
        user: {
          id: base64UrlToUint8Array(start.user.id),
          name: start.user.name,
          displayName: start.user.displayName,
        },
        pubKeyCredParams: [
          { type: 'public-key', alg: -7 },   // ES256 (NIST P-256)
          { type: 'public-key', alg: -257 }, // RS256 fallback for spec compliance
        ],
        authenticatorSelection,
        timeout: 60000,
        attestation: 'none',
        excludeCredentials: (start.excludeCredentials || []).map((cid) => ({
          type: 'public-key',
          id: base64UrlToUint8Array(cid),
        })),
      };
    };

    let cred;
    try {
      cred = await navigator.credentials.create({ publicKey: buildOptions(true) });
    } catch (platformErr) {
      if (platformErr && (platformErr.name === 'NotSupportedError' || platformErr.name === 'InvalidStateError')) {
        cred = await navigator.credentials.create({ publicKey: buildOptions(false) });
      } else {
        throw platformErr;
      }
    }

    if (!cred || !cred.response) {
      throw new Error('Passkey registration was cancelled.');
    }

    let publicKeySpki = null;
    try {
      if (typeof cred.response.getPublicKey === 'function') {
        const spkiBuf = cred.response.getPublicKey();
        if (spkiBuf) publicKeySpki = bufferToBase64Url(spkiBuf);
      }
    } catch (_) {}

    let authenticatorData = null;
    try {
      if (typeof cred.response.getAuthenticatorData === 'function') {
        const adBuf = cred.response.getAuthenticatorData();
        if (adBuf) authenticatorData = bufferToBase64Url(adBuf);
      }
    } catch (_) {}

    const finishRes = await api('/api/auth/passkeys/register/finish', {
      method: 'POST',
      body: {
        challengeId: start.challengeId,
        name: label,
        credentialId: bufferToBase64Url(cred.rawId),
        publicKeySpki,
        authenticatorData,
        attestationObject: bufferToBase64Url(cred.response.attestationObject),
        clientDataJSON: bufferToBase64Url(cred.response.clientDataJSON),
      },
    });

    state.passkeysList = finishRes.passkeys || [];
    state.passkeyCount = state.passkeysList.length;
    renderSecurityStatusSummary();
    await loadPasskeysList();
    toast(`Passkey "${label}" registered! You can now sign in with Face ID / Fingerprint.`, 'success');
  } catch (err) {
    if (err.name === 'NotAllowedError') {
      toast('Biometric / Passkey prompt was cancelled or timed out.', 'info');
    } else if (err.name === 'InvalidStateError') {
      toast('This device passkey is already registered on your account.', 'info');
    } else {
      toast(`Passkey registration failed: ${err.message}`, 'error');
    }
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = `
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 10a2 2 0 0 0-2 2c0 1.02-.1 2.51-.26 4"/><path d="M14 13.12c0 2.38 0 6.38-1 8.88"/><path d="M2 12a10 10 0 0 1 18-6"/><path d="M5 19.5C5.5 18 6 15 6 12a6 6 0 0 1 .34-2"/><path d="M9 6.8a6 6 0 0 1 9 5.2v2"/></svg>
        <span>Register Passkey / Biometric</span>
      `;
    }
  }
}
window.registerNewPasskey = registerNewPasskey;

async function deletePasskey(id, name) {
  const ok = await showConfirmDialog({
    title: 'Remove Passkey / Biometric Device',
    message: `Remove "${name}" from your account? You will no longer be able to sign in with this passkey unless you register it again.`,
    confirmText: 'Remove Passkey',
    danger: true,
  });
  if (!ok) return;
  try {
    const res = await api(`/api/auth/passkeys/${id}`, { method: 'DELETE' });
    state.passkeysList = res.passkeys || [];
    state.passkeyCount = state.passkeysList.length;
    renderSecurityStatusSummary();
    await loadPasskeysList();
    toast(`Removed passkey "${name}".`, 'info');
  } catch (err) {
    toast(`Failed to remove passkey: ${err.message}`, 'error');
  }
}
window.deletePasskey = deletePasskey;

async function loginWithPasskey() {
  if (!window.isSecureContext || !window.PublicKeyCredential || !navigator.credentials?.get) {
    toast(
      `Passkeys / Biometrics require HTTPS (https://your-domain.com) or localhost. Current URL (${window.location.origin}) is plain HTTP.`,
      'warning'
    );
    return;
  }
  const username = (document.getElementById('login-username')?.value || '').trim();
  const btn = document.getElementById('login-passkey-btn');
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<span>Verifying Face ID / Fingerprint...</span>';
  }
  try {
    const start = await api('/api/auth/passkeys/login/start', {
      method: 'POST',
      body: { username: username || null },
    });
    const allowCredentials = (start.allowCredentials || []).map((cid) => ({
      type: 'public-key',
      id: base64UrlToUint8Array(cid),
    }));
    const publicKey = {
      challenge: base64UrlToUint8Array(start.challenge),
      userVerification: 'preferred',
      timeout: 60000,
    };
    if (allowCredentials.length > 0) {
      publicKey.allowCredentials = allowCredentials;
    }

    const assertion = await navigator.credentials.get({ publicKey });
    if (!assertion || !assertion.response) {
      throw new Error('Passkey sign-in was cancelled.');
    }

    const res = await api('/api/auth/passkeys/login/finish', {
      method: 'POST',
      body: {
        challengeId: start.challengeId,
        credentialId: bufferToBase64Url(assertion.rawId),
        authenticatorData: bufferToBase64Url(assertion.response.authenticatorData),
        clientDataJSON: bufferToBase64Url(assertion.response.clientDataJSON),
        signature: bufferToBase64Url(assertion.response.signature),
      },
    });

    await applyAuthSuccess(res);
    toast('Signed in with Passkey / Biometrics!', 'success');
  } catch (err) {
    if (err.name === 'NotAllowedError') {
      toast('Biometric / Passkey sign-in was cancelled.', 'info');
    } else {
      toast(err.message || 'Passkey sign-in failed', 'error');
    }
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = `
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 10a2 2 0 0 0-2 2c0 1.02-.1 2.51-.26 4"/><path d="M14 13.12c0 2.38 0 6.38-1 8.88"/><path d="M17.29 21.02c.12-.6.43-2.3.5-3.02"/><path d="M2 12a10 10 0 0 1 18-6"/><path d="M2 16h.01"/><path d="M21.8 16c.2-2 .131-5.354 0-6"/><path d="M5 19.5C5.5 18 6 15 6 12a6 6 0 0 1 .34-2"/><path d="M8.65 22c.21-.66.45-1.32.57-2"/><path d="M9 6.8a6 6 0 0 1 9 5.2v2"/></svg>
        <span>Sign in with Passkey / Biometrics</span>
      `;
    }
  }
}
window.loginWithPasskey = loginWithPasskey;



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
  const current = document.getElementById('pwd-current').value;
  const next = document.getElementById('pwd-next').value;
  const confirm = document.getElementById('pwd-confirm').value;
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
        ? `Password updated and ${res.revokedSessions} other session(s) signed out!`
        : 'Password updated in SQLite!',
      'success'
    );
    closeModal('modal-change-password');
  } catch (err) {
    toast(`Failed to change password: ${err.message}`, 'error');
  }
});

async function start2faSetup() {
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

    document.getElementById('sec-2fa-step1-password').style.display = 'none';
    document.getElementById('sec-2fa-step2-verify').style.display = 'block';
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
window.start2faSetup = start2faSetup;

function copy2faSecret() {
  const raw = state.pending2faSecret || document.getElementById('tfa-secret-display')?.value || '';
  navigator.clipboard.writeText(raw.replace(/\s+/g, '')).then(() => {
    toast('2FA Base32 secret copied to clipboard!', 'success');
  }).catch((err) => {
    toast(`Failed to copy to clipboard: ${err.message}`, 'error');
  });
}
window.copy2faSecret = copy2faSecret;

async function confirmEnable2fa() {
  const raw = (document.getElementById('tfa-verify-code')?.value || '').trim();
  const code = raw.replace(/\D/g, '');
  if (code.length !== 6) {
    toast('Please enter the 6-digit code from your authenticator app.', 'warning');
    return;
  }
  try {
    const res = await api('/api/auth/2fa/enable', { method: 'POST', body: { code } });
    state.user.totpEnabled = true;
    state.lastRecoveryCodes = res.backupCodes || [];
    renderSecurityStatusSummary();
    if (state.currentView === 'settings') await loadSettingsView();

    const grid = document.getElementById('tfa-recovery-codes-grid');
    if (grid) {
      grid.innerHTML = (res.backupCodes || []).map((c) => `<div style="padding:4px; background:rgba(255,255,255,0.04); border-radius:4px;">${escapeHtml(c)}</div>`).join('');
    }
    document.getElementById('sec-2fa-step2-verify').style.display = 'none';
    document.getElementById('sec-2fa-step3-recovery').style.display = 'block';
    toast('Two-Factor Authentication enabled!', 'success');
  } catch (err) {
    toast(`Verification failed: ${err.message}`, 'error');
  }
}
window.confirmEnable2fa = confirmEnable2fa;

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

function copyRecoveryCodes() {
  const codes = (state.lastRecoveryCodes || []).join('\n');
  if (!codes) return;
  navigator.clipboard.writeText(codes).then(() => {
    toast('Recovery codes copied to clipboard!', 'success');
  }).catch((err) => {
    toast(`Failed to copy to clipboard: ${err.message}`, 'error');
  });
}
window.copyRecoveryCodes = copyRecoveryCodes;

async function disable2fa() {
  const password = document.getElementById('tfa-disable-password')?.value || '';
  const code = (document.getElementById('tfa-disable-code')?.value || '').trim();
  if (!password || !code) {
    toast('Please enter both your current password and a 6-digit 2FA or recovery code.', 'warning');
    return;
  }
  try {
    await api('/api/auth/2fa/disable', { method: 'POST', body: { password, code } });
    state.user.totpEnabled = false;
    renderSecurityStatusSummary();
    toast('Two-Factor Authentication has been disabled.', 'info');
    closeModal('modal-change-password');
  } catch (err) {
    toast(`Disable 2FA failed: ${err.message}`, 'error');
  }
}
window.disable2fa = disable2fa;

async function revokeOtherSessions() {
  try {
    const res = await api('/api/auth/sessions/revoke-others', { method: 'POST' });
    state.activeSessions = 1;
    renderSecurityStatusSummary();
    toast(`Signed out ${res.revoked || 0} other active session(s)!`, 'success');
  } catch (err) {
    toast(`Failed to revoke sessions: ${err.message}`, 'error');
  }
}
window.revokeOtherSessions = revokeOtherSessions;

async function adminResetUser2fa(userId, username) {
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
window.adminResetUser2fa = adminResetUser2fa;

// ============================================================================
// Pure-JS ISO/IEC 18004 QR Code SVG Generator (Offline, Zero External Calls)
// ============================================================================
function renderTotpQrSvg(text) {
  try {
    const matrix = generateQrMatrix(text);
    const n = matrix.length;
    const quiet = 4;
    const total = n + quiet * 2;
    let paths = '';
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        if (matrix[r][c]) {
          paths += `M${c + quiet},${r + quiet}h1v1h-1z`;
        }
      }
    }
    return `<svg viewBox="0 0 ${total} ${total}" width="144" height="144" shape-rendering="crispEdges" xmlns="http://www.w3.org/2000/svg"><rect width="${total}" height="${total}" fill="#ffffff"/><path d="${paths}" fill="#0f172a"/></svg>`;
  } catch {
    return `<div style="font-size:11px; color:#0f172a; text-align:center; padding:8px;">Use Setup Key</div>`;
  }
}

function generateQrMatrix(text) {
  const dataBytes = new TextEncoder().encode(text);
  // Version table for ECC Level L (versions 1..10): [totalCodewords, ecCodewordsPerBlock, numBlocks]
  const V_TABLE = [
    null,
    [26, 7, 1],
    [44, 10, 1],
    [70, 15, 1],
    [100, 20, 1],
    [134, 26, 1],
    [172, 18, 2],
    [196, 20, 2],
    [242, 24, 2],
    [292, 30, 2],
    [346, 18, 4],
  ];
  let ver = 1;
  while (ver <= 10) {
    const [totalCw, ecCw, blocks] = V_TABLE[ver];
    const dataCw = totalCw - ecCw * blocks;
    const headerBytes = ver < 10 ? 2 : 3;
    if (dataBytes.length + headerBytes <= dataCw) break;
    ver++;
  }
  if (ver > 10) ver = 10;
  const [totalCw, ecCw, numBlocks] = V_TABLE[ver];
  const totalDataCw = totalCw - ecCw * numBlocks;

  // Build bit stream: Byte mode (0100), length (8 or 16 bits), payload, terminator
  const bits = [];
  const pushBits = (val, len) => {
    for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1);
  };
  pushBits(0b0100, 4);
  pushBits(dataBytes.length, ver < 10 ? 8 : 16);
  for (const b of dataBytes) pushBits(b, 8);
  const maxBits = totalDataCw * 8;
  for (let i = 0; i < 4 && bits.length < maxBits; i++) bits.push(0);
  while (bits.length % 8 !== 0) bits.push(0);

  const dataCw = [];
  for (let i = 0; i < bits.length; i += 8) {
    let b = 0;
    for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
    dataCw.push(b);
  }
  let padToggle = true;
  while (dataCw.length < totalDataCw) {
    dataCw.push(padToggle ? 0xec : 0x11);
    padToggle = !padToggle;
  }

  // GF(256) Reed-Solomon
  const gfExp = new Uint8Array(512);
  const gfLog = new Uint8Array(256);
  let x = 1;
  for (let i = 0; i < 255; i++) {
    gfExp[i] = x;
    gfLog[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) gfExp[i] = gfExp[i - 255];
  const gfMul = (a, b) => (a === 0 || b === 0 ? 0 : gfExp[gfLog[a] + gfLog[b]]);

  let gen = [1];
  for (let i = 0; i < ecCw; i++) {
    const next = new Array(gen.length + 1).fill(0);
    for (let j = 0; j < gen.length; j++) {
      next[j] ^= gen[j];
      next[j + 1] ^= gfMul(gen[j], gfExp[i]);
    }
    gen = next;
  }

  const rsEncode = (msg) => {
    const rem = new Uint8Array(ecCw);
    for (const b of msg) {
      const factor = b ^ rem[0];
      rem.copyWithin(0, 1);
      rem[ecCw - 1] = 0;
      for (let i = 0; i < ecCw; i++) rem[i] ^= gfMul(gen[i + 1], factor);
    }
    return Array.from(rem);
  };

  const dataBlocks = [];
  const ecBlocks = [];
  const baseBlockLen = Math.floor(totalDataCw / numBlocks);
  const extraBlocks = totalDataCw % numBlocks;
  let offset = 0;
  for (let b = 0; b < numBlocks; b++) {
    const len = baseBlockLen + (b >= numBlocks - extraBlocks ? 1 : 0);
    const blk = dataCw.slice(offset, offset + len);
    offset += len;
    dataBlocks.push(blk);
    ecBlocks.push(rsEncode(blk));
  }

  const finalCw = [];
  const maxDataLen = baseBlockLen + (extraBlocks > 0 ? 1 : 0);
  for (let i = 0; i < maxDataLen; i++) {
    for (let b = 0; b < numBlocks; b++) {
      if (i < dataBlocks[b].length) finalCw.push(dataBlocks[b][i]);
    }
  }
  for (let i = 0; i < ecCw; i++) {
    for (let b = 0; b < numBlocks; b++) finalCw.push(ecBlocks[b][i]);
  }

  const size = ver * 4 + 17;
  const grid = Array.from({ length: size }, () => new Uint8Array(size));
  const reserved = Array.from({ length: size }, () => new Uint8Array(size));

  const setFinder = (r0, c0) => {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const rr = r0 + r;
        const cc = c0 + c;
        if (rr < 0 || rr >= size || cc < 0 || cc >= size) continue;
        const on =
          (r >= 0 && r <= 6 && (c === 0 || c === 6)) ||
          (c >= 0 && c <= 6 && (r === 0 || r === 6)) ||
          (r >= 2 && r <= 4 && c >= 2 && c <= 4);
        grid[rr][cc] = on ? 1 : 0;
        reserved[rr][cc] = 1;
      }
    }
  };
  setFinder(0, 0);
  setFinder(0, size - 7);
  setFinder(size - 7, 0);

  const ALIGN_POS = [
    [],
    [],
    [6, 18],
    [6, 22],
    [6, 26],
    [6, 30],
    [6, 34],
    [6, 22, 38],
    [6, 24, 42],
    [6, 26, 46],
    [6, 28, 50],
  ];
  const apos = ALIGN_POS[ver];
  for (const ar of apos) {
    for (const ac of apos) {
      if (reserved[ar][ac]) continue;
      for (let r = -2; r <= 2; r++) {
        for (let c = -2; c <= 2; c++) {
          const on = Math.max(Math.abs(r), Math.abs(c)) !== 1;
          grid[ar + r][ac + c] = on ? 1 : 0;
          reserved[ar + r][ac + c] = 1;
        }
      }
    }
  }

  for (let i = 8; i < size - 8; i++) {
    if (!reserved[6][i]) {
      grid[6][i] = i % 2 === 0 ? 1 : 0;
      reserved[6][i] = 1;
    }
    if (!reserved[i][6]) {
      grid[i][6] = i % 2 === 0 ? 1 : 0;
      reserved[i][6] = 1;
    }
  }

  for (let i = 0; i < 9; i++) {
    if (i < size) {
      reserved[8][i] = 1;
      reserved[i][8] = 1;
    }
  }
  for (let i = 0; i < 8; i++) {
    reserved[8][size - 1 - i] = 1;
    reserved[size - 1 - i][8] = 1;
  }
  grid[size - 8][8] = 1;

  if (ver >= 7) {
    let vinfo = ver;
    for (let i = 0; i < 12; i++) vinfo = (vinfo << 1) ^ ((vinfo >>> 11) * 0x1f25);
    const vbits = (ver << 12) | vinfo;
    for (let i = 0; i < 18; i++) {
      const bit = (vbits >>> i) & 1;
      const r = Math.floor(i / 3);
      const c = size - 11 + (i % 3);
      grid[r][c] = bit;
      reserved[r][c] = 1;
      grid[c][r] = bit;
      reserved[c][r] = 1;
    }
  }

  let bitIdx = 0;
  const totalBits = finalCw.length * 8;
  let upward = true;
  for (let rawCol = size - 1; rawCol >= 1; rawCol -= 2) {
    const col = rawCol <= 6 ? rawCol - 1 : rawCol;
    for (let step = 0; step < size; step++) {
      const r = upward ? size - 1 - step : step;
      for (let dc = 0; dc < 2; dc++) {
        const c = col - dc;
        if (reserved[r][c]) continue;
        let bit = 0;
        if (bitIdx < totalBits) {
          bit = (finalCw[bitIdx >>> 3] >>> (7 - (bitIdx & 7))) & 1;
          bitIdx++;
        }
        if ((r + c) % 2 === 0) bit ^= 1; // Mask 0
        grid[r][c] = bit;
      }
    }
    upward = !upward;
  }

  // Format info for ECC Level L (01) + Mask 0 (000) -> 0x77c4 (MSB bit 14 down to LSB bit 0)
  const fmtBits = 0x77c4;
  const fPos1 = [
    [8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8],
    [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8],
  ];
  for (let i = 0; i < 15; i++) {
    const bit = (fmtBits >>> (14 - i)) & 1;
    const [r1, c1] = fPos1[i];
    grid[r1][c1] = bit;
    if (i < 7) grid[size - 1 - i][8] = bit;
    else grid[8][size - 15 + i] = bit;
  }

  return grid;
}



window.resetCleanUrl = resetCleanUrl;
window.stopPolling = stopPolling;
window.initAuth = initAuth;
window.showLogin = showLogin;
window.applyAuthSuccess = applyAuthSuccess;
window.onAuthenticated = onAuthenticated;

export {
  resetCleanUrl,
  stopPolling,
  initAuth,
  showLogin,
  startLoginCanvasAnimation,
  stopLoginCanvasAnimation,
  togglePasswordField,
  toggleLoginPasswordVisibility,
  hasPower,
  onAuthenticated,
  applyAuthSuccess,
  openSecurityModal,
  switchSecurityTab,
  loadPasskeysList,
  registerNewPasskey,
  deletePasskey,
  loginWithPasskey,
  start2faSetup,
  copy2faSecret,
  confirmEnable2fa,
  copyRecoveryCodes,
  disable2fa,
  revokeOtherSessions,
  adminResetUser2fa,
  renderTotpQrSvg,
};
