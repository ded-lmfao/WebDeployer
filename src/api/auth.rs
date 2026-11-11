use axum::{
    extract::{Path as AxPath, State},
    http::{HeaderMap, HeaderValue, StatusCode},
    response::Response,
    Json,
};
use serde::Deserialize;

use super::common::*;
use crate::auth::{
    generate_backup_codes, generate_totp_secret, hash_password,
    verify_password, verify_totp_code,
};

#[derive(Deserialize)]
pub(crate) struct LoginPayload {
    username: String,
    password: String,
}



pub(crate) async fn login_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<LoginPayload>,
) -> Result<Response, (StatusCode, String)> {
    // Always revoke any pre-existing session cookie when starting a new login attempt
    if let Some(old_sid) = extract_session_id(&headers) {
        state.auth.delete_session(&old_sid);
    }

    // Sync Main Admin login ID & password from .env (supports live editing .env without server restart)
    state.auth.ensure_admin();

    let uname_key = format!("login:{}", payload.username.trim().to_lowercase());
    if let Some(rem) = state.auth.check_lockout(&uname_key) {
        return Err((
            StatusCode::TOO_MANY_REQUESTS,
            format!("Too many failed sign-in attempts. Account temporarily locked for {} seconds.", rem),
        ));
    }

    let Some((user, hash)) = state.auth.get_user_by_username(payload.username.trim()) else {
        state.auth.record_failure(&uname_key);
        return Err((StatusCode::UNAUTHORIZED, "Invalid username or password".to_string()));
    };

    let user_2fa_key = format!("2fa_user:{}", user.id);
    if let Some(rem) = state.auth.check_lockout(&user_2fa_key) {
        return Err((
            StatusCode::TOO_MANY_REQUESTS,
            format!("Account temporarily locked due to failed 2FA attempts ({} seconds remaining).", rem),
        ));
    }

    if user.disabled {
        return Err((StatusCode::FORBIDDEN, "Account is disabled by administrator".to_string()));
    }

    if !verify_password(&payload.password, &hash) {
        if let Some(lock_s) = state.auth.record_failure(&uname_key) {
            log_audit(&state, &user.username, "auth.lockout", Some(&user.username), Some("Account locked after repeated failed password attempts"));
            return Err((
                StatusCode::TOO_MANY_REQUESTS,
                format!("Too many failed sign-in attempts. Account locked for {} seconds.", lock_s),
            ));
        }
        return Err((StatusCode::UNAUTHORIZED, "Invalid username or password".to_string()));
    }

    state.auth.clear_failures(&uname_key);

    // If 2FA is enabled on this account, require 2FA challenge verification before creating a session
    if user.totp_enabled {
        let mfa_token = state.auth.create_mfa_challenge(user.id);
        let mut res = Json(serde_json::json!({
            "requires2fa": true,
            "mfaToken": mfa_token,
            "username": user.username,
        }))
        .into_response();
        // Ensure no session cookie exists while awaiting 2FA completion
        res.headers_mut().insert(
            header::SET_COOKIE,
            HeaderValue::from_static("nd_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0"),
        );
        return Ok(res);
    }

    log_audit(&state, &user.username, "auth.login", Some(&user.username), Some("User signed in"));
    create_authenticated_response(&state, user)
}

#[derive(Deserialize)]
pub(crate) struct Verify2faLoginPayload {
    #[serde(rename = "mfaToken")]
    mfa_token: String,
    code: String,
}

