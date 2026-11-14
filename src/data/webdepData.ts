export interface TelemetryMetric {
  id: string;
  label: string;
  value: string;
  detail: string;
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

export interface FaqEntry {
  id: string;
  question: string;
  answer: string;
}

export const GITHUB_REPO_URL = "https://github.com/ded-lmfao/WebDep";
export const GITHUB_RELEASES_URL =
  "https://github.com/ded-lmfao/WebDep/releases";

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
    id: "webdep-daemon",
    label: "WebDep (daemon)",
    stack: "Static Rust binary + SQLite WAL + RustEmbed UI",
    mb: 20,
    displayValue: "~20 MB",
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
    id: "daemon-rss",
    label: "Daemon RAM footprint",
    value: "~20 MB",
    detail: "Axum + SQLite WAL + UI",
  },
  {
    id: "deploy-stages",
    label: "Deploy pipeline",
    value: "7 stages",
    detail: "Queued FIFO via live SSE",
  },
  {
    id: "targets",
    label: "Target platforms",
    value: "x86_64 · arm64",
    detail: "Linux musl & Windows",
  },
  {
    id: "themes",
    label: "Embedded UI themes",
    value: "10 presets",
    detail: "8 dark · 2 light palettes",
  },
];

export const CAPABILITIES: CapabilityItem[] = [
  {
    id: "websites",
    title: "Websites & Auto Caddy TLS",
    eyebrow: "Reverse proxy",
    summary:
      "Deploy Node.js, Python, Go, Rust, or static apps with zero-conflict port allocation and managed Caddy HTTPS.",
    specs: [
      "7-stage FIFO build pipeline with rollback snapshots",
      "Auto Caddyfile sync & HMAC-SHA256 GitHub webhooks",
    ],
    iconName: "globe",
  },
  {
    id: "services",
    title: "24/7 Background Workers",
    eyebrow: "Process supervisor",
    summary:
      "Supervise Discord/Telegram bots, Lavalink Java servers, and queue daemons natively as OS processes.",
    specs: [
      "Auto-resumes running workloads across restarts",
      "Live PID CPU%/RSS tracking & log streaming",
    ],
    iconName: "cpu",
  },
  {
    id: "databases",
    title: "Isolated PostgreSQL Clusters",
    eyebrow: "pg_ctl + firewall",
    summary:
      "Launch standalone PostgreSQL instances with SCRAM-SHA-256 auth and automatic pg_hba.conf firewall rules.",
    specs: [
      "Localhost, IP/CIDR allowlist, or public network modes",
      "1-click DATABASE_URL injection & live Postgres logs",
    ],
    iconName: "database",
  },
  {
    id: "security",
    title: "Passkeys & Encrypted Secrets",
    eyebrow: "Security",
    summary:
      "Protect the panel with WebAuthn Passkeys, RFC 6238 TOTP 2FA, Argon2 passwords, and AES-256-GCM secrets.",
    specs: [
      "HttpOnly SameSite sessions + X-CSRF-Token checks",
      "Encrypted .env vault & Git tokens inside SQLite",
    ],
    iconName: "shield",
  },
  {
    id: "workspace",
    title: "File Explorer & Code Editor",
    eyebrow: "Workspace",
    summary:
      "Browse, upload, create, rename, edit, and download release files locked inside each canonical root.",
    specs: [
      "Syntax-highlighted editor with dirty-state save",
      "500 MB uploads & symlink-escape protection",
    ],
    iconName: "folder",
  },
  {
    id: "telemetry",
    title: "Telemetry, RBAC & Updates",
    eyebrow: "Operations",
    summary:
      "Real-time host CPU/RAM/disk/network charts, scoped user permissions, and SHA-256 verified self-updates.",
    specs: [
      "~20 MB daemon RAM preserves VPS headroom",
      "GitHub Release binary swap with .old rollback",
    ],
    iconName: "activity",
  },
];

