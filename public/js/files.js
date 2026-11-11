/**
 * WebDep File Explorer & In-Browser IDE Subsystem
 * Enterprise file manager, directory navigator, syntax editor, and file upload dropzone
 */

import { icon, FILE_KINDS } from './icons.js';
import { state, escapeHtml, formatDate, showConfirmDialog, showPromptDialog, copyTextToClipboard } from './state.js';
import { api, toast } from './api.js';
import { highlightCode, detectLanguage } from './syntax.js';

// ============================================================================
// Backend Service File Browser
// ============================================================================
// Modern Enterprise File Explorer & In-Browser IDE Editor
// ============================================================================
state.filesPath = '';
state.filesOpenPath = null;
state.filesProjectId = null;
state.filesCachedEntries = [];
state.filesFilter = '';
state.filesEditorInitialContent = '';
state.filesEditorDirty = false;

function filesJoin(dir, name) {
  if (!dir) return name;
  return dir.endsWith('/') ? `${dir}${name}` : `${dir}/${name}`;
}

function formatFileBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  if (i === 0) return `${bytes} B`;
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}

function formatFileDate(unixSec) {
  if (!unixSec || unixSec <= 0) return { relative: '—', full: '' };
  const d = new Date(unixSec * 1000);
  const now = Date.now();
  const diffSec = Math.floor((now - d.getTime()) / 1000);

  let relative = '';
  if (diffSec < 60) relative = 'Just now';
  else if (diffSec < 3600) relative = `${Math.floor(diffSec / 60)}m ago`;
  else if (diffSec < 86400) relative = `${Math.floor(diffSec / 3600)}h ago`;
  else if (diffSec < 604800) relative = `${Math.floor(diffSec / 86400)}d ago`;
  else {
    relative = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: d.getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined });
  }

  const full = d.toLocaleString();
  return { relative, full };
}

function getFileMeta(entry) {
  const build = (kindKey, extLabel, isEditable, isBinary, isDir = false) => {
    const k = FILE_KINDS[kindKey] || FILE_KINDS.file;
    return {
      isDir,
      extLabel,
      isEditable,
      isBinary,
      iconColor: k.color,
      iconBg: k.bg,
      iconSvg: icon(k.icon, { size: 16 }),
    };
  };

  if (entry.is_dir) return build('folder', 'DIR', false, false, true);

  const name = entry.name.toLowerCase();
  const ext = name.includes('.') ? name.split('.').pop() : '';

  if (['jar', 'war', 'class'].includes(ext)) return build('java', ext.toUpperCase(), false, true);
  if (['py', 'pyw', 'ipynb'].includes(ext)) return build('python', 'PY', true, false);
  if (['js', 'mjs', 'cjs'].includes(ext)) return build('javascript', 'JS', true, false);
  if (['ts', 'tsx'].includes(ext)) return build('typescript', 'TS', true, false);
  if (name === '.env' || name.startsWith('.env.')) return build('env', 'ENV', true, false);
  if (['json', 'yaml', 'yml', 'toml', 'xml', 'ini', 'conf', 'config'].includes(ext)) return build('config', ext.toUpperCase() || 'CONF', true, false);
  if (['sh', 'bash', 'bat', 'cmd', 'ps1'].includes(ext)) return build('shell', 'SHELL', true, false);
  if (['md', 'txt', 'log'].includes(ext)) return build('doc', ext.toUpperCase(), true, false);
  if (['html', 'htm', 'css', 'scss', 'sass', 'less'].includes(ext)) return build('web', ext.toUpperCase(), true, false);
  if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico'].includes(ext)) return build('image', 'IMG', false, true);
  if (['zip', 'tar', 'gz', 'tgz', '7z', 'rar', 'bz2'].includes(ext)) return build('archive', 'ZIP', false, true);
  if (name === 'dockerfile' || name.startsWith('docker-compose')) return build('docker', 'DOCKER', true, false);

  return {
    isDir: false,
    extLabel: ext ? ext.toUpperCase().slice(0, 4) : 'FILE',
    isEditable: entry.size < 2 * 1024 * 1024,
    isBinary: false,
    iconColor: 'var(--text-muted)',
    iconBg: 'rgba(255, 255, 255, 0.05)',
    iconSvg: icon('file', { size: 16 }),
  };
}

