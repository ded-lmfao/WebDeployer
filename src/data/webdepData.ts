export interface TelemetryMetric {
  id: string;
  label: string;
  value: string;
  detail: string;
}

export interface PipelineStage {
  id: string;
  step: number;
  label: string;
  summary: string;
  durationMs: number;
  logs: string[];
}

export interface CapabilityItem {
  id: string;
  title: string;
  eyebrow: string;
  summary: string;
  specs: string[];
  iconName:
    | "globe"
    | "cpu"
    | "database"
    | "shield"
    | "folder"
    | "activity";
}

export interface PanelScreen {
  id: string;
  title: string;
  subtitle: string;
  image: string;
  highlights: string[];
}

export interface ComparisonRow {
  feature: string;
  category: "architecture" | "security" | "operations";
  webdep: string;
  coolify: string;
  dokku: string;
  pterodactyl: string;
}

export interface DecisionRule {
  platform: string;
  fit: string;
  reason: string;
}

export interface InstallMethod {
  id: string;
  label: string;
  platform: string;
  note: string;
  command: string;
  verify: string;
}

export interface EnvVarRow {
  name: string;
  defaultValue: string;
  description: string;
}

export interface RuntimeRow {
  name: string;
  detection: string;
  notes: string;
}

export interface CommitRule {
  pattern: string;
  effect: string;
  example: string;
}

export interface FaqEntry {
  id: string;
  question: string;
  answer: string;
}

export const GITHUB_REPO_URL = "https://github.com/ded-lmfao/WebDep";
export const GITHUB_RELEASES_URL =
  "https://github.com/ded-lmfao/WebDep/releases";
export const SONAR_URL =
  "https://sonarcloud.io/summary/new_code?id=ded-lmfao_WebDeployer";

export interface FootprintBar {
  id: string;
  label: string;
  stack: string;
  mb: number;
  displayValue: string;
  highlight?: boolean;
}

export const RAM_FOOTPRINT_BENCHMARKS: FootprintBar[] = [
  {
    id: "webdep-idle",
    label: "WebDep (idle)",
    stack: "Single Rust binary + SQLite WAL",
    mb: 18.4,
    displayValue: "18.4 MB",
    highlight: true,
  },
  {
    id: "webdep-load",
    label: "WebDep (25 apps)",
    stack: "10 active PIDs + SSE stream",
    mb: 23.7,
    displayValue: "23.7 MB",
    highlight: true,
  },
  {
    id: "dokku",
    label: "Dokku",
    stack: "Bash/Go plugins + Docker daemon",
    mb: 300,
    displayValue: "200–400 MB",
  },
  {
    id: "pterodactyl",
    label: "Pterodactyl",
    stack: "Laravel panel + MariaDB + Redis + Wings",
    mb: 600,
    displayValue: "400–800 MB",
  },
  {
    id: "coolify",
    label: "Coolify",
    stack: "Docker containers + Laravel runtime",
    mb: 750,
    displayValue: "500–1,000 MB",
  },
];

export const TELEMETRY_STRIP: TelemetryMetric[] = [
  {
    id: "idle-rss",
    label: "Idle control-plane RSS",
    value: "~18.4 MB",
    detail: "Single Rust binary, Axum, SQLite WAL, embedded UI",
  },
  {
    id: "peak-rss",
    label: "Peak RSS (25 apps / 10 PIDs)",
    value: "~23.7 MB",
    detail: "Sysinfo telemetry collector + concurrent SSE streams",
  },
  {
    id: "overview-p50",
    label: "/api/overview cold P50",
    value: "~2.0 ms",
    detail: "Measured across 25 projects (down from 116.4 ms)",
  },
  {
    id: "binary-footprint",
    label: "Release binary size",
    value: "~10.0 MB",
    detail: "No Node, Python, or Docker required for the panel",
  },
];

