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

pub(crate) async fn link_database_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxPath(id): AxPath<i64>,
    Json(payload): Json<LinkDbPayload>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let user = current_user(&state, &headers)
        .ok_or_else(|| (StatusCode::UNAUTHORIZED, "Unauthorized".to_string()))?;
    let db = state.databases.get(id)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?
        .ok_or_else(|| (StatusCode::NOT_FOUND, "Database not found".to_string()))?;

    let p = fetch_project(&state.projects, payload.project_id)?;
    let raw_pass = db.db_password.unwrap_or_default();
    let internal_url = format!("postgresql://{}:{}@127.0.0.1:{}/{}", db.db_user, raw_pass, db.port, db.db_name);

    state.projects.set_env_var(p.id, "DATABASE_URL", &internal_url, true).map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    state.projects.set_env_var(p.id, "PGHOST", "127.0.0.1", false).map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    state.projects.set_env_var(p.id, "PGPORT", &db.port.to_string(), false).map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    state.projects.set_env_var(p.id, "PGUSER", &db.db_user, false).map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    state.projects.set_env_var(p.id, "PGPASSWORD", &raw_pass, true).map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    state.projects.set_env_var(p.id, "PGDATABASE", &db.db_name, false).map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    state.databases.set_linked_project(id, Some(p.id)).map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
    state.cache.invalidate_project(p.id);
    state.cache.invalidate_prefix("databases:");
    state.cache.invalidate_prefix("overview:");

    let is_service = p.project_kind == "service";
    let target_noun = if is_service { "service" } else { "website" };

    if is_service {
        let cwd = std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("."));
        let raw = std::path::Path::new(&p.deploy_dir);
        let base = if raw.is_absolute() {
            raw.to_path_buf()
        } else {
            cwd.join(p.deploy_dir.trim_start_matches("./").trim_start_matches(".\\"))
        };
        let app_dir = base.join("app");
        let dotenv_path = app_dir.join(".env");
        if dotenv_path.exists() {
            if let Ok(content) = tokio::fs::read_to_string(&dotenv_path).await {
                let mut lines: Vec<String> = content.lines()
                    .filter(|l| !l.starts_with("DATABASE_URL=") && !l.starts_with("PGHOST=") && !l.starts_with("PGPORT=") && !l.starts_with("PGUSER=") && !l.starts_with("PGPASSWORD=") && !l.starts_with("PGDATABASE="))
                    .map(|l| l.to_string())
                    .collect();
                lines.push(format!("DATABASE_URL={}", internal_url));
                lines.push("PGHOST=127.0.0.1".to_string());
                lines.push(format!("PGPORT={}", db.port));
                lines.push(format!("PGUSER={}", db.db_user));
                lines.push(format!("PGPASSWORD={}", raw_pass));
                lines.push(format!("PGDATABASE={}", db.db_name));
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
    let db = state.databases.get(id).map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?.ok_or_else(|| (StatusCode::NOT_FOUND, "Database not found".to_string()))?;
    let old_proj = db.linked_project_id.and_then(|pid| state.projects.get(pid).ok().flatten());
    let target_noun = if old_proj.as_ref().map(|p| p.project_kind.as_str()) == Some("service") { "service" } else { "website" };
    let desc = format!("Unlinked database from {}", target_noun);
    perform_database_action(&state, &headers, id, "database.unlink", &desc, async {
        state.databases.set_linked_project(id, None)
    }).await
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
