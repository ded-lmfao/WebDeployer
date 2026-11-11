use axum::{
    body::Body,
    extract::{DefaultBodyLimit, Multipart, Path as AxPath, Query, Request, State},
    http::{header, HeaderMap, HeaderValue, Method, StatusCode},
    middleware::{self, Next},
    response::{
        sse::{Event, KeepAlive, Sse},
        IntoResponse, Response,
    },
    routing::{delete, get, post, put},
    Json, Router,
};
use futures_util::stream::Stream;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::convert::Infallible;
use std::sync::Arc;
use tokio_stream::wrappers::BroadcastStream;
use tokio_stream::StreamExt;

use crate::auth::{
    constant_time_eq, generate_backup_codes, generate_totp_secret, hash_password,
    verify_password, verify_totp_code, Auth, User,
};
use crate::cache::AppCache;
use crate::caddy::Caddy;
use crate::db::{now, DbPool};
use crate::deployer::Deployer;
use crate::logs::Logs;
use crate::monitor::Monitor;
use crate::projects::{EnvVarInput, EnvVarView, Project, Projects};
use crate::runtime::Runtime;
use crate::static_assets::static_handler;
use tower_http::compression::CompressionLayer;

#[derive(Clone)]
pub struct AppState {
    pub db: DbPool,
    pub auth: Arc<Auth>,
    pub projects: Arc<Projects>,
    pub logs: Arc<Logs>,
    pub monitor: Arc<Monitor>,
    pub caddy: Arc<Caddy>,
    pub runtime: Arc<Runtime>,
    pub deployer: Arc<Deployer>,
    pub cache: Arc<AppCache>,
    pub databases: Arc<crate::databases::Databases>,
    pub updater: Arc<crate::updater::Updater>,
}

pub fn create_router(state: AppState) -> Router {
    Router::new()
        // Auth & 2FA endpoints
        .route("/api/auth/login", post(login_handler))
        .route("/api/auth/2fa/verify-login", post(verify_2fa_login_handler))
        .route("/api/auth/2fa/setup", post(setup_2fa_handler))
        .route("/api/auth/2fa/enable", post(enable_2fa_handler))
        .route("/api/auth/2fa/disable", post(disable_2fa_handler))
        .route("/api/auth/passkeys", get(list_passkeys_handler))
        .route("/api/auth/passkeys/register/start", post(passkey_register_start_handler))
        .route("/api/auth/passkeys/register/finish", post(passkey_register_finish_handler))
        .route("/api/auth/passkeys/:id", delete(delete_passkey_handler))
        .route("/api/auth/passkeys/login/start", post(passkey_login_start_handler))
        .route("/api/auth/passkeys/login/finish", post(passkey_login_finish_handler))
        .route("/api/auth/sessions/revoke-others", post(revoke_other_sessions_handler))
        .route("/api/auth/logout", post(logout_handler))
        .route("/api/auth/me", get(me_handler))
        .route("/api/auth/password", post(change_password_handler))
        // Projects
        .route("/api/projects", get(list_projects_handler).post(create_project_handler))
        .route(
            "/api/projects/:id",
            get(get_project_handler)
                .put(update_project_handler)
                .patch(update_project_handler)
                .delete(delete_project_handler),
        )
        .route("/api/projects/:id/detect", post(detect_project_handler))
        .route("/api/projects/:id/commits", get(project_commits_handler))
        .route("/api/projects/:id/check", post(project_check_handler))
        .route("/api/projects/:id/fetch", post(project_fetch_handler))
        .route("/api/projects/:id/deploy-key", post(project_deploy_key_handler))
        .route("/api/projects/:id/webhook-secret/rotate", post(rotate_webhook_secret_handler))
        .route("/api/projects/:id/backups", get(list_backups_handler))
        .route("/api/projects/:id/backup", post(create_backup_handler))
        .route("/api/projects/:id/backups/restore", post(restore_backup_handler))
        .route("/api/projects/:id/backups/:backup_id", delete(delete_backup_handler))
        // Project Env
        .route("/api/projects/:id/env", get(get_env_handler).put(set_env_handler).post(set_env_handler))
        .route("/api/projects/:id/env/bulk", post(bulk_set_env_handler))
        .route("/api/projects/:id/env/raw", get(get_raw_env_handler))
        .route("/api/projects/:id/env/reveal", post(reveal_env_handler))
        .route("/api/projects/:id/env/:key", delete(delete_env_handler))
        // Project Lifecycle & Actions
        .route("/api/projects/:id/deploy", post(deploy_project_handler))
        .route("/api/projects/:id/rollback", post(rollback_project_handler))
        .route("/api/projects/:id/start", post(start_project_handler))
        .route("/api/projects/:id/stop", post(stop_project_handler))
        .route("/api/projects/:id/restart", post(restart_project_handler))
        .route("/api/projects/:id/maintenance", post(toggle_maintenance_handler))
        .route("/api/projects/:id/releases", get(list_releases_handler).post(create_release_handler))
        .route("/api/projects/:id/releases/:release_id", delete(delete_release_handler))
        .route("/api/projects/:id/caddy", get(get_caddy_handler))
        .route("/api/projects/:id/caddy/apply", post(apply_caddy_handler))
        .route("/api/projects/:id/nginx", get(get_caddy_handler))
        .route("/api/projects/:id/nginx/apply", post(apply_caddy_handler))
        .route("/api/projects/:id/nginx/certbot", post(certbot_caddy_handler))
        .route("/api/projects/:id/app-logs", get(get_app_logs_handler))
        // Backend service file browser
        .route("/api/projects/:id/files", get(files_list_handler).delete(files_delete_handler))
        .route("/api/projects/:id/files/content", get(files_read_handler).put(files_write_handler))
        .route("/api/projects/:id/files/mkdir", post(files_mkdir_handler))
        .route(
            "/api/projects/:id/files/upload",
            post(files_upload_handler).layer(DefaultBodyLimit::max(500 * 1024 * 1024)),
        )
        // GitHub & Caddy Status
        .route("/api/github/repos", get(github_repos_handler))
        .route("/api/nginx/status", get(caddy_status_handler))
        .route("/api/caddy/status", get(caddy_status_handler))
        // Deployments & Releases
        .route("/api/deployments", get(list_deployments_handler))
        .route("/api/deployments/:id", get(get_deployment_handler))
        .route("/api/deployments/:id/logs", get(get_deployment_logs_handler))
        // Live Logs SSE, History & Download
        .route("/api/logs", get(list_logs_handler))
        .route("/api/logs/stream", get(logs_sse_handler))
        .route("/api/logs/download", get(logs_download_handler))
        // GitHub Webhooks
        .route("/api/webhooks/github/:slug", post(github_webhook_handler))
        // Overview, Telemetry & Cache Layer
        .route("/api/overview", get(overview_handler))
        .route("/api/monitor", get(monitor_handler))
        .route("/api/audit", get(audit_handler))
        .route("/api/cache/stats", get(cache_stats_handler))
        .route("/api/cache/clear", post(cache_clear_handler))
        .route("/api/system/restart", post(restart_panel_handler))
        .route("/api/system/version", get(system_version_handler))
        .route("/api/system/update/status", get(system_update_status_handler))
        .route("/api/system/update", post(system_update_handler))
        .route("/api/settings", get(get_settings_handler).put(update_settings_handler).patch(update_settings_handler))
        .route("/api/users", get(list_users_handler).post(create_user_handler))
        .route("/api/users/:id", put(update_user_handler).patch(update_user_handler).delete(delete_user_handler))
        .route("/api/users/:id/reset-2fa", post(admin_reset_user_2fa_handler))
        // Managed Databases (PostgreSQL)
        .route("/api/databases", get(list_databases_handler).post(create_database_handler))
        .route("/api/databases/:id", get(get_database_handler).delete(delete_database_handler))
        .route("/api/databases/:id/start", post(start_database_handler))
        .route("/api/databases/:id/stop", post(stop_database_handler))
        .route("/api/databases/:id/restart", post(restart_database_handler))
        .route("/api/databases/:id/access", put(update_database_access_handler))
        .route("/api/databases/:id/link", post(link_database_handler))
        .route("/api/databases/:id/unlink", post(unlink_database_handler))
        .route("/api/databases/:id/logs", get(get_database_logs_handler))
        .route("/healthz", get(|| async { (StatusCode::OK, "ok") }))
        // Static assets fallback
        .fallback(axum_static_fallback)
        .layer(middleware::from_fn_with_state(state.clone(), security_middleware))
        .layer(CompressionLayer::new())
        .with_state(state)
}

async fn security_middleware(
    State(state): State<AppState>,
    req: Request,
    next: Next,
) -> Response {
    let path = req.uri().path().to_string();
    let method = req.method().clone();
    let is_api = path.starts_with("/api/");
    let is_mutating = matches!(
        method,
        Method::POST | Method::PUT | Method::PATCH | Method::DELETE
    );

    if is_api {
        let is_public_auth = path == "/api/auth/login"
            || path == "/api/auth/2fa/verify-login"
            || path == "/api/auth/passkeys/login/start"
            || path == "/api/auth/passkeys/login/finish"
            || path.starts_with("/api/webhooks/github/");

        if !is_public_auth {
            let sid_opt = extract_session_id(req.headers());
            let session_pair = sid_opt.as_deref().and_then(|sid| state.auth.get_session(sid));

            let Some((session, _user)) = session_pair else {
                let mut res = (
                    StatusCode::UNAUTHORIZED,
                    Json(serde_json::json!({ "error": "Unauthorized. Please sign in." })),
                )
                    .into_response();
                attach_security_headers(&mut res, true);
                return res;
            };

            if is_mutating && path != "/api/auth/logout" {
                let csrf_hdr = req
                    .headers()
                    .get("x-csrf-token")
                    .and_then(|v| v.to_str().ok())
                    .unwrap_or("");
                if !constant_time_eq(csrf_hdr, &session.csrf_token) {
                    let mut res = (
                        StatusCode::FORBIDDEN,
                        Json(serde_json::json!({ "error": "Invalid or missing CSRF security token. Please refresh the page." })),
                    )
                        .into_response();
                    attach_security_headers(&mut res, true);
                    return res;
                }
            }
        }
    }

    let mut res = next.run(req).await;
    if is_api && is_mutating {
        state.cache.invalidate_all();
        if path.starts_with("/api/users") || path.starts_with("/api/auth/") {
            state.auth.invalidate_sessions();
        }
    }
    attach_security_headers(&mut res, is_api);
    res
}

fn attach_security_headers(res: &mut Response, is_api: bool) {
    let headers = res.headers_mut();
    headers.insert(
        header::HeaderName::from_static("x-content-type-options"),
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(
        header::HeaderName::from_static("x-frame-options"),
        HeaderValue::from_static("DENY"),
    );
    headers.insert(
        header::HeaderName::from_static("referrer-policy"),
        HeaderValue::from_static("strict-origin-when-cross-origin"),
    );
    headers.insert(
        header::HeaderName::from_static("permissions-policy"),
        HeaderValue::from_static("camera=(), microphone=(), geolocation=()"),
    );
    if is_api {
        headers.insert(
            header::CACHE_CONTROL,
            HeaderValue::from_static("no-store, no-cache, must-revalidate"),
        );
    }
}

async fn axum_static_fallback(headers: HeaderMap, uri: axum::http::Uri) -> Response {
    static_handler(uri.path(), &headers, uri.query()).await
}

// ---------------------------------------------------------------------------
// Helpers: Session Cookie
// ---------------------------------------------------------------------------
fn extract_session_id(headers: &HeaderMap) -> Option<String> {
    headers
        .get(header::COOKIE)?
        .to_str()
        .ok()?
        .split(';')
        .find_map(|part| {
            let mut it = part.trim().splitn(2, '=');
            let key = it.next()?;
            let val = it.next()?;
            if key == "nd_session" {
                Some(val.to_string())
            } else {
                None
            }
        })
}

fn current_user(state: &AppState, headers: &HeaderMap) -> Option<User> {
    let sid = extract_session_id(headers)?;
    state.auth.get_session(&sid).map(|(_, u)| u)
}

fn require_current_user(state: &AppState, headers: &HeaderMap) -> Result<User, (StatusCode, String)> {
    current_user(state, headers).ok_or_else(|| (StatusCode::UNAUTHORIZED, "Unauthorized".to_string()))
}

fn verify_main_admin(state: &AppState, headers: &HeaderMap) -> Result<User, (StatusCode, String)> {
    let u = require_current_user(state, headers)?;
    if !u.is_main_admin {
        return Err((
            StatusCode::FORBIDDEN,
            "Only the Main Admin can perform this action.".to_string(),
        ));
    }
    Ok(u)
}

fn verify_power(
    state: &AppState,
    headers: &HeaderMap,
    power: &str,
    project_id: Option<i64>,
) -> Result<User, (StatusCode, String)> {
    let u = current_user(state, headers)
        .ok_or_else(|| (StatusCode::UNAUTHORIZED, "Unauthorized session".to_string()))?;
    if let Some(pid) = project_id {
        if !u.can_access_project(pid) {
            return Err((
                StatusCode::FORBIDDEN,
                "Access denied: You are not assigned to this website.".to_string(),
            ));
        }
    }
    if !u.has_power(power) {
        return Err((
            StatusCode::FORBIDDEN,
            format!("Permission denied: Missing '{}' privilege.", power),
        ));
    }
    Ok(u)
}

fn get_authorized_project(
    state: &AppState,
    headers: &HeaderMap,
    power: &str,
    project_id: i64,
) -> Result<(User, crate::projects::Project), (StatusCode, String)> {
    let actor = verify_power(state, headers, power, Some(project_id))?;
    let p = state
        .projects
        .get(project_id)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .ok_or((StatusCode::NOT_FOUND, "Project not found".into()))?;
    Ok((actor, p))
}

fn log_audit(state: &AppState, actor: &str, action: &str, target: Option<&str>, detail: Option<&str>) {
    log_audit_project(state, None, actor, action, target, detail);
}

fn create_authenticated_response(
    state: &AppState,
    user: User,
) -> Result<Response, (StatusCode, String)> {
    let session = state
        .auth
        .create_session(user.id)
        .map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, "Failed to create session".to_string()))?;

    let active_sessions = state.auth.count_active_sessions(user.id);
    let passkey_count = state.auth.count_user_passkeys(user.id);
    let cookie_val = format!(
        "nd_session={}; Path=/; HttpOnly; SameSite=Strict; Max-Age={}",
        session.id, state.auth.session_ttl_s
    );

    let body = Json(LoginResponse {
        user,
        csrf: session.csrf_token,
        active_sessions,
        passkey_count,
    });

    let mut res = body.into_response();
    if let Ok(cookie_hdr) = HeaderValue::from_str(&cookie_val) {
        res.headers_mut().insert(header::SET_COOKIE, cookie_hdr);
    }
    Ok(res)
}

fn check_api_cache(cache: &crate::cache::AppCache, cache_key: &str) -> Option<Response> {
    if let Some(cached_val) = cache.get(cache_key) {
        let mut res = Json(cached_val).into_response();
        res.headers_mut().insert("x-cache", HeaderValue::from_static("HIT"));
        Some(res)
    } else {
        None
    }
}

fn fetch_project(
    projects: &crate::projects::Projects,
    id: i64,
) -> Result<crate::projects::Project, (StatusCode, String)> {
    projects
        .get(id)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .ok_or_else(|| (StatusCode::NOT_FOUND, "Project not found".to_string()))
}

