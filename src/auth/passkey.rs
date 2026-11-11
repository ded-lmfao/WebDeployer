use rand::RngCore;
use rusqlite::params;
use serde::{Deserialize, Serialize};
use std::time::{SystemTime, UNIX_EPOCH};

use super::crypto_p256::{b64url_decode, b64url_encode, extract_p256_pubkey, verify_p256_ecdsa};
use super::manager::Auth;
use super::password::{constant_time_eq, random_token};
use super::user::User;

#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct PasskeyInfo {
    pub id: i64,
    #[serde(rename = "userId")]
    pub user_id: i64,
    #[serde(rename = "credentialId")]
    pub credential_id: String,
    pub name: String,
    pub alg: i64,
    #[serde(rename = "signCount")]
    pub sign_count: i64,
    #[serde(rename = "createdAt")]
    pub created_at: i64,
    #[serde(rename = "lastUsedAt")]
    pub last_used_at: Option<i64>,
}



impl Auth {
    pub fn create_passkey_challenge(&self, user_id: Option<i64>) -> (String, String) {
        let now = Self::now_secs();
        let challenge_id = random_token(24);
        let mut raw_challenge = [0u8; 32];
        rand::thread_rng().fill_bytes(&mut raw_challenge);
        let challenge_b64 = b64url_encode(&raw_challenge);
        if let Ok(mut map) = self.passkey_challenges.lock() {
            map.retain(|_, (_, _, exp)| *exp > now);
            map.insert(challenge_id.clone(), (user_id, challenge_b64.clone(), now + 300));
        }
        (challenge_id, challenge_b64)
    }

    pub fn consume_passkey_challenge(&self, challenge_id: &str) -> Option<(Option<i64>, String)> {
        let now = Self::now_secs();
        let mut map = self.passkey_challenges.lock().ok()?;
        map.retain(|_, (_, _, exp)| *exp > now);
        map.remove(challenge_id).map(|(uid, ch, _)| (uid, ch))
    }

    pub fn list_passkeys(&self, user_id: i64) -> Vec<PasskeyInfo> {
        let conn = self.db.lock().unwrap();
        let mut stmt = match conn.prepare(
            "SELECT id, user_id, credential_id, name, alg, sign_count, created_at, last_used_at
             FROM user_passkeys WHERE user_id = ? ORDER BY id DESC",
        ) {
            Ok(s) => s,
            Err(_) => return Vec::new(),
        };
        stmt.query_map(params![user_id], |r| {
            Ok(PasskeyInfo {
                id: r.get(0)?,
                user_id: r.get(1)?,
                credential_id: r.get(2)?,
                name: r.get(3)?,
                alg: r.get(4)?,
                sign_count: r.get(5)?,
                created_at: r.get(6)?,
                last_used_at: r.get(7)?,
            })
        })
        .map(|it| it.flatten().collect())
        .unwrap_or_default()
    }

    pub fn count_user_passkeys(&self, user_id: i64) -> usize {
        let conn = self.db.lock().unwrap();
        conn.query_row(
            "SELECT COUNT(*) FROM user_passkeys WHERE user_id = ?",
            params![user_id],
            |r| r.get::<_, i64>(0),
        )
        .unwrap_or(0) as usize
    }

    pub fn total_passkeys_count(&self) -> usize {
        let conn = self.db.lock().unwrap();
        conn.query_row(
            "SELECT COUNT(*) FROM user_passkeys p JOIN users u ON u.id = p.user_id WHERE COALESCE(u.disabled, 0) = 0",
            [],
            |r| r.get::<_, i64>(0),
        )
        .unwrap_or(0) as usize
    }

