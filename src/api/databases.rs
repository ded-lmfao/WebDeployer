use axum::{
    extract::{Path as AxPath, State},
    http::{HeaderMap, StatusCode},
    response::Response,
    Json,
};
use serde::Deserialize;

use super::common::*;
use super::files::{
    delete_in_root, download_in_root, list_entries_in_root, mkdir_in_root, read_file_in_root,
    rename_in_root, upload_in_root, write_file_in_root, FileMkdirPayload, FileRenamePayload,
    FileWritePayload, FilesQuery,
};
use axum::extract::{Multipart, Query};

// ---------------------------------------------------------------------------
// Managed Databases (PostgreSQL)
// ---------------------------------------------------------------------------
fn can_access_db(user: &crate::auth::user::User, db: &crate::databases::ManagedDatabase) -> bool {
    let can_unlinked = user.all_projects || user.has_power("databases_manage");
    db.linked_project_id
        .map(|pid| user.can_access_project(pid))
        .unwrap_or(can_unlinked)
}

pub(crate) fn verify_db_access(
    state: &AppState,
    headers: &HeaderMap,
    powers: &[&str],
    db: &crate::databases::ManagedDatabase,
) -> Result<crate::auth::user::User, (StatusCode, String)> {
    let user = verify_any_power(state, headers, powers, db.linked_project_id)?;
    if !can_access_db(&user, db) {
        return Err((StatusCode::FORBIDDEN, "Access to unlinked database is restricted".to_string()));
    }
    Ok(user)
}

pub(crate) fn get_authorized_database(
    state: &AppState,
    headers: &HeaderMap,
    powers: &[&str],
    id: i64,
) -> Result<(crate::auth::user::User, crate::databases::ManagedDatabase), (StatusCode, String)> {
    let db = state
        .databases
        .get(id)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?
        .ok_or_else(|| (StatusCode::NOT_FOUND, "Database not found".to_string()))?;
    let user = verify_db_access(state, headers, powers, &db)?;
    Ok((user, db))
}

fn verify_db_files_write(
    state: &AppState,
    headers: &HeaderMap,
    id: i64,
) -> Result<(crate::auth::user::User, crate::databases::ManagedDatabase), (StatusCode, String)> {
    let (user, db) = get_authorized_database(state, headers, &["databases", "databases_manage"], id)?;
    if !user.has_power("databases_manage") && !(user.has_power("databases") && user.has_power("files_write")) {
        return Err((
            StatusCode::FORBIDDEN,
            "Permission denied: Missing 'databases_manage' or 'files_write' privilege".to_string(),
        ));
    }
    Ok((user, db))
}

fn database_root(db: &crate::databases::ManagedDatabase) -> std::path::PathBuf {
    let cwd = std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("."));
    let raw = std::path::Path::new(&db.data_dir);
    let root = if raw.is_absolute() {
        raw.to_path_buf()
    } else {
        cwd.join(db.data_dir.trim_start_matches("./").trim_start_matches(".\\"))
    };
    let _ = std::fs::create_dir_all(&root);
    root
}

fn redact_pg_url(url: &str) -> String {
    if let Some(rest) = url.strip_prefix("postgresql://") {
        if let Some((userinfo, hostpart)) = rest.split_once('@') {
            if let Some((user, _pass)) = userinfo.split_once(':') {
                return format!("postgresql://{}:****@{}", user, hostpart);
            }
        }
    }
    String::new()
}

pub(crate) fn redact_db_if_unprivileged(
    mut db: crate::databases::ManagedDatabase,
    can_creds: bool,
) -> crate::databases::ManagedDatabase {
    if !can_creds {
        db.db_password = None;
        db.internal_url = redact_pg_url(&db.internal_url);
        db.external_url = redact_pg_url(&db.external_url);
    }
    db
}

pub(crate) async fn list_databases_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Response, (StatusCode, String)> {
    let user = verify_any_power(&state, &headers, &["databases", "databases_manage"], None)?;
    let can_creds = user.has_any_power(&["databases_manage", "env"]);

    let cache_key = format!("databases:u{}:c{}", user.id, u8::from(can_creds));
    if let Some(res) = check_api_cache(&state.cache, &cache_key) {
        return Ok(res);
    }

    let list: Vec<crate::databases::ManagedDatabase> = state
        .databases
        .list()
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?
        .into_iter()
        .filter(|db| can_access_db(&user, db))
        .map(|db| redact_db_if_unprivileged(db, can_creds))
        .collect();

    cached_json_response(&state.cache, cache_key, &list, std::time::Duration::from_secs(4))
        .map_err(|code| (code, "Serialization error".to_string()))
}

