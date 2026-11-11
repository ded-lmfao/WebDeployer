/**
 * WebDep High-Performance In-Browser Syntax Highlighter
 * Zero-dependency, offline lexical tokenizer for rich IDE code coloring
 */

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function detectLanguage(filename) {
  if (!filename) return 'text';
  const lower = filename.toLowerCase();
  const base = lower.split('/').pop().split('\\').pop();

  if (base === 'dockerfile' || base.startsWith('dockerfile.')) return 'dockerfile';
  if (base === '.env' || base.startsWith('.env.') || base.endsWith('.env')) return 'env';
  if (base.endsWith('.conf') || base.endsWith('.ini') || base.endsWith('.cfg') || base.endsWith('.properties')) return 'env';
  if (base.endsWith('.py') || base.endsWith('.pyw')) return 'python';
  if (base.endsWith('.js') || base.endsWith('.mjs') || base.endsWith('.cjs') || base.endsWith('.jsx')) return 'javascript';
  if (base.endsWith('.ts') || base.endsWith('.tsx')) return 'typescript';
  if (base.endsWith('.json') || base.endsWith('.jsonc') || base.endsWith('.json5') || base.endsWith('.lock')) return 'json';
  if (base.endsWith('.sh') || base.endsWith('.bash') || base.endsWith('.zsh') || base.endsWith('.ksh') || base === '.bashrc' || base === '.zshrc') return 'bash';
  if (base.endsWith('.html') || base.endsWith('.htm') || base.endsWith('.svg') || base.endsWith('.xml') || base.endsWith('.vue')) return 'html';
  if (base.endsWith('.css') || base.endsWith('.scss') || base.endsWith('.sass') || base.endsWith('.less')) return 'css';
  if (base.endsWith('.yaml') || base.endsWith('.yml')) return 'yaml';
  if (base.endsWith('.sql')) return 'sql';
  if (base.endsWith('.rs')) return 'rust';
  if (base.endsWith('.go')) return 'go';
  if (base.endsWith('.md') || base.endsWith('.markdown')) return 'markdown';
  return 'text';
}

function highlightPython(code) {
  const masterRegex = new RegExp(
    [
      '(?<comment>#.*)',
      '(?<docstring>"""[\\s\\S]*?"""|\'\'\'[\\s\\S]*?\'\'\')',
      '(?<string>(?:[furbFURB]{1,2})?(?:"(?:[^"\\\\\n]|\\\\.)*"|\'(?:[^\'\\\\\n]|\\\\.)*\'))',
      '(?<decorator>@[a-zA-Z_]\\w*(?:\\.[a-zA-Z_]\\w*)*)',
      '(?<def>\\bdef\\s+([a-zA-Z_]\\w*))',
      '(?<class>\\bclass\\s+([a-zA-Z_]\\w*))',
      '(?<keyword>\\b(?:and|as|assert|async|await|break|continue|del|elif|else|except|finally|for|from|global|if|import|in|is|lambda|nonlocal|not|or|pass|raise|return|try|while|with|yield)\\b)',
      '(?<builtin>\\b(?:None|True|False|self|cls|int|float|str|bool|list|dict|tuple|set|len|range|enumerate|print|zip|open|super|type|isinstance|issubclass|any|all|min|max|sum|sorted|map|filter|input|id|repr|abs|round)\\b)',
      '(?<number>\\b0[xX][0-9a-fA-F]+\\b|\\b0[bB][01]+\\b|\\b\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?\\b)',
      '(?<fncall>\\b[a-zA-Z_]\\w*(?=\\s*\\())',
      '(?<operator>==|!=|<=|>=|=>|->|\\+=|-=|\\*=|/=|%=|\\*\\*|//|[+\\-*/%<>=&|^~!])',
      '(?<punct>[{}()[\\];,:])',
      '(?<ident>[a-zA-Z_]\\w*)',
      '(?<ws>\\s+)',
      '(?<other>[^a-zA-Z0-9_\\s{}()[\\];,:#"\'+\\-*/%<>=&|^~!]+)'
    ].join('|'),
    'gy'
  );

  let html = '';
  masterRegex.lastIndex = 0;
  while (masterRegex.lastIndex < code.length) {
    const match = masterRegex.exec(code);
    if (!match) {
      html += escapeHtml(code[masterRegex.lastIndex]);
      masterRegex.lastIndex++;
      continue;
    }
    const g = match.groups;
    if (g.comment) {
      html += `<span class="tok-comment">${escapeHtml(match[0])}</span>`;
    } else if (g.docstring || g.string) {
      html += `<span class="tok-string">${escapeHtml(match[0])}</span>`;
    } else if (g.decorator) {
      html += `<span class="tok-decorator">${escapeHtml(match[0])}</span>`;
    } else if (g.def) {
      const parts = match[0].split(/\s+/);
      html += `<span class="tok-keyword">${escapeHtml(parts[0])}</span> <span class="tok-function">${escapeHtml(parts.slice(1).join(' '))}</span>`;
    } else if (g.class) {
      const parts = match[0].split(/\s+/);
      html += `<span class="tok-keyword">${escapeHtml(parts[0])}</span> <span class="tok-type">${escapeHtml(parts.slice(1).join(' '))}</span>`;
    } else if (g.keyword) {
      html += `<span class="tok-keyword">${escapeHtml(match[0])}</span>`;
    } else if (g.builtin) {
      html += `<span class="tok-builtin">${escapeHtml(match[0])}</span>`;
    } else if (g.number) {
      html += `<span class="tok-number">${escapeHtml(match[0])}</span>`;
    } else if (g.fncall) {
      html += `<span class="tok-function">${escapeHtml(match[0])}</span>`;
    } else if (g.operator) {
      html += `<span class="tok-operator">${escapeHtml(match[0])}</span>`;
    } else if (g.punct) {
      html += `<span class="tok-punct">${escapeHtml(match[0])}</span>`;
    } else {
      html += escapeHtml(match[0]);
    }
  }
  return html;
}