export const PANEL_SCREENS: PanelScreen[] = [
  {
    id: "overview",
    title: "Overview Telemetry",
    subtitle:
      "Monitor panel overhead, total host CPU/RAM/disk/network throughput, and per-workload CPU, memory, PID, port, and disk utilization.",
    image: "./images/overview.png",
    highlights: [
      "Real-time network curve & host CPU/RAM/disk cards",
      "Per-workload RSS memory, CPU%, PID, port, and disk view",
      "Quick filter tabs across Websites, Services, and Databases",
    ],
  },
  {
    id: "websites",
    title: "Hosted Websites",
    subtitle:
      "Manage multi-framework web apps with automatic port allocation, custom domains, automated HTTPS via Caddy, and maintenance mode.",
    image: "./images/websites.png",
    highlights: [
      "Zero-conflict port allocation with {{PORT}} injection",
      "Automated Caddyfile generation & one-click lifecycle actions",
      "Maintenance page mode without tearing down config",
    ],
  },
  {
    id: "services",
    title: "Backend Services",
    subtitle:
      "Run supervised 24/7 background daemons, Lavalink audio servers, and Node.js or Python bots via Git repos or manual file uploads.",
    image: "./images/services.png",
    highlights: [
      "Built-in presets for Lavalink, Discord/Telegram bots, and workers",
      "Git merge deploys preserve untracked .env and local data",
      "Live PID tracking, start/stop controls, and stdout/stderr logs",
    ],
  },
  {
    id: "databases",
    title: "Managed PostgreSQL",
    subtitle:
      "Spin up isolated native pg_ctl clusters with SCRAM-SHA-256 auth, local / CIDR allowlist / public rules, and 1-click app linking.",
    image: "./images/databases.png",
    highlights: [
      "Isolated pg_ctl clusters per database instance",
      "Automated pg_hba.conf & UFW/netsh firewall synchronization",
      "1-click DATABASE_URL injection into linked websites",
    ],
  },
  {
    id: "workspace",
    title: "Pipeline & Project Workspace",
    subtitle:
      "Track Pending to Health Checking deployments, inspect commits, view per-app CPU/RAM/network charts, edit .env secrets, and roll back.",
    image: "./images/workspace.png",
    highlights: [
      "Live 7-stage pipeline progress & full release history",
      "Instant atomic symlink/junction rollback to prior releases",
      "Per-app AES-256-GCM encrypted .env variable editor",
    ],
  },
  {
    id: "files",
    title: "File Explorer & Code Editor",
    subtitle:
      "Upload, browse, create, rename, edit with syntax highlighting, and download release files contained within each project root.",
    image: "./images/files.png",
    highlights: [
      "Drag-and-drop file uploads up to 500 MB per transfer",
      "In-browser code editor with syntax highlighting & line numbers",
      "Canonical path validation preventing symlink traversal",
    ],
  },
  {
    id: "settings",
    title: "Settings, RBAC & Updates",
    subtitle:
      "Configure WebAuthn Passkeys, TOTP 2FA, GitHub tokens, SHA-256 verified release updates, 10 themes, and scoped team permissions.",
    image: "./images/settings.png",
    highlights: [
      "WebAuthn Passkeys, TOTP 2FA & active session management",
      "Per-user RBAC powers with Online/Idle/Offline presence",
      "In-panel GitHub Release update with SHA-256 checksum verification",
    ],
  },
  {
    id: "login",
    title: "Authentication & Passkeys",
    subtitle:
      "Strict pre-auth login gate supporting Argon2 password verification, rate-limited lockouts, TOTP two-factor challenges, and Passkeys.",
    image: "./images/login.png",
    highlights: [
      "Hardware & platform WebAuthn Passkey authentication",
      "RFC 6238 TOTP two-factor challenge with recovery codes",
      "Argon2 password hashing with rate-limited lockouts",
    ],
  },
];

export const PROS_ITEMS = [
  {
    title: "Minimal daemon footprint (~20 MB RAM)",
    detail:
      "Compiled Rust binary with tuned allocator settings leaves nearly all VPS memory free for your workloads",
  },
  {
    title: "Zero Docker daemon overhead",
    detail:
      "Supervises native Linux and Windows OS processes directly without image layers or container daemons",
  },
  {
    title: "Integrated reverse proxy, Postgres & file workspace",
    detail:
      "Generates Caddyfile routes for HTTPS, provisions isolated pg_ctl clusters, and includes an in-browser file editor",
  },
  {
    title: "Hardened auth, RBAC & encrypted vault",
    detail:
      "WebAuthn Passkeys, TOTP 2FA, Argon2 password verification, scoped user powers, and AES-256-GCM SQLite secrets",
  },
];

