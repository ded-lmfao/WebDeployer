use axum::{
    extract::{Path as AxPath, State},
    http::{HeaderMap, StatusCode},
    response::Response,
    Json,
};
use serde::{Deserialize, Serialize};

use super::common::*;
use crate::projects::{EnvVarInput, EnvVarView};

pub(crate) async fn list_projects_handler(
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

    cached_json_response(&state.cache, cache_key, &list, std::time::Duration::from_secs(4))
}

pub(crate) async fn get_project_handler(
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

pub(crate) async fn create_project_handler(
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

    // Always assign a guaranteed unique port across all workloads (websites, services, databases)
    let allocated_port = {
        let conn = state.db.lock().map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
        let default_start = if is_service { 8000 } else { 3000 };
        crate::db::allocate_global_unique_port(&conn, p.port, default_start, None, None)
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?
    };

    if !is_service && p.health_url.contains(":3000") && allocated_port != 3000 {
        p.health_url = p.health_url.replace(":3000", &format!(":{}", allocated_port));
    }
    p.port = Some(allocated_port);

    let id = state
        .projects
        .create(&p)
        .map_err(|e| (StatusCode::BAD_REQUEST, e.to_string()))?;

    let audit_action = if is_service { "service.create" } else { "website.create" };
    let audit_desc = if is_service {
        format!("Created backend service '{}' (Port {}, Repo: {})", p.name, allocated_port, p.repo_url)
    } else {
        format!("Created website '{}' (Port {}, Repo: {})", p.name, allocated_port, p.repo_url)
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

pub(crate) fn normalize_domain(d: &str) -> String {
    d.trim()
        .trim_start_matches("https://")
        .trim_start_matches("http://")
        .trim_end_matches('/')
        .trim()
        .to_lowercase()
}

pub(crate) fn sanitize_domains<I: IntoIterator<Item = String>>(domains: I) -> Vec<String> {
    domains
        .into_iter()
        .map(|d| normalize_domain(&d))
        .filter(|d| !d.is_empty())
        .collect()
}

pub(crate) async fn update_project_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxPath(id): AxPath<i64>,
    Json(mut p): Json<Project>,
) -> Result<Json<Project>, (StatusCode, String)> {
    let actor = verify_power(&state, &headers, "projects_manage", Some(id))?;
    p.domains = sanitize_domains(p.domains);

    let prev = state.projects.get(id).ok().flatten();

    // Ensure non-conflicting, valid port allocation across all workloads
    if let Some(port) = p.port {
        let allocated_port = {
            let conn = state.db.lock().map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
            crate::db::allocate_global_unique_port(&conn, Some(port), port, Some(id), None)
                .map_err(|e| (StatusCode::BAD_REQUEST, format!("Port allocation error: {}", e)))?
        };
        p.port = Some(allocated_port);
    } else if let Some(ref old_p) = prev {
        if let Some(old_port) = old_p.port {
            p.port = Some(old_port);
        } else {
            let default_start = if p.project_kind == "service" { 8000 } else { 3000 };
            let allocated_port = {
                let conn = state.db.lock().map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
                crate::db::allocate_global_unique_port(&conn, None, default_start, Some(id), None)
                    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?
            };
            p.port = Some(allocated_port);
        }
    }

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
            format!("Updated service settings (Port {:?}, Branch '{}', Start '{}')", p.port, p.branch, p.start_cmd)
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

    // Clean up old firewall rules if port, access mode, or allowed IPs changed
    if let Some(ref old_p) = prev {
        if let Some(old_port) = old_p.port {
            if Some(old_port) != updated.port
                || old_p.access_mode != updated.access_mode
                || old_p.allowed_ips != updated.allowed_ips
            {
                crate::databases::Databases::remove_firewall_rules(old_port, &old_p.allowed_ips).await;
            }
        }
    }

    if let Some(port) = updated.port {
        crate::databases::Databases::sync_firewall_rules(port, &updated.access_mode, &updated.allowed_ips).await;
    }
    state.cache.invalidate_all();

    Ok(Json(updated))
}

pub(crate) async fn delete_project_handler(
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
// Environment Variables
// ---------------------------------------------------------------------------
pub(crate) async fn get_env_handler(
    State(state): State<AppState>,
    AxPath(id): AxPath<i64>,
) -> Result<Json<Vec<EnvVarView>>, StatusCode> {
    let list = state.projects.get_env_vars(id).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(list))
}

#[derive(Deserialize)]
pub(crate) struct SetEnvPayload {
    key: String,
    value: String,
    is_secret: Option<bool>,
    previous_key: Option<String>,
}

pub(crate) async fn set_env_handler(
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
pub(crate) struct BulkEnvPayload {
    #[serde(default)]
    content: String,
    #[serde(default)]
    items: Option<Vec<EnvVarInput>>,
    is_secret: Option<bool>,
    replace_all: Option<bool>,
}

#[derive(Serialize)]
pub(crate) struct BulkEnvResponse {
    count: usize,
}

pub(crate) async fn bulk_set_env_handler(
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
pub(crate) struct RawEnvResponse {
    content: String,
}

pub(crate) async fn get_raw_env_handler(
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
pub(crate) struct RevealEnvPayload {
    key: String,
}

#[derive(Serialize)]
pub(crate) struct RevealEnvResponse {
    key: String,
    value: String,
}

pub(crate) async fn reveal_env_handler(
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

pub(crate) async fn delete_env_handler(
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


pub(crate) async fn start_project_with_audit(
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

pub(crate) async fn start_project_handler(
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

pub(crate) async fn stop_project_handler(
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

pub(crate) async fn restart_project_handler(
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
pub(crate) struct MaintenancePayload {
    enabled: Option<bool>,
}

pub(crate) async fn toggle_maintenance_handler(
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


// ---------------------------------------------------------------------------
// Git & GitHub Integration Handlers
// ---------------------------------------------------------------------------
#[derive(Serialize)]
pub(crate) struct CommitView {
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

pub(crate) async fn project_commits_handler(
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

    cached_json_response(&state.cache, cache_key, &views, std::time::Duration::from_secs(30))
        .map_err(|c| (c, "Serialization error".to_string()))
}

#[derive(Serialize)]
pub(crate) struct CheckGitResponse {
    #[serde(rename = "needsFetch")]
    needs_fetch: bool,
    #[serde(rename = "needsDeploy")]
    needs_deploy: bool,
    remote_sha: String,
    local_sha: String,
    deployed_sha: Option<String>,
}

pub(crate) async fn project_check_handler(
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
pub(crate) struct FetchGitResponse {
    status: String,
    sha: String,
    has_new_commits: bool,
    needs_deploy: bool,
}

pub(crate) async fn project_fetch_handler(
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
pub(crate) struct DetectProjectResponse {
    #[serde(rename = "type")]
    project_type: String,
    install: String,
    build: String,
    start: String,
}

pub(crate) async fn detect_project_handler(
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
pub(crate) struct DeployKeyResponse {
    #[serde(rename = "publicKey")]
    public_key: String,
}

pub(crate) async fn project_deploy_key_handler(
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
pub(crate) struct RotateSecretResponse {
    #[serde(rename = "webhookSecret")]
    webhook_secret: String,
}

pub(crate) async fn rotate_webhook_secret_handler(
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


// ---------------------------------------------------------------------------
// Backups & Proxy Status Handlers
// ---------------------------------------------------------------------------
#[derive(Serialize)]
pub(crate) struct BackupItem {
    id: i64,
    ts: i64,
    kind: String,
    size: u64,
    note: String,
    path: String,
    #[serde(rename = "releaseId")]
    release_id: Option<i64>,
}

pub(crate) fn copy_backup_files(src: &std::path::Path, dst: &std::path::Path) -> u64 {
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

pub(crate) async fn list_backups_handler(
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

    cached_json_response(&state.cache, cache_key, &backups, std::time::Duration::from_secs(15))
}

#[derive(Deserialize)]
pub(crate) struct CreateBackupPayload {
    note: Option<String>,
    kind: Option<String>,
}

pub(crate) async fn create_backup_handler(
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
pub(crate) struct RestoreBackupPayload {
    #[serde(rename = "backupId")]
    backup_id: i64,
}

pub(crate) async fn restore_backup_handler(
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

pub(crate) async fn delete_backup_handler(
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
