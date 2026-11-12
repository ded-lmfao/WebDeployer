/**
 * WebDep In-Browser Code & Config Editor Subsystem
 * Handles syntax highlighting with speed-highlight, real-time gutter numbering, dirty-state tracking, and save flows.
 */

import { icon } from './icons.js';
import { state, escapeHtml } from './state.js';
import { api, toast } from './api.js';
import { highlightHTML } from '../vendor/speed-highlight/index.js';

export function getSpeedHighlightLang(filename) {
  if (!filename) return 'plain';
  const lower = filename.toLowerCase();
  const base = lower.split('/').pop().split('\\').pop();

  if (base === 'dockerfile' || base.startsWith('dockerfile.')) return 'docker';
  if (base === '.env' || base.startsWith('.env.') || base.endsWith('.env')) return 'ini';
  if (base.endsWith('.conf') || base.endsWith('.ini') || base.endsWith('.cfg') || base.endsWith('.properties') || base === 'requirements.txt') return 'ini';
  if (base.endsWith('.py') || base.endsWith('.pyw')) return 'py';
  if (base.endsWith('.js') || base.endsWith('.mjs') || base.endsWith('.cjs') || base.endsWith('.jsx')) return 'js';
  if (base.endsWith('.ts') || base.endsWith('.tsx')) return 'ts';
  if (base.endsWith('.json') || base.endsWith('.jsonc') || base.endsWith('.json5') || base.endsWith('.lock')) return 'json';
  if (base.endsWith('.sh') || base.endsWith('.bash') || base.endsWith('.zsh') || base.endsWith('.ksh') || base === '.bashrc' || base === '.zshrc') return 'bash';
  if (base.endsWith('.html') || base.endsWith('.htm') || base.endsWith('.svg') || base.endsWith('.xml') || base.endsWith('.vue')) return 'html';
  if (base.endsWith('.css') || base.endsWith('.scss') || base.endsWith('.sass') || base.endsWith('.less')) return 'css';
  if (base.endsWith('.yaml') || base.endsWith('.yml')) return 'yaml';
  if (base.endsWith('.sql')) return 'sql';
  if (base.endsWith('.rs')) return 'rs';
  if (base.endsWith('.go')) return 'go';
  if (base.endsWith('.md') || base.endsWith('.markdown')) return 'md';
  return 'plain';
}

let highlightSeq = 0;
let highlightTimer = null;
let lastHighlightedContent = '';

export async function updateEditorHighlight(immediate = false) {
  const textarea = document.getElementById('files-editor');
  const codeEl = document.getElementById('files-editor-code');
  const card = document.getElementById('files-editor-card');
  if (!textarea || !codeEl) return;

  const content = textarea.value;
  if (content === lastHighlightedContent && !immediate) return;

  if (content.length > 500000 || content.split('\n').length > 15000) {
    if (card) card.classList.add('no-highlight');
    codeEl.textContent = content;
    lastHighlightedContent = content;
    return;
  }

  if (card) card.classList.remove('no-highlight');
  const lang = getSpeedHighlightLang(state.filesOpenPath || '');

  const doHighlight = async () => {
    const seq = ++highlightSeq;
    try {
      let html = await highlightHTML(content, lang, { block: false });
      if (seq !== highlightSeq) return;
      if (content.endsWith('\n')) {
        html += '\n';
      }
      codeEl.innerHTML = html;
      lastHighlightedContent = content;
    } catch (err) {
      console.warn('Speed-highlight error:', err);
      if (seq === highlightSeq) {
        codeEl.textContent = content;
        lastHighlightedContent = content;
      }
    }
  };

  if (immediate) {
    if (highlightTimer) clearTimeout(highlightTimer);
    highlightTimer = null;
    await doHighlight();
  } else {
    if (highlightTimer) clearTimeout(highlightTimer);
    highlightTimer = setTimeout(doHighlight, 35);
  }
}

let lastGutterLineCount = 0;