pub(crate) async fn get_database_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxPath(id): AxPath<i64>,
) -> Result<Json<crate::databases::ManagedDatabase>, (StatusCode, String)> {
    let db = state.databases.get(id)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?
        .ok_or_else(|| (StatusCode::NOT_FOUND, "Database not found".to_string()))?;
    let user = verify_db_access(&state, &headers, &["databases", "databases_manage"], &db)?;
    let can_creds = user.has_any_power(&["databases_manage", "env"]);
    Ok(Json(redact_db_if_unprivileged(db, can_creds)))
}

pub(crate) async fn create_database_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<crate::databases::CreateDatabaseInput>,
) -> Result<Json<crate::databases::ManagedDatabase>, (StatusCode, String)> {
    let user = verify_power(&state, &headers, "databases_manage", payload.linked_project_id)?;
    let db = state.databases.create(payload)
        .await
        .map_err(|e| (StatusCode::BAD_REQUEST, e))?;
    state.cache.invalidate_prefix("databases:");
    state.cache.invalidate_prefix("overview:");
    log_audit(&state, &user.username, "database.create", Some(&db.name), Some(&format!("Created PostgreSQL database '{}' on port {}", db.db_name, db.port)));
    Ok(Json(db))
}

async fn run_database_lifecycle<F>(
    state: &AppState,
    headers: &HeaderMap,
    id: i64,
    action_name: &str,
    audit_desc: &str,
    f: F,
) -> Result<Json<crate::databases::ManagedDatabase>, (StatusCode, String)>
where
    F: std::future::Future<Output = Result<(), String>>,
{
    let db = state.databases.get(id)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?
        .ok_or_else(|| (StatusCode::NOT_FOUND, "Database not found".to_string()))?;
    let user = verify_db_access(state, headers, &["databases", "databases_manage"], &db)?;
    let can_creds = user.has_any_power(&["databases_manage", "env"]);
    f.await.map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
    state.cache.invalidate_prefix("databases:");
    state.cache.invalidate_prefix("overview:");
    log_audit(state, &user.username, action_name, Some(&format!("DB #{}", id)), Some(audit_desc));
    let updated = state.databases.get(id).map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?
        .ok_or_else(|| (StatusCode::NOT_FOUND, "Database not found".to_string()))?;
    Ok(Json(redact_db_if_unprivileged(updated, can_creds)))
}

pub(crate) async fn start_database_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxPath(id): AxPath<i64>,
) -> Result<Json<crate::databases::ManagedDatabase>, (StatusCode, String)> {
    run_database_lifecycle(&state, &headers, id, "database.start", "Started database container", state.databases.start(id)).await
}

pub(crate) async fn stop_database_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxPath(id): AxPath<i64>,
) -> Result<Json<crate::databases::ManagedDatabase>, (StatusCode, String)> {
    run_database_lifecycle(&state, &headers, id, "database.stop", "Stopped database container", state.databases.stop(id)).await
}

pub(crate) async fn restart_database_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxPath(id): AxPath<i64>,
) -> Result<Json<crate::databases::ManagedDatabase>, (StatusCode, String)> {
    run_database_lifecycle(&state, &headers, id, "database.restart", "Restarted database container", state.databases.restart(id)).await
}

pub(crate) async fn update_database_access_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxPath(id): AxPath<i64>,
    Json(payload): Json<crate::databases::UpdateDatabaseAccessInput>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let db = state.databases.get(id)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?
        .ok_or_else(|| (StatusCode::NOT_FOUND, "Database not found".to_string()))?;
    let user = verify_db_access(&state, &headers, &["databases_manage"], &db)?;
    state.databases.update_access(id, payload).await.map_err(|e| (StatusCode::BAD_REQUEST, e))?;
    state.cache.invalidate_prefix("databases:");
    state.cache.invalidate_prefix("overview:");
    log_audit(&state, &user.username, "database.access", Some(&format!("DB #{}", id)), Some("Updated database network access rules"));
    Ok(Json(serde_json::json!({ "ok": true })))
}

