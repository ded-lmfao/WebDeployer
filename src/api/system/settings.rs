use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    Json,
};
use std::collections::HashMap;

use crate::api::common::*;

pub(crate) async fn restart_panel_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let actor = verify_main_admin(&state, &headers)?;
    log_audit(
        &state,
        &actor.username,
        "system.restart",
        Some("platform"),
        Some("Restarted the WebDep panel"),
    );
    state.logs.add(None, None, "system", "warn", &format!("Panel restart requested by {}", actor.username));

    crate::updater::restart_service_delayed(600);

    Ok(Json(serde_json::json!({ "ok": true, "message": "Panel is restarting" })))
}

pub(crate) async fn system_version_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<crate::updater::GitVersionInfo>, (StatusCode, String)> {
    let _actor = current_user(&state, &headers)
        .ok_or_else(|| (StatusCode::UNAUTHORIZED, "Unauthorized".to_string()))?;
    Ok(Json(state.updater.get_version_info()))
}

pub(crate) async fn system_update_status_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<crate::updater::UpdateStatus>, (StatusCode, String)> {
    let _actor = current_user(&state, &headers)
        .ok_or_else(|| (StatusCode::UNAUTHORIZED, "Unauthorized".to_string()))?;
    Ok(Json(state.updater.get_status()))
}

pub(crate) async fn system_update_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    payload: Option<Json<crate::updater::TriggerUpdatePayload>>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let actor = verify_main_admin(&state, &headers)?;
    log_audit(
        &state,
        &actor.username,
        "system.update",
        Some("platform"),
        Some("Triggered 1-click platform update from Git repository"),
    );
    state.logs.add(None, None, "system", "warn", &format!("1-Click platform update triggered by {}", actor.username));

    let branch = payload.and_then(|p| p.branch.clone());
    state.updater.start_update(branch)
        .map_err(|e| (StatusCode::BAD_REQUEST, e))?;

    Ok(Json(serde_json::json!({ "ok": true, "message": "Update sequence started" })))
}

pub(crate) async fn system_update_repo_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<crate::updater::SetUpdateRepoPayload>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let actor = verify_main_admin(&state, &headers)?;
    let remote_url = state.updater.set_remote_repo(&payload.repo)
        .map_err(|e| (StatusCode::BAD_REQUEST, e))?;

    log_audit(
        &state,
        &actor.username,
        "system.update_repo",
        Some("platform"),
        Some(&format!("Changed platform update origin repository to {}", remote_url)),
    );
    state.logs.add(
        None,
        None,
        "system",
        "info",
        &format!("Platform update repository updated to '{}' by {}", remote_url, actor.username),
    );

    Ok(Json(serde_json::json!({ "ok": true, "remote_url": remote_url })))
}

pub(crate) async fn cache_stats_handler(State(state): State<AppState>) -> Json<crate::cache::CacheStats> {
    Json(state.cache.stats())
}

pub(crate) async fn cache_clear_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let actor = current_user(&state, &headers)
        .ok_or_else(|| (StatusCode::UNAUTHORIZED, "Unauthorized".to_string()))?;
    {
        let conn = state.db.lock().unwrap();
        crate::db::purge_orphaned_project_data(&conn);
    }
    state.cache.invalidate_all();
    log_audit(
        &state,
        &actor.username,
        "cache.clear",
        Some("platform"),
        Some("Flushed server in-memory response cache and purged orphaned website data"),
    );
    Ok(Json(serde_json::json!({
        "ok": true,
        "stats": state.cache.stats()
    })))
}