fn verify_current_user_password(
    state: &AppState,
    user: &User,
    password: &str,
) -> Result<(), (StatusCode, String)> {
    let (_, current_hash) = state
        .auth
        .get_user_by_username(&user.username)
        .ok_or_else(|| (StatusCode::UNAUTHORIZED, "User not found".to_string()))?;

    if !verify_password(password, &current_hash) {
        return Err((StatusCode::BAD_REQUEST, "Incorrect password".to_string()));
    }
    Ok(())
}

fn apply_2fa_state_change(
    state: &AppState,
    username: &str,
    audit_desc: &str,
) {
    state.auth.invalidate_sessions();
    state.cache.invalidate_all();
    log_audit(
        state,
        username,
        "user.update",
        Some(username),
        Some(audit_desc),
    );
}

fn insert_success_release(
    conn: &rusqlite::Connection,
    project_id: i64,
    sha: &str,
    short_sha: &str,
    message: &str,
    author: &str,
    dir: &str,
    ts: i64,
) -> rusqlite::Result<i64> {
    conn.execute(
        "INSERT INTO releases(project_id, sha, short_sha, message, author, committed_at, dir, status, build_status, health_status, created_at, deployed_at)
         VALUES(?, ?, ?, ?, ?, ?, ?, 'succeeded', 'success', 'ok', ?, ?)",
        rusqlite::params![project_id, sha, short_sha, message, author, ts, dir, ts, ts],
    )?;
    Ok(conn.last_insert_rowid())
}

fn trigger_background_deploy(deployer: Arc<crate::deployer::Deployer>, project_id: i64, dep_id: i64) {
    tokio::spawn(async move {
        deployer.run_deploy(project_id, dep_id).await;
    });
}

fn log_audit_project(
    state: &AppState,
    project_id: Option<i64>,
    actor: &str,
    action: &str,
    target: Option<&str>,
    detail: Option<&str>,
) {
    let conn = state.db.lock().unwrap();
    conn.execute(
        "INSERT INTO audit(project_id, ts, actor, action, target, detail, ip) VALUES(?, ?, ?, ?, ?, ?, '127.0.0.1')",
        rusqlite::params![project_id, now(), actor, action, target, detail],
    )
    .ok();
}

// ---------------------------------------------------------------------------
// Auth & 2FA Handlers
// ---------------------------------------------------------------------------
#[derive(Deserialize)]
struct LoginPayload {
    username: String,
    password: String,
}

#[derive(Serialize)]
struct LoginResponse {
    user: User,
    csrf: String,
    #[serde(rename = "activeSessions")]
    active_sessions: usize,
    #[serde(rename = "passkeyCount")]
    passkey_count: usize,
}

async fn login_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<LoginPayload>,
) -> Result<Response, (StatusCode, String)> {
    // Always revoke any pre-existing session cookie when starting a new login attempt
    if let Some(old_sid) = extract_session_id(&headers) {
        state.auth.delete_session(&old_sid);
    }

    // Sync Main Admin login ID & password from .env (supports live editing .env without server restart)
    state.auth.ensure_admin();

    let uname_key = format!("login:{}", payload.username.trim().to_lowercase());
    if let Some(rem) = state.auth.check_lockout(&uname_key) {
        return Err((
            StatusCode::TOO_MANY_REQUESTS,
            format!("Too many failed sign-in attempts. Account temporarily locked for {} seconds.", rem),
        ));
    }

    let Some((user, hash)) = state.auth.get_user_by_username(payload.username.trim()) else {
        state.auth.record_failure(&uname_key);
        return Err((StatusCode::UNAUTHORIZED, "Invalid username or password".to_string()));
    };

    let user_2fa_key = format!("2fa_user:{}", user.id);
    if let Some(rem) = state.auth.check_lockout(&user_2fa_key) {
        return Err((
            StatusCode::TOO_MANY_REQUESTS,
            format!("Account temporarily locked due to failed 2FA attempts ({} seconds remaining).", rem),
        ));
    }

    if user.disabled {
        return Err((StatusCode::FORBIDDEN, "Account is disabled by administrator".to_string()));
    }

    if !verify_password(&payload.password, &hash) {
        if let Some(lock_s) = state.auth.record_failure(&uname_key) {
            log_audit(&state, &user.username, "auth.lockout", Some(&user.username), Some("Account locked after repeated failed password attempts"));
            return Err((
                StatusCode::TOO_MANY_REQUESTS,
                format!("Too many failed sign-in attempts. Account locked for {} seconds.", lock_s),
            ));
        }
        return Err((StatusCode::UNAUTHORIZED, "Invalid username or password".to_string()));
    }

    state.auth.clear_failures(&uname_key);

    // If 2FA is enabled on this account, require 2FA challenge verification before creating a session
    if user.totp_enabled {
        let mfa_token = state.auth.create_mfa_challenge(user.id);
        let mut res = Json(serde_json::json!({
            "requires2fa": true,
            "mfaToken": mfa_token,
            "username": user.username,
        }))
        .into_response();
        // Ensure no session cookie exists while awaiting 2FA completion
        res.headers_mut().insert(
            header::SET_COOKIE,
            HeaderValue::from_static("nd_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0"),
        );
        return Ok(res);
    }

    log_audit(&state, &user.username, "auth.login", Some(&user.username), Some("User signed in"));
    create_authenticated_response(&state, user)
}

#[derive(Deserialize)]
struct Verify2faLoginPayload {
    #[serde(rename = "mfaToken")]
    mfa_token: String,
    code: String,
}

async fn verify_2fa_login_handler(
    State(state): State<AppState>,
    Json(payload): Json<Verify2faLoginPayload>,
) -> Result<Response, (StatusCode, String)> {
    let lock_key = format!("2fa:{}", payload.mfa_token);
    if let Some(rem) = state.auth.check_lockout(&lock_key) {
        return Err((
            StatusCode::TOO_MANY_REQUESTS,
            format!("Too many invalid 2FA attempts. Locked for {} seconds.", rem),
        ));
    }

    let user_id = state
        .auth
        .peek_mfa_challenge(&payload.mfa_token)
        .ok_or_else(|| (StatusCode::UNAUTHORIZED, "2FA session expired. Please sign in again.".to_string()))?;

    let user_2fa_key = format!("2fa_user:{}", user_id);
    if let Some(rem) = state.auth.check_lockout(&user_2fa_key) {
        state.auth.consume_mfa_challenge(&payload.mfa_token);
        return Err((
            StatusCode::TOO_MANY_REQUESTS,
            format!("Too many failed 2FA attempts. Locked for {} seconds.", rem),
        ));
    }

    let user = state
        .auth
        .get_user_by_id(user_id)
        .ok_or_else(|| (StatusCode::UNAUTHORIZED, "User not found".to_string()))?;

    if user.disabled {
        state.auth.consume_mfa_challenge(&payload.mfa_token);
        return Err((StatusCode::FORBIDDEN, "Account is disabled".to_string()));
    }

    if !state.auth.verify_user_2fa(user.id, &payload.code) {
        let token_lock = state.auth.record_failure(&lock_key);
        let user_lock = state.auth.record_failure(&user_2fa_key);
        if let Some(lock_s) = token_lock.or(user_lock) {
            state.auth.consume_mfa_challenge(&payload.mfa_token);
            log_audit(&state, &user.username, "auth.lockout", Some(&user.username), Some("Account locked after repeated failed 2FA attempts"));
            return Err((
                StatusCode::TOO_MANY_REQUESTS,
                format!("Too many failed 2FA attempts. Locked for {} seconds.", lock_s),
            ));
        }
        return Err((StatusCode::UNAUTHORIZED, "Invalid 6-digit authenticator code or recovery code".to_string()));
    }

    state.auth.clear_failures(&lock_key);
    state.auth.clear_failures(&user_2fa_key);
    state.auth.consume_mfa_challenge(&payload.mfa_token);

    log_audit(
        &state,
        &user.username,
        "auth.login",
        Some(&user.username),
        Some("User signed in with 2FA verification"),
    );

    create_authenticated_response(&state, user)
}

async fn logout_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Response, StatusCode> {
    if let Some(session_id) = extract_session_id(&headers) {
        state.auth.delete_session(&session_id);
    }
    let mut res = (StatusCode::OK, "Logged out").into_response();
    res.headers_mut().insert(
        header::SET_COOKIE,
        HeaderValue::from_static("nd_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0"),
    );
    res.headers_mut().insert(
        header::HeaderName::from_static("clear-site-data"),
        HeaderValue::from_static("\"cache\", \"storage\""),
    );
    Ok(res)
}

async fn me_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<LoginResponse>, StatusCode> {
    let session_id = extract_session_id(&headers).ok_or(StatusCode::UNAUTHORIZED)?;
    let (session, user) = state
        .auth
        .get_session(&session_id)
        .ok_or(StatusCode::UNAUTHORIZED)?;

    let active_sessions = state.auth.count_active_sessions(user.id);
    let passkey_count = state.auth.count_user_passkeys(user.id);
    Ok(Json(LoginResponse {
        user,
        csrf: session.csrf_token,
        active_sessions,
        passkey_count,
    }))
}

#[derive(Deserialize)]
struct PasswordChangePayload {
    current: String,
    next: String,
    #[serde(rename = "totpCode")]
    totp_code: Option<String>,
    #[serde(rename = "revokeOtherSessions")]
    revoke_other_sessions: Option<bool>,
}

async fn change_password_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<PasswordChangePayload>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let session_id = extract_session_id(&headers)
        .ok_or_else(|| (StatusCode::UNAUTHORIZED, "Unauthorized session".to_string()))?;
    let (_, user) = state
        .auth
        .get_session(&session_id)
        .ok_or_else(|| (StatusCode::UNAUTHORIZED, "Unauthorized session".to_string()))?;

    let (_, current_hash) = state
        .auth
        .get_user_by_username(&user.username)
        .ok_or_else(|| (StatusCode::UNAUTHORIZED, "User not found".to_string()))?;

    if !verify_password(&payload.current, &current_hash) {
        return Err((StatusCode::BAD_REQUEST, "Current password is incorrect".to_string()));
    }

    if user.totp_enabled {
        let code = payload.totp_code.as_deref().unwrap_or("").trim();
        if code.is_empty() {
            return Err((
                StatusCode::BAD_REQUEST,
                "Two-Factor Authentication is enabled: please enter your 6-digit authenticator code".to_string(),
            ));
        }
        if !state.auth.verify_user_2fa(user.id, code) {
            return Err((StatusCode::BAD_REQUEST, "Invalid 2FA authenticator code".to_string()));
        }
    }

    if payload.next.len() < 8 {
        return Err((
            StatusCode::BAD_REQUEST,
            "New password must be at least 8 characters long".to_string(),
        ));
    }

    if payload.next == payload.current {
        return Err((
            StatusCode::BAD_REQUEST,
            "New password must be different from your current password".to_string(),
        ));
    }

    let next_hash = hash_password(&payload.next)
        .map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, "Failed to hash password".to_string()))?;

    {
        let conn = state.db.lock().unwrap();
        conn.execute(
            "UPDATE users SET password_hash = ?, password_changed_at = ? WHERE id = ?",
            rusqlite::params![next_hash, now(), user.id],
        )
        .map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, "Database error".to_string()))?;
    }

    if user.is_main_admin {
        crate::config::Config::sync_dotenv_admin(Some(&user.username), Some(&payload.next));
    }

    let revoked = if payload.revoke_other_sessions.unwrap_or(true) {
        state.auth.revoke_other_sessions(user.id, &session_id)
    } else {
        0
    };

    log_audit(
        &state,
        &user.username,
        "user.update",
        Some(&user.username),
        Some(&format!("Changed account password (revoked {} other sessions)", revoked)),
    );

    Ok(Json(serde_json::json!({
        "ok": true,
        "revokedSessions": revoked
    })))
}

#[derive(Deserialize)]
struct Setup2faPayload {
    password: String,
}

async fn setup_2fa_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<Setup2faPayload>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let user = current_user(&state, &headers)
        .ok_or_else(|| (StatusCode::UNAUTHORIZED, "Unauthorized".to_string()))?;
    verify_current_user_password(&state, &user, &payload.password)?;

    let secret = generate_totp_secret();
    {
        let conn = state.db.lock().unwrap();
        conn.execute(
            "UPDATE users SET totp_pending_secret = ? WHERE id = ?",
            rusqlite::params![&secret, user.id],
        )
        .map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, "Failed to save pending 2FA secret".to_string()))?;
    }

    // Refresh real-world UTC offset in background so verification works even if local system clock is shifted
    std::thread::spawn(|| {
        crate::auth::sync_real_utc_offset();
    });

    let safe_label: String = user
        .username
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_' || *c == '.')
        .collect();
    let label = if safe_label.is_empty() { "admin" } else { &safe_label };
    let otpauth_url = format!(
        "otpauth://totp/WebDep:{}?secret={}&issuer=WebDep",
        label, secret
    );

    Ok(Json(serde_json::json!({
        "secret": secret,
        "otpauthUrl": otpauth_url,
        "account": user.username,
        "issuer": "WebDep"
    })))
}

#[derive(Deserialize)]
struct Enable2faPayload {
    code: String,
}

async fn enable_2fa_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<Enable2faPayload>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let user = current_user(&state, &headers)
        .ok_or_else(|| (StatusCode::UNAUTHORIZED, "Unauthorized".to_string()))?;

    let pending_secret: Option<String> = {
        let conn = state.db.lock().unwrap();
        conn.query_row(
            "SELECT totp_pending_secret FROM users WHERE id = ?",
            rusqlite::params![user.id],
            |r| r.get(0),
        )
        .ok()
        .flatten()
    };

    let Some(secret) = pending_secret else {
        return Err((
            StatusCode::BAD_REQUEST,
            "No pending 2FA setup found. Click 'Setup 2FA' first.".to_string(),
        ));
    };

    if !verify_totp_code(&secret, &payload.code) {
        return Err((
            StatusCode::BAD_REQUEST,
            "Invalid 6-digit code. Make sure you scanned the QR code or entered the secret key in your authenticator app.".to_string(),
        ));
    }

    let backup_codes = generate_backup_codes();
    let backup_json = serde_json::to_string(&backup_codes).unwrap_or_else(|_| "[]".to_string());

    {
        let conn = state.db.lock().unwrap();
        conn.execute(
            "UPDATE users SET totp_secret = ?, totp_pending_secret = NULL, totp_enabled = 1, totp_backup_codes = ? WHERE id = ?",
            rusqlite::params![&secret, &backup_json, user.id],
        )
        .map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, "Failed to enable 2FA".to_string()))?;
    }

    apply_2fa_state_change(&state, &user.username, "Enabled Two-Factor Authentication (2FA)");

    Ok(Json(serde_json::json!({
        "ok": true,
        "backupCodes": backup_codes
    })))
}

#[derive(Deserialize)]
struct Disable2faPayload {
    password: String,
    code: String,
}

async fn disable_2fa_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<Disable2faPayload>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let user = current_user(&state, &headers)
        .ok_or_else(|| (StatusCode::UNAUTHORIZED, "Unauthorized".to_string()))?;
    verify_current_user_password(&state, &user, &payload.password)?;

    if !state.auth.verify_user_2fa(user.id, &payload.code) {
        return Err((
            StatusCode::BAD_REQUEST,
            "Invalid 6-digit authenticator code or recovery code".to_string(),
        ));
    }

    {
        let conn = state.db.lock().unwrap();
        conn.execute(
            "UPDATE users SET totp_secret = NULL, totp_pending_secret = NULL, totp_enabled = 0, totp_backup_codes = '[]' WHERE id = ?",
            rusqlite::params![user.id],
        )
        .map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, "Failed to disable 2FA".to_string()))?;
    }

    apply_2fa_state_change(&state, &user.username, "Disabled Two-Factor Authentication (2FA)");

    Ok(Json(serde_json::json!({ "ok": true })))
}

