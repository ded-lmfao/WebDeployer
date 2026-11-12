use axum::{
    extract::{Path as AxPath, State},
    http::{HeaderMap, StatusCode},
    response::Response,
    Json,
};
use serde::Serialize;

use crate::api::common::*;

#[derive(Serialize)]
pub(crate) struct CommitView {
    pub sha: String,
    #[serde(rename = "shortSha")]
    pub short_sha: String,
    pub author: String,
    pub date: i64,
    pub message: String,
    pub live: bool,
    #[serde(rename = "deployedBefore")]
    pub deployed_before: bool,
}

pub(crate) async fn project_commits_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxPath(id): AxPath<i64>,
) -> Result<Response, (StatusCode, String)> {
    let _actor = verify_project_access(&state, &headers, id)?;
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
    pub needs_fetch: bool,
    #[serde(rename = "needsDeploy")]
    pub needs_deploy: bool,
    pub remote_sha: String,
    pub local_sha: String,
    pub deployed_sha: Option<String>,
}

pub(crate) async fn project_check_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxPath(id): AxPath<i64>,
) -> Result<Json<CheckGitResponse>, (StatusCode, String)> {
    let _actor = verify_project_access(&state, &headers, id)?;
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
    pub status: String,
    pub sha: String,
    pub has_new_commits: bool,
    pub needs_deploy: bool,
}

pub(crate) async fn project_fetch_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxPath(id): AxPath<i64>,
) -> Result<Json<FetchGitResponse>, (StatusCode, String)> {
    let actor = verify_power(&state, &headers, "deploy", Some(id))?.username;
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
    pub project_type: String,
    pub install: String,
    pub build: String,
    pub start: String,
}

pub(crate) async fn detect_project_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxPath(id): AxPath<i64>,
) -> Result<Json<DetectProjectResponse>, (StatusCode, String)> {
    let _actor = verify_any_power(
        &state,
        &headers,
        &["deploy", "projects_manage", "services_manage"],
        Some(id),
    )?;
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
    pub public_key: String,
}

pub(crate) async fn project_deploy_key_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxPath(id): AxPath<i64>,
) -> Result<Json<DeployKeyResponse>, (StatusCode, String)> {
    let _actor = verify_power(&state, &headers, "deploy", Some(id))?;
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
    pub webhook_secret: String,
}

pub(crate) async fn rotate_webhook_secret_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxPath(id): AxPath<i64>,
) -> Result<Json<RotateSecretResponse>, (StatusCode, String)> {
    let actor = verify_power(&state, &headers, "deploy", Some(id))?;
    use rand::RngCore;
    let mut bytes = [0u8; 24];
    rand::thread_rng().fill_bytes(&mut bytes);
    let new_secret = hex::encode(bytes);

    let conn = state.db.lock().unwrap();
    conn.execute(
        "UPDATE projects SET webhook_secret = ? WHERE id = ?",
        rusqlite::params![new_secret, id],
    )
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    drop(conn);

    log_audit_project(
        &state,
        Some(id),
        &actor.username,
        "git.webhook_rotate",
        None,
        Some("Rotated GitHub webhook HMAC secret"),
    );

    Ok(Json(RotateSecretResponse {
        webhook_secret: new_secret,
    }))
}

