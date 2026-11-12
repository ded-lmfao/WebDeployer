use axum::{
    extract::{Path as AxPath, State},
    http::{HeaderMap, StatusCode},
    response::Response,
    Json,
};
use serde::Deserialize;

use super::common::*;

// ---------------------------------------------------------------------------
// Managed Databases (PostgreSQL)
// ---------------------------------------------------------------------------
pub(crate) async fn list_databases_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Response, (StatusCode, String)> {
    let _user = current_user(&state, &headers)
        .ok_or_else(|| (StatusCode::UNAUTHORIZED, "Unauthorized".to_string()))?;

    let cache_key = "databases:all".to_string();
    if let Some(res) = check_api_cache(&state.cache, &cache_key) {
        return Ok(res);
    }

    let list = state.databases.list().map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;

    cached_json_response(&state.cache, cache_key, &list, std::time::Duration::from_secs(4))
        .map_err(|code| (code, "Serialization error".to_string()))
}

pub(crate) async fn get_database_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxPath(id): AxPath<i64>,
) -> Result<Json<crate::databases::ManagedDatabase>, (StatusCode, String)> {
    let _user = current_user(&state, &headers)
        .ok_or_else(|| (StatusCode::UNAUTHORIZED, "Unauthorized".to_string()))?;
    let db = state.databases.get(id)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?
        .ok_or_else(|| (StatusCode::NOT_FOUND, "Database not found".to_string()))?;
    Ok(Json(db))
}

pub(crate) async fn create_database_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<crate::databases::CreateDatabaseInput>,
) -> Result<Json<crate::databases::ManagedDatabase>, (StatusCode, String)> {
    let user = current_user(&state, &headers)
        .ok_or_else(|| (StatusCode::UNAUTHORIZED, "Unauthorized".to_string()))?;
    let db = state.databases.create(payload)
        .await
        .map_err(|e| (StatusCode::BAD_REQUEST, e))?;
    state.cache.invalidate_prefix("databases:");
    state.cache.invalidate_prefix("overview:");
    log_audit(&state, &user.username, "database.create", Some(&db.name), Some(&format!("Created PostgreSQL database '{}' on port {}", db.db_name, db.port)));
    Ok(Json(db))
}

pub(crate) async fn perform_database_action<F>(
    state: &AppState,
    headers: &HeaderMap,
    id: i64,
    action_name: &str,
    audit_desc: &str,
    f: F,
) -> Result<Json<serde_json::Value>, (StatusCode, String)>
where
    F: std::future::Future<Output = Result<(), String>>,
{
    let user = require_current_user(state, headers)?;
    f.await.map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
    state.cache.invalidate_prefix("databases:");
    state.cache.invalidate_prefix("overview:");
    log_audit(state, &user.username, action_name, Some(&format!("DB #{}", id)), Some(audit_desc));
    Ok(Json(serde_json::json!({ "ok": true })))
}

pub(crate) async fn start_database_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxPath(id): AxPath<i64>,
) -> Result<Json<crate::databases::ManagedDatabase>, (StatusCode, String)> {
    let user = require_current_user(&state, &headers)?;
    state.databases.start(id).await.map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
    state.cache.invalidate_prefix("databases:");
    state.cache.invalidate_prefix("overview:");
    log_audit(&state, &user.username, "database.start", Some(&format!("DB #{}", id)), Some("Started database container"));
    let updated = state.databases.get(id).map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?
        .ok_or_else(|| (StatusCode::NOT_FOUND, "Database not found".to_string()))?;
    Ok(Json(updated))
}

pub(crate) async fn stop_database_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxPath(id): AxPath<i64>,
) -> Result<Json<crate::databases::ManagedDatabase>, (StatusCode, String)> {
    let user = require_current_user(&state, &headers)?;
    state.databases.stop(id).await.map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
    state.cache.invalidate_prefix("databases:");
    state.cache.invalidate_prefix("overview:");
    log_audit(&state, &user.username, "database.stop", Some(&format!("DB #{}", id)), Some("Stopped database container"));
    let updated = state.databases.get(id).map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?
        .ok_or_else(|| (StatusCode::NOT_FOUND, "Database not found".to_string()))?;
    Ok(Json(updated))
}

pub(crate) async fn restart_database_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxPath(id): AxPath<i64>,
) -> Result<Json<crate::databases::ManagedDatabase>, (StatusCode, String)> {
    let user = require_current_user(&state, &headers)?;
    state.databases.restart(id).await.map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
    state.cache.invalidate_prefix("databases:");
    state.cache.invalidate_prefix("overview:");
    log_audit(&state, &user.username, "database.restart", Some(&format!("DB #{}", id)), Some("Restarted database container"));
    let updated = state.databases.get(id).map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?
        .ok_or_else(|| (StatusCode::NOT_FOUND, "Database not found".to_string()))?;
    Ok(Json(updated))
}

pub(crate) async fn update_database_access_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxPath(id): AxPath<i64>,
    Json(payload): Json<crate::databases::UpdateDatabaseAccessInput>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let user = require_current_user(&state, &headers)?;
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
    perform_database_action(&state, &headers, id, "database.delete", "Deleted database container", state.databases.delete(id)).await
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
    let user = verify_power(&state, &headers, "env", Some(p.id))?;
    let db = state.databases.get(id)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?
        .ok_or_else(|| (StatusCode::NOT_FOUND, "Database not found".to_string()))?;

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
    let old_proj = db.linked_project_id.and_then(|pid| state.projects.get(pid).ok().flatten());
    let actor = match old_proj.as_ref() {
        Some(p) => verify_power(&state, &headers, "env", Some(p.id))?,
        None => require_current_user(&state, &headers)?,
    };

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

pub(crate) async fn get_database_logs_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxPath(id): AxPath<i64>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let _user = current_user(&state, &headers)
        .ok_or_else(|| (StatusCode::UNAUTHORIZED, "Unauthorized".to_string()))?;
    let db = state.databases.get(id)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?
        .ok_or_else(|| (StatusCode::NOT_FOUND, "Database not found".to_string()))?;

    let log_content = state.databases.get_logs(id)
        .unwrap_or_else(|e| format!("Error reading log file: {}", e));

    Ok(Json(serde_json::json!({
        "id": db.id,
        "name": db.name,
        "status": db.status,
        "port": db.port,
        "logs": log_content
    })))
}