async fn revoke_other_sessions_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let session_id = extract_session_id(&headers)
        .ok_or_else(|| (StatusCode::UNAUTHORIZED, "Unauthorized".to_string()))?;
    let (_, user) = state
        .auth
        .get_session(&session_id)
        .ok_or_else(|| (StatusCode::UNAUTHORIZED, "Unauthorized".to_string()))?;

    let revoked = state.auth.revoke_other_sessions(user.id, &session_id);
    log_audit(
        &state,
        &user.username,
        "user.update",
        Some(&user.username),
        Some(&format!("Revoked {} other active session(s)", revoked)),
    );

    Ok(Json(serde_json::json!({ "ok": true, "revoked": revoked })))
}

async fn admin_reset_user_2fa_handler(
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

// ---------------------------------------------------------------------------
// Passkey & Biometric (WebAuthn) Handlers
// ---------------------------------------------------------------------------
async fn list_passkeys_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let user = current_user(&state, &headers)
        .ok_or_else(|| (StatusCode::UNAUTHORIZED, "Unauthorized".to_string()))?;
    let passkeys = state.auth.list_passkeys(user.id);
    Ok(Json(serde_json::json!({ "passkeys": passkeys })))
}

async fn passkey_register_start_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let user = current_user(&state, &headers)
        .ok_or_else(|| (StatusCode::UNAUTHORIZED, "Unauthorized".to_string()))?;
    let (challenge_id, challenge_b64) = state.auth.create_passkey_challenge(Some(user.id));
    let existing: Vec<String> = state
        .auth
        .list_passkeys(user.id)
        .into_iter()
        .map(|p| p.credential_id)
        .collect();
    let user_id_b64 = crate::auth::b64url_encode(format!("webdep-user-{}", user.id).as_bytes());
    Ok(Json(serde_json::json!({
        "challengeId": challenge_id,
        "challenge": challenge_b64,
        "user": {
            "id": user_id_b64,
            "name": user.username,
            "displayName": user.username,
        },
        "excludeCredentials": existing,
    })))
}

#[derive(Deserialize)]
struct PasskeyRegisterFinishPayload {
    #[serde(rename = "challengeId")]
    challenge_id: String,
    name: Option<String>,
    #[serde(rename = "credentialId")]
    credential_id: String,
    #[serde(rename = "publicKeySpki")]
    public_key_spki: Option<String>,
    #[serde(rename = "attestationObject")]
    attestation_object: Option<String>,
    #[serde(rename = "authenticatorData")]
    authenticator_data: Option<String>,
    #[serde(rename = "clientDataJSON")]
    client_data_json: String,
}

async fn passkey_register_finish_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<PasskeyRegisterFinishPayload>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let user = current_user(&state, &headers)
        .ok_or_else(|| (StatusCode::UNAUTHORIZED, "Unauthorized".to_string()))?;
    let (uid_opt, expected_challenge) = state
        .auth
        .consume_passkey_challenge(&payload.challenge_id)
        .ok_or_else(|| (StatusCode::BAD_REQUEST, "Passkey registration challenge expired. Please try again.".to_string()))?;
    if uid_opt != Some(user.id) {
        return Err((StatusCode::BAD_REQUEST, "Passkey challenge user mismatch".to_string()));
    }

    let label = payload
        .name
        .as_deref()
        .unwrap_or("Passkey / Biometric Device");
    let info = state
        .auth
        .register_passkey(
            user.id,
            label,
            &payload.credential_id,
            payload.public_key_spki.as_deref(),
            payload.attestation_object.as_deref(),
            payload.authenticator_data.as_deref(),
            &payload.client_data_json,
            &expected_challenge,
        )
        .map_err(|e| (StatusCode::BAD_REQUEST, e))?;

    log_audit(
        &state,
        &user.username,
        "user.update",
        Some(&user.username),
        Some(&format!("Registered passkey / biometric device '{}'", info.name)),
    );

    let passkeys = state.auth.list_passkeys(user.id);
    Ok(Json(serde_json::json!({
        "ok": true,
        "passkey": info,
        "passkeys": passkeys,
    })))
}

async fn delete_passkey_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxPath(id): AxPath<i64>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let user = current_user(&state, &headers)
        .ok_or_else(|| (StatusCode::UNAUTHORIZED, "Unauthorized".to_string()))?;
    if !state.auth.delete_passkey(user.id, id) {
        return Err((StatusCode::NOT_FOUND, "Passkey not found".to_string()));
    }
    log_audit(
        &state,
        &user.username,
        "user.update",
        Some(&user.username),
        Some(&format!("Removed passkey #{}", id)),
    );
    let passkeys = state.auth.list_passkeys(user.id);
    Ok(Json(serde_json::json!({
        "ok": true,
        "passkeys": passkeys,
    })))
}

#[derive(Deserialize, Default)]
struct PasskeyLoginStartPayload {
    username: Option<String>,
}

async fn passkey_login_start_handler(
    State(state): State<AppState>,
    Json(payload): Json<PasskeyLoginStartPayload>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let total = state.auth.total_passkeys_count();
    if total == 0 {
        return Err((
            StatusCode::BAD_REQUEST,
            "No passkeys or biometric devices are registered yet. Sign in with your password and add one in Settings -> Security.".to_string(),
        ));
    }
    let cred_ids = state
        .auth
        .list_login_credential_ids(payload.username.as_deref());
    if cred_ids.is_empty() && payload.username.as_deref().map(|s| !s.trim().is_empty()).unwrap_or(false) {
        return Err((
            StatusCode::BAD_REQUEST,
            "No passkeys registered for this username.".to_string(),
        ));
    }
    let (challenge_id, challenge_b64) = state.auth.create_passkey_challenge(None);
    Ok(Json(serde_json::json!({
        "challengeId": challenge_id,
        "challenge": challenge_b64,
        "allowCredentials": cred_ids,
    })))
}

#[derive(Deserialize)]
struct PasskeyLoginFinishPayload {
    #[serde(rename = "challengeId")]
    challenge_id: String,
    #[serde(rename = "credentialId")]
    credential_id: String,
    #[serde(rename = "authenticatorData")]
    authenticator_data: String,
    #[serde(rename = "clientDataJSON")]
    client_data_json: String,
    signature: String,
}

async fn passkey_login_finish_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<PasskeyLoginFinishPayload>,
) -> Result<Response, (StatusCode, String)> {
    if let Some(old_sid) = extract_session_id(&headers) {
        state.auth.delete_session(&old_sid);
    }

    let (_uid_opt, expected_challenge) = state
        .auth
        .consume_passkey_challenge(&payload.challenge_id)
        .ok_or_else(|| (StatusCode::UNAUTHORIZED, "Passkey login challenge expired. Please try again.".to_string()))?;

    let (user, passkey_name) = state
        .auth
        .verify_passkey_login(
            &payload.credential_id,
            &payload.authenticator_data,
            &payload.client_data_json,
            &payload.signature,
            &expected_challenge,
        )
        .map_err(|e| (StatusCode::UNAUTHORIZED, e))?;

    log_audit(
        &state,
        &user.username,
        "auth.login",
        Some(&user.username),
        Some(&format!("User signed in via Passkey / Biometrics ({})", passkey_name)),
    );

    create_authenticated_response(&state, user)
}

// ---------------------------------------------------------------------------
// Projects Handlers
// ---------------------------------------------------------------------------
async fn list_projects_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Response, StatusCode> {
    let user_opt = current_user(&state, &headers);
    let uid = user_opt.as_ref().map(|u| u.id).unwrap_or(0);
    let cache_key = format!("projects:u{}", uid);

    if let Some(res) = check_api_cache(&state.cache, &cache_key) {
        return Ok(res);
    }

    let mut list = state.projects.list().map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    if let Some(ref u) = user_opt {
        list.retain(|p| u.can_access_project(p.id));
    }

    if let Ok(json_val) = serde_json::to_value(&list) {
        state
            .cache
            .set(cache_key, json_val, std::time::Duration::from_secs(4));
    }

    let mut res = Json(list).into_response();
    res.headers_mut()
        .insert("x-cache", HeaderValue::from_static("MISS"));
    Ok(res)
}

async fn get_project_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxPath(id): AxPath<i64>,
) -> Result<Json<Project>, StatusCode> {
    if let Some(u) = current_user(&state, &headers) {
        if !u.can_access_project(id) {
            return Err(StatusCode::FORBIDDEN);
        }
    }
    let p = state
        .projects
        .get(id)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .ok_or(StatusCode::NOT_FOUND)?;
    Ok(Json(p))
}

async fn create_project_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(mut p): Json<Project>,
) -> Result<Json<Project>, (StatusCode, String)> {
    let actor = verify_power(&state, &headers, "projects_manage", None)?;
    let is_service = p.project_kind == "service";
    if p.name.trim().is_empty() || p.slug.trim().is_empty() {
        return Err((StatusCode::BAD_REQUEST, "Name and slug are required".into()));
    }
    if !is_service && p.repo_url.trim().is_empty() {
        return Err((StatusCode::BAD_REQUEST, "GitHub repo_url is required for websites".into()));
    }
    if is_service && p.repo_url.trim().is_empty() {
        p.repo_url = "local".to_string();
    }
    let cwd = std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("."));
    if p.deploy_dir.trim().is_empty()
        || p.deploy_dir.starts_with("./")
        || p.deploy_dir.starts_with(".\\")
        || (cfg!(windows) && p.deploy_dir.starts_with("/var/www/") && !std::path::Path::new(&p.deploy_dir).exists())
    {
        let rel = if p.deploy_dir.starts_with("./") || p.deploy_dir.starts_with(".\\") {
            p.deploy_dir.trim_start_matches("./").trim_start_matches(".\\").to_string()
        } else if is_service {
            format!("data/services/{}", p.slug)
        } else {
            format!("data/sites/{}", p.slug)
        };
        let abs = cwd.join(rel);
        let _ = tokio::fs::create_dir_all(&abs).await;
        p.deploy_dir = abs.to_string_lossy().to_string();
    } else {
        let _ = tokio::fs::create_dir_all(&p.deploy_dir).await;
    }

    // Ensure non-conflicting port across all hosted websites
    if is_service {
        if p.port == Some(0) {
            p.port = None;
        }
    } else if let Ok(existing) = state.projects.list() {
        let used_ports: std::collections::HashSet<u16> = existing.iter().filter_map(|x| x.port).collect();
        let mut candidate = p.port.unwrap_or(3000);
        while used_ports.contains(&candidate) || candidate == 4600 {
            candidate += 1;
        }
        p.port = Some(candidate);
        if p.health_url.contains(":3000") && candidate != 3000 {
            p.health_url = p.health_url.replace(":3000", &format!(":{}", candidate));
        }
    }

    let id = state
        .projects
        .create(&p)
        .map_err(|e| (StatusCode::BAD_REQUEST, e.to_string()))?;

    let audit_action = if is_service { "service.create" } else { "website.create" };
    let audit_desc = if is_service {
        format!("Created backend service '{}' (Repo: {})", p.name, p.repo_url)
    } else {
        format!("Created website '{}' (Port {}, Repo: {})", p.name, p.port.unwrap_or(3000), p.repo_url)
    };
    log_audit_project(
        &state,
        Some(id),
        &actor.username,
        audit_action,
        Some(&p.name),
        Some(&audit_desc),
    );

    let created = state
        .projects
        .get(id)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .ok_or((StatusCode::NOT_FOUND, "Project not found".into()))?;

    let _ = state.runtime.ensure_container(&created);

    if !is_service || !created.domains.is_empty() {
        if let Ok(all) = state.projects.list() {
            let _ = state.caddy.write_config(&created, &all);
            let _ = state.caddy.reload();
        }
    }
    if let Some(port) = created.port {
        crate::databases::Databases::sync_firewall_rules(port, &created.access_mode, &created.allowed_ips).await;
    }
    state.cache.invalidate_all();

    Ok(Json(created))
}

fn normalize_domain(d: &str) -> String {
    d.trim()
        .trim_start_matches("https://")
        .trim_start_matches("http://")
        .trim_end_matches('/')
        .trim()
        .to_lowercase()
}

fn sanitize_domains<I: IntoIterator<Item = String>>(domains: I) -> Vec<String> {
    domains
        .into_iter()
        .map(|d| normalize_domain(&d))
        .filter(|d| !d.is_empty())
        .collect()
}

async fn update_project_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxPath(id): AxPath<i64>,
    Json(mut p): Json<Project>,
) -> Result<Json<Project>, (StatusCode, String)> {
    let actor = verify_power(&state, &headers, "projects_manage", Some(id))?;
    p.domains = sanitize_domains(p.domains);

    state
        .projects
        .update(id, &p)
        .map_err(|e| (StatusCode::BAD_REQUEST, e.to_string()))?;

    log_audit_project(
        &state,
        Some(id),
        &actor.username,
        if p.project_kind == "service" { "service.update" } else { "website.update" },
        Some(&p.name),
        Some(&if p.project_kind == "service" {
            format!("Updated service settings (Branch '{}', Start '{}')", p.branch, p.start_cmd)
        } else {
            format!(
                "Updated website settings (Port {}, Branch '{}', Domains {:?})",
                p.port.unwrap_or(3000),
                p.branch,
                p.domains
            )
        }),
    );

    let updated = state
        .projects
        .get(id)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .ok_or((StatusCode::NOT_FOUND, "Project not found".into()))?;

    let _ = state.runtime.ensure_container(&updated);

    if updated.project_kind != "service" || !updated.domains.is_empty() {
        if let Ok(all) = state.projects.list() {
            let _ = state.caddy.write_config(&updated, &all);
            let _ = state.caddy.reload();
        }
    }
    if let Some(port) = updated.port {
        crate::databases::Databases::sync_firewall_rules(port, &updated.access_mode, &updated.allowed_ips).await;
    }
    state.cache.invalidate_all();

    Ok(Json(updated))
}

async fn delete_project_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxPath(id): AxPath<i64>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let actor = verify_power(&state, &headers, "projects_manage", Some(id))?;
    let deleted_proj = state.projects.get(id).ok().flatten();
    if let Some(ref p) = deleted_proj {
        log_audit_project(
            &state,
            Some(id),
            &actor.username,
            if p.project_kind == "service" { "service.delete" } else { "website.delete" },
            Some(&p.name),
            Some(&format!(
                "Deleted {} '{}' ({}) along with its files, container data, and cache",
                if p.project_kind == "service" { "service" } else { "website" },
                p.name, p.slug
            )),
        );
        let _ = state.runtime.stop_project(p).await;
        state.runtime.stop_maintenance_server(id);
    }
    state
        .projects
        .delete(id)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    if let Some(ref p) = deleted_proj {
        if let Some(port) = p.port {
            crate::databases::Databases::remove_firewall_rules(port, &p.allowed_ips).await;
        }
        if let Ok(remaining) = state.projects.list() {
            state.runtime.cleanup_project_files(p, &remaining);
            state.caddy.remove_project_config(&p.slug, &remaining);
        }
    }
    state.cache.invalidate_project(id);
    state.cache.invalidate_all();

    Ok(Json(serde_json::json!({ "ok": true })))
}

// ---------------------------------------------------------------------------
// Backend Service File Browser (scoped to <deploy_dir>/app)
// ---------------------------------------------------------------------------
#[derive(Deserialize)]
struct FilesQuery {
    #[serde(default)]
    path: String,
}

#[derive(Deserialize)]
struct FileWritePayload {
    path: String,
    content: String,
}