pub(crate) async fn delete_database_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxPath(id): AxPath<i64>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let db = state.databases.get(id)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?
        .ok_or_else(|| (StatusCode::NOT_FOUND, "Database not found".to_string()))?;
    let user = verify_db_access(&state, &headers, &["databases_manage"], &db)?;
    state.databases.delete(id).await.map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
    state.cache.invalidate_prefix("databases:");
    state.cache.invalidate_prefix("overview:");
    log_audit(&state, &user.username, "database.delete", Some(&format!("DB #{}", id)), Some("Deleted database container"));
    Ok(Json(serde_json::json!({ "ok": true })))
}

#[derive(Deserialize)]
pub(crate) struct LinkDbPayload {
    #[serde(alias = "projectId", alias = "project_id")]
    project_id: i64,
}

const LINKED_DB_ENV_KEYS: [&str; 6] = [
    "DATABASE_URL",
    "PGHOST",
    "PGPORT",
    "PGUSER",
    "PGPASSWORD",
    "PGDATABASE",
];

fn service_dotenv_path(p: &crate::projects::Project) -> std::path::PathBuf {
    let cwd = std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("."));
    let raw = std::path::Path::new(&p.deploy_dir);
    let base = if raw.is_absolute() {
        raw.to_path_buf()
    } else {
        cwd.join(p.deploy_dir.trim_start_matches("./").trim_start_matches(".\\"))
    };
    base.join("app").join(".env")
}

fn strip_linked_db_env_lines(content: &str) -> Vec<String> {
    content
        .lines()
        .filter(|line| {
            line.split_once('=')
                .map(|(k, _)| !LINKED_DB_ENV_KEYS.contains(&k.trim()))
                .unwrap_or(true)
        })
        .map(|line| line.to_string())
        .collect()
}

pub(crate) async fn link_database_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxPath(id): AxPath<i64>,
    Json(payload): Json<LinkDbPayload>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let p = fetch_project(&state.projects, payload.project_id)?;
    let db = state.databases.get(id)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?
        .ok_or_else(|| (StatusCode::NOT_FOUND, "Database not found".to_string()))?;
    let _ = verify_db_access(&state, &headers, &["databases_manage"], &db)?;
    let user = verify_power(&state, &headers, "env", Some(p.id))?;

    let raw_pass = db.db_password.unwrap_or_default();
    let port_str = db.port.to_string();
    let internal_url = format!("postgresql://{}:{}@127.0.0.1:{}/{}", db.db_user, raw_pass, port_str, db.db_name);
    let entries: [(&str, &str, bool); 6] = [
        (LINKED_DB_ENV_KEYS[0], &internal_url, true),
        (LINKED_DB_ENV_KEYS[1], "127.0.0.1", false),
        (LINKED_DB_ENV_KEYS[2], &port_str, false),
        (LINKED_DB_ENV_KEYS[3], &db.db_user, false),
        (LINKED_DB_ENV_KEYS[4], &raw_pass, true),
        (LINKED_DB_ENV_KEYS[5], &db.db_name, false),
    ];

    for (key, val, is_secret) in entries {
        state.projects.set_env_var(p.id, key, val, is_secret)
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    }

    state.databases.set_linked_project(id, Some(p.id)).map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
    state.cache.invalidate_project(p.id);
    state.cache.invalidate_prefix("databases:");
    state.cache.invalidate_prefix("overview:");

    let is_service = p.project_kind == "service";
    let target_noun = if is_service { "service" } else { "website" };

    if is_service {
        let dotenv_path = service_dotenv_path(&p);
        if dotenv_path.exists() {
            if let Ok(content) = tokio::fs::read_to_string(&dotenv_path).await {
                let mut lines = strip_linked_db_env_lines(&content);
                for (key, val, _) in entries {
                    lines.push(format!("{}={}", key, val));
                }
                let _ = tokio::fs::write(&dotenv_path, lines.join("\n") + "\n").await;
            }
        }
    }

    log_audit(&state, &user.username, "database.link", Some(&db.name), Some(&format!("Linked database '{}' to {} '{}'", db.name, target_noun, p.name)));
    Ok(Json(serde_json::json!({
        "ok": true,
        "message": format!("Database linked to {} '{}' and credentials injected!", target_noun, p.name)
    })))
}