function highlightJsTs(code) {
  const masterRegex = new RegExp(
    [
      '(?<comment>//.*|/\\*[\\s\\S]*?\\*/)',
      '(?<template>`(?:[^`\\\\]|\\\\.)*`)',
      '(?<string>"(?:[^"\\\\\n]|\\\\.)*"|\'(?:[^\'\\\\\n]|\\\\.)*\')',
      '(?<regex>/(?![*+?])(?:[^\\r\\n\\[/\\\\]|\\\\.|\\[(?:[^\\r\\n\\]\\\\]|\\\\.)*\\])+/[gimsuy]*)',
      '(?<keyword>\\b(?:await|async|break|case|catch|class|const|continue|debugger|default|delete|do|else|enum|export|extends|finally|for|function|get|if|implements|import|in|instanceof|interface|let|new|of|package|private|protected|public|return|set|static|super|switch|throw|try|typeof|var|void|while|with|yield|type|as|from)\\b)',
      '(?<builtin>\\b(?:true|false|null|undefined|NaN|Infinity|this|window|document|console|globalThis|Array|Object|String|Number|Boolean|Function|Symbol|Map|Set|Promise|JSON|Math|Date|RegExp|Error|setTimeout|setInterval|clearTimeout|clearInterval)\\b)',
      '(?<number>\\b0[xX][0-9a-fA-F]+\\b|\\b\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?\\b)',
      '(?<fncall>\\b[a-zA-Z_$][a-zA-Z0-9_$]*(?=\\s*\\())',
      '(?<operator>===|!==|==|!=|<=|>=|=>|\\+\\+|--|\\+=|-=|\\*=|/=|%=|&&|\\|\\||\\?\\?|\\?|:|[+\\-*/%<>=&|^~!])',
      '(?<punct>[{}()[\\];,.])',
      '(?<ident>[a-zA-Z_$][a-zA-Z0-9_$]*)',
      '(?<ws>\\s+)',
      '(?<other>[^a-zA-Z0-9_$\\s{}()[\\];,:.`"\'+\\-*/%<>=&|^~!?]+)'
    ].join('|'),
    'gy'
  );

  let html = '';
  masterRegex.lastIndex = 0;
  while (masterRegex.lastIndex < code.length) {
    const match = masterRegex.exec(code);
    if (!match) {
      html += escapeHtml(code[masterRegex.lastIndex]);
      masterRegex.lastIndex++;
      continue;
    }
    const g = match.groups;
    if (g.comment) {
      html += `<span class="tok-comment">${escapeHtml(match[0])}</span>`;
    } else if (g.template || g.string) {
      html += `<span class="tok-string">${escapeHtml(match[0])}</span>`;
    } else if (g.regex) {
      html += `<span class="tok-regex">${escapeHtml(match[0])}</span>`;
    } else if (g.keyword) {
      html += `<span class="tok-keyword">${escapeHtml(match[0])}</span>`;
    } else if (g.builtin) {
      html += `<span class="tok-builtin">${escapeHtml(match[0])}</span>`;
    } else if (g.number) {
      html += `<span class="tok-number">${escapeHtml(match[0])}</span>`;
    } else if (g.fncall) {
      html += `<span class="tok-function">${escapeHtml(match[0])}</span>`;
    } else if (g.operator) {
      html += `<span class="tok-operator">${escapeHtml(match[0])}</span>`;
    } else if (g.punct) {
      html += `<span class="tok-punct">${escapeHtml(match[0])}</span>`;
    } else {
      html += escapeHtml(match[0]);
    }
  }
  return html;
}

