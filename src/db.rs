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

    // Ultra-efficient, low-memory PRAGMAs:
    // - WAL mode for fast concurrency
    // - 2MB page cache (plenty for WebDep's < 1MB database while saving ~18MB RAM)
    // - temp_store = DEFAULT & mmap_size = 0 to prevent unnecessary RAM bloat
    conn.execute_batch(
        "
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = NORMAL;
        PRAGMA foreign_keys = ON;
        PRAGMA busy_timeout = 5000;
        PRAGMA cache_size = -2000;
        PRAGMA temp_store = DEFAULT;
        PRAGMA mmap_size = 0;
        ",
    )?;

    migrate(&conn)?;

    Ok(Arc::new(Mutex::new(conn)))
}

pub fn shrink_memory(conn: &Connection) {
    let _ = conn.execute_batch("PRAGMA shrink_memory;");
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

fn drop_column_if_exists(conn: &Connection, table: &str, cols: &[String], col: &str) -> bool {
    if cols.iter().any(|c| c.eq_ignore_ascii_case(col)) {
        conn.execute_batch(&format!("ALTER TABLE {table} DROP COLUMN {col};")).is_ok()
    } else {
        false
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
        ensure_column(conn, "users", &cols, "disabled", "INTEGER NOT NULL DEFAULT 0");
        ensure_column(conn, "users", &cols, "permissions", "TEXT NOT NULL DEFAULT '[\"*\"]'");
        ensure_column(conn, "users", &cols, "allowed_projects", "TEXT NOT NULL DEFAULT '[\"*\"]'");
        ensure_column(conn, "users", &cols, "totp_secret", "TEXT");
        ensure_column(conn, "users", &cols, "totp_pending_secret", "TEXT");
        ensure_column(conn, "users", &cols, "totp_enabled", "INTEGER NOT NULL DEFAULT 0");
        ensure_column(conn, "users", &cols, "totp_backup_codes", "TEXT NOT NULL DEFAULT '[]'");
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
        ensure_column(conn, "projects", &cols, "project_kind", "TEXT NOT NULL DEFAULT 'web'");
        ensure_column(conn, "projects", &cols, "access_mode", "TEXT NOT NULL DEFAULT 'local'");
        ensure_column(conn, "projects", &cols, "allowed_ips", "TEXT NOT NULL DEFAULT ''");
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
                health_timeout_s INTEGER NOT NULL DEFAULT 30,
                stability_s INTEGER NOT NULL DEFAULT 5,
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
                project_kind TEXT NOT NULL DEFAULT 'web',
                access_mode TEXT NOT NULL DEFAULT 'local',
                allowed_ips TEXT NOT NULL DEFAULT '',
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
                disabled INTEGER NOT NULL DEFAULT 0,
                permissions TEXT NOT NULL DEFAULT '[\"*\"]',
                allowed_projects TEXT NOT NULL DEFAULT '[\"*\"]',
                totp_secret TEXT,
                totp_pending_secret TEXT,
                totp_enabled INTEGER NOT NULL DEFAULT 0,
                totp_backup_codes TEXT NOT NULL DEFAULT '[]',
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
                created_at INTEGER NOT NULL DEFAULT 0,
                path TEXT NOT NULL DEFAULT '',
                size_bytes INTEGER NOT NULL DEFAULT 0,
                kind TEXT NOT NULL DEFAULT 'full-snapshot',
                note TEXT DEFAULT '',
                release_id INTEGER
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
            domain TEXT NOT NULL DEFAULT '',
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

    // Align backups columns (backfilling legacy fields before dropping duplicate/dead columns)
    let b_cols = get_table_columns(conn, "backups");
    ensure_column(conn, "backups", &b_cols, "release_id", "INTEGER");
    ensure_column(conn, "backups", &b_cols, "kind", "TEXT NOT NULL DEFAULT 'full-snapshot'");
    if !b_cols.iter().any(|c| c.eq_ignore_ascii_case("path")) {
        let _ = conn.execute_batch("ALTER TABLE backups ADD COLUMN path TEXT NOT NULL DEFAULT '';");
        if b_cols.iter().any(|c| c.eq_ignore_ascii_case("dir")) {
            let _ = conn.execute_batch("UPDATE backups SET path = COALESCE(dir, '');");
        }
    } else if b_cols.iter().any(|c| c.eq_ignore_ascii_case("dir")) {
        let _ = conn.execute_batch("UPDATE backups SET path = dir WHERE (path IS NULL OR path = '') AND dir IS NOT NULL AND dir != '';");
    }
    if !b_cols.iter().any(|c| c.eq_ignore_ascii_case("size_bytes")) {
        let _ = conn.execute_batch("ALTER TABLE backups ADD COLUMN size_bytes INTEGER NOT NULL DEFAULT 0;");
        if b_cols.iter().any(|c| c.eq_ignore_ascii_case("size")) {
            let _ = conn.execute_batch("UPDATE backups SET size_bytes = COALESCE(size, 0);");
        }
    } else if b_cols.iter().any(|c| c.eq_ignore_ascii_case("size")) {
        let _ = conn.execute_batch("UPDATE backups SET size_bytes = size WHERE (size_bytes IS NULL OR size_bytes = 0) AND size > 0;");
    }
    ensure_column(conn, "backups", &b_cols, "note", "TEXT DEFAULT ''");
    if !b_cols.iter().any(|c| c.eq_ignore_ascii_case("created_at")) {
        let _ = conn.execute_batch("ALTER TABLE backups ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0;");
        if b_cols.iter().any(|c| c.eq_ignore_ascii_case("ts")) {
            let _ = conn.execute_batch("UPDATE backups SET created_at = COALESCE(ts, 0);");
        }
    } else if b_cols.iter().any(|c| c.eq_ignore_ascii_case("ts")) {
        let _ = conn.execute_batch("UPDATE backups SET created_at = ts WHERE (created_at IS NULL OR created_at = 0) AND ts > 0;");
    }

    // Drop unused tables & columns from existing databases (idempotent)
    let mut cleaned_schema = false;
    for legacy_table in ["jobs", "locks"] {
        let exists: bool = conn
            .query_row(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",
                [legacy_table],
                |_| Ok(true),
            )
            .unwrap_or(false);
        if exists {
            let _ = conn.execute_batch(&format!("DROP TABLE IF EXISTS {legacy_table};"));
            cleaned_schema = true;
        }
    }

    let u_cols = get_table_columns(conn, "users");
    for col in ["salt", "role", "password_changed_at"] {
        if drop_column_if_exists(conn, "users", &u_cols, col) {
            cleaned_schema = true;
        }
    }

    let b_cols_after = get_table_columns(conn, "backups");
    for col in ["ts", "dir", "size", "status"] {
        if drop_column_if_exists(conn, "backups", &b_cols_after, col) {
            cleaned_schema = true;
        }
    }

    let p_cols_after = get_table_columns(conn, "projects");
    for col in ["health_cmd", "preflight", "nginx_configured"] {
        if drop_column_if_exists(conn, "projects", &p_cols_after, col) {
            cleaned_schema = true;
        }
    }

    if cleaned_schema {
        let _ = conn.execute_batch("INSERT OR REPLACE INTO _meta(key, value) VALUES('schema_version', '3'); VACUUM;");
    }

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

    // Dynamically ensure databases table has domain column for custom hostname routing
    let d_cols = get_table_columns(conn, "databases");
    ensure_column(conn, "databases", &d_cols, "domain", "TEXT NOT NULL DEFAULT ''");

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

    // Universal Port Assignment Guarantee:
    // Ensures every single website and backend service in SQLite has a non-conflicting, valid port assigned.
    if let Ok(mut stmt) = conn.prepare("SELECT id, name, project_kind FROM projects WHERE port IS NULL OR port = 0") {
        let unassigned: Vec<(i64, String, String)> = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get::<_, Option<String>>(2)?.unwrap_or_else(|| "website".to_string()))))
            .map(|iter| iter.flatten().collect())
            .unwrap_or_default();
        for (pid, name, kind) in unassigned {
            let default_start = if kind == "service" { 8000 } else { 3000 };
            if let Ok(new_port) = allocate_global_unique_port(conn, None, default_start, Some(pid), None) {
                conn.execute(
                    "UPDATE projects SET port = ? WHERE id = ?",
                    rusqlite::params![new_port as u32, pid],
                )
                .ok();
                eprintln!(
                    "[migration] Allocated unique port {} for workload '{}' (id: {})",
                    new_port, name, pid
                );
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

    let now_s = now() / 1000;
    let _ = conn.execute("DELETE FROM sessions WHERE expires_at <= ?", [now_s]);

    let _ = conn.execute_batch(
        "
        PRAGMA foreign_keys = OFF;
        DELETE FROM logs WHERE project_id IS NOT NULL AND project_id NOT IN (SELECT id FROM projects);
        UPDATE logs SET channel = 'system' WHERE channel = 'app' AND (
            message LIKE 'Started service %' OR
            message LIKE 'Started container %' OR
            message LIKE 'Stopped service %' OR
            message LIKE 'Stopped website container %' OR
            message LIKE 'Enabled Maintenance Mode for %' OR
            message LIKE 'Could not auto-resume %' OR
            message LIKE 'Process exited (%' OR
            message LIKE 'Process exited immediately with code %' OR
            message IN ('Process terminated', 'Process terminated unexpectedly')
        );
        DELETE FROM backups WHERE project_id NOT IN (SELECT id FROM projects);
        DELETE FROM deployments WHERE project_id NOT IN (SELECT id FROM projects);
        DELETE FROM releases WHERE project_id NOT IN (SELECT id FROM projects);
        DELETE FROM project_env WHERE project_id NOT IN (SELECT id FROM projects);
        DELETE FROM project_keys WHERE project_id NOT IN (SELECT id FROM projects);
        DELETE FROM logs WHERE deployment_id IS NOT NULL AND deployment_id NOT IN (SELECT id FROM deployments);
        DELETE FROM audit WHERE project_id IS NOT NULL AND project_id NOT IN (SELECT id FROM projects);
        PRAGMA foreign_keys = ON;
        PRAGMA wal_checkpoint(PASSIVE);
        ",
    );
}

/// Global unified TCP port allocator across all platform workloads:
/// - Guarantees non-conflicting ports across websites, backend services/bots, and databases
/// - Protects reserved system & daemon ports (22 SSH, 80 HTTP, 443 HTTPS, 4600 WebDep daemon)
/// - Probes physical OS socket availability via TcpListener on 127.0.0.1
/// - Preserves running workload assignments across configuration updates
pub fn allocate_global_unique_port(
    conn: &Connection,
    requested: Option<u16>,
    default_start: u16,
    exclude_project_id: Option<i64>,
    exclude_database_id: Option<i64>,
) -> Result<u16, String> {
    // If updating an existing project and keeping its existing port, preserve it directly
    if let (Some(id), Some(req)) = (exclude_project_id, requested) {
        if req > 0 {
            let current_port: Option<u16> = conn
                .query_row("SELECT port FROM projects WHERE id = ?", [id], |r| r.get(0))
                .ok()
                .flatten();
            if current_port == Some(req) {
                return Ok(req);
            }
        }
    }

    // If updating an existing database and keeping its existing port, preserve it directly
    if let (Some(id), Some(req)) = (exclude_database_id, requested) {
        if req > 0 {
            let current_port: Option<u16> = conn
                .query_row("SELECT port FROM databases WHERE id = ?", [id], |r| r.get(0))
                .ok();
            if current_port == Some(req) {
                return Ok(req);
            }
        }
    }

    let mut used = std::collections::HashSet::new();
    // Well-known and reserved daemon ports
    used.insert(22);
    used.insert(80);
    used.insert(443);
    used.insert(4600);

    // Query allocated ports from `projects` (websites & services)
    let sql_proj = match exclude_project_id {
        Some(id) => format!("SELECT port FROM projects WHERE port IS NOT NULL AND id != {}", id),
        None => "SELECT port FROM projects WHERE port IS NOT NULL".to_string(),
    };
    if let Ok(mut stmt) = conn.prepare(&sql_proj) {
        if let Ok(rows) = stmt.query_map([], |r| r.get::<_, u16>(0)) {
            for p in rows.flatten() {
                used.insert(p);
            }
        }
    }

    // Query allocated ports from `databases`
    let sql_db = match exclude_database_id {
        Some(id) => format!("SELECT port FROM databases WHERE port IS NOT NULL AND id != {}", id),
        None => "SELECT port FROM databases WHERE port IS NOT NULL".to_string(),
    };
    if let Ok(mut stmt) = conn.prepare(&sql_db) {
        if let Ok(rows) = stmt.query_map([], |r| r.get::<_, u16>(0)) {
            for p in rows.flatten() {
                used.insert(p);
            }
        }
    }

    // If a specific valid port was requested and is not in use or bound on the OS, assign it
    if let Some(req) = requested {
        if req > 0 && req < 65535 && !used.contains(&req) {
            if std::net::TcpListener::bind(("127.0.0.1", req)).is_ok() {
                return Ok(req);
            }
        }
    }

    // Search ascending from requested (if > 0) or default_start
    let start = requested.filter(|&r| r > 0).unwrap_or(default_start).max(1024);
    for port in start..65535 {
        if used.contains(&port) {
            continue;
        }
        if std::net::TcpListener::bind(("127.0.0.1", port)).is_ok() {
            return Ok(port);
        }
    }

    // Search wrapped lower range 1024..start if upper range exhausted
    for port in 1024..start {
        if used.contains(&port) {
            continue;
        }
        if std::net::TcpListener::bind(("127.0.0.1", port)).is_ok() {
            return Ok(port);
        }
    }

    Err("No free TCP ports available in range 1024-65535".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_schema_cleanup_drops_unused_columns_and_tables() {
        let temp_dir = std::env::temp_dir().join(format!("webdep-db-clean-{}", now()));
        std::fs::create_dir_all(&temp_dir).unwrap();
        let db_path = temp_dir.join("webdep.sqlite");

        {
            let conn = Connection::open(&db_path).unwrap();
            conn.execute_batch(
                "
                CREATE TABLE _meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
                INSERT INTO _meta(key, value) VALUES('schema_version', '2');
                CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
                CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, expires_at INTEGER NOT NULL, csrf_token TEXT NOT NULL);
                CREATE TABLE releases (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, sha TEXT NOT NULL, short_sha TEXT NOT NULL, message TEXT, author TEXT, committed_at INTEGER, dir TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', error TEXT, created_at INTEGER NOT NULL, deployed_at INTEGER);
                CREATE TABLE deployments (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL);
                CREATE TABLE logs (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER, deployment_id INTEGER, channel TEXT NOT NULL DEFAULT 'system', level TEXT NOT NULL DEFAULT 'info', message TEXT NOT NULL, ts INTEGER NOT NULL);
                CREATE TABLE project_env (project_id INTEGER NOT NULL, key TEXT NOT NULL, value_enc TEXT NOT NULL, is_secret INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(project_id, key));
                CREATE TABLE audit (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, target TEXT, detail TEXT, ip TEXT);
                CREATE TABLE users (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    username TEXT NOT NULL UNIQUE,
                    password_hash TEXT NOT NULL,
                    salt TEXT NOT NULL DEFAULT '',
                    role TEXT NOT NULL DEFAULT 'admin',
                    disabled INTEGER NOT NULL DEFAULT 0,
                    permissions TEXT NOT NULL DEFAULT '[\"*\"]',
                    allowed_projects TEXT NOT NULL DEFAULT '[\"*\"]',
                    password_changed_at INTEGER,
                    created_at INTEGER NOT NULL DEFAULT 0
                );
                INSERT INTO users(username, password_hash, salt, role, created_at) VALUES('admin', 'hash', '', 'admin', 100);
                CREATE TABLE projects (
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
                    project_kind TEXT NOT NULL DEFAULT 'web',
                    access_mode TEXT NOT NULL DEFAULT 'local',
                    allowed_ips TEXT NOT NULL DEFAULT '',
                    created_at INTEGER NOT NULL DEFAULT 0,
                    updated_at INTEGER NOT NULL DEFAULT 0
                );
                CREATE TABLE backups (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    project_id INTEGER NOT NULL,
                    ts INTEGER NOT NULL DEFAULT 0,
                    dir TEXT NOT NULL DEFAULT '',
                    size INTEGER NOT NULL DEFAULT 0,
                    kind TEXT NOT NULL DEFAULT 'full-snapshot',
                    note TEXT DEFAULT '',
                    status TEXT NOT NULL DEFAULT 'ok',
                    release_id INTEGER
                );
                CREATE TABLE jobs (id INTEGER PRIMARY KEY);
                CREATE TABLE locks (key TEXT PRIMARY KEY);
                ",
            )
            .unwrap();
        }

        let pool = open_db(&temp_dir).unwrap();
        let conn = pool.lock().unwrap();
        let u_cols = get_table_columns(&conn, "users");
        assert!(!u_cols.iter().any(|c| c == "salt" || c == "role" || c == "password_changed_at"));
        let b_cols = get_table_columns(&conn, "backups");
        assert!(!b_cols.iter().any(|c| c == "ts" || c == "dir" || c == "size" || c == "status"));
        assert!(b_cols.iter().any(|c| c == "created_at"));
        assert!(b_cols.iter().any(|c| c == "path"));
        assert!(b_cols.iter().any(|c| c == "size_bytes"));
        let p_cols = get_table_columns(&conn, "projects");
        assert!(!p_cols.iter().any(|c| c == "health_cmd" || c == "preflight" || c == "nginx_configured"));

        let jobs_exists: bool = conn
            .query_row("SELECT 1 FROM sqlite_master WHERE type='table' AND name='jobs'", [], |_| Ok(true))
            .unwrap_or(false);
        let locks_exists: bool = conn
            .query_row("SELECT 1 FROM sqlite_master WHERE type='table' AND name='locks'", [], |_| Ok(true))
            .unwrap_or(false);
        assert!(!jobs_exists);
        assert!(!locks_exists);

        drop(conn);
        drop(pool);
        std::fs::remove_dir_all(&temp_dir).ok();
    }
}