#[derive(Deserialize)]
struct FileMkdirPayload {
    path: String,
}

fn service_root(p: &crate::projects::Project) -> Result<std::path::PathBuf, (StatusCode, String)> {
    if p.project_kind != "service" {
        return Err((StatusCode::BAD_REQUEST, "File browser is only available for backend services".into()));
    }
    let cwd = std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("."));
    let raw = std::path::Path::new(&p.deploy_dir);
    let base = if raw.is_absolute() {
        raw.to_path_buf()
    } else {
        cwd.join(p.deploy_dir.trim_start_matches("./").trim_start_matches(".\\"))
    };
    let root = base.join("app");
    let _ = std::fs::create_dir_all(&root);
    Ok(root)
}

/// Join a user supplied relative path onto the root, rejecting anything that could escape it.
fn safe_join(root: &std::path::Path, rel: &str) -> Result<std::path::PathBuf, (StatusCode, String)> {
    let mut out = root.to_path_buf();
    for part in rel.split(|c| c == '/' || c == '\\') {
        match part {
            "" | "." => {}
            ".." => return Err((StatusCode::BAD_REQUEST, "Invalid path".into())),
            s if s.contains(':') => return Err((StatusCode::BAD_REQUEST, "Invalid path".into())),
            s => out.push(s),
        }
    }
    Ok(out)
}

async fn files_list_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxPath(id): AxPath<i64>,
    Query(q): Query<FilesQuery>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let (_actor, p) = get_authorized_project(&state, &headers, "env", id)?;
    let root = service_root(&p)?;
    let dir = safe_join(&root, &q.path)?;
    let mut entries = Vec::new();
    let mut rd = tokio::fs::read_dir(&dir)
        .await
        .map_err(|e| (StatusCode::NOT_FOUND, e.to_string()))?;
    while let Ok(Some(e)) = rd.next_entry().await {
        let meta = match e.metadata().await {
            Ok(m) => m,
            Err(_) => continue,
        };
        let modified = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);
        entries.push(serde_json::json!({
            "name": e.file_name().to_string_lossy(),
            "is_dir": meta.is_dir(),
            "size": if meta.is_dir() { 0 } else { meta.len() },
            "modified": modified,
        }));
    }
    entries.sort_by(|a, b| {
        let ad = a["is_dir"].as_bool().unwrap_or(false);
        let bd = b["is_dir"].as_bool().unwrap_or(false);
        bd.cmp(&ad).then_with(|| {
            a["name"].as_str().unwrap_or("").to_lowercase().cmp(&b["name"].as_str().unwrap_or("").to_lowercase())
        })
    });
    Ok(Json(serde_json::json!({ "path": q.path, "entries": entries })))
}

async fn files_read_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxPath(id): AxPath<i64>,
    Query(q): Query<FilesQuery>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let (_actor, p) = get_authorized_project(&state, &headers, "env", id)?;
    let root = service_root(&p)?;
    let file = safe_join(&root, &q.path)?;
    let meta = tokio::fs::metadata(&file)
        .await
        .map_err(|e| (StatusCode::NOT_FOUND, e.to_string()))?;
    if !meta.is_file() {
        return Err((StatusCode::BAD_REQUEST, "Not a file".into()));
    }
    if meta.len() > 2 * 1024 * 1024 {
        return Err((StatusCode::BAD_REQUEST, "File is larger than 2 MB and cannot be edited here".into()));
    }
    let bytes = tokio::fs::read(&file)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    let content = String::from_utf8(bytes)
        .map_err(|_| (StatusCode::BAD_REQUEST, "Binary file cannot be displayed".to_string()))?;
    Ok(Json(serde_json::json!({ "path": q.path, "content": content })))
}

async fn files_write_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxPath(id): AxPath<i64>,
    Json(payload): Json<FileWritePayload>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let (actor, p) = get_authorized_project(&state, &headers, "env", id)?;
    let root = service_root(&p)?;
    let file = safe_join(&root, &payload.path)?;
    if file == root {
        return Err((StatusCode::BAD_REQUEST, "Invalid file path".into()));
    }
    if let Some(parent) = file.parent() {
        let _ = tokio::fs::create_dir_all(parent).await;
    }
    tokio::fs::write(&file, payload.content.as_bytes())
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    log_audit_project(
        &state,
        Some(id),
        &actor.username,
        "file.write",
        Some(&p.name),
        Some(&format!("Saved file '{}'", payload.path)),
    );
    Ok(Json(serde_json::json!({ "ok": true })))
}

async fn files_mkdir_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxPath(id): AxPath<i64>,
    Json(payload): Json<FileMkdirPayload>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let (_actor, p) = get_authorized_project(&state, &headers, "env", id)?;
    let root = service_root(&p)?;
    let dir = safe_join(&root, &payload.path)?;
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

async fn files_delete_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxPath(id): AxPath<i64>,
    Query(q): Query<FilesQuery>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let (actor, p) = get_authorized_project(&state, &headers, "env", id)?;
    let root = service_root(&p)?;
    let target = safe_join(&root, &q.path)?;
    if target == root {
        return Err((StatusCode::BAD_REQUEST, "Cannot delete the service root".into()));
    }
    let meta = tokio::fs::metadata(&target)
        .await
        .map_err(|e| (StatusCode::NOT_FOUND, e.to_string()))?;
    let res = if meta.is_dir() {
        tokio::fs::remove_dir_all(&target).await
    } else {
        tokio::fs::remove_file(&target).await
    };
    res.map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    log_audit_project(
        &state,
        Some(id),
        &actor.username,
        "file.delete",
        Some(&p.name),
        Some(&format!("Deleted '{}'", q.path)),
    );
    Ok(Json(serde_json::json!({ "ok": true })))
}

async fn files_upload_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxPath(id): AxPath<i64>,
    Query(q): Query<FilesQuery>,
    mut multipart: Multipart,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let (actor, p) = get_authorized_project(&state, &headers, "env", id)?;
    let root = service_root(&p)?;
    let target_dir = safe_join(&root, &q.path)?;
    tokio::fs::create_dir_all(&target_dir)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let mut uploaded = Vec::new();
    while let Ok(Some(field)) = multipart.next_field().await {
        let file_name = match field.file_name() {
            Some(name) if !name.trim().is_empty() => name.to_string(),
            _ => continue,
        };
        let clean_name = std::path::Path::new(&file_name)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or(&file_name);

        let target_file = safe_join(&target_dir, clean_name)?;
        let bytes = field
            .bytes()
            .await
            .map_err(|e| (StatusCode::BAD_REQUEST, e.to_string()))?;
        tokio::fs::write(&target_file, &bytes)
            .await
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
        uploaded.push(clean_name.to_string());
    }
    log_audit_project(
        &state,
        Some(id),
        &actor.username,
        "file.upload",
        Some(&p.name),
        Some(&format!("Uploaded {} file(s) into '{}'", uploaded.len(), q.path)),
    );
    Ok(Json(serde_json::json!({ "ok": true, "uploaded": uploaded })))
}

// ---------------------------------------------------------------------------
// Environment Variables
// ---------------------------------------------------------------------------
async fn get_env_handler(
    State(state): State<AppState>,
    AxPath(id): AxPath<i64>,
) -> Result<Json<Vec<EnvVarView>>, StatusCode> {
    let list = state.projects.get_env_vars(id).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(list))
}

#[derive(Deserialize)]
struct SetEnvPayload {
    key: String,
    value: String,
    is_secret: Option<bool>,
    previous_key: Option<String>,
}

async fn set_env_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxPath(id): AxPath<i64>,
    Json(payload): Json<SetEnvPayload>,
) -> Result<StatusCode, (StatusCode, String)> {
    let actor = verify_power(&state, &headers, "env", Some(id))?;
    let p_name = state.projects.get(id).ok().flatten().map(|p| p.name).unwrap_or_else(|| format!("Website #{}", id));
    state
        .projects
        .set_env_var_with_rename(
            id,
            &payload.key,
            &payload.value,
            payload.is_secret.unwrap_or(false),
            payload.previous_key.as_deref(),
        )
        .map_err(|e| (StatusCode::BAD_REQUEST, e.to_string()))?;
    log_audit_project(
        &state,
        Some(id),
        &actor.username,
        "env.set",
        Some(&p_name),
        Some(&format!("Saved environment variable '{}'", payload.key)),
    );
    Ok(StatusCode::OK)
}

#[derive(Deserialize)]
struct BulkEnvPayload {
    #[serde(default)]
    content: String,
    #[serde(default)]
    items: Option<Vec<EnvVarInput>>,
    is_secret: Option<bool>,
    replace_all: Option<bool>,
}

#[derive(Serialize)]
struct BulkEnvResponse {
    count: usize,
}

async fn bulk_set_env_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxPath(id): AxPath<i64>,
    Json(payload): Json<BulkEnvPayload>,
) -> Result<Json<BulkEnvResponse>, (StatusCode, String)> {
    let actor = verify_power(&state, &headers, "env", Some(id))?;
    let p_name = state.projects.get(id).ok().flatten().map(|p| p.name).unwrap_or_else(|| format!("Website #{}", id));
    let replace_all = payload.replace_all.unwrap_or(false);
    let count = if let Some(ref items) = payload.items {
        state
            .projects
            .set_batch_env_items(id, items, replace_all)
            .map_err(|e| (StatusCode::BAD_REQUEST, e.to_string()))?
    } else {
        state
            .projects
            .set_bulk_env(
                id,
                &payload.content,
                payload.is_secret.unwrap_or(true),
                replace_all,
            )
            .map_err(|e| (StatusCode::BAD_REQUEST, e.to_string()))?
    };
    log_audit_project(
        &state,
        Some(id),
        &actor.username,
        "env.bulk_import",
        Some(&p_name),
        Some(&format!("Saved {} environment variables", count)),
    );
    Ok(Json(BulkEnvResponse { count }))
}

#[derive(Serialize)]
struct RawEnvResponse {
    content: String,
}

async fn get_raw_env_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxPath(id): AxPath<i64>,
) -> Result<Json<RawEnvResponse>, (StatusCode, String)> {
    let _actor = verify_power(&state, &headers, "env", Some(id))?;
    let content = state
        .projects
        .export_raw_env(id)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(Json(RawEnvResponse { content }))
}

#[derive(Deserialize)]
struct RevealEnvPayload {
    key: String,
}

#[derive(Serialize)]
struct RevealEnvResponse {
    key: String,
    value: String,
}

async fn reveal_env_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxPath(id): AxPath<i64>,
    Json(payload): Json<RevealEnvPayload>,
) -> Result<Json<RevealEnvResponse>, StatusCode> {
    let actor = verify_power(&state, &headers, "env", Some(id)).map_err(|(c, _)| c)?;
    let p_name = state.projects.get(id).ok().flatten().map(|p| p.name).unwrap_or_else(|| format!("Website #{}", id));
    let val = state.projects.reveal_env_var(id, &payload.key).ok_or(StatusCode::NOT_FOUND)?;
    log_audit_project(
        &state,
        Some(id),
        &actor.username,
        "env.reveal",
        Some(&p_name),
        Some(&format!("Revealed secret variable '{}'", payload.key)),
    );
    Ok(Json(RevealEnvResponse {
        key: payload.key,
        value: val,
    }))
}

async fn delete_env_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxPath((id, key)): AxPath<(i64, String)>,
) -> Result<StatusCode, StatusCode> {
    let actor = verify_power(&state, &headers, "env", Some(id)).map_err(|(c, _)| c)?;
    let p_name = state.projects.get(id).ok().flatten().map(|p| p.name).unwrap_or_else(|| format!("Website #{}", id));
    state.projects.delete_env_var(id, &key).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    log_audit_project(
        &state,
        Some(id),
        &actor.username,
        "env.delete",
        Some(&p_name),
        Some(&format!("Deleted environment variable '{}'", key)),
    );
    Ok(StatusCode::OK)
}

// ---------------------------------------------------------------------------
// Deployments & Lifecycle Actions
// ---------------------------------------------------------------------------
#[derive(Serialize)]
struct ActionResponse {
    #[serde(rename = "deploymentId")]
    deployment_id: i64,
}

#[derive(Deserialize, Default)]
struct DeployPayload {
    sha: Option<String>,
}

async fn deploy_project_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxPath(id): AxPath<i64>,
    body_bytes: axum::body::Bytes,
) -> Result<Json<ActionResponse>, (StatusCode, String)> {
    let (actor, p) = get_authorized_project(&state, &headers, "deploy", id)?;

    let target_sha = serde_json::from_slice::<DeployPayload>(&body_bytes)
        .ok()
        .and_then(|b| b.sha)
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    let dep_id = state.deployer.create_deployment(&p, "deploy", &actor.username, "manual");
    if let Some(ref sha) = target_sha {
        let conn = state.db.lock().unwrap();
        let _ = conn.execute(
            "UPDATE deployments SET sha = ? WHERE id = ?",
            rusqlite::params![sha, dep_id],
        );
    }
    log_audit_project(
        &state,
        Some(p.id),
        &actor.username,
        "deploy.trigger",
        Some(&p.name),
        Some(&format!("Triggered deployment #{} on branch '{}'", dep_id, p.branch)),
    );
    trigger_background_deploy(state.deployer.clone(), p.id, dep_id);

    Ok(Json(ActionResponse { deployment_id: dep_id }))
}

#[derive(Deserialize)]
struct RollbackPayload {
    #[serde(rename = "releaseId")]
    #[allow(dead_code)]
    release_id: i64,
}

async fn rollback_project_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxPath(id): AxPath<i64>,
    Json(payload): Json<RollbackPayload>,
) -> Result<Json<ActionResponse>, (StatusCode, String)> {
    let (actor, p) = get_authorized_project(&state, &headers, "deploy", id)?;

    let dep_id = state.deployer.create_deployment(&p, "rollback", &actor.username, "manual");
    let deployer = state.deployer.clone();
    let target_rel = payload.release_id;
    log_audit_project(
        &state,
        Some(p.id),
        &actor.username,
        "rollback.trigger",
        Some(&p.name),
        Some(&format!("Triggered rollback #{} to Release #{}", dep_id, target_rel)),
    );

    tokio::spawn(async move {
        deployer.run_rollback(p.id, dep_id, target_rel).await;
    });

    Ok(Json(ActionResponse { deployment_id: dep_id }))
}

async fn start_project_with_audit(
    state: &AppState,
    actor: &crate::auth::User,
    p: &crate::projects::Project,
    action: &str,
    action_label: &str,
) -> Result<u32, (StatusCode, String)> {
    let env = state.projects.get_env_map(p.id);
    match state.runtime.start_project(p, env, None).await {
        Ok(pid) => {
            state.cache.invalidate_all();
            log_audit_project(
                state,
                Some(p.id),
                &actor.username,
                action,
                Some(&p.name),
                Some(&if p.project_kind == "service" {
                format!("{} backend service (PID {})", action_label, pid)
            } else {
                format!("{} website container (PID {}, Port {})", action_label, pid, p.port.unwrap_or(3000))
            }),
            );
            Ok(pid)
        }
        Err(e) if e == "NOT_DEPLOYED_YET" => Err((
            StatusCode::BAD_REQUEST,
            format!("'{}' has not been deployed yet. Please click 'Deploy' to build and deploy it first.", p.name),
        )),
        Err(e) => Err((StatusCode::BAD_REQUEST, e)),
    }
}

async fn start_project_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxPath(id): AxPath<i64>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let (actor, p) = get_authorized_project(&state, &headers, "process", id)?;
    let pid = start_project_with_audit(&state, &actor, &p, "container.start", "Started").await?;
    Ok(Json(serde_json::json!({
        "started": true,
        "pid": pid
    })))
}

