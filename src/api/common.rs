use axum::{
    extract::{Request, State},
    http::{HeaderMap, HeaderValue, Method, StatusCode},
    middleware::Next,
    response::Response,
    Json,
};
pub(crate) use axum::http::header;
pub(crate) use axum::response::IntoResponse;
use serde::Serialize;
use std::sync::Arc;

pub(crate) use crate::auth::{constant_time_eq, verify_password, Auth, User};
pub(crate) use crate::cache::AppCache;
pub(crate) use crate::caddy::Caddy;
pub(crate) use crate::db::{now, DbPool};
pub(crate) use crate::deployer::Deployer;
pub(crate) use crate::logs::Logs;
pub(crate) use crate::monitor::Monitor;
pub(crate) use crate::projects::{Project, Projects};
pub(crate) use crate::runtime::Runtime;
pub(crate) use crate::static_assets::static_handler;

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


pub(crate) async fn security_middleware(
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
    if is_api && is_mutating && path != "/api/auth/presence" {
        state.cache.invalidate_all();
        if path.starts_with("/api/users") || (path.starts_with("/api/auth/") && path != "/api/auth/presence") {
            state.auth.invalidate_sessions();
        }
    }
    attach_security_headers(&mut res, is_api);
    res
}

pub(crate) fn attach_security_headers(res: &mut Response, is_api: bool) {
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
    headers.insert(
        header::HeaderName::from_static("cross-origin-opener-policy"),
        HeaderValue::from_static("same-origin"),
    );
    if is_api {
        headers.insert(
            header::CACHE_CONTROL,
            HeaderValue::from_static("no-store, no-cache, must-revalidate"),
        );
    }
}

pub(crate) async fn axum_static_fallback(headers: HeaderMap, uri: axum::http::Uri) -> Response {
    static_handler(uri.path(), &headers, uri.query()).await
}


// ---------------------------------------------------------------------------
// Helpers: Session Cookie
// ---------------------------------------------------------------------------
pub(crate) fn extract_session_id(headers: &HeaderMap) -> Option<String> {
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

pub(crate) fn current_user(state: &AppState, headers: &HeaderMap) -> Option<User> {
    let sid = extract_session_id(headers)?;
    state.auth.get_session(&sid).map(|(_, u)| u)
}

pub(crate) fn require_current_user(state: &AppState, headers: &HeaderMap) -> Result<User, (StatusCode, String)> {
    current_user(state, headers).ok_or_else(|| (StatusCode::UNAUTHORIZED, "Unauthorized".to_string()))
}

pub(crate) fn verify_project_access(
    state: &AppState,
    headers: &HeaderMap,
    project_id: i64,
) -> Result<User, (StatusCode, String)> {
    let u = require_current_user(state, headers)?;
    if !u.can_access_project(project_id) {
        return Err((
            StatusCode::FORBIDDEN,
            "Access denied: You are not assigned to this website.".to_string(),
        ));
    }
    Ok(u)
}

pub(crate) fn verify_main_admin(state: &AppState, headers: &HeaderMap) -> Result<User, (StatusCode, String)> {
    let u = require_current_user(state, headers)?;
    if !u.is_main_admin {
        return Err((
            StatusCode::FORBIDDEN,
            "Only the Main Admin can perform this action.".to_string(),
        ));
    }
    Ok(u)
}

pub(crate) fn verify_power(
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

pub(crate) fn get_authorized_project(
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

pub(crate) fn log_audit(state: &AppState, actor: &str, action: &str, target: Option<&str>, detail: Option<&str>) {
    log_audit_project(state, None, actor, action, target, detail);
}

pub(crate) fn create_authenticated_response(
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

pub(crate) fn check_api_cache(cache: &crate::cache::AppCache, cache_key: &str) -> Option<Response> {
    if let Some(cached_bytes) = cache.get_bytes(cache_key) {
        let res = Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, "application/json")
            .header("x-cache", HeaderValue::from_static("HIT"))
            .body(axum::body::Body::from(cached_bytes))
            .unwrap_or_else(|_| Json(serde_json::json!({})).into_response());
        Some(res)
    } else {
        None
    }
}

pub(crate) fn cached_json_response<T: Serialize>(
    cache: &crate::cache::AppCache,
    cache_key: String,
    val: &T,
    ttl: std::time::Duration,
) -> Result<Response, StatusCode> {
    let json_str = serde_json::to_string(val).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let bytes = axum::body::Bytes::from(json_str);
    cache.set_bytes(cache_key, bytes.clone(), ttl);
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "application/json")
        .header("x-cache", HeaderValue::from_static("MISS"))
        .body(axum::body::Body::from(bytes))
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

pub(crate) fn fetch_project(
    projects: &crate::projects::Projects,
    id: i64,
) -> Result<crate::projects::Project, (StatusCode, String)> {
    projects
        .get(id)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .ok_or_else(|| (StatusCode::NOT_FOUND, "Project not found".to_string()))
}

pub(crate) fn verify_current_user_password(
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

pub(crate) fn apply_2fa_state_change(
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

pub(crate) fn insert_success_release(
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

pub(crate) fn trigger_background_deploy(deployer: Arc<crate::deployer::Deployer>, project_id: i64, dep_id: i64) {
    tokio::spawn(async move {
        deployer.run_deploy(project_id, dep_id).await;
    });
}

pub(crate) fn log_audit_project(
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


#[derive(Serialize)]
pub(crate) struct LoginResponse {
    pub(crate) user: User,
    pub(crate) csrf: String,
    #[serde(rename = "activeSessions")]
    pub(crate) active_sessions: usize,
    #[serde(rename = "passkeyCount")]
    pub(crate) passkey_count: usize,
}


#[derive(Serialize)]
pub(crate) struct ActionResponse {
    #[serde(rename = "deploymentId")]
    pub(crate) deployment_id: i64,
}
