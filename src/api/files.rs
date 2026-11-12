use axum::{
    body::Body,
    extract::{Multipart, Path as AxPath, Query, State},
    http::{HeaderMap, StatusCode},
    response::Response,
    Json,
};
use serde::Deserialize;

use super::common::*;

// ---------------------------------------------------------------------------
// Backend Service File Browser (scoped to <deploy_dir>/app)
// ---------------------------------------------------------------------------
#[derive(Deserialize)]
pub(crate) struct FilesQuery {
    #[serde(default)]
    path: String,
}

#[derive(Deserialize)]
pub(crate) struct FileWritePayload {
    path: String,
    content: String,
}

#[derive(Deserialize)]
pub(crate) struct FileMkdirPayload {
    path: String,
}

#[derive(Deserialize)]
pub(crate) struct FileRenamePayload {
    old_path: String,
    new_path: String,
}

pub(crate) fn service_root(p: &crate::projects::Project) -> Result<std::path::PathBuf, (StatusCode, String)> {
    let cwd = std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("."));
    let raw = std::path::Path::new(&p.deploy_dir);
    let base = if raw.is_absolute() {
        raw.to_path_buf()
    } else {
        cwd.join(p.deploy_dir.trim_start_matches("./").trim_start_matches(".\\"))
    };
    if p.project_kind == "service" {
        let root = base.join("app");
        let _ = std::fs::create_dir_all(&root);
        Ok(root)
    } else {
        let app_dir = base.join("app");
        let current_dir = base.join("current");
        let repo_dir = base.join("repo");
        if current_dir.exists() {
            Ok(current_dir)
        } else if app_dir.exists() {
            Ok(app_dir)
        } else if repo_dir.exists() {
            Ok(repo_dir)
        } else {
            let _ = std::fs::create_dir_all(&app_dir);
            Ok(app_dir)
        }
    }
}

/// Join a user supplied relative path onto the root, rejecting anything that could escape it.
pub(crate) fn safe_join(root: &std::path::Path, rel: &str) -> Result<std::path::PathBuf, (StatusCode, String)> {
    let mut out = root.to_path_buf();
    for part in rel.split(|c| c == '/' || c == '\\') {
        match part {
            "" | "." => {}
            ".." => return Err((StatusCode::BAD_REQUEST, "Invalid path".into())),
            s if s.contains(':') || s.contains('\0') => {
                return Err((StatusCode::BAD_REQUEST, "Invalid path".into()));
            }
            s => out.push(s),
        }
    }
    Ok(out)
}

/// Verify an existing target path resolves canonically within `root` (blocks symlink escape).
fn ensure_existing_within_root(
    root: &std::path::Path,
    target: &std::path::Path,
) -> Result<std::path::PathBuf, (StatusCode, String)> {
    let canon_root = std::fs::canonicalize(root)
        .map_err(|_| (StatusCode::NOT_FOUND, "Service root not found".to_string()))?;
    let canon_target = std::fs::canonicalize(target)
        .map_err(|e| (StatusCode::NOT_FOUND, e.to_string()))?;
    if !canon_target.starts_with(&canon_root) {
        return Err((StatusCode::FORBIDDEN, "Path escapes service root".to_string()));
    }
    Ok(canon_root)
}

/// Verify the deepest existing ancestor (and the target if it already exists) stays within `root`.
fn ensure_ancestor_within_root(
    root: &std::path::Path,
    target: &std::path::Path,
) -> Result<(), (StatusCode, String)> {
    let canon_root = std::fs::canonicalize(root)
        .map_err(|_| (StatusCode::NOT_FOUND, "Service root not found".to_string()))?;
    if std::fs::symlink_metadata(target).is_ok() {
        let canon_target = std::fs::canonicalize(target)
            .map_err(|_| (StatusCode::FORBIDDEN, "Invalid target path".to_string()))?;
        if !canon_target.starts_with(&canon_root) {
            return Err((StatusCode::FORBIDDEN, "Path escapes service root".to_string()));
        }
        return Ok(());
    }
    for anc in target.ancestors() {
        if std::fs::symlink_metadata(anc).is_ok() {
            let canon_anc = std::fs::canonicalize(anc)
                .map_err(|_| (StatusCode::FORBIDDEN, "Invalid ancestor path".to_string()))?;
            if !canon_anc.starts_with(&canon_root) {
                return Err((StatusCode::FORBIDDEN, "Path escapes service root".to_string()));
            }
            return Ok(());
        }
    }
    Err((StatusCode::FORBIDDEN, "Invalid target path".to_string()))
}

