use axum::{
    body::Body,
    extract::{Path as AxPath, Query, State},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::{
        sse::{Event, KeepAlive, Sse},
        IntoResponse, Response,
    },
    routing::{delete, get, post},
    Json, Router,
};
use futures_util::stream::Stream;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::convert::Infallible;
use std::sync::Arc;
use tokio_stream::wrappers::BroadcastStream;
use tokio_stream::StreamExt;

use crate::auth::{hash_password, verify_password, Auth, User};
use crate::caddy::Caddy;
use crate::db::{now, DbPool};
use crate::deployer::Deployer;
use crate::logs::Logs;
use crate::monitor::Monitor;
use crate::projects::{EnvVarView, Project, Projects};
use crate::runtime::Runtime;
use crate::static_assets::static_handler;

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
}

pub fn create_router(state: AppState) -> Router {
    Router::new()
        // Auth endpoints
        .route("/api/auth/login", post(login_handler))
        .route("/api/auth/logout", post(logout_handler))
        .route("/api/auth/me", get(me_handler))
        .route("/api/auth/password", post(change_password_handler))
        // Projects
        .route("/api/projects", get(list_projects_handler).post(create_project_handler))
        .route(
            "/api/projects/:id",
            get(get_project_handler)
                .patch(update_project_handler)
                .delete(delete_project_handler),
        )
        // Project Env
        .route("/api/projects/:id/env", get(get_env_handler).put(set_env_handler))
        .route("/api/projects/:id/env/reveal", post(reveal_env_handler))
        .route("/api/projects/:id/env/:key", delete(delete_env_handler))
        // Project Lifecycle & Actions
        .route("/api/projects/:id/deploy", post(deploy_project_handler))
        .route("/api/projects/:id/rollback", post(rollback_project_handler))
        .route("/api/projects/:id/start", post(start_project_handler))
        .route("/api/projects/:id/stop", post(stop_project_handler))
        .route("/api/projects/:id/restart", post(restart_project_handler))
        .route("/api/projects/:id/releases", get(list_releases_handler))
        .route("/api/projects/:id/caddy", get(get_caddy_handler))
        .route("/api/projects/:id/caddy/apply", post(apply_caddy_handler))
        .route("/api/projects/:id/nginx", get(get_caddy_handler))
        .route("/api/projects/:id/nginx/apply", post(apply_caddy_handler))
        .route("/api/projects/:id/nginx/certbot", post(certbot_caddy_handler))
        .route("/api/projects/:id/app-logs", get(get_app_logs_handler))
        // Deployments & Releases
        .route("/api/deployments", get(list_deployments_handler))
        // Live Logs SSE & Download
        .route("/api/logs/stream", get(logs_sse_handler))
        .route("/api/logs/download", get(logs_download_handler))
        // Overview & Telemetry
        .route("/api/overview", get(overview_handler))
        .route("/api/monitor", get(monitor_handler))
        .route("/api/audit", get(audit_handler))
        .route("/api/settings", get(get_settings_handler).patch(update_settings_handler))
        .route("/api/users", get(list_users_handler).post(create_user_handler))
        .route("/healthz", get(|| async { (StatusCode::OK, "ok") }))
        // Static assets fallback
        .fallback(axum_static_fallback)
        .with_state(state)
}

async fn axum_static_fallback(uri: axum::http::Uri) -> Response {
    static_handler(uri.path()).await
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

// ---------------------------------------------------------------------------
// Auth Handlers
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
}

async fn login_handler(
    State(state): State<AppState>,
    Json(payload): Json<LoginPayload>,
) -> Result<Response, (StatusCode, &'static str)> {
    let (user, hash) = state
        .auth
        .get_user_by_username(&payload.username)
        .ok_or((StatusCode::UNAUTHORIZED, "Invalid username or password"))?;

    if !verify_password(&payload.password, &hash) {
        return Err((StatusCode::UNAUTHORIZED, "Invalid username or password"));
    }

    let session = state
        .auth
        .create_session(user.id)
        .map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, "Failed to create session"))?;

    let cookie_val = format!(
        "nd_session={}; Path=/; HttpOnly; SameSite=Lax; Max-Age={}",
        session.id, state.auth.session_ttl_s
    );

    let body = Json(LoginResponse {
        user,
        csrf: session.csrf_token,
    });

    let mut res = body.into_response();
    res.headers_mut().insert(
        header::SET_COOKIE,
        HeaderValue::from_str(&cookie_val).unwrap(),
    );
    Ok(res)
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
        HeaderValue::from_static("nd_session=; Path=/; HttpOnly; Max-Age=0"),
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

    Ok(Json(LoginResponse {
        user,
        csrf: session.csrf_token,
    }))
}