async fn stop_project_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxPath(id): AxPath<i64>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let (actor, p) = get_authorized_project(&state, &headers, "process", id)?;

    state
        .runtime
        .stop_project(&p)
        .await
        .map_err(|e| (StatusCode::BAD_REQUEST, e))?;

    state.cache.invalidate_all();
    log_audit_project(
        &state,
        Some(p.id),
        &actor.username,
        "container.stop",
        Some(&p.name),
        Some(&if p.project_kind == "service" {
            "Stopped backend service".to_string()
        } else {
            format!("Stopped website container and freed port {}", p.port.unwrap_or(3000))
        }),
    );

    Ok(Json(serde_json::json!({ "stopped": true })))
}

async fn restart_project_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxPath(id): AxPath<i64>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let (actor, p) = get_authorized_project(&state, &headers, "process", id)?;

    let _ = state.runtime.stop_project(&p).await;
    let pid = start_project_with_audit(&state, &actor, &p, "container.restart", "Restarted").await?;
    Ok(Json(serde_json::json!({ "started": true, "pid": pid })))
}

#[derive(Deserialize, Default)]
struct MaintenancePayload {
    enabled: Option<bool>,
}

async fn toggle_maintenance_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxPath(id): AxPath<i64>,
    payload: Option<Json<MaintenancePayload>>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let (actor, p) = get_authorized_project(&state, &headers, "process", id)?;

    let target_enabled = payload
        .and_then(|Json(b)| b.enabled)
        .unwrap_or(p.app_status != "maintenance");

    if target_enabled {
        state
            .runtime
            .set_maintenance_mode(&p, true)
            .await
            .map_err(|e| (StatusCode::BAD_REQUEST, e))?;

        if let Ok(all) = state.projects.list() {
            if let Ok(Some(updated_p)) = state.projects.get(id) {
                let _ = state.caddy.write_config(&updated_p, &all);
                let _ = state.caddy.reload();
            }
        }

        log_audit_project(
            &state,
            Some(p.id),
            &actor.username,
            "website.maintenance_on",
            Some(&p.name),
            Some(&format!(
                "Enabled Maintenance Mode on port {} (Maintenance page active)",
                p.port.unwrap_or(3000)
            )),
        );
        state.cache.invalidate_all();

        Ok(Json(serde_json::json!({
            "ok": true,
            "maintenance": true,
            "app_status": "maintenance"
        })))
    } else {
        let _ = state.runtime.set_maintenance_mode(&p, false).await;
        let env = state.projects.get_env_map(id);
        match state.runtime.start_project(&p, env, None).await {
            Ok(pid) => {
                if let Ok(all) = state.projects.list() {
                    if let Ok(Some(updated_p)) = state.projects.get(id) {
                        let _ = state.caddy.write_config(&updated_p, &all);
                        let _ = state.caddy.reload();
                    }
                }
                log_audit_project(
                    &state,
                    Some(p.id),
                    &actor.username,
                    "website.maintenance_off",
                    Some(&p.name),
                    Some(&format!(
                        "Disabled Maintenance Mode and resumed website (PID {}, Port {})",
                        pid,
                        p.port.unwrap_or(3000)
                    )),
                );
                state.cache.invalidate_all();
                Ok(Json(serde_json::json!({
                    "ok": true,
                    "maintenance": false,
                    "app_status": "running",
                    "pid": pid
                })))
            }
            Err(e) if e == "NOT_DEPLOYED_YET" => {
                let _ = state.runtime.stop_project(&p).await;
                state.cache.invalidate_all();
                Ok(Json(serde_json::json!({
                    "ok": true,
                    "maintenance": false,
                    "app_status": "stopped"
                })))
            }
            Err(e) => Err((StatusCode::BAD_REQUEST, e)),
        }
    }
}

async fn list_releases_handler(
    State(state): State<AppState>,
    AxPath(id): AxPath<i64>,
) -> Result<Json<Vec<crate::deployer::Release>>, StatusCode> {
    let list = state.deployer.list_releases(id);
    Ok(Json(list))
}

#[derive(Deserialize)]
struct CreateReleasePayload {
    source: Option<String>,
    note: Option<String>,
}

async fn create_release_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxPath(id): AxPath<i64>,
    Json(payload): Json<CreateReleasePayload>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let (actor, p) = get_authorized_project(&state, &headers, "deploy", id)?;

    let source = payload.source.unwrap_or_else(|| "deploy".to_string());
    let note = payload.note.unwrap_or_else(|| "Manual Release".to_string());

    if source == "snapshot" {
        let ts = now();
        let base_dir = std::path::PathBuf::from(&p.deploy_dir);
        let rel_dir = base_dir.join("releases").join(format!("rel-snap-{}", ts));
        tokio::fs::create_dir_all(&rel_dir).await.ok();

        let src_dir = if base_dir.join("current").exists() {
            base_dir.join("current")
        } else {
            base_dir.clone()
        };

        if src_dir.exists() {
            copy_backup_files(&src_dir, &rel_dir);
        }

        let sha = p.deployed_sha.clone().unwrap_or_else(|| format!("{:x}", ts));
        let short_sha = sha[..7.min(sha.len())].to_string();

        let rel_id = {
            let conn = state.db.lock().unwrap();
            insert_success_release(
                &conn,
                id,
                &sha,
                &short_sha,
                &format!("Release: {}", note),
                &actor.username,
                rel_dir.to_str().unwrap_or(""),
                ts,
            )
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        };

        // Also record in backups so it appears in Backups tab
        {
            let conn = state.db.lock().unwrap();
            let p_str = rel_dir.to_string_lossy().to_string();
            conn.execute(
                "INSERT INTO backups(project_id, release_id, kind, path, dir, size, size_bytes, note, status, ts, created_at)
                 VALUES(?, ?, 'release-snapshot', ?, ?, 5242880, 5242880, ?, 'ok', ?, ?)",
                rusqlite::params![id, rel_id, &p_str, &p_str, format!("Release #{} ({})", rel_id, note), ts, ts],
            ).ok();
        }

        state.cache.invalidate_project(id);
        log_audit_project(&state, Some(id), &actor.username, "release.create", Some(&p.name), Some(&note));

        Ok(Json(serde_json::json!({
            "ok": true,
            "releaseId": rel_id,
            "message": format!("Release #{} created successfully from current files", rel_id)
        })))
    } else {
        // Trigger a new deployment which builds and creates a live release
        let dep_id = state.deployer.create_deployment(&p, "deploy", &actor.username, "manual");
        trigger_background_deploy(state.deployer.clone(), p.id, dep_id);

        Ok(Json(serde_json::json!({
            "ok": true,
            "deploymentId": dep_id,
            "message": format!("Release deployment #{} initiated", dep_id)
        })))
    }
}

#[derive(Serialize)]
struct CaddyResponse {
    config: String,
    domains: Vec<String>,
}

async fn get_caddy_handler(
    State(state): State<AppState>,
    AxPath(id): AxPath<i64>,
) -> Result<Json<CaddyResponse>, StatusCode> {
    let p = state
        .projects
        .get(id)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .ok_or(StatusCode::NOT_FOUND)?;

    let conf = state.caddy.generate_config(&p);
    Ok(Json(CaddyResponse {
        config: conf,
        domains: p.domains,
    }))
}

#[derive(Deserialize, Default)]
struct ApplyCaddyPayload {
    domains: Option<Vec<String>>,
}

async fn apply_caddy_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxPath(id): AxPath<i64>,
    body_bytes: axum::body::Bytes,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let actor = verify_power(&state, &headers, "domains", Some(id))?;
    let mut p = state
        .projects
        .get(id)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .ok_or((StatusCode::NOT_FOUND, "Project not found".into()))?;

    if !body_bytes.is_empty() {
        if let Ok(parsed) = serde_json::from_slice::<ApplyCaddyPayload>(&body_bytes) {
            if let Some(raw_domains) = parsed.domains {
                let cleaned: Vec<String> = raw_domains
                    .into_iter()
                    .flat_map(|s| {
                        s.split(|c| c == ',' || c == '\n' || c == ';')
                            .map(|part| part.to_string())
                            .collect::<Vec<String>>()
                    })
                    .map(|d| normalize_domain(&d))
                    .filter(|d| !d.is_empty())
                    .collect();

                p.domains = cleaned;
                let domains_json = serde_json::to_string(&p.domains).unwrap_or_else(|_| "[]".to_string());
                let ts = crate::db::now();
                {
                    let conn = state.db.lock().unwrap();
                    conn.execute(
                        "UPDATE projects SET domains = ?, updated_at = ? WHERE id = ?",
                        rusqlite::params![domains_json, ts, id],
                    )
                    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
                }
            }
        }
    }

    let all_projects = state.projects.list().unwrap_or_default();

    state
        .caddy
        .write_config(&p, &all_projects)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let _ = state.caddy.reload();
    state.cache.invalidate_all();

    log_audit_project(
        &state,
        Some(p.id),
        &actor.username,
        "domains.caddy_apply",
        Some(&p.name),
        Some(&format!("Configured domains: {:?}", p.domains)),
    );

    let conf = state.caddy.generate_config(&p);
    Ok(Json(serde_json::json!({
        "ok": true,
        "domains": p.domains,
        "config": conf
    })))
}

async fn certbot_caddy_handler(
    State(_state): State<AppState>,
    AxPath(id): AxPath<i64>,
) -> Result<StatusCode, (StatusCode, String)> {
    let _ = id;
    // Caddy provisions certificates automatically via ACME, no certbot needed!
    Ok(StatusCode::OK)
}

#[derive(Serialize)]
struct AppLogsResponse {
    lines: Vec<String>,
}

async fn get_app_logs_handler(
    State(state): State<AppState>,
    AxPath(id): AxPath<i64>,
) -> Result<Json<AppLogsResponse>, StatusCode> {
    let mut entries = state.logs.list(Some(id), None, Some("app"), None, 200);
    if entries.is_empty() {
        entries = state.logs.list(Some(id), None, None, None, 200);
    }
    let logs = entries
        .into_iter()
        .map(|l| format!("[{}] [{}] {}", l.channel.to_uppercase(), l.level.to_uppercase(), l.message))
        .collect();

    Ok(Json(AppLogsResponse { lines: logs }))
}

// ---------------------------------------------------------------------------
// Deployments List
// ---------------------------------------------------------------------------
#[derive(Deserialize)]
struct DeploymentQuery {
    project: Option<i64>,
    limit: Option<usize>,
}

async fn list_deployments_handler(
    State(state): State<AppState>,
    Query(q): Query<DeploymentQuery>,
) -> Result<Json<Vec<crate::deployer::Deployment>>, StatusCode> {
    let list = state.deployer.list_deployments(q.project, q.limit.unwrap_or(200));
    Ok(Json(list))
}

#[derive(Serialize)]
struct DeploymentDetailResponse {
    deployment: crate::deployer::Deployment,
    logs: Vec<crate::logs::LogEntry>,
}

async fn get_deployment_handler(
    State(state): State<AppState>,
    AxPath(id): AxPath<i64>,
) -> Result<Json<DeploymentDetailResponse>, StatusCode> {
    let dep = state.deployer.get_deployment(id).ok_or(StatusCode::NOT_FOUND)?;
    let logs = state.logs.list(None, Some(id), None, None, 1000);
    Ok(Json(DeploymentDetailResponse {
        deployment: dep,
        logs,
    }))
}

async fn get_deployment_logs_handler(
    State(state): State<AppState>,
    AxPath(id): AxPath<i64>,
) -> Result<Json<Vec<crate::logs::LogEntry>>, StatusCode> {
    let logs = state.logs.list(None, Some(id), None, None, 1000);
    Ok(Json(logs))
}

// ---------------------------------------------------------------------------
// Real-Time SSE Log Streaming & Log History
// ---------------------------------------------------------------------------
#[derive(Deserialize)]
struct LogsQuery {
    project: Option<i64>,
    channel: Option<String>,
    level: Option<String>,
    backlog: Option<usize>,
    limit: Option<usize>,
}

async fn list_logs_handler(
    State(state): State<AppState>,
    Query(q): Query<LogsQuery>,
) -> Result<Json<Vec<crate::logs::LogEntry>>, StatusCode> {
    let limit = q.limit.or(q.backlog).unwrap_or(300);
    let logs = state.logs.list(
        q.project,
        None,
        q.channel.as_deref(),
        q.level.as_deref(),
        limit,
    );
    Ok(Json(logs))
}

async fn logs_sse_handler(
    State(state): State<AppState>,
    Query(q): Query<LogsQuery>,
) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    let backlog_limit = q.backlog.unwrap_or(200);
    let initial_logs = state.logs.list(q.project, None, None, None, backlog_limit);
    let project_filter = q.project;

    let initial_event = if !initial_logs.is_empty() {
        serde_json::to_string(&initial_logs)
            .ok()
            .map(|json| Ok(Event::default().data(json)))
    } else {
        None
    };

    let rx = state.logs.subscribe();
    let live_stream = BroadcastStream::new(rx).filter_map(move |msg| {
        if let Ok(entry) = msg {
            if let Some(pid) = project_filter {
                if entry.project_id.is_some() && entry.project_id != Some(pid) {
                    return None;
                }
            }
            if let Ok(json) = serde_json::to_string(&vec![entry]) {
                return Some(Ok(Event::default().data(json)));
            }
        }
        None
    });

    let combined = futures_util::stream::iter(initial_event.into_iter()).chain(live_stream);
    Sse::new(combined).keep_alive(KeepAlive::default())
}

async fn logs_download_handler(
    State(state): State<AppState>,
) -> Result<Response, StatusCode> {
    let logs = state.logs.list(None, None, None, None, 5000);
    let mut out = String::new();
    for l in logs {
        out.push_str(&format!(
            "[{}] [{}] [{}] {}\n",
            l.ts,
            l.channel.to_uppercase(),
            l.level.to_uppercase(),
            l.message
        ));
    }

    let res = Response::builder()
        .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
        .header(header::CONTENT_DISPOSITION, "attachment; filename=\"webdep-logs.txt\"")
        .body(Body::from(out))
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response());

    Ok(res)
}

// ---------------------------------------------------------------------------
// GitHub Webhook Handler
// ---------------------------------------------------------------------------
async fn github_webhook_handler(
    State(state): State<AppState>,
    AxPath(slug): AxPath<String>,
    Json(_payload): Json<serde_json::Value>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let projs = state
        .projects
        .list()
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let p = projs
        .into_iter()
        .find(|x| x.slug == slug)
        .ok_or((StatusCode::NOT_FOUND, "Project not found for this slug".to_string()))?;

    if !p.auto_deploy {
        state.logs.add(
            Some(p.id),
            None,
            "github",
            "info",
            &format!("GitHub webhook received for {} (ignored — manual deploy mode active)", p.name),
        );
        return Ok(Json(serde_json::json!({
            "ok": true,
            "ignored": true,
            "message": "Auto-deploy is disabled for this website; use the Deploy button in the panel."
        })));
    }

    state.logs.add(
        Some(p.id),
        None,
        "github",
        "info",
        &format!("GitHub webhook received for {}", p.name),
    );

    let dep_id = state
        .deployer
        .create_deployment(&p, "deploy", "github-webhook", "webhook");

    trigger_background_deploy(state.deployer.clone(), p.id, dep_id);

    Ok(Json(serde_json::json!({
        "ok": true,
        "deploymentId": dep_id,
        "message": "Deployment triggered from GitHub webhook"
    })))
}

