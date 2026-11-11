/**
 * WebDep File Explorer & In-Browser IDE Subsystem
 * Enterprise file manager, directory navigator, syntax editor, and file upload dropzone
 */

import { state, escapeHtml, formatDate, showConfirmDialog, showPromptDialog, copyTextToClipboard } from './state.js';
import { api, toast } from './api.js';

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
  if (entry.is_dir) {
    return {
      isDir: true,
      extLabel: 'DIR',
      isEditable: false,
      isBinary: false,
      iconColor: '#eab308',
      iconBg: 'rgba(234, 179, 8, 0.12)',
      iconSvg: `<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>`,
    };
  }

  const name = entry.name.toLowerCase();
  const ext = name.includes('.') ? name.split('.').pop() : '';

  // Java JAR / Class
  if (ext === 'jar' || ext === 'war' || ext === 'class') {
    return {
      isDir: false,
      extLabel: ext.toUpperCase(),
      isEditable: false,
      isBinary: true,
      iconColor: '#f97316',
      iconBg: 'rgba(249, 115, 22, 0.14)',
      iconSvg: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 8h1a4 4 0 0 1 0 8h-1"></path><path d="M2 8h16v9a4 4 0 0 1-4 4H6a4 4 0 0 1-4-4V8z"></path><line x1="6" y1="1" x2="6" y2="4"></line><line x1="10" y1="1" x2="10" y2="4"></line><line x1="14" y1="1" x2="14" y2="4"></line></svg>`,
    };
  }

  // Python
  if (ext === 'py' || ext === 'pyw' || ext === 'ipynb') {
    return {
      isDir: false,
      extLabel: 'PY',
      isEditable: true,
      isBinary: false,
      iconColor: '#38bdf8',
      iconBg: 'rgba(56, 189, 248, 0.14)',
      iconSvg: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 14H9v-2h2v2zm0-4H9V7h2v5z"></path></svg>`,
    };
  }

  // JavaScript
  if (ext === 'js' || ext === 'mjs' || ext === 'cjs') {
    return {
      isDir: false,
      extLabel: 'JS',
      isEditable: true,
      isBinary: false,
      iconColor: '#eab308',
      iconBg: 'rgba(234, 179, 8, 0.14)',
      iconSvg: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon></svg>`,
    };
  }

  // TypeScript
  if (ext === 'ts' || ext === 'tsx') {
    return {
      isDir: false,
      extLabel: 'TS',
      isEditable: true,
      isBinary: false,
      iconColor: '#3b82f6',
      iconBg: 'rgba(59, 130, 246, 0.14)',
      iconSvg: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="4 7 4 4 20 4 20 7"></polyline><line x1="9" y1="20" x2="15" y2="20"></line><line x1="12" y1="4" x2="12" y2="20"></line></svg>`,
    };
  }

  // Secrets & Environment
  if (name === '.env' || name.startsWith('.env.')) {
    return {
      isDir: false,
      extLabel: 'ENV',
      isEditable: true,
      isBinary: false,
      iconColor: '#10b981',
      iconBg: 'rgba(16, 185, 129, 0.15)',
      iconSvg: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>`,
    };
  }

  // JSON / YAML / Config
  if (ext === 'json' || ext === 'yaml' || ext === 'yml' || ext === 'toml' || ext === 'xml' || ext === 'ini' || ext === 'conf' || ext === 'config') {
    return {
      isDir: false,
      extLabel: ext.toUpperCase() || 'CONF',
      isEditable: true,
      isBinary: false,
      iconColor: '#a855f7',
      iconBg: 'rgba(168, 85, 247, 0.14)',
      iconSvg: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>`,
    };
  }

  // Shell scripts
  if (ext === 'sh' || ext === 'bash' || ext === 'bat' || ext === 'cmd' || ext === 'ps1') {
    return {
      isDir: false,
      extLabel: 'SHELL',
      isEditable: true,
      isBinary: false,
      iconColor: '#22c55e',
      iconBg: 'rgba(34, 197, 94, 0.14)',
      iconSvg: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="4 17 10 11 4 5"></polyline><line x1="12" y1="19" x2="20" y2="19"></line></svg>`,
    };
  }

  // Markdown & Documentation
  if (ext === 'md' || ext === 'txt' || ext === 'log') {
    return {
      isDir: false,
      extLabel: ext.toUpperCase(),
      isEditable: true,
      isBinary: false,
      iconColor: '#60a5fa',
      iconBg: 'rgba(96, 165, 250, 0.14)',
      iconSvg: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line><polyline points="10 9 9 9 8 9"></polyline></svg>`,
    };
  }

  // Web markup & styling
  if (ext === 'html' || ext === 'htm' || ext === 'css' || ext === 'scss') {
    return {
      isDir: false,
      extLabel: ext.toUpperCase(),
      isEditable: true,
      isBinary: false,
      iconColor: '#f59e0b',
      iconBg: 'rgba(245, 158, 11, 0.14)',
      iconSvg: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="16 18 22 12 16 6"></polyline><polyline points="8 6 2 12 8 18"></polyline></svg>`,
    };
  }

  // Images
  if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico'].includes(ext)) {
    return {
      isDir: false,
      extLabel: 'IMG',
      isEditable: false,
      isBinary: true,
      iconColor: '#ec4899',
      iconBg: 'rgba(236, 72, 153, 0.14)',
      iconSvg: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline></svg>`,
    };
  }

  // Archives
  if (['zip', 'tar', 'gz', 'tgz', '7z', 'rar', 'bz2'].includes(ext)) {
    return {
      isDir: false,
      extLabel: 'ZIP',
      isEditable: false,
      isBinary: true,
      iconColor: '#f97316',
      iconBg: 'rgba(249, 115, 22, 0.14)',
      iconSvg: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path><polyline points="3.27 6.96 12 12.01 20.73 6.96"></polyline><line x1="12" y1="22.08" x2="12" y2="12"></line></svg>`,
    };
  }

  // Docker
  if (name === 'dockerfile' || name.startsWith('docker-compose')) {
    return {
      isDir: false,
      extLabel: 'DOCKER',
      isEditable: true,
      isBinary: false,
      iconColor: '#0ea5e9',
      iconBg: 'rgba(14, 165, 233, 0.14)',
      iconSvg: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242"></path><path d="M12 12v9"></path><path d="m8 17 4 4 4-4"></path></svg>`,
    };
  }

  // Generic File
  return {
    isDir: false,
    extLabel: ext ? ext.toUpperCase().slice(0, 4) : 'FILE',
    isEditable: entry.size < 2 * 1024 * 1024,
    isBinary: false,
    iconColor: 'var(--text-muted)',
    iconBg: 'rgba(255, 255, 255, 0.05)',
    iconSvg: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"></path><polyline points="13 2 13 9 20 9"></polyline></svg>`,
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
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>
    <span>app</span>
  </a>`;

  let acc = '';
  parts.forEach((seg, idx) => {
    acc = filesJoin(acc, seg);
    const isLast = idx === parts.length - 1;
    const safeAcc = escapeHtml(acc).replace(/'/g, '&#39;');
    crumbHtml += `<span class="file-crumb-sep">/</span><a href="javascript:void(0)" class="file-crumb-item ${isLast ? 'active' : ''}" onclick="filesGo('${safeAcc}')">${escapeHtml(seg)}</a>`;
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
          <div style="font-size: 28px; margin-bottom: 8px;">🔍</div>
          <p style="font-size: 14px; font-weight: 600; color: var(--text-main); margin-bottom: 4px;">No matching files found</p>
          <p style="font-size: 12px; color: var(--text-muted); margin-bottom: 12px;">No items match "${escapeHtml(q)}".</p>
          <button class="btn btn-secondary btn-sm" onclick="filesClearFilter()">Clear Filter</button>
        `;
      } else {
        emptyState.innerHTML = `
          <div style="width: 52px; height: 52px; margin: 0 auto 12px; border-radius: 12px; background: rgba(59, 130, 246, 0.1); color: var(--accent-light); display: flex; align-items: center; justify-content: center;">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>
          </div>
          <p style="font-size: 14px; font-weight: 600; color: var(--text-main); margin-bottom: 4px;">This folder is empty</p>
          <p style="font-size: 12px; color: var(--text-muted); margin-bottom: 16px;">Drag and drop files here, or upload your scripts, binaries, and configurations.</p>
          <div style="display: flex; gap: 8px; justify-content: center;">
            <button class="btn btn-primary btn-sm" onclick="document.getElementById('service-file-upload-input').click()">Upload Files</button>
            <button class="btn btn-secondary btn-sm" onclick="filesNewFile()">Create File</button>
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

    rows.push(`
      <tr class="file-tr">
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
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M12 20h9"></path><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path></svg>
                <span>Edit</span>
              </button>
            ` : ''}
            ${!e.is_dir ? `
              <button class="file-btn-action" onclick="filesDownload('${safeFull}')" title="Download file to computer">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
                <span>Download</span>
              </button>
            ` : ''}
            <button class="file-btn-action" onclick="filesRename('${safeFull}')" title="Rename item">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>
            </button>
            <button class="file-btn-action danger" onclick="filesDelete('${safeFull}')" title="Delete file or folder">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
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

    if (nameEl) nameEl.textContent = path;
    if (textarea) textarea.value = res.content || '';
    if (dirtyBadge) dirtyBadge.style.display = 'none';

    const entry = (state.filesCachedEntries || []).find((x) => filesJoin(state.filesPath, x.name) === path);
    if (metaEl && entry) {
      metaEl.textContent = `• ${formatFileBytes(entry.size)}`;
    } else if (metaEl) {
      metaEl.textContent = `• ${formatFileBytes(new Blob([res.content]).size)}`;
    }

    if (iconEl) {
      const meta = getFileMeta({ name: path, is_dir: false });
      iconEl.textContent = meta.extLabel === 'ENV' ? '🔒' : (meta.extLabel === 'JAR' ? '☕' : '📄');
    }

    if (editorCard) {
      editorCard.style.display = 'block';
      editorCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }

    updateEditorGutter();
    bindEditorEvents();
  } catch (err) {
    toast(err.message, 'error');
  }
}
window.filesOpen = filesOpen;

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
  if (!textarea || textarea.dataset.bound) return;
  textarea.dataset.bound = 'true';

  // Sync scroll
  textarea.addEventListener('scroll', () => {
    if (gutter) gutter.scrollTop = textarea.scrollTop;
  });

  // Track cursor position
  textarea.addEventListener('keyup', updateEditorPos);
  textarea.addEventListener('click', updateEditorPos);

  // Track dirty state and gutter updates
  textarea.addEventListener('input', () => {
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

function filesCloseEditor(force = false) {
  if (!force && state.filesEditorDirty) {
    if (!confirm('You have unsaved changes. Discard and close editor?')) {
      return;
    }
  }
  state.filesOpenPath = null;
  state.filesEditorDirty = false;
  const card = document.getElementById('files-editor-card');
  if (card) card.style.display = 'none';
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