function highlightJson(code) {
  const masterRegex = new RegExp(
    [
      '(?<key>"(?:[^"\\\\\n]|\\\\.)*"(?=\\s*:))',
      '(?<string>"(?:[^"\\\\\n]|\\\\.)*")',
      '(?<number>-?\\b\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?\\b)',
      '(?<builtin>\\b(?:true|false|null)\\b)',
      '(?<punct>[{}()[\\];,:])',
      '(?<ws>\\s+)',
      '(?<other>[^"\\s{}()[\\];,:0-9\\-]+)'
    ].join('|'),
    'gy'
  );

  let html = '';
  masterRegex.lastIndex = 0;
  while (masterRegex.lastIndex < code.length) {
    const match = masterRegex.exec(code);
    if (!match) {
      html += escapeHtml(code[masterRegex.lastIndex]);
      masterRegex.lastIndex++;
      continue;
    }
    const g = match.groups;
    if (g.key) {
      html += `<span class="tok-property">${escapeHtml(match[0])}</span>`;
    } else if (g.string) {
      html += `<span class="tok-string">${escapeHtml(match[0])}</span>`;
    } else if (g.number) {
      html += `<span class="tok-number">${escapeHtml(match[0])}</span>`;
    } else if (g.builtin) {
      html += `<span class="tok-builtin">${escapeHtml(match[0])}</span>`;
    } else if (g.punct) {
      html += `<span class="tok-punct">${escapeHtml(match[0])}</span>`;
    } else {
      html += escapeHtml(match[0]);
    }
  }
  return html;
}

function highlightEnv(code) {
  return code
    .split('\n')
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return '';
      if (trimmed.startsWith('#') || trimmed.startsWith(';')) {
        return `<span class="tok-comment">${escapeHtml(line)}</span>`;
      }
      if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
        return `<span class="tok-type">${escapeHtml(line)}</span>`;
      }
      const eqIdx = line.indexOf('=');
      if (eqIdx !== -1) {
        const key = line.slice(0, eqIdx);
        const val = line.slice(eqIdx + 1);

        let valHtml = '';
        const valTrim = val.trim();
        if ((valTrim.startsWith('"') && valTrim.endsWith('"')) || (valTrim.startsWith("'") && valTrim.endsWith("'"))) {
          valHtml = `<span class="tok-string">${escapeHtml(val)}</span>`;
        } else if (/^-?\d+(\.\d+)?$/.test(valTrim)) {
          valHtml = `<span class="tok-number">${escapeHtml(val)}</span>`;
        } else if (/^(true|false|yes|no|on|off)$/i.test(valTrim)) {
          valHtml = `<span class="tok-builtin">${escapeHtml(val)}</span>`;
        } else {
          valHtml = `<span class="tok-string">${escapeHtml(val)}</span>`;
        }
        return `<span class="tok-property">${escapeHtml(key)}</span><span class="tok-operator">=</span>${valHtml}`;
      }
      return escapeHtml(line);
    })
    .join('\n');
}