export const PIPELINE_STAGES: PipelineStage[] = [
  {
    id: "pending",
    step: 1,
    label: "Pending",
    summary:
      "Webhook verified (HMAC) or manual deploy queued with branch + commit metadata.",
    durationMs: 400,
    logs: [
      "[00:00.04] deploy#184 queued for billing-api (branch: main)",
      "[00:00.06] lock acquired on workspace /srv/webdep/apps/billing-api",
    ],
  },
  {
    id: "fetching",
    step: 2,
    label: "Fetching",
    summary:
      "Resolves encrypted per-project GitHub/Git PAT via AES-256-GCM or public clone target.",
    durationMs: 650,
    logs: [
      "[00:00.18] decrypting project git token via AES-256-GCM key",
      "[00:00.42] git fetch origin main --depth=1 -> commit 9c4e21a",
    ],
  },
  {
    id: "pulling",
    step: 3,
    label: "Pulling",
    summary:
      "Checks out immutable workspace state and injects decrypted .env secrets securely.",
    durationMs: 600,
    logs: [
      "[00:00.78] checked out tree 9c4e21a cleanly",
      "[00:00.84] injected 14 encrypted env secrets (0 written to logs)",
    ],
  },
  {
    id: "installing",
    step: 4,
    label: "Installing",
    summary:
      "Executes configured package manager or detected runtime setup command.",
    durationMs: 850,
    logs: [
      "[00:01.02] detected Node.js + pnpm workspace",
      "[00:01.64] pnpm install --frozen-lockfile completed in 620 ms",
    ],
  },
  {
    id: "building",
    step: 5,
    label: "Building",
    summary:
      "Compiles production bundle or release target and streams live build stdout/stderr over SSE.",
    durationMs: 950,
    logs: [
      "[00:01.70] running build command: pnpm build",
      "[00:02.48] build artifacts emitted cleanly (exit code 0)",
    ],
  },
  {
    id: "deploying",
    step: 6,
    label: "Deploying",
    summary:
      "Assigns dynamic loopback port, spawns native OS process supervisor, and syncs Caddy route.",
    durationMs: 700,
    logs: [
      "[00:02.52] bound upstream 127.0.0.1:4128 via OS process supervisor",
      "[00:02.79] synced Caddy reverse proxy route api.example.com -> 127.0.0.1:4128",
    ],
  },
  {
    id: "health-checking",
    step: 7,
    label: "Health Checking",
    summary:
      "Verifies HTTP/TCP readiness, shifts live traffic, and notifies configured webhooks.",
    durationMs: 550,
    logs: [
      "[00:02.86] probing http://127.0.0.1:4128/healthz -> 200 OK (2.4 ms)",
      "[00:03.05] deploy#184 LIVE (rollback snapshot retained)",
    ],
  },
];

export const CAPABILITIES: CapabilityItem[] = [
  {
    id: "websites",
    title: "Websites & Auto Caddy TLS",
    eyebrow: "Reverse proxy",
    summary:
      "Deploy static bundles, Next.js or Astro SSR servers, Python ASGI/WSGI apps, Go binaries, or custom shells with managed Caddy routes",
    specs: [
      "7-stage pipeline streamed live over Server-Sent Events (SSE)",
      "Per-domain HTTPS TLS and loopback upstream routing via Caddy",
      "GitHub/Git HMAC webhook auto-deploy with branch filtering",
    ],
    iconName: "globe",
  },
  {
    id: "services",
    title: "24/7 Background Workers",
    eyebrow: "Process supervisor",
    summary:
      "Run Discord or Telegram bots, queue consumers, AI agents, cron loops, and long-lived daemons natively without systemd boilerplate",
    specs: [
      "Capped restart backoff and persistent stdout/stderr log buffers",
      "Real-time per-PID CPU% and RSS memory sampled by sysinfo",
      "Start, stop, restart, and clear logs directly from the panel",
    ],
    iconName: "cpu",
  },
  {
    id: "databases",
    title: "Isolated PostgreSQL Clusters",
    eyebrow: "pg_ctl + firewall",
    summary:
      "Provision standalone data-directory PostgreSQL clusters on arbitrary ports while WebDep manages roles, backups, and host firewall rules",
    specs: [
      "3 access modes: Local Only (127.0.0.1), IP/CIDR Allowlist, Public",
      "pg_hba.conf + UFW / iptables / netsh firewall sync",
      "Live pg_dump & psql SQL console with one-click .sql snapshots",
    ],
    iconName: "database",
  },
  {
    id: "security",
    title: "Hardened Auth & Encrypted Secrets",
    eyebrow: "Passkeys + TOTP",
    summary:
      "Protect control-plane operations with hardware passkeys, role-based access, and AES-256-GCM encrypted secret storage",
    specs: [
      "WebAuthn hardware/platform Passkeys + TOTP 2FA authenticator",
      "Argon2id password hashing and AES-256-GCM encrypted secrets",
      "Viewer & Admin RBAC plus IP, session, and audit trails",
    ],
    iconName: "shield",
  },
  {
    id: "workspace",
    title: "Workspace Shell, SFTP & IDE",
    eyebrow: "Browser workspace",
    summary:
      "Open an interactive PTY terminal, manage file trees with drag-and-drop uploads, or edit source files in an embedded Monaco workspace",
    specs: [
      "Embedded Monaco editor across project source trees",
      "Direct archive extraction, permissions, and file previewing",
      "Live PTY host terminal scoped behind admin auth",
    ],
    iconName: "folder",
  },
  {
    id: "telemetry",
    title: "Sub-2 ms Telemetry & Auto-Updates",
    eyebrow: "Low-overhead ops",
    summary:
      "Inspect CPU cores, RAM, disk saturation, and live alerts with minimal polling overhead, plus in-panel GitHub Releases upgrades",
    specs: [
      "~18.4 MB idle RSS leaves VPS memory free for workloads",
      "One-click GitHub Release pull, verify, restart & auto reload",
      "Alert channels for Discord, Slack, Telegram & custom webhooks",
    ],
    iconName: "activity",
  },
];

