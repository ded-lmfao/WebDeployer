# WebDep — Configuration (`src/config.rs`, `.env`)
`.env` (auto-created from `DEFAULT_DOTENV` in `src/config.rs:4-25` if absent) + process env. Secret values never stored.

| Key | Default | Consumer | Effect / Failure if absent |
|-----|---------|----------|----------------------------|
| `HOST` | `0.0.0.0` | `src/config.rs:197` | Bind interface |
| `PORT` | `4600` | `src/config.rs:193` | Panel HTTP port |
| `DATA_DIR` | `./data` | `src/config.rs:198`, `src/git.rs:60` | Root for DB, `master.key`, sites, PG, caddy |
| `LOG_DIR` | `$DATA_DIR/logs` | `src/config.rs:201` | Log dir |
| `SESSION_TTL_S` | `604800` | `src/config.rs:204` | Session TTL (seconds) |
| `ADMIN_USERNAME` (`_ID`/`_USER`) | `admin` | `src/config.rs:99` | Main Admin login; live-synced to `users` `id=1` |
| `ADMIN_PASSWORD` (`_PASS`) | `[secret — value not stored]` | `src/config.rs:107` | Main Admin password; live-synced to `users` `id=1` |
| `ADMIN_RESET_2FA` | `false` | `src/config.rs:114` | `true`/`1` clears Main Admin 2FA then resets to `false` |
| `RUST_LOG` | `webdep=info,tower_http=info` | `src/main.rs:52` | Tracing filter |
| `GITHUB_TOKEN` | `""` | `src/db.rs:282`, `src/git.rs:141` | GitHub fallback (also seeded from `gh auth token`) |
| `PG_BIN_DIR` | unset (`PATH`) | `src/databases/binaries.rs:16` | PG binaries path; DB create/start fails if PG missing |
| `PUBLIC_IP` | unset | `src/databases.rs:94` | External DB URL host |
| `WEBDEP_DB` / `NEXUS_DB` | unset | `src/git.rs:54` | DB path override for `Git` token lookup |
| `JAVA_HOME` | unset (`PATH`) | `src/runtime/tree.rs:28` | Java discovery |
| `NODE_OPTIONS` | unset | `src/deployer/builder.rs:123` | Build shell Node options |
| `WEBDEP_RESTARTED` | unset (`"1"`) | `src/main.rs:212` | Set by hot-reload binary watcher |
| `COMPUTERNAME` / `HOSTNAME` | OS | `src/api/system/overview.rs:555` | Monitor hostname |

Runtime secret files (untracked): `.env`, `data/master.key` (AES-256-GCM key — loss breaks all `project_env` decryption), `data/webdep.sqlite`.
