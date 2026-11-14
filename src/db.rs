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

    init_schema(&conn)?;

    Ok(Arc::new(Mutex::new(conn)))
}

pub fn shrink_memory(conn: &Connection) {
    let _ = conn.execute_batch("PRAGMA shrink_memory;");
}

/// Cap total stored log rows to prevent unbounded SQLite growth on busy services.
pub fn prune_old_logs(conn: &Connection, max_rows: usize) {
    if max_rows == 0 {
        return;
    }
    let count: i64 = conn
        .query_row("SELECT COUNT(*) FROM logs", [], |r| r.get(0))
        .unwrap_or(0);
    if count as usize > max_rows {
        let offset = (max_rows - 1) as i64;
        let _ = conn.execute(
            "DELETE FROM logs WHERE id < (SELECT id FROM logs ORDER BY id DESC LIMIT 1 OFFSET ?1)",
            rusqlite::params![offset],
        );
    }
}

fn init_schema(conn: &Connection) -> Result<(), rusqlite::Error> {
    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS _meta (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );

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
            webhook_secret TEXT,
            current_release_id INTEGER,
            deployed_sha TEXT,
            last_poll_at INTEGER,
            app_status TEXT NOT NULL DEFAULT 'stopped',
            app_pid INTEGER,
            app_started_at INTEGER,
            domains TEXT NOT NULL DEFAULT '[]',
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
            created_at INTEGER NOT NULL,
            deployed_at INTEGER,
            deployment_id INTEGER REFERENCES deployments(id) ON DELETE SET NULL,
            build_status TEXT NOT NULL DEFAULT 'pending',
            health_status TEXT NOT NULL DEFAULT 'pending'
        );
        CREATE INDEX IF NOT EXISTS idx_releases_proj ON releases(project_id, id DESC);
        CREATE INDEX IF NOT EXISTS idx_releases_dep ON releases(deployment_id);

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
        CREATE INDEX IF NOT EXISTS idx_deployments_proj_status ON deployments(project_id, status, id DESC);
        CREATE INDEX IF NOT EXISTS idx_deployments_active ON deployments(status, id DESC) WHERE status IN ('running', 'pending');

        CREATE TABLE IF NOT EXISTS logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
            deployment_id INTEGER REFERENCES deployments(id) ON DELETE CASCADE,
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
            last_active_at INTEGER NOT NULL DEFAULT 0,
            csrf_token TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
        CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

        CREATE TABLE IF NOT EXISTS backups (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            created_at INTEGER NOT NULL DEFAULT 0,
            path TEXT NOT NULL DEFAULT '',
            size_bytes INTEGER NOT NULL DEFAULT 0,
            kind TEXT NOT NULL DEFAULT 'full-snapshot',
            note TEXT DEFAULT '',
            release_id INTEGER REFERENCES releases(id) ON DELETE SET NULL
        );
        CREATE INDEX IF NOT EXISTS idx_backups_proj ON backups(project_id, id DESC);

        CREATE TABLE IF NOT EXISTS audit (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ts INTEGER NOT NULL,
            actor TEXT NOT NULL,
            action TEXT NOT NULL,
            target TEXT,
            detail TEXT,
            ip TEXT,
            project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL
        );
        CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit(ts DESC);
        CREATE INDEX IF NOT EXISTS idx_audit_ts_id ON audit(ts DESC, id DESC);
        CREATE INDEX IF NOT EXISTS idx_audit_proj ON audit(project_id, id DESC);
        CREATE INDEX IF NOT EXISTS idx_audit_proj_ts_id ON audit(project_id, ts DESC, id DESC);

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
            started_at INTEGER,
            data_dir TEXT NOT NULL DEFAULT '',
            linked_project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_projects_created ON projects(created_at DESC, id DESC);
        CREATE INDEX IF NOT EXISTS idx_backups_proj ON backups(project_id, id DESC);
        CREATE INDEX IF NOT EXISTS idx_databases_port ON databases(port);
        CREATE INDEX IF NOT EXISTS idx_databases_linked_project ON databases(linked_project_id);

        INSERT OR IGNORE INTO settings(key, value) VALUES ('min_free_mb', '500');
        INSERT OR IGNORE INTO settings(key, value) VALUES ('default_retention', '10');
        INSERT OR IGNORE INTO settings(key, value) VALUES ('step_timeout_s', '900');
        INSERT OR IGNORE INTO settings(key, value) VALUES ('deploy_timeout_s', '1800');
        INSERT OR REPLACE INTO _meta(key, value) VALUES('schema_version', '3');
        ",
    )?;

    // Idempotent column migrations for existing databases
    let has_db_started_at: bool = conn
        .prepare("PRAGMA table_info(databases)")
        .and_then(|mut s| {
            let rows = s.query_map([], |r| r.get::<_, String>(1))?;
            Ok(rows.flatten().any(|name| name == "started_at"))
        })
        .unwrap_or(false);
    if !has_db_started_at {
        let _ = conn.execute("ALTER TABLE databases ADD COLUMN started_at INTEGER", []);
    }

    let has_session_last_active: bool = conn
        .prepare("PRAGMA table_info(sessions)")
        .and_then(|mut s| {
            let rows = s.query_map([], |r| r.get::<_, String>(1))?;
            Ok(rows.flatten().any(|name| name == "last_active_at"))
        })
        .unwrap_or(false);
    if !has_session_last_active {
        conn.execute(
            "ALTER TABLE sessions ADD COLUMN last_active_at INTEGER NOT NULL DEFAULT 0",
            [],
        )?;
    }
    let now_s = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;
    let _ = conn.execute(
        "UPDATE sessions SET last_active_at = ? WHERE last_active_at = 0",
        [now_s],
    );
    // Create the partial index only after legacy databases have added `sessions.last_active_at`.
    conn.execute_batch(
        "CREATE INDEX IF NOT EXISTS idx_sessions_last_active ON sessions(last_active_at) WHERE last_active_at > 0;",
    )?;

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

    // Ensure deploy directories exist for active projects
    if let Ok(mut stmt) = conn.prepare("SELECT deploy_dir FROM projects") {
        if let Ok(dirs) = stmt.query_map([], |r| r.get::<_, String>(0)) {
            for dir in dirs.flatten() {
                if !dir.trim().is_empty() {
                    let _ = std::fs::create_dir_all(&dir);
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
        DELETE FROM backups WHERE project_id NOT IN (SELECT id FROM projects);
        DELETE FROM deployments WHERE project_id NOT IN (SELECT id FROM projects);
        DELETE FROM releases WHERE project_id NOT IN (SELECT id FROM projects);
        DELETE FROM project_env WHERE project_id NOT IN (SELECT id FROM projects);
        DELETE FROM project_keys WHERE project_id NOT IN (SELECT id FROM projects);
        DELETE FROM logs WHERE deployment_id IS NOT NULL AND deployment_id NOT IN (SELECT id FROM deployments);
        DELETE FROM audit WHERE project_id IS NOT NULL AND project_id NOT IN (SELECT id FROM projects);
        UPDATE releases SET deployment_id = NULL WHERE deployment_id IS NOT NULL AND deployment_id NOT IN (SELECT id FROM deployments);
        UPDATE backups SET release_id = NULL WHERE release_id IS NOT NULL AND release_id NOT IN (SELECT id FROM releases);
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
    fn test_init_schema_is_idempotent() {
        let temp_dir = std::env::temp_dir().join(format!("webdep-db-init-{}", now()));
        std::fs::create_dir_all(&temp_dir).unwrap();

        let pool = open_db(&temp_dir).unwrap();
        drop(pool);
        let pool2 = open_db(&temp_dir).unwrap();
        let conn = pool2.lock().unwrap();

        let version: String = conn
            .query_row("SELECT value FROM _meta WHERE key = 'schema_version'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(version, "3");

        let mut stmt = conn.prepare("PRAGMA table_info(users)").unwrap();
        let u_cols: Vec<String> = stmt.query_map([], |r| r.get(1)).unwrap().flatten().collect();
        assert!(!u_cols.iter().any(|c| c == "salt" || c == "role" || c == "password_changed_at"));
        drop(stmt);

        let mut p_stmt = conn.prepare("PRAGMA table_info(projects)").unwrap();
        let p_cols: Vec<String> = p_stmt.query_map([], |r| r.get(1)).unwrap().flatten().collect();
        assert!(!p_cols.iter().any(|c| {
            c == "poll_interval_s" || c == "retention" || c == "persistent_paths" || c == "ssl_enabled"
        }));
        drop(p_stmt);

        let mut r_stmt = conn.prepare("PRAGMA table_info(releases)").unwrap();
        let r_cols: Vec<String> = r_stmt.query_map([], |r| r.get(1)).unwrap().flatten().collect();
        assert!(!r_cols.iter().any(|c| c == "error"));
        assert!(r_cols.iter().any(|c| c == "deployment_id"));
        drop(r_stmt);

        let mut d_stmt = conn.prepare("PRAGMA table_info(databases)").unwrap();
        let d_cols: Vec<String> = d_stmt.query_map([], |r| r.get(1)).unwrap().flatten().collect();
        assert!(d_cols.iter().any(|c| c == "started_at"));
        drop(d_stmt);

        drop(conn);
        drop(pool2);
        std::fs::remove_dir_all(&temp_dir).ok();
    }

    #[test]
    fn test_prune_old_logs_caps_rows() {
        let temp_dir = std::env::temp_dir().join(format!("webdep-db-logs-{}", now()));
        std::fs::create_dir_all(&temp_dir).unwrap();
        let pool = open_db(&temp_dir).unwrap();
        let conn = pool.lock().unwrap();
        for i in 0..15 {
            conn.execute(
                "INSERT INTO logs (channel, level, message, ts) VALUES ('sys', 'info', ?, ?)",
                rusqlite::params![format!("msg-{}", i), i as i64],
            )
            .unwrap();
        }
        prune_old_logs(&conn, 5);
        let remaining: i64 = conn
            .query_row("SELECT COUNT(*) FROM logs", [], |r| r.get(0))
            .unwrap();
        assert_eq!(remaining, 5);
        drop(conn);
        drop(pool);
        std::fs::remove_dir_all(&temp_dir).ok();
    }

    #[test]
    fn test_audit_query_plan_avoids_temp_btree() {
        let temp_dir = std::env::temp_dir().join(format!("webdep-db-eqp-{}", now()));
        std::fs::create_dir_all(&temp_dir).unwrap();
        let pool = open_db(&temp_dir).unwrap();
        let conn = pool.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "EXPLAIN QUERY PLAN SELECT id, project_id, ts, actor, action, target, detail, ip
                 FROM audit
                 WHERE project_id = 1 OR LOWER(COALESCE(target, '')) = LOWER('Project 1')
                 ORDER BY ts DESC, id DESC LIMIT 500",
            )
            .unwrap();
        let plans: Vec<String> = stmt.query_map([], |r| r.get(3)).unwrap().flatten().collect();
        let joined = plans.join(" | ");
        assert!(joined.contains("idx_audit_ts_id"), "expected idx_audit_ts_id in {}", joined);
        assert!(!joined.contains("TEMP B-TREE"), "unexpected temp sort in {}", joined);
        drop(stmt);
        drop(conn);
        drop(pool);
        std::fs::remove_dir_all(&temp_dir).ok();
    }

    #[test]
    fn test_overview_and_sessions_query_plans_use_indexes() {
        let temp_dir = std::env::temp_dir().join(format!("webdep-db-eqp2-{}", now()));
        std::fs::create_dir_all(&temp_dir).unwrap();
        let pool = open_db(&temp_dir).unwrap();
        let conn = pool.lock().unwrap();

        conn.execute(
            "INSERT INTO users (id, username, password_hash, created_at) VALUES (1, 'eqp', 'h', 1)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO projects (id, name, slug, repo_url, branch, deploy_dir, created_at, updated_at) VALUES (1, 'Eqp', 'eqp', 'https://example.com/a.git', 'main', '/tmp/eqp', 1, 1)",
            [],
        )
        .unwrap();
        for i in 0..300 {
            let status = if i == 0 { "running" } else { "success" };
            conn.execute(
                "INSERT INTO deployments (project_id, kind, status, stage, trigger, actor, started_at) VALUES (1, 'deploy', ?, 'done', 'manual', 'eqp', ?)",
                rusqlite::params![status, i as i64],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO sessions (id, user_id, expires_at, last_active_at, csrf_token) VALUES (?, 1, ?, ?, 'csrf')",
                rusqlite::params![format!("sess-{}", i), 1000 + i as i64, 500 + i as i64],
            )
            .unwrap();
        }
        conn.execute_batch("ANALYZE;").unwrap();

        let eqp = |sql: &str| -> String {
            let mut stmt = conn.prepare(&format!("EXPLAIN QUERY PLAN {}", sql)).unwrap();
            let plans: Vec<String> = stmt.query_map([], |r| r.get(3)).unwrap().flatten().collect();
            plans.join(" | ")
        };

        let active_plan = eqp(
            "SELECT id, project_id, release_id, from_release_id, kind, status, stage, sha, trigger, actor, error, started_at, finished_at \
             FROM deployments WHERE status IN ('running', 'pending')",
        );
        assert!(
            active_plan.contains("idx_deployments_active"),
            "expected idx_deployments_active in {}",
            active_plan
        );
        assert!(
            !active_plan.contains("TEMP B-TREE"),
            "unexpected temp B-tree in {}",
            active_plan
        );

        let exp_purge_plan = eqp("DELETE FROM sessions WHERE expires_at <= 100");
        assert!(
            exp_purge_plan.contains("idx_sessions_expires"),
            "expected idx_sessions_expires in {}",
            exp_purge_plan
        );

        let idle_purge_plan =
            eqp("DELETE FROM sessions WHERE last_active_at > 0 AND last_active_at <= 100");
        assert!(
            idle_purge_plan.contains("idx_sessions_last_active"),
            "expected idx_sessions_last_active in {}",
            idle_purge_plan
        );

        drop(conn);
        drop(pool);
        std::fs::remove_dir_all(&temp_dir).ok();
    }

    #[test]
    fn test_open_db_migrates_legacy_sessions_table_before_indexing() {
        let temp_dir = std::env::temp_dir().join(format!("webdep-db-legacy-migrate-{}", now()));
        std::fs::create_dir_all(&temp_dir).unwrap();
        let db_path = temp_dir.join("webdep.sqlite");

        // Simulate a pre-v2.0.10 VPS database before `sessions.last_active_at` existed.
        {
            let legacy = Connection::open(&db_path).unwrap();
            legacy
                .execute_batch(
                    "
                    CREATE TABLE users (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        username TEXT NOT NULL UNIQUE,
                        password_hash TEXT NOT NULL,
                        created_at INTEGER NOT NULL
                    );
                    CREATE TABLE sessions (
                        id TEXT PRIMARY KEY,
                        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                        expires_at INTEGER NOT NULL,
                        csrf_token TEXT NOT NULL
                    );
                    INSERT INTO users (id, username, password_hash, created_at) VALUES (1, 'admin', 'hash', 1);
                    INSERT INTO sessions (id, user_id, expires_at, csrf_token) VALUES ('legacy-sid', 1, 9999999999, 'legacy-csrf');
                    ",
                )
                .unwrap();
        }

        let pool = open_db(&temp_dir).expect("open_db should migrate legacy v2.0.9 databases cleanly");
        let conn = pool.lock().unwrap();

        let last_active: i64 = conn
            .query_row(
                "SELECT last_active_at FROM sessions WHERE id = 'legacy-sid'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(last_active > 0, "legacy session should have backfilled last_active_at");

        let has_index: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name = 'idx_sessions_last_active'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(has_index, 1, "idx_sessions_last_active should exist after migration");

        drop(conn);
        drop(pool);
        std::fs::remove_dir_all(&temp_dir).ok();
    }
}
