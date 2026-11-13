/**
 * WebDep File Explorer & Storage Management Subsystem
 * Directory navigator, breadcrumbs, search filter, file actions, and drag-and-drop uploader.
 */

import { DEVICONS, icon } from './icons.js';
import { state, escapeHtml, formatDate, showConfirmDialog, showPromptDialog, copyTextToClipboard, getFilesEntityContext } from './state.js';
import { api, toast } from './api.js';

// Re-export editor submodule so imports from './files.js' remain 100% compatible
export * from './files_editor.js';

import { filesCloseEditor, filesOpen } from './files_editor.js';

state.filesPath = '';
state.filesOpenPath = null;
state.filesProjectId = null;
state.filesCachedEntries = [];
state.filesFilter = '';
state.filesEditorInitialContent = '';
state.filesEditorDirty = false;

export function filesJoin(dir, name) {
  if (!dir) return name;
  return dir.endsWith('/') ? `${dir}${name}` : `${dir}/${name}`;
}

export function formatFileBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  if (i === 0) return `${bytes} B`;
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}

export function formatFileDate(unixSec) {
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

const FILE_EXT_GROUPS = [
  { exts: ['jar', 'war', 'class'], icon: 'java', label: null, editable: false, binary: true },
  { exts: ['java'], icon: 'java', label: 'Java', editable: true, binary: false },
  { exts: ['zip', 'tar', 'gz', 'tgz', '7z', 'rar', 'bz2'], icon: 'file-archive', label: 'Zip', editable: false, binary: true },
  { exts: ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico'], icon: 'file-image', label: 'Img', editable: false, binary: true },
  { exts: ['db', 'sqlite', 'sqlite3'], icon: 'sqlite', label: null, editable: false, binary: true },
  { exts: ['sql'], icon: 'postgresql', label: 'SQL', editable: true, binary: false },
  { exts: ['py', 'pyw', 'ipynb'], icon: 'python', label: 'PY', editable: true, binary: false },
  { exts: ['js', 'mjs', 'cjs'], icon: 'javascript', label: 'JS', editable: true, binary: false },
  { exts: ['jsx'], icon: 'react', label: 'JSX', editable: true, binary: false },
  { exts: ['tsx'], icon: 'react', label: 'TSX', editable: true, binary: false },
  { exts: ['ts'], icon: 'typescript', label: 'TS', editable: true, binary: false },
  { exts: ['vue'], icon: 'vuejs', label: 'Vue', editable: true, binary: false },
  { exts: ['svelte'], icon: 'svelte', label: null, editable: true, binary: false },
  { exts: ['rs'], icon: 'rust', label: 'RS', editable: true, binary: false },
  { exts: ['go'], icon: 'go', label: 'GO', editable: true, binary: false },
  { exts: ['php'], icon: 'php', label: 'PHP', editable: true, binary: false },
  { exts: ['rb', 'erb'], icon: 'ruby', label: 'RB', editable: true, binary: false },
  { exts: ['html', 'htm'], icon: 'html5', label: null, editable: true, binary: false },
  { exts: ['css', 'less'], icon: 'css3', label: null, editable: true, binary: false },
  { exts: ['scss', 'sass'], icon: 'sass', label: null, editable: true, binary: false },
  { exts: ['json'], icon: 'json', label: null, editable: true, binary: false },
  { exts: ['yaml', 'yml'], icon: 'yaml', label: null, editable: true, binary: false },
  { exts: ['toml'], icon: 'toml', label: null, editable: true, binary: false },
  { exts: ['xml'], icon: 'xml', label: null, editable: true, binary: false },
  { exts: ['ini', 'conf', 'config'], icon: 'file-json', label: null, editable: true, binary: false },
  { exts: ['ps1'], icon: 'powershell', label: 'PS1', editable: true, binary: false },
  { exts: ['sh', 'bash', 'bat', 'cmd'], icon: 'bash', label: 'Shell', editable: true, binary: false },
  { exts: ['md', 'mdx'], icon: 'markdown', label: 'MD', editable: true, binary: false },
  { exts: ['txt', 'log'], icon: 'file-text', label: null, editable: true, binary: false },
];

const FILE_EXT_MAP = Object.fromEntries(
  FILE_EXT_GROUPS.flatMap((g) => g.exts.map((ext) => [ext, g])),
);

const FILE_NAME_RULES = [
  { match: (n) => n === '.env' || n.startsWith('.env.'), icon: 'file-lock', label: 'Env', editable: true, binary: false },
  { match: (n) => n === 'dockerfile' || n.startsWith('dockerfile.'), icon: 'docker', label: 'Docker', editable: true, binary: false },
  { match: (n) => n === '.dockerignore', icon: 'docker', label: 'Dock', editable: true, binary: false },
  { match: (n) => n.startsWith('docker-compose') || n === 'compose.yaml' || n === 'compose.yml', icon: 'docker', label: null, editable: true, binary: false },
  { match: (n) => n === '.gitignore' || n === '.gitattributes' || n === '.gitmodules', icon: 'git', label: 'Git', editable: true, binary: false },
  { match: (n) => n === 'package.json' || n === 'package-lock.json', icon: 'npm', label: null, editable: true, binary: false },
  { match: (n) => n.startsWith('vite.config.'), icon: 'vitejs', label: null, editable: true, binary: false },
  { match: (n) => n === 'netlify.toml', icon: 'netlify', label: 'TOML', editable: true, binary: false },
  { match: (n) => n === 'nginx.conf' || n.endsWith('.nginx'), icon: 'nginx', label: null, editable: true, binary: false },
];

export function getFileMeta(entry) {
  const make = (iconName, extLabel, isEditable, isBinary, isDir = false) => ({
    isDir,
    extLabel,
    isEditable,
    isBinary,
    iconColor: isDir ? 'var(--text-main)' : 'var(--text-muted)',
    boxColor: (isDir || DEVICONS[iconName]) ? 'var(--text-main)' : 'var(--text-muted)',
    iconBg: isDir ? 'rgba(238, 241, 247, 0.08)' : 'rgba(238, 241, 247, 0.05)',
    iconSvg: icon(iconName, { size: 17 }),
  });

  if (entry.is_dir) return make('folder', 'Dir', false, false, true);

  const name = entry.name.toLowerCase();
  const baseName = name.includes('/') ? name.split('/').pop() : name;
  const ext = baseName.includes('.') ? baseName.split('.').pop() : '';

  const nameRule = FILE_NAME_RULES.find((r) => r.match(baseName));
  if (nameRule) {
    return make(nameRule.icon, nameRule.label || (ext ? ext.toUpperCase() : 'File'), nameRule.editable, nameRule.binary);
  }

  const spec = FILE_EXT_MAP[ext];
  if (spec) {
    return make(spec.icon, spec.label || ext.toUpperCase() || 'File', spec.editable, spec.binary);
  }

  return make('file', ext ? ext.toUpperCase().slice(0, 4) : 'File', entry.size < 2 * 1024 * 1024, false);
}

export async function loadFilesView() {
  const ctx = getFilesEntityContext();
  if (!ctx) return;

  if (state.filesProjectId !== ctx.key) {
    state.filesProjectId = ctx.key;
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
    viewTitle.textContent = ctx.kind === 'database'
      ? `${ctx.name} — Cluster Files (Read-Only)`
      : `${ctx.name} — Files & Storage`;
  }

  if (refreshBtn) {
    refreshBtn.classList.add('loading-spin');
    setTimeout(() => refreshBtn.classList.remove('loading-spin'), 600);
  }

  const parts = state.filesPath ? state.filesPath.split('/').filter(Boolean) : [];
  let crumbHtml = `<a href="javascript:void(0)" class="file-crumb-item ${parts.length === 0 ? 'active' : ''}" onclick="filesGo('')">
    ${icon('folder-open', { size: 14 })}
    <span>${escapeHtml(ctx.rootLabel)}</span>
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
    dropPathLabel.textContent = `Uploading to /${ctx.rootLabel}${state.filesPath ? '/' + state.filesPath : ''}`;
  }

  document.querySelectorAll('.files-write-only').forEach((el) => {
    el.style.display = ctx.canWrite ? '' : 'none';
  });

  try {
    const res = await api(`${ctx.baseUrl}?path=${encodeURIComponent(state.filesPath)}`, { noCache: true });
    state.filesCachedEntries = res.entries || [];
    renderFilesTable();
    setupFileDropzone();
  } catch (err) {
    if (tableBody) {
      tableBody.innerHTML = `<tr><td colspan="4" style="padding: 32px; text-align: center; color: var(--danger-light);">Failed to load files: ${escapeHtml(err.message)}</td></tr>`;
    }
  }
}

export function renderFilesTable() {
  const tableBody = document.getElementById('files-list-body');
  const emptyState = document.getElementById('files-empty-state');
  const countBadge = document.getElementById('files-count-badge');
  if (!tableBody) return;

  const canWriteFiles = !!getFilesEntityContext()?.canWrite;
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
            <div class="file-icon-box" style="background: transparent; color: ${meta.boxColor};">
              ${meta.iconSvg}
            </div>
            <span class="file-name-text" title="${safeName}">${safeName}</span>
            <span class="file-tag-ext" style="background: ${meta.iconBg}; color: ${meta.iconColor};">${meta.extLabel}</span>
          </div>
        </td>
        <td style="padding: 8px 16px; font-family: var(--font-mono); font-size: 12px; color: var(--text-dim);">
          ${sizeStr}
        </td>
        <td style="padding: 8px 16px; font-family: var(--font-mono); font-size: 12px; color: var(--text-dim);" title="${escapeHtml(dateObj.full)}">
          ${dateObj.relative}
        </td>
        <td style="padding: 8px 16px; text-align: right;">
          <div class="file-actions-cell">
            ${meta.isEditable ? `
              <button class="file-btn-action" onclick="filesOpen('${safeFull}')" title="${canWriteFiles ? 'Edit in code editor' : 'View in code viewer'}">
                ${icon(canWriteFiles ? 'edit' : 'eye', { size: 13 })}
                <span>${canWriteFiles ? 'Edit' : 'View'}</span>
              </button>
            ` : ''}
            ${!e.is_dir ? `
              <button class="file-btn-action" onclick="filesDownload('${safeFull}')" title="Download file to computer">
                ${icon('download', { size: 13 })}
                <span>Download</span>
              </button>
            ` : ''}
            ${canWriteFiles ? `
              <button class="file-btn-action" onclick="filesRename('${safeFull}')" title="Rename item">
                ${icon('pencil', { size: 13 })}
              </button>
              <button class="file-btn-action danger" onclick="filesDelete('${safeFull}')" title="Delete file or folder">
                ${icon('trash', { size: 13 })}
              </button>
            ` : ''}
          </div>
        </td>
      </tr>
    `);
  });

  tableBody.innerHTML = rows.join('');
}