pub(crate) async fn unlink_database_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxPath(id): AxPath<i64>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let db = state.databases.get(id)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?
        .ok_or_else(|| (StatusCode::NOT_FOUND, "Database not found".to_string()))?;
    let actor = verify_db_access(&state, &headers, &["databases_manage"], &db)?;
    let old_proj = db.linked_project_id.and_then(|pid| state.projects.get(pid).ok().flatten());
    if let Some(ref p) = old_proj {
        let _ = verify_power(&state, &headers, "env", Some(p.id))?;
    }

    if let Some(ref p) = old_proj {
        for key in LINKED_DB_ENV_KEYS {
            let _ = state.projects.delete_env_var(p.id, key);
        }
        if p.project_kind == "service" {
            let dotenv_path = service_dotenv_path(p);
            if dotenv_path.exists() {
                if let Ok(content) = tokio::fs::read_to_string(&dotenv_path).await {
                    let lines = strip_linked_db_env_lines(&content);
                    let out = if lines.is_empty() { String::new() } else { lines.join("\n") + "\n" };
                    let _ = tokio::fs::write(&dotenv_path, out).await;
                }
            }
        }
        state.cache.invalidate_project(p.id);
    }

    let target_noun = if old_proj.as_ref().map(|p| p.project_kind.as_str()) == Some("service") { "service" } else { "website" };
    let desc = format!("Unlinked database from {}", target_noun);
    state.databases.set_linked_project(id, None)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
    state.cache.invalidate_prefix("databases:");
    state.cache.invalidate_prefix("overview:");
    log_audit(&state, &actor.username, "database.unlink", Some(&db.name), Some(&desc));

    Ok(Json(serde_json::json!({ "ok": true, "message": desc })))
}

fn classify_pg_log_level(line: &str) -> &'static str {
    let upper = line.to_ascii_uppercase();
    if upper.contains("FATAL:") || upper.contains("PANIC:") || upper.contains("ERROR:") {
        "error"
    } else if upper.contains("WARNING:") {
        "warn"
    } else {
        "info"
    }
}

pub(crate) async fn get_database_logs_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxPath(id): AxPath<i64>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let (_user, db) = get_authorized_database(&state, &headers, &["databases", "databases_manage"], id)?;

    let log_content = state
        .databases
        .get_logs(id)
        .unwrap_or_else(|e| format!("Error reading log file: {}", e));

    let db_tag = format!("[DB #{}]", id);
    let mut entries: Vec<serde_json::Value> = state
        .logs
        .list(None, None, Some("database"), None, 150)
        .into_iter()
        .filter(|e| e.message.contains(&db_tag) || e.message.contains(&db.name))
        .map(|e| {
            serde_json::json!({
                "id": e.id,
                "ts": e.ts,
                "level": e.level,
                "channel": e.channel,
                "message": e.message,
            })
        })
        .collect();

    let now_ts = crate::db::now();
    for (idx, line) in log_content.lines().enumerate() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        entries.push(serde_json::json!({
            "id": 1_000_000_000i64 + idx as i64,
            "ts": now_ts,
            "level": classify_pg_log_level(trimmed),
            "channel": "postgres",
            "message": trimmed,
        }));
    }

    Ok(Json(serde_json::json!({
        "id": db.id,
        "name": db.name,
        "status": db.status,
        "port": db.port,
        "logs": log_content,
        "entries": entries
    })))
}

pub(crate) async fn db_files_list_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxPath(id): AxPath<i64>,
    Query(q): Query<FilesQuery>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let (_actor, db) = get_authorized_database(&state, &headers, &["databases", "databases_manage"], id)?;
    let root = database_root(&db);
    list_entries_in_root(&root, &q.path).await
}

pub(crate) async fn db_files_read_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxPath(id): AxPath<i64>,
    Query(q): Query<FilesQuery>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let (actor, db) = get_authorized_database(&state, &headers, &["databases", "databases_manage"], id)?;
    let root = database_root(&db);
    read_file_in_root(&actor, &root, &q.path).await
}

pub(crate) async fn db_files_write_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxPath(id): AxPath<i64>,
    Json(payload): Json<FileWritePayload>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let (actor, db) = verify_db_files_write(&state, &headers, id)?;
    let root = database_root(&db);
    write_file_in_root(&state, &actor, None, &db.name, "database.file.write", &root, payload).await
}

