# 🚀 WebDep

<p align="center">
  <strong>Blazingly fast, lightweight, self-hosted multi-website deployment & hosting platform.</strong><br>
  <em>Turn any Linux VPS into your own private Heroku / Vercel with zero overhead.</em>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Rust-2021%20Edition-orange?logo=rust" alt="Rust 2021">
  <img src="https://img.shields.io/badge/Tokio-Asynchronous-blue?logo=tokio" alt="Tokio">
  <img src="https://img.shields.io/badge/Axum-0.7-blueviolet" alt="Axum">
  <img src="https://img.shields.io/badge/SQLite-WAL%20Mode-003B57?logo=sqlite" alt="SQLite">
  <img src="https://img.shields.io/badge/Reverse%20Proxy-Caddy%20Auto--HTTPS-00ADD8?logo=caddy" alt="Caddy">
  <img src="https://img.shields.io/badge/Security-Argon2id%20%7C%20Passkeys%20%7C%202FA-green" alt="Security">
  <img src="https://img.shields.io/badge/License-MIT-lightgrey" alt="License">
</p>

---

## 📖 Overview

**WebDep** is a unified, self-contained multi-website deployment platform engineered in **Rust**. It combines a high-performance HTTP engine, process supervisor, Git release manager, dynamic reverse proxy manager, encrypted secrets vault, and real-time observability panel into a **single static binary** with **zero runtime dependencies**.

Say goodbye to complex Kubernetes clusters, slow Docker-in-Docker orchestrators, and fragile bash deploy scripts. WebDep gives you instant 1-click deployments, atomic zero-downtime symlink switches, automated rollbacks, and instant HTTPS domains on any 512 MB – 1 GB RAM VPS.

---

## ✨ Key Features

### ⚡ Blazingly Fast & Lightweight Engine
- **Single Static Binary**: Compiled with Link-Time Optimization (LTO), stripped, and embeds all frontend assets (`rust-embed`). Zero external runtime packages required.
- **Microscopic Footprint**: Idles at **< 20 MB RAM**, leaving virtually 100% of your VPS memory for your deployed applications.
- **Embedded Database**: Zero-configuration SQLite running in Write-Ahead Logging (WAL) mode with multi-threaded pooling and in-memory read cache.

### 🔄 Deployment Pipeline & Lifecycle
- **Git Push & Webhook Support**: Deploy directly from GitHub webhooks or with 1-click from the management dashboard.
- **Atomic Symlink Switching**: Fast `releases/<timestamp>` directory switching via atomic symlink swap (`current`), ensuring zero downtime during updates.
- **Automated Health Probing**: Automatically runs health checks against newly started releases. If a release crashes or fails its health probe, WebDep automatically halts deployment and rolls back to the last stable release.
- **Instant 1-Click Rollback**: Revert instantly to any previous release snapshot or configuration without rebuilds.
- **Global FIFO Concurrency Semaphore**: Queue management ensures that builds on small 1 GB RAM VPS instances execute safely one-by-one without OOM spikes.

