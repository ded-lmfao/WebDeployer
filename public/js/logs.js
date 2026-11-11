/**
 * WebDep Real-Time Live Logs Subsystem
 * SSE stream receiver, level filters, live autoscroll, and log exporter
 */

import { state, escapeHtml, copyTextToClipboard } from './state.js';
import { api, toast } from './api.js';

// ============================================================================
// View 7: Real-Time Live Logs
// ============================================================================
async function loadLogsView() {
  startLogStream();
  try {
    const p = getSelectedProject();
    let url = '/api/logs?limit=300';
    if (p) url += `&project=${p.id}`;
    const history = await api(url);
    if (Array.isArray(history)) {
      state.logLines = history;
    }
  } catch (_) {}
  renderTerminalLogs();
}

function startLogStream() {
  if (state.logEventSource) {
    state.logEventSource.close();
  }

  const p = getSelectedProject();
  let url = '/api/logs/stream?backlog=200';
  if (p) url += `&project=${p.id}`;

  const es = new EventSource(url);
  es.onmessage = (e) => {
    try {
      const data = JSON.parse(e.data);
      if (Array.isArray(data)) {
        const existingIds = new Set(state.logLines.map((x) => x.id));
        const fresh = data.filter((x) => !x.id || !existingIds.has(x.id));
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

  const chanFilter = document.getElementById('log-channel-filter')?.value || '';
  const lvlFilter = document.getElementById('log-level-filter')?.value || '';
  const q = (document.getElementById('log-search-input')?.value || '').toLowerCase();

  const filtered = state.logLines.filter((l) => {
    if (chanFilter && l.channel !== chanFilter) return false;
    if (lvlFilter && l.level !== lvlFilter) return false;
    if (q && !(l.message || '').toLowerCase().includes(q)) return false;
    return true;
  });

  if (!filtered.length) {
    const filterNote = (chanFilter || lvlFilter || q)
      ? `No log entries match filter (${[chanFilter, lvlFilter, q].filter(Boolean).join(', ')}). Switch filters to "All Channels" / "All Levels" to view all ${state.logLines.length} logs.`
      : 'WebDep real-time log stream connected. Waiting for log events...';
    terminal.innerHTML = `<div class="log-line"><span class="log-ts">${new Date().toLocaleTimeString()}</span><span class="log-chan">[system]</span><span class="log-lvl-info">${escapeHtml(filterNote)}</span></div>`;
    return;
  }

  terminal.innerHTML = filtered.map((l) => formatLogLine(l)).join('');
  if (document.getElementById('log-autoscroll')?.checked) {
    terminal.scrollTop = terminal.scrollHeight;
  }
}

function appendTerminalLogs(newLines) {
  const terminal = document.getElementById('log-terminal-output');
  if (!terminal) return;

  const chanFilter = document.getElementById('log-channel-filter')?.value || '';
  const lvlFilter = document.getElementById('log-level-filter')?.value || '';
  const q = (document.getElementById('log-search-input')?.value || '').toLowerCase();

  let batchHtml = '';
  for (const l of newLines) {
    if (chanFilter && l.channel !== chanFilter) continue;
    if (lvlFilter && l.level !== lvlFilter) continue;
    if (q && !l.message.toLowerCase().includes(q)) continue;
    batchHtml += formatLogLine(l);
  }

  if (batchHtml) {
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
  const ansiRegex = /(?:\x1b|\u001b)\[([0-9;]*)m/g;
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

function formatLogLine(l) {
  const time = l.ts ? new Date(l.ts).toLocaleTimeString() : '--:--:--';
  const lvlClass = `log-lvl-${l.level || 'info'}`;
  return `<div class="log-line"><span class="log-ts">${time}</span><span class="log-chan">[${l.channel}]</span><span class="${lvlClass}">${ansiToHtml(l.message)}</span></div>`;
}

// Log filters bindings
['log-channel-filter', 'log-level-filter', 'log-search-input'].forEach((id) => {
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
  const text = state.logLines.map((l) => `[${l.ts ? new Date(l.ts).toLocaleTimeString() : '--:--:--'}] [${(l.channel || 'SYSTEM').toUpperCase()}] [${(l.level || 'INFO').toUpperCase()}] ${l.message}`).join('\n');
  await copyTextToClipboard(text, 'Logs copied to clipboard');
});

// Download logs
document.getElementById('logs-download-btn')?.addEventListener('click', () => {
  const p = getSelectedProject();
  let url = '/api/logs/download';
  if (p) url += `?project=${p.id}`;
  window.open(url, '_blank');
});

// Tail application supervisor logs
document.getElementById('logs-app-tail-btn')?.addEventListener('click', async () => {
  const p = getSelectedProject();
  if (!p) return;
  try {
    const res = await api(`/api/projects/${p.id}/app-logs?lines=300`);
    const terminal = document.getElementById('log-terminal-output');
    terminal.innerHTML = `\n===== Application Runtime Logs for ${escapeHtml(p.name)} (${res.lines.length} lines) =====\n` +
      res.lines.map((l) => `<div class="log-line"><span class="log-lvl-info">${escapeHtml(l)}</span></div>`).join('');
    terminal.scrollTop = terminal.scrollHeight;
  } catch (err) {
    toast(`Failed to load app logs: ${err.message}`, 'error');
  }
});

function openLogsForProject(projectId) {
  const chanSel = document.getElementById('log-channel-filter');
  const lvlSel = document.getElementById('log-level-filter');
  if (chanSel) chanSel.value = '';
  if (lvlSel) lvlSel.value = '';
  navigateTo('logs', projectId);
}
window.openLogsForProject = openLogsForProject;



window.loadLogsView = loadLogsView;
window.openLogsForProject = openLogsForProject;
window.formatLogLine = formatLogLine;

export { loadLogsView, openLogsForProject, formatLogLine };