export const CONS_ITEMS = [
  {
    title: "Single-node VPS architecture",
    detail:
      "Built for single servers; does not cluster or schedule workloads across multiple remote hosts",
  },
  {
    title: "No container app template marketplace",
    detail:
      "Deploys your repositories, services, and PostgreSQL rather than prepackaged Docker Compose SaaS stacks",
  },
  {
    title: "Shared host OS environment",
    detail:
      "Native processes run directly on the host rather than inside Docker container namespaces or cgroup quotas",
  },
  {
    title: "Host runtimes & PostgreSQL-focused",
    detail:
      "Relies on language toolchains installed on the host and focuses managed database automation on PostgreSQL",
  },
];

export const COMPARISON_ROWS: ComparisonRow[] = [
  {
    feature: "Control-Plane Runtime & Footprint",
    category: "architecture",
    webdep: "Single static Rust binary (~20 MB daemon RAM)",
    coolify: "Docker containers + PHP/Laravel (~500 MB–1 GB+ RAM)",
    dokku: "Bash/Go plugins + Docker daemon (~200–400 MB+ RAM)",
    pterodactyl: "PHP/Laravel Panel + MariaDB + Redis + Wings (~400–800 MB RAM)",
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
    webdep: "Embedded UI + syntax-highlighted editor + file manager",
    coolify: "Rich web UI + container terminal",
    dokku: "CLI-first via SSH (third-party UI add-ons)",
    pterodactyl: "Game UI + console + SFTP/file manager",
  },
  {
    feature: "Reverse Proxy & TLS",
    category: "operations",
    webdep: "Auto-generated Caddyfile + Caddy reload (auto HTTPS)",
    coolify: "Traefik or Caddy managed proxy",
    dokku: "Nginx proxy + Let's Encrypt plugin",
    pterodactyl: "Manual Nginx/Caddy for panel + SFTP/game ports",
  },
  {
    feature: "Database Provisioning & Firewall",
    category: "security",
    webdep: "Isolated pg_ctl Postgres + pg_hba & UFW/netsh sync",
    coolify: "Containerized Postgres, MySQL, Redis, MongoDB",
    dokku: "Official DB plugins (Postgres, Redis, etc.)",
    pterodactyl: "External MySQL/MariaDB database hosts",
  },
  {
    feature: "Auth & Secrets Encryption",
    category: "security",
    webdep: "Passkeys (WebAuthn), TOTP 2FA, Argon2, AES-256-GCM",
    coolify: "Session auth + 2FA + Laravel team RBAC",
    dokku: "SSH keys / host UNIX permissions",
    pterodactyl: "Laravel auth + 2FA + subuser permissions",
  },
  {
    feature: "Best-Fit Use Case",
    category: "operations",
    webdep: "Small VPS, native websites, bots, services & Postgres",
    coolify: "Self-hosted cloud, multi-server Compose apps & templates",
    dokku: "Git-push Heroku workflow for CLI minimalists",
    pterodactyl: "Commercial or community game-server hosting",
  },
];

export const INSTALL_METHODS: InstallMethod[] = [
  {
    id: "linux-prebuilt",
    label: "Linux Quick Install",
    platform: "Ubuntu / Debian / RHEL (x86_64 & arm64)",
    note: "Recommended. Fetches the SHA-256 verified GitHub Release binary, configures UFW/iptables ports, and can install a systemd service.",
    command: `git clone https://github.com/ded-lmfao/WebDep.git webdep
cd webdep
./start.sh

# Or install as a 24/7 systemd service
sudo ./start.sh --service`,
    verify:
      "Verify health locally: curl -i http://127.0.0.1:4600/healthz (returns X-WebDep-Boot & X-WebDep-Version).",
  },
  {
    id: "source-cargo",
    label: "Build From Source",
    platform: "Any Linux / Windows host with Rust",
    note: "Compiles the Rust binary with bundled SQLite and RustEmbed dashboard assets directly from source.",
    command: `git clone https://github.com/ded-lmfao/WebDep.git webdep
cd webdep
cp .env.example .env
cargo build --release --locked
./target/release/webdep`,
    verify:
      "Produces a standalone binary at target/release/webdep; open http://YOUR_SERVER_IP:4600.",
  },
  {
    id: "windows-host",
    label: "Windows Server / Local",
    platform: "Windows 10 / 11 / Server",
    note: "Compiles if needed and starts WebDep natively on Windows with netsh firewall support.",
    command: `git clone https://github.com/ded-lmfao/WebDep.git webdep
cd webdep
.\\start.bat`,
    verify:
      "Also supports PowerShell orchestration via .\\start.ps1; opens http://127.0.0.1:4600.",
  },
];

