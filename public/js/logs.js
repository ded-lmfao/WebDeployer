/**
 * WebDep Real-Time Live Logs Subsystem
 * SSE stream receiver, level filters, live autoscroll, and log exporter
 */

import { state, escapeHtml, copyTextToClipboard, getSelectedProject, getSelectedDatabase } from './state.js';
import { api, toast } from './api.js';
import { navigateTo } from './workspace.js';

let dbLogPollTimer = null;

function stopDbLogPoller() {
  if (dbLogPollTimer !== null) {
    clearInterval(dbLogPollTimer);
    dbLogPollTimer = null;
  }
}

async function fetchDatabaseLogLines(db) {
  const res = await api(`/api/databases/${db.id}/logs`, { noCache: true });
  if (Array.isArray(res?.entries) && res.entries.length > 0) {
    return res.entries.map((e, idx) => ({
      id: e.id || (1000000 + idx),
      database_id: db.id,
      ts: e.ts || Date.now(),
      level: e.level || 'info',
      channel: e.channel || 'postgres',
      message: e.message || '',
    }));
  }
  const raw = typeof res?.logs === 'string' ? res.logs : '';
  const now = Date.now();
  return raw
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line, idx) => {
      const upper = line.toUpperCase();
      let level = 'info';
      if (upper.includes('FATAL:') || upper.includes('PANIC:') || upper.includes('ERROR:')) level = 'error';
      else if (upper.includes('WARNING:')) level = 'warn';
      return {
        id: 2000000 + idx,
        database_id: db.id,
        ts: now,
        level,
        channel: 'postgres',
        message: line,
      };
    });
}

// ============================================================================
// View 7: Real-Time Live Logs
// ============================================================================
async function loadLogsView() {
  const terminal = document.getElementById('log-terminal-output');
  const titleEl = document.getElementById('logs-view-title');
  const descEl = document.getElementById('logs-view-desc');
  state.logLines = [];

  if (state.selectedEntityKind === 'database') {
    if (state.logEventSource) {
      state.logEventSource.close();
      state.logEventSource = null;
    }
    stopDbLogPoller();

    const db = getSelectedDatabase();
    if (titleEl) titleEl.textContent = db ? `${db.name} — Logs` : 'Database Logs';
    if (descEl) descEl.textContent = 'PostgreSQL server logs and container engine lifecycle output (postgresql.log)';

    if (!db) {
      if (terminal) {
        terminal.innerHTML = `<div class="log-line log-empty-placeholder"><span class="log-ts">--:--:--</span><span class="log-lvl-info">Select a managed database to view its PostgreSQL logs.</span></div>`;
      }
      return;
    }

    if (terminal) {
      terminal.innerHTML = `<div class="log-line log-empty-placeholder"><span class="log-ts">${new Date().toLocaleTimeString()}</span><span class="log-lvl-info">Loading PostgreSQL logs for ${escapeHtml(db.name)}...</span></div>`;
    }

    try {
      state.logLines = await fetchDatabaseLogLines(db);
    } catch (err) {
      if (terminal) {
        terminal.innerHTML = `<div class="log-line log-empty-placeholder"><span class="log-ts">${new Date().toLocaleTimeString()}</span><span class="log-lvl-error">Failed to load PostgreSQL logs: ${escapeHtml(err.message)}</span></div>`;
      }
      return;
    }
    renderTerminalLogs();

    dbLogPollTimer = setInterval(async () => {
      if (state.currentView !== 'logs' || state.selectedEntityKind !== 'database') {
        stopDbLogPoller();
        return;
      }
      if (document.hidden) return;
      const activeDb = getSelectedDatabase();
      if (!activeDb || activeDb.id !== db.id) {
        stopDbLogPoller();
        return;
      }
      try {
        const nextLines = await fetchDatabaseLogLines(activeDb);
        const prevLast = state.logLines[state.logLines.length - 1]?.message || '';
        const nextLast = nextLines[nextLines.length - 1]?.message || '';
        if (nextLines.length !== state.logLines.length || prevLast !== nextLast) {
          state.logLines = nextLines;
          renderTerminalLogs();
        }
      } catch (_) {}
    }, 2500);
    return;
  }

  stopDbLogPoller();
  if (titleEl) titleEl.textContent = 'App Logs';
  if (descEl) descEl.textContent = 'Live application console output (stdout & stderr)';

  const p = getSelectedProject();
  if (!p) {
    if (state.logEventSource) {
      state.logEventSource.close();
      state.logEventSource = null;
    }
    if (terminal) {
      terminal.innerHTML = `<div class="log-line log-empty-placeholder"><span class="log-ts">--:--:--</span><span class="log-lvl-info">Select a website or service to view its app logs.</span></div>`;
    }
    return;
  }

  if (terminal) {
    terminal.innerHTML = `<div class="log-line log-empty-placeholder"><span class="log-ts">${new Date().toLocaleTimeString()}</span><span class="log-lvl-info">Connecting to app logs for ${escapeHtml(p.name)}...</span></div>`;
  }

  startLogStream();
  try {
    const history = await api(`/api/logs?limit=300&project=${p.id}&channel=app`);
    if (Array.isArray(history)) {
      state.logLines = history.filter((x) => x.project_id === p.id && x.channel === 'app');
    }
  } catch (_) {}
  renderTerminalLogs();
}

