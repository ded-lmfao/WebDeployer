use rusqlite::Connection;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{SystemTime, UNIX_EPOCH};

pub type DbPool = Arc<Mutex<Connection>>;

static ACTIVE_DB_PATH: RwLock<Option<PathBuf>> = RwLock::new(None);

pub fn active_db_path() -> Option<PathBuf> {
    ACTIVE_DB_PATH.read().ok().and_then(|g| g.clone())
}

pub fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

pub fn open_db(data_dir: &Path) -> Result<DbPool, Box<dyn std::error::Error + Send + Sync>> {
    std::fs::create_dir_all(data_dir)?;
    let db_path = data_dir.join("webdep.sqlite");
    if let Ok(mut guard) = ACTIVE_DB_PATH.write() {
        *guard = Some(db_path.clone());
    }
    let legacy_path = data_dir.join("nexus-deploy.sqlite");

    // Seamlessly migrate legacy nexus-deploy.sqlite -> webdep.sqlite without losing any user data
    if !db_path.exists() && legacy_path.exists() {
        if let Ok(legacy_conn) = Connection::open(&legacy_path) {
            let _ = legacy_conn.execute_batch("PRAGMA wal_checkpoint(FULL);");
        }
        let _ = std::fs::copy(&legacy_path, &db_path);
    }

    let conn = Connection::open(&db_path)?;

    // High performance PRAGMAs (WAL, NORMAL sync, in-memory temp store, 20MB cache)
    conn.execute_batch(
        "
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = NORMAL;
        PRAGMA foreign_keys = ON;
        PRAGMA busy_timeout = 5000;
        PRAGMA cache_size = -20000;
        PRAGMA temp_store = MEMORY;
        ",
    )?;

    migrate(&conn)?;

    Ok(Arc::new(Mutex::new(conn)))
}

fn get_table_columns(conn: &Connection, table: &str) -> Vec<String> {
    if let Ok(mut stmt) = conn.prepare(&format!("PRAGMA table_info({table})")) {
        stmt.query_map([], |r| r.get::<_, String>(1))
            .map(|it| it.flatten().collect())
            .unwrap_or_default()
    } else {
        Vec::new()
    }
}

fn ensure_column(conn: &Connection, table: &str, cols: &[String], col: &str, col_def: &str) {
    if !cols.iter().any(|c| c.eq_ignore_ascii_case(col)) {
        let _ = conn.execute_batch(&format!("ALTER TABLE {table} ADD COLUMN {col} {col_def};"));
    }
}

