# WebDep — Symbol & File Index

## Key Entity Cross-References

`Project` — `src/projects/models.rs:32`
  used by: `src/projects.rs` L26,48,69,121; `src/api/common.rs` L250,337; `src/api/{projects,caddy}.rs`; `src/caddy.rs` L30,80; `src/deployer{,/worker}.rs`; `src/runtime/{container,maintenance,process,tree}.rs`
  DB: `projects` (`src/db.rs:85`, `SELECT_PROJECT_FIELDS` `models.rs:109`, `row_to_project` `L117`)
  frontend: `public/js/state.js` → `websites.js`, `services.js`, `workspace.js`
  Propagation: 1. `src/db.rs:85` → 2. `src/projects/models.rs:32,109,117` → 3. `src/projects.rs:69,121` → 4. `src/api/projects.rs` → 5. `public/js/{websites,services_modal,workspace}.js`

`User` — `src/auth/user.rs:8`
  used by: `src/auth/manager.rs` L310,328,344,377; `src/api/common.rs` L160,169,184,195,274; `src/api/{auth,users}.rs`
  DB: `users` (`src/db.rs:175`) · frontend: `public/js/{auth,settings_users}.js`
  Propagation: 1. `src/db.rs:175` → 2. `src/auth/user.rs:8,27,78` → 3. `src/auth/manager.rs:310-377` → 4. `src/api/{users,auth}.rs` → 5. `public/js/{settings_users,auth}.js`

`ManagedDatabase` — `src/databases.rs:20`
  used by: `src/databases.rs` (`list,get,create,start,stop,update_access,delete,set_linked_project`), `src/api/databases.rs`
  DB: `databases` (`src/db.rs:243`) · frontend: `public/js/{databases,databases_modal}.js`
  Propagation: 1. `src/db.rs:243` → 2. `src/databases.rs:20,45,70` → 3. `src/api/databases.rs` → 4. `public/js/{databases,databases_modal}.js`

`Deployment` & `Release` — `src/deployer.rs:18,37`
  used by: `src/deployer{,/worker}.rs`, `src/api/deployments.rs`, `src/api/system.rs:111`, `src/api/system/overview.rs:137`
  DB: `deployments` (`src/db.rs:145`), `releases` (`src/db.rs:126`) · frontend: `public/js/{deployments,pipeline_engine,releases}.js`
  Propagation: 1. `src/db.rs:126,145` → 2. `src/deployer.rs:18,37,71` → 3. `src/deployer/worker.rs` → 4. `src/api/deployments.rs` → 5. `public/js/{deployments,pipeline_engine,releases}.js`

`AppState` — `src/api/common.rs:25`
  used by: `src/main.rs:178`, `src/api/mod.rs:34`, all `src/api/*` handlers
  Propagation: 1. `src/api/common.rs:25` → 2. `src/main.rs:62-190` → 3. `src/api/*.rs`

`Runtime` (`src/runtime/mod.rs:20`), `Vault` (`src/vault.rs:11`), `Caddy` (`src/caddy.rs:8`) — core services wired via `AppState`.

