# WebDep — Repo Intelligence Index
Schema version: 2
Store status: COMPLETE
Generated: 2026-11-13T15:58:00+05:30
Last incremental update: none
Git HEAD at last analysis: b1e6d14389fe92ff53efe1839914f46f2443c07c
Files analyzed: 98
Index confidence: 13 validated / 13 sampled
Stale risk: LOW
Language(s): Rust 2021, JS (ES6), HTML, CSS, Shell/PS1/Batch
Framework(s): Axum 0.7, Tokio 1, rusqlite 0.32, rust-embed 8.5, sysinfo 0.32, @speed-highlight/core 2.1.0
Repo class: APPLICATION
Type: Web PaaS / Process Orchestrator + Vanilla ES6 SPA
Entry: src/main.rs:40, public/app.js

## Quick Reference
Q: What is entry point and how is app started?
A: `src/main.rs:40` (`main()`), `public/index.html` → `public/app.js`. Run `cargo build --release && ./target/release/webdep` (or `./start.sh`, `start.ps1`, `start.bat`). Check: `cargo test`, `cargo check`, `node --check public/app.js`.

Q: How does auth/authorization work?
A: `nd_session` HttpOnly SameSite=Strict cookie + `X-CSRF-Token` header on mutations. Enforced in `security_middleware` (`src/api/common.rs:40`). Argon2id passwords, 5-fail/10m lockout (`3` for 2FA), RFC 6238 TOTP + backup codes, P-256 WebAuthn passkeys. RBAC (`src/auth/user.rs:90`): `id=1`/`admin` = Main Admin (`*`), sub-users scoped by `allowed_projects` + powers. Fails `401` (no session) / `403` (bad CSRF/missing power).

Q: Where are routes registered and how many?
A: `src/api/mod.rs:34-148`. 69 `.route()` calls across 10 domains + `.fallback(axum_static_fallback)`. Public: `/healthz`, `/api/auth/{login,2fa/verify-login,passkeys/login/start,passkeys/login/finish}`, `/api/webhooks/github/:slug` (HMAC-SHA256).

Q: What is data layer?
A: Embedded SQLite (`rusqlite` 0.32 WAL, `schema_version=3`) at `$DATA_DIR/webdep.sqlite` (`src/db.rs:21-270`). Raw parameterized SQL (`init_schema` auto-creates 14 tables; no migration files). Workload DBs are native PostgreSQL clusters (`src/databases.rs`). `project_env` encrypted AES-256-GCM via `Vault` (`data/master.key`).

Q: How do I add a new endpoint/feature?
A: 1. Add table/col in `src/db.rs:72` + struct/mapper (`src/projects/models.rs` or domain mod). 2. Add method on service struct in `src/<domain>.rs`. 3. Add handler in `src/api/<domain>.rs` with `verify_power`/`get_authorized_project`/`log_audit`. 4. Register `.route()` in `src/api/mod.rs:34`. 5. Call `api(...)` in `public/js/<view>.js`.

Q: How does Git deploy pipeline work?
A: `POST /api/projects/:id/deploy` or webhook → `Deployer::run_deploy` (`src/deployer/worker.rs:12`) acquires `Semaphore(1)` → 7 stages (`pending->fetching->pulling->installing->building->deploying->health_checking`) → swaps `current` link, starts process with decrypted env + `PORT`, runs HTTP/TCP health check.

Q: What env vars are required?
A: None strictly (`Config::from_env` writes `.env` defaults: `HOST=0.0.0.0`, `PORT=4600`, `DATA_DIR=./data`, `ADMIN_USERNAME=admin`, `SESSION_TTL_S=604800`). Set `ADMIN_PASSWORD` in prod; `PG_BIN_DIR` if PG not in `PATH`; `GITHUB_TOKEN` or `gh` auth for private repos.

Q: What happens on 401 or workload crash?
A: `401` clears `clientCache` and calls `showLogin()` (`public/js/api.js:41`). Process exit is detected within 2s (child) / 6s (preserved PID) by `start_background_monitor` (`src/runtime/supervisor.rs:11`), marking `app_status='stopped'`.

## Invariants & Gotchas
- Global build lock: `Deployer::queue_semaphore` (`Semaphore(1)`, `src/deployer.rs:64`) serializes all deploys/rollbacks.
- Stop-sequence fence: `Runtime::bump_stop_seq` (`src/runtime/mod.rs:54`) aborts in-flight deploys if project stopped mid-build.
- Port registry: always use `allocate_global_unique_port()` (`src/db.rs:353`), checking `projects` + `databases` + OS bind (reserves `22,80,443,4600`).
- Cache/CSRF sync: mutating `/api/*` (except `/api/auth/presence`) clears `AppCache` (`src/api/common.rs:94`); non-logout mutations require `X-CSRF-Token`.
- Disk-first assets: `static_handler` (`src/static_assets.rs:186`) serves `./public/` before `rust-embed` fallback; `build.rs` watches top-level `public/` files only.
- Admin `.env` live sync: `Auth::ensure_admin` (`src/auth/manager.rs:246`) overwrites `users` (`id=1`) creds from `.env` and clears TOTP if `ADMIN_RESET_2FA=true`.
- Direct DB env lookup: `src/git.rs:54` reads `WEBDEP_DB`/`NEXUS_DB`/`DATA_DIR` instead of `DbPool`.
- Legacy names: `package.json` uses `nexus-deploy`; cookie is `nd_session`; `/api/nginx/*` aliases Caddy; `audit.ip` hardcodes `'127.0.0.1'` (`src/api/common.rs:410`).
- Vault key: losing `data/master.key` breaks decryption of all `project_env` rows permanently.
- SSE isolation: `/api/logs/stream` (`src/api/logs.rs:110`) emits only `channel=="app"` for requested `project` query param.

## Coverage Gaps / Known Unknowns
- Handler/service/UI bodies unread beyond Tier-1 + headers/grep; inspect target file before editing internals.
- `src/auth/totp.rs:263` `sync_real_utc_offset()` outbound time endpoint `(inferred — body unread)`.
- Skipped: `docs/images/*.png`, `public/vendor/`, `data/`, `saved data/`, `node_modules/`, `target/`.

## Coverage
architecture.md · routes.md · data-model.md · dependencies.md · flows.md · config.md · file-index.md

## Changelog
2026-11-13T15:58:00+05:30: full analysis — 98 files, Rust 2021 (Axum 0.7 + SQLite WAL + Tokio) + Vanilla ES6 SPA