#[derive(Deserialize)]
struct PasswordChangePayload {
    current: String,
    next: String,
}

async fn change_password_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<PasswordChangePayload>,
) -> Result<StatusCode, (StatusCode, &'static str)> {
    let session_id = extract_session_id(&headers).ok_or((StatusCode::UNAUTHORIZED, "Unauthorized"))?;
    let (_, user) = state
        .auth
        .get_session(&session_id)
        .ok_or((StatusCode::UNAUTHORIZED, "Unauthorized"))?;

    let (_, current_hash) = state
        .auth
        .get_user_by_username(&user.username)
        .ok_or((StatusCode::UNAUTHORIZED, "User not found"))?;

    if !verify_password(&payload.current, &current_hash) {
        return Err((StatusCode::BAD_REQUEST, "Current password incorrect"));
    }

    if payload.next.len() < 8 {
        return Err((StatusCode::BAD_REQUEST, "Password must be at least 8 characters"));
    }

    let next_hash = hash_password(&payload.next)
        .map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, "Failed to hash password"))?;

    let conn = state.db.lock().unwrap();
    conn.execute(
        "UPDATE users SET password_hash=? WHERE id=?",
        rusqlite::params![next_hash, user.id],
    )
    .map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, "Database error"))?;

    Ok(StatusCode::OK)
}

// ---------------------------------------------------------------------------
// Projects Handlers
// ---------------------------------------------------------------------------
async fn list_projects_handler(
    State(state): State<AppState>,
) -> Result<Json<Vec<Project>>, StatusCode> {
    let list = state.projects.list().map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(list))
}

async fn get_project_handler(
    State(state): State<AppState>,
    AxPath(id): AxPath<i64>,
) -> Result<Json<Project>, StatusCode> {
    let p = state
        .projects
        .get(id)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .ok_or(StatusCode::NOT_FOUND)?;
    Ok(Json(p))
}

async fn create_project_handler(
    State(state): State<AppState>,
    Json(mut p): Json<Project>,
) -> Result<Json<Project>, (StatusCode, String)> {
    if p.name.trim().is_empty() || p.slug.trim().is_empty() || p.repo_url.trim().is_empty() {
        return Err((StatusCode::BAD_REQUEST, "Name, slug, and repo_url are required".into()));
    }
    if p.deploy_dir.trim().is_empty() {
        p.deploy_dir = format!("./data/apps/{}", p.slug);
    }
    let id = state
        .projects
        .create(&p)
        .map_err(|e| (StatusCode::BAD_REQUEST, e.to_string()))?;

    let created = state
        .projects
        .get(id)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .ok_or((StatusCode::NOT_FOUND, "Project not found".into()))?;

    Ok(Json(created))
}

async fn update_project_handler(
    State(state): State<AppState>,
    AxPath(id): AxPath<i64>,
    Json(p): Json<Project>,
) -> Result<Json<Project>, (StatusCode, String)> {
    state
        .projects
        .update(id, &p)
        .map_err(|e| (StatusCode::BAD_REQUEST, e.to_string()))?;

    let updated = state
        .projects
        .get(id)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .ok_or((StatusCode::NOT_FOUND, "Project not found".into()))?;

    Ok(Json(updated))
}

async fn delete_project_handler(
    State(state): State<AppState>,
    AxPath(id): AxPath<i64>,
) -> Result<StatusCode, StatusCode> {
    state.projects.delete(id).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(StatusCode::OK)
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
}

async fn set_env_handler(
    State(state): State<AppState>,
    AxPath(id): AxPath<i64>,
    Json(payload): Json<SetEnvPayload>,
) -> Result<StatusCode, (StatusCode, String)> {
    state
        .projects
        .set_env_var(id, &payload.key, &payload.value, payload.is_secret.unwrap_or(false))
        .map_err(|e| (StatusCode::BAD_REQUEST, e.to_string()))?;
    Ok(StatusCode::OK)
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
    AxPath(id): AxPath<i64>,
    Json(payload): Json<RevealEnvPayload>,
) -> Result<Json<RevealEnvResponse>, StatusCode> {
    let val = state.projects.reveal_env_var(id, &payload.key).ok_or(StatusCode::NOT_FOUND)?;
    Ok(Json(RevealEnvResponse {
        key: payload.key,
        value: val,
    }))
}