pub(crate) async fn verify_2fa_login_handler(
    State(state): State<AppState>,
    Json(payload): Json<Verify2faLoginPayload>,
) -> Result<Response, (StatusCode, String)> {
    let lock_key = format!("2fa:{}", payload.mfa_token);
    if let Some(rem) = state.auth.check_lockout(&lock_key) {
        return Err((
            StatusCode::TOO_MANY_REQUESTS,
            format!("Too many invalid 2FA attempts. Locked for {} seconds.", rem),
        ));
    }

    let user_id = state
        .auth
        .peek_mfa_challenge(&payload.mfa_token)
        .ok_or_else(|| (StatusCode::UNAUTHORIZED, "2FA session expired. Please sign in again.".to_string()))?;

    let user_2fa_key = format!("2fa_user:{}", user_id);
    if let Some(rem) = state.auth.check_lockout(&user_2fa_key) {
        state.auth.consume_mfa_challenge(&payload.mfa_token);
        return Err((
            StatusCode::TOO_MANY_REQUESTS,
            format!("Too many failed 2FA attempts. Locked for {} seconds.", rem),
        ));
    }

    let user = state
        .auth
        .get_user_by_id(user_id)
        .ok_or_else(|| (StatusCode::UNAUTHORIZED, "User not found".to_string()))?;

    if user.disabled {
        state.auth.consume_mfa_challenge(&payload.mfa_token);
        return Err((StatusCode::FORBIDDEN, "Account is disabled".to_string()));
    }

    if !state.auth.verify_user_2fa(user.id, &payload.code) {
        let token_lock = state.auth.record_failure(&lock_key);
        let user_lock = state.auth.record_failure(&user_2fa_key);
        if let Some(lock_s) = token_lock.or(user_lock) {
            state.auth.consume_mfa_challenge(&payload.mfa_token);
            log_audit(&state, &user.username, "auth.lockout", Some(&user.username), Some("Account locked after repeated failed 2FA attempts"));
            return Err((
                StatusCode::TOO_MANY_REQUESTS,
                format!("Too many failed 2FA attempts. Locked for {} seconds.", lock_s),
            ));
        }
        return Err((StatusCode::UNAUTHORIZED, "Invalid 6-digit authenticator code or recovery code".to_string()));
    }

    state.auth.clear_failures(&lock_key);
    state.auth.clear_failures(&user_2fa_key);
    state.auth.consume_mfa_challenge(&payload.mfa_token);

    log_audit(
        &state,
        &user.username,
        "auth.login",
        Some(&user.username),
        Some("User signed in with 2FA verification"),
    );

    create_authenticated_response(&state, user)
}

pub(crate) async fn logout_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Response, StatusCode> {
    if let Some(session_id) = extract_session_id(&headers) {
        state.auth.delete_session(&session_id);
    }
    let mut res = (StatusCode::OK, "Logged out").into_response();
    res.headers_mut().insert(
        header::SET_COOKIE,
        HeaderValue::from_static("nd_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0"),
    );
    res.headers_mut().insert(
        header::HeaderName::from_static("clear-site-data"),
        HeaderValue::from_static("\"cache\", \"storage\""),
    );
    Ok(res)
}

pub(crate) async fn me_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<LoginResponse>, StatusCode> {
    let session_id = extract_session_id(&headers).ok_or(StatusCode::UNAUTHORIZED)?;
    let (session, user) = state
        .auth
        .get_session(&session_id)
        .ok_or(StatusCode::UNAUTHORIZED)?;

    let active_sessions = state.auth.count_active_sessions(user.id);
    let passkey_count = state.auth.count_user_passkeys(user.id);
    Ok(Json(LoginResponse {
        user,
        csrf: session.csrf_token,
        active_sessions,
        passkey_count,
    }))
}

#[derive(Deserialize)]
pub(crate) struct PasswordChangePayload {
    current: String,
    next: String,
    #[serde(rename = "totpCode")]
    totp_code: Option<String>,
    #[serde(rename = "revokeOtherSessions")]
    revoke_other_sessions: Option<bool>,
}

