use axum::{
    extract::{Path as AxPath, State},
    http::{HeaderMap, StatusCode},
    response::Response,
    Json,
};
use serde::{Deserialize, Serialize};

use crate::api::common::*;

#[derive(Serialize)]
pub(crate) struct BackupItem {
    pub id: i64,
    pub ts: i64,
    pub kind: String,
    pub size: u64,
    pub note: String,
    pub path: String,
    #[serde(rename = "releaseId")]
    pub release_id: Option<i64>,
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
            // Never traverse or copy symlinks to prevent directory escape or cycles
            let Ok(meta) = std::fs::symlink_metadata(&src_path) else {
                continue;
            };
            if meta.file_type().is_symlink() {
                continue;
            }
            let dst_path = dst.join(&name);
            if meta.is_dir() {
                total_bytes += copy_backup_files(&src_path, &dst_path);
            } else if meta.is_file() {
                if let Ok(bytes) = std::fs::copy(&src_path, &dst_path) {
                    total_bytes += bytes;
                }
            }
        }
    }
    total_bytes
}

pub(crate) async fn list_backups_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxPath(id): AxPath<i64>,
) -> Result<Response, (StatusCode, String)> {
    let _actor = verify_power(&state, &headers, "backups", Some(id))?;
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
        .map_err(|code| (code, "Serialization error".to_string()))
}

#[derive(Deserialize)]
pub(crate) struct CreateBackupPayload {
    pub note: Option<String>,
    pub kind: Option<String>,
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
            let dst_dir = backup_dir.join("files");
            total_size += tokio::task::spawn_blocking(move || copy_backup_files(&src_dir, &dst_dir))
                .await
                .unwrap_or(0);
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
            "INSERT INTO backups(project_id, release_id, kind, path, size_bytes, note, created_at)
             VALUES(?, ?, ?, ?, ?, ?, ?)",
            rusqlite::params![
                id,
                rel_id,
                kind,
                &backup_path_str,
                total_size as i64,
                note,
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
    pub backup_id: i64,
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

    let p_opt = state.projects.get(id).ok().flatten();
    if let Some(p_str) = b_path {
        let path = std::path::Path::new(&p_str);
        if let Some(ref p) = p_opt {
            let backups_root = std::path::Path::new(&p.deploy_dir).join("backups");
            let releases_root = std::path::Path::new(&p.deploy_dir).join("releases");
            if let Ok(canon_path) = tokio::fs::canonicalize(path).await {
                let inside_backups = tokio::fs::canonicalize(&backups_root)
                    .await
                    .map(|r| canon_path.starts_with(&r) && canon_path != r)
                    .unwrap_or(false);
                let inside_releases = tokio::fs::canonicalize(&releases_root)
                    .await
                    .map(|r| canon_path.starts_with(&r) && canon_path != r)
                    .unwrap_or(false);
                if inside_backups || inside_releases {
                    let _ = tokio::fs::remove_dir_all(&canon_path).await;
                }
            }
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