export const ENV_VARIABLES: EnvVarRow[] = [
  {
    name: "HOST",
    defaultValue: "0.0.0.0",
    description: "Network interface to bind the HTTP control-plane server.",
  },
  {
    name: "PORT",
    defaultValue: "4600",
    description: "TCP port where the WebDep panel and API listen.",
  },
  {
    name: "DATA_DIR",
    defaultValue: "./data",
    description: "Directory holding webdep.sqlite, master.key, Caddy configs, releases, and database clusters.",
  },
  {
    name: "ADMIN_USERNAME",
    defaultValue: "admin",
    description: "Main administrator username (live-reloaded directly from .env).",
  },
  {
    name: "ADMIN_PASSWORD",
    defaultValue: "(auto-generated)",
    description: "20-character bootstrap password generated at first launch (.env written with 0600 permissions on Unix).",
  },
  {
    name: "ADMIN_RESET_2FA",
    defaultValue: "false",
    description: "Temporarily set to true to clear TOTP 2FA on the Main Admin account.",
  },
  {
    name: "SESSION_TTL_S",
    defaultValue: "604800",
    description: "Absolute HttpOnly session cookie lifetime in seconds (7 days default).",
  },
  {
    name: "SESSION_IDLE_TIMEOUT_S",
    defaultValue: "1800",
    description: "Idle inactivity session expiration in seconds (30 minutes default; 0 disables).",
  },
  {
    name: "FORCE_SECURE_COOKIES",
    defaultValue: "false",
    description: "Force Secure session cookies unconditionally (also auto-enabled on HTTPS / X-Forwarded-Proto: https).",
  },
  {
    name: "RUST_LOG",
    defaultValue: "webdep=info",
    description: "Tracing verbosity filter (debug, info, warn, error).",
  },
];

export const SUPPORTED_RUNTIMES: RuntimeRow[] = [
  {
    name: "Node.js / TypeScript",
    detection: "package.json",
    notes: "Next.js, Vite, Express, Fastify, bots, or APIs via npm/pnpm with {{PORT}} injection.",
  },
  {
    name: "Python",
    detection: "requirements.txt",
    notes: "FastAPI, Flask, Django, Uvicorn, Discord/Telegram bots, and background workers.",
  },
  {
    name: "Java",
    detection: ".jar / pom.xml",
    notes: "Lavalink audio servers, Spring Boot services, and JAR workers.",
  },
  {
    name: "Go",
    detection: "go.mod",
    notes: "Compiles native Go web servers and daemons with zero external runtime overhead.",
  },
  {
    name: "Rust",
    detection: "Cargo.toml",
    notes: "Builds Cargo release binaries cleanly and supervises the compiled binary directly.",
  },
  {
    name: "Static / Custom",
    detection: "Custom commands",
    notes: "Runs static bundles or arbitrary shell install, build, and start commands.",
  },
];

export const FAQ_ITEMS: FaqEntry[] = [
  {
    id: "docker-needed",
    question: "Does WebDep require Docker to run websites or databases?",
    answer:
      "No. WebDep supervises websites, background workers, and isolated PostgreSQL (pg_ctl) clusters directly as native OS processes from a single static Rust binary with zero container daemon overhead.",
  },
  {
    id: "custom-domain",
    question: "How does automatic HTTPS and custom domain routing work?",
    answer:
      "WebDep writes per-website and master Caddyfile configs into data/caddy/ with strict token sanitization and reloads Caddy automatically, giving your custom domains managed HTTPS via Let's Encrypt / ZeroSSL.",
  },
  {
    id: "auto-update",
    question: "How do in-panel self-updates work?",
    answer:
      "From Platform Settings (or ./start.sh --update), WebDep downloads the SHA-256 verified static GitHub Release binary, runs a --version check, swaps the executable atomically with .old rollback support, and restarts seamlessly.",
  },
  {
    id: "security-model",
    question: "How are .env secrets, Git tokens, and logins secured?",
    answer:
      "First startup generates a random 20-character bootstrap password rather than using static defaults. Environment variables, GitHub tokens, SSH deploy keys, and TOTP secrets are encrypted at rest via AES-256-GCM (DATA_DIR/master.key). Auth includes Argon2id hashing, WebAuthn Passkeys, TOTP 2FA, HttpOnly/SameSite=Strict/HTTPS-Secure cookies, CSRF validation, CSP + HSTS headers, absolute & idle session expiration, and scrubbed child process environments.",
  },
];
