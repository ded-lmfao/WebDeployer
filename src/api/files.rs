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
    pub(crate) path: String,
}

#[derive(Deserialize)]
pub(crate) struct FileWritePayload {
    pub(crate) path: String,
    pub(crate) content: String,
}

#[derive(Deserialize)]
pub(crate) struct FileMkdirPayload {
    pub(crate) path: String,
}

#[derive(Deserialize)]
pub(crate) struct FileRenamePayload {
    pub(crate) old_path: String,
    pub(crate) new_path: String,
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
async fn ensure_existing_within_root(
    root: &std::path::Path,
    target: &std::path::Path,
) -> Result<std::path::PathBuf, (StatusCode, String)> {
    let canon_root = tokio::fs::canonicalize(root)
        .await
        .map_err(|_| (StatusCode::NOT_FOUND, "Service root not found".to_string()))?;
    let canon_target = tokio::fs::canonicalize(target)
        .await
        .map_err(|e| (StatusCode::NOT_FOUND, e.to_string()))?;
    if !canon_target.starts_with(&canon_root) {
        return Err((StatusCode::FORBIDDEN, "Path escapes service root".to_string()));
    }
    Ok(canon_root)
}

/// Verify the deepest existing ancestor (and the target if it already exists) stays within `root`.
async fn ensure_ancestor_within_root(
    root: &std::path::Path,
    target: &std::path::Path,
) -> Result<(), (StatusCode, String)> {
    let canon_root = tokio::fs::canonicalize(root)
        .await
        .map_err(|_| (StatusCode::NOT_FOUND, "Service root not found".to_string()))?;
    if tokio::fs::symlink_metadata(target).await.is_ok() {
        let canon_target = tokio::fs::canonicalize(target)
            .await
            .map_err(|_| (StatusCode::FORBIDDEN, "Invalid target path".to_string()))?;
        if !canon_target.starts_with(&canon_root) {
            return Err((StatusCode::FORBIDDEN, "Path escapes service root".to_string()));
        }
        return Ok(());
    }
    for anc in target.ancestors() {
        if tokio::fs::symlink_metadata(anc).await.is_ok() {
            let canon_anc = tokio::fs::canonicalize(anc)
                .await
                .map_err(|_| (StatusCode::FORBIDDEN, "Invalid ancestor path".to_string()))?;
            if !canon_anc.starts_with(&canon_root) {
                return Err((StatusCode::FORBIDDEN, "Path escapes service root".to_string()));
            }
            return Ok(());
        }
    }
    Err((StatusCode::FORBIDDEN, "Invalid target path".to_string()))
}

pub(crate) fn touches_dotenv_file(rel: &str) -> bool {
    rel.split(|c| c == '/' || c == '\\').any(|part| {
        let lower = part.trim().to_ascii_lowercase();
        lower == ".env" || lower.starts_with(".env.")
    })
}

pub(crate) fn ensure_file_env_access(actor: &User, paths: &[&str]) -> Result<(), (StatusCode, String)> {
    if actor.has_power("env") {
        return Ok(());
    }
    if paths.iter().any(|p| touches_dotenv_file(p)) {
        return Err((
            StatusCode::FORBIDDEN,
            "Permission denied: Missing 'env' privilege to access .env files.".to_string(),
        ));
    }
    Ok(())
}

/// List directory entries within `root`, enforcing canonical confinement and filtering escaping symlinks.
pub(crate) async fn list_entries_in_root(
    root: &std::path::Path,
    rel_path: &str,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let dir = safe_join(root, rel_path)?;
    let canon_root = ensure_existing_within_root(root, &dir).await?;
    let mut entries = Vec::new();
    let mut rd = tokio::fs::read_dir(&dir)
        .await
        .map_err(|e| (StatusCode::NOT_FOUND, e.to_string()))?;
    while let Ok(Some(e)) = rd.next_entry().await {
        if e.file_type().await.map(|ft| ft.is_symlink()).unwrap_or(false) {
            match tokio::fs::canonicalize(e.path()).await {
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
    Ok(Json(serde_json::json!({ "path": rel_path, "entries": entries })))
}

/// Read UTF-8 file contents (up to 2 MB) confined within `root`.
pub(crate) async fn read_file_in_root(
    actor: &User,
    root: &std::path::Path,
    rel_path: &str,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    ensure_file_env_access(actor, &[rel_path])?;
    let file = safe_join(root, rel_path)?;
    ensure_existing_within_root(root, &file).await?;
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
    Ok(Json(serde_json::json!({ "path": rel_path, "content": content })))
}

/// Write a file confined within `root` and append an audit record.
pub(crate) async fn write_file_in_root(
    state: &AppState,
    actor: &User,
    audit_project_id: Option<i64>,
    audit_target: &str,
    audit_action: &str,
    root: &std::path::Path,
    payload: FileWritePayload,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    ensure_file_env_access(actor, &[&payload.path])?;
    let file = safe_join(root, &payload.path)?;
    if file == root {
        return Err((StatusCode::BAD_REQUEST, "Invalid file path".into()));
    }
    ensure_ancestor_within_root(root, &file).await?;
    if let Some(parent) = file.parent() {
        let _ = tokio::fs::create_dir_all(parent).await;
    }
    tokio::fs::write(&file, payload.content.as_bytes())
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    log_audit_project(
        state,
        audit_project_id,
        &actor.username,
        audit_action,
        Some(audit_target),
        Some(&format!("Saved file '{}'", payload.path)),
    );
    Ok(Json(serde_json::json!({ "ok": true })))
}

/// Create a directory (and missing parents) confined within `root`.
pub(crate) async fn mkdir_in_root(
    actor: &User,
    root: &std::path::Path,
    payload: FileMkdirPayload,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    ensure_file_env_access(actor, &[&payload.path])?;
    let dir = safe_join(root, &payload.path)?;
    ensure_ancestor_within_root(root, &dir).await?;
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

/// Delete a file, symlink, or directory confined within `root` and append an audit record.
pub(crate) async fn delete_in_root(
    state: &AppState,
    actor: &User,
    audit_project_id: Option<i64>,
    audit_target: &str,
    audit_action: &str,
    root: &std::path::Path,
    rel_path: &str,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    ensure_file_env_access(actor, &[rel_path])?;
    let target = safe_join(root, rel_path)?;
    if target == root {
        return Err((StatusCode::BAD_REQUEST, "Cannot delete the workspace root".into()));
    }
    if let Some(parent) = target.parent() {
        ensure_existing_within_root(root, parent).await?;
    }
    let meta = tokio::fs::symlink_metadata(&target)
        .await
        .map_err(|e| (StatusCode::NOT_FOUND, e.to_string()))?;
    let res = if meta.file_type().is_symlink() {
        tokio::fs::remove_file(&target).await
    } else if meta.is_dir() {
        ensure_existing_within_root(root, &target).await?;
        tokio::fs::remove_dir_all(&target).await
    } else {
        ensure_existing_within_root(root, &target).await?;
        tokio::fs::remove_file(&target).await
    };
    res.map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    log_audit_project(
        state,
        audit_project_id,
        &actor.username,
        audit_action,
        Some(audit_target),
        Some(&format!("Deleted '{}'", rel_path)),
    );
    Ok(Json(serde_json::json!({ "ok": true })))
}

/// Upload multipart files confined within `root` and append an audit record.
pub(crate) async fn upload_in_root(
    state: &AppState,
    actor: &User,
    audit_project_id: Option<i64>,
    audit_target: &str,
    audit_action: &str,
    root: &std::path::Path,
    rel_path: &str,
    mut multipart: Multipart,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    ensure_file_env_access(actor, &[rel_path])?;
    let target_dir = safe_join(root, rel_path)?;
    ensure_ancestor_within_root(root, &target_dir).await?;
    tokio::fs::create_dir_all(&target_dir)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    ensure_existing_within_root(root, &target_dir).await?;

    let mut uploaded = Vec::new();
    while let Ok(Some(field)) = multipart.next_field().await {
        let file_name = match field.file_name() {
            Some(name) if !name.trim().is_empty() => name.to_string(),
            _ => continue,
        };
        let normalized = file_name.replace('\\', "/");
        ensure_file_env_access(actor, &[&normalized])?;
        let target_file = safe_join(&target_dir, &normalized)?;
        ensure_ancestor_within_root(root, &target_file).await?;

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
        state,
        audit_project_id,
        &actor.username,
        audit_action,
        Some(audit_target),
        Some(&format!("Uploaded {} file(s) into '{}'", uploaded.len(), rel_path)),
    );
    Ok(Json(serde_json::json!({ "ok": true, "uploaded": uploaded })))
}

/// Download a file confined within `root` as an attachment response.
pub(crate) async fn download_in_root(
    actor: &User,
    root: &std::path::Path,
    rel_path: &str,
) -> Result<Response, (StatusCode, String)> {
    ensure_file_env_access(actor, &[rel_path])?;
    let file = safe_join(root, rel_path)?;
    ensure_existing_within_root(root, &file).await?;
    let meta = tokio::fs::metadata(&file)
        .await
        .map_err(|e| (StatusCode::NOT_FOUND, e.to_string()))?;
    if !meta.is_file() {
        return Err((StatusCode::BAD_REQUEST, "Not a file".into()));
    }
    let file_name = std::path::Path::new(rel_path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("download");
    let bytes = tokio::fs::read(&file)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Response::builder()
        .header(header::CONTENT_TYPE, "application/octet-stream")
        .header(
            header::CONTENT_DISPOSITION,
            format!("attachment; filename=\"{}\"", file_name.replace('"', "\\\"").replace(['\r', '\n'], "")),
        )
        .body(Body::from(bytes))
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))
}

/// Rename/move a file or folder confined within `root` and append an audit record.
pub(crate) async fn rename_in_root(
    state: &AppState,
    actor: &User,
    audit_project_id: Option<i64>,
    audit_target: &str,
    audit_action: &str,
    root: &std::path::Path,
    payload: FileRenamePayload,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    ensure_file_env_access(actor, &[&payload.old_path, &payload.new_path])?;
    let old_target = safe_join(root, &payload.old_path)?;
    let new_target = safe_join(root, &payload.new_path)?;
    if old_target == root || new_target == root {
        return Err((StatusCode::BAD_REQUEST, "Invalid path".into()));
    }
    if let Some(parent) = old_target.parent() {
        ensure_existing_within_root(root, parent).await?;
    }
    ensure_ancestor_within_root(root, &new_target).await?;
    if let Some(parent) = new_target.parent() {
        let _ = tokio::fs::create_dir_all(parent).await;
    }
    tokio::fs::rename(&old_target, &new_target)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    log_audit_project(
        state,
        audit_project_id,
        &actor.username,
        audit_action,
        Some(audit_target),
        Some(&format!("Renamed '{}' to '{}'", payload.old_path, payload.new_path)),
    );
    Ok(Json(serde_json::json!({ "ok": true })))
}

pub(crate) async fn files_list_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxPath(id): AxPath<i64>,
    Query(q): Query<FilesQuery>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let (_actor, p) = get_authorized_project_any(&state, &headers, &["files", "files_write"], id)?;
    let root = service_root(&p)?;
    list_entries_in_root(&root, &q.path).await
}

pub(crate) async fn files_read_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxPath(id): AxPath<i64>,
    Query(q): Query<FilesQuery>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let (actor, p) = get_authorized_project_any(&state, &headers, &["files", "files_write"], id)?;
    let root = service_root(&p)?;
    read_file_in_root(&actor, &root, &q.path).await
}

pub(crate) async fn files_write_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxPath(id): AxPath<i64>,
    Json(payload): Json<FileWritePayload>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let (actor, p) = get_authorized_project(&state, &headers, "files_write", id)?;
    let root = service_root(&p)?;
    write_file_in_root(&state, &actor, Some(id), &p.name, "file.write", &root, payload).await
}

pub(crate) async fn files_mkdir_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxPath(id): AxPath<i64>,
    Json(payload): Json<FileMkdirPayload>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let (actor, p) = get_authorized_project(&state, &headers, "files_write", id)?;
    let root = service_root(&p)?;
    mkdir_in_root(&actor, &root, payload).await
}