pub(crate) async fn change_password_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<PasswordChangePayload>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let session_id = extract_session_id(&headers)
        .ok_or_else(|| (StatusCode::UNAUTHORIZED, "Unauthorized session".to_string()))?;
    let (_, user) = state
        .auth
        .get_session(&session_id)
        .ok_or_else(|| (StatusCode::UNAUTHORIZED, "Unauthorized session".to_string()))?;

    let (_, current_hash) = state
        .auth
        .get_user_by_username(&user.username)
        .ok_or_else(|| (StatusCode::UNAUTHORIZED, "User not found".to_string()))?;

    if !verify_password(&payload.current, &current_hash) {
        return Err((StatusCode::BAD_REQUEST, "Current password is incorrect".to_string()));
    }

    if user.totp_enabled {
        let code = payload.totp_code.as_deref().unwrap_or("").trim();
        if code.is_empty() {
            return Err((
                StatusCode::BAD_REQUEST,
                "Two-Factor Authentication is enabled: please enter your 6-digit authenticator code".to_string(),
            ));
        }
        if !state.auth.verify_user_2fa(user.id, code) {
            return Err((StatusCode::BAD_REQUEST, "Invalid 2FA authenticator code".to_string()));
        }
    }

    if payload.next.len() < 8 {
        return Err((
            StatusCode::BAD_REQUEST,
            "New password must be at least 8 characters long".to_string(),
        ));
    }

    if payload.next == payload.current {
        return Err((
            StatusCode::BAD_REQUEST,
            "New password must be different from your current password".to_string(),
        ));
    }

    let next_hash = hash_password(&payload.next)
        .map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, "Failed to hash password".to_string()))?;

    {
        let conn = state.db.lock().unwrap();
        conn.execute(
            "UPDATE users SET password_hash = ?, password_changed_at = ? WHERE id = ?",
            rusqlite::params![next_hash, now(), user.id],
        )
        .map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, "Database error".to_string()))?;
    }

    if user.is_main_admin {
        crate::config::Config::sync_dotenv_admin(Some(&user.username), Some(&payload.next));
    }

    let revoked = if payload.revoke_other_sessions.unwrap_or(true) {
        state.auth.revoke_other_sessions(user.id, &session_id)
    } else {
        0
    };

    log_audit(
        &state,
        &user.username,
        "user.update",
        Some(&user.username),
        Some(&format!("Changed account password (revoked {} other sessions)", revoked)),
    );

    Ok(Json(serde_json::json!({
        "ok": true,
        "revokedSessions": revoked
    })))
}

#[derive(Deserialize)]
pub(crate) struct Setup2faPayload {
    password: String,
}

pub(crate) async fn setup_2fa_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<Setup2faPayload>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let user = current_user(&state, &headers)
        .ok_or_else(|| (StatusCode::UNAUTHORIZED, "Unauthorized".to_string()))?;
    verify_current_user_password(&state, &user, &payload.password)?;

    let secret = generate_totp_secret();
    {
        let conn = state.db.lock().unwrap();
        conn.execute(
            "UPDATE users SET totp_pending_secret = ? WHERE id = ?",
            rusqlite::params![&secret, user.id],
        )
        .map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, "Failed to save pending 2FA secret".to_string()))?;
    }

    // Refresh real-world UTC offset in background so verification works even if local system clock is shifted
    std::thread::spawn(|| {
        crate::auth::sync_real_utc_offset();
    });

    let safe_label: String = user
        .username
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_' || *c == '.')
        .collect();
    let label = if safe_label.is_empty() { "admin" } else { &safe_label };
    let otpauth_url = format!(
        "otpauth://totp/WebDep:{}?secret={}&issuer=WebDep",
        label, secret
    );

    Ok(Json(serde_json::json!({
        "secret": secret,
        "otpauthUrl": otpauth_url,
        "account": user.username,
        "issuer": "WebDep"
    })))
}

#[derive(Deserialize)]
pub(crate) struct Enable2faPayload {
    code: String,
}

pub(crate) async fn enable_2fa_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<Enable2faPayload>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let user = current_user(&state, &headers)
        .ok_or_else(|| (StatusCode::UNAUTHORIZED, "Unauthorized".to_string()))?;

    let pending_secret: Option<String> = {
        let conn = state.db.lock().unwrap();
        conn.query_row(
            "SELECT totp_pending_secret FROM users WHERE id = ?",
            rusqlite::params![user.id],
            |r| r.get(0),
        )
        .ok()
        .flatten()
    };

    let Some(secret) = pending_secret else {
        return Err((
            StatusCode::BAD_REQUEST,
            "No pending 2FA setup found. Click 'Setup 2FA' first.".to_string(),
        ));
    };

    if !verify_totp_code(&secret, &payload.code) {
        return Err((
            StatusCode::BAD_REQUEST,
            "Invalid 6-digit code. Make sure you scanned the QR code or entered the secret key in your authenticator app.".to_string(),
        ));
    }

    let backup_codes = generate_backup_codes();
    let backup_json = serde_json::to_string(&backup_codes).unwrap_or_else(|_| "[]".to_string());

    {
        let conn = state.db.lock().unwrap();
        conn.execute(
            "UPDATE users SET totp_secret = ?, totp_pending_secret = NULL, totp_enabled = 1, totp_backup_codes = ? WHERE id = ?",
            rusqlite::params![&secret, &backup_json, user.id],
        )
        .map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, "Failed to enable 2FA".to_string()))?;
    }

    apply_2fa_state_change(&state, &user.username, "Enabled Two-Factor Authentication (2FA)");

    Ok(Json(serde_json::json!({
        "ok": true,
        "backupCodes": backup_codes
    })))
}

