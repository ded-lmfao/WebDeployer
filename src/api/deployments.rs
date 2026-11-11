use axum::{
    extract::{Path as AxPath, Query, State},
    http::{HeaderMap, StatusCode},
    Json,
};
use serde::{Deserialize, Serialize};

use super::common::*;
use super::projects::copy_backup_files;

#[derive(Deserialize, Default)]
pub(crate) struct DeployPayload {
    sha: Option<String>,
}

pub(crate) async fn deploy_project_handler(
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
pub(crate) struct RollbackPayload {
    #[serde(rename = "releaseId")]
    #[allow(dead_code)]
    release_id: i64,
}

pub(crate) async fn rollback_project_handler(
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


pub(crate) async fn list_releases_handler(
    State(state): State<AppState>,
    AxPath(id): AxPath<i64>,
) -> Result<Json<Vec<crate::deployer::Release>>, StatusCode> {
    let list = state.deployer.list_releases(id);
    Ok(Json(list))
}

#[derive(Deserialize)]
pub(crate) struct CreateReleasePayload {
    source: Option<String>,
    note: Option<String>,
}

pub(crate) async fn create_release_handler(
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


#[derive(Deserialize)]
pub(crate) struct DeploymentQuery {
    project: Option<i64>,
    limit: Option<usize>,
}

pub(crate) async fn list_deployments_handler(
    State(state): State<AppState>,
    Query(q): Query<DeploymentQuery>,
) -> Result<Json<Vec<crate::deployer::Deployment>>, StatusCode> {
    let list = state.deployer.list_deployments(q.project, q.limit.unwrap_or(200));
    Ok(Json(list))
}

#[derive(Serialize)]
pub(crate) struct DeploymentDetailResponse {
    deployment: crate::deployer::Deployment,
    logs: Vec<crate::logs::LogEntry>,
}

pub(crate) async fn get_deployment_handler(
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

pub(crate) async fn get_deployment_logs_handler(
    State(state): State<AppState>,
    AxPath(id): AxPath<i64>,
) -> Result<Json<Vec<crate::logs::LogEntry>>, StatusCode> {
    let logs = state.logs.list(None, Some(id), None, None, 1000);
    Ok(Json(logs))
}


pub(crate) async fn delete_release_handler(
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
