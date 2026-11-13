# WebDep — Data Model (`src/db.rs:72-270`, SQLite WAL, `schema_version=3`)
Schema auto-created in `init_schema()` + `purge_orphaned_project_data()`. No migration files.

## Tables
- `_meta(key PK, value)` — `schema_version='3'`.
- `settings(key PK, value)` — `min_free_mb=500`, `default_retention=10`, `step_timeout_s=900`, `deploy_timeout_s=1800`, `github_token`, `github_tokens` JSON.
- `projects(id PK, name, slug UNIQUE, repo_url, branch, project_type, deploy_method, deploy_dir, port, install_cmd, build_cmd, start_cmd, health_url, health_timeout_s, stability_s, auto_deploy, webhook_secret, current_release_id, deployed_sha, last_poll_at, app_status, app_pid, app_started_at, domains JSON, ssl_email, project_kind, access_mode, allowed_ips, created_at, updated_at)`. Kinds: `'web'|'service'`; status: `'stopped'|'running'|'maintenance'`.
- `project_env(PK(project_id, key), value_enc, is_secret)` → FK `projects` CASCADE. AES-256-GCM encrypted (`Vault`).
- `releases(id PK, project_id FK CASCADE, sha, short_sha, message, author, committed_at, dir, status, created_at, deployed_at, deployment_id FK->deployments SET NULL, build_status, health_status)`.
- `deployments(id PK, project_id FK CASCADE, release_id FK->releases SET NULL, from_release_id FK->releases SET NULL, kind, status, stage, sha, trigger, actor, error, started_at, finished_at)`. Stages: `pending->fetching->pulling->installing->building->deploying->health_checking`.
- `logs(id PK, project_id FK CASCADE, deployment_id FK CASCADE, channel, level, message, ts)`. Capped at `20,000` rows.
- `backups(id PK, project_id FK CASCADE, created_at, path, size_bytes, kind, note, release_id FK->releases SET NULL)`.
- `project_keys(project_id PK FK CASCADE, public_key, private_key, created_at)` — SSH deploy keys.
- `users(id PK, username UNIQUE, password_hash, disabled, permissions JSON, allowed_projects JSON, totp_secret, totp_pending_secret, totp_enabled, totp_backup_codes JSON, created_at)`. `id=1` = Main Admin.
- `sessions(id TEXT PK, user_id FK CASCADE, expires_at, csrf_token)`.
- `user_passkeys(id PK, user_id FK CASCADE, credential_id UNIQUE, name, public_key, alg, sign_count, created_at, last_used_at)`.
- `audit(id PK, ts, actor, action, target, detail, ip, project_id FK->projects SET NULL)`. Note: `ip` hardcoded `'127.0.0.1'` (`src/api/common.rs:410`).
- `databases(id PK, name, engine='postgres', db_name, db_user, db_password, port, is_superuser, domain, access_mode, allowed_ips, status, container_id, data_dir, linked_project_id FK->projects SET NULL, created_at, updated_at)`.

## DTOs
- `Project` (`src/projects/models.rs:32`): skips `webhook_secret` serialization.
- `User` (`src/auth/user.rs:8`): omits secrets; adds `allProjects`, `isMainAdmin`, `totpEnabled`, `presence`.
- `ManagedDatabase` (`src/databases.rs:20`, `camelCase`): adds `internalUrl`, `externalUrl`, `psqlCommand`, `linkedProjectName`.
- `Deployment` / `Release` (`src/deployer.rs:18,37`): `Deployment` adds `project_name`; `Release` adds `live`, `available`.