function highlightBash(code) {
  const masterRegex = new RegExp(
    [
      '(?<comment>#.*)',
      '(?<string>"(?:[^"\\\\\n]|\\\\.)*"|\'(?:[^\'\\\\\n]|\\\\.)*\')',
      '(?<variable>\\$(?:[a-zA-Z_]\\w*|\\{[a-zA-Z_]\\w*\\}|\\?|\\$|#|\\d+))',
      '(?<keyword>\\b(?:if|then|else|elif|fi|for|while|in|do|done|case|esac|function|select|until|return|exit|source)\\b)',
      '(?<command>\\b(?:echo|cd|ls|pwd|mkdir|rm|cp|mv|chmod|chown|touch|cat|grep|sed|awk|curl|wget|tar|export|local|read|kill|sudo|systemctl|docker|git|cargo|node|npm|pnpm|python|python3|pip)\\b)',
      '(?<flag>-[a-zA-Z0-9_-]+)',
      '(?<number>\\b\\d+\\b)',
      '(?<operator>==|!=|<=|>=|&&|\\|\\||>>|>|<|\\||[+\\-*/%<>=])',
      '(?<punct>[{}()[\\];,])',
      '(?<ident>[a-zA-Z_][a-zA-Z0-9_.-]*)',
      '(?<ws>\\s+)',
      '(?<other>[^a-zA-Z0-9_\\s{}()[\\];,#"\'+<>=|&$-]+)'
    ].join('|'),
    'gy'
  );

  let html = '';
  masterRegex.lastIndex = 0;
  while (masterRegex.lastIndex < code.length) {
    const match = masterRegex.exec(code);
    if (!match) {
      html += escapeHtml(code[masterRegex.lastIndex]);
      masterRegex.lastIndex++;
      continue;
    }
    const g = match.groups;
    if (g.comment) {
      html += `<span class="tok-comment">${escapeHtml(match[0])}</span>`;
    } else if (g.string) {
      html += `<span class="tok-string">${escapeHtml(match[0])}</span>`;
    } else if (g.variable) {
      html += `<span class="tok-property">${escapeHtml(match[0])}</span>`;
    } else if (g.keyword) {
      html += `<span class="tok-keyword">${escapeHtml(match[0])}</span>`;
    } else if (g.command) {
      html += `<span class="tok-function">${escapeHtml(match[0])}</span>`;
    } else if (g.flag) {
      html += `<span class="tok-operator">${escapeHtml(match[0])}</span>`;
    } else if (g.number) {
      html += `<span class="tok-number">${escapeHtml(match[0])}</span>`;
    } else if (g.operator) {
      html += `<span class="tok-operator">${escapeHtml(match[0])}</span>`;
    } else if (g.punct) {
      html += `<span class="tok-punct">${escapeHtml(match[0])}</span>`;
    } else {
      html += escapeHtml(match[0]);
    }
  }
  return html;
}

function highlightHtml(code) {
  const masterRegex = new RegExp(
    [
      '(?<comment><!--[\\s\\S]*?-->)',
      '(?<doctype><!DOCTYPE[^>]*>)',
      '(?<tag><\\/?[a-zA-Z0-9:-]+)',
      '(?<tagclose>\\/?>)',
      '(?<attr>[a-zA-Z0-9-_:]+(?=\\s*=))',
      '(?<attrval>=\\s*(?:"[^"]*"|\'[^\']*\'))',
      '(?<string>"(?:[^"\\\\\n]|\\\\.)*"|\'(?:[^\'\\\\\n]|\\\\.)*\')',
      '(?<punct>[<>=/])',
      '(?<text>[^<>&]+)',
      '(?<other>[<>&])'
    ].join('|'),
    'gy'
  );

  let html = '';
  masterRegex.lastIndex = 0;
  while (masterRegex.lastIndex < code.length) {
    const match = masterRegex.exec(code);
    if (!match) {
      html += escapeHtml(code[masterRegex.lastIndex]);
      masterRegex.lastIndex++;
      continue;
    }
    const g = match.groups;
    if (g.comment) {
      html += `<span class="tok-comment">${escapeHtml(match[0])}</span>`;
    } else if (g.doctype) {
      html += `<span class="tok-keyword">${escapeHtml(match[0])}</span>`;
    } else if (g.tag) {
      html += `<span class="tok-tag">${escapeHtml(match[0])}</span>`;
    } else if (g.tagclose) {
      html += `<span class="tok-tag">${escapeHtml(match[0])}</span>`;
    } else if (g.attr) {
      html += `<span class="tok-attr">${escapeHtml(match[0])}</span>`;
    } else if (g.attrval) {
      const eq = match[0].indexOf('=');
      html += `<span class="tok-operator">${escapeHtml(match[0].slice(0, eq + 1))}</span><span class="tok-string">${escapeHtml(match[0].slice(eq + 1))}</span>`;
    } else if (g.string) {
      html += `<span class="tok-string">${escapeHtml(match[0])}</span>`;
    } else {
      html += escapeHtml(match[0]);
    }
  }
  return html;
}