    pub fn list_login_credential_ids(&self, username_opt: Option<&str>) -> Vec<String> {
        let conn = self.db.lock().unwrap();
        if let Some(uname) = username_opt.map(|s| s.trim()).filter(|s| !s.is_empty()) {
            let mut stmt = match conn.prepare(
                "SELECT p.credential_id FROM user_passkeys p
                 JOIN users u ON u.id = p.user_id
                 WHERE LOWER(u.username) = LOWER(?) AND COALESCE(u.disabled, 0) = 0
                 ORDER BY p.id DESC",
            ) {
                Ok(s) => s,
                Err(_) => return Vec::new(),
            };
            stmt.query_map(params![uname], |r| r.get::<_, String>(0))
                .map(|it| it.flatten().collect())
                .unwrap_or_default()
        } else {
            let mut stmt = match conn.prepare(
                "SELECT p.credential_id FROM user_passkeys p
                 JOIN users u ON u.id = p.user_id
                 WHERE COALESCE(u.disabled, 0) = 0
                 ORDER BY p.id DESC LIMIT 50",
            ) {
                Ok(s) => s,
                Err(_) => return Vec::new(),
            };
            stmt.query_map([], |r| r.get::<_, String>(0))
                .map(|it| it.flatten().collect())
                .unwrap_or_default()
        }
    }

    pub fn register_passkey(
        &self,
        user_id: i64,
        name: &str,
        credential_id_b64: &str,
        public_key_spki_b64: Option<&str>,
        attestation_object_b64: Option<&str>,
        auth_data_b64: Option<&str>,
        client_data_b64: &str,
        expected_challenge_b64: &str,
    ) -> Result<PasskeyInfo, String> {
        let cred_raw = b64url_decode(credential_id_b64)
            .ok_or_else(|| "Invalid credential ID encoding".to_string())?;
        if cred_raw.is_empty() || cred_raw.len() > 1024 {
            return Err("Invalid credential ID length".to_string());
        }
        let norm_cred_id = b64url_encode(&cred_raw);

        let client_data_bytes = b64url_decode(client_data_b64)
            .ok_or_else(|| "Invalid clientDataJSON encoding".to_string())?;
        let client_json: serde_json::Value = serde_json::from_slice(&client_data_bytes)
            .map_err(|_| "Invalid clientDataJSON payload".to_string())?;

        if client_json.get("type").and_then(|v| v.as_str()) != Some("webauthn.create") {
            return Err("WebAuthn clientDataJSON type mismatch (expected webauthn.create)".to_string());
        }
        let got_challenge = client_json
            .get("challenge")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        if !constant_time_eq(got_challenge, expected_challenge_b64) {
            return Err("WebAuthn registration challenge mismatch".to_string());
        }

        let mut pub_point: Option<[u8; 65]> = None;
        if let Some(spki_b64) = public_key_spki_b64.filter(|s| !s.trim().is_empty()) {
            if let Some(spki_bytes) = b64url_decode(spki_b64) {
                pub_point = extract_p256_pubkey(&spki_bytes);
            }
        }
        if pub_point.is_none() {
            if let Some(ad_b64) = auth_data_b64.filter(|s| !s.trim().is_empty()) {
                if let Some(ad_bytes) = b64url_decode(ad_b64) {
                    pub_point = extract_p256_pubkey(&ad_bytes);
                }
            }
        }
        if pub_point.is_none() {
            if let Some(att_b64) = attestation_object_b64.filter(|s| !s.trim().is_empty()) {
                if let Some(att_bytes) = b64url_decode(att_b64) {
                    pub_point = extract_p256_pubkey(&att_bytes);
                }
            }
        }

        let point65 = pub_point.ok_or_else(|| {
            "Unsupported passkey public key format (expected ES256 / P-256)".to_string()
        })?;
        let pub_hex = hex::encode(point65);

        let clean_name = {
            let trimmed = name.trim();
            if trimmed.is_empty() {
                "Passkey / Biometric Device".to_string()
            } else {
                trimmed.chars().take(64).collect()
            }
        };

        let now_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as i64;

        let conn = self.db.lock().unwrap();
        conn.execute(
            "INSERT INTO user_passkeys (user_id, credential_id, name, public_key, alg, sign_count, created_at)
             VALUES (?, ?, ?, ?, -7, 0, ?)
             ON CONFLICT(credential_id) DO UPDATE SET
               user_id = excluded.user_id,
               name = excluded.name,
               public_key = excluded.public_key",
            params![user_id, norm_cred_id, clean_name, pub_hex, now_ms],
        )
        .map_err(|e| format!("Failed to save passkey: {}", e))?;

        let id = conn.last_insert_rowid();
        Ok(PasskeyInfo {
            id,
            user_id,
            credential_id: norm_cred_id,
            name: clean_name,
            alg: -7,
            sign_count: 0,
            created_at: now_ms,
            last_used_at: None,
        })
    }

