/**
 * WebDep Predefined Platform Theme Manager (10 Curated Presets)
 * Instant client-side application + localStorage caching + SQLite platform default sync.
 */

import { state, escapeHtml } from './state.js';
import { api, toast } from './api.js';

export const THEME_STORAGE_KEY = 'webdep.theme';
export const DEFAULT_THEME_ID = 'midnight-ink';

export const PLATFORM_THEMES = [
  {
    id: 'midnight-ink',
    name: 'Midnight Ink',
    category: 'Dark • Cobalt',
    metaColor: '#0b101d',
    preview: { canvas: '#0b101d', sidebar: '#070b14', card: '#111829', accent: '#4f8ef7', text: '#eef1f7' },
  },
  {
    id: 'obsidian-carbon',
    name: 'Obsidian Carbon',
    category: 'OLED • Cyan',
    metaColor: '#090a0d',
    preview: { canvas: '#090a0d', sidebar: '#050608', card: '#111318', accent: '#38bdf8', text: '#f1f5f9' },
  },
  {
    id: 'nordic-frost',
    name: 'Nordic Frost',
    category: 'Dark • Glacier',
    metaColor: '#1a1f29',
    preview: { canvas: '#1a1f29', sidebar: '#131720', card: '#222836', accent: '#88c0d0', text: '#eceff4' },
  },
  {
    id: 'emerald-terminal',
    name: 'Emerald Terminal',
    category: 'Dark • Mint',
    metaColor: '#08110e',
    preview: { canvas: '#08110e', sidebar: '#050b09', card: '#0e1c17', accent: '#34d399', text: '#ecfdf5' },
  },
  {
    id: 'catppuccin-mocha',
    name: 'Catppuccin Mocha',
    category: 'Dark • Mocha',
    metaColor: '#181825',
    preview: { canvas: '#181825', sidebar: '#11111b', card: '#1e1e2e', accent: '#89b4fa', text: '#cdd6f4' },
  },
  {
    id: 'tokyo-dusk',
    name: 'Tokyo Dusk',
    category: 'Dark • Indigo',
    metaColor: '#131521',
    preview: { canvas: '#131521', sidebar: '#0d0f18', card: '#1a1d2d', accent: '#7aa2f7', text: '#c0caf5' },
  },
  {
    id: 'gruvbox-warm',
    name: 'Gruvbox Warm',
    category: 'Dark • Amber',
    metaColor: '#1b1917',
    preview: { canvas: '#1b1917', sidebar: '#141210', card: '#24211e', accent: '#e09f3e', text: '#ebdbb2' },
  },
  {
    id: 'crimson-ember',
    name: 'Crimson Ember',
    category: 'Dark • Rose',
    metaColor: '#120c0e',
    preview: { canvas: '#120c0e', sidebar: '#0b0708', card: '#1b1215', accent: '#fb7185', text: '#f8eff1' },
  },
  {
    id: 'daylight-crisp',
    name: 'Daylight Crisp',
    category: 'Light • Sapphire',
    metaColor: '#f3f6fb',
    preview: { canvas: '#f3f6fb', sidebar: '#e9eef6', card: '#ffffff', accent: '#2563eb', text: '#0f172a' },
  },
  {
    id: 'paper-espresso',
    name: 'Paper Pine',
    category: 'Light • Forest',
    metaColor: '#f4f1ea',
    preview: { canvas: '#f4f1ea', sidebar: '#eae5da', card: '#fcfbf7', accent: '#15803d', text: '#1c1917' },
  },
];

export function resolveTheme(themeId) {
  const clean = String(themeId || '').trim().toLowerCase();
  return PLATFORM_THEMES.find((t) => t.id === clean) || PLATFORM_THEMES[0];
}

export function getActiveThemeId() {
  const fromDom = document.documentElement.dataset.theme;
  if (fromDom) return resolveTheme(fromDom).id;
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    if (stored) return resolveTheme(stored).id;
  } catch (_) {}
  return DEFAULT_THEME_ID;
}