function highlightCss(code) {
  const masterRegex = new RegExp(
    [
      '(?<comment>/\\*[\\s\\S]*?\\*/)',
      '(?<atrule>@[a-zA-Z-]+)',
      '(?<string>"(?:[^"\\\\\n]|\\\\.)*"|\'(?:[^\'\\\\\n]|\\\\.)*\')',
      '(?<color>#[0-9a-fA-F]{3,8}\\b)',
      '(?<property>\\b[a-zA-Z-]+(?=\\s*:))',
      '(?<unit>\\b\\d+(?:\\.\\d+)?(?:px|em|rem|%|vh|vw|s|ms|deg|fr)\\b)',
      '(?<number>\\b\\d+(?:\\.\\d+)?\\b)',
      '(?<fncall>\\b[a-zA-Z-]+(?=\\())',
      '(?<punct>[{}(),;:!])',
      '(?<ws>\\s+)',
      '(?<ident>[.#]?[a-zA-Z0-9_-]+)',
      '(?<other>[^a-zA-Z0-9_#.\\s{}(),;:!"\'-]+)'
    ].join('|'),
    'gy'
  );

  let html = '';
  masterRegex.lastIndex = 0;
  while (masterRegex.lastIndex < code.length) {
    const match = masterRegex.exec(code);
    if (!match) {
      html += escapeHtml(code[masterRegex.lastIndex]);
      masterRegex.lastIndex++;
      continue;
    }
    const g = match.groups;
    if (g.comment) {
      html += `<span class="tok-comment">${escapeHtml(match[0])}</span>`;
    } else if (g.atrule) {
      html += `<span class="tok-keyword">${escapeHtml(match[0])}</span>`;
    } else if (g.string) {
      html += `<span class="tok-string">${escapeHtml(match[0])}</span>`;
    } else if (g.color) {
      html += `<span class="tok-number">${escapeHtml(match[0])}</span>`;
    } else if (g.property) {
      html += `<span class="tok-property">${escapeHtml(match[0])}</span>`;
    } else if (g.unit || g.number) {
      html += `<span class="tok-number">${escapeHtml(match[0])}</span>`;
    } else if (g.fncall) {
      html += `<span class="tok-function">${escapeHtml(match[0])}</span>`;
    } else if (g.punct) {
      html += `<span class="tok-punct">${escapeHtml(match[0])}</span>`;
    } else {
      html += escapeHtml(match[0]);
    }
  }
  return html;
}

function highlightYaml(code) {
  return code
    .split('\n')
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return '';
      if (trimmed.startsWith('#')) {
        return `<span class="tok-comment">${escapeHtml(line)}</span>`;
      }
      const colonIdx = line.indexOf(':');
      if (colonIdx !== -1 && !line.includes('://')) {
        const keyPart = line.slice(0, colonIdx);
        const valPart = line.slice(colonIdx + 1);

        let valHtml = '';
        const vTrim = valPart.trim();
        if ((vTrim.startsWith('"') && vTrim.endsWith('"')) || (vTrim.startsWith("'") && vTrim.endsWith("'"))) {
          valHtml = `<span class="tok-string">${escapeHtml(valPart)}</span>`;
        } else if (/^-?\d+(\.\d+)?$/.test(vTrim)) {
          valHtml = `<span class="tok-number">${escapeHtml(valPart)}</span>`;
        } else if (/^(true|false|yes|no|on|off|null)$/i.test(vTrim)) {
          valHtml = `<span class="tok-builtin">${escapeHtml(valPart)}</span>`;
        } else {
          valHtml = escapeHtml(valPart);
        }
        return `<span class="tok-property">${escapeHtml(keyPart)}</span><span class="tok-punct">:</span>${valHtml}`;
      }
      return escapeHtml(line);
    })
    .join('\n');
}