pub(crate) async fn db_files_mkdir_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxPath(id): AxPath<i64>,
    Json(payload): Json<FileMkdirPayload>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let (actor, db) = verify_db_files_write(&state, &headers, id)?;
    let root = database_root(&db);
    mkdir_in_root(&actor, &root, payload).await
}

pub(crate) async fn db_files_delete_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxPath(id): AxPath<i64>,
    Query(q): Query<FilesQuery>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let (actor, db) = verify_db_files_write(&state, &headers, id)?;
    let root = database_root(&db);
    delete_in_root(&state, &actor, None, &db.name, "database.file.delete", &root, &q.path).await
}

pub(crate) async fn db_files_upload_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxPath(id): AxPath<i64>,
    Query(q): Query<FilesQuery>,
    multipart: Multipart,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let (actor, db) = verify_db_files_write(&state, &headers, id)?;
    let root = database_root(&db);
    upload_in_root(&state, &actor, None, &db.name, "database.file.upload", &root, &q.path, multipart).await
}

pub(crate) async fn db_files_download_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxPath(id): AxPath<i64>,
    Query(q): Query<FilesQuery>,
) -> Result<Response, (StatusCode, String)> {
    let (actor, db) = get_authorized_database(&state, &headers, &["databases", "databases_manage"], id)?;
    let root = database_root(&db);
    download_in_root(&actor, &root, &q.path).await
}

pub(crate) async fn db_files_rename_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxPath(id): AxPath<i64>,
    Json(payload): Json<FileRenamePayload>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let (actor, db) = verify_db_files_write(&state, &headers, id)?;
    let root = database_root(&db);
    rename_in_root(&state, &actor, None, &db.name, "database.file.rename", &root, payload).await
}

#[cfg(test)]
mod tests {
    use super::{classify_pg_log_level, redact_db_if_unprivileged};
    use crate::databases::ManagedDatabase;

    fn sample_db() -> ManagedDatabase {
        ManagedDatabase {
            id: 1,
            name: "appdb".to_string(),
            engine: "postgres".to_string(),
            db_name: "app".to_string(),
            db_user: "webdep".to_string(),
            db_password: Some("super-secret-pass".to_string()),
            port: 5432,
            is_superuser: false,
            access_mode: "local".to_string(),
            allowed_ips: "".to_string(),
            domain: "db.example.com".to_string(),
            status: "running".to_string(),
            container_id: None,
            data_dir: "/tmp/db".to_string(),
            linked_project_id: Some(7),
            linked_project_name: Some("web".to_string()),
            internal_url: "postgresql://webdep:super-secret-pass@127.0.0.1:5432/app".to_string(),
            external_url: "postgresql://webdep:super-secret-pass@db.example.com:5432/app?sslmode=prefer".to_string(),
            psql_command: "psql -h db.example.com -p 5432 -U webdep -d app".to_string(),
            created_at: 0,
            updated_at: 0,
        }
    }

    #[test]
    fn test_redact_db_if_unprivileged() {
        let redacted = redact_db_if_unprivileged(sample_db(), false);
        assert!(redacted.db_password.is_none());
        assert_eq!(redacted.internal_url, "postgresql://webdep:****@127.0.0.1:5432/app");
        assert_eq!(redacted.external_url, "postgresql://webdep:****@db.example.com:5432/app?sslmode=prefer");
        assert_eq!(redacted.psql_command, "psql -h db.example.com -p 5432 -U webdep -d app");

        let full = redact_db_if_unprivileged(sample_db(), true);
        assert_eq!(full.db_password.as_deref(), Some("super-secret-pass"));
        assert!(full.internal_url.contains("super-secret-pass"));
    }

    #[test]
    fn test_classify_pg_log_level() {
        assert_eq!(classify_pg_log_level("2026-11-13 LOG: database system is ready"), "info");
        assert_eq!(classify_pg_log_level("2026-11-13 WARNING: deprecated setting"), "warn");
        assert_eq!(classify_pg_log_level("2026-11-13 ERROR: role does not exist"), "error");
        assert_eq!(classify_pg_log_level("2026-11-13 FATAL: password authentication failed"), "error");
    }
}