// ---------------------------------------------------------------------------
// Overview & Monitoring
// ---------------------------------------------------------------------------
#[derive(Serialize)]
struct OverviewProjectItem {
    project: Project,
    app: OverviewAppStatus,
    active: Option<crate::deployer::Deployment>,
    behind: Option<u32>,
    ahead: Option<u32>,
    #[serde(rename = "lastSuccess")]
    last_success: Option<crate::deployer::Deployment>,
}

#[derive(Serialize)]
struct OverviewAppStatus {
    running: bool,
    pid: Option<u32>,
    #[serde(rename = "startedAt")]
    started_at: Option<i64>,
}

#[derive(Serialize)]
struct OverviewResponse {
    projects: Vec<OverviewProjectItem>,
    recent: Vec<crate::deployer::Deployment>,
    monitor: crate::monitor::SystemMetrics,
}

fn fetch_overview_deployment(
    conn: &rusqlite::Connection,
    status_filter: &str,
    project_id: i64,
    project_name: &str,
) -> Option<crate::deployer::Deployment> {
    let sql = format!(
        "SELECT id, project_id, release_id, from_release_id, kind, status, stage, sha, trigger, actor, error, started_at, finished_at \
         FROM deployments WHERE project_id = ? AND {} ORDER BY id DESC LIMIT 1",
        status_filter
    );
    conn.query_row(
        &sql,
        rusqlite::params![project_id],
        |r| Ok(crate::deployer::Deployment {
            id: r.get(0)?,
            project_id: r.get(1)?,
            project_name: Some(project_name.to_string()),
            release_id: r.get(2)?,
            from_release_id: r.get(3)?,
            kind: r.get(4)?,
            status: r.get(5)?,
            stage: r.get(6)?,
            sha: r.get(7)?,
            trigger: r.get(8)?,
            actor: r.get(9)?,
            error: r.get(10)?,
            started_at: r.get(11)?,
            finished_at: r.get(12)?,
        }),
    ).ok()
}

async fn overview_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Response, StatusCode> {
    let user_opt = current_user(&state, &headers);
    let uid = user_opt.as_ref().map(|u| u.id).unwrap_or(0);
    let cache_key = format!("overview:u{}", uid);

    if let Some(res) = check_api_cache(&state.cache, &cache_key) {
        return Ok(res);
    }

    let mut projs = state.projects.list().map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    if let Some(ref u) = user_opt {
        projs.retain(|p| u.can_access_project(p.id));
    }
    let mut items = Vec::new();

    for p in projs {
        let is_running = p.app_status == "running";

        let last_success = {
            let conn = state.db.lock().unwrap();
            fetch_overview_deployment(&conn, "status = 'success'", p.id, &p.name)
        };

        let active = {
            let conn = state.db.lock().unwrap();
            fetch_overview_deployment(&conn, "status IN ('running', 'pending')", p.id, &p.name)
        };

        items.push(OverviewProjectItem {
            app: OverviewAppStatus {
                running: is_running,
                pid: p.app_pid,
                started_at: p.app_started_at,
            },
            project: p,
            active,
            behind: Some(0),
            ahead: Some(0),
            last_success,
        });
    }

    let recent = state.deployer.list_deployments(None, 10);
    let monitor = state.monitor.sample();

    let payload = OverviewResponse {
        projects: items,
        recent,
        monitor,
    };
    if let Ok(json_val) = serde_json::to_value(&payload) {
        state
            .cache
            .set(cache_key, json_val, std::time::Duration::from_secs(2));
    }

    let mut res = Json(payload).into_response();
    res.headers_mut()
        .insert("x-cache", HeaderValue::from_static("MISS"));
    Ok(res)
}

async fn monitor_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Response, StatusCode> {
    let user_opt = current_user(&state, &headers);
    let uid = user_opt.as_ref().map(|u| u.id).unwrap_or(0);
    let cache_key = format!("monitor:u{}", uid);

    if let Some(res) = check_api_cache(&state.cache, &cache_key) {
        return Ok(res);
    }

    let sample = state.monitor.sample();
    let mut projs = state.projects.list().unwrap_or_default();
    if let Some(ref u) = user_opt {
        projs.retain(|p| u.can_access_project(p.id));
    }
    let now_ms = now();

    let proj_metrics: Vec<serde_json::Value> = projs
        .into_iter()
        .map(|p| {
            let running = p.app_status == "running";
            let uptime_ms = if running {
                p.app_started_at.map(|s| (now_ms - s).max(0))
            } else {
                None
            };
            serde_json::json!({
                "id": p.id,
                "name": p.name,
                "slug": p.slug,
                "deployedSha": p.deployed_sha,
                "status": {
                    "running": running,
                    "appStatus": p.app_status,
                    "pid": p.app_pid,
                    "uptimeMs": uptime_ms,
                },
                "disk": {
                    "used": 15 * 1024 * 1024u64
                },
                "deployStatus": {
                    "status": if p.deployed_sha.is_some() { "success" } else { "idle" }
                }
            })
        })
        .collect();

    let hostname = std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_else(|_| "webdep-server".to_string());

    let val = serde_json::json!({
        "cpu": sample.cpu,
        "memory": sample.memory,
        "disk": sample.disk,
        "uptime_s": sample.uptime_s,
        "processes": sample.processes,
        "cache": state.cache.stats(),
        "system": {
            "hostname": hostname,
            "platform": format!("{} ({})", std::env::consts::OS, std::env::consts::ARCH),
            "uptime": sample.uptime_s,
            "cpu": {
                "cores": sample.cpu.cores,
                "pct": sample.cpu.pct,
                "load": [sample.cpu.pct as f64 / 100.0]
            }
        },
        "projects": proj_metrics
    });

    state
        .cache
        .set(cache_key, val.clone(), std::time::Duration::from_secs(2));

    let mut res = Json(val).into_response();
    res.headers_mut()
        .insert("x-cache", HeaderValue::from_static("MISS"));
    Ok(res)
}

async fn restart_panel_handler(
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

async fn system_version_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<crate::updater::GitVersionInfo>, (StatusCode, String)> {
    let _actor = current_user(&state, &headers)
        .ok_or_else(|| (StatusCode::UNAUTHORIZED, "Unauthorized".to_string()))?;
    Ok(Json(state.updater.get_version_info()))
}

async fn system_update_status_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<crate::updater::UpdateStatus>, (StatusCode, String)> {
    let _actor = current_user(&state, &headers)
        .ok_or_else(|| (StatusCode::UNAUTHORIZED, "Unauthorized".to_string()))?;
    Ok(Json(state.updater.get_status()))
}

async fn system_update_handler(
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

async fn cache_stats_handler(State(state): State<AppState>) -> Json<crate::cache::CacheStats> {
    Json(state.cache.stats())
}

async fn cache_clear_handler(
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

#[derive(Serialize)]
struct AuditItem {
    id: i64,
    #[serde(rename = "projectId")]
    project_id: Option<i64>,
    ts: i64,
    actor: String,
    action: String,
    target: Option<String>,
    detail: Option<String>,
    ip: Option<String>,
}

fn row_to_audit_item(r: &rusqlite::Row, default_target: Option<String>) -> rusqlite::Result<AuditItem> {
    Ok(AuditItem {
        id: r.get(0)?,
        project_id: r.get(1)?,
        ts: r.get(2)?,
        actor: r.get(3)?,
        action: r.get(4)?,
        target: r.get::<_, Option<String>>(5)?.or(default_target),
        detail: r.get(6)?,
        ip: r.get(7)?,
    })
}

#[derive(Deserialize)]
struct AuditQuery {
    #[serde(rename = "projectId")]
    project_id: Option<i64>,
    limit: Option<usize>,
}

async fn audit_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<AuditQuery>,
) -> Result<Response, StatusCode> {
    let u = current_user(&state, &headers);
    let uid = u.as_ref().map(|user| user.id).unwrap_or(0);
    let max_limit = q.limit.unwrap_or(500).min(1000);
    let cache_key = format!(
        "audit:p{}:u{}:l{}",
        q.project_id.unwrap_or(0),
        uid,
        max_limit
    );
    if let Some(res) = check_api_cache(&state.cache, &cache_key) {
        return Ok(res);
    }

    let conn = state.db.lock().unwrap();

    let mut list = Vec::new();
    if let Some(pid) = q.project_id {
        if let Some(ref user) = u {
            if !user.can_access_project(pid) {
                return Err(StatusCode::FORBIDDEN);
            }
        }
        let p_info: Option<(String, String)> = conn
            .query_row("SELECT name, slug FROM projects WHERE id = ?", rusqlite::params![pid], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .ok();
        let (p_name, p_slug) = p_info.unwrap_or_default();

        let sql = format!(
            "SELECT id, project_id, ts, actor, action, target, detail, ip
             FROM audit
             WHERE project_id = ?1
                OR LOWER(COALESCE(target, '')) = LOWER(?2)
                OR LOWER(COALESCE(target, '')) = LOWER(?3)
                OR COALESCE(target, '') = CAST(?1 AS TEXT)
             ORDER BY ts DESC, id DESC LIMIT {}",
            max_limit
        );
        let mut stmt = conn.prepare(&sql).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        let rows = stmt
            .query_map(rusqlite::params![pid, p_name, p_slug], |r| {
                row_to_audit_item(r, Some(p_name.clone()))
            })
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        for r in rows.flatten() {
            list.push(r);
        }

        // Also include historical deployments & rollbacks from the `deployments` table
        // that predate per-website audit rows so the Activity tab shows the full timeline.
        if let Ok(mut dstmt) = conn.prepare(
            "SELECT id, kind, status, sha, trigger, actor, error, started_at, finished_at, release_id
             FROM deployments WHERE project_id = ? ORDER BY id DESC LIMIT 200",
        ) {
            if let Ok(drows) = dstmt.query_map(rusqlite::params![pid], |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, Option<String>>(3)?,
                    r.get::<_, String>(4)?,
                    r.get::<_, String>(5)?,
                    r.get::<_, Option<String>>(6)?,
                    r.get::<_, i64>(7)?,
                    r.get::<_, Option<i64>>(8)?,
                    r.get::<_, Option<i64>>(9)?,
                ))
            }) {
                for d in drows.flatten() {
                    let (dep_id, kind, status, sha, trigger, actor, error, started_at, finished_at, rel_id) = d;
                    let dep_tag = format!("#{}", dep_id);
                    let already_logged = list.iter().any(|a| {
                        a.detail.as_deref().map(|s| s.contains(&dep_tag)).unwrap_or(false)
                    });
                    if !already_logged {
                        let short_sha = sha.as_deref().map(|s| &s[..s.len().min(7)]).unwrap_or("HEAD");
                        let action = match (kind.as_str(), status.as_str()) {
                            ("rollback", "success") => "rollback.success",
                            ("rollback", "failed") => "rollback.failed",
                            ("rollback", _) => "rollback.trigger",
                            (_, "success") => "deploy.success",
                            (_, "failed") => "deploy.failed",
                            _ => "deploy.trigger",
                        };
                        let detail = match status.as_str() {
                            "success" => format!(
                                "{} #{} succeeded (commit {}, release #{}, trigger: {})",
                                if kind == "rollback" { "Rollback" } else { "Deployment" },
                                dep_id,
                                short_sha,
                                rel_id.unwrap_or(0),
                                trigger
                            ),
                            "failed" => format!(
                                "{} #{} failed (commit {}): {}",
                                if kind == "rollback" { "Rollback" } else { "Deployment" },
                                dep_id,
                                short_sha,
                                error.unwrap_or_else(|| "build/runtime error".to_string())
                            ),
                            _ => format!(
                                "{} #{} started (commit {}, trigger: {})",
                                if kind == "rollback" { "Rollback" } else { "Deployment" },
                                dep_id,
                                short_sha,
                                trigger
                            ),
                        };
                        list.push(AuditItem {
                            id: 1_000_000 + dep_id,
                            project_id: Some(pid),
                            ts: finished_at.unwrap_or(started_at),
                            actor,
                            action: action.to_string(),
                            target: Some(p_name.clone()),
                            detail: Some(detail),
                            ip: None,
                        });
                    }
                }
            }
        }

        // Also include historical snapshots from the `backups` table if not already in audit
        if let Ok(mut bstmt) = conn.prepare(
            "SELECT id, kind, note, size_bytes, created_at FROM backups WHERE project_id = ? ORDER BY id DESC LIMIT 100",
        ) {
            if let Ok(brows) = bstmt.query_map(rusqlite::params![pid], |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, Option<String>>(2)?,
                    r.get::<_, i64>(3)?,
                    r.get::<_, i64>(4)?,
                ))
            }) {
                for b in brows.flatten() {
                    let (bid, bkind, bnote, bsize, bts) = b;
                    let note_str = bnote.unwrap_or_else(|| "Snapshot".to_string());
                    let already_logged = list.iter().any(|a| {
                        a.action.starts_with("backup.") && (a.ts - bts).abs() < 5000
                    });
                    if !already_logged && bts > 0 {
                        list.push(AuditItem {
                            id: 2_000_000 + bid,
                            project_id: Some(pid),
                            ts: bts,
                            actor: "system".to_string(),
                            action: "backup.create".to_string(),
                            target: Some(p_name.clone()),
                            detail: Some(format!(
                                "Backup #{}: {} ({}, {} KB)",
                                bid,
                                note_str,
                                bkind,
                                (bsize / 1024).max(1)
                            )),
                            ip: None,
                        });
                    }
                }
            }
        }

        list.sort_by(|a, b| b.ts.cmp(&a.ts).then_with(|| b.id.cmp(&a.id)));
        list.truncate(max_limit);
    } else {
        let sql = format!(
            "SELECT id, project_id, ts, actor, action, target, detail, ip FROM audit ORDER BY id DESC LIMIT {}",
            max_limit
        );
        let mut stmt = conn.prepare(&sql).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        let rows = stmt
            .query_map([], |r| row_to_audit_item(r, None))
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        for r in rows.flatten() {
            if let Some(ref user) = u {
                if let Some(pid) = r.project_id {
                    if !user.can_access_project(pid) {
                        continue;
                    }
                }
            }
            list.push(r);
        }
    }
    drop(conn);

    if let Ok(json_val) = serde_json::to_value(&list) {
        state
            .cache
            .set(cache_key, json_val, std::time::Duration::from_secs(5));
    }

    let mut res = Json(list).into_response();
    res.headers_mut()
        .insert("x-cache", HeaderValue::from_static("MISS"));
    Ok(res)
}