function highlightSql(code) {
  const masterRegex = new RegExp(
    [
      '(?<comment>--.*|/\\*[\\s\\S]*?\\*/)',
      '(?<string>\'(?:[^\'\\\\]|\\\\.)*\')',
      '(?<keyword>\\b(?:SELECT|FROM|WHERE|INSERT|INTO|UPDATE|SET|DELETE|CREATE|DROP|ALTER|TABLE|VIEW|INDEX|JOIN|LEFT|RIGHT|INNER|OUTER|CROSS|ON|AND|OR|NOT|IN|IS|NULL|LIKE|ORDER|BY|ASC|DESC|GROUP|HAVING|LIMIT|OFFSET|UNION|ALL|AS|DISTINCT|PRIMARY|KEY|FOREIGN|REFERENCES|DEFAULT|CHECK|UNIQUE|VALUES|CASE|WHEN|THEN|ELSE|END|EXISTS|BETWEEN|COUNT|SUM|AVG|MIN|MAX)\\b)',
      '(?<number>\\b\\d+(?:\\.\\d+)?\\b)',
      '(?<operator>=|!=|<>|<=|>=|[+\\-*/%<>=])',
      '(?<punct>[{}()[\\];,.])',
      '(?<ident>[a-zA-Z_][a-zA-Z0-9_]*)',
      '(?<ws>\\s+)',
      '(?<other>[^a-zA-Z0-9_\\s{}()[\\];,.\'-]+)'
    ].join('|'),
    'giy'
  );

  let html = '';
  masterRegex.lastIndex = 0;
  while (masterRegex.lastIndex < code.length) {
    const match = masterRegex.exec(code);
    if (!match) {
      html += escapeHtml(code[masterRegex.lastIndex]);
      masterRegex.lastIndex++;
      continue;
    }
    const g = match.groups;
    if (g.comment) {
      html += `<span class="tok-comment">${escapeHtml(match[0])}</span>`;
    } else if (g.string) {
      html += `<span class="tok-string">${escapeHtml(match[0])}</span>`;
    } else if (g.keyword) {
      html += `<span class="tok-keyword">${escapeHtml(match[0])}</span>`;
    } else if (g.number) {
      html += `<span class="tok-number">${escapeHtml(match[0])}</span>`;
    } else if (g.operator) {
      html += `<span class="tok-operator">${escapeHtml(match[0])}</span>`;
    } else if (g.punct) {
      html += `<span class="tok-punct">${escapeHtml(match[0])}</span>`;
    } else {
      html += escapeHtml(match[0]);
    }
  }
  return html;
}

function highlightDockerfile(code) {
  return code
    .split('\n')
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return '';
      if (trimmed.startsWith('#')) {
        return `<span class="tok-comment">${escapeHtml(line)}</span>`;
      }
      const match = line.match(/^(\s*)(FROM|RUN|CMD|LABEL|MAINTAINER|EXPOSE|ENV|ADD|COPY|ENTRYPOINT|VOLUME|USER|WORKDIR|ARG|ONBUILD|STOPSIGNAL|HEALTHCHECK|SHELL)\b(.*)$/i);
      if (match) {
        return `${escapeHtml(match[1])}<span class="tok-keyword">${escapeHtml(match[2])}</span>${escapeHtml(match[3])}`;
      }
      return escapeHtml(line);
    })
    .join('\n');
}

export function highlightCode(code, langOrFilename) {
  if (!code) return '';
  // Performance safeguard for extremely large files (>500KB or >15k lines)
  if (code.length > 500000 || code.split('\n').length > 15000) {
    return escapeHtml(code);
  }

  const lang = detectLanguage(langOrFilename);
  let highlighted = '';

  switch (lang) {
    case 'python':
      highlighted = highlightPython(code);
      break;
    case 'javascript':
    case 'typescript':
      highlighted = highlightJsTs(code);
      break;
    case 'json':
      highlighted = highlightJson(code);
      break;
    case 'env':
      highlighted = highlightEnv(code);
      break;
    case 'bash':
      highlighted = highlightBash(code);
      break;
    case 'html':
      highlighted = highlightHtml(code);
      break;
    case 'css':
      highlighted = highlightCss(code);
      break;
    case 'yaml':
      highlighted = highlightYaml(code);
      break;
    case 'sql':
      highlighted = highlightSql(code);
      break;
    case 'dockerfile':
      highlighted = highlightDockerfile(code);
      break;
    default:
      highlighted = escapeHtml(code);
      break;
  }

  // Critical for textarea overlay: browsers collapse trailing newlines in <pre>
  if (code.endsWith('\n')) {
    highlighted += '\n';
  }

  return highlighted;
}