async fn delete_env_handler(
    State(state): State<AppState>,
    AxPath((id, key)): AxPath<(i64, String)>,
) -> Result<StatusCode, StatusCode> {
    state.projects.delete_env_var(id, &key).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
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

async fn deploy_project_handler(
    State(state): State<AppState>,
    AxPath(id): AxPath<i64>,
) -> Result<Json<ActionResponse>, (StatusCode, String)> {
    let p = state
        .projects
        .get(id)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .ok_or((StatusCode::NOT_FOUND, "Project not found".into()))?;

    let dep_id = state.deployer.create_deployment(&p, "deploy", "admin", "manual");
    let deployer = state.deployer.clone();

    // Async task executes deployment in background
    tokio::spawn(async move {
        deployer.run_deploy(p.id, dep_id).await;
    });

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
    AxPath(id): AxPath<i64>,
    Json(_payload): Json<RollbackPayload>,
) -> Result<Json<ActionResponse>, (StatusCode, String)> {
    let p = state
        .projects
        .get(id)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .ok_or((StatusCode::NOT_FOUND, "Project not found".into()))?;

    let dep_id = state.deployer.create_deployment(&p, "rollback", "admin", "manual");
    let deployer = state.deployer.clone();

    tokio::spawn(async move {
        deployer.run_deploy(p.id, dep_id).await;
    });

    Ok(Json(ActionResponse { deployment_id: dep_id }))
}

async fn start_project_handler(
    State(state): State<AppState>,
    AxPath(id): AxPath<i64>,
) -> Result<StatusCode, (StatusCode, String)> {
    let p = state
        .projects
        .get(id)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .ok_or((StatusCode::NOT_FOUND, "Project not found".into()))?;

    let env = state.projects.get_env_map(id);
    state
        .runtime
        .start_project(&p, env)
        .await
        .map_err(|e| (StatusCode::BAD_REQUEST, e))?;

    Ok(StatusCode::OK)
}

async fn stop_project_handler(
    State(state): State<AppState>,
    AxPath(id): AxPath<i64>,
) -> Result<StatusCode, (StatusCode, String)> {
    let p = state
        .projects
        .get(id)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .ok_or((StatusCode::NOT_FOUND, "Project not found".into()))?;

    state
        .runtime
        .stop_project(&p)
        .await
        .map_err(|e| (StatusCode::BAD_REQUEST, e))?;

    Ok(StatusCode::OK)
}

async fn restart_project_handler(
    State(state): State<AppState>,
    AxPath(id): AxPath<i64>,
) -> Result<StatusCode, (StatusCode, String)> {
    let p = state
        .projects
        .get(id)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .ok_or((StatusCode::NOT_FOUND, "Project not found".into()))?;

    let _ = state.runtime.stop_project(&p).await;
    let env = state.projects.get_env_map(id);
    state
        .runtime
        .start_project(&p, env)
        .await
        .map_err(|e| (StatusCode::BAD_REQUEST, e))?;

    Ok(StatusCode::OK)
}

async fn list_releases_handler(
    State(state): State<AppState>,
    AxPath(id): AxPath<i64>,
) -> Result<Json<Vec<crate::deployer::Release>>, StatusCode> {
    let list = state.deployer.list_releases(id);
    Ok(Json(list))
}

#[derive(Serialize)]
struct CaddyResponse {
    config: String,
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
    Ok(Json(CaddyResponse { config: conf }))
}

async fn apply_caddy_handler(
    State(state): State<AppState>,
    AxPath(id): AxPath<i64>,
) -> Result<StatusCode, (StatusCode, String)> {
    let p = state
        .projects
        .get(id)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .ok_or((StatusCode::NOT_FOUND, "Project not found".into()))?;

    state
        .caddy
        .write_config(&p)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let _ = state.caddy.reload();

    Ok(StatusCode::OK)
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
    let logs = state
        .logs
        .list(Some(id), None, Some("app"), None, 100)
        .into_iter()
        .map(|l| l.message)
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
    let list = state.deployer.list_deployments(q.project, q.limit.unwrap_or(50));
    Ok(Json(list))
}

// ---------------------------------------------------------------------------
// Real-Time SSE Log Streaming
// ---------------------------------------------------------------------------
async fn logs_sse_handler(
    State(state): State<AppState>,
) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    let rx = state.logs.subscribe();
    let stream = BroadcastStream::new(rx).filter_map(|msg| {
        if let Ok(entry) = msg {
            if let Ok(json) = serde_json::to_string(&vec![entry]) {
                return Some(Ok(Event::default().data(json)));
            }
        }
        None
    });

    Sse::new(stream).keep_alive(KeepAlive::default())
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
        .header(header::CONTENT_DISPOSITION, "attachment; filename=\"nexus-deploy-logs.txt\"")
        .body(Body::from(out))
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response());

    Ok(res)
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