export const PANEL_SCREENS: PanelScreen[] = [
  {
    id: "overview",
    title: "Overview Telemetry",
    subtitle:
      "Real-time host CPU cores, memory/swap pressure, active PIDs, deployments, and instant service health in ~2.0 ms API cold P50.",
    image: "./images/overview.png",
    highlights: [
      "Live host utilization & process memory tracking",
      "Deployment counts and instant health status overview",
      "Zero external Prometheus/Grafana stack needed",
    ],
  },
  {
    id: "websites",
    title: "Websites & Deploy Pipeline",
    subtitle:
      "Inspect domain routing, SSL status, build commands, webhook secrets, encrypted environment variables, and live SSE deployment logs.",
    image: "./images/websites.png",
    highlights: [
      "Live 7-stage pipeline progress & full rollback history",
      "Custom domain + automatic Caddy upstream synchronization",
      "Per-app AES-256-GCM encrypted env editor",
    ],
  },
  {
    id: "services",
    title: "Background Services",
    subtitle:
      "Supervise bots, workers, and daemons with live stdout/stderr streaming, crash recovery policies, and real-time PID metrics.",
    image: "./images/services.png",
    highlights: [
      "Live WebSocket console tailing without SSH",
      "Capped restart backoff and crash notifications",
      "Start / stop / restart controls per process",
    ],
  },
  {
    id: "databases",
    title: "PostgreSQL Clusters",
    subtitle:
      "Spin up isolated pg_ctl clusters, switch between Local, CIDR Allowlist, and Public firewall policies, run SQL, and snapshot backups.",
    image: "./images/databases.png",
    highlights: [
      "Isolated pg_ctl clusters per database instance",
      "Automated pg_hba.conf + OS firewall synchronization",
      "Built-in SQL console and downloadable pg_dump backups",
    ],
  },
  {
    id: "workspace",
    title: "Workspace & Monaco IDE",
    subtitle:
      "Edit files, inspect configs, and run commands inside your project directory with built-in Monaco syntax highlighting and PTY shell.",
    image: "./images/workspace.png",
    highlights: [
      "In-browser Monaco code editor across workspaces",
      "Interactive PTY shell directly inside the dashboard",
      "Fast config tweaks paired with instant redeploy",
    ],
  },
  {
    id: "files",
    title: "File & Archive Manager",
    subtitle:
      "Browse host and app directories, upload bundles via drag-and-drop, inspect logs, and extract archives cleanly.",
    image: "./images/files.png",
    highlights: [
      "Drag-and-drop browser file uploads and downloads",
      "Directory browsing across project workspaces",
      "Built-in archive handling without external FTP tools",
    ],
  },
  {
    id: "settings",
    title: "Security, RBAC & Updates",
    subtitle:
      "Enroll WebAuthn passkeys, configure TOTP 2FA, manage admin/viewer accounts, alert webhooks, and apply GitHub Releases cleanly.",
    image: "./images/settings.png",
    highlights: [
      "WebAuthn Passkeys + TOTP 2FA + Argon2id hashing",
      "Discord, Slack, Telegram & custom alert channels",
      "In-panel self-update with automatic single-reload sync",
    ],
  },
  {
    id: "login",
    title: "Clean Sign-In Gate",
    subtitle:
      "Focused single-screen login supporting username/password with Argon2id verification, passkey challenges, and 2FA codes.",
    image: "./images/login.png",
    highlights: [
      "Hardware/platform Passkey sign-in support",
      "TOTP two-factor challenge & session audit logs",
      "Zero external auth service dependencies",
    ],
  },
];