pub(crate) async fn get_settings_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<HashMap<String, String>>, (StatusCode, String)> {
    let _actor = verify_power(&state, &headers, "settings_manage", None)?;
    let (mut map, current_tok) = {
        let conn = state.db.lock().unwrap();
        let mut stmt = conn
            .prepare("SELECT key, value FROM settings")
            .map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, "Database error".to_string()))?;
        let rows = stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
            .map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, "Database error".to_string()))?;

        let mut map = HashMap::new();
        for r in rows.flatten() {
            map.insert(r.0, r.1);
        }
        let current_tok = map.get("github_token").cloned().unwrap_or_default();
        (map, current_tok)
    };

    // If github_token is not yet saved in SQLite, try auto-detecting from gh CLI once and persisting it
    if current_tok.trim().is_empty() {
        if let Ok(out) = tokio::process::Command::new("gh").args(["auth", "token"]).output().await {
            if out.status.success() {
                let detected = String::from_utf8_lossy(&out.stdout).trim().to_string();
                if !detected.is_empty() {
                    let conn = state.db.lock().unwrap();
                    conn.execute(
                        "INSERT INTO settings(key, value) VALUES('github_token', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                        rusqlite::params![&detected],
                    ).ok();
                    map.insert("github_token".to_string(), detected);
                }
            }
        }
    }

    // Build unified list of configured GitHub tokens
    let mut tok_list: Vec<crate::git::StoredGithubToken> = map
        .get("github_tokens")
        .and_then(|raw| serde_json::from_str::<Vec<crate::git::StoredGithubToken>>(raw).ok())
        .unwrap_or_default()
        .into_iter()
        .filter(|t| !t.token.trim().is_empty())
        .collect();

    if tok_list.is_empty() {
        for part in current_tok.split(|c| c == ',' || c == '\n' || c == ';') {
            let trimmed = part.trim();
            if !trimmed.is_empty() {
                tok_list.push(crate::git::StoredGithubToken {
                    label: format!("Account #{}", tok_list.len() + 1),
                    token: trimmed.to_string(),
                });
            }
        }
    }

    if !tok_list.is_empty() {
        if let Ok(serialized) = serde_json::to_string(&tok_list) {
            map.insert("github_tokens".to_string(), serialized);
        }
        let first_tok = tok_list[0].token.trim();
        let suffix = if first_tok.len() >= 4 { &first_tok[first_tok.len() - 4..] } else { "****" };
        map.insert("github_token_configured".to_string(), "true".to_string());
        map.insert("github_token_count".to_string(), tok_list.len().to_string());
        map.insert(
            "github_token_masked".to_string(),
            if tok_list.len() > 1 {
                format!("{} tokens configured (••••••••{})", tok_list.len(), suffix)
            } else {
                format!("••••••••{}", suffix)
            },
        );
    }

    Ok(Json(map))
}

pub(crate) async fn update_settings_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<HashMap<String, serde_json::Value>>,
) -> Result<StatusCode, (StatusCode, String)> {
    let actor = verify_power(&state, &headers, "settings_manage", None)?;
    let conn = state.db.lock().unwrap();
    for (k, v) in payload {
        if k == "github_tokens" {
            let tokens_vec: Vec<crate::git::StoredGithubToken> = if let Some(arr) = v.as_array() {
                arr.iter()
                    .filter_map(|item| serde_json::from_value::<crate::git::StoredGithubToken>(item.clone()).ok())
                    .filter(|t| !t.token.trim().is_empty())
                    .collect()
            } else if let Some(s) = v.as_str() {
                serde_json::from_str::<Vec<crate::git::StoredGithubToken>>(s)
                    .unwrap_or_default()
                    .into_iter()
                    .filter(|t| !t.token.trim().is_empty())
                    .collect()
            } else {
                Vec::new()
            };

            let json_str = serde_json::to_string(&tokens_vec).unwrap_or_else(|_| "[]".to_string());
            conn.execute(
                "INSERT INTO settings(key, value) VALUES('github_tokens', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                rusqlite::params![json_str],
            ).ok();

            let primary = tokens_vec.first().map(|t| t.token.trim().to_string()).unwrap_or_default();
            conn.execute(
                "INSERT INTO settings(key, value) VALUES('github_token', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                rusqlite::params![primary],
            ).ok();
            continue;
        }

        let val_str = match v {
            serde_json::Value::String(s) => s.trim().to_string(),
            serde_json::Value::Number(n) => n.to_string(),
            serde_json::Value::Bool(b) => b.to_string(),
            _ => v.to_string(),
        };
        if k == "github_token" && val_str.is_empty() {
            continue;
        }
        conn.execute(
            "INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            rusqlite::params![k, val_str],
        ).ok();
    }
    drop(conn);
    log_audit(&state, &actor.username, "settings.update", Some("platform"), Some("Updated global deployment & GitHub settings"));
    Ok(StatusCode::OK)
}

