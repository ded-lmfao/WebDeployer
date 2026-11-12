# 🚀 WebDep

<p align="center">
  <br>
  <strong>A modern, blazingly fast, self-hosted deployment platform and process orchestrator written in Rust.</strong><br>
  <em>Turn any $4 Linux VPS into your own private Heroku, Railway, or Vercel with zero overhead.</em>
  <br><br>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Rust-2021%20Edition-DEA584?style=for-the-badge&logo=rust&logoColor=black" alt="Rust">
  <img src="https://img.shields.io/badge/Tokio-Asynchronous-8A2BE2?style=for-the-badge&logo=tokio&logoColor=white" alt="Tokio">
  <img src="https://img.shields.io/badge/Axum-0.7-555555?style=for-the-badge" alt="Axum">
  <img src="https://img.shields.io/badge/SQLite-WAL%20Mode-003B57?style=for-the-badge&logo=sqlite&logoColor=white" alt="SQLite">
  <img src="https://img.shields.io/badge/PostgreSQL-Isolated%20Clusters-336791?style=for-the-badge&logo=postgresql&logoColor=white" alt="PostgreSQL">
  <img src="https://img.shields.io/badge/License-MIT-00B289?style=for-the-badge" alt="MIT License">
</p>

---

## 📖 Overview

**WebDep** is a unified, self-contained multi-tenant hosting and deployment system. Compiled into a **single static binary with zero runtime dependencies**, it combines a high-throughput HTTP server, persistent background process supervisor, Git deployment engine, automated Caddy reverse proxy, hardware-accelerated telemetry pipeline, and AES-256-GCM encrypted vault.

Say goodbye to heavy Kubernetes clusters, memory-hungry Docker-in-Docker daemons, and fragile bash scripts. WebDep runs smoothly on minimal **512 MB – 1 GB RAM VPS** nodes while delivering atomic zero-downtime symlink updates, instant rollbacks, and automated HTTPS certificates.

---

