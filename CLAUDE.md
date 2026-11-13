# WebDep — CLAUDE.md

## Repo Intelligence
Single-binary Rust PaaS, Git deployer, process supervisor, native PostgreSQL cluster manager, and embedded Vanilla ES6 SPA (`Cargo.toml` `webdep` v2.0.0; `package.json` legacy name `nexus-deploy`). Full graph in `.claude/repo-knowledge/`.

- **Entry & Run**: `src/main.rs:40` (`main()`) + `public/app.js`. Run: `cargo build --release` / `cargo run --release` / `./start.sh` (`start.ps1` / `start.bat`). Check: `cargo test`, `cargo check`, `node --check public/app.js`.
- **Stack**: Axum 0.7 + Tokio (`worker_threads=2`) + SQLite WAL (`rusqlite` 0.32, `schema_version=3` in `src/db.rs`) + Argon2id / P-256 WebAuthn / RFC 6238 TOTP (`src/auth/`) + AES-256-GCM vault (`src/vault.rs`, `data/master.key`) + `sysinfo` + `rust-embed` (`public/`).
- **Routes & Auth**: `src/api/mod.rs:34` (69 routes + static fallback). `security_middleware` (`src/api/common.rs:40`) checks `nd_session` cookie + `X-CSRF-Token` on all mutating `/api/*` except `/api/auth/{login,2fa/verify-login,passkeys/login/*}`, `/api/webhooks/github/:slug` (HMAC-SHA256), `/api/auth/logout` (CSRF-exempt). RBAC via `User::has_power` (`src/auth/user.rs:90`).
- **Core Invariants**:
  - `Deployer::queue_semaphore` (`Semaphore(1)`, `src/deployer.rs:64`) serializes all deploys/rollbacks globally.
  - `Runtime::bump_stop_seq` (`src/runtime/mod.rs:54`) cancels in-flight deploys if project stopped mid-build.
  - `allocate_global_unique_port()` (`src/db.rs:353`) owns port assignment across `projects` + `databases` (reserves `22, 80, 443, 4600`).
  - `static_handler` (`src/static_assets.rs:186`) serves `./public/` disk-first before `rust-embed` fallback; `build.rs` watches top-level `public/` files.
  - `.env` live-syncs Main Admin (`id=1`) username/password/2FA-reset via `Auth::ensure_admin` (`src/auth/manager.rs:246`).
  - Never commit `.env`, `data/master.key`, or `data/webdep.sqlite`.

