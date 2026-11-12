use axum::{
    extract::{Path as AxPath, State},
    http::StatusCode,
    Json,
};

use super::common::*;

pub mod overview;
pub mod settings;

pub use overview::*;
pub(crate) use settings::*;

// ---------------------------------------------------------------------------
// GitHub Webhook Handler
// ---------------------------------------------------------------------------
pub(crate) async fn github_webhook_handler(
    State(state): State<AppState>,
    AxPath(slug): AxPath<String>,
    Json(_payload): Json<serde_json::Value>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let projs = state
        .projects
        .list()
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let p = projs
        .into_iter()
        .find(|x| x.slug == slug)
        .ok_or((StatusCode::NOT_FOUND, "Project not found for this slug".to_string()))?;

    if !p.auto_deploy {
        state.logs.add(
            Some(p.id),
            None,
            "github",
            "info",
            &format!("GitHub webhook received for {} (ignored — manual deploy mode active)", p.name),
        );
        return Ok(Json(serde_json::json!({
            "ok": true,
            "ignored": true,
            "message": "Auto-deploy is disabled for this website; use the Deploy button in the panel."
        })));
    }

    state.logs.add(
        Some(p.id),
        None,
        "github",
        "info",
        &format!("GitHub webhook received for {}", p.name),
    );

    let dep_id = state
        .deployer
        .create_deployment(&p, "deploy", "github-webhook", "webhook");

    trigger_background_deploy(state.deployer.clone(), p.id, dep_id);

    Ok(Json(serde_json::json!({
        "ok": true,
        "deploymentId": dep_id,
        "message": "Deployment triggered from GitHub webhook"
    })))
}
