use axum::{
    extract::{Path as AxPath, State},
    http::{HeaderMap, StatusCode},
    response::Response,
    Json,
};
use serde::Deserialize;

use super::common::*;

pub mod backups;
pub mod env;
pub mod git_ops;

pub(crate) use backups::*;
pub(crate) use env::*;
pub(crate) use git_ops::*;

#[derive(serde::Serialize)]
pub(crate) struct ProjectResponse {
    #[serde(flatten)]
    pub(crate) project: Project,
    #[serde(rename = "diskFormatted")]
    pub(crate) disk_formatted: String,
}

fn enrich_project_status(p: &mut Project) {
    let pid_alive = p.app_pid.map(crate::runtime::process::is_pid_alive).unwrap_or(false);
    if pid_alive {
        p.app_status = "running".to_string();
    } else if p.app_status == "running" {
        if let Some(port) = p.port {
            if let Some(&port_pid) = crate::runtime::Runtime::find_pids_on_port_cached(port).first() {
                if crate::runtime::process::is_pid_alive(port_pid) {
                    p.app_pid = Some(port_pid);
                }
            }
        }
    }
}

pub(crate) fn to_project_response(mut p: Project, cwd: &std::path::Path) -> ProjectResponse {
    enrich_project_status(&mut p);
    let (_, disk_formatted) = crate::api::system::compute_project_disk_formatted(&p, cwd);
    ProjectResponse {
        project: p,
        disk_formatted,
    }
}

static CACHED_CWD: std::sync::OnceLock<std::path::PathBuf> = std::sync::OnceLock::new();

fn cached_cwd() -> &'static std::path::Path {
    CACHED_CWD
        .get_or_init(|| std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from(".")))
        .as_path()
}

pub(crate) async fn list_projects_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Response, StatusCode> {
    let user = require_current_user(&state, &headers).map_err(|(c, _)| c)?;
    let cache_key = format!("projects:u{}", user.id);

    singleflight_json_bytes(&state.cache, cache_key, std::time::Duration::from_secs(4), &headers, || async {
        let state = state.clone();
        let user = user.clone();
        tokio::task::spawn_blocking(move || {
            let cwd = cached_cwd();
            let list: Vec<ProjectResponse> = state
                .projects
                .list()
                .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
                .into_iter()
                .filter(|p| user.can_access_project(p.id))
                .map(|p| to_project_response(p, cwd))
                .collect();
            let json = serde_json::to_string(&list).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
            Ok(axum::body::Bytes::from(json))
        })
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
    })
    .await
}

pub(crate) async fn get_project_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxPath(id): AxPath<i64>,
) -> Result<Json<ProjectResponse>, StatusCode> {
    let user = require_current_user(&state, &headers).map_err(|(c, _)| c)?;
    if !user.can_access_project(id) {
        return Err(StatusCode::FORBIDDEN);
    }
    let p = state
        .projects
        .get(id)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .ok_or(StatusCode::NOT_FOUND)?;

    Ok(Json(to_project_response(p, cached_cwd())))
}

fn manage_power_for_kind(kind: &str) -> &'static str {
    if kind == "service" {
        "services_manage"
    } else {
        "projects_manage"
    }
}

pub(crate) async fn create_project_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(mut p): Json<Project>,
) -> Result<Json<Project>, (StatusCode, String)> {
    let actor = verify_power(&state, &headers, manage_power_for_kind(&p.project_kind), None)?;
    let is_service = p.project_kind == "service";
    if p.name.trim().is_empty() || p.slug.trim().is_empty() {
        return Err((StatusCode::BAD_REQUEST, "Name and slug are required".into()));
    }
    if p.repo_url.trim().is_empty() {
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
    let cleaned = d
        .trim()
        .trim_start_matches("https://")
        .trim_start_matches("http://")
        .trim_end_matches('/')
        .trim()
        .to_lowercase();
    if cleaned.is_empty()
        || cleaned.len() > 253
        || cleaned.chars().any(|c| {
            c.is_whitespace()
                || c.is_control()
                || matches!(c, '{' | '}' | ';' | '#' | '"' | '\'' | '`' | '\\')
        })
    {
        return String::new();
    }
    cleaned
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
    let prev = state.projects.get(id).ok().flatten();
    let existing_kind = prev
        .as_ref()
        .map(|old| old.project_kind.as_str())
        .unwrap_or(p.project_kind.as_str());
    let actor = verify_power(&state, &headers, manage_power_for_kind(existing_kind), Some(id))?;
    if p.project_kind != existing_kind {
        let _ = verify_power(&state, &headers, manage_power_for_kind(&p.project_kind), Some(id))?;
    }
    p.domains = sanitize_domains(p.domains);

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
    let deleted_proj = state.projects.get(id).ok().flatten();
    let kind = deleted_proj
        .as_ref()
        .map(|p| p.project_kind.as_str())
        .unwrap_or("website");
    let actor = verify_power(&state, &headers, manage_power_for_kind(kind), Some(id))?;
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

