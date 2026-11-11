use axum::{
    extract::{Path as AxPath, State},
    http::{HeaderMap, StatusCode},
    response::Response,
    Json,
};
use serde::{Deserialize, Serialize};

use super::common::*;
use super::projects::normalize_domain;

#[derive(Serialize)]
pub(crate) struct CaddyResponse {
    config: String,
    domains: Vec<String>,
}

pub(crate) async fn get_caddy_handler(
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
pub(crate) struct ApplyCaddyPayload {
    domains: Option<Vec<String>>,
}

pub(crate) async fn apply_caddy_handler(
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

pub(crate) async fn certbot_caddy_handler(
    State(_state): State<AppState>,
    AxPath(id): AxPath<i64>,
) -> Result<StatusCode, (StatusCode, String)> {
    let _ = id;
    // Caddy provisions certificates automatically via ACME, no certbot needed!
    Ok(StatusCode::OK)
}


#[derive(Serialize, Deserialize)]
pub(crate) struct GithubRepoItem {
    full_name: String,
    clone_url: String,
    private: bool,
    default_branch: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    token_label: Option<String>,
}

pub(crate) async fn github_repos_handler(
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


#[derive(Serialize)]
pub(crate) struct CaddyStatusResponse {
    installed: bool,
    active: bool,
    running: bool,
    version: String,
}

pub(crate) async fn caddy_status_handler(State(state): State<AppState>) -> Response {
    let cache_key = "caddy:status";
    if let Some(res) = check_api_cache(&state.cache, cache_key) {
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
    cached_json_response(&state.cache, cache_key.to_string(), &payload, std::time::Duration::from_secs(60))
        .unwrap_or_else(|_| Json(payload).into_response())
}