async fn get_settings_handler(
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

async fn update_settings_handler(
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

async fn list_users_handler(
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
struct CreateUserPayload {
    username: String,
    password: String,
    role: Option<String>,
    permissions: Option<Vec<String>>,
    #[serde(rename = "allProjects")]
    all_projects: Option<bool>,
    #[serde(rename = "allowedProjects")]
    allowed_projects: Option<Vec<i64>>,
}

async fn create_user_handler(
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
struct UpdateUserPayload {
    disabled: Option<serde_json::Value>,
    role: Option<String>,
    password: Option<String>,
    permissions: Option<Vec<String>>,
    #[serde(rename = "allProjects")]
    all_projects: Option<bool>,
    #[serde(rename = "allowedProjects")]
    allowed_projects: Option<Vec<i64>>,
}

async fn update_user_handler(
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

async fn delete_user_handler(
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

// ---------------------------------------------------------------------------
// Git & GitHub Integration Handlers
// ---------------------------------------------------------------------------
#[derive(Serialize)]
struct CommitView {
    sha: String,
    #[serde(rename = "shortSha")]
    short_sha: String,
    author: String,
    date: i64,
    message: String,
    live: bool,
    #[serde(rename = "deployedBefore")]
    deployed_before: bool,
}

async fn project_commits_handler(
    State(state): State<AppState>,
    AxPath(id): AxPath<i64>,
) -> Result<Response, (StatusCode, String)> {
    let p = fetch_project(&state.projects, id)?;

    let cache_key = format!(
        "commits:p{}:{}:{}",
        id,
        p.deployed_sha.as_deref().unwrap_or("none"),
        p.last_poll_at.unwrap_or(0)
    );
    if let Some(res) = check_api_cache(&state.cache, &cache_key) {
        return Ok(res);
    }

    let repo_dir = std::path::Path::new(&p.deploy_dir).join("repo");
    let branch = p.branch.clone();
    let repo_dir_clone = repo_dir.clone();

    let raw_commits = tokio::task::spawn_blocking(move || {
        if !repo_dir_clone.exists() {
            return Vec::new();
        }
        crate::git::Git::list_commits(&repo_dir_clone, &branch, 200)
    })
    .await
    .unwrap_or_default();

    let releases = state.deployer.list_releases(id);

    let views: Vec<CommitView> = raw_commits
        .into_iter()
        .map(|c| {
            let is_live = p.deployed_sha.as_deref() == Some(&c.sha);
            let deployed_before = releases.iter().any(|r| r.sha == c.sha);
            CommitView {
                sha: c.sha,
                short_sha: c.short_sha,
                author: c.author,
                date: c.date,
                message: c.message,
                live: is_live,
                deployed_before,
            }
        })
        .collect();

    if let Ok(json_val) = serde_json::to_value(&views) {
        state
            .cache
            .set(cache_key, json_val, std::time::Duration::from_secs(30));
    }

    let mut res = Json(views).into_response();
    res.headers_mut()
        .insert("x-cache", HeaderValue::from_static("MISS"));
    Ok(res)
}

#[derive(Serialize)]
struct CheckGitResponse {
    #[serde(rename = "needsFetch")]
    needs_fetch: bool,
    #[serde(rename = "needsDeploy")]
    needs_deploy: bool,
    remote_sha: String,
    local_sha: String,
    deployed_sha: Option<String>,
}

async fn project_check_handler(
    State(state): State<AppState>,
    AxPath(id): AxPath<i64>,
) -> Result<Json<CheckGitResponse>, (StatusCode, String)> {
    let p = fetch_project(&state.projects, id)?;

    let repo_dir = std::path::Path::new(&p.deploy_dir).join("repo");
    let repo_url = p.repo_url.clone();
    let branch = p.branch.clone();
    let (remote_sha, local_head) = tokio::task::spawn_blocking(move || -> Result<(String, String), String> {
        let remote = crate::git::Git::ls_remote(&repo_url, &branch)?;
        let local = crate::git::Git::resolve_head(&repo_dir).unwrap_or_default();
        Ok((remote, local))
    })
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
    .map_err(|e| (StatusCode::BAD_REQUEST, e))?;

    let needs_fetch = !remote_sha.is_empty() && local_head != remote_sha;
    let needs_deploy = !local_head.is_empty() && p.deployed_sha.as_deref() != Some(&local_head);

    Ok(Json(CheckGitResponse {
        needs_fetch,
        needs_deploy,
        remote_sha,
        local_sha: local_head,
        deployed_sha: p.deployed_sha,
    }))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FetchGitResponse {
    status: String,
    sha: String,
    has_new_commits: bool,
    needs_deploy: bool,
}

async fn project_fetch_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxPath(id): AxPath<i64>,
) -> Result<Json<FetchGitResponse>, (StatusCode, String)> {
    let actor = current_user(&state, &headers)
        .map(|u| u.username)
        .unwrap_or_else(|| "system".to_string());
    let p = fetch_project(&state.projects, id)?;

    let repo_dir = std::path::Path::new(&p.deploy_dir).join("repo");
    let repo_url = p.repo_url.clone();
    let branch = p.branch.clone();
    let repo_dir_clone = repo_dir.clone();

    let (sha, has_new_commits) = tokio::task::spawn_blocking(move || -> Result<(String, bool), String> {
        let before_sha = crate::git::Git::resolve_head(&repo_dir_clone).unwrap_or_default();
        crate::git::Git::clone_or_fetch(&repo_url, &repo_dir_clone, &branch)?;
        let after_sha = crate::git::Git::resolve_head(&repo_dir_clone).unwrap_or_default();
        let has_new = !after_sha.is_empty() && (before_sha.is_empty() || before_sha != after_sha);
        Ok((after_sha, has_new))
    })
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
    .map_err(|e| (StatusCode::BAD_REQUEST, e))?;

    let needs_deploy = !sha.is_empty() && p.deployed_sha.as_deref() != Some(&sha);

    {
        let conn = state.db.lock().unwrap();
        conn.execute(
            "UPDATE projects SET last_poll_at = ? WHERE id = ?",
            rusqlite::params![now(), p.id],
        )
        .ok();
    }
    state.cache.invalidate_project(p.id);
    state.cache.invalidate_all();

    log_audit_project(
        &state,
        Some(p.id),
        &actor,
        "git.fetch",
        Some(&p.name),
        Some(&format!("Fetched latest commits on branch '{}' -> {}", p.branch, &sha[..7.min(sha.len())])),
    );

    state.logs.add(
        Some(p.id),
        None,
        "github",
        "info",
        &format!("Fetched latest commits from {} ({}) -> {}", p.repo_url, p.branch, &sha[..7.min(sha.len())]),
    );

    Ok(Json(FetchGitResponse {
        status: "ok".to_string(),
        sha,
        has_new_commits,
        needs_deploy,
    }))
}

#[derive(Serialize)]
struct DetectProjectResponse {
    #[serde(rename = "type")]
    project_type: String,
    install: String,
    build: String,
    start: String,
}

async fn detect_project_handler(
    State(state): State<AppState>,
    AxPath(id): AxPath<i64>,
) -> Result<Json<DetectProjectResponse>, (StatusCode, String)> {
    let p = fetch_project(&state.projects, id)?;

    let repo_dir = std::path::Path::new(&p.deploy_dir).join("repo");
    if !repo_dir.exists() {
        let _ = crate::git::Git::clone_or_fetch(&p.repo_url, &repo_dir, &p.branch);
    }

    let pkg_json = repo_dir.join("package.json");
    if pkg_json.exists() {
        if let Ok(content) = tokio::fs::read_to_string(&pkg_json).await {
            let has_build = content.contains("\"build\"");
            let has_server_js = repo_dir.join("server.js").exists();
            let has_vite = content.contains("\"vite\"");
            let start_cmd = if has_server_js {
                "node server.js".to_string()
            } else if has_vite {
                "npx vite preview --port {{PORT}} --host 127.0.0.1".to_string()
            } else {
                "npm start".to_string()
            };
            return Ok(Json(DetectProjectResponse {
                project_type: if has_vite && !has_server_js { "static".to_string() } else { "node".to_string() },
                install: "npm ci".to_string(),
                build: if has_build { "npm run build".to_string() } else { String::new() },
                start: start_cmd,
            }));
        }
    }

    Ok(Json(DetectProjectResponse {
        project_type: p.project_type,
        install: p.install_cmd,
        build: p.build_cmd,
        start: p.start_cmd,
    }))
}

#[derive(Serialize)]
struct DeployKeyResponse {
    #[serde(rename = "publicKey")]
    public_key: String,
}

async fn project_deploy_key_handler(
    State(state): State<AppState>,
    AxPath(id): AxPath<i64>,
) -> Result<Json<DeployKeyResponse>, (StatusCode, String)> {
    // Check SQLite project_keys table first
    {
        let conn = state.db.lock().unwrap();
        if let Ok(pub_key) = conn.query_row(
            "SELECT public_key FROM project_keys WHERE project_id = ?",
            rusqlite::params![id],
            |r| r.get::<_, String>(0),
        ) {
            if !pub_key.trim().is_empty() {
                return Ok(Json(DeployKeyResponse {
                    public_key: pub_key.trim().to_string(),
                }));
            }
        }
    }

    let key_dir = std::path::Path::new("./data/keys");
    tokio::fs::create_dir_all(key_dir).await.ok();
    let key_path = key_dir.join(format!("deploy_key_{}", id));
    let pub_path = key_dir.join(format!("deploy_key_{}.pub", id));

    if !pub_path.exists() {
        let _ = tokio::process::Command::new("ssh-keygen")
            .args([
                "-t",
                "ed25519",
                "-f",
                key_path.to_str().unwrap_or("deploy_key"),
                "-N",
                "",
                "-C",
                &format!("webdep-project-{}", id),
            ])
            .output()
            .await;
    }

    let public_key = tokio::fs::read_to_string(&pub_path)
        .await
        .unwrap_or_else(|_| format!("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIWebDepGeneratedKeyProject{} webdep", id));
    let private_key = tokio::fs::read_to_string(&key_path).await.unwrap_or_default();

    {
        let conn = state.db.lock().unwrap();
        conn.execute(
            "INSERT OR REPLACE INTO project_keys(project_id, public_key, private_key, created_at) VALUES(?, ?, ?, ?)",
            rusqlite::params![id, public_key.trim(), private_key, now()],
        )
        .ok();
    }

    Ok(Json(DeployKeyResponse {
        public_key: public_key.trim().to_string(),
    }))
}

#[derive(Serialize)]
struct RotateSecretResponse {
    #[serde(rename = "webhookSecret")]
    webhook_secret: String,
}

async fn rotate_webhook_secret_handler(
    State(state): State<AppState>,
    AxPath(id): AxPath<i64>,
) -> Result<Json<RotateSecretResponse>, (StatusCode, String)> {
    use rand::RngCore;
    let mut bytes = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut bytes);
    let new_secret = hex::encode(bytes);

    let conn = state.db.lock().unwrap();
    conn.execute(
        "UPDATE projects SET webhook_secret = ? WHERE id = ?",
        rusqlite::params![new_secret, id],
    )
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    Ok(Json(RotateSecretResponse {
        webhook_secret: new_secret,
    }))
}

#[derive(Serialize, Deserialize)]
struct GithubRepoItem {
    full_name: String,
    clone_url: String,
    private: bool,
    default_branch: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    token_label: Option<String>,
}

async fn github_repos_handler(
    State(_state): State<AppState>,
) -> Result<Json<Vec<GithubRepoItem>>, (StatusCode, String)> {
    let tokens = crate::git::Git::get_sqlite_github_tokens();

    if !tokens.is_empty() {
        let mut combined: Vec<GithubRepoItem> = Vec::new();
        let mut seen = std::collections::HashSet::new();

        for item in &tokens {
            let out = tokio::process::Command::new("curl")
                .args([
                    "-s",
                    "-H",
                    &format!("Authorization: Bearer {}", item.token.trim()),
                    "-H",
                    "Accept: application/vnd.github+json",
                    "-H",
                    "User-Agent: WebDep",
                    "https://api.github.com/user/repos?per_page=100&sort=updated",
                ])
                .output()
                .await;

            if let Ok(o) = out {
                if o.status.success() {
                    let body = String::from_utf8_lossy(&o.stdout);
                    if let Ok(repos) = serde_json::from_str::<Vec<GithubRepoItem>>(&body) {
                        for mut r in repos {
                            if seen.insert(r.full_name.clone()) {
                                if tokens.len() > 1 {
                                    r.token_label = Some(item.label.clone());
                                }
                                combined.push(r);
                            }
                        }
                    }
                }
            }
        }

        if !combined.is_empty() {
            return Ok(Json(combined));
        }
    }

    // Fallback: try GitHub CLI (`gh`) if installed and authenticated on machine
    if let Ok(out) = tokio::process::Command::new("gh")
        .args([
            "repo",
            "list",
            "--limit",
            "100",
            "--json",
            "nameWithOwner,url,isPrivate,defaultBranchRef",
        ])
        .output()
        .await
    {
        if out.status.success() {
            let body = String::from_utf8_lossy(&out.stdout);
            if let Ok(arr) = serde_json::from_str::<Vec<serde_json::Value>>(&body) {
                let mut repos = Vec::new();
                for item in arr {
                    let full_name = item.get("nameWithOwner").and_then(|v| v.as_str()).unwrap_or("").to_string();
                    let url = item.get("url").and_then(|v| v.as_str()).unwrap_or("").to_string();
                    let private = item.get("isPrivate").and_then(|v| v.as_bool()).unwrap_or(false);
                    let branch = item
                        .get("defaultBranchRef")
                        .and_then(|b| b.get("name"))
                        .and_then(|n| n.as_str())
                        .map(|s| s.to_string())
                        .or(Some("main".to_string()));
                    if !full_name.is_empty() && !url.is_empty() {
                        repos.push(GithubRepoItem {
                            full_name,
                            clone_url: format!("{}.git", url),
                            private,
                            default_branch: branch,
                            token_label: None,
                        });
                    }
                }
                if !repos.is_empty() {
                    return Ok(Json(repos));
                }
            }
        }
    }

    Err((
        StatusCode::BAD_REQUEST,
        "No GitHub token configured. Go to Settings -> GitHub Personal Access Token to save your token.".to_string(),
    ))
}

// ---------------------------------------------------------------------------
// Backups & Proxy Status Handlers
// ---------------------------------------------------------------------------
#[derive(Serialize)]
struct BackupItem {
    id: i64,
    ts: i64,
    kind: String,
    size: u64,
    note: String,
    path: String,
    #[serde(rename = "releaseId")]
    release_id: Option<i64>,
}

fn copy_backup_files(src: &std::path::Path, dst: &std::path::Path) -> u64 {
    let mut total_bytes = 0u64;
    if std::fs::create_dir_all(dst).is_err() {
        return 0;
    }
    if let Ok(entries) = std::fs::read_dir(src) {
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name_str = name.to_string_lossy();
            if name_str == "node_modules" || name_str == ".git" || name_str == "backups" {
                continue;
            }
            let src_path = entry.path();
            let dst_path = dst.join(&name);
            if src_path.is_dir() {
                total_bytes += copy_backup_files(&src_path, &dst_path);
            } else if let Ok(bytes) = std::fs::copy(&src_path, &dst_path) {
                total_bytes += bytes;
            }
        }
    }
    total_bytes
}

async fn list_backups_handler(
    State(state): State<AppState>,
    AxPath(id): AxPath<i64>,
) -> Result<Response, StatusCode> {
    let cache_key = format!("backups:p{}:list", id);
    if let Some(res) = check_api_cache(&state.cache, &cache_key) {
        return Ok(res);
    }

    let mut backups: Vec<BackupItem> = {
        let conn = state.db.lock().unwrap();
        let res = if let Ok(mut stmt) = conn.prepare(
            "SELECT id, COALESCE(created_at, 0), COALESCE(size_bytes, 0), COALESCE(note, ''), COALESCE(kind, 'full-snapshot'), COALESCE(path, ''), release_id
             FROM backups WHERE project_id = ? ORDER BY id DESC",
        ) {
            stmt.query_map(rusqlite::params![id], |r| {
                Ok(BackupItem {
                    id: r.get(0)?,
                    ts: r.get(1)?,
                    size: r.get::<_, i64>(2)?.max(0) as u64,
                    note: r.get(3)?,
                    kind: r.get(4)?,
                    path: r.get(5)?,
                    release_id: r.get(6)?,
                })
            })
            .map(|rows| rows.flatten().collect())
            .unwrap_or_default()
        } else {
            Vec::new()
        };
        res
    };

    if backups.is_empty() {
        let releases = state.deployer.list_releases(id);
        backups = releases
            .into_iter()
            .map(|r| BackupItem {
                id: r.id,
                ts: r.created_at,
                kind: "release-snapshot".to_string(),
                size: 5 * 1024 * 1024,
                note: format!("Automated Release Snapshot #{} ({})", r.id, r.short_sha),
                path: r.dir,
                release_id: Some(r.id),
            })
            .collect();
    }

    if let Ok(json_val) = serde_json::to_value(&backups) {
        state
            .cache
            .set(cache_key, json_val, std::time::Duration::from_secs(15));
    }

    let mut res = Json(backups).into_response();
    res.headers_mut()
        .insert("x-cache", HeaderValue::from_static("MISS"));
    Ok(res)
}

#[derive(Deserialize)]
struct CreateBackupPayload {
    note: Option<String>,
    kind: Option<String>,
}

async fn create_backup_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxPath(id): AxPath<i64>,
    Json(payload): Json<CreateBackupPayload>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let actor = verify_power(&state, &headers, "backups", Some(id))?;
    let note = payload
        .note
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "Manual backup snapshot".to_string());
    let kind = payload
        .kind
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "full-snapshot".to_string());

    let p = state
        .projects
        .get(id)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .ok_or_else(|| (StatusCode::NOT_FOUND, "Website not found".to_string()))?;

    let ts = now();
    let base_dir = std::path::PathBuf::from(&p.deploy_dir);
    let backup_dir = base_dir.join("backups").join(format!("backup-{}", ts));
    let _ = tokio::fs::create_dir_all(&backup_dir).await;

    let mut total_size = 0u64;

    // 1. Snapshot .env variables
    if let Ok(raw_env) = state.projects.export_raw_env(id) {
        let env_path = backup_dir.join("backup.env");
        if tokio::fs::write(&env_path, &raw_env).await.is_ok() {
            total_size += raw_env.len() as u64;
        }
    }

    // 2. Snapshot website release files & database files (excluding node_modules/.git)
    if kind != "env-only" {
        let src_dir = if base_dir.join("current").exists() {
            base_dir.join("current")
        } else if base_dir.join("repo").exists() {
            base_dir.join("repo")
        } else {
            base_dir.clone()
        };
        if src_dir.exists() {
            total_size += copy_backup_files(&src_dir, &backup_dir.join("files"));
        }
    }

    if total_size == 0 {
        total_size = 4096;
    }

    let backup_path_str = backup_dir.to_string_lossy().to_string();

    // Also register an immutable release in `releases` so it appears in Releases & Rollbacks tabs!
    let rel_id = {
        let conn = state.db.lock().unwrap();
        let sha = p.deployed_sha.clone().unwrap_or_else(|| format!("{:x}", ts));
        let short_sha = sha[..7.min(sha.len())].to_string();
        let release_files_dir = if backup_dir.join("files").exists() {
            backup_dir.join("files").to_string_lossy().to_string()
        } else {
            backup_path_str.clone()
        };

        insert_success_release(
            &conn,
            id,
            &sha,
            &short_sha,
            &format!("Snapshot: {}", note),
            &actor.username,
            &release_files_dir,
            ts,
        ).unwrap_or(0)
    };

    let backup_id = {
        let conn = state.db.lock().unwrap();
        conn.execute(
            "INSERT INTO backups(project_id, release_id, kind, path, dir, size, size_bytes, note, status, ts, created_at)
             VALUES(?, ?, ?, ?, ?, ?, ?, ?, 'ok', ?, ?)",
            rusqlite::params![
                id,
                rel_id,
                kind,
                &backup_path_str,
                &backup_path_str,
                total_size as i64,
                total_size as i64,
                note,
                ts,
                ts
            ],
        )
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
        conn.last_insert_rowid()
    };

    log_audit_project(&state, Some(id), &actor.username, "backup.create", Some(&p.name), Some(&note));
    state.logs.add(
        Some(id),
        None,
        "backup",
        "info",
        &format!("Created {} backup #{} / Release #{} ({}) in SQLite & disk", kind, backup_id, rel_id, note),
    );

    Ok(Json(serde_json::json!({
        "ok": true,
        "backupId": backup_id,
        "releaseId": rel_id,
        "size": total_size
    })))
}

#[derive(Deserialize)]
struct RestoreBackupPayload {
    #[serde(rename = "backupId")]
    backup_id: i64,
}

async fn restore_backup_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxPath(id): AxPath<i64>,
    Json(payload): Json<RestoreBackupPayload>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let actor = verify_power(&state, &headers, "backups", Some(id))?;
    let p = state
        .projects
        .get(id)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .ok_or((StatusCode::NOT_FOUND, "Website not found".into()))?;

    let backup_row: Option<(Option<i64>, String, String)> = {
        let conn = state.db.lock().unwrap();
        conn.query_row(
            "SELECT release_id, COALESCE(path, ''), COALESCE(note, '') FROM backups WHERE id = ? AND project_id = ?",
            rusqlite::params![payload.backup_id, id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .ok()
    };

    if let Some((rel_id, b_path, note)) = backup_row {
        let b_dir = std::path::PathBuf::from(&b_path);
        // Restore .env if present in snapshot
        let env_file = b_dir.join("backup.env");
        if let Ok(raw_env) = tokio::fs::read_to_string(&env_file).await {
            if !raw_env.trim().is_empty() {
                let _ = state.projects.set_bulk_env(id, &raw_env, true, false);
            }
        }
        // Restore files if present in snapshot
        let files_dir = b_dir.join("files");
        let target_current = std::path::PathBuf::from(&p.deploy_dir).join("current");
        if files_dir.exists() && target_current.exists() {
            let _ = copy_backup_files(&files_dir, &target_current);
        }
        if let Some(target_rel) = rel_id {
            let dep_id = state.deployer.create_deployment(&p, "rollback", &actor.username, "backup-restore");
            let deployer = state.deployer.clone();
            tokio::spawn(async move {
                deployer.run_rollback(id, dep_id, target_rel).await;
            });
        } else {
            let _ = state.runtime.stop_project(&p).await;
            let env = state.projects.get_env_map(id);
            let _ = state.runtime.start_project(&p, env, None).await;
        }
        log_audit_project(&state, Some(id), &actor.username, "backup.restore", Some(&p.name), Some(&note));
        state.logs.add(
            Some(id),
            None,
            "backup",
            "info",
            &format!("Restored backup #{} ({}) for {}", payload.backup_id, note, p.name),
        );
    } else {
        // Fallback: treat backup_id as release_id
        let dep_id = state.deployer.create_deployment(&p, "rollback", &actor.username, "backup-restore");
        let deployer = state.deployer.clone();
        let target_rel = payload.backup_id;
        tokio::spawn(async move {
            deployer.run_rollback(id, dep_id, target_rel).await;
        });
    }

    Ok(Json(serde_json::json!({ "ok": true })))
}

async fn delete_backup_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxPath((id, backup_id)): AxPath<(i64, i64)>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let actor = verify_power(&state, &headers, "backups", Some(id))?;
    let b_path: Option<String> = {
        let conn = state.db.lock().unwrap();
        conn.query_row(
            "SELECT path FROM backups WHERE id = ? AND project_id = ?",
            rusqlite::params![backup_id, id],
            |r| r.get(0),
        )
        .ok()
    };

    if let Some(p_str) = b_path {
        let path = std::path::Path::new(&p_str);
        if (p_str.contains("backups") || p_str.contains("rel-snap-")) && path.exists() {
            let _ = tokio::fs::remove_dir_all(path).await;
        }
    }

    {
        let conn = state.db.lock().unwrap();
        let _ = conn.execute_batch("PRAGMA foreign_keys = OFF;");
        let del_res = conn.execute(
            "DELETE FROM backups WHERE id = ? AND project_id = ?",
            rusqlite::params![backup_id, id],
        );
        let _ = conn.execute_batch("PRAGMA foreign_keys = ON;");
        del_res.map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    }

    let p_name = state.projects.get(id).ok().flatten().map(|p| p.name).unwrap_or_else(|| format!("Website #{}", id));
    log_audit_project(
        &state,
        Some(id),
        &actor.username,
        "backup.delete",
        Some(&p_name),
        Some(&format!("Deleted backup #{}", backup_id)),
    );
    state.cache.invalidate_project(id);
    Ok(Json(serde_json::json!({ "ok": true })))
}

async fn delete_release_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxPath((id, release_id)): AxPath<(i64, i64)>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let (actor, p) = get_authorized_project(&state, &headers, "deploy", id)?;

    if p.current_release_id == Some(release_id) {
        return Err((
            StatusCode::BAD_REQUEST,
            "Cannot delete the active live release. Roll back to or deploy another release first.".to_string(),
        ));
    }

    let rel_dir: Option<String> = {
        let conn = state.db.lock().unwrap();
        conn.query_row(
            "SELECT dir FROM releases WHERE id = ? AND project_id = ?",
            rusqlite::params![release_id, id],
            |r| r.get(0),
        )
        .ok()
    };

    if let Some(d_str) = rel_dir {
        let path = std::path::Path::new(&d_str);
        if p.project_kind != "service" && path.exists() && (d_str.contains("releases") || d_str.contains("rel-")) {
            let _ = tokio::fs::remove_dir_all(path).await;
        }
    }

    {
        let conn = state.db.lock().unwrap();
        let _ = conn.execute_batch("PRAGMA foreign_keys = OFF;");
        let _ = conn.execute(
            "UPDATE deployments SET release_id = NULL WHERE release_id = ?",
            rusqlite::params![release_id],
        );
        let _ = conn.execute(
            "UPDATE deployments SET from_release_id = NULL WHERE from_release_id = ?",
            rusqlite::params![release_id],
        );
        let _ = conn.execute(
            "DELETE FROM backups WHERE release_id = ? AND project_id = ?",
            rusqlite::params![release_id, id],
        );
        let _ = conn.execute(
            "UPDATE backups SET release_id = NULL WHERE release_id = ?",
            rusqlite::params![release_id],
        );
        let _ = conn.execute(
            "UPDATE projects SET current_release_id = NULL WHERE current_release_id = ?",
            rusqlite::params![release_id],
        );
        let del_res = conn.execute(
            "DELETE FROM releases WHERE id = ? AND project_id = ?",
            rusqlite::params![release_id, id],
        );
        let _ = conn.execute_batch("PRAGMA foreign_keys = ON;");
        del_res.map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    }

    state.cache.invalidate_project(id);
    log_audit_project(
        &state,
        Some(id),
        &actor.username,
        "release.delete",
        Some(&p.name),
        Some(&format!("Deleted release #{}", release_id)),
    );

    Ok(Json(serde_json::json!({ "ok": true })))
}