async function loadFilesView() {
  const p = getSelectedProject();
  if (!p) return;

  if (state.filesProjectId !== p.id) {
    state.filesProjectId = p.id;
    state.filesPath = '';
    state.filesFilter = '';
    filesCloseEditor(true);
  }

  const tableBody = document.getElementById('files-list-body');
  const crumbEl = document.getElementById('files-breadcrumb');
  const upBtn = document.getElementById('files-up-btn');
  const viewTitle = document.getElementById('files-view-title');
  const refreshBtn = document.getElementById('files-refresh-btn');

  if (viewTitle) {
    viewTitle.textContent = `${p.name} — Files & Storage`;
  }

  if (refreshBtn) {
    refreshBtn.classList.add('loading-spin');
    setTimeout(() => refreshBtn.classList.remove('loading-spin'), 600);
  }

  // Render modern breadcrumbs
  const parts = state.filesPath ? state.filesPath.split('/').filter(Boolean) : [];
  let crumbHtml = `<a href="javascript:void(0)" class="file-crumb-item ${parts.length === 0 ? 'active' : ''}" onclick="filesGo('')">
    ${icon('folder-open', { size: 14 })}
    <span>app</span>
  </a>`;

  let acc = '';
  parts.forEach((seg, idx) => {
    acc = filesJoin(acc, seg);
    const isLast = idx === parts.length - 1;
    const safeAcc = escapeHtml(acc).replace(/'/g, '&#39;');
    crumbHtml += `<span class="file-crumb-sep" style="display:inline-flex;align-items:center;opacity:0.4;">/</span><a href="javascript:void(0)" class="file-crumb-item ${isLast ? 'active' : ''}" onclick="filesGo('${safeAcc}')">${escapeHtml(seg)}</a>`;
  });

  if (crumbEl) crumbEl.innerHTML = crumbHtml;
  if (upBtn) upBtn.style.display = parts.length > 0 ? 'inline-flex' : 'none';

  const dropPathLabel = document.getElementById('file-drop-path-label');
  if (dropPathLabel) {
    dropPathLabel.textContent = `Uploading to /app${state.filesPath ? '/' + state.filesPath : ''}`;
  }

  try {
    const res = await api(`/api/projects/${p.id}/files?path=${encodeURIComponent(state.filesPath)}`, { noCache: true });
    state.filesCachedEntries = res.entries || [];
    renderFilesTable();
    setupFileDropzone();
  } catch (err) {
    if (tableBody) {
      tableBody.innerHTML = `<tr><td colspan="4" style="padding: 32px; text-align: center; color: var(--danger-light);">Failed to load files: ${escapeHtml(err.message)}</td></tr>`;
    }
  }
}
window.loadFilesView = loadFilesView;

function renderFilesTable() {
  const tableBody = document.getElementById('files-list-body');
  const emptyState = document.getElementById('files-empty-state');
  const countBadge = document.getElementById('files-count-badge');
  if (!tableBody) return;

  const q = (state.filesFilter || '').toLowerCase().trim();
  const filtered = state.filesCachedEntries.filter((e) => {
    if (!q) return true;
    return e.name.toLowerCase().includes(q);
  });

  if (countBadge) {
    const totalCount = state.filesCachedEntries.length;
    countBadge.textContent = q ? `${filtered.length} of ${totalCount} items` : `${totalCount} item${totalCount === 1 ? '' : 's'}`;
  }

  if (!filtered.length) {
    tableBody.innerHTML = '';
    if (emptyState) {
      emptyState.style.display = 'block';
      if (q) {
        emptyState.innerHTML = `
          <div style="margin-bottom: 8px; color: var(--text-dim);">${icon('search', { size: 30, stroke: 1.5 })}</div>
          <p style="font-size: 14px; font-weight: 600; color: var(--text-main); margin-bottom: 4px;">No matching files found</p>
          <p style="font-size: 12px; color: var(--text-muted); margin-bottom: 12px;">No items match "${escapeHtml(q)}".</p>
          <button class="btn btn-secondary btn-sm" onclick="filesClearFilter()">Clear Filter</button>
        `;
      } else {
        emptyState.innerHTML = `
          <div class="empty-icon-tile">
            ${icon('folder', { size: 30, stroke: 1.5 })}
          </div>
          <p style="font-size: 14px; font-weight: 600; color: var(--text-main); margin-bottom: 4px;">This folder is empty</p>
          <p style="font-size: 12px; color: var(--text-muted); margin-bottom: 16px;">Drag and drop files here, or upload your scripts, binaries, and configurations.</p>
          <div style="display: flex; gap: 8px; justify-content: center;">
            <button class="btn btn-primary btn-sm" onclick="document.getElementById('service-file-upload-input').click()">${icon('upload', { size: 14 })} Upload Files</button>
            <button class="btn btn-secondary btn-sm" onclick="filesNewFile()">${icon('plus', { size: 14 })} Create File</button>
          </div>
        `;
      }
    }
    return;
  }

  if (emptyState) emptyState.style.display = 'none';

  const rows = [];
  filtered.forEach((e) => {
    const full = filesJoin(state.filesPath, e.name);
    const safeFull = escapeHtml(full).replace(/'/g, '&#39;');
    const safeName = escapeHtml(e.name).replace(/'/g, '&#39;');
    const meta = getFileMeta(e);
    const sizeStr = e.is_dir ? '—' : formatFileBytes(e.size);
    const dateObj = formatFileDate(e.modified);

    const clickAction = e.is_dir
      ? `filesGo('${safeFull}')`
      : (meta.isEditable ? `filesOpen('${safeFull}')` : `filesDownload('${safeFull}')`);

    const isEditing = state.filesOpenPath === full;
    rows.push(`
      <tr class="file-tr ${isEditing ? 'file-tr-active' : ''}">
        <td style="padding: 10px 16px;">
          <div class="file-cell-name" onclick="${clickAction}">
            <div class="file-icon-box" style="background: ${meta.iconBg}; color: ${meta.iconColor};">
              ${meta.iconSvg}
            </div>
            <span class="file-name-text" title="${safeName}">${safeName}</span>
            <span class="file-tag-ext" style="background: ${meta.iconBg}; color: ${meta.iconColor};">${meta.extLabel}</span>
          </div>
        </td>
        <td style="padding: 10px 14px; font-family: var(--font-mono); font-size: 12px; color: var(--text-dim);">
          ${sizeStr}
        </td>
        <td style="padding: 10px 14px; font-family: var(--font-mono); font-size: 12px; color: var(--text-dim);" title="${escapeHtml(dateObj.full)}">
          ${dateObj.relative}
        </td>
        <td style="padding: 8px 16px; text-align: right;">
          <div class="file-actions-cell">
            ${meta.isEditable ? `
              <button class="file-btn-action" onclick="filesOpen('${safeFull}')" title="Edit in code editor">
                ${icon('edit', { size: 13 })}
                <span>Edit</span>
              </button>
            ` : ''}
            ${!e.is_dir ? `
              <button class="file-btn-action" onclick="filesDownload('${safeFull}')" title="Download file to computer">
                ${icon('download', { size: 13 })}
                <span>Download</span>
              </button>
            ` : ''}
            <button class="file-btn-action" onclick="filesRename('${safeFull}')" title="Rename item">
              ${icon('pencil', { size: 13 })}
            </button>
            <button class="file-btn-action danger" onclick="filesDelete('${safeFull}')" title="Delete file or folder">
              ${icon('trash', { size: 13 })}
            </button>
          </div>
        </td>
      </tr>
    `);
  });

  tableBody.innerHTML = rows.join('');
}

function filesFilterList(val) {
  state.filesFilter = val || '';
  const clearBtn = document.getElementById('files-filter-clear');
  if (clearBtn) clearBtn.style.display = state.filesFilter ? 'inline-block' : 'none';
  renderFilesTable();
}
window.filesFilterList = filesFilterList;

function filesClearFilter() {
  const input = document.getElementById('files-filter-input');
  if (input) {
    input.value = '';
    input.focus();
  }
  filesFilterList('');
}
window.filesClearFilter = filesClearFilter;

function filesGo(path) {
  state.filesPath = path || '';
  state.filesFilter = '';
  const input = document.getElementById('files-filter-input');
  if (input) input.value = '';
  const clearBtn = document.getElementById('files-filter-clear');
  if (clearBtn) clearBtn.style.display = 'none';
  void loadFilesView();
}
window.filesGo = filesGo;

function filesGoUp() {
  if (!state.filesPath) return;
  const parts = state.filesPath.split('/').filter(Boolean);
  parts.pop();
  filesGo(parts.join('/'));
}
window.filesGoUp = filesGoUp;

function filesCopyCurrentPath() {
  const fullVirtual = `/app${state.filesPath ? '/' + state.filesPath : ''}`;
  navigator.clipboard.writeText(fullVirtual).then(() => {
    toast(`Copied path: ${fullVirtual}`, 'success');
  }).catch(() => {
    toast(`Path: ${fullVirtual}`, 'info');
  });
}
window.filesCopyCurrentPath = filesCopyCurrentPath;

// In-Browser Code / Config Editor
async function filesOpen(path) {
  const p = getSelectedProject();
  if (!p) return;

  try {
    toast(`Loading ${path}...`, 'info');
    const res = await api(`/api/projects/${p.id}/files/content?path=${encodeURIComponent(path)}`, { noCache: true });
    state.filesOpenPath = path;
    state.filesEditorInitialContent = res.content || '';
    state.filesEditorDirty = false;

    const editorCard = document.getElementById('files-editor-card');
    const nameEl = document.getElementById('files-editor-name');
    const textarea = document.getElementById('files-editor');
    const dirtyBadge = document.getElementById('files-editor-dirty-badge');
    const metaEl = document.getElementById('files-editor-meta');
    const iconEl = document.getElementById('files-editor-icon');

    if (nameEl) {
      const parts = path.split('/');
      const fileName = parts.pop();
      const dirPath = parts.length ? parts.join('/') + '/' : '';
      nameEl.innerHTML = `<span style="color:var(--text-dim);font-weight:400;">${escapeHtml(dirPath)}</span>${escapeHtml(fileName)}`;
    }
    if (textarea) textarea.value = res.content || '';
    if (dirtyBadge) dirtyBadge.style.display = 'none';

    const entry = (state.filesCachedEntries || []).find((x) => filesJoin(state.filesPath, x.name) === path);
    if (metaEl && entry) {
      metaEl.textContent = `• ${formatFileBytes(entry.size)}`;
    } else if (metaEl) {
      metaEl.textContent = `• ${formatFileBytes(new Blob([res.content]).size)}`;
    }

    const meta = getFileMeta({ name: path, is_dir: false });
    if (iconEl) {
      iconEl.innerHTML = meta.iconSvg;
    }

    const detectedLang = detectLanguage(path);
    const langBadge = document.getElementById('files-editor-lang-badge');
    if (langBadge) {
      langBadge.textContent = detectedLang.toUpperCase();
      langBadge.style.background = meta.iconBg;
      langBadge.style.color = meta.iconColor;
    }

    if (editorCard) {
      editorCard.style.display = 'block';
      editorCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }

    renderFilesTable();
    updateEditorHighlight();
    updateEditorGutter();
    updateEditorPos();
    bindEditorEvents();

    if (textarea) {
      textarea.scrollTop = 0;
      textarea.scrollLeft = 0;
    }
    const pre = document.getElementById('files-editor-pre');
    if (pre) {
      pre.scrollTop = 0;
      pre.scrollLeft = 0;
    }
    if (gutter) {
      gutter.scrollTop = 0;
    }
  } catch (err) {
    toast(err.message, 'error');
  }
}
window.filesOpen = filesOpen;

function updateEditorHighlight() {
  const textarea = document.getElementById('files-editor');
  const codeEl = document.getElementById('files-editor-code');
  const card = document.getElementById('files-editor-card');
  if (!textarea || !codeEl) return;

  const content = textarea.value;
  // If file is excessively large, fallback to plain text textarea rendering
  if (content.length > 500000 || content.split('\n').length > 15000) {
    if (card) card.classList.add('no-highlight');
    codeEl.textContent = content;
    return;
  }

  if (card) card.classList.remove('no-highlight');
  const lang = detectLanguage(state.filesOpenPath || '');
  codeEl.innerHTML = highlightCode(content, lang);
}

function updateEditorGutter() {
  const textarea = document.getElementById('files-editor');
  const gutter = document.getElementById('files-editor-gutter');
  const linesSpan = document.getElementById('files-editor-lines');
  const sizeSpan = document.getElementById('files-editor-size');
  if (!textarea || !gutter) return;

  const content = textarea.value;
  const lineCount = content.split('\n').length;
  let nums = '';
  for (let i = 1; i <= lineCount; i++) {
    nums += i + '\n';
  }
  gutter.textContent = nums;

  if (linesSpan) linesSpan.textContent = `${lineCount} line${lineCount === 1 ? '' : 's'}`;
  if (sizeSpan) sizeSpan.textContent = formatFileBytes(new Blob([content]).size);
}

function updateEditorPos() {
  const textarea = document.getElementById('files-editor');
  const posSpan = document.getElementById('files-editor-pos');
  if (!textarea || !posSpan) return;

  const text = textarea.value.slice(0, textarea.selectionStart);
  const lines = text.split('\n');
  const row = lines.length;
  const col = lines[lines.length - 1].length + 1;
  posSpan.textContent = `Ln ${row}, Col ${col}`;
}

function bindEditorEvents() {
  const textarea = document.getElementById('files-editor');
  const gutter = document.getElementById('files-editor-gutter');
  const pre = document.getElementById('files-editor-pre');
  if (!textarea || textarea.dataset.bound) return;
  textarea.dataset.bound = 'true';

  // Sync scroll
  textarea.addEventListener('scroll', () => {
    if (gutter) gutter.scrollTop = textarea.scrollTop;
    if (pre) {
      pre.scrollTop = textarea.scrollTop;
      pre.scrollLeft = textarea.scrollLeft;
    }
  });

  // Track cursor position
  textarea.addEventListener('keyup', updateEditorPos);
  textarea.addEventListener('click', updateEditorPos);

  // Track dirty state, syntax highlight, and gutter updates
  textarea.addEventListener('input', () => {
    updateEditorHighlight();
    updateEditorGutter();
    updateEditorPos();
    const isDirty = textarea.value !== state.filesEditorInitialContent;
    state.filesEditorDirty = isDirty;
    const dirtyBadge = document.getElementById('files-editor-dirty-badge');
    if (dirtyBadge) dirtyBadge.style.display = isDirty ? 'inline-block' : 'none';
  });

  // Handle Tab key indentation and Ctrl+S / Cmd+S save
  textarea.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) {
      e.preventDefault();
      void filesSaveCurrent();
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      filesCloseEditor();
      return;
    }
    if (e.key === 'Tab') {
      e.preventDefault();
      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      const val = textarea.value;
      textarea.value = val.substring(0, start) + '  ' + val.substring(end);
      textarea.selectionStart = textarea.selectionEnd = start + 2;
      textarea.dispatchEvent(new Event('input'));
    }
  });
}

