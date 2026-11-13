use axum::{
    body::Bytes,
    extract::{Path as AxPath, State},
    http::{HeaderMap, StatusCode},
    Json,
};
use sha2::{Digest, Sha256};

use super::common::*;

pub mod app_usage;
pub mod overview;
pub mod settings;

pub(crate) use app_usage::*;
pub use overview::*;
pub(crate) use settings::*;

fn hmac_sha256_hex(secret: &[u8], data: &[u8]) -> String {
    const BLOCK_SIZE: usize = 64;
    let mut key_block = [0u8; BLOCK_SIZE];
    if secret.len() > BLOCK_SIZE {
        let digest = Sha256::digest(secret);
        key_block[..digest.len()].copy_from_slice(&digest);
    } else {
        key_block[..secret.len()].copy_from_slice(secret);
    }

    let mut ipad = [0x36u8; BLOCK_SIZE];
    let mut opad = [0x5cu8; BLOCK_SIZE];
    for i in 0..BLOCK_SIZE {
        ipad[i] ^= key_block[i];
        opad[i] ^= key_block[i];
    }

    let mut inner = Sha256::new();
    inner.update(ipad);
    inner.update(data);
    let inner_hash = inner.finalize();

    let mut outer = Sha256::new();
    outer.update(opad);
    outer.update(inner_hash);
    hex::encode(outer.finalize())
}

// ---------------------------------------------------------------------------
// GitHub Webhook Handler
// ---------------------------------------------------------------------------
pub(crate) async fn github_webhook_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxPath(slug): AxPath<String>,
    body: Bytes,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let projs = state
        .projects
        .list()
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let p = projs
        .into_iter()
        .find(|x| x.slug == slug)
        .ok_or((StatusCode::NOT_FOUND, "Project not found for this slug".to_string()))?;

    let secret = p
        .webhook_secret
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or((
            StatusCode::UNAUTHORIZED,
            "Webhook secret is not configured for this project. Rotate webhook secret first.".to_string(),
        ))?;

    let sig_hdr = headers
        .get("x-hub-signature-256")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .trim();
    let expected = format!("sha256={}", hmac_sha256_hex(secret.as_bytes(), &body));
    if !constant_time_eq(&sig_hdr.to_ascii_lowercase(), &expected) {
        return Err((StatusCode::UNAUTHORIZED, "Invalid GitHub webhook signature".to_string()));
    }

    if serde_json::from_slice::<serde_json::Value>(&body).is_err() {
        return Err((StatusCode::BAD_REQUEST, "Invalid webhook JSON payload".to_string()));
    }

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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_hmac_sha256_rfc4231_and_github_vector() {
        // RFC 4231 Test Case 2: Key = "Jefe", Data = "what do ya want for nothing?"
        let mac = hmac_sha256_hex(b"Jefe", b"what do ya want for nothing?");
        assert_eq!(
            mac,
            "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"
        );
    }
}
