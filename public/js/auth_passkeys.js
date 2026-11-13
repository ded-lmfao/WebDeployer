/**
 * WebDep WebAuthn Passkeys & Biometrics Subsystem
 * W3C WebAuthn Level 3 client implementation supporting Face ID, Touch ID, Windows Hello, and FIDO2 keys.
 */

import { icon } from './icons.js';
import {
  state,
  escapeHtml,
  formatDate,
  formatRelativeTime,
  showCopyDialog,
  showConfirmDialog,
} from './state.js';
import { api, toast } from './api.js';

export function base64UrlToUint8Array(base64Url) {
  const padding = '='.repeat((4 - (base64Url.length % 4)) % 4);
  const base64 = (base64Url + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

export function bufferToBase64Url(buffer) {
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

export function detectDefaultPasskeyDeviceName() {
  const ua = navigator.userAgent || '';
  if (/iPhone/i.test(ua)) return 'iPhone Face ID';
  if (/iPad/i.test(ua)) return 'iPad Face ID / Touch ID';
  if (/Android/i.test(ua)) return 'Android Fingerprint';
  if (/Macintosh|Mac OS X/i.test(ua)) return 'Mac Touch ID';
  if (/Windows/i.test(ua)) return 'Windows Hello';
  return 'Passkey / Biometric Device';
}

export async function loadPasskeysList() {
  const container = document.getElementById('passkeys-list-container');
  try {
    const res = await api('/api/auth/passkeys', { noCache: true });
    const list = Array.isArray(res?.passkeys) ? res.passkeys : [];
    state.passkeysList = list;
    state.passkeyCount = list.length;
    if (window.renderSecurityStatusSummary) window.renderSecurityStatusSummary();
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

export async function registerNewPasskey() {
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
      confirmText: 'Done',
    });
    return;
  }

  const nameInput = document.getElementById('passkey-device-name');
  const label = (nameInput?.value || '').trim() || detectDefaultPasskeyDeviceName();
  const btn = document.getElementById('register-passkey-btn');
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = `${icon('refresh', { size: 14, cls: 'icon-spin', style: 'margin-right:6px;' })} Scanning Face ID / Fingerprint`;
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
    if (window.renderSecurityStatusSummary) window.renderSecurityStatusSummary();
    await loadPasskeysList();
    toast(`Passkey "${label}" registered. You can now sign in with Face ID / Fingerprint.`, 'success');
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
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin-right:6px;"><path d="M12 10a2 2 0 0 0-2 2c0 1.02-.1 2.51-.26 4"/><path d="M14 13.12c0 2.38 0 6.38-1 8.88"/><path d="M2 12a10 10 0 0 1 18-6"/><path d="M5 19.5C5.5 18 6 15 6 12a6 6 0 0 1 .34-2"/><path d="M9 6.8a6 6 0 0 1 9 5.2v2"/></svg>
        <span>Register Passkey / Biometric</span>
      `;
    }
  }
}

export async function deletePasskey(id, name) {
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
    if (window.renderSecurityStatusSummary) window.renderSecurityStatusSummary();
    await loadPasskeysList();
    toast(`Removed passkey "${name}".`, 'info');
  } catch (err) {
    toast(`Failed to remove passkey: ${err.message}`, 'error');
  }
}

export async function loginWithPasskey() {
  if (!window.isSecureContext || !window.PublicKeyCredential || !navigator.credentials?.get) {
    toast(
      `Passkeys / Biometrics require HTTPS (https://your-domain.com) or localhost. Current URL (${window.location.origin}) is plain HTTP.`,
      'warning'
    );
    return;
  }

  const btn = document.getElementById('login-passkey-btn');
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = `${icon('refresh', { size: 14, cls: 'icon-spin', style: 'margin-right:6px;' })} Scanning Face ID / Touch ID`;
  }

  try {
    const start = await api('/api/auth/passkeys/login/start', {
      method: 'POST',
      body: { username: (document.getElementById('login-username')?.value || '').trim() || null },
    });

    const allowCredentials = (start.allowCredentials || []).map((cid) => ({
      type: 'public-key',
      id: base64UrlToUint8Array(cid),
    }));

    const assertion = await navigator.credentials.get({
      publicKey: {
        challenge: base64UrlToUint8Array(start.challenge),
        rpId: start.rpId || window.location.hostname,
        allowCredentials,
        userVerification: 'preferred',
        timeout: 60000,
      },
    });

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
        userHandle: assertion.response.userHandle ? bufferToBase64Url(assertion.response.userHandle) : null,
      },
    });

    if (window.applyAuthSuccess) window.applyAuthSuccess(res);
    toast('Signed in with Passkey / Biometrics.', 'success');
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
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin-right:6px;"><path d="M12 10a2 2 0 0 0-2 2c0 1.02-.1 2.51-.26 4"/><path d="M14 13.12c0 2.38 0 6.38-1 8.88"/><path d="M2 12a10 10 0 0 1 18-6"/><path d="M5 19.5C5.5 18 6 15 6 12a6 6 0 0 1 .34-2"/><path d="M9 6.8a6 6 0 0 1 9 5.2v2"/></svg>
        <span>Sign in with Passkey / Biometrics</span>
      `;
    }
  }
}

// Bind globals for onclick inline HTML handlers
window.loadPasskeysList = loadPasskeysList;
window.registerNewPasskey = registerNewPasskey;
window.deletePasskey = deletePasskey;
window.loginWithPasskey = loginWithPasskey;
window.base64UrlToUint8Array = base64UrlToUint8Array;
window.bufferToBase64Url = bufferToBase64Url;

