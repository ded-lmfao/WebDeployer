/**
 * WebDep Environment Variables Management Subsystem
 * Single inline editing, multi-row bulk table editor, and raw .env parsing/export
 */

import {
  state,
  getSelectedProject,
  paginateAndRender,
  escapeHtml,
  showConfirmDialog,
  copyTextToClipboard,
  syncProjectSelectors,
} from './state.js';
import { api, toast } from './api.js';

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

function cancelInlineEnvEdit() {
  envUiState.editingKey = null;
  renderEnvTableFromState();
}

function handleInlineEditKeydown(e, originalKey) {
  if (e.key === 'Enter') {
    e.preventDefault();
    void saveInlineEnvEdit(originalKey);
  } else if (e.key === 'Escape') {
    e.preventDefault();
    cancelInlineEnvEdit();
  }
}

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

function toggleRevealSingleEnv(key) {
  if (envUiState.revealedKeys.has(key)) {
    envUiState.revealedKeys.delete(key);
  } else {
    envUiState.revealedKeys.add(key);
  }
  renderEnvTableFromState();
}

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

function copyEnvVarValue(key) {
  const found = envUiState.vars.find((v) => v.key === key);
  if (!found) return;
  void copyTextToClipboard(getRealEnvValue(found), `Copied value for "${key}"`);
}

function toggleSelectEnvVar(key, checked) {
  if (checked) {
    envUiState.selectedKeys.add(key);
  } else {
    envUiState.selectedKeys.delete(key);
  }
  updateSelectedEnvToolbar();
}

function toggleSelectAllEnvVars(checked) {
  if (checked) {
    envUiState.vars.forEach((v) => envUiState.selectedKeys.add(v.key));
  } else {
    envUiState.selectedKeys.clear();
  }
  renderEnvTableFromState();
}

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

function removeMultiEditEnvRow(idx) {
  syncMultiEditDomToState();
  envUiState.multiRows.splice(idx, 1);
  if (envUiState.multiRows.length === 0) {
    envUiState.multiRows.push({ key: '', value: '', is_secret: true });
  }
  renderMultiEditTable();
}

function toggleMultiEditRowSecret(idx) {
  syncMultiEditDomToState();
  if (envUiState.multiRows[idx]) {
    envUiState.multiRows[idx].is_secret = !envUiState.multiRows[idx].is_secret;
    renderMultiEditTable();
  }
}

async function finishEnvSave(p, countMsg, andRestart) {
  toast(countMsg, 'success');
  setEnvViewMode('list');
  await loadEnvView();
  if (andRestart && typeof window.restartProject === 'function') {
    await window.restartProject(p.id);
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

function copyRawEnvToClipboard() {
  const ta = document.getElementById('env-raw-editor-textarea');
  const content = ta ? ta.value : formatEnvVarsToRaw(envUiState.vars);
  if (!content.trim()) {
    toast('No variables to copy.', 'info');
    return;
  }
  void copyTextToClipboard(content, 'Copied .env contents to clipboard');
}

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

function onEnvProjectChange(projectId) {
  state.selectedProjectId = Number(projectId);
  const globalSel = document.getElementById('global-project-select');
  if (globalSel) globalSel.value = String(projectId);
  syncProjectSelectors();
  if (typeof window.renderCurrentView === 'function') {
    window.renderCurrentView();
  }
}

function restartCurrentProject() {
  const p = getSelectedProject();
  if (p && typeof window.restartProject === 'function') {
    void window.restartProject(p.id);
  }
}

let activeEnvTab = 'single';

function switchEnvModalTab(tab) {
  activeEnvTab = tab;
  const singleSec = document.getElementById('env-section-single');
  const bulkSec = document.getElementById('env-section-bulk');
  if (singleSec) singleSec.style.display = tab === 'single' ? 'block' : 'none';
  if (bulkSec) bulkSec.style.display = tab === 'bulk' ? 'block' : 'none';
}

function openAddEnvModal() {
  setEnvViewMode('list');
  document.getElementById('env-quick-key-input')?.focus();
}

function openBulkEnvModal() {
  setEnvViewMode('raw');
}

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

async function handleSaveEnv(e) {
  if (e) e.preventDefault();
  return handleInlineQuickAddEnv(e);
}

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

function promptRevealEnv(key) {
  toggleRevealSingleEnv(key);
}

// Global window bindings for inline HTML handlers
window.loadEnvView = loadEnvView;
window.setEnvViewMode = setEnvViewMode;
window.renderEnvTableFromState = renderEnvTableFromState;
window.startInlineEnvEdit = startInlineEnvEdit;
window.toggleInlineEditSecret = toggleInlineEditSecret;
window.cancelInlineEnvEdit = cancelInlineEnvEdit;
window.handleInlineEditKeydown = handleInlineEditKeydown;
window.saveInlineEnvEdit = saveInlineEnvEdit;
window.toggleQuickAddSecret = toggleQuickAddSecret;
window.handleInlineQuickAddEnv = handleInlineQuickAddEnv;
window.toggleRevealSingleEnv = toggleRevealSingleEnv;
window.toggleRevealAllEnv = toggleRevealAllEnv;
window.copyEnvVarValue = copyEnvVarValue;
window.toggleSelectEnvVar = toggleSelectEnvVar;
window.toggleSelectAllEnvVars = toggleSelectAllEnvVars;
window.deleteSelectedEnvVars = deleteSelectedEnvVars;
window.addMultiEditEnvRow = addMultiEditEnvRow;
window.removeMultiEditEnvRow = removeMultiEditEnvRow;
window.toggleMultiEditRowSecret = toggleMultiEditRowSecret;
window.saveMultiEditEnv = saveMultiEditEnv;
window.saveInlineRawEnv = saveInlineRawEnv;
window.copyRawEnvToClipboard = copyRawEnvToClipboard;
window.handleEnvFileUpload = handleEnvFileUpload;
window.onEnvProjectChange = onEnvProjectChange;
window.restartCurrentProject = restartCurrentProject;
window.switchEnvModalTab = switchEnvModalTab;
window.openAddEnvModal = openAddEnvModal;
window.openBulkEnvModal = openBulkEnvModal;
window.loadCurrentEnv = loadCurrentEnv;
window.exportEnvFile = exportEnvFile;
window.handleSaveEnv = handleSaveEnv;
window.deleteEnvVar = deleteEnvVar;
window.promptRevealEnv = promptRevealEnv;
window.setBtnLoading = setBtnLoading;

export {
  loadEnvView,
  setEnvViewMode,
  renderEnvTableFromState,
  startInlineEnvEdit,
  toggleInlineEditSecret,
  cancelInlineEnvEdit,
  saveInlineEnvEdit,
  toggleQuickAddSecret,
  handleInlineQuickAddEnv,
  toggleRevealSingleEnv,
  toggleRevealAllEnv,
  copyEnvVarValue,
  toggleSelectEnvVar,
  toggleSelectAllEnvVars,
  deleteSelectedEnvVars,
  addMultiEditEnvRow,
  removeMultiEditEnvRow,
  toggleMultiEditRowSecret,
  saveMultiEditEnv,
  saveInlineRawEnv,
  copyRawEnvToClipboard,
  handleEnvFileUpload,
  onEnvProjectChange,
  restartCurrentProject,
  switchEnvModalTab,
  openAddEnvModal,
  openBulkEnvModal,
  loadCurrentEnv,
  exportEnvFile,
  handleSaveEnv,
  deleteEnvVar,
  promptRevealEnv,
  setBtnLoading,
};