function filesToggleFullscreen() {
  const card = document.getElementById('files-editor-card');
  const btn = document.getElementById('files-fullscreen-btn');
  if (!card) return;
  const isFull = card.classList.toggle('fullscreen');
  if (btn) {
    btn.innerHTML = isFull
      ? `${icon('x', { size: 13 })} <span>Exit Fullscreen</span>`
      : `${icon('external-link', { size: 13 })} <span>Fullscreen</span>`;
  }
}
window.filesToggleFullscreen = filesToggleFullscreen;

function filesCloseEditor(force = false) {
  if (!force && state.filesEditorDirty) {
    if (!confirm('You have unsaved changes. Discard and close editor?')) {
      return;
    }
  }
  state.filesOpenPath = null;
  state.filesEditorDirty = false;
  const card = document.getElementById('files-editor-card');
  if (card) {
    card.classList.remove('fullscreen');
    card.style.display = 'none';
  }
  const codeEl = document.getElementById('files-editor-code');
  if (codeEl) codeEl.innerHTML = '';
  const textarea = document.getElementById('files-editor');
  if (textarea) textarea.value = '';
  renderFilesTable();
}
window.filesCloseEditor = filesCloseEditor;

async function filesSaveCurrent() {
  const p = getSelectedProject();
  if (!p || !state.filesOpenPath) return;

  const btn = document.getElementById('files-save-btn');
  const textarea = document.getElementById('files-editor');
  const dirtyBadge = document.getElementById('files-editor-dirty-badge');
  if (btn) btn.disabled = true;

  try {
    await api(`/api/projects/${p.id}/files/content`, {
      method: 'PUT',
      body: { path: state.filesOpenPath, content: textarea ? textarea.value : '' },
    });
    state.filesEditorInitialContent = textarea ? textarea.value : '';
    state.filesEditorDirty = false;
    if (dirtyBadge) dirtyBadge.style.display = 'none';
    toast(`Saved ${state.filesOpenPath}. Restart service to apply changes.`, 'success');
    void loadFilesView();
  } catch (err) {
    toast(`Save failed: ${err.message}`, 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}
window.filesSaveCurrent = filesSaveCurrent;

function filesDownload(path) {
  const p = getSelectedProject();
  if (!p) return;
  const url = `/api/projects/${p.id}/files/download?path=${encodeURIComponent(path)}`;
  const a = document.createElement('a');
  a.href = url;
  a.download = path.split('/').pop() || 'download';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  toast(`Downloading ${path.split('/').pop()}...`, 'info');
}
window.filesDownload = filesDownload;

function filesDownloadCurrent() {
  if (!state.filesOpenPath) return;
  filesDownload(state.filesOpenPath);
}
window.filesDownloadCurrent = filesDownloadCurrent;

async function filesRename(path) {
  const p = getSelectedProject();
  if (!p) return;

  const currentName = path.split('/').pop();
  const parentPath = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';

  const input = await showPromptDialog({
    title: 'Rename File or Folder',
    message: `Enter new name for "${currentName}":`,
    placeholder: currentName,
    defaultValue: currentName,
    confirmText: 'Rename',
  });

  const newName = (input || '').trim();
  if (!newName || newName === currentName) return;

  const newPath = filesJoin(parentPath, newName);

  try {
    await api(`/api/projects/${p.id}/files/rename`, {
      method: 'POST',
      body: { old_path: path, new_path: newPath },
    });
    toast(`Renamed to "${newName}"`, 'success');
    if (state.filesOpenPath === path) {
      state.filesOpenPath = newPath;
      const nameEl = document.getElementById('files-editor-name');
      if (nameEl) nameEl.textContent = newPath;
    }
    await loadFilesView();
  } catch (err) {
    toast(`Rename failed: ${err.message}`, 'error');
  }
}
window.filesRename = filesRename;

async function filesNewFile() {
  const p = getSelectedProject();
  if (!p) return;
  const input = await showPromptDialog({
    title: 'New File',
    message: `Create a file in /app${state.filesPath ? '/' + state.filesPath : ''}:`,
    placeholder: 'e.g. .env, config.json, or start.sh',
    confirmText: 'Create File',
  });
  const name = (input || '').trim();
  if (!name) return;
  const path = filesJoin(state.filesPath, name);
  try {
    await api(`/api/projects/${p.id}/files/content`, { method: 'PUT', body: { path, content: '' } });
    toast(`Created ${name}`, 'success');
    await loadFilesView();
    await filesOpen(path);
  } catch (err) {
    toast(`Failed to create file: ${err.message}`, 'error');
  }
}
window.filesNewFile = filesNewFile;

async function filesNewFolder() {
  const p = getSelectedProject();
  if (!p) return;
  const input = await showPromptDialog({
    title: 'New Folder',
    message: `Create a subfolder in /app${state.filesPath ? '/' + state.filesPath : ''}:`,
    placeholder: 'e.g. config, assets, or src',
    confirmText: 'Create Folder',
  });
  const name = (input || '').trim();
  if (!name) return;
  try {
    await api(`/api/projects/${p.id}/files/mkdir`, { method: 'POST', body: { path: filesJoin(state.filesPath, name) } });
    toast(`Folder "${name}" created`, 'success');
    await loadFilesView();
  } catch (err) {
    toast(`Failed to create folder: ${err.message}`, 'error');
  }
}
window.filesNewFolder = filesNewFolder;

async function filesDelete(path) {
  const p = getSelectedProject();
  if (!p) return;
  const itemName = path.split('/').pop();
  const ok = await showConfirmDialog({
    title: 'Delete File or Folder',
    message: `Are you sure you want to permanently delete "${itemName}"? This cannot be undone.`,
    confirmText: 'Delete Permanently',
    danger: true,
  });
  if (!ok) return;
  try {
    await api(`/api/projects/${p.id}/files?path=${encodeURIComponent(path)}`, { method: 'DELETE' });
    toast(`Deleted ${itemName}`, 'success');
    if (state.filesOpenPath === path) filesCloseEditor(true);
    await loadFilesView();
  } catch (err) {
    toast(`Delete failed: ${err.message}`, 'error');
  }
}
window.filesDelete = filesDelete;

async function uploadFileList(files) {
  const p = getSelectedProject();
  if (!p || !files || !files.length) return;

  const formData = new FormData();
  for (let i = 0; i < files.length; i++) {
    // Preserve webkitRelativePath if folder upload, otherwise use file name
    const relPath = files[i].webkitRelativePath || files[i].name;
    formData.append('file', files[i], relPath);
  }

  try {
    toast(`Uploading ${files.length} file(s)...`, 'info');
    const pathParam = encodeURIComponent(state.filesPath || '');
    const res = await fetch(`/api/projects/${p.id}/files/upload?path=${pathParam}`, {
      method: 'POST',
      headers: {
        'x-csrf-token': state.csrf || '',
      },
      body: formData,
    });
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(errText || 'Upload failed');
    }
    toast(`Successfully uploaded ${files.length} file(s)!`, 'success');
    await loadFilesView();
  } catch (err) {
    toast(`Upload failed: ${err.message}`, 'error');
  }
}

async function handleFilesUpload(e) {
  const files = e.target?.files;
  if (files && files.length) {
    await uploadFileList(files);
  }
  if (e.target) e.target.value = '';
}
window.handleFilesUpload = handleFilesUpload;

async function handleFolderUpload(e) {
  const files = e.target?.files;
  if (files && files.length) {
    await uploadFileList(files);
  }
  if (e.target) e.target.value = '';
}
window.handleFolderUpload = handleFolderUpload;

function setupFileDropzone() {
  const dropzone = document.getElementById('file-explorer-dropzone');
  const overlay = document.getElementById('file-drop-overlay');
  if (!dropzone || dropzone.dataset.dropBound) return;
  dropzone.dataset.dropBound = 'true';

  let dragCounter = 0;

  dropzone.addEventListener('dragenter', (e) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter++;
    if (overlay) overlay.style.display = 'flex';
    dropzone.classList.add('drag-active');
  });

  dropzone.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'copy';
  });

  dropzone.addEventListener('dragleave', (e) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter--;
    if (dragCounter <= 0) {
      dragCounter = 0;
      if (overlay) overlay.style.display = 'none';
      dropzone.classList.remove('drag-active');
    }
  });

  dropzone.addEventListener('drop', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter = 0;
    if (overlay) overlay.style.display = 'none';
    dropzone.classList.remove('drag-active');

    const dt = e.dataTransfer;
    if (dt && dt.files && dt.files.length) {
      await uploadFileList(dt.files);
    }
  });
}
window.setupFileDropzone = setupFileDropzone;



export {
  loadFilesView,
  renderFilesTable,
  filesFilterList,
  filesClearFilter,
  filesGo,
  filesGoUp,
  filesCopyCurrentPath,
  filesOpen,
  filesCloseEditor,
  filesToggleFullscreen,
  filesSaveCurrent,
  filesDownload,
  filesDownloadCurrent,
  filesRename,
  filesNewFile,
  filesNewFolder,
  filesDelete,
  handleFilesUpload,
  handleFolderUpload,
  setupFileDropzone,
};