export function updateEditorGutter() {
  const textarea = document.getElementById('files-editor');
  const gutter = document.getElementById('files-editor-gutter');
  const linesSpan = document.getElementById('files-editor-lines');
  const sizeSpan = document.getElementById('files-editor-size');
  if (!textarea || !gutter) return;

  const content = textarea.value;
  const lineCount = content.split('\n').length;
  if (lineCount !== lastGutterLineCount || !gutter.textContent) {
    lastGutterLineCount = lineCount;
    let nums = '';
    for (let i = 1; i <= lineCount; i++) {
      nums += i + '\n';
    }
    gutter.textContent = nums;
    if (linesSpan) linesSpan.textContent = `${lineCount} line${lineCount === 1 ? '' : 's'}`;
  }

  if (sizeSpan) sizeSpan.textContent = window.formatFileBytes ? window.formatFileBytes(content.length) : `${content.length} B`;
}

export function updateEditorPos() {
  const textarea = document.getElementById('files-editor');
  const posSpan = document.getElementById('files-editor-pos');
  if (!textarea || !posSpan) return;

  const text = textarea.value.slice(0, textarea.selectionStart);
  const lines = text.split('\n');
  const row = lines.length;
  const col = lines[lines.length - 1].length + 1;
  posSpan.textContent = `Ln ${row}, Col ${col}`;
}

