/**
 * WebDep Interactive Live Demo Mock Backend
 * Intercepts /api/* fetch calls & EventSource streams so the genuine WebDep UI
 * runs 100% client-side with live 60fps telemetry, state mutations, & zero backend needed.
 */
(() => {
  if (window.__WEBDEP_DEMO_MOCK__) return;
  window.__WEBDEP_DEMO_MOCK__ = true;

  const nativeFetch = window.fetch.bind(window);
  const nowSec = () => Math.floor(Date.now() / 1000);
  const nowMs = () => Date.now();

  let signedIn = false;
  let activeTheme = (() => {
    try {
      return localStorage.getItem('webdep.theme') || 'midnight-ink';
    } catch (_) {
      return 'midnight-ink';
    }
  })();

  let nextId = 200;
  const bootTime = Date.now() - 48 * 3600 * 1000;
  let totalRxBytes = 10.6 * 1024 * 1024 * 1024;
  let totalTxBytes = 6.8 * 1024 * 1024 * 1024;
  let netPhase = 0.7;

  // Build 48 initial 1-second network history samples matching overview.js / app_usage.js
  const netHistory = [];
  for (let i = 48; i >= 0; i--) {
    const t = Date.now() - i * 1000;
    const wave = Math.sin(i * 0.28) * 0.42 + Math.cos(i * 0.14) * 0.25;
    const burst = i === 5 || i === 4 ? 3.1 : i === 18 ? 1.85 : 1;
    netHistory.push({
      ts: t,
      inboundBps: Math.round(Math.max(8500, 62000 * (1 + wave * 0.5) * burst)),
      outboundBps: Math.round(Math.max(14000, 148000 * (1 + Math.sin(i * 0.34) * 0.44) * (burst > 2 ? 2.4 : 1))),
    });
  }

  function stepNetworkSample() {
    netPhase += 0.48;
    const spike = Math.random() > 0.85 ? 1.7 + Math.random() * 1.15 : 1;
    const inbound = Math.round(Math.max(9200, (58000 + Math.sin(netPhase) * 28000 + Math.random() * 22000) * spike));
    const outbound = Math.round(Math.max(18000, (142000 + Math.cos(netPhase * 0.82) * 64000 + Math.random() * 44000) * spike));
    totalRxBytes += inbound;
    totalTxBytes += outbound;
    const pt = { ts: Date.now(), inboundBps: inbound, outboundBps: outbound };
    netHistory.push(pt);
    if (netHistory.length > 75) netHistory.shift();
    return pt;
  }

  // Initial stateful workloads
  const projects = [
    {
      id: 1,
      name: 'Payments API',
      slug: 'payments-api',
      project_kind: 'website',
      project_type: 'Node.js / TypeScript',
      repo_url: 'git@github.com:acme-corp/payments-api.git',
      branch: 'main',
      root_dir: '',
      install_cmd: 'npm ci',
      build_cmd: 'npm run build',
      start_cmd: 'node dist/server.js',
      port: 8080,
      domains: ['api.acme-cloud.dev'],
      access_mode: 'public',
      allowed_ips: '',
      app_status: 'running',
      app_pid: 69928,
      app_started_at: new Date(Date.now() - 14 * 3600 * 1000).toISOString(),
      deployed_sha: 'a15d04e91f8c30b4a2',
      diskFormatted: '919 KB',
      cpuPct: 0.2,
      memoryBytes: 31.1 * 1048576,
      diskBytes: 919 * 1024,
      auto_deploy: true,
      webhook_secret: 'whsec_demo_9914b7a2',
    },
    {
      id: 2,
      name: 'Acme Storefront',
      slug: 'acme-storefront',
      project_kind: 'website',
      project_type: 'Next.js App',
      repo_url: 'git@github.com:acme-corp/storefront.git',
      branch: 'main',
      root_dir: '',
      install_cmd: 'npm ci',
      build_cmd: 'npm run build',
      start_cmd: 'npm run start -- -p 3001',
      port: 3001,
      domains: ['shop.acme-cloud.dev'],
      access_mode: 'public',
      allowed_ips: '',
      app_status: 'running',
      app_pid: 68212,
      app_started_at: new Date(Date.now() - 9 * 3600 * 1000).toISOString(),
      deployed_sha: '8f3c91a20e12d4b887',
      diskFormatted: '1.0 MB',
      cpuPct: 0.1,
      memoryBytes: 30.9 * 1048576,
      diskBytes: 1024 * 1024,
      auto_deploy: true,
      webhook_secret: 'whsec_demo_4418a912',
    },
    {
      id: 3,
      name: 'Marketing Docs',
      slug: 'marketing-docs',
      project_kind: 'website',
      project_type: 'React / TypeScript',
      repo_url: 'git@github.com:acme-corp/docs-site.git',
      branch: 'main',
      root_dir: '',
      install_cmd: 'npm ci',
      build_cmd: 'npm run build',
      start_cmd: 'vite preview --port 4173',
      port: 4173,
      domains: ['docs.acme-cloud.dev'],
      access_mode: 'localhost',
      allowed_ips: '',
      app_status: 'stopped',
      app_pid: null,
      app_started_at: null,
      deployed_sha: '5e21b0f4a199e7710a',
      diskFormatted: '457 KB',
      cpuPct: 0,
      memoryBytes: 0,
      diskBytes: 457 * 1024,
      auto_deploy: false,
      webhook_secret: 'whsec_demo_0094d11c',
    },
    {
      id: 4,
      name: 'Email Queue Worker',
      slug: 'email-queue-worker',
      project_kind: 'service',
      project_type: 'Node.js Daemon',
      repo_url: 'git@github.com:acme-corp/email-worker.git',
      branch: 'main',
      root_dir: '',
      install_cmd: 'npm ci',
      build_cmd: 'npm run build',
      start_cmd: 'node dist/worker.js',
      port: 3102,
      domains: [],
      access_mode: 'localhost',
      app_status: 'running',
      app_pid: 70340,
      app_started_at: new Date(Date.now() - 22 * 3600 * 1000).toISOString(),
      deployed_sha: 'f72a11c331ab9f0211',
      diskFormatted: '313 KB',
      cpuPct: 0.1,
      memoryBytes: 31.0 * 1048576,
      diskBytes: 313 * 1024,
      deployStatus: { status: 'success', stage: 'health_checking', message: 'Online' },
    },
    {
      id: 5,
      name: 'Analytics Aggregator',
      slug: 'analytics-aggregator',
      project_kind: 'service',
      project_type: 'Python Daemon',
      repo_url: 'git@github.com:acme-corp/analytics-py.git',
      branch: 'main',
      root_dir: '',
      install_cmd: 'pip install -r requirements.txt',
      build_cmd: '',
      start_cmd: 'uvicorn app:main --port 8000',
      port: 8000,
      domains: [],
      access_mode: 'localhost',
      app_status: 'stopped',
      app_pid: null,
      app_started_at: null,
      deployed_sha: '99bc10277e45f12a08',
      diskFormatted: '119 KB',
      cpuPct: 0,
      memoryBytes: 0,
      diskBytes: 119 * 1024,
      deployStatus: null,
    },
  ];

  const databases = [
    {
      id: 1,
      name: 'analytics-warehouse',
      db_name: 'analytics',
      db_user: 'warehouse_usr',
      host: '127.0.0.1',
      port: 5433,
      domain: '',
      access_mode: 'local',
      status: 'running',
      pid: 4120,
      container_id: 'pid-4120',
      started_at: new Date(Date.now() - 36 * 3600 * 1000).toISOString(),
      diskFormatted: '273 KB',
      memoryBytes: 0.9 * 1048576,
      diskBytes: 273 * 1024,
      cpuPct: 0.0,
    },
    {
      id: 2,
      name: 'acme-prod-db',
      db_name: 'acme_prod',
      db_user: 'wd_usr',
      host: '127.0.0.1',
      port: 5432,
      domain: '',
      access_mode: 'local',
      status: 'running',
      pid: 3988,
      container_id: 'pid-3988',
      started_at: new Date(Date.now() - 48 * 3600 * 1000).toISOString(),
      diskFormatted: '463 KB',
      memoryBytes: 0.9 * 1048576,
      diskBytes: 463 * 1024,
      cpuPct: 0.0,
    },
  ];

  const envByProject = {
    1: [
      { key: 'NODE_ENV', value: 'production', real_value: 'production', is_secret: false },
      { key: 'PORT', value: '8080', real_value: '8080', is_secret: false },
      { key: 'DATABASE_URL', value: '********', real_value: 'postgres://wd_usr:s3cr3t@127.0.0.1:5432/acme_prod', is_secret: true },
      { key: 'STRIPE_WEBHOOK_SECRET', value: '********', real_value: 'whsec_live_9823f7a1c02e4410', is_secret: true },
    ],
    2: [
      { key: 'NEXT_PUBLIC_API_URL', value: 'https://api.acme-cloud.dev', real_value: 'https://api.acme-cloud.dev', is_secret: false },
      { key: 'SESSION_SECRET', value: '********', real_value: 'aes256_gcm_c91a88412f01', is_secret: true },
    ],
  };

  const filesTree = {
    '': [
      { name: 'src', is_dir: true, size: 0, modified: nowSec() - 3600 },
      { name: 'package.json', is_dir: false, size: 482, modified: nowSec() - 7200 },
      { name: 'tsconfig.json', is_dir: false, size: 312, modified: nowSec() - 86400 },
      { name: '.gitignore', is_dir: false, size: 96, modified: nowSec() - 172800 },
    ],
    src: [
      { name: 'server.ts', is_dir: false, size: 1240, modified: nowSec() - 1200 },
      { name: 'webhooks.ts', is_dir: false, size: 890, modified: nowSec() - 3600 },
    ],
  };

  const fileContents = {
    'package.json': `{
  "name": "payments-api",
  "version": "2.4.12",
  "type": "module",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "start": "node dist/server.js"
  },
  "engines": { "node": ">=20" }
}`,
    'tsconfig.json': `{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "outDir": "dist",
    "strict": true
  }
}`,
    '.gitignore': `node_modules\ndist\n.env\n`,
    'src/server.ts': `import http from "node:http";
import { verifyWebhook } from "./webhooks.js";

const PORT = Number(process.env.PORT || 8080);

const server = http.createServer(async (req, res) => {
  if (req.url === "/healthz") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ status: "ok", pid: process.pid }));
  }

  if (req.method === "POST" && req.url === "/v1/webhooks/stripe") {
    const ok = verifyWebhook(req.headers["stripe-signature"]);
    res.writeHead(ok ? 200 : 401);
    return res.end(ok ? "verified" : "invalid signature");
  }

  res.writeHead(404).end("Not Found");
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(\`[payments-api] Listening on 127.0.0.1:\${PORT}\`);
});`,
    'src/webhooks.ts': `import crypto from "node:crypto";

export function verifyWebhook(sigHeader) {
  if (!sigHeader || Array.isArray(sigHeader)) return false;
  const secret = process.env.STRIPE_WEBHOOK_SECRET || "";
  const hmac = crypto.createHmac("sha256", secret).update(sigHeader).digest("hex");
  return hmac.length === 64;
}`,
  };

  const deployments = [
    {
      id: 42,
      project_id: 1,
      kind: 'deploy',
      sha: 'a15d04e91f8c30b4a2',
      message: 'feat(webhooks): verify stripe ed25519 signature header',
      author: 'just-nixx',
      status: 'success',
      stage: 'health_checking',
      duration_ms: 4820,
      created_at: new Date(Date.now() - 840000).toISOString(),
      logs: '[pending] Queued deploy #42\n[fetching] git fetch origin main\n[pulling] Checked out a15d04e\n[installing] npm ci (1.8s)\n[building] tsc -p tsconfig.json (0.9s)\n[deploying] Swapped release symlink & started PID 69928\n[health_checking] GET 127.0.0.1:8080/healthz -> 200 OK',
    },
    {
      id: 41,
      project_id: 2,
      kind: 'deploy',
      sha: '8f3c91a20e12d4b887',
      message: 'perf: stream product catalog RSC chunks',
      author: 'just-nixx',
      status: 'success',
      stage: 'health_checking',
      duration_ms: 6140,
      created_at: new Date(Date.now() - 10800000).toISOString(),
      logs: '[deploy] Acme Storefront built cleanly and verified on :3001',
    },
  ];

  const releases = [
    {
      id: 12,
      project_id: 1,
      sha: 'a15d04e91f8c30b4a2',
      short_sha: 'a15d04e',
      message: 'feat(webhooks): verify stripe ed25519 signature header',
      author: 'just-nixx',
      status: 'succeeded',
      build_status: 'success',
      health_status: 'ok',
      live: true,
      available: true,
      deployment_id: 42,
      created_at: new Date(Date.now() - 840000).toISOString(),
      deployed_at: new Date(Date.now() - 840000).toISOString(),
    },
    {
      id: 11,
      project_id: 1,
      sha: '94c0b2189fe01a239c',
      short_sha: '94c0b21',
      message: 'chore(pool): tune pg max_connections=40 & idle timeout',
      author: 'just-nixx',
      status: 'succeeded',
      build_status: 'success',
      health_status: 'ok',
      live: false,
      available: true,
      deployment_id: 41,
      created_at: new Date(Date.now() - 14400000).toISOString(),
      deployed_at: new Date(Date.now() - 14400000).toISOString(),
    },
  ];

  const auditLogs = [
    { ts: new Date(Date.now() - 600000).toISOString(), actor: 'admin', action: 'deploy.success', detail: 'Deployed release #12 (a15d04e) to Payments API', ip: '127.0.0.1', project_id: 1 },
    { ts: new Date(Date.now() - 3600000).toISOString(), actor: 'admin', action: 'domains.sync', detail: 'Synced Caddy TLS route api.acme-cloud.dev -> 127.0.0.1:8080', ip: '127.0.0.1', project_id: 1 },
    { ts: new Date(Date.now() - 9600000).toISOString(), actor: 'system', action: 'database.start', detail: 'Started PostgreSQL instance acme-prod-db on port 5432', ip: 'local', database_id: 2 },
  ];

  const demoUser = {
    id: 1,
    username: 'admin',
    isMainAdmin: true,
    role: 'Main Admin',
    permissions: ['*'],
    totpEnabled: true,
  };

  function buildResources() {
    const res = [
      {
        kind: 'panel',
        name: 'WebDep Engine',
        port: 9000,
        pid: 1482,
        status: 'running',
        cpuPct: 0.0,
        memoryBytes: 22.3 * 1048576,
        memoryFormatted: '22.3 MB',
        memoryPct: 0.1,
        diskBytes: 10.2 * 1048576,
        diskFormatted: '10.2 MB',
        diskPct: 0.0,
      },
    ];
    for (const p of projects) {
      const running = p.app_status === 'running';
      res.push({
        kind: p.project_kind === 'service' ? 'service' : 'website',
        projectId: p.id,
        name: p.name,
        domain: p.domains?.[0] || null,
        commitSha: p.deployed_sha || null,
        projectType: p.project_type,
        startCmd: p.start_cmd,
        port: p.port,
        pid: running ? p.app_pid : null,
        status: p.app_status,
        cpuPct: running ? p.cpuPct : 0,
        memoryBytes: running ? p.memoryBytes : 0,
        memoryFormatted: running ? `${(p.memoryBytes / 1048576).toFixed(1)} MB` : '0 MB',
        memoryPct: running ? 0.2 : 0,
        diskBytes: p.diskBytes,
        diskFormatted: p.diskFormatted,
        diskPct: 0.0,
      });
    }
    for (const d of databases) {
      const running = d.status === 'running';
      res.push({
        kind: 'database',
        databaseId: d.id,
        name: d.name,
        port: d.port,
        pid: running ? d.pid : null,
        status: d.status,
        cpuPct: 0.0,
        memoryBytes: running ? d.memoryBytes : 0,
        memoryFormatted: running ? '< 1 MB' : '0 MB',
        memoryPct: 0.0,
        diskBytes: d.diskBytes,
        diskFormatted: d.diskFormatted,
        diskPct: 0.0,
      });
    }
    return res;
  }

  function buildOverviewPayload() {
    const latestNet = stepNetworkSample();
    const resources = buildResources();
    const workloads = resources.filter((r) => r.kind !== 'panel');
    const runningCount = workloads.filter((r) => r.status === 'running').length;
    const managedBytes = workloads.reduce((acc, r) => acc + (r.memoryBytes || 0), 0);

    return {
      monitor: {
        cpu: { pct: 15, cores: 10 },
        memory: { pct: 72, used: 11649 * 1048576, total: 16105 * 1048576 },
        disk: { pct: 80, free: 91.6 * 1073741824, total: 464.6 * 1073741824 },
      },
      network: {
        inboundBps: latestNet.inboundBps,
        outboundBps: latestNet.outboundBps,
        interfaceCount: 2,
        totalRxBytes: Math.round(totalRxBytes),
        totalTxBytes: Math.round(totalTxBytes),
        history: [...netHistory],
      },
      summary: {
        panelMemoryFormatted: '22.3 MB',
        panelCpu: 0.0,
        totalManagedMemoryFormatted: `${(managedBytes / 1048576).toFixed(1)} MB`,
        totalManagedCpu: 0.3,
        systemOverheadMemoryFormatted: '11.26 GB',
        systemOverheadCpu: 15.0,
        runningWorkloadsCount: runningCount,
        totalWorkloadsCount: workloads.length,
      },
      resources,
      projects: projects.map((p) => ({
        project: p,
        active: deployments.find((d) => d.project_id === p.id && d.status === 'running') || null,
      })),
    };
  }

  function jsonResp(data, status = 200) {
    return new Response(JSON.stringify(data), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Simulate live deployment progression
  function startMockDeployment(project, sha) {
    const depId = ++nextId;
    const dep = {
      id: depId,
      project_id: project.id,
      kind: 'deploy',
      sha: sha || project.deployed_sha || Math.random().toString(16).slice(2, 18),
      message: 'Triggered deploy from WebDep interactive panel',
      author: 'admin',
      status: 'running',
      stage: 'pending',
      duration_ms: 0,
      created_at: new Date().toISOString(),
      logs: '[pending] Queued deployment job #' + depId + '\n',
    };
    deployments.unshift(dep);
    auditLogs.unshift({
      ts: new Date().toISOString(),
      actor: 'admin',
      action: 'deploy.start',
      detail: `Started deployment #${depId} for ${project.name}`,
      ip: '127.0.0.1',
      project_id: project.id,
    });

    const stages = ['fetching', 'pulling', 'installing', 'building', 'deploying', 'health_checking'];
    let i = 0;
    const timer = setInterval(() => {
      if (i < stages.length) {
        dep.stage = stages[i];
        dep.logs += `[${stages[i]}] Executing ${stages[i]} step...\n`;
        // Boost live network traffic during fetch/install
        if (i <= 2) {
          netHistory.push({
            ts: Date.now(),
            inboundBps: 410000 + Math.random() * 190000,
            outboundBps: 195000 + Math.random() * 85000,
          });
        }
        i++;
      } else {
        clearInterval(timer);
        dep.status = 'success';
        dep.stage = 'health_checking';
        dep.duration_ms = 3950;
        dep.logs += `[health_checking] App responding 200 OK on :${project.port}\n`;
        project.app_status = 'running';
        project.app_pid = Math.floor(68000 + Math.random() * 4000);
        project.deployed_sha = dep.sha;
        project.app_started_at = new Date().toISOString();
      }
    }, 650);

    return dep;
  }

  // Intercept /api/* requests
  window.fetch = async (input, init = {}) => {
    const rawUrl = typeof input === 'string' ? input : input?.url || '';
    const u = new URL(rawUrl, window.location.origin);
    const path = u.pathname;
    const method = (init.method || 'GET').toUpperCase();

    if (!path.startsWith('/api/')) {
      return nativeFetch(input, init);
    }

    let body = {};
    if (init.body && typeof init.body === 'string') {
      try { body = JSON.parse(init.body); } catch (_) {}
    }

    // Theme & Auth
    if (path === '/api/theme') {
      return jsonResp({ theme: activeTheme });
    }
    if (path === '/api/auth/me') {
      if (!signedIn) return jsonResp({ error: 'Not authenticated' }, 401);
      return jsonResp({ user: demoUser, csrf: 'demo-csrf-token', activeSessions: 1, passkeyCount: 1 });
    }
    if (path === '/api/auth/login' && method === 'POST') {
      signedIn = true;
      return jsonResp({ user: demoUser, csrf: 'demo-csrf-token' });
    }
    if (path === '/api/auth/logout' && method === 'POST') {
      signedIn = false;
      return jsonResp({ ok: true });
    }
    if (path === '/api/auth/presence' && method === 'POST') {
      return jsonResp({ ok: true });
    }
    if (path === '/api/auth/passkeys') {
      return jsonResp([{ id: 1, name: 'MacBook Touch ID (Demo)', created_at: new Date().toISOString() }]);
    }

    // Overview & Network
    if (path === '/api/overview') {
      return jsonResp(buildOverviewPayload());
    }
    if (path === '/api/overview/network') {
      const latestNet = stepNetworkSample();
      return jsonResp({
        inboundBps: latestNet.inboundBps,
        outboundBps: latestNet.outboundBps,
        interfaceCount: 2,
        totalRxBytes: Math.round(totalRxBytes),
        totalTxBytes: Math.round(totalTxBytes),
        history: [...netHistory],
      });
    }

    // Projects / Websites / Services
    if (path === '/api/projects' && method === 'GET') {
      return jsonResp(projects);
    }
    if (path === '/api/projects' && method === 'POST') {
      const id = ++nextId;
      const slug = (body.name || `app-${id}`).toLowerCase().replace(/[^a-z0-9]+/g, '-');
      const created = {
        id,
        name: body.name || `App ${id}`,
        slug,
        project_kind: body.project_kind || 'website',
        project_type: body.project_type || 'Node.js App',
        repo_url: body.repo_url || `git@github.com:acme-corp/${slug}.git`,
        branch: body.branch || 'main',
        start_cmd: body.start_cmd || 'npm start',
        port: Number(body.port) || 3000 + id,
        domains: body.domains ? (Array.isArray(body.domains) ? body.domains : [body.domains]) : [`${slug}.acme-cloud.dev`],
        access_mode: body.access_mode || 'public',
        app_status: 'running',
        app_pid: Math.floor(70000 + Math.random() * 5000),
        app_started_at: new Date().toISOString(),
        deployed_sha: Math.random().toString(16).slice(2, 16),
        diskFormatted: '512 KB',
        cpuPct: 0.1,
        memoryBytes: 28 * 1048576,
        diskBytes: 512 * 1024,
      };
      projects.unshift(created);
      return jsonResp(created);
    }

    // Project sub-routes
    let m;
    if ((m = path.match(/^\/api\/projects\/(\d+)\/usage$/))) {
      const p = projects.find((x) => x.id === Number(m[1]));
      const running = p?.app_status === 'running';
      const latestNet = stepNetworkSample();
      return jsonResp({
        running,
        port: p?.port || 3000,
        cpu: { pct: running ? (p?.cpuPct || 0.4) : 0, cores: 10 },
        ram: {
          bytes: running ? (p?.memoryBytes || 31 * 1048576) : 0,
          percentOfHost: running ? 0.2 : 0,
          formatted: running ? `${((p?.memoryBytes || 31 * 1048576) / 1048576).toFixed(1)} MB` : '0 B',
          hostTotalFormatted: '15.7 GB',
        },
        disk: {
          bytes: p?.diskBytes || 919 * 1024,
          percentOfVps: 0.1,
          formatted: p?.diskFormatted || '919 KB',
          vpsFreeFormatted: '91.6 GB',
        },
        network: {
          inboundBps: running ? Math.round(latestNet.inboundBps * 0.45) : 0,
          outboundBps: running ? Math.round(latestNet.outboundBps * 0.45) : 0,
          interfaceCount: 1,
          totalRxBytes: 412 * 1048576,
          totalTxBytes: 980 * 1048576,
          history: netHistory.map((h) => ({
            ts: h.ts,
            inboundBps: Math.round(h.inboundBps * 0.45),
            outboundBps: Math.round(h.outboundBps * 0.45),
          })),
        },
      });
    }

    if ((m = path.match(/^\/api\/projects\/(\d+)\/(start|stop|restart|fetch|maintenance)$/))) {
      const p = projects.find((x) => x.id === Number(m[1]));
      const act = m[2];
      if (p) {
        if (act === 'start' || act === 'restart') {
          p.app_status = 'running';
          p.app_pid = Math.floor(68000 + Math.random() * 4000);
          p.app_started_at = new Date().toISOString();
          p.memoryBytes = 31.1 * 1048576;
        } else if (act === 'stop') {
          p.app_status = 'stopped';
          p.app_pid = null;
          p.memoryBytes = 0;
        } else if (act === 'maintenance') {
          p.app_status = p.app_status === 'maintenance' ? 'running' : 'maintenance';
        }
      }
      return jsonResp({ ok: true, project: p });
    }

    if ((m = path.match(/^\/api\/projects\/(\d+)\/deploy$/)) && method === 'POST') {
      const p = projects.find((x) => x.id === Number(m[1]));
      const dep = startMockDeployment(p || projects[0], body.sha);
      return jsonResp({ ok: true, deploymentId: dep.id, deployment: dep });
    }

    if ((m = path.match(/^\/api\/projects\/(\d+)\/commits$/))) {
      const p = projects.find((x) => x.id === Number(m[1]));
      return jsonResp([
        { sha: p?.deployed_sha || 'a15d04e91f8c30b4a2', shortSha: (p?.deployed_sha || 'a15d04e').slice(0, 7), message: 'feat(webhooks): verify stripe ed25519 signature header', author: 'just-nixx', date: new Date(Date.now() - 900000).toISOString(), live: true },
        { sha: '94c0b2189fe01a239c', shortSha: '94c0b21', message: 'chore(pool): tune pg max_connections=40 & idle timeout', author: 'just-nixx', date: new Date(Date.now() - 10800000).toISOString(), deployedBefore: true },
        { sha: '702f8d411c9e04122a', shortSha: '702f8d4', message: 'fix(caddy): preserve X-Forwarded-Proto behind Cloudflare', author: 'just-nixx', date: new Date(Date.now() - 86400000).toISOString(), deployedBefore: true },
      ]);
    }

    if ((m = path.match(/^\/api\/projects\/(\d+)\/releases$/))) {
      const pid = Number(m[1]);
      if (method === 'POST') {
        const rel = {
          id: ++nextId,
          project_id: pid,
          sha: Math.random().toString(16).slice(2, 18),
          short_sha: Math.random().toString(16).slice(2, 9),
          message: body.note || 'Manual panel release snapshot',
          author: 'admin',
          status: 'succeeded',
          build_status: 'success',
          health_status: 'ok',
          live: false,
          available: true,
          created_at: new Date().toISOString(),
        };
        releases.unshift(rel);
        return jsonResp(rel);
      }
      return jsonResp(releases);
    }

    if ((m = path.match(/^\/api\/projects\/(\d+)\/rollback$/))) {
      return jsonResp({ ok: true });
    }

    if ((m = path.match(/^\/api\/projects\/(\d+)\/env$/))) {
      const pid = Number(m[1]);
      if (!envByProject[pid]) envByProject[pid] = [...envByProject[1]];
      if (method === 'POST' || method === 'PUT') {
        const idx = envByProject[pid].findIndex((v) => v.key === body.key);
        const row = { key: body.key, value: body.is_secret ? '********' : body.value, real_value: body.value, is_secret: Boolean(body.is_secret) };
        if (idx >= 0) envByProject[pid][idx] = row;
        else envByProject[pid].push(row);
        return jsonResp(row);
      }
      return jsonResp(envByProject[pid]);
    }
    if ((m = path.match(/^\/api\/projects\/(\d+)\/env\/raw$/))) {
      const pid = Number(m[1]);
      const vars = envByProject[pid] || envByProject[1];
      if (method === 'PUT') {
        return jsonResp({ ok: true, count: vars.length });
      }
      return jsonResp({ content: vars.map((v) => `${v.key}=${v.real_value || v.value}`).join('\n') });
    }
    if ((m = path.match(/^\/api\/projects\/(\d+)\/env\/bulk$/))) {
      const pid = Number(m[1]);
      if (Array.isArray(body.vars)) {
        envByProject[pid] = body.vars.map((v) => ({
          key: v.key,
          value: v.is_secret ? '********' : v.value,
          real_value: v.value,
          is_secret: Boolean(v.is_secret),
        }));
      }
      return jsonResp({ ok: true });
    }
    if ((m = path.match(/^\/api\/projects\/(\d+)\/env\/.+$/)) && method === 'DELETE') {
      return jsonResp({ ok: true });
    }

    if ((m = path.match(/^\/api\/(projects|databases)\/(\d+)\/files$/))) {
      const subPath = u.searchParams.get('path') || '';
      return jsonResp({ path: subPath, entries: filesTree[subPath] || [] });
    }
    if ((m = path.match(/^\/api\/(projects|databases)\/(\d+)\/files\/content$/))) {
      const filePath = u.searchParams.get('path') || body.path || 'src/server.ts';
      if (method === 'PUT' || method === 'POST') {
        fileContents[filePath] = body.content || '';
        return jsonResp({ ok: true });
      }
      return jsonResp({ path: filePath, content: fileContents[filePath] ?? '// File preview\n' });
    }
    if ((m = path.match(/^\/api\/projects\/(\d+)\/caddy$/))) {
      const p = projects.find((x) => x.id === Number(m[1]));
      return jsonResp({ domains: p?.domains || [], autoTls: true, caddyRunning: true });
    }
    if ((m = path.match(/^\/api\/projects\/(\d+)\/(app-logs|deploy-key|webhook-secret\/rotate|detect)$/))) {
      if (m[2] === 'app-logs') {
        return jsonResp({ lines: ['[16:08:11] [app] Listening cleanly on configured loopback port', '[16:09:41] [http] GET /healthz -> 200 OK (0.4ms)'] });
      }
      if (m[2] === 'deploy-key') {
        return jsonResp({ publicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIWebDepDemoDeployKey2026 webdep@vps' });
      }
      return jsonResp({ ok: true, secret: 'whsec_rotated_' + Math.random().toString(16).slice(2, 12) });
    }

    // Databases
    if (path === '/api/databases' && method === 'GET') {
      return jsonResp(databases);
    }
    if (path === '/api/databases' && method === 'POST') {
      const id = ++nextId;
      const db = {
        id,
        name: body.name || `pg-cluster-${id}`,
        db_name: body.db_name || 'app',
        db_user: body.db_user || 'app_user',
        host: '127.0.0.1',
        port: Number(body.port) || 5434 + id,
        domain: '',
        access_mode: body.access_mode || 'local',
        status: 'running',
        pid: Math.floor(4200 + Math.random() * 500),
        started_at: new Date().toISOString(),
        diskFormatted: '256 KB',
        memoryBytes: 0.9 * 1048576,
        diskBytes: 256 * 1024,
      };
      databases.unshift(db);
      return jsonResp(db);
    }
    if ((m = path.match(/^\/api\/databases\/(\d+)\/(start|stop|restart)$/))) {
      const d = databases.find((x) => x.id === Number(m[1]));
      if (d) {
        d.status = m[2] === 'stop' ? 'stopped' : 'running';
        d.pid = d.status === 'running' ? Math.floor(4100 + Math.random() * 400) : null;
      }
      return jsonResp(d || { ok: true });
    }
    if ((m = path.match(/^\/api\/databases\/(\d+)\/usage$/))) {
      const d = databases.find((x) => x.id === Number(m[1]));
      const running = d?.status === 'running';
      return jsonResp({
        running,
        port: d?.port || 5432,
        cpu: { pct: 0.0, cores: 10 },
        ram: { bytes: running ? 940000 : 0, percentOfHost: 0.01, formatted: running ? '< 1 MB' : '0 B', hostTotalFormatted: '15.7 GB' },
        disk: { bytes: d?.diskBytes || 463 * 1024, percentOfVps: 0.01, formatted: d?.diskFormatted || '463 KB', vpsFreeFormatted: '91.6 GB' },
        network: { inboundBps: running ? 4200 : 0, outboundBps: running ? 9100 : 0, interfaceCount: 1, totalRxBytes: 42 * 1048576, totalTxBytes: 86 * 1048576, history: netHistory.map((h) => ({ ts: h.ts, inboundBps: 4200, outboundBps: 9100 })) },
      });
    }
    if ((m = path.match(/^\/api\/databases\/(\d+)\/logs$/))) {
      return jsonResp({ lines: ['LOG: database system is ready to accept connections', 'LOG: checkpoint complete: wrote 3 buffers (0.0%)'] });
    }

    // Deployments, Audit, Monitor, Settings, Users, System
    if (path === '/api/deployments') {
      const pid = u.searchParams.get('project');
      return jsonResp(pid ? deployments.filter((d) => d.project_id === Number(pid)) : deployments);
    }
    if ((m = path.match(/^\/api\/deployments\/(\d+)$/))) {
      return jsonResp(deployments.find((d) => d.id === Number(m[1])) || deployments[0]);
    }
    if (path === '/api/audit') {
      return jsonResp(auditLogs);
    }
    if (path === '/api/logs') {
      return jsonResp({
        lines: [
          `[${new Date().toLocaleTimeString()}] [webdep] Process health probe passed`,
          `[${new Date().toLocaleTimeString()}] [http] POST /v1/webhooks/stripe -> 200 OK (2.8ms)`,
          `[${new Date().toLocaleTimeString()}] [http] GET /healthz -> 200 OK (0.4ms)`,
        ],
      });
    }
    if (path === '/api/monitor') {
      return jsonResp({
        system: { hostname: 'vps-prod-01', platform: 'Linux x86_64 (Ubuntu 24.04)', uptime: Math.floor((Date.now() - bootTime) / 1000), cpu: { cores: 10, pct: 15, load: [0.42, 0.38, 0.31] } },
        projects: projects.map((p) => ({
          id: p.id,
          name: p.name,
          status: { running: p.app_status === 'running', appStatus: p.app_status, uptimeMs: p.app_status === 'running' ? 48 * 3600 * 1000 : 0 },
          deployedSha: p.deployed_sha,
          disk: { used: p.diskBytes },
          deployStatus: { status: 'success' },
        })),
      });
    }
    if (path === '/api/nginx/status') {
      return jsonResp({ running: true, installed: true, version: '2.8.4 (Caddy TLS)' });
    }
    if (path === '/api/settings') {
      if (method === 'PUT') {
        if (body.panel_theme) activeTheme = body.panel_theme;
        return jsonResp({ ok: true, panel_theme: activeTheme });
      }
      return jsonResp({
        panel_theme: activeTheme,
        auto_deploy_enabled: true,
        github_tokens: [{ label: 'Primary Account', token: 'ghp_demo_token_••••' }],
      });
    }
    if (path === '/api/users') {
      return jsonResp([
        { id: 1, username: 'admin', isMainAdmin: true, permissions: ['*'], totpEnabled: true, disabled: false, presence: 'online' },
      ]);
    }
    if (path === '/api/system/version') {
      return jsonResp({ version: '3.27.0', current_tag: 'v3.27.0', remote_tag: 'v3.27.0', up_to_date: true });
    }
    if (path === '/api/system/update/status') {
      return jsonResp({ active: false, progress: 100 });
    }
    if (path === '/api/github/repos') {
      return jsonResp([
        { full_name: 'acme-corp/payments-api', default_branch: 'main' },
        { full_name: 'acme-corp/storefront', default_branch: 'main' },
        { full_name: 'acme-corp/docs-site', default_branch: 'main' },
      ]);
    }
    if (path === '/api/cache/clear') {
      return jsonResp({ ok: true });
    }

    return jsonResp({ ok: true });
  };

  // Mock EventSource so live log streaming doesn't hit 404 console errors
  class DemoEventSource {
    constructor(url) {
      this.url = url;
      this.readyState = 1;
      this.listeners = {};
      setTimeout(() => {
        this._emit('message', { data: JSON.stringify({ line: `[${new Date().toLocaleTimeString()}] [stream] Connected to live WebDep demo log tail` }) });
      }, 200);
      this._timer = setInterval(() => {
        if (this.readyState !== 1) return;
        this._emit('message', { data: JSON.stringify({ line: `[${new Date().toLocaleTimeString()}] [http] GET /healthz -> 200 OK (0.${Math.floor(2 + Math.random() * 6)}ms)` }) });
      }, 4500);
    }
    addEventListener(type, fn) {
      if (!this.listeners[type]) this.listeners[type] = [];
      this.listeners[type].push(fn);
    }
    removeEventListener(type, fn) {
      if (this.listeners[type]) this.listeners[type] = this.listeners[type].filter((f) => f !== fn);
    }
    _emit(type, evt) {
      if (type === 'message' && typeof this.onmessage === 'function') this.onmessage(evt);
      (this.listeners[type] || []).forEach((fn) => fn(evt));
    }
    close() {
      this.readyState = 2;
      clearInterval(this._timer);
    }
  }
  window.EventSource = DemoEventSource;

  // Start from the Hello -> Welcome -> Sign In splash screen with demo credentials ready
  function prefillDemoLogin() {
    setTimeout(() => {
      const userInput = document.getElementById('login-username');
      const passInput = document.getElementById('login-password');
      if (userInput && !userInput.value) userInput.value = 'admin';
      if (passInput && !passInput.value) passInput.value = 'admin123';
    }, 0);
  }

  function setupDemoLoginHelpers() {
    const loginView = document.getElementById('login-view');
    if (loginView) {
      if (loginView.style.display === 'flex') prefillDemoLogin();
      const observer = new MutationObserver(() => {
        if (loginView.style.display === 'flex') prefillDemoLogin();
      });
      observer.observe(loginView, { attributes: true, attributeFilter: ['style'] });
    }

    const passkeyBtn = document.getElementById('login-passkey-btn');
    if (passkeyBtn) {
      passkeyBtn.addEventListener(
        'click',
        async (e) => {
          e.preventDefault();
          e.stopImmediatePropagation();
          passkeyBtn.disabled = true;
          try {
            const resp = await fetch('/api/auth/login', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ username: 'admin' }),
            });
            const data = await resp.json();
            if (typeof window.applyAuthSuccess === 'function') {
              await window.applyAuthSuccess(data);
            }
          } finally {
            passkeyBtn.disabled = false;
          }
        },
        true
      );
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', setupDemoLoginHelpers);
  } else {
    setupDemoLoginHelpers();
  }
})();