fn migrate(conn: &Connection) -> Result<(), rusqlite::Error> {
    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS _meta (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
        ",
    )?;

    // Dynamic schema alignment for existing databases
    let has_users: bool = conn
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='users'",
            [],
            |_| Ok(true),
        )
        .unwrap_or(false);

    if has_users {
        let cols = get_table_columns(conn, "users");
        if !cols.iter().any(|c| c == "password_hash") && cols.iter().any(|c| c == "pass_hash") {
            let _ = conn.execute_batch("ALTER TABLE users RENAME COLUMN pass_hash TO password_hash;");
        }
        ensure_column(conn, "users", &cols, "salt", "TEXT NOT NULL DEFAULT ''");
        ensure_column(conn, "users", &cols, "disabled", "INTEGER NOT NULL DEFAULT 0");
        ensure_column(conn, "users", &cols, "permissions", "TEXT NOT NULL DEFAULT '[\"*\"]'");
        ensure_column(conn, "users", &cols, "allowed_projects", "TEXT NOT NULL DEFAULT '[\"*\"]'");
        ensure_column(conn, "users", &cols, "totp_secret", "TEXT");
        ensure_column(conn, "users", &cols, "totp_pending_secret", "TEXT");
        ensure_column(conn, "users", &cols, "totp_enabled", "INTEGER NOT NULL DEFAULT 0");
        ensure_column(conn, "users", &cols, "totp_backup_codes", "TEXT NOT NULL DEFAULT '[]'");
        ensure_column(conn, "users", &cols, "password_changed_at", "INTEGER");
    }

    let has_sessions: bool = conn
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='sessions'",
            [],
            |_| Ok(true),
        )
        .unwrap_or(false);

    if has_sessions {
        let cols = get_table_columns(conn, "sessions");
        if cols.iter().any(|c| c == "token_hash") && !cols.iter().any(|c| c == "id") {
            conn.execute_batch(
                "DROP TABLE sessions;
                 CREATE TABLE sessions (
                     id TEXT PRIMARY KEY,
                     user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                     expires_at INTEGER NOT NULL,
                     csrf_token TEXT NOT NULL
                 );",
            )?;
        }
    }

    let has_projects: bool = conn
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='projects'",
            [],
            |_| Ok(true),
        )
        .unwrap_or(false);

    if has_projects {
        let cols = get_table_columns(conn, "projects");
        if !cols.iter().any(|c| c == "webhook_secret") {
            if cols.iter().any(|c| c == "webhook_secret_enc") {
                let _ = conn.execute_batch("ALTER TABLE projects RENAME COLUMN webhook_secret_enc TO webhook_secret;");
            } else {
                ensure_column(conn, "projects", &cols, "webhook_secret", "TEXT");
            }
        }
        if !cols.iter().any(|c| c == "app_started_at") {
            if cols.iter().any(|c| c == "app_status_at") {
                let _ = conn.execute_batch("ALTER TABLE projects RENAME COLUMN app_status_at TO app_started_at;");
            } else {
                ensure_column(conn, "projects", &cols, "app_started_at", "INTEGER");
            }
        }
        ensure_column(conn, "projects", &cols, "app_pid", "INTEGER");
        ensure_column(conn, "projects", &cols, "domains", "TEXT NOT NULL DEFAULT '[]'");
        ensure_column(conn, "projects", &cols, "ssl_enabled", "INTEGER NOT NULL DEFAULT 0");
        ensure_column(conn, "projects", &cols, "ssl_email", "TEXT DEFAULT ''");
        ensure_column(conn, "projects", &cols, "nginx_configured", "INTEGER NOT NULL DEFAULT 0");
    }

    let version: i32 = conn
        .query_row(
            "SELECT CAST(value AS INTEGER) FROM _meta WHERE key = 'schema_version'",
            [],
            |row| row.get(0),
        )
        .unwrap_or(0);

    if version < 1 {
        conn.execute_batch(
            "
            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS projects (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                slug TEXT NOT NULL UNIQUE,
                repo_url TEXT NOT NULL,
                branch TEXT NOT NULL DEFAULT 'main',
                project_type TEXT NOT NULL DEFAULT 'node',
                deploy_method TEXT NOT NULL DEFAULT 'managed',
                deploy_dir TEXT NOT NULL,
                port INTEGER,
                install_cmd TEXT DEFAULT '',
                build_cmd TEXT DEFAULT '',
                start_cmd TEXT DEFAULT '',
                health_url TEXT DEFAULT '',
                health_cmd TEXT DEFAULT '',
                health_timeout_s INTEGER NOT NULL DEFAULT 30,
                stability_s INTEGER NOT NULL DEFAULT 5,
                preflight INTEGER NOT NULL DEFAULT 1,
                auto_deploy INTEGER NOT NULL DEFAULT 0,
                poll_interval_s INTEGER NOT NULL DEFAULT 60,
                webhook_secret TEXT,
                retention INTEGER NOT NULL DEFAULT 5,
                persistent_paths TEXT NOT NULL DEFAULT '[]',
                current_release_id INTEGER,
                deployed_sha TEXT,
                last_poll_at INTEGER,
                app_status TEXT NOT NULL DEFAULT 'stopped',
                app_pid INTEGER,
                app_started_at INTEGER,
                domains TEXT NOT NULL DEFAULT '[]',
                ssl_enabled INTEGER NOT NULL DEFAULT 0,
                ssl_email TEXT DEFAULT '',
                nginx_configured INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS project_env (
                project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                key TEXT NOT NULL,
                value_enc TEXT NOT NULL,
                is_secret INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY(project_id, key)
            );

            CREATE TABLE IF NOT EXISTS releases (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                sha TEXT NOT NULL,
                short_sha TEXT NOT NULL,
                message TEXT,
                author TEXT,
                committed_at INTEGER,
                dir TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'pending',
                error TEXT,
                created_at INTEGER NOT NULL,
                deployed_at INTEGER
            );
            CREATE INDEX IF NOT EXISTS idx_releases_proj ON releases(project_id, id DESC);

            CREATE TABLE IF NOT EXISTS deployments (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                release_id INTEGER REFERENCES releases(id) ON DELETE SET NULL,
                from_release_id INTEGER REFERENCES releases(id) ON DELETE SET NULL,
                kind TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'pending',
                stage TEXT NOT NULL DEFAULT 'pending',
                sha TEXT,
                trigger TEXT NOT NULL DEFAULT 'manual',
                actor TEXT NOT NULL DEFAULT 'system',
                error TEXT,
                started_at INTEGER NOT NULL,
                finished_at INTEGER
            );
            CREATE INDEX IF NOT EXISTS idx_deployments_proj ON deployments(project_id, id DESC);

            CREATE TABLE IF NOT EXISTS logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                project_id INTEGER,
                deployment_id INTEGER,
                channel TEXT NOT NULL DEFAULT 'system',
                level TEXT NOT NULL DEFAULT 'info',
                message TEXT NOT NULL,
                ts INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_logs_proj ON logs(project_id, id DESC);
            CREATE INDEX IF NOT EXISTS idx_logs_dep ON logs(deployment_id, id ASC);
            CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs(ts DESC);

            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT NOT NULL UNIQUE,
                password_hash TEXT NOT NULL,
                salt TEXT NOT NULL,
                role TEXT NOT NULL DEFAULT 'admin',
                disabled INTEGER NOT NULL DEFAULT 0,
                permissions TEXT NOT NULL DEFAULT '[\"*\"]',
                allowed_projects TEXT NOT NULL DEFAULT '[\"*\"]',
                totp_secret TEXT,
                totp_pending_secret TEXT,
                totp_enabled INTEGER NOT NULL DEFAULT 0,
                totp_backup_codes TEXT NOT NULL DEFAULT '[]',
                password_changed_at INTEGER,
                created_at INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS sessions (
                id TEXT PRIMARY KEY,
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                expires_at INTEGER NOT NULL,
                csrf_token TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS backups (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                ts INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL DEFAULT 0,
                dir TEXT NOT NULL DEFAULT '',
                path TEXT NOT NULL DEFAULT '',
                size INTEGER NOT NULL DEFAULT 0,
                size_bytes INTEGER NOT NULL DEFAULT 0,
                kind TEXT NOT NULL DEFAULT 'full-snapshot',
                note TEXT DEFAULT '',
                status TEXT NOT NULL DEFAULT 'ok',
                release_id INTEGER
            );

            CREATE TABLE IF NOT EXISTS jobs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
                type TEXT NOT NULL,
                payload TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'queued',
                attempt INTEGER NOT NULL DEFAULT 0,
                error TEXT,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status, id ASC);

            CREATE TABLE IF NOT EXISTS locks (
                key TEXT PRIMARY KEY,
                owner TEXT NOT NULL,
                acquired_at INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS audit (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                ts INTEGER NOT NULL,
                actor TEXT NOT NULL,
                action TEXT NOT NULL,
                target TEXT,
                detail TEXT,
                ip TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit(ts DESC);

            INSERT OR REPLACE INTO _meta(key, value) VALUES('schema_version', '2');
            ",
        )?;
    }

    // Ensure persistent tables for deploy keys and passkeys always exist
    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS project_keys (
            project_id INTEGER PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
            public_key TEXT NOT NULL,
            private_key TEXT NOT NULL,
            created_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS user_passkeys (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            credential_id TEXT NOT NULL UNIQUE,
            name TEXT NOT NULL,
            public_key TEXT NOT NULL,
            alg INTEGER NOT NULL DEFAULT -7,
            sign_count INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL,
            last_used_at INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_user_passkeys_user ON user_passkeys(user_id, id DESC);

        CREATE TABLE IF NOT EXISTS databases (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            engine TEXT NOT NULL DEFAULT 'postgres',
            db_name TEXT NOT NULL,
            db_user TEXT NOT NULL,
            db_password TEXT NOT NULL,
            port INTEGER NOT NULL,
            is_superuser INTEGER NOT NULL DEFAULT 0,
            access_mode TEXT NOT NULL DEFAULT 'local',
            allowed_ips TEXT NOT NULL DEFAULT '',
            status TEXT NOT NULL DEFAULT 'stopped',
            container_id TEXT,
            data_dir TEXT NOT NULL DEFAULT '',
            linked_project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_databases_port ON databases(port);

        INSERT OR IGNORE INTO settings(key, value) VALUES ('min_free_mb', '500');
        INSERT OR IGNORE INTO settings(key, value) VALUES ('default_retention', '10');
        INSERT OR IGNORE INTO settings(key, value) VALUES ('step_timeout_s', '900');
        INSERT OR IGNORE INTO settings(key, value) VALUES ('deploy_timeout_s', '1800');
        ",
    )?;

    // Dynamically align existing backups table columns (migrating from legacy schema if needed)
    let b_cols = get_table_columns(conn, "backups");
    ensure_column(conn, "backups", &b_cols, "release_id", "INTEGER");
    ensure_column(conn, "backups", &b_cols, "kind", "TEXT NOT NULL DEFAULT 'full-snapshot'");
    ensure_column(conn, "backups", &b_cols, "path", "TEXT NOT NULL DEFAULT ''");
    ensure_column(conn, "backups", &b_cols, "dir", "TEXT NOT NULL DEFAULT ''");
    if !b_cols.iter().any(|c| c.eq_ignore_ascii_case("size_bytes")) {
        let _ = conn.execute_batch("ALTER TABLE backups ADD COLUMN size_bytes INTEGER NOT NULL DEFAULT 0;");
        if b_cols.iter().any(|c| c.eq_ignore_ascii_case("size")) {
            let _ = conn.execute_batch("UPDATE backups SET size_bytes = COALESCE(size, 0);");
        }
    }
    ensure_column(conn, "backups", &b_cols, "size", "INTEGER NOT NULL DEFAULT 0");
    ensure_column(conn, "backups", &b_cols, "note", "TEXT DEFAULT ''");
    ensure_column(conn, "backups", &b_cols, "status", "TEXT NOT NULL DEFAULT 'ok'");
    if !b_cols.iter().any(|c| c.eq_ignore_ascii_case("created_at")) {
        let _ = conn.execute_batch("ALTER TABLE backups ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0;");
        if b_cols.iter().any(|c| c.eq_ignore_ascii_case("ts")) {
            let _ = conn.execute_batch("UPDATE backups SET created_at = COALESCE(ts, 0);");
        }
    }
    ensure_column(conn, "backups", &b_cols, "ts", "INTEGER NOT NULL DEFAULT 0");

    // Dynamically ensure releases table has deployment_id, build_status, and health_status columns
    let r_cols = get_table_columns(conn, "releases");
    ensure_column(conn, "releases", &r_cols, "deployment_id", "INTEGER");
    ensure_column(conn, "releases", &r_cols, "build_status", "TEXT DEFAULT 'success'");
    ensure_column(conn, "releases", &r_cols, "health_status", "TEXT DEFAULT 'healthy'");

    // Dynamically ensure audit table has project_id for per-website activity logs
    let a_cols = get_table_columns(conn, "audit");
    ensure_column(conn, "audit", &a_cols, "project_id", "INTEGER");
    if !a_cols.iter().any(|c| c.eq_ignore_ascii_case("project_id")) {
        let _ = conn.execute_batch(
            "CREATE INDEX IF NOT EXISTS idx_audit_proj ON audit(project_id, id DESC);
             UPDATE audit SET project_id = (
                 SELECT p.id FROM projects p
                 WHERE LOWER(p.name) = LOWER(audit.target)
                    OR LOWER(p.slug) = LOWER(audit.target)
                    OR CAST(p.id AS TEXT) = audit.target
                 LIMIT 1
             ) WHERE project_id IS NULL AND target IS NOT NULL;",
        );
    }

    // Auto-seed github_token into SQLite settings if not yet configured
    let existing_token: String = conn
        .query_row(
            "SELECT value FROM settings WHERE key = 'github_token'",
            [],
            |r| r.get(0),
        )
        .unwrap_or_default();
    if existing_token.trim().is_empty() {
        let mut detected_tok = std::env::var("GITHUB_TOKEN").unwrap_or_default();
        if detected_tok.trim().is_empty() {
            if let Ok(out) = std::process::Command::new("gh").args(["auth", "token"]).output() {
                if out.status.success() {
                    detected_tok = String::from_utf8_lossy(&out.stdout).trim().to_string();
                }
            }
        }
        if !detected_tok.trim().is_empty() {
            conn.execute(
                "INSERT INTO settings(key, value) VALUES('github_token', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                rusqlite::params![detected_tok.trim()],
            )
            .ok();
        }
    }

    // Generic multi-website migration: normalize relative deploy_dir paths and upgrade full-stack Node+Vite start_cmd
    let cwd = std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("."));
    if let Ok(mut stmt) = conn.prepare("SELECT id, deploy_dir, start_cmd FROM projects") {
        let rows: Vec<(i64, String, String)> = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .map(|iter| iter.flatten().collect())
            .unwrap_or_default();
        for (pid, deploy_dir, start_cmd) in rows {
            let mut norm_dir = deploy_dir.clone();
            if let Some(rel) = deploy_dir.strip_prefix("./").or_else(|| deploy_dir.strip_prefix(".\\")) {
                let abs = cwd.join(rel);
                #[cfg(windows)]
                {
                    norm_dir = abs.to_string_lossy().replace('/', "\\");
                }
                #[cfg(not(windows))]
                {
                    norm_dir = abs.to_string_lossy().replace('\\', "/");
                }
                let _ = std::fs::create_dir_all(&norm_dir);
                conn.execute(
                    "UPDATE projects SET deploy_dir = ? WHERE id = ?",
                    rusqlite::params![norm_dir, pid],
                )
                .ok();
            } else {
                let _ = std::fs::create_dir_all(&norm_dir);
            }

            let base = Path::new(&norm_dir);
            // If 'current' is a broken junction (os error 267), remove it so runtime falls back cleanly
            let current_link = base.join("current");
            if std::fs::symlink_metadata(&current_link).is_ok() && std::fs::read_dir(&current_link).is_err() {
                #[cfg(windows)]
                {
                    let _ = std::process::Command::new("cmd")
                        .args(["/C", "rmdir", &current_link.to_string_lossy()])
                        .output();
                }
                let _ = std::fs::remove_dir_all(&current_link);
                let _ = std::fs::remove_file(&current_link);
            }

            if start_cmd.contains("vite preview") {
                if base.join("repo").join("server.js").exists()
                    || base.join("current").join("server.js").exists()
                {
                    conn.execute(
                        "UPDATE projects SET start_cmd = 'node server.js' WHERE id = ?",
                        rusqlite::params![pid],
                    )
                    .ok();
                }
            }
        }
    }

    purge_orphaned_project_data(conn);

    Ok(())
}

/// Automatically sweeps and deletes any leftover SQLite database rows
/// belonging to websites (`project_id`) that were previously deleted.
/// Never touches disk files so active websites or custom directories on disk can never be affected.
pub fn purge_orphaned_project_data(conn: &Connection) {
    // Verify the `projects` table exists and is readable before cleaning child tables
    let projects_table_ok: bool = conn
        .query_row("SELECT 1 FROM sqlite_master WHERE type='table' AND name='projects'", [], |_| Ok(true))
        .unwrap_or(false);
    if !projects_table_ok {
        return;
    }

    let _ = conn.execute_batch(
        "
        PRAGMA foreign_keys = OFF;
        DELETE FROM logs WHERE project_id IS NOT NULL AND project_id NOT IN (SELECT id FROM projects);
        DELETE FROM backups WHERE project_id NOT IN (SELECT id FROM projects);
        DELETE FROM deployments WHERE project_id NOT IN (SELECT id FROM projects);
        DELETE FROM releases WHERE project_id NOT IN (SELECT id FROM projects);
        DELETE FROM project_env WHERE project_id NOT IN (SELECT id FROM projects);
        DELETE FROM project_keys WHERE project_id NOT IN (SELECT id FROM projects);
        DELETE FROM jobs WHERE project_id IS NOT NULL AND project_id NOT IN (SELECT id FROM projects);
        DELETE FROM logs WHERE deployment_id IS NOT NULL AND deployment_id NOT IN (SELECT id FROM deployments);
        DELETE FROM audit WHERE project_id IS NOT NULL AND project_id NOT IN (SELECT id FROM projects);
        PRAGMA foreign_keys = ON;
        PRAGMA wal_checkpoint(PASSIVE);
        ",
    );
}