export const PROS_ITEMS = [
  {
    title: "Small control-plane footprint (~20 MB RAM)",
    detail:
      "Written in Rust (~18.4 MB idle, ~23.7 MB under 25-project load), preserving RAM on 1 GB–2 GB VPS instances",
  },
  {
    title: "Native processes without Docker overhead",
    detail:
      "Runs native binaries and runtimes directly on Linux or Windows with no container layer tax or image bloat",
  },
  {
    title: "Single binary with embedded UI",
    detail:
      "SQLite (WAL mode) and all dashboard assets compile inside the ~10.0 MB executable — one file to fetch and run",
  },
  {
    title: "Database firewall automation",
    detail:
      "Manages isolated pg_ctl PostgreSQL clusters while keeping pg_hba.conf and OS firewall rules (UFW/iptables/netsh) aligned",
  },
  {
    title: "Built-in workspace (Shell + Monaco + Files)",
    detail:
      "Interactive PTY shell, file manager, and Monaco editor ship out of the box without separate web IDE addons",
  },
  {
    title: "Linux and Windows host support",
    detail:
      "Runs natively on headless Ubuntu/Debian servers and local or dedicated Windows hosts",
  },
];

export const CONS_ITEMS = [
  {
    title: "Single-node only (no Swarm or Kubernetes)",
    detail:
      "Built as a single-node VPS orchestrator; it does not federate across multi-host worker nodes",
  },
  {
    title: "No prebuilt Docker app marketplace",
    detail:
      "Does not bundle 100+ one-click community templates (WordPress, Ghost, Plausible) like container PaaS panels",
  },
  {
    title: "No container rootfs sandboxing",
    detail:
      "Processes share the host filesystem and installed runtimes rather than running inside Docker namespaces or cgroup quotas",
  },
  {
    title: "Requires host language runtimes",
    detail:
      "Node.js, Python, Go, or Rust toolchains must exist on the host machine when building apps directly on the VPS",
  },
  {
    title: "PostgreSQL-first database tooling",
    detail:
      "First-class UI automation targets isolated PostgreSQL clusters; MySQL, Redis, or MongoDB run as separate host services",
  },
  {
    title: "Smaller third-party ecosystem",
    detail:
      "Fewer third-party plugins and guides than multi-year Ruby or PHP panels",
  },
];

export const COMPARISON_ROWS: ComparisonRow[] = [
  {
    feature: "Control-Plane Runtime & Footprint",
    category: "architecture",
    webdep: "Single ~10 MB Rust binary (~20 MB RAM)",
    coolify: "Docker containers + PHP/Laravel (~500 MB-1 GB+ RAM)",
    dokku: "Bash/Go plugins + Docker daemon (~200-400 MB+ RAM)",
    pterodactyl: "PHP/Laravel Panel + MariaDB + Redis + Wings (~400-800 MB RAM)",
  },
  {
    feature: "Workload Isolation Model",
    category: "architecture",
    webdep: "Native OS processes + isolated data dirs",
    coolify: "Docker containers / Docker Compose",
    dokku: "Docker containers (Heroku buildpack / Dockerfile)",
    pterodactyl: "Dedicated game Docker containers (Eggs)",
  },
  {
    feature: "Windows Host Support",
    category: "architecture",
    webdep: "Native Windows & Linux binaries",
    coolify: "Linux only (requires WSL2 on Windows)",
    dokku: "Linux only",
    pterodactyl: "Linux only for Wings daemon",
  },
  {
    feature: "Multi-Server Clustering",
    category: "architecture",
    webdep: "Single-node VPS focused",
    coolify: "Yes — multiple remote Docker servers via SSH",
    dokku: "Single-host core (scheduler plugins needed)",
    pterodactyl: "Yes — Panel manages many Wings nodes",
  },
  {
    feature: "Web UI & Built-In Workspace",
    category: "operations",
    webdep: "Embedded dashboard + Monaco IDE + SFTP + PTY terminal",
    coolify: "Rich web UI + container terminal",
    dokku: "CLI-first via SSH (third-party UI add-ons)",
    pterodactyl: "Game UI + console + SFTP/file manager",
  },
  {
    feature: "Reverse Proxy & TLS",
    category: "operations",
    webdep: "Managed Caddy integration with auto HTTPS",
    coolify: "Traefik or Caddy managed proxy",
    dokku: "Nginx proxy + Let's Encrypt plugin",
    pterodactyl: "Manual Nginx/Caddy for panel + SFTP/game ports",
  },
  {
    feature: "Database Provisioning & Firewall",
    category: "security",
    webdep: "Isolated pg_ctl Postgres + pg_hba & OS firewall sync",
    coolify: "Containerized Postgres, MySQL, Redis, MongoDB",
    dokku: "Official DB plugins (Postgres, Redis, etc.)",
    pterodactyl: "External MySQL/MariaDB database hosts",
  },
  {
    feature: "Auth & Secrets Encryption",
    category: "security",
    webdep: "Passkeys (WebAuthn), TOTP 2FA, Argon2id, AES-256-GCM",
    coolify: "Session auth + 2FA + Laravel team RBAC",
    dokku: "SSH keys / host UNIX permissions",
    pterodactyl: "Laravel auth + 2FA + subuser permissions",
  },
  {
    feature: "Best-Fit Use Case",
    category: "operations",
    webdep: "Small VPS, native websites, bots, agents & Postgres",
    coolify: "Self-hosted cloud, multi-server Compose apps & templates",
    dokku: "Git-push Heroku workflow for CLI minimalists",
    pterodactyl: "Commercial or community game-server hosting",
  },
];