async fn overview_handler(
    State(state): State<AppState>,
) -> Result<Json<OverviewResponse>, StatusCode> {
    let projs = state.projects.list().map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let mut items = Vec::new();

    for p in projs {
        let is_running = p.app_status == "running";
        items.push(OverviewProjectItem {
            app: OverviewAppStatus {
                running: is_running,
                pid: p.app_pid,
                started_at: p.app_started_at,
            },
            project: p,
            active: None,
            behind: Some(0),
            ahead: Some(0),
            last_success: None,
        });
    }

    let recent = state.deployer.list_deployments(None, 10);
    let monitor = state.monitor.sample();

    Ok(Json(OverviewResponse {
        projects: items,
        recent,
        monitor,
    }))
}

async fn monitor_handler(
    State(state): State<AppState>,
) -> Result<Json<crate::monitor::SystemMetrics>, StatusCode> {
    let sample = state.monitor.sample();
    Ok(Json(sample))
}

#[derive(Serialize)]
struct AuditItem {
    id: i64,
    ts: i64,
    actor: String,
    action: String,
    target: Option<String>,
    detail: Option<String>,
    ip: Option<String>,
}

async fn audit_handler(
    State(state): State<AppState>,
) -> Result<Json<Vec<AuditItem>>, StatusCode> {
    let conn = state.db.lock().unwrap();
    let mut stmt = conn
        .prepare("SELECT id, ts, actor, action, target, detail, ip FROM audit ORDER BY id DESC LIMIT 100")
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    let rows = stmt.query_map([], |r| {
        Ok(AuditItem {
            id: r.get(0)?,
            ts: r.get(1)?,
            actor: r.get(2)?,
            action: r.get(3)?,
            target: r.get(4)?,
            detail: r.get(5)?,
            ip: r.get(6)?,
        })
    }).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    let mut list = Vec::new();
    for r in rows {
        if let Ok(item) = r {
            list.push(item);
        }
    }
    Ok(Json(list))
}

async fn get_settings_handler(
    State(state): State<AppState>,
) -> Result<Json<HashMap<String, String>>, StatusCode> {
    let conn = state.db.lock().unwrap();
    let mut stmt = conn.prepare("SELECT key, value FROM settings").map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    let mut map = HashMap::new();
    for r in rows.flatten() {
        map.insert(r.0, r.1);
    }
    Ok(Json(map))
}

async fn update_settings_handler(
    State(state): State<AppState>,
    Json(payload): Json<HashMap<String, String>>,
) -> Result<StatusCode, StatusCode> {
    let conn = state.db.lock().unwrap();
    for (k, v) in payload {
        conn.execute(
            "INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            rusqlite::params![k, v],
        ).ok();
    }
    Ok(StatusCode::OK)
}

async fn list_users_handler(
    State(state): State<AppState>,
) -> Result<Json<Vec<User>>, StatusCode> {
    let conn = state.db.lock().unwrap();
    let mut stmt = conn
        .prepare("SELECT id, username, role, created_at FROM users ORDER BY id ASC")
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    let rows = stmt.query_map([], |r| {
        Ok(User {
            id: r.get(0)?,
            username: r.get(1)?,
            role: r.get(2)?,
            created_at: r.get(3)?,
        })
    }).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    let mut list = Vec::new();
    for r in rows.flatten() {
        list.push(r);
    }
    Ok(Json(list))
}

#[derive(Deserialize)]
struct CreateUserPayload {
    username: String,
    password: String,
    role: Option<String>,
}

async fn create_user_handler(
    State(state): State<AppState>,
    Json(payload): Json<CreateUserPayload>,
) -> Result<Json<User>, (StatusCode, String)> {
    if payload.username.trim().is_empty() || payload.password.len() < 8 {
        return Err((StatusCode::BAD_REQUEST, "Username and password (min 8 chars) required".into()));
    }

    let hashed = hash_password(&payload.password)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;

    let role = payload.role.unwrap_or_else(|| "admin".to_string());
    let ts = now();

    let id = {
        let conn = state.db.lock().unwrap();
        conn.execute(
            "INSERT INTO users(username, password_hash, salt, role, created_at) VALUES(?, ?, '', ?, ?)",
            rusqlite::params![payload.username, hashed, role, ts],
        ).map_err(|e| (StatusCode::BAD_REQUEST, e.to_string()))?;
        conn.last_insert_rowid()
    };

    Ok(Json(User {
        id,
        username: payload.username,
        role,
        created_at: ts,
    }))
}
