use axum::{
    extract::{Path as AxPath, State},
    http::{HeaderMap, StatusCode},
    Json,
};
use serde::{Deserialize, Serialize};

use crate::api::common::*;
use crate::projects::{EnvVarInput, EnvVarView};

pub(crate) async fn get_env_handler(
    State(state): State<AppState>,
    AxPath(id): AxPath<i64>,
) -> Result<Json<Vec<EnvVarView>>, StatusCode> {
    let list = state.projects.get_env_vars(id).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(list))
}

#[derive(Deserialize)]
pub(crate) struct SetEnvPayload {
    pub key: String,
    pub value: String,
    pub is_secret: Option<bool>,
    pub previous_key: Option<String>,
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
    pub content: String,
    #[serde(default)]
    pub items: Option<Vec<EnvVarInput>>,
    pub is_secret: Option<bool>,
    pub replace_all: Option<bool>,
}

#[derive(Serialize)]
pub(crate) struct BulkEnvResponse {
    pub count: usize,
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
    pub content: String,
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
    pub key: String,
}

#[derive(Serialize)]
pub(crate) struct RevealEnvResponse {
    pub key: String,
    pub value: String,
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