export const DECISION_GUIDE: DecisionRule[] = [
  {
    platform: "Choose WebDep",
    fit: "Low-RAM VPS, Websites, Bots & Native Performance",
    reason:
      "Keep ~98% of a 1 GB-2 GB VPS free for your apps with a single ~10 MB Rust binary, built-in Monaco IDE, and real pg_ctl Postgres.",
  },
  {
    platform: "Choose Coolify",
    fit: "Multi-Server Container Fleets & 1-Click Templates",
    reason:
      "You run larger servers (4 GB+ RAM) and want Docker Compose previews plus dozens of prepackaged SaaS alternatives.",
  },
  {
    platform: "Choose Dokku",
    fit: "Pure CLI Git-Push Minimalism",
    reason:
      "You prefer living in SSH terminals (git push dokku main), do not want a web IDE, and want Heroku-style buildpacks.",
  },
  {
    platform: "Choose Pterodactyl",
    fit: "Game Server Allocation & SFTP Quotas",
    reason:
      "You host Minecraft, Rust, or Steam game servers that need per-user RAM/CPU/disk container limits and Egg installers.",
  },
];

export const INSTALL_METHODS: InstallMethod[] = [
  {
    id: "linux-prebuilt",
    label: "Linux Quick Install",
    platform: "Ubuntu / Debian / RHEL",
    note: "Recommended. Downloads the prebuilt x86_64 release binary, writes defaults to .env, and starts WebDep with live supervisor.",
    command: `git clone https://github.com/ded-lmfao/WebDep.git
cd WebDep
chmod +x start.sh
./start.sh`,
    verify:
      "Verify health locally: curl -i http://127.0.0.1:3000/healthz (includes X-WebDep-Boot token).",
  },
  {
    id: "source-cargo",
    label: "Build From Source",
    platform: "Any Linux / macOS / Windows with Rust",
    note: "Compiles the complete Rust workspace including embedded frontend UI and bundled SQLite engine.",
    command: `git clone https://github.com/ded-lmfao/WebDep.git
cd WebDep
cargo build --release --locked
./target/release/webdep`,
    verify:
      "Produces a standalone binary at target/release/webdep with zero runtime asset folders required.",
  },
  {
    id: "windows-host",
    label: "Windows Server / Local",
    platform: "Windows 10 / 11 / Server",
    note: "Runs natively as a Windows binary with netsh firewall integration and local process supervision.",
    command: `git clone https://github.com/ded-lmfao/WebDep.git
cd WebDep
.\\start.bat`,
    verify:
      "Also supports PowerShell orchestration via .\\start.ps1; visits http://127.0.0.1:3000.",
  },
];