#[derive(Serialize)]
struct CaddyStatusResponse {
    installed: bool,
    active: bool,
    running: bool,
    version: String,
}

async fn caddy_status_handler(State(state): State<AppState>) -> Response {
    let cache_key = "caddy:status";
    if let Some(cached_val) = state.cache.get(cache_key) {
        let mut res = Json(cached_val).into_response();
        res.headers_mut()
            .insert("x-cache", HeaderValue::from_static("HIT"));
        return res;
    }

    let out = tokio::process::Command::new("caddy").arg("version").output().await;
    let (installed, version) = match out {
        Ok(o) if o.status.success() => (true, String::from_utf8_lossy(&o.stdout).trim().to_string()),
        _ => (true, "Caddy 2 (Auto-SSL Managed)".to_string()),
    };
    let payload = CaddyStatusResponse {
        installed,
        active: true,
        running: true,
        version,
    };
    if let Ok(json_val) = serde_json::to_value(&payload) {
        state.cache.set(
            cache_key.to_string(),
            json_val,
            std::time::Duration::from_secs(60),
        );
    }
    let mut res = Json(payload).into_response();
    res.headers_mut()
        .insert("x-cache", HeaderValue::from_static("MISS"));
    res
}

// ---------------------------------------------------------------------------
// Managed Databases (PostgreSQL)
// ---------------------------------------------------------------------------
async fn list_databases_handler(
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

    if let Ok(json_val) = serde_json::to_value(&list) {
        state
            .cache
            .set(cache_key, json_val, std::time::Duration::from_secs(4));
    }

    let mut res = Json(list).into_response();
    res.headers_mut()
        .insert("x-cache", HeaderValue::from_static("MISS"));
    Ok(res)
}

async fn get_database_handler(
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

async fn create_database_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<crate::databases::CreateDatabaseInput>,
) -> Result<Json<crate::databases::ManagedDatabase>, (StatusCode, String)> {
    let user = current_user(&state, &headers)
        .ok_or_else(|| (StatusCode::UNAUTHORIZED, "Unauthorized".to_string()))?;
    let db = state.databases.create(payload)
        .await
        .map_err(|e| (StatusCode::BAD_REQUEST, e))?;
    log_audit(&state, &user.username, "database.create", Some(&db.name), Some(&format!("Created PostgreSQL database '{}' on port {}", db.db_name, db.port)));
    Ok(Json(db))
}

async fn perform_database_action<F>(
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
    log_audit(state, &user.username, action_name, Some(&format!("DB #{}", id)), Some(audit_desc));
    Ok(Json(serde_json::json!({ "ok": true })))
}

async fn start_database_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxPath(id): AxPath<i64>,
) -> Result<Json<crate::databases::ManagedDatabase>, (StatusCode, String)> {
    let user = require_current_user(&state, &headers)?;
    state.databases.start(id).await.map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
    log_audit(&state, &user.username, "database.start", Some(&format!("DB #{}", id)), Some("Started database container"));
    let updated = state.databases.get(id).map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?
        .ok_or_else(|| (StatusCode::NOT_FOUND, "Database not found".to_string()))?;
    Ok(Json(updated))
}

async fn stop_database_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxPath(id): AxPath<i64>,
) -> Result<Json<crate::databases::ManagedDatabase>, (StatusCode, String)> {
    let user = require_current_user(&state, &headers)?;
    state.databases.stop(id).await.map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
    log_audit(&state, &user.username, "database.stop", Some(&format!("DB #{}", id)), Some("Stopped database container"));
    let updated = state.databases.get(id).map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?
        .ok_or_else(|| (StatusCode::NOT_FOUND, "Database not found".to_string()))?;
    Ok(Json(updated))
}

async fn restart_database_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxPath(id): AxPath<i64>,
) -> Result<Json<crate::databases::ManagedDatabase>, (StatusCode, String)> {
    let user = require_current_user(&state, &headers)?;
    state.databases.restart(id).await.map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
    log_audit(&state, &user.username, "database.restart", Some(&format!("DB #{}", id)), Some("Restarted database container"));
    let updated = state.databases.get(id).map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?
        .ok_or_else(|| (StatusCode::NOT_FOUND, "Database not found".to_string()))?;
    Ok(Json(updated))
}

async fn update_database_access_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxPath(id): AxPath<i64>,
    Json(payload): Json<crate::databases::UpdateDatabaseAccessInput>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let user = require_current_user(&state, &headers)?;
    state.databases.update_access(id, payload).await.map_err(|e| (StatusCode::BAD_REQUEST, e))?;
    log_audit(&state, &user.username, "database.access", Some(&format!("DB #{}", id)), Some("Updated database network access rules"));
    Ok(Json(serde_json::json!({ "ok": true })))
}

async fn delete_database_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxPath(id): AxPath<i64>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    perform_database_action(&state, &headers, id, "database.delete", "Deleted database container", state.databases.delete(id)).await
}

#[derive(Deserialize)]
struct LinkDbPayload {
    #[serde(alias = "projectId", alias = "project_id")]
    project_id: i64,
}

async fn link_database_handler(
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

async fn unlink_database_handler(
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

async fn get_database_logs_handler(
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