pub(crate) async fn files_delete_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxPath(id): AxPath<i64>,
    Query(q): Query<FilesQuery>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let (actor, p) = get_authorized_project(&state, &headers, "files_write", id)?;
    let root = service_root(&p)?;
    delete_in_root(&state, &actor, Some(id), &p.name, "file.delete", &root, &q.path).await
}

pub(crate) async fn files_upload_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxPath(id): AxPath<i64>,
    Query(q): Query<FilesQuery>,
    multipart: Multipart,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let (actor, p) = get_authorized_project(&state, &headers, "files_write", id)?;
    let root = service_root(&p)?;
    upload_in_root(&state, &actor, Some(id), &p.name, "file.upload", &root, &q.path, multipart).await
}

pub(crate) async fn files_download_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxPath(id): AxPath<i64>,
    Query(q): Query<FilesQuery>,
) -> Result<Response, (StatusCode, String)> {
    let (actor, p) = get_authorized_project_any(&state, &headers, &["files", "files_write"], id)?;
    let root = service_root(&p)?;
    download_in_root(&actor, &root, &q.path).await
}

pub(crate) async fn files_rename_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxPath(id): AxPath<i64>,
    Json(payload): Json<FileRenamePayload>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let (actor, p) = get_authorized_project(&state, &headers, "files_write", id)?;
    let root = service_root(&p)?;
    rename_in_root(&state, &actor, Some(id), &p.name, "file.rename", &root, payload).await
}

#[cfg(test)]
mod tests {
    use super::{ensure_file_env_access, touches_dotenv_file};
    use crate::auth::User;

    fn make_user(perms: &str) -> User {
        User::from_db(2, "dev".into(), 0, perms.into(), "[\"*\"]".into(), 0, 1_700_000_000)
    }

    #[test]
    fn test_dotenv_path_detection_and_env_power_guard() {
        assert!(touches_dotenv_file(".env"));
        assert!(touches_dotenv_file("sub/.env.production"));
        assert!(touches_dotenv_file("sub\\.ENV"));
        assert!(!touches_dotenv_file("src/config.env.example"));

        let file_only = make_user(r#"["files","files_write"]"#);
        assert!(ensure_file_env_access(&file_only, &["src/main.rs"]).is_ok());
        assert!(ensure_file_env_access(&file_only, &[".env"]).is_err());
        assert!(ensure_file_env_access(&file_only, &["config/.env.local"]).is_err());

        let with_env = make_user(r#"["files_write","env"]"#);
        assert!(ensure_file_env_access(&with_env, &[".env"]).is_ok());
    }
}