export function applyTheme(themeId, persistLocal = true) {
  const theme = resolveTheme(themeId);
  document.documentElement.dataset.theme = theme.id;

  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', theme.metaColor);

  if (persistLocal) {
    try {
      localStorage.setItem(THEME_STORAGE_KEY, theme.id);
    } catch (_) {}
  }
  updateThemePickerUI(theme.id);
  return theme;
}

export async function syncThemeFromServer() {
  let hasLocal = false;
  try {
    hasLocal = Boolean(localStorage.getItem(THEME_STORAGE_KEY));
  } catch (_) {}

  try {
    const res = await fetch('/api/theme', { credentials: 'same-origin', cache: 'no-store' });
    if (!res.ok) return;
    const data = await res.json();
    if (data && data.theme) {
      const serverTheme = resolveTheme(data.theme);
      state.platformTheme = serverTheme.id;
      if (!hasLocal) {
        applyTheme(serverTheme.id, true);
      }
    }
  } catch (_) {}
}

function canSaveGlobalSettings() {
  if (!state.user) return false;
  if (state.user.isMainAdmin) return true;
  const perms = state.user.permissions || [];
  return perms.includes('*') || perms.includes('settings_manage');
}

export async function selectPlatformTheme(themeId) {
  const theme = applyTheme(themeId, true);

  if (canSaveGlobalSettings()) {
    try {
      await api('/api/settings', {
        method: 'PUT',
        body: { panel_theme: theme.id },
      });
      state.platformTheme = theme.id;
      toast(`Applied "${theme.name}" platform theme`, 'success');
    } catch (err) {
      toast(`Applied "${theme.name}" locally (server save failed: ${err.message})`, 'warning');
    }
  } else {
    toast(`Applied "${theme.name}" theme for your browser`, 'success');
  }
}

export function updateThemePickerUI(activeId = getActiveThemeId()) {
  const resolved = resolveTheme(activeId);
  const badge = document.getElementById('settings-active-theme-badge');
  if (badge) {
    badge.textContent = resolved.name;
  }

  const grid = document.getElementById('settings-theme-grid');
  if (!grid) return;

  grid.querySelectorAll('.theme-swatch-card').forEach((card) => {
    const isMatch = card.getAttribute('data-theme-id') === resolved.id;
    card.classList.toggle('active', isMatch);
    card.setAttribute('aria-pressed', isMatch ? 'true' : 'false');
  });
}

export function renderThemePicker() {
  const grid = document.getElementById('settings-theme-grid');
  if (!grid) return;

  const activeId = getActiveThemeId();
  if (!grid.dataset.rendered) {
    grid.innerHTML = PLATFORM_THEMES.map((t) => {
      const p = t.preview;
      const isMatch = t.id === activeId;
      const isLight = t.category.startsWith('Light');
      return `
        <button type="button"
          class="theme-swatch-card${isMatch ? ' active' : ''}"
          data-theme-id="${escapeHtml(t.id)}"
          aria-pressed="${isMatch ? 'true' : 'false'}"
          title="Apply ${escapeHtml(t.name)} theme (${escapeHtml(t.category)})">
          <span class="theme-swatch-dot" style="background: ${p.canvas};" aria-hidden="true">
            <span class="theme-swatch-dot-accent" style="background: ${p.accent};"></span>
          </span>
          <span class="theme-swatch-label">
            <span class="theme-swatch-name">${escapeHtml(t.name)}</span>
            ${isLight ? '<span class="theme-swatch-tag">Light</span>' : ''}
          </span>
          <span class="theme-swatch-check" aria-hidden="true">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="20 6 9 17 4 12"></polyline>
            </svg>
          </span>
        </button>
      `;
    }).join('');

    grid.addEventListener('click', (e) => {
      const btn = e.target.closest('.theme-swatch-card');
      if (!btn) return;
      const tid = btn.getAttribute('data-theme-id');
      if (tid) void selectPlatformTheme(tid);
    });
    grid.dataset.rendered = 'true';
  }

  updateThemePickerUI(activeId);
}

// Expose helpers for inline handlers if needed
window.selectPlatformTheme = selectPlatformTheme;
window.resetPlatformTheme = () => selectPlatformTheme(DEFAULT_THEME_ID);