export function filesFilterList(val) {
  state.filesFilter = val || '';
  const clearBtn = document.getElementById('files-filter-clear');
  if (clearBtn) clearBtn.style.display = state.filesFilter ? 'inline-block' : 'none';
  renderFilesTable();
}

export function filesClearFilter() {
  const input = document.getElementById('files-filter-input');
  if (input) {
    input.value = '';
    input.focus();
  }
  filesFilterList('');
}

export function filesGo(path) {
  state.filesPath = path || '';
  state.filesFilter = '';
  const input = document.getElementById('files-filter-input');
  if (input) input.value = '';
  const clearBtn = document.getElementById('files-filter-clear');
  if (clearBtn) clearBtn.style.display = 'none';
  void loadFilesView();
}

export function filesGoUp() {
  if (!state.filesPath) return;
  const parts = state.filesPath.split('/').filter(Boolean);
  parts.pop();
  filesGo(parts.join('/'));
}

export function filesCopyCurrentPath() {
  const ctx = getFilesEntityContext();
  const rootLabel = ctx ? ctx.rootLabel : 'app';
  const fullVirtual = `/${rootLabel}${state.filesPath ? '/' + state.filesPath : ''}`;
  navigator.clipboard.writeText(fullVirtual).then(() => {
    toast(`Copied path: ${fullVirtual}`, 'success');
  }).catch(() => {
    toast(`Path: ${fullVirtual}`, 'info');
  });
}

