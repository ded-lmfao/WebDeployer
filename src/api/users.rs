use axum::{
    extract::{Path as AxPath, State},
    http::{HeaderMap, StatusCode},
    Json,
};
use serde::Deserialize;

use super::common::*;
use crate::auth::hash_password;

pub(crate) async fn admin_reset_user_2fa_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxPath(id): AxPath<i64>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let actor = verify_main_admin(&state, &headers)?;
    if !actor.is_main_admin {
        return Err((
            StatusCode::FORBIDDEN,
            "Only the Main Admin can reset another user's 2FA.".to_string(),
        ));
    }

    let target = state
        .auth
        .get_user_by_id(id)
        .ok_or_else(|| (StatusCode::NOT_FOUND, "User not found".to_string()))?;

    {
        let conn = state.db.lock().unwrap();
        conn.execute(
            "UPDATE users SET totp_secret = NULL, totp_pending_secret = NULL, totp_enabled = 0, totp_backup_codes = '[]' WHERE id = ?",
            rusqlite::params![id],
        )
        .map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, "Database error".to_string()))?;
    }

    state.auth.invalidate_sessions();
    state.cache.invalidate_all();

    log_audit(
        &state,
        &actor.username,
        "user.update",
        Some(&target.username),
        Some("Main Admin reset Two-Factor Authentication for user"),
    );

    Ok(Json(serde_json::json!({ "ok": true })))
}



pub(crate) async fn list_users_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Vec<User>>, (StatusCode, String)> {
    let _actor = verify_main_admin(&state, &headers)?;
    let list = state
        .auth
        .list_users()
        .map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, "Database error".to_string()))?;
    Ok(Json(list))
}

#[derive(Deserialize)]
pub(crate) struct CreateUserPayload {
    username: String,
    password: String,
    role: Option<String>,
    permissions: Option<Vec<String>>,
    #[serde(rename = "allProjects")]
    all_projects: Option<bool>,
    #[serde(rename = "allowedProjects")]
    allowed_projects: Option<Vec<i64>>,
}

pub(crate) async fn create_user_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<CreateUserPayload>,
) -> Result<Json<User>, (StatusCode, String)> {
    let actor = verify_main_admin(&state, &headers)?;

    let uname = payload.username.trim().to_string();
    if uname.is_empty() || payload.password.len() < 6 {
        return Err((StatusCode::BAD_REQUEST, "Username and password (min 6 chars) required".into()));
    }

    let hashed = hash_password(&payload.password)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;

    let role = payload.role.unwrap_or_else(|| "operator".to_string());
    let perms = payload.permissions.unwrap_or_else(|| {
        if role == "admin" {
            vec!["*".to_string()]
        } else if role == "operator" {
            vec!["deploy".to_string(), "process".to_string(), "logs".to_string(), "backups".to_string()]
        } else {
            vec!["logs".to_string()]
        }
    });
    let perms_json = serde_json::to_string(&perms).unwrap_or_else(|_| "[]".into());

    let all_projs = payload.all_projects.unwrap_or(true);
    let allowed_json = if all_projs {
        "[\"*\"]".to_string()
    } else {
        serde_json::to_string(&payload.allowed_projects.unwrap_or_default()).unwrap_or_else(|_| "[]".into())
    };

    let ts = now();

    let id = {
        let conn = state.db.lock().unwrap();
        conn.execute(
            "INSERT INTO users(username, password_hash, salt, role, disabled, permissions, allowed_projects, created_at) VALUES(?, ?, '', ?, 0, ?, ?, ?)",
            rusqlite::params![uname, hashed, role, perms_json, allowed_json, ts],
        ).map_err(|e| (StatusCode::BAD_REQUEST, format!("Could not create user: {}", e)))?;
        conn.last_insert_rowid()
    };

    log_audit(&state, &actor.username, "user.create", Some(&uname), Some(&format!("role={}", role)));

    Ok(Json(User::from_db(
        id,
        uname,
        role,
        0,
        perms_json,
        allowed_json,
        0,
        ts,
    )))
}

#[derive(Deserialize)]
pub(crate) struct UpdateUserPayload {
    disabled: Option<serde_json::Value>,
    role: Option<String>,
    password: Option<String>,
    permissions: Option<Vec<String>>,
    #[serde(rename = "allProjects")]
    all_projects: Option<bool>,
    #[serde(rename = "allowedProjects")]
    allowed_projects: Option<Vec<i64>>,
}