#[derive(Deserialize)]
pub(crate) struct Disable2faPayload {
    password: String,
    code: String,
}

pub(crate) async fn disable_2fa_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<Disable2faPayload>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let user = current_user(&state, &headers)
        .ok_or_else(|| (StatusCode::UNAUTHORIZED, "Unauthorized".to_string()))?;
    verify_current_user_password(&state, &user, &payload.password)?;

    if !state.auth.verify_user_2fa(user.id, &payload.code) {
        return Err((
            StatusCode::BAD_REQUEST,
            "Invalid 6-digit authenticator code or recovery code".to_string(),
        ));
    }

    {
        let conn = state.db.lock().unwrap();
        conn.execute(
            "UPDATE users SET totp_secret = NULL, totp_pending_secret = NULL, totp_enabled = 0, totp_backup_codes = '[]' WHERE id = ?",
            rusqlite::params![user.id],
        )
        .map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, "Failed to disable 2FA".to_string()))?;
    }

    apply_2fa_state_change(&state, &user.username, "Disabled Two-Factor Authentication (2FA)");

    Ok(Json(serde_json::json!({ "ok": true })))
}

pub(crate) async fn revoke_other_sessions_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let session_id = extract_session_id(&headers)
        .ok_or_else(|| (StatusCode::UNAUTHORIZED, "Unauthorized".to_string()))?;
    let (_, user) = state
        .auth
        .get_session(&session_id)
        .ok_or_else(|| (StatusCode::UNAUTHORIZED, "Unauthorized".to_string()))?;

    let revoked = state.auth.revoke_other_sessions(user.id, &session_id);
    log_audit(
        &state,
        &user.username,
        "user.update",
        Some(&user.username),
        Some(&format!("Revoked {} other active session(s)", revoked)),
    );

    Ok(Json(serde_json::json!({ "ok": true, "revoked": revoked })))
}


// ---------------------------------------------------------------------------
// Passkey & Biometric (WebAuthn) Handlers
// ---------------------------------------------------------------------------
pub(crate) async fn list_passkeys_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let user = current_user(&state, &headers)
        .ok_or_else(|| (StatusCode::UNAUTHORIZED, "Unauthorized".to_string()))?;
    let passkeys = state.auth.list_passkeys(user.id);
    Ok(Json(serde_json::json!({ "passkeys": passkeys })))
}

pub(crate) async fn passkey_register_start_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let user = current_user(&state, &headers)
        .ok_or_else(|| (StatusCode::UNAUTHORIZED, "Unauthorized".to_string()))?;
    let (challenge_id, challenge_b64) = state.auth.create_passkey_challenge(Some(user.id));
    let existing: Vec<String> = state
        .auth
        .list_passkeys(user.id)
        .into_iter()
        .map(|p| p.credential_id)
        .collect();
    let user_id_b64 = crate::auth::b64url_encode(format!("webdep-user-{}", user.id).as_bytes());
    Ok(Json(serde_json::json!({
        "challengeId": challenge_id,
        "challenge": challenge_b64,
        "user": {
            "id": user_id_b64,
            "name": user.username,
            "displayName": user.username,
        },
        "excludeCredentials": existing,
    })))
}

#[derive(Deserialize)]
pub(crate) struct PasskeyRegisterFinishPayload {
    #[serde(rename = "challengeId")]
    challenge_id: String,
    name: Option<String>,
    #[serde(rename = "credentialId")]
    credential_id: String,
    #[serde(rename = "publicKeySpki")]
    public_key_spki: Option<String>,
    #[serde(rename = "attestationObject")]
    attestation_object: Option<String>,
    #[serde(rename = "authenticatorData")]
    authenticator_data: Option<String>,
    #[serde(rename = "clientDataJSON")]
    client_data_json: String,
}