export function bindEditorEvents() {
  const textarea = document.getElementById('files-editor');
  const gutter = document.getElementById('files-editor-gutter');
  const pre = document.getElementById('files-editor-pre');
  if (!textarea || textarea.dataset.bound) return;
  textarea.dataset.bound = 'true';

  textarea.addEventListener('scroll', () => {
    if (gutter) gutter.scrollTop = textarea.scrollTop;
    if (pre) {
      pre.scrollTop = textarea.scrollTop;
      pre.scrollLeft = textarea.scrollLeft;
    }
  }, { passive: true });

  textarea.addEventListener('keyup', updateEditorPos);
  textarea.addEventListener('click', updateEditorPos);

  textarea.addEventListener('input', () => {
    void updateEditorHighlight();
    updateEditorGutter();
    updateEditorPos();
    const isDirty = textarea.value !== state.filesEditorInitialContent;
    state.filesEditorDirty = isDirty;
    const dirtyBadge = document.getElementById('files-editor-dirty-badge');
    if (dirtyBadge) dirtyBadge.style.display = isDirty ? 'inline-block' : 'none';
  });

  textarea.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) {
      e.preventDefault();
      void filesSaveCurrent(false);
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

export async function filesOpen(path) {
  const p = window.getSelectedProject ? window.getSelectedProject() : null;
  if (!p) return;

  try {
    toast(`Loading ${path}...`, 'info');
    const res = await api(`/api/projects/${p.id}/files/content?path=${encodeURIComponent(path)}`, { noCache: true });
    state.filesOpenPath = path;
    state.filesEditorInitialContent = res.content || '';
    state.filesEditorDirty = false;

    const editorCard = document.getElementById('files-editor-card');
    const browserView = document.getElementById('files-browser-view');
    const headerActions = document.getElementById('files-header-actions');
    const nameEl = document.getElementById('files-editor-name');
    const textarea = document.getElementById('files-editor');
    const dirtyBadge = document.getElementById('files-editor-dirty-badge');
    const metaEl = document.getElementById('files-editor-meta');
    const iconEl = document.getElementById('files-editor-icon');
    const gutter = document.getElementById('files-editor-gutter');
    const pre = document.getElementById('files-editor-pre');

    if (nameEl) {
      const parts = path.split('/');
      const fileName = parts.pop();
      const dirPath = parts.length ? parts.join('/') + '/' : '';
      nameEl.innerHTML = `<span style="color:var(--text-dim);font-weight:400;">${escapeHtml(dirPath)}</span>${escapeHtml(fileName)}`;
    }
    if (textarea) {
      textarea.value = res.content || '';
      textarea.readOnly = !hasPower('files_write');
    }
    const saveBtn = document.getElementById('files-save-btn');
    if (saveBtn) saveBtn.style.display = hasPower('files_write') ? '' : 'none';
    if (dirtyBadge) dirtyBadge.style.display = 'none';

    const fmtBytes = window.formatFileBytes || ((b) => `${b} B`);
    const filesJoin = window.filesJoin || ((d, n) => d ? `${d}/${n}` : n);
    const entry = (state.filesCachedEntries || []).find((x) => filesJoin(state.filesPath, x.name) === path);
    if (metaEl && entry) {
      metaEl.textContent = `• ${fmtBytes(entry.size)}`;
    } else if (metaEl) {
      metaEl.textContent = `• ${fmtBytes(new Blob([res.content]).size)}`;
    }

    const meta = window.getFileMeta ? window.getFileMeta({ name: path, is_dir: false }) : {};
    if (iconEl && meta.iconSvg) {
      iconEl.innerHTML = meta.iconSvg;
    }

    const detectedLang = getSpeedHighlightLang(path);
    const langBadge = document.getElementById('files-editor-lang-badge');
    if (langBadge) {
      const displayLang = detectedLang === 'py' ? 'PYTHON' : detectedLang === 'js' ? 'JAVASCRIPT' : detectedLang === 'ts' ? 'TYPESCRIPT' : detectedLang.toUpperCase();
      langBadge.textContent = displayLang;
      if (meta.iconBg) langBadge.style.background = meta.iconBg;
      if (meta.iconColor) langBadge.style.color = meta.iconColor;
    }

    if (browserView) browserView.style.display = 'none';
    if (headerActions) headerActions.style.display = 'none';
    if (editorCard) {
      editorCard.style.display = 'block';
    }

    if (window.renderFilesTable) window.renderFilesTable();
    void updateEditorHighlight(true);
    updateEditorGutter();
    updateEditorPos();
    bindEditorEvents();

    if (textarea) {
      textarea.scrollTop = 0;
      textarea.scrollLeft = 0;
    }
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

export function filesToggleFullscreen() {
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

export function filesCloseEditor(force = false) {
  if (!force && state.filesEditorDirty) {
    if (!confirm('You have unsaved changes. Discard and return to files?')) {
      return;
    }
  }
  state.filesOpenPath = null;
  state.filesEditorDirty = false;
  lastGutterLineCount = 0;

  const card = document.getElementById('files-editor-card');
  const browserView = document.getElementById('files-browser-view');
  const headerActions = document.getElementById('files-header-actions');
  const fullscreenBtn = document.getElementById('files-fullscreen-btn');

  if (card) {
    card.classList.remove('fullscreen');
    card.style.display = 'none';
  }
  if (browserView) {
    browserView.style.display = 'block';
  }
  if (headerActions) {
    headerActions.style.display = 'flex';
  }
  if (fullscreenBtn) {
    fullscreenBtn.innerHTML = `${icon('external-link', { size: 13 })} <span>Fullscreen</span>`;
  }

  const codeEl = document.getElementById('files-editor-code');
  if (codeEl) codeEl.innerHTML = '';
  const textarea = document.getElementById('files-editor');
  if (textarea) textarea.value = '';
  lastHighlightedContent = '';
  if (highlightTimer) clearTimeout(highlightTimer);
  highlightTimer = null;
  if (window.renderFilesTable) window.renderFilesTable();
}

export async function filesSaveCurrent(andClose = true) {
  if (!hasPower('files_write')) return;
  const p = window.getSelectedProject ? window.getSelectedProject() : null;
  if (!p || !state.filesOpenPath) return;

  const btn = document.getElementById('files-save-btn');
  const textarea = document.getElementById('files-editor');
  const dirtyBadge = document.getElementById('files-editor-dirty-badge');
  if (btn) btn.disabled = true;

  try {
    const savedPath = state.filesOpenPath;
    await api(`/api/projects/${p.id}/files/content`, {
      method: 'PUT',
      body: { path: savedPath, content: textarea ? textarea.value : '' },
    });
    state.filesEditorInitialContent = textarea ? textarea.value : '';
    state.filesEditorDirty = false;
    if (dirtyBadge) dirtyBadge.style.display = 'none';
    toast(`Saved ${savedPath}. Restart service to apply changes.`, 'success');

    if (andClose) {
      filesCloseEditor(true);
      if (window.loadFilesView) void window.loadFilesView();
    } else {
      if (window.loadFilesView) void window.loadFilesView();
    }
  } catch (err) {
    toast(`Save failed: ${err.message}`, 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}

// Bind globals for onclick inline HTML handlers
window.filesOpen = filesOpen;
window.filesToggleFullscreen = filesToggleFullscreen;
window.filesCloseEditor = filesCloseEditor;
window.filesSaveCurrent = filesSaveCurrent;