    pub fn verify_passkey_login(
        &self,
        credential_id_b64: &str,
        auth_data_b64: &str,
        client_data_b64: &str,
        signature_b64: &str,
        expected_challenge_b64: &str,
    ) -> Result<(User, String), String> {
        let cred_raw = b64url_decode(credential_id_b64)
            .ok_or_else(|| "Invalid credential ID".to_string())?;
        let norm_cred_id = b64url_encode(&cred_raw);

        let auth_data = b64url_decode(auth_data_b64)
            .ok_or_else(|| "Invalid authenticatorData".to_string())?;
        if auth_data.len() < 37 {
            return Err("authenticatorData too short".to_string());
        }
        let flags = auth_data[32];
        if (flags & 0x01) == 0 {
            return Err("Authenticator did not assert User Presence".to_string());
        }
        let new_sign_count = u32::from_be_bytes([auth_data[33], auth_data[34], auth_data[35], auth_data[36]]) as i64;

        let client_data = b64url_decode(client_data_b64)
            .ok_or_else(|| "Invalid clientDataJSON".to_string())?;
        let client_json: serde_json::Value = serde_json::from_slice(&client_data)
            .map_err(|_| "Malformed clientDataJSON".to_string())?;
        if client_json.get("type").and_then(|v| v.as_str()) != Some("webauthn.get") {
            return Err("WebAuthn clientDataJSON type mismatch (expected webauthn.get)".to_string());
        }
        let got_challenge = client_json
            .get("challenge")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        if !constant_time_eq(got_challenge, expected_challenge_b64) {
            return Err("Passkey challenge expired or mismatched".to_string());
        }

        let sig_bytes = b64url_decode(signature_b64)
            .ok_or_else(|| "Invalid passkey signature encoding".to_string())?;

        let (passkey_id, user_id, passkey_name, pub_hex, prev_sign_count): (i64, i64, String, String, i64) = {
            let conn = self.db.lock().unwrap();
            conn.query_row(
                "SELECT id, user_id, name, public_key, sign_count FROM user_passkeys WHERE credential_id = ?",
                params![norm_cred_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
            )
            .map_err(|_| "Passkey is not registered on this server".to_string())?
        };

        let pub_bytes = hex::decode(&pub_hex)
            .map_err(|_| "Stored passkey public key is corrupted".to_string())?;

        use sha2::{Digest, Sha256};
        let client_hash = Sha256::digest(&client_data);
        let mut signed_payload = Vec::with_capacity(auth_data.len() + 32);
        signed_payload.extend_from_slice(&auth_data);
        signed_payload.extend_from_slice(&client_hash);
        let msg_hash_generic = Sha256::digest(&signed_payload);
        let mut msg_hash = [0u8; 32];
        msg_hash.copy_from_slice(&msg_hash_generic);

        if !verify_p256_ecdsa(&pub_bytes, &msg_hash, &sig_bytes) {
            return Err("Passkey cryptographic signature verification failed".to_string());
        }

        let user = self
            .get_user_by_id(user_id)
            .ok_or_else(|| "Account associated with passkey no longer exists".to_string())?;
        if user.disabled {
            return Err("Account disabled".to_string());
        }

        let now_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as i64;
        let updated_count = new_sign_count.max(prev_sign_count);
        {
            let conn = self.db.lock().unwrap();
            conn.execute(
                "UPDATE user_passkeys SET last_used_at = ?, sign_count = ? WHERE id = ?",
                params![now_ms, updated_count, passkey_id],
            )
            .ok();
        }

        Ok((user, passkey_name))
    }

    pub fn delete_passkey(&self, user_id: i64, passkey_id: i64) -> bool {
        let conn = self.db.lock().unwrap();
        let changed = conn
            .execute(
                "DELETE FROM user_passkeys WHERE id = ? AND user_id = ?",
                params![passkey_id, user_id],
            )
            .unwrap_or(0);
        changed > 0
    }
}