export const ENV_VARIABLES: EnvVarRow[] = [
  {
    name: "PORT",
    defaultValue: "3000",
    description: "TCP port where the WebDep control-plane HTTP server binds.",
  },
  {
    name: "ADMIN_USER",
    defaultValue: "admin",
    description: "Bootstrap administrator account created on first launch.",
  },
  {
    name: "ADMIN_PASS",
    defaultValue: "(generated/custom)",
    description: "Initial administrator password (hashed immediately via Argon2id).",
  },
  {
    name: "JWT_SECRET",
    defaultValue: "(auto-generated)",
    description: "HMAC signing key for HTTP-only dashboard authentication cookies.",
  },
  {
    name: "ENCRYPTION_KEY",
    defaultValue: "(auto-generated)",
    description: "32-byte key protecting .env secrets, TOTP secrets, and Git PATs via AES-256-GCM.",
  },
  {
    name: "APPS_ROOT",
    defaultValue: "./apps",
    description: "Filesystem root storing cloned app repositories and workspaces.",
  },
  {
    name: "DATA_DIR",
    defaultValue: "./data",
    description: "Directory holding the SQLite WAL database, logs, and PostgreSQL cluster data.",
  },
  {
    name: "CADDY_ADMIN_URL",
    defaultValue: "http://127.0.0.1:2019",
    description: "Optional Caddy Admin API endpoint for automated domain + HTTPS routing.",
  },
];

export const SUPPORTED_RUNTIMES: RuntimeRow[] = [
  {
    name: "Node.js / TypeScript",
    detection: "package.json",
    notes: "Supports npm, pnpm, yarn, Next.js, Astro, Express, Fastify, Vite, or React builds.",
  },
  {
    name: "Python",
    detection: "requirements.txt / pyproject.toml",
    notes: "FastAPI, Flask, Django, Uvicorn, Gunicorn, or standalone worker scripts.",
  },
  {
    name: "Rust",
    detection: "Cargo.toml",
    notes: "Compiles release binaries cleanly via Cargo and supervises the executable directly.",
  },
  {
    name: "Go",
    detection: "go.mod",
    notes: "Builds static Go services with zero runtime dependencies.",
  },
  {
    name: "Static / Frontend",
    detection: "index.html / dist/",
    notes: "Served via WebDep's embedded static file handler or Caddy with Gzip compression.",
  },
  {
    name: "Custom Shell",
    detection: "Any start command",
    notes: "Executes arbitrary commands, cron daemons, shell scripts, or custom binaries.",
  },
];

export const CI_COMMIT_RULES: CommitRule[] = [
  {
    pattern: "Default push to main",
    effect: "Runs CI checks + SonarCloud gate, bumps patch release on pass",
    example: "git commit -m 'fix: handle graceful worker shutdown'",
  },
  {
    pattern: "docs:, chore(docs):, [skip release], [docs], [no-release]",
    effect: "Skips release job completely while allowing repository updates",
    example: "git commit -m 'docs: update .env firewall notes [skip release]'",
  },
  {
    pattern: "fix!:, feat!:, [major] / feat:, [minor]",
    effect: "Triggers SemVer major or minor version bump when SonarCloud passes",
    example: "git commit -m 'feat: add passkey challenge endpoint'",
  },
];

export const FAQ_ITEMS: FaqEntry[] = [
  {
    id: "docker-needed",
    question: "Does WebDep require Docker to run websites or databases?",
    answer:
      "No. WebDep runs your websites, background workers, and PostgreSQL clusters as native OS processes supervised directly by its ~10 MB Rust binary. You can still run Docker containers separately if desired, but WebDep imposes zero container daemon overhead.",
  },
  {
    id: "custom-domain",
    question: "How does HTTPS and reverse proxying work without Nginx configs?",
    answer:
      "Point CADDY_ADMIN_URL at Caddy's local admin endpoint (default http://127.0.0.1:2019). Whenever a project deploys onto its assigned loopback port, WebDep syncs the domain route in Caddy so automatic Let's Encrypt TLS works immediately.",
  },
  {
    id: "auto-update",
    question: "What happens when I update WebDep from the Settings panel?",
    answer:
      "WebDep pulls the verified binary from GitHub Releases, replaces the executable cleanly, restarts itself with a fresh random X-WebDep-Boot boot token on /healthz, and instructs your active Settings session to run a single hard reload once the new boot ID responds.",
  },
  {
    id: "ci-sonar",
    question: "How are releases gated in CI/CD?",
    answer:
      "Releases on the main branch run behind a dedicated sonar_gate job in GitHub Actions. If the SonarCloud Quality Gate fails or errors, the release job is blocked. Documentation-only commits matching docs:, [skip release], or [docs] bypass releasing automatically.",
  },
  {
    id: "security-model",
    question: "How are database credentials, Git PATs, and .env secrets stored?",
    answer:
      "All secrets — project environment variables, GitHub/Git personal access tokens, and TOTP secrets — are encrypted at rest inside SQLite using AES-256-GCM before storage. Control-plane passwords use Argon2id, and WebAuthn hardware/platform passkeys are built in.",
  },
];