## ✨ Key Highlights

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ WebDep Core Architecture                                                    │
├──────────────────────┬──────────────────────┬───────────────────────────────┤
│ 🌐 Hosted Websites   │ 🤖 Backend Services  │ 🐘 Managed PostgreSQL         │
│ • Next.js, Vite, SPA │ • Discord / TG Bots  │ • Zero-Docker native clusters │
│ • Node.js, Python, Go│ • Lavalink servers   │ • Firewall IP allowlisting    │
│ • Auto HTTPS (Caddy) │ • Background daemons │ • 1-click credential sync     │
│ • Atomic symlinks    │ • In-browser editor  │ • Multi-tenant port routing   │
└──────────────────────┴──────────────────────┴───────────────────────────────┘
```

### ⚡ Blazingly Fast & Resource Efficient
- **Single Static Binary**: Compiled with Link-Time Optimization (LTO) and embedded frontend assets (`rust-embed`). Zero external runtime dependencies required.
- **Microscopic Footprint**: Idles at **< 20 MB RAM**, leaving over 95% of your host's memory available for your workloads.
- **Embedded Database**: Integrated SQLite engine running in Write-Ahead Logging (WAL) mode with high-concurrency connection pooling.

### 🔄 Deployment Pipeline & Lifecycle Supervision
- **Git Push & Webhook Automation**: Deploy on `git push` via GitHub webhooks or 1-click manual triggers.
- **Atomic Symlink Switching**: Seamless directory swaps (`releases/<timestamp>` → `current`) guarantee zero downtime.
- **Automated Health Checks & Rollbacks**: Automatically verifies release health post-launch. If a release crashes or fails probing, WebDep rolls back instantly to the prior stable release.
- **FIFO Build Queue Semaphore**: Serializes resource-heavy builds on low-spec hardware to prevent Out-Of-Memory (OOM) kernel kills.

### 🤖 24/7 Backend Services, Bots & Daemons
- **Supervised Process Manager**: Deploy Discord bots, Telegram bots, queue workers, and audio daemons (Lavalink) with continuous heartbeat monitoring and auto-restart on exit.
- **Dual Source Support**: Deploy directly from Git repositories or upload stand-alone scripts using **Manual Files mode**.
- **In-Browser File Manager & Editor**: Manage project files, upload assets, and edit configuration files directly in your browser with real-time syntax highlighting.

### 🐘 Managed PostgreSQL Databases
- **Native Process Containers**: Spawns isolated PostgreSQL instances with custom databases, dedicated ports, and secure SCRAM-SHA-256 credentials without the RAM overhead of Docker.
- **Granular Network Firewalls**:
  - 🔒 **Localhost Only (`127.0.0.1`)**: Restrict databases exclusively to local workloads.
  - 🛡️ **Remote IP Allowlist (`CIDR`)**: Securely allow remote access from developer machines or external services with kernel-level packet filtering.
  - 🌐 **Public Access (`0.0.0.0`)**: Open access for distributed architectures.
- **1-Click Credential Injection**: Automatically sync `DATABASE_URL` and connection strings into your hosted websites' encrypted vaults.

### 🛡️ Enterprise Security & Observability
- **FIDO2 / WebAuthn Passkeys**: Passwordless biometric sign-in (Touch ID, Face ID, Windows Hello, YubiKey).
- **Two-Factor Authentication (TOTP)**: RFC 6238 time-based authenticator support with emergency recovery codes.
- **Encrypted Vault**: Environment variables and credentials encrypted at rest using **AES-256-GCM**.
- **Live SSE Telemetry**: Sub-millisecond log streaming for builds, application runtime, system events, and audit trails.

---

## 🏗️ System Architecture

```
                       Inbound Internet Traffic
                                  │
                                  ▼
                    ┌───────────────────────────┐
                    │       Caddy Proxy         │  (Port 80 / 443)
                    │  (Auto HTTPS / Let's Enc) │
                    └─────────────┬─────────────┘
                                  │
              ┌───────────────────┴───────────────────┐
              │                                       │
              ▼ (webdep.domain.com)                   ▼ (*.yourdomain.com)
    ┌───────────────────────────┐           ┌───────────────────────────┐
    │     WebDep Platform       │           │   Deployed Applications   │
    │  (Axum + Tokio + SQLite)  │           │  Node.js / Python / Go... │
    │                           │           └─────────────▲─────────────┘
    │  • Passkey Auth Engine    │                         │
    │  • AES-256-GCM Secrets    │                   Atomic Symlink
    │  • FIFO Build Queue       │                  (current -> rel)
    │  • Native Process Manager ├─────────────────────────┘
    └─────────────┬─────────────┘
                  │
                  ▼ (127.0.0.1 / Allowed IPs)
    ┌───────────────────────────┐
    │   PostgreSQL Engine(s)    │
    │ (Isolated Native Sandbox) │
    └───────────────────────────┘
```

---

## 🚀 Quick Start (60 Seconds)

### Option 1: Automated VPS Quickstart

Clone the repository to your Linux server and run the interactive setup script:

```bash
git clone https://github.com/ded-lmfao/WebDeployer.git webdep
cd webdep

# Launch in foreground
./start.sh
```

To install and run as a managed systemd background service:

```bash
sudo ./start.sh --service
```

The script automatically:
1. Detects package managers (`apt`, `dnf`) and installs build essentials if needed.
2. Sets up the Rust compiler toolchain and builds an optimized release binary.
3. Configures firewall rules for HTTP (`80`), HTTPS (`443`), and WebDep's management dashboard.
4. Generates a secure default configuration and displays initial login credentials.

---

### Option 2: Manual Build with Cargo

```bash
# 1. Clone repository
git clone https://github.com/ded-lmfao/WebDeployer.git webdep
cd webdep

# 2. Configure environment
cp .env.example .env
nano .env

# 3. Build optimized release binary
cargo build --release

# 4. Run WebDep
./target/release/webdep
```

Access the WebDep panel in your browser at `http://YOUR_SERVER_IP:4600` (or your configured port).

---

## ⚙️ Configuration Reference

WebDep is configured via environment variables or a `.env` file in the working directory:

| Variable | Default | Description |
| :--- | :--- | :--- |
| `HOST` | `0.0.0.0` | Network interface to bind to (`0.0.0.0` for all interfaces). |
| `PORT` | `4600` | Port for the WebDep web panel and API. |
| `DATA_DIR` | `./data` | Directory for SQLite database, release storage, and vault encryption keys. |
| `ADMIN_USERNAME` | `admin` | Initial administrator username. |
| `ADMIN_PASSWORD` | `admin123` | Initial administrator password (change upon first login!). |
| `ADMIN_RESET_2FA` | `false` | Set to `true` to force-reset admin 2FA if locked out. |
| `SESSION_TTL_S` | `604800` | Session lifetime in seconds (default is 7 days). |
| `RUST_LOG` | `webdep=info` | Logging verbosity filter (`debug`, `info`, `warn`, `error`). |

---

## 📦 Supported Runtimes & Frameworks

WebDep natively supports any application that compiles or executes through shell commands:

| Runtime | Install Command | Start Command | Common Frameworks |
| :--- | :--- | :--- | :--- |
| **Node.js** | `npm ci` / `pnpm install` | `npm start` / `node index.js` | Next.js, Express, Fastify, SvelteKit, Astro |
| **Python** | `pip install -r requirements.txt` | `python -m uvicorn main:app --port {{PORT}}` | FastAPI, Flask, Django, Discord.py |
| **Go** | `go build -o app .` | `./app` | Gin, Echo, Fiber, standard library |
| **Rust** | `cargo build --release` | `./target/release/server` | Axum, Actix-web, Rocket |
| **Static / SPA** | `npm run build` | Built-in Static File Server | React, Vue, Svelte, Vite builds |
| **Java** | Pre-built JAR / Gradle | `java -jar App.jar` | Lavalink, Spring Boot, Quarkus |

> **Port Injection**: Use the `{{PORT}}` placeholder in your start commands or health check URLs. WebDep automatically allocates a unique, non-colliding port for every project and injects `PORT=<assigned>` into the process environment.

---

## 🛠️ Testing & Verification

```bash
# Run unit & integration tests
cargo test

# Validate type safety & syntax without full build
cargo check

# Validate JavaScript syntax
node --check public/app.js
```

---

## 🤝 Contributing

Contributions are welcome! If you want to contribute to WebDep:

1. **Fork the repository** on GitHub.
2. **Create a feature branch**: `git checkout -b feat/my-new-feature`
3. **Commit your changes**: `git commit -m 'feat: add support for custom health probes'`
4. **Push to the branch**: `git push origin feat/my-new-feature`
5. **Open a Pull Request** with a detailed summary of your changes.

---

## 📄 License

This project is licensed under the [MIT License](LICENSE).
