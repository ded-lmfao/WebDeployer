# WebDep — Dependencies & Wiring

## Rust Module Graph
- **Hubs**:
  - `src/api/common.rs` → imported by all 10 `src/api/*` modules (re-exports `AppState`, services, guards, cache/audit helpers).
  - `src/db.rs` → imported by `main`, `auth/manager`, `databases`, `deployer`, `deployer/worker`, `logs`, `projects`, `runtime/{mod,process}`, `api/common`.
  - `src/projects.rs` (`models`) → imported by `main`, `caddy`, `deployer`, `runtime/{container,maintenance,process,tree}`, `api/common`, `api/projects/env`.
  - `src/logs.rs` & `src/runtime/mod.rs` → imported by `main`, `deployer`, `caddy`/`databases`, `api/common`.
- **Leaves**: `vault.rs`, `cache.rs`, `config.rs`, `monitor.rs`, `updater.rs`, `static_assets.rs`, `auth/{password,session,crypto_p256,totp,user}`, `databases/{binaries,security}`.
- **Quirks**: `src/git.rs` bypasses `crate::db`, reading `WEBDEP_DB`/`NEXUS_DB`/`DATA_DIR` env directly (`L54-60`). `src/caddy.rs` depends on `crate::runtime::Runtime` + `Project`.

## Frontend ES6 Graph (`public/`)
- Entry `public/app.js` imports `icons`, `state`, `api`, `auth`, `overview`, `websites`, `services`, `workspace`, `databases`, `deployments`, `settings`, `files`, `logs`.
- Hubs: `js/state.js` (SWR `clientCache`, TTLs, modals), `js/api.js` (CSRF injection, deduped SWR GET, mutation cache clear), `js/icons.js`. View cross-cycles exist (`auth`↔`websites/settings/workspace`; `websites`↔`workspace/services/deployments`).
- Vendor: `js/files_editor.js:9` imports `../vendor/speed-highlight/index.js`.

## External Services & Binaries
- **GitHub**: `git` CLI (`src/git.rs`, `updater.rs`), `gh auth token`, `curl https://api.github.com/user/repos` (`api/caddy.rs:144`).
- **Proxy**: `caddy` (`validate`/`reload`/`version`).
- **PostgreSQL**: native `initdb`, `pg_ctl`, `psql`, `pg_isready` (`PG_BIN_DIR`/`PATH`); Linux `id`/`runuser`/`chown`/`chmod`/`sudo ufw`.
- **OS/Build**: `sh`/`cmd`, `taskkill`/`kill`, `netstat`/`lsof`, `ssh-keygen`, `cargo`+`systemctl` (`updater.rs`). `auth/totp.rs:263` `sync_real_utc_offset()` (inferred outbound time check, body unread).

## Async/Event Boundaries
- `Logs`: `tokio::sync::broadcast::channel(2048)` → `GET /api/logs/stream` (`BroadcastStream`, filters `channel=="app"` + `project_id`; lagged msgs dropped).
- `Deployer`: `Semaphore(1)` FIFO queue + `tokio::spawn` (`active_projects` deduplicates per project).
- `Runtime`: 2s child `try_wait()` + 6s PID/port supervisor loop; `oneshot` channels for maintenance server shutdown.