### 🌐 Automatic Reverse Proxy & HTTPS
- **Integrated Caddy Engine**: Auto-generates Caddyfile configurations with automated reload triggers.
- **Zero-Touch SSL/TLS**: Automatic ACME certificate provisioning (Let's Encrypt / ZeroSSL) for custom domains and subdomains.
- **Multi-Domain Routing**: Map multiple hostnames, apex domains, and wildcard routes to individual websites with automatic port isolation.

### 🛡️ Enterprise-Grade Security
- **Modern Authentication**:
  - Argon2id password hashing with custom work factors.
  - **FIDO2 / WebAuthn Passkeys**: Passwordless biometric sign-in (Touch ID, Face ID, Windows Hello, YubiKey).
  - **RFC 6238 TOTP 2FA**: Two-factor authenticator app support with emergency recovery codes.
- **Encrypted Secrets Vault**: Environment variables and keys are encrypted at rest using authenticated **AES-256-GCM**.
- **Granular RBAC**: Assign granular powers (`deploy`, `env`, `domains`, `process`, `terminal`, `logs`, `users`) with strict website-level isolation.
- **Tamper-Evident Audit Logging**: Every deployment, credential change, environment update, and lifecycle action is immutably logged with actor, timestamp, and IP address.

### 📊 Real-Time Observability & Monitoring
- **Live SSE Log Streaming**: Real-time server-sent events stream build, application, system, and webhooks logs with sub-millisecond latency.
- **System Metrics**: Live CPU utilization, physical memory breakdown, storage capacity, and process monitoring.
- **Prometheus Metric Exporter**: Built-in `/metrics` endpoint ready to scrape by Prometheus, Grafana, or Datadog.

---

## 🏗️ Architecture

```
                       Internet / Browser Traffic
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
    │  • Auth & Passkey Engine  │                         │
    │  • AES-256-GCM Vault      │                   Atomic Symlink
    │  • Git / FIFO Deployer    │                  (current -> rel)
    │  • Process Supervisor     ├─────────────────────────┘
    └───────────────────────────┘
```

---

## 🚀 Quick Start (60 Seconds)

### Option 1: Automated VPS Quickstart Script

Clone the repository to your Linux server and run the all-in-one setup script:

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
1. Detects your OS package manager (`apt-get`, `dnf`) and installs build essentials if needed.
2. Installs the Rust toolchain and builds an optimized release binary.
3. Automatically sets up UFW and iptables firewall rules for ports `80`, `443`, and WebDep's dashboard port.
4. Generates a default `.env` configuration file.
5. Prints your public dashboard access credentials.

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

# 4. Start WebDep
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
| `ADMIN_USERNAME` | `admin` | Initial Main Admin username. |
| `ADMIN_PASSWORD` | `admin123` | Initial Main Admin password (change upon first login!). |
| `ADMIN_RESET_2FA` | `false` | Set to `true` to force reset Main Admin 2FA if locked out. |
| `SESSION_TTL_S` | `604800` | Session lifetime in seconds (default is 7 days). |
| `RUST_LOG` | `webdep=info` | Logging verbosity filter (`debug`, `info`, `warn`, `error`). |

---

## 📦 Supported Application Runtimes

WebDep natively supports any project that can be built or executed via shell commands:

| Runtime | Install Command | Start Command | Notes |
| :--- | :--- | :--- | :--- |
| **Node.js** | `npm ci` / `pnpm install` | `npm start` / `node index.js` | Supports Express, Next.js (standalone), Fastify, Vite |
| **Python** | `pip install -r requirements.txt` | `python -m uvicorn main:app --port {{PORT}}` | FastAPI, Flask, Django, Starlette |
| **Go** | `go build -o app .` | `./app` | Fast compiled binaries |
| **Rust** | `cargo build --release` | `./target/release/server` | Native high-performance microservices |
| **Static** | `npm run build` | Built-in Static File Server | SPAs (React, Vue, Svelte, Vite preview) |
| **PHP / Ruby** | `composer install` / `bundle install` | `php -S 0.0.0.0:{{PORT}}` | Scripted web backends |
| **Generic Shell** | Custom build commands | Custom execution script | Any process that binds to an allocated port |

> **Port Injection**: Use the `{{PORT}}` placeholder in your start commands or health check URLs. WebDep automatically allocates a unique, non-colliding port for every website and passes `PORT=<assigned>` in the process environment.

---

## 🔒 Security & Best Practices

- **Vault Key Encryption**: On initial startup, WebDep creates an isolated 256-bit AES master key in `data/vault.key` with restricted `0600` POSIX file permissions. Never share or commit this key to public source control.
- **Reverse Proxy**: We recommend placing WebDep behind Caddy or Cloudflare for public production traffic with TLS enabled.
- **Passkeys & 2FA**: Enable Passkeys and Authenticator App (TOTP) under **Settings → Security** for hardware-backed, phishing-resistant administrator access.

---

## 🛠️ Testing & Quality Assurance

WebDep maintains high code quality and test coverage across Rust modules and the frontend client:

```bash
# Run unit & integration tests
cargo test

# Validate type safety & syntax without building
cargo check

# Validate JavaScript syntax
node --check public/app.js
```

---

## 📄 License

This project is licensed under the [MIT License](LICENSE).

