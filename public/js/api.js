/**
 * WebDep API & Toast Subsystem
 * High-performance network requests, stale-while-revalidate client caching, and toasts
 */

import { state, clientCache, inflightGets, persistCacheToSession, getCacheTtlMs, getCacheEpoch, invalidateClientCache } from './state.js';
import { animateToastEnter, animateToastExit } from './motion_ui.js';


async function networkFetch(path, options = {}) {
  const headers = {
    'Accept': 'application/json',
    ...(options.headers || {}),
  };
  if (state.csrf && options.method && options.method !== 'GET') {
    headers['X-CSRF-Token'] = state.csrf;
  }
  const fetchOpts = { ...options };
  if (fetchOpts.noCache) {
    fetchOpts.cache = 'no-store';
  }
  if (fetchOpts.body && typeof fetchOpts.body === 'object' && !(fetchOpts.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
    fetchOpts.body = JSON.stringify(fetchOpts.body);
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), fetchOpts.timeoutMs || 15000);

  let res;
  try {
    res = await fetch(path, {
      credentials: 'same-origin',
      signal: controller.signal,
      ...fetchOpts,
      headers,
    });
  } finally {
    clearTimeout(timeoutId);
  }

  if (
    res.status === 401
    && !path.startsWith('/api/auth/login')
    && !path.startsWith('/api/auth/logout')
    && !path.startsWith('/api/auth/2fa/verify-login')
    && !path.startsWith('/api/auth/passkeys/login/')
  ) {
    invalidateClientCache();
    const loginView = document.getElementById('login-view');
    if (!loginView || loginView.style.display !== 'flex') {
      showLogin();
    }
    throw new Error('Session expired. Please log in again.');
  }

  const contentType = res.headers.get('content-type') || '';
  let data;
  if (contentType.includes('application/json')) {
    data = await res.json();
  } else {
    data = await res.text();
  }

  if (!res.ok) {
    const errorMsg = (typeof data === 'object' && data.error) ? data.error : (data || res.statusText);
    throw new Error(errorMsg);
  }

  return data;
}

async function api(path, options = {}) {
  const method = (options.method || 'GET').toUpperCase();

  // Any mutation immediately invalidates client cache so subsequent reads are 100% fresh
  if (method !== 'GET') {
    const result = await networkFetch(path, options);
    invalidateClientCache();
    return result;
  }

  const ttl = options.noCache ? 0 : getCacheTtlMs(path);
  const now = Date.now();

  if (ttl > 0 && clientCache.has(path)) {
    const entry = clientCache.get(path);
    const age = now - entry.ts;
    if (age <= ttl) {
      // Fresh cache hit -> 0ms instant return
      return entry.data;
    }
    if (age <= ttl * 6) {
      // Stale-While-Revalidate -> return cached data in 0ms and refresh silently in background
      if (!inflightGets.has(path)) {
        const bgEpoch = getCacheEpoch();
        const bgPromise = networkFetch(path, options)
          .then((fresh) => {
            if (getCacheEpoch() === bgEpoch) {
              clientCache.set(path, { data: fresh, ts: Date.now(), ttl });
              persistCacheToSession();
            }
            return fresh;
          })
          .catch(() => {})
          .finally(() => inflightGets.delete(path));
        inflightGets.set(path, bgPromise);
      }
      return entry.data;
    }
  }

  // Deduplicate concurrent identical GET requests unless caller explicitly bypassed cache
  if (!options.noCache && inflightGets.has(path)) {
    return inflightGets.get(path);
  }

  const reqEpoch = getCacheEpoch();
  const reqPromise = networkFetch(path, options)
    .then((data) => {
      if (ttl > 0 && getCacheEpoch() === reqEpoch) {
        clientCache.set(path, { data, ts: Date.now(), ttl });
        persistCacheToSession();
      }
      return data;
    })
    .finally(() => {
      if (inflightGets.get(path) === reqPromise) {
        inflightGets.delete(path);
      }
    });

  if (!options.noCache) {
    inflightGets.set(path, reqPromise);
  }
  return reqPromise;
}

function prefetchWebsiteWorkspace(projectId) {
  const pid = Number(projectId);
  if (!pid) return;
  const endpoints = [
    `/api/deployments?project=${pid}&limit=200`,
    `/api/projects/${pid}/commits`,
    `/api/projects/${pid}/releases`,
    `/api/audit?projectId=${pid}&limit=500`,
  ];
  if (typeof window.hasPower === 'function' ? window.hasPower('env') : false) endpoints.push(`/api/projects/${pid}/env`);

  // Run non-blocking background warm-up
  setTimeout(() => {
    for (const url of endpoints) {
      if (!clientCache.has(url)) {
        api(url).catch(() => {});
      }
    }
  }, 10);
}

function prefetchDatabaseWorkspace(dbId) {
  const did = Number(dbId);
  if (!did) return;
  const endpoints = [
    `/api/databases/${did}/files?path=`,
    `/api/audit?databaseId=${did}&limit=500`,
  ];
  setTimeout(() => {
    for (const url of endpoints) {
      if (!clientCache.has(url)) {
        api(url).catch(() => {});
      }
    }
  }, 10);
}
window.prefetchDatabaseWorkspace = prefetchDatabaseWorkspace;

// ============================================================================
// Toasts
// ============================================================================
export function toast(message, type = 'info', duration = 4000) {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.textContent = message;
  container.appendChild(el);
  animateToastEnter(el);
  setTimeout(() => {
    animateToastExit(el);
  }, duration);
}



window.networkFetch = networkFetch;
window.api = api;
window.prefetchWebsiteWorkspace = prefetchWebsiteWorkspace;
window.toast = toast;

export { networkFetch, api, prefetchWebsiteWorkspace, prefetchDatabaseWorkspace };