export function filesDownload(path) {
  const ctx = getFilesEntityContext();
  if (!ctx) return;
  const url = `${ctx.baseUrl}/download?path=${encodeURIComponent(path)}`;
  const a = document.createElement('a');
  a.href = url;
  a.download = path.split('/').pop() || 'download';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  toast(`Downloading ${path.split('/').pop()}`, 'info');
}

export function filesDownloadCurrent() {
  if (!state.filesOpenPath) return;
  filesDownload(state.filesOpenPath);
}

export async function filesRename(path) {
  const ctx = getFilesEntityContext();
  if (!ctx) return;

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
    await api(`${ctx.baseUrl}/rename`, {
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

export async function filesNewFile() {
  const ctx = getFilesEntityContext();
  if (!ctx) return;
  const input = await showPromptDialog({
    title: 'New File',
    message: `Create a file in /${ctx.rootLabel}${state.filesPath ? '/' + state.filesPath : ''}:`,
    placeholder: ctx.kind === 'database' ? 'e.g. notes.sql or custom.conf' : 'e.g. .env, config.json, or start.sh',
    confirmText: 'Create File',
  });
  const name = (input || '').trim();
  if (!name) return;
  const path = filesJoin(state.filesPath, name);
  try {
    await api(`${ctx.baseUrl}/content`, { method: 'PUT', body: { path, content: '' } });
    toast(`Created ${name}`, 'success');
    await loadFilesView();
    await filesOpen(path);
  } catch (err) {
    toast(`Failed to create file: ${err.message}`, 'error');
  }
}

export async function filesNewFolder() {
  const ctx = getFilesEntityContext();
  if (!ctx) return;
  const input = await showPromptDialog({
    title: 'New Folder',
    message: `Create a subfolder in /${ctx.rootLabel}${state.filesPath ? '/' + state.filesPath : ''}:`,
    placeholder: 'e.g. config, assets, or src',
    confirmText: 'Create Folder',
  });
  const name = (input || '').trim();
  if (!name) return;
  try {
    await api(`${ctx.baseUrl}/mkdir`, { method: 'POST', body: { path: filesJoin(state.filesPath, name) } });
    toast(`Folder "${name}" created`, 'success');
    await loadFilesView();
  } catch (err) {
    toast(`Failed to create folder: ${err.message}`, 'error');
  }
}

export async function filesDelete(path) {
  const ctx = getFilesEntityContext();
  if (!ctx) return;
  const itemName = path.split('/').pop();
  const ok = await showConfirmDialog({
    title: 'Delete File or Folder',
    message: `Are you sure you want to permanently delete "${itemName}"? This cannot be undone.`,
    confirmText: 'Delete Permanently',
    danger: true,
  });
  if (!ok) return;
  try {
    await api(`${ctx.baseUrl}?path=${encodeURIComponent(path)}`, { method: 'DELETE' });
    toast(`Deleted ${itemName}`, 'success');
    if (state.filesOpenPath === path) filesCloseEditor(true);
    await loadFilesView();
  } catch (err) {
    toast(`Delete failed: ${err.message}`, 'error');
  }
}

export async function uploadFileList(files) {
  const ctx = getFilesEntityContext();
  if (!ctx || !files || !files.length) return;

  const formData = new FormData();
  for (let i = 0; i < files.length; i++) {
    const relPath = files[i].webkitRelativePath || files[i].name;
    formData.append('file', files[i], relPath);
  }

  try {
    toast(`Uploading ${files.length} file(s)`, 'info');
    const pathParam = encodeURIComponent(state.filesPath || '');
    const res = await fetch(`${ctx.baseUrl}/upload?path=${pathParam}`, {
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
    toast(`Uploaded ${files.length} file(s)`, 'success');
    await loadFilesView();
  } catch (err) {
    toast(`Upload failed: ${err.message}`, 'error');
  }
}

export async function handleFilesUpload(e) {
  const ctx = getFilesEntityContext();
  if (!ctx?.canWrite) {
    if (e.target) e.target.value = '';
    return;
  }
  const files = e.target?.files;
  if (files && files.length) {
    await uploadFileList(files);
  }
  if (e.target) e.target.value = '';
}

export async function handleFolderUpload(e) {
  if (!getFilesEntityContext()?.canWrite) {
    if (e.target) e.target.value = '';
    return;
  }
  const files = e.target?.files;
  if (files && files.length) {
    await uploadFileList(files);
  }
  if (e.target) e.target.value = '';
}

export function setupFileDropzone() {
  const dropzone = document.getElementById('file-explorer-dropzone');
  const overlay = document.getElementById('file-drop-overlay');
  if (!dropzone || dropzone.dataset.dropBound) return;
  dropzone.dataset.dropBound = 'true';

  let dragCounter = 0;

  dropzone.addEventListener('dragenter', (e) => {
    if (state.filesOpenPath || !getFilesEntityContext()?.canWrite) return;
    e.preventDefault();
    e.stopPropagation();
    dragCounter++;
    if (overlay) overlay.style.display = 'flex';
    dropzone.classList.add('drag-active');
  });

  dropzone.addEventListener('dragover', (e) => {
    if (state.filesOpenPath || !getFilesEntityContext()?.canWrite) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'copy';
  });

  dropzone.addEventListener('dragleave', (e) => {
    if (state.filesOpenPath || !getFilesEntityContext()?.canWrite) return;
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
    if (!getFilesEntityContext()?.canWrite) return;

    const dt = e.dataTransfer;
    if (dt && dt.files && dt.files.length) {
      await uploadFileList(dt.files);
    }
  });
}

// Bind globals for inline HTML event handlers
window.filesJoin = filesJoin;
window.formatFileBytes = formatFileBytes;
window.formatFileDate = formatFileDate;
window.getFileMeta = getFileMeta;
window.renderFilesTable = renderFilesTable;
window.loadFilesView = loadFilesView;
window.filesFilterList = filesFilterList;
window.filesClearFilter = filesClearFilter;
window.filesGo = filesGo;
window.filesGoUp = filesGoUp;
window.filesCopyCurrentPath = filesCopyCurrentPath;
window.filesDownload = filesDownload;
window.filesDownloadCurrent = filesDownloadCurrent;
window.filesRename = filesRename;
window.filesNewFile = filesNewFile;
window.filesNewFolder = filesNewFolder;
window.filesDelete = filesDelete;
window.handleFilesUpload = handleFilesUpload;
window.handleFolderUpload = handleFolderUpload;
window.setupFileDropzone = setupFileDropzone;