function startLogStream() {
  if (state.logEventSource) {
    state.logEventSource.close();
    state.logEventSource = null;
  }

  const p = getSelectedProject();
  if (!p) return;

  const url = `/api/logs/stream?backlog=200&project=${p.id}&channel=app`;
  const es = new EventSource(url);
  es.onmessage = (e) => {
    try {
      const data = JSON.parse(e.data);
      if (Array.isArray(data)) {
        const curP = getSelectedProject();
        if (!curP) return;
        const existingIds = new Set(state.logLines.map((x) => x.id));
        // Strict isolation: only allow `app` channel logs matching this specific project
        const fresh = data.filter((x) => {
          if (x.project_id !== curP.id || x.channel !== 'app') return false;
          return !x.id || !existingIds.has(x.id);
        });
        if (fresh.length) {
          state.logLines.push(...fresh);
          if (state.logLines.length > 2000) state.logLines.splice(0, state.logLines.length - 2000);
          appendTerminalLogs(fresh);
        }
      }
    } catch { /* keepalive or malformed */ }
  };
  es.onerror = () => {
    // EventSource automatically retries
  };
  state.logEventSource = es;
}

function renderTerminalLogs() {
  const terminal = document.getElementById('log-terminal-output');
  if (!terminal) return;

  const isDb = state.selectedEntityKind === 'database';
  const db = isDb ? getSelectedDatabase() : null;
  const p = !isDb ? getSelectedProject() : null;
  const lvlFilter = document.getElementById('log-level-filter')?.value || '';
  const q = (document.getElementById('log-search-input')?.value || '').toLowerCase();

  const filtered = state.logLines.filter((l) => {
    if (isDb) {
      if (db && l.database_id !== db.id) return false;
    } else {
      if (p && l.project_id !== p.id) return false;
      if (l.channel !== 'app') return false;
    }
    if (lvlFilter && l.level !== lvlFilter) return false;
    if (q && !(l.message || '').toLowerCase().includes(q)) return false;
    return true;
  });

  if (!filtered.length) {
    const targetName = isDb ? (db?.name || 'database') : (p?.name || 'application');
    const filterNote = (lvlFilter || q)
      ? `No log entries match filter (${[lvlFilter, q].filter(Boolean).join(', ')}).`
      : `Waiting for logs from ${targetName}...`;
    terminal.innerHTML = `<div class="log-line log-empty-placeholder"><span class="log-ts">${new Date().toLocaleTimeString()}</span><span class="log-lvl-info">${escapeHtml(filterNote)}</span></div>`;
    return;
  }

  terminal.innerHTML = filtered.map((l) => formatLogLine(l, isDb)).join('');
  if (document.getElementById('log-autoscroll')?.checked) {
    terminal.scrollTop = terminal.scrollHeight;
  }
}

function appendTerminalLogs(newLines) {
  const terminal = document.getElementById('log-terminal-output');
  if (!terminal) return;

  const isDb = state.selectedEntityKind === 'database';
  const db = isDb ? getSelectedDatabase() : null;
  const p = !isDb ? getSelectedProject() : null;
  const lvlFilter = document.getElementById('log-level-filter')?.value || '';
  const q = (document.getElementById('log-search-input')?.value || '').toLowerCase();

  let batchHtml = '';
  for (const l of newLines) {
    if (isDb) {
      if (db && l.database_id !== db.id) continue;
    } else {
      if (p && l.project_id !== p.id) continue;
      if (l.channel !== 'app') continue;
    }
    if (lvlFilter && l.level !== lvlFilter) continue;
    if (q && !(l.message || '').toLowerCase().includes(q)) continue;
    batchHtml += formatLogLine(l, isDb);
  }

  if (batchHtml) {
    terminal.querySelectorAll('.log-empty-placeholder').forEach((el) => el.remove());
    terminal.insertAdjacentHTML('beforeend', batchHtml);

    // Memory optimization: cap terminal DOM nodes to 1,000 max
    const excess = terminal.childElementCount - 1000;
    if (excess > 0) {
      for (let i = 0; i < excess; i++) {
        if (terminal.firstChild) terminal.removeChild(terminal.firstChild);
      }
    }
  }

  if (document.getElementById('log-autoscroll')?.checked) {
    terminal.scrollTop = terminal.scrollHeight;
  }
}