pub(crate) async fn passkey_register_finish_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<PasskeyRegisterFinishPayload>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let user = current_user(&state, &headers)
        .ok_or_else(|| (StatusCode::UNAUTHORIZED, "Unauthorized".to_string()))?;
    let (uid_opt, expected_challenge) = state
        .auth
        .consume_passkey_challenge(&payload.challenge_id)
        .ok_or_else(|| (StatusCode::BAD_REQUEST, "Passkey registration challenge expired. Please try again.".to_string()))?;
    if uid_opt != Some(user.id) {
        return Err((StatusCode::BAD_REQUEST, "Passkey challenge user mismatch".to_string()));
    }

    let label = payload
        .name
        .as_deref()
        .unwrap_or("Passkey / Biometric Device");
    let info = state
        .auth
        .register_passkey(
            user.id,
            label,
            &payload.credential_id,
            payload.public_key_spki.as_deref(),
            payload.attestation_object.as_deref(),
            payload.authenticator_data.as_deref(),
            &payload.client_data_json,
            &expected_challenge,
        )
        .map_err(|e| (StatusCode::BAD_REQUEST, e))?;

    log_audit(
        &state,
        &user.username,
        "user.update",
        Some(&user.username),
        Some(&format!("Registered passkey / biometric device '{}'", info.name)),
    );

    let passkeys = state.auth.list_passkeys(user.id);
    Ok(Json(serde_json::json!({
        "ok": true,
        "passkey": info,
        "passkeys": passkeys,
    })))
}

pub(crate) async fn delete_passkey_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxPath(id): AxPath<i64>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let user = current_user(&state, &headers)
        .ok_or_else(|| (StatusCode::UNAUTHORIZED, "Unauthorized".to_string()))?;
    if !state.auth.delete_passkey(user.id, id) {
        return Err((StatusCode::NOT_FOUND, "Passkey not found".to_string()));
    }
    log_audit(
        &state,
        &user.username,
        "user.update",
        Some(&user.username),
        Some(&format!("Removed passkey #{}", id)),
    );
    let passkeys = state.auth.list_passkeys(user.id);
    Ok(Json(serde_json::json!({
        "ok": true,
        "passkeys": passkeys,
    })))
}

#[derive(Deserialize, Default)]
pub(crate) struct PasskeyLoginStartPayload {
    username: Option<String>,
}

pub(crate) async fn passkey_login_start_handler(
    State(state): State<AppState>,
    Json(payload): Json<PasskeyLoginStartPayload>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let total = state.auth.total_passkeys_count();
    if total == 0 {
        return Err((
            StatusCode::BAD_REQUEST,
            "No passkeys or biometric devices are registered yet. Sign in with your password and add one in Settings -> Security.".to_string(),
        ));
    }
    let cred_ids = state
        .auth
        .list_login_credential_ids(payload.username.as_deref());
    if cred_ids.is_empty() && payload.username.as_deref().map(|s| !s.trim().is_empty()).unwrap_or(false) {
        return Err((
            StatusCode::BAD_REQUEST,
            "No passkeys registered for this username.".to_string(),
        ));
    }
    let (challenge_id, challenge_b64) = state.auth.create_passkey_challenge(None);
    Ok(Json(serde_json::json!({
        "challengeId": challenge_id,
        "challenge": challenge_b64,
        "allowCredentials": cred_ids,
    })))
}

#[derive(Deserialize)]
pub(crate) struct PasskeyLoginFinishPayload {
    #[serde(rename = "challengeId")]
    challenge_id: String,
    #[serde(rename = "credentialId")]
    credential_id: String,
    #[serde(rename = "authenticatorData")]
    authenticator_data: String,
    #[serde(rename = "clientDataJSON")]
    client_data_json: String,
    signature: String,
}

pub(crate) async fn passkey_login_finish_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<PasskeyLoginFinishPayload>,
) -> Result<Response, (StatusCode, String)> {
    if let Some(old_sid) = extract_session_id(&headers) {
        state.auth.delete_session(&old_sid);
    }

    let (_uid_opt, expected_challenge) = state
        .auth
        .consume_passkey_challenge(&payload.challenge_id)
        .ok_or_else(|| (StatusCode::UNAUTHORIZED, "Passkey login challenge expired. Please try again.".to_string()))?;

    let (user, passkey_name) = state
        .auth
        .verify_passkey_login(
            &payload.credential_id,
            &payload.authenticator_data,
            &payload.client_data_json,
            &payload.signature,
            &expected_challenge,
        )
        .map_err(|e| (StatusCode::UNAUTHORIZED, e))?;

    log_audit(
        &state,
        &user.username,
        "auth.login",
        Some(&user.username),
        Some(&format!("User signed in via Passkey / Biometrics ({})", passkey_name)),
    );

    create_authenticated_response(&state, user)
}

// ---------------------------------------------------------------------------
// Projects Handlers
// ---------------------------------------------------------------------------