pub(crate) async fn update_user_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxPath(id): AxPath<i64>,
    Json(payload): Json<UpdateUserPayload>,
) -> Result<Json<User>, (StatusCode, String)> {
    let actor = verify_main_admin(&state, &headers)?;

    let existing = state
        .auth
        .get_user_by_id(id)
        .ok_or_else(|| (StatusCode::NOT_FOUND, "User not found".to_string()))?;

    if existing.is_main_admin && !actor.is_main_admin {
        return Err((StatusCode::FORBIDDEN, "Only the Main Admin can modify the Main Admin account.".into()));
    }

    let conn = state.db.lock().unwrap();

    if let Some(pwd) = payload.password.as_ref().map(|s| s.trim()).filter(|s| !s.is_empty()) {
        if pwd.len() < 6 {
            return Err((StatusCode::BAD_REQUEST, "Password must be at least 6 characters".into()));
        }
        let hashed = hash_password(pwd).map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
        conn.execute("UPDATE users SET password_hash=? WHERE id=?", rusqlite::params![hashed, id]).ok();
        if existing.is_main_admin {
            crate::config::Config::sync_dotenv_admin(Some(&existing.username), Some(pwd));
        }
    }

    if !existing.is_main_admin {
        if let Some(r) = payload.role.as_ref() {
            conn.execute("UPDATE users SET role=? WHERE id=?", rusqlite::params![r, id]).ok();
        }
        if let Some(d_val) = payload.disabled {
            let is_disabled = match d_val {
                serde_json::Value::Bool(b) => b,
                serde_json::Value::Number(n) => n.as_i64().unwrap_or(0) != 0,
                serde_json::Value::String(s) => s == "1" || s.eq_ignore_ascii_case("true"),
                _ => false,
            };
            conn.execute(
                "UPDATE users SET disabled=? WHERE id=?",
                rusqlite::params![if is_disabled { 1 } else { 0 }, id],
            )
            .ok();
            if is_disabled {
                conn.execute("DELETE FROM sessions WHERE user_id=?", rusqlite::params![id]).ok();
            }
        }
        if let Some(perms) = payload.permissions.as_ref() {
            let perms_json = serde_json::to_string(perms).unwrap_or_else(|_| "[]".into());
            conn.execute("UPDATE users SET permissions=? WHERE id=?", rusqlite::params![perms_json, id]).ok();
        }
        if payload.all_projects.is_some() || payload.allowed_projects.is_some() {
            let all_p = payload.all_projects.unwrap_or(false);
            let allowed_json = if all_p {
                "[\"*\"]".to_string()
            } else {
                serde_json::to_string(&payload.allowed_projects.unwrap_or_default()).unwrap_or_else(|_| "[]".into())
            };
            conn.execute("UPDATE users SET allowed_projects=? WHERE id=?", rusqlite::params![allowed_json, id]).ok();
        }
    }

    drop(conn);
    log_audit(&state, &actor.username, "user.update", Some(&existing.username), None);

    let updated = state
        .auth
        .get_user_by_id(id)
        .ok_or_else(|| (StatusCode::NOT_FOUND, "User not found".to_string()))?;

    Ok(Json(updated))
}

pub(crate) async fn delete_user_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxPath(id): AxPath<i64>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let actor = verify_main_admin(&state, &headers)?;

    let target = state
        .auth
        .get_user_by_id(id)
        .ok_or_else(|| (StatusCode::NOT_FOUND, "User not found".to_string()))?;

    if target.is_main_admin {
        return Err((StatusCode::BAD_REQUEST, "Cannot delete the Main Admin account.".into()));
    }
    if target.id == actor.id {
        return Err((StatusCode::BAD_REQUEST, "Cannot delete your own currently logged-in account.".into()));
    }

    {
        let conn = state.db.lock().unwrap();
        conn.execute("DELETE FROM sessions WHERE user_id = ?", rusqlite::params![id]).ok();
        conn.execute("DELETE FROM users WHERE id = ?", rusqlite::params![id])
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    }

    log_audit(&state, &actor.username, "user.delete", Some(&target.username), Some("Deleted user account"));

    Ok(Json(serde_json::json!({ "ok": true })))
}