function ansiToHtml(str) {
  if (!str) return '';
  const escaped = escapeHtml(str);
  const esc = String.fromCharCode(27);
  const ansiRegex = new RegExp(`${esc}\\[([0-9;]*)m`, 'g');
  const colors = {
    '30': 'var(--text-dim)',
    '31': '#ef4444',
    '32': '#10b981',
    '33': '#f59e0b',
    '34': '#3b82f6',
    '35': '#ec4899',
    '36': '#06b6d4',
    '37': '#f3f4f6',
    '90': '#6b7280',
    '91': '#f87171',
    '92': '#34d399',
    '93': '#fbbf24',
    '94': '#60a5fa',
    '95': '#f472b6',
    '96': '#22d3ee',
    '97': '#ffffff',
  };

  let openSpan = false;
  let converted = escaped.replace(ansiRegex, (_, code) => {
    if (!code || code === '0') {
      if (openSpan) {
        openSpan = false;
        return '</span>';
      }
      return '';
    }
    const color = colors[code];
    if (color) {
      const prefix = openSpan ? '</span>' : '';
      openSpan = true;
      return `${prefix}<span style="color:${color}">`;
    }
    if (code === '1') {
      const prefix = openSpan ? '</span>' : '';
      openSpan = true;
      return `${prefix}<span style="font-weight:600">`;
    }
    return '';
  });

  return openSpan ? converted + '</span>' : converted;
}

function formatLogLine(l, showChannel = true) {
  const time = l.ts ? new Date(l.ts).toLocaleTimeString() : '--:--:--';
  const lvlClass = `log-lvl-${l.level || 'info'}`;
  const chanHtml = showChannel && l.channel ? `<span class="log-chan">[${escapeHtml(l.channel)}]</span>` : '';
  return `<div class="log-line"><span class="log-ts">${time}</span>${chanHtml}<span class="${lvlClass}">${ansiToHtml(l.message)}</span></div>`;
}

// Log filters bindings
['log-level-filter', 'log-search-input'].forEach((id) => {
  const el = document.getElementById(id);
  el?.addEventListener('input', renderTerminalLogs);
  el?.addEventListener('change', renderTerminalLogs);
});
document.getElementById('log-clear-btn')?.addEventListener('click', () => {
  state.logLines = [];
  document.getElementById('log-terminal-output').innerHTML = '';
});

// Copy logs to clipboard
document.getElementById('logs-copy-btn')?.addEventListener('click', async () => {
  if (!state.logLines.length) {
    toast('No log lines to copy.', 'info');
    return;
  }
  const text = state.logLines.map((l) => `[${l.ts ? new Date(l.ts).toLocaleTimeString() : '--:--:--'}] ${l.message}`).join('\n');
  await copyTextToClipboard(text, 'Logs copied to clipboard');
});

// Download logs
document.getElementById('logs-download-btn')?.addEventListener('click', () => {
  if (state.selectedEntityKind === 'database') {
    const db = getSelectedDatabase();
    if (!db) {
      toast('Select a database first to download its logs.', 'info');
      return;
    }
    const text = (state.logLines || [])
      .map((l) => (l.channel ? `[${l.channel}] ${l.message}` : l.message))
      .join('\n');
    const blob = new Blob([text || 'No logs recorded yet.\n'], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${(db.name || 'postgres').replace(/[^a-zA-Z0-9._-]+/g, '-')}-postgresql.log`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return;
  }
  const p = getSelectedProject();
  if (!p) {
    toast('Select an app first to download its logs.', 'info');
    return;
  }
  window.open(`/api/logs/download?project=${p.id}`, '_blank');
});

// Tail application supervisor logs
document.getElementById('logs-app-tail-btn')?.addEventListener('click', async () => {
  const p = getSelectedProject();
  if (!p) return;
  try {
    const res = await api(`/api/projects/${p.id}/app-logs?lines=300`);
    const terminal = document.getElementById('log-terminal-output');
    terminal.innerHTML = `\n===== Application Logs for ${escapeHtml(p.name)} (${res.lines.length} lines) =====\n` +
      res.lines.map((l) => `<div class="log-line"><span class="log-lvl-info">${escapeHtml(l)}</span></div>`).join('');
    terminal.scrollTop = terminal.scrollHeight;
  } catch (err) {
    toast(`Failed to load app logs: ${err.message}`, 'error');
  }
});

function openLogsForProject(projectId) {
  const lvlSel = document.getElementById('log-level-filter');
  if (lvlSel) lvlSel.value = '';
  navigateTo('logs', projectId);
}
window.openLogsForProject = openLogsForProject;



window.loadLogsView = loadLogsView;
window.openLogsForProject = openLogsForProject;
window.formatLogLine = formatLogLine;

export { loadLogsView, openLogsForProject, formatLogLine };