## Layer File Map
- **Core/Config**: `src/main.rs` (`main` L40); `src/config.rs` (`Config` L28, `read_dotenv_admin` L95, `sync_dotenv_admin` L134, `from_env` L189); `src/db.rs` (`DbPool` L6, `now` L14, `open_db` L21, `prune_old_logs` L56, `purge_orphaned_project_data` L318, `allocate_global_unique_port` L353); `src/vault.rs` (`Vault` L11, `encrypt` L39, `decrypt` L56); `src/cache.rs` (`AppCache` L23); `src/static_assets.rs` (`Assets` L13, `static_handler` L163).
- **Auth (`src/auth/`)**: `manager.rs` (`Auth` L21, `check_lockout` L124, `create_mfa_challenge` L169, `verify_user_2fa` L192, `ensure_admin` L246, `create_session` L354, `get_session` L377, `prune_in_memory` L480); `user.rs` (`User` L8, `has_power` L90, `can_access_project` L104); `session.rs` (`Session` L4); `password.rs` (`hash_password` L7, `verify_password` L16, `constant_time_eq` L32); `passkey.rs` (`register_passkey` L127, `verify_passkey_login` L226); `totp.rs` (`sync_real_utc_offset` L263, `verify_totp_code` L282); `crypto_p256.rs` (`extract_p256_pubkey` L35, `verify_p256_ecdsa` L470).
- **Services**: `src/projects.rs` (`Projects` L11, `create` L69, `update` L121, `delete` L169, `get_env_map` L288); `src/projects/models.rs` (`Project` L32, `parse_dotenv` L155); `src/deployer.rs` (`Deployer` L56, `create_deployment` L247, `update_stage` L295); `src/deployer/builder.rs` (`switch_current` L27, `run_shell_cmd` L77); `src/deployer/worker.rs` (`run_deploy` L12, `run_rollback` L293); `src/runtime/mod.rs` (`Runtime` L20, `bump_stop_seq` L54); `src/runtime/{container.rs:43,port.rs:46,process.rs:13,tree.rs:123,maintenance.rs:316,supervisor.rs:11}`; `src/caddy.rs` (`Caddy` L8, `generate_config` L30, `reload` L148); `src/git.rs` (`Git` L20, `clone_or_fetch` L315, `checkout` L407); `src/logs.rs` (`Logs` L20, `subscribe` L36, `add` L40); `src/monitor.rs` (`Monitor` L56, `start_background_sampler` L177); `src/databases.rs` (`Databases` L79, `create` L218); `src/databases/{binaries.rs:14,security.rs:26}`; `src/updater.rs` (`Updater` L56, `start_update` L264).
- **Handlers (`src/api/`)**: `mod.rs` (`create_router` L34); `common.rs` (`security_middleware` L40, `verify_main_admin` L184, `verify_power` L195, `get_authorized_project` L245); `auth.rs` (`login_handler` L23, `verify_2fa_login_handler` L102, `passkey_login_finish_handler` L676); `projects.rs` (`create_project_handler` L91, `start_project_handler` L390); `projects/{env.rs:11,git_ops.rs:24,backups.rs:118}`; `deployments.rs` (`deploy_project_handler` L16, `rollback_project_handler` L65); `files.rs` (`files_list_handler` L151, `files_write_handler` L227, `files_upload_handler` L315); `caddy.rs` (`apply_caddy_handler` L42, `github_repos_handler` L132); `logs.rs` (`logs_sse_handler` L74, `audit_handler` L201); `databases.rs` (`create_database_handler` L95, `link_database_handler` L230); `system.rs` (`github_webhook_handler` L48); `system/{overview.rs:162,settings.rs:45}`; `users.rs` (`create_user_handler` L77).
- **Frontend (`public/`)**: `app.js` (`pollTick` L30, `startPolling` L74); `js/api.js` (`networkFetch` L9, `api` L68, `prefetchWebsiteWorkspace` L126); `js/state.js` (TTLs L231-240, exports L536); `js/auth.js` (`initAuth` L148, `hasPower` L247, `onAuthenticated` L258); `js/{auth_passkeys,qrcode,websites,services,services_modal,workspace,workspace_actions,deployments,pipeline_engine,releases,env_vars,files,files_editor,logs,overview,databases,databases_modal,settings,settings_caddy,settings_users,icons}.js`.

## Entry Point Chains
- `POST /api/auth/login` → `src/api/auth.rs:23` → `security_middleware (bypass)` → `Auth::verify_password/create_session` → `users`, `sessions`
- `POST /api/projects/:id/deploy` → `src/api/deployments.rs:16` → `get_authorized_project("deploy")` → `Deployer::run_deploy` (`worker.rs:12`) → `deployments`, `releases`, `projects`, `logs`
- `POST /api/webhooks/github/:slug` → `src/api/system.rs:48` → `hmac_sha256_hex` (`L17`) → `Deployer::run_deploy` → `projects`, `deployments`, `releases`
- `POST /api/projects/:id/start` → `src/api/projects.rs:390` → `get_authorized_project("process")` → `Runtime::start_project` (`process.rs:13`) + `Projects::get_env_map` → `projects`, `logs`
- `GET /api/logs/stream` → `src/api/logs.rs:74` → `verify_power("logs")` → `Logs::list` + `Logs::subscribe` → `logs`, broadcast
- `POST /api/databases` → `src/api/databases.rs:95` → `verify_power("databases_manage")` → `Databases::create` + `allocate_global_unique_port` + `PgBinaries` → `databases`, `logs`
- `POST /api/databases/:id/link` → `src/api/databases.rs:230` → `verify_power("env")` → `Databases::set_linked_project` + `Projects::set_env_var` → `databases`, `project_env`
- `PUT /api/projects/:id/files/content` → `src/api/files.rs:227` → `get_authorized_project("files_write")` → canonical root check + file write