pub(crate) async fn files_list_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxPath(id): AxPath<i64>,
    Query(q): Query<FilesQuery>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let (_actor, p) = get_authorized_project(&state, &headers, "env", id)?;
    let root = service_root(&p)?;
    let dir = safe_join(&root, &q.path)?;
    let canon_root = ensure_existing_within_root(&root, &dir)?;
    let mut entries = Vec::new();
    let mut rd = tokio::fs::read_dir(&dir)
        .await
        .map_err(|e| (StatusCode::NOT_FOUND, e.to_string()))?;
    while let Ok(Some(e)) = rd.next_entry().await {
        if e.file_type().await.map(|ft| ft.is_symlink()).unwrap_or(false) {
            match std::fs::canonicalize(e.path()) {
                Ok(c) if c.starts_with(&canon_root) => {}
                _ => continue,
            }
        }
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

pub(crate) async fn files_read_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxPath(id): AxPath<i64>,
    Query(q): Query<FilesQuery>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let (_actor, p) = get_authorized_project(&state, &headers, "env", id)?;
    let root = service_root(&p)?;
    let file = safe_join(&root, &q.path)?;
    ensure_existing_within_root(&root, &file)?;
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

pub(crate) async fn files_write_handler(
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
    ensure_ancestor_within_root(&root, &file)?;
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

pub(crate) async fn files_mkdir_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxPath(id): AxPath<i64>,
    Json(payload): Json<FileMkdirPayload>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let (_actor, p) = get_authorized_project(&state, &headers, "env", id)?;
    let root = service_root(&p)?;
    let dir = safe_join(&root, &payload.path)?;
    ensure_ancestor_within_root(&root, &dir)?;
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

pub(crate) async fn files_delete_handler(
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
    if let Some(parent) = target.parent() {
        ensure_existing_within_root(&root, parent)?;
    }
    let meta = tokio::fs::symlink_metadata(&target)
        .await
        .map_err(|e| (StatusCode::NOT_FOUND, e.to_string()))?;
    let res = if meta.file_type().is_symlink() {
        tokio::fs::remove_file(&target).await
    } else if meta.is_dir() {
        ensure_existing_within_root(&root, &target)?;
        tokio::fs::remove_dir_all(&target).await
    } else {
        ensure_existing_within_root(&root, &target)?;
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

pub(crate) async fn files_upload_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxPath(id): AxPath<i64>,
    Query(q): Query<FilesQuery>,
    mut multipart: Multipart,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let (actor, p) = get_authorized_project(&state, &headers, "env", id)?;
    let root = service_root(&p)?;
    let target_dir = safe_join(&root, &q.path)?;
    ensure_ancestor_within_root(&root, &target_dir)?;
    tokio::fs::create_dir_all(&target_dir)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    ensure_existing_within_root(&root, &target_dir)?;

    let mut uploaded = Vec::new();
    while let Ok(Some(field)) = multipart.next_field().await {
        let file_name = match field.file_name() {
            Some(name) if !name.trim().is_empty() => name.to_string(),
            _ => continue,
        };
        // Normalize any Windows/Unix slashes for directory uploads
        let normalized = file_name.replace('\\', "/");
        let target_file = safe_join(&target_dir, &normalized)?;
        ensure_ancestor_within_root(&root, &target_file)?;

        if let Some(parent) = target_file.parent() {
            let _ = tokio::fs::create_dir_all(parent).await;
        }

        let bytes = field
            .bytes()
            .await
            .map_err(|e| (StatusCode::BAD_REQUEST, e.to_string()))?;
        tokio::fs::write(&target_file, &bytes)
            .await
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
        uploaded.push(normalized);
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

pub(crate) async fn files_download_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxPath(id): AxPath<i64>,
    Query(q): Query<FilesQuery>,
) -> Result<Response, (StatusCode, String)> {
    let (_actor, p) = get_authorized_project(&state, &headers, "env", id)?;
    let root = service_root(&p)?;
    let file = safe_join(&root, &q.path)?;
    ensure_existing_within_root(&root, &file)?;
    let meta = tokio::fs::metadata(&file)
        .await
        .map_err(|e| (StatusCode::NOT_FOUND, e.to_string()))?;
    if !meta.is_file() {
        return Err((StatusCode::BAD_REQUEST, "Not a file".into()));
    }
    let file_name = std::path::Path::new(&q.path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("download");
    let bytes = tokio::fs::read(&file)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    let res = Response::builder()
        .header(header::CONTENT_TYPE, "application/octet-stream")
        .header(
            header::CONTENT_DISPOSITION,
            format!("attachment; filename=\"{}\"", file_name.replace('"', "\\\"").replace(['\r', '\n'], "")),
        )
        .body(Body::from(bytes))
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(res)
}

pub(crate) async fn files_rename_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxPath(id): AxPath<i64>,
    Json(payload): Json<FileRenamePayload>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let (actor, p) = get_authorized_project(&state, &headers, "env", id)?;
    let root = service_root(&p)?;
    let old_target = safe_join(&root, &payload.old_path)?;
    let new_target = safe_join(&root, &payload.new_path)?;
    if old_target == root || new_target == root {
        return Err((StatusCode::BAD_REQUEST, "Invalid path".into()));
    }
    if let Some(parent) = old_target.parent() {
        ensure_existing_within_root(&root, parent)?;
    }
    ensure_ancestor_within_root(&root, &new_target)?;
    if let Some(parent) = new_target.parent() {
        let _ = tokio::fs::create_dir_all(parent).await;
    }
    tokio::fs::rename(&old_target, &new_target)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    log_audit_project(
        &state,
        Some(id),
        &actor.username,
        "file.rename",
        Some(&p.name),
        Some(&format!("Renamed '{}' to '{}'", payload.old_path, payload.new_path)),
    );
    Ok(Json(serde_json::json!({ "ok": true })))
}
