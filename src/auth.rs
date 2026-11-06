use argon2::{
    password_hash::{rand_core::OsRng, PasswordHash, PasswordHasher, PasswordVerifier, SaltString},
    Argon2,
};
use rand::RngCore;
use rusqlite::params;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::db::DbPool;

#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct User {
    pub id: i64,
    pub username: String,
    pub role: String,
    pub disabled: bool,
    pub permissions: Vec<String>,
    #[serde(rename = "allowedProjects")]
    pub allowed_projects: Vec<i64>,
    #[serde(rename = "allProjects")]
    pub all_projects: bool,
    #[serde(rename = "isMainAdmin")]
    pub is_main_admin: bool,
    #[serde(rename = "totpEnabled")]
    pub totp_enabled: bool,
    pub created_at: i64,
}

impl User {
    pub fn from_db(
        id: i64,
        username: String,
        role: String,
        disabled_int: i64,
        perms_json: String,
        proj_json: String,
        totp_enabled_int: i64,
        created_at: i64,
    ) -> Self {
        let is_main_admin = id == 1 || username.eq_ignore_ascii_case("admin");
        let disabled = !is_main_admin && disabled_int != 0;

        let mut permissions: Vec<String> = serde_json::from_str(&perms_json).unwrap_or_default();
        if is_main_admin {
            permissions = vec!["*".to_string()];
        } else if permissions.is_empty() && role == "admin" {
            permissions = vec!["*".to_string()];
        }

        let mut all_projects = is_main_admin;
        let mut allowed_projects = Vec::new();
        if !is_main_admin {
            if let Ok(vals) = serde_json::from_str::<Vec<serde_json::Value>>(&proj_json) {
                for v in vals {
                    if v.as_str() == Some("*") {
                        all_projects = true;
                    } else if let Some(pid) = v.as_i64() {
                        allowed_projects.push(pid);
                    } else if let Some(s) = v.as_str() {
                        if let Ok(pid) = s.parse::<i64>() {
                            allowed_projects.push(pid);
                        }
                    }
                }
            } else {
                all_projects = true;
            }
        }

        Self {
            id,
            username,
            role: if is_main_admin { "admin".to_string() } else { role },
            disabled,
            permissions,
            allowed_projects,
            all_projects,
            is_main_admin,
            totp_enabled: totp_enabled_int != 0,
            created_at,
        }
    }

    pub fn has_power(&self, power: &str) -> bool {
        if self.is_main_admin {
            return true;
        }
        self.permissions.iter().any(|p| p == "*" || p == power)
    }

    pub fn can_access_project(&self, project_id: i64) -> bool {
        if self.is_main_admin || self.all_projects {
            return true;
        }
        self.allowed_projects.contains(&project_id)
    }
}

#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct Session {
    pub id: String,
    pub user_id: i64,
    pub expires_at: i64,
    pub csrf_token: String,
}

pub fn hash_password(password: &str) -> Result<String, String> {
    let salt = SaltString::generate(&mut OsRng);
    let argon2 = Argon2::default();
    let hash = argon2
        .hash_password(password.as_bytes(), &salt)
        .map_err(|e| e.to_string())?;
    Ok(hash.to_string())
}

pub fn verify_password(password: &str, hash_str: &str) -> bool {
    if let Ok(parsed) = PasswordHash::new(hash_str) {
        Argon2::default()
            .verify_password(password.as_bytes(), &parsed)
            .is_ok()
    } else {
        false
    }
}

pub fn random_token(byte_len: usize) -> String {
    let mut bytes = vec![0u8; byte_len];
    rand::thread_rng().fill_bytes(&mut bytes);
    hex::encode(bytes)
}

pub fn constant_time_eq(a: &str, b: &str) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.bytes().zip(b.bytes()) {
        diff |= x ^ y;
    }
    diff == 0
}

// ===========================================================================
// RFC 4648 Base32 & RFC 6238 TOTP (HMAC-SHA1) Implementation
// ===========================================================================
const BASE32_ALPHABET: &[u8; 32] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

pub fn base32_encode(data: &[u8]) -> String {
    let mut out = String::new();
    let mut buffer: u32 = 0;
    let mut bits_left: u8 = 0;
    for &byte in data {
        buffer = (buffer << 8) | (byte as u32);
        bits_left += 8;
        while bits_left >= 5 {
            bits_left -= 5;
            let idx = ((buffer >> bits_left) & 0x1F) as usize;
            out.push(BASE32_ALPHABET[idx] as char);
        }
    }
    if bits_left > 0 {
        let idx = ((buffer << (5 - bits_left)) & 0x1F) as usize;
        out.push(BASE32_ALPHABET[idx] as char);
    }
    out
}

pub fn base32_decode(input: &str) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    let mut buffer: u32 = 0;
    let mut bits_left: u8 = 0;
    for c in input.chars() {
        if c == '=' || c.is_whitespace() || c == '-' {
            continue;
        }
        let val: u32 = match c.to_ascii_uppercase() {
            'A'..='Z' => (c.to_ascii_uppercase() as u32) - ('A' as u32),
            '2'..='7' => (c as u32) - ('2' as u32) + 26,
            _ => return None,
        };
        buffer = (buffer << 5) | val;
        bits_left += 5;
        if bits_left >= 8 {
            bits_left -= 8;
            out.push(((buffer >> bits_left) & 0xFF) as u8);
        }
    }
    Some(out)
}

fn sha1_digest(data: &[u8]) -> [u8; 20] {
    let mut h0: u32 = 0x67452301;
    let mut h1: u32 = 0xEFCDAB89;
    let mut h2: u32 = 0x98BADCFE;
    let mut h3: u32 = 0x10325476;
    let mut h4: u32 = 0xC3D2E1F0;

    let bit_len = (data.len() as u64) * 8;
    let mut msg = data.to_vec();
    msg.push(0x80);
    while (msg.len() % 64) != 56 {
        msg.push(0x00);
    }
    msg.extend_from_slice(&bit_len.to_be_bytes());

    for chunk in msg.chunks(64) {
        let mut w = [0u32; 80];
        for i in 0..16 {
            w[i] = u32::from_be_bytes([
                chunk[i * 4],
                chunk[i * 4 + 1],
                chunk[i * 4 + 2],
                chunk[i * 4 + 3],
            ]);
        }
        for i in 16..80 {
            w[i] = (w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16]).rotate_left(1);
        }

        let mut a = h0;
        let mut b = h1;
        let mut c = h2;
        let mut d = h3;
        let mut e = h4;

        for i in 0..80 {
            let (f, k) = match i {
                0..=19 => ((b & c) | ((!b) & d), 0x5A827999u32),
                20..=39 => (b ^ c ^ d, 0x6ED9EBA1u32),
                40..=59 => ((b & c) | (b & d) | (c & d), 0x8F1BBCDCu32),
                _ => (b ^ c ^ d, 0xCA62C1D6u32),
            };
            let temp = a
                .rotate_left(5)
                .wrapping_add(f)
                .wrapping_add(e)
                .wrapping_add(k)
                .wrapping_add(w[i]);
            e = d;
            d = c;
            c = b.rotate_left(30);
            b = a;
            a = temp;
        }

        h0 = h0.wrapping_add(a);
        h1 = h1.wrapping_add(b);
        h2 = h2.wrapping_add(c);
        h3 = h3.wrapping_add(d);
        h4 = h4.wrapping_add(e);
    }

    let mut out = [0u8; 20];
    out[0..4].copy_from_slice(&h0.to_be_bytes());
    out[4..8].copy_from_slice(&h1.to_be_bytes());
    out[8..12].copy_from_slice(&h2.to_be_bytes());
    out[12..16].copy_from_slice(&h3.to_be_bytes());
    out[16..20].copy_from_slice(&h4.to_be_bytes());
    out
}

fn hmac_sha1(key: &[u8], message: &[u8]) -> [u8; 20] {
    let mut k_block = [0u8; 64];
    if key.len() > 64 {
        let hashed = sha1_digest(key);
        k_block[..20].copy_from_slice(&hashed);
    } else {
        k_block[..key.len()].copy_from_slice(key);
    }

    let mut ipad = [0x36u8; 64];
    let mut opad = [0x5Cu8; 64];
    for i in 0..64 {
        ipad[i] ^= k_block[i];
        opad[i] ^= k_block[i];
    }

    let mut inner = Vec::with_capacity(64 + message.len());
    inner.extend_from_slice(&ipad);
    inner.extend_from_slice(message);
    let inner_hash = sha1_digest(&inner);

    let mut outer = Vec::with_capacity(64 + 20);
    outer.extend_from_slice(&opad);
    outer.extend_from_slice(&inner_hash);
    sha1_digest(&outer)
}

pub fn generate_totp_secret() -> String {
    let mut bytes = [0u8; 20];
    rand::thread_rng().fill_bytes(&mut bytes);
    base32_encode(&bytes)
}

pub fn compute_totp_at(secret_b32: &str, counter: u64) -> Option<String> {
    let key = base32_decode(secret_b32)?;
    let msg = counter.to_be_bytes();
    let mac = hmac_sha1(&key, &msg);
    let offset = (mac[19] & 0x0f) as usize;
    let bin_code = ((mac[offset] as u32 & 0x7f) << 24)
        | ((mac[offset + 1] as u32) << 16)
        | ((mac[offset + 2] as u32) << 8)
        | (mac[offset + 3] as u32);
    let otp = bin_code % 1_000_000;
    Some(format!("{:06}", otp))
}

pub fn verify_totp_code(secret_b32: &str, code: &str) -> bool {
    let clean: String = code.chars().filter(|c| c.is_ascii_digit()).collect();
    if clean.len() != 6 {
        return false;
    }
    let now_s = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let step = now_s / 30;
    for offset in [-1i64, 0, 1] {
        let counter = (step as i64 + offset) as u64;
        if let Some(expected) = compute_totp_at(secret_b32, counter) {
            if constant_time_eq(&expected, &clean) {
                return true;
            }
        }
    }
    false
}

pub fn generate_backup_codes() -> Vec<String> {
    const CHARS: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let mut codes = Vec::with_capacity(8);
    let mut rng = rand::thread_rng();
    for _ in 0..8 {
        let mut buf = [0u8; 8];
        rng.fill_bytes(&mut buf);
        let p1: String = (0..4).map(|i| CHARS[(buf[i] as usize) % CHARS.len()] as char).collect();
        let p2: String = (4..8).map(|i| CHARS[(buf[i] as usize) % CHARS.len()] as char).collect();
        codes.push(format!("{}-{}", p1, p2));
    }
    codes
}

#[derive(Clone, Default)]
struct FailureRecord {
    count: u32,
    first_at_s: u64,
    locked_until_s: u64,
}

pub struct Auth {
    db: DbPool,
    pub session_ttl_s: u64,
    mfa_challenges: Mutex<HashMap<String, (i64, u64)>>,
    failures: Mutex<HashMap<String, FailureRecord>>,
    session_cache: Mutex<HashMap<String, (Session, User, u64)>>,
}

impl Auth {
    pub fn new(db: DbPool, session_ttl_s: u64) -> Self {
        let auth = Self {
            db,
            session_ttl_s,
            mfa_challenges: Mutex::new(HashMap::new()),
            failures: Mutex::new(HashMap::new()),
            session_cache: Mutex::new(HashMap::new()),
        };
        auth.ensure_admin();
        auth
    }

    pub fn invalidate_sessions(&self) {
        if let Ok(mut cache) = self.session_cache.lock() {
            cache.clear();
        }
    }

    fn now_secs() -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs()
    }

    pub fn check_lockout(&self, key: &str) -> Option<u64> {
        let now = Self::now_secs();
        let mut map = self.failures.lock().unwrap();
        if let Some(rec) = map.get_mut(key) {
            if rec.locked_until_s > now {
                return Some(rec.locked_until_s - now);
            }
            if now.saturating_sub(rec.first_at_s) > 600 {
                map.remove(key);
            }
        }
        None
    }

    pub fn record_failure(&self, key: &str) -> Option<u64> {
        let now = Self::now_secs();
        let mut map = self.failures.lock().unwrap();
        let entry = map.entry(key.to_string()).or_insert(FailureRecord {
            count: 0,
            first_at_s: now,
            locked_until_s: 0,
        });
        if now.saturating_sub(entry.first_at_s) > 600 {
            entry.count = 0;
            entry.first_at_s = now;
            entry.locked_until_s = 0;
        }
        entry.count += 1;
        if entry.count >= 5 {
            entry.locked_until_s = now + 300; // 5-minute lockout after 5 failed attempts
            return Some(300);
        }
        None
    }

    pub fn clear_failures(&self, key: &str) {
        let mut map = self.failures.lock().unwrap();
        map.remove(key);
    }

    pub fn create_mfa_challenge(&self, user_id: i64) -> String {
        let now = Self::now_secs();
        let token = random_token(24);
        let mut map = self.mfa_challenges.lock().unwrap();
        map.retain(|_, (_, exp)| *exp > now);
        map.insert(token.clone(), (user_id, now + 300)); // valid for 5 minutes
        token
    }

    pub fn peek_mfa_challenge(&self, token: &str) -> Option<i64> {
        let now = Self::now_secs();
        let map = self.mfa_challenges.lock().unwrap();
        map.get(token).and_then(|(uid, exp)| if *exp > now { Some(*uid) } else { None })
    }

    pub fn consume_mfa_challenge(&self, token: &str) -> Option<i64> {
        let now = Self::now_secs();
        let mut map = self.mfa_challenges.lock().unwrap();
        map.retain(|_, (_, exp)| *exp > now);
        map.remove(token).map(|(uid, _)| uid)
    }

    pub fn verify_user_2fa(&self, user_id: i64, code: &str) -> bool {
        let trimmed = code.trim();
        if trimmed.is_empty() {
            return false;
        }

        let (secret_opt, backup_json): (Option<String>, String) = {
            let conn = self.db.lock().unwrap();
            conn.query_row(
                "SELECT totp_secret, COALESCE(totp_backup_codes, '[]') FROM users WHERE id = ? AND totp_enabled = 1",
                params![user_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap_or((None, "[]".to_string()))
        };

        if let Some(secret) = secret_opt {
            if verify_totp_code(&secret, trimmed) {
                return true;
            }
        }

        // Check one-time backup recovery codes (case-insensitive, with or without hyphen)
        let norm_input: String = trimmed
            .chars()
            .filter(|c| c.is_ascii_alphanumeric())
            .map(|c| c.to_ascii_uppercase())
            .collect();
        if norm_input.len() >= 8 {
            if let Ok(mut codes) = serde_json::from_str::<Vec<String>>(&backup_json) {
                if let Some(pos) = codes.iter().position(|c| {
                    let norm_c: String = c
                        .chars()
                        .filter(|ch| ch.is_ascii_alphanumeric())
                        .map(|ch| ch.to_ascii_uppercase())
                        .collect();
                    constant_time_eq(&norm_c, &norm_input)
                }) {
                    codes.remove(pos);
                    let updated_json = serde_json::to_string(&codes).unwrap_or_else(|_| "[]".to_string());
                    let conn = self.db.lock().unwrap();
                    conn.execute(
                        "UPDATE users SET totp_backup_codes = ? WHERE id = ?",
                        params![updated_json, user_id],
                    )
                    .ok();
                    return true;
                }
            }
        }

        false
    }

    pub fn ensure_admin(&self) {
        let (env_user, env_pass, reset_2fa) = crate::config::Config::read_dotenv_admin();
        let conn = self.db.lock().unwrap();

        let existing_main: Option<(i64, String, String)> = conn
            .query_row(
                "SELECT id, username, password_hash FROM users WHERE id = 1 OR LOWER(username) = LOWER(?) OR role = 'admin' ORDER BY CASE WHEN id = 1 THEN 0 ELSE 1 END, id ASC LIMIT 1",
                params![&env_user],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .ok();

        if let Some((admin_id, current_username, current_hash)) = existing_main {
            let mut updated_session_needed = false;

            if current_username != env_user {
                conn.execute(
                    "UPDATE users SET username = ?, role = 'admin', disabled = 0 WHERE id = ?",
                    params![&env_user, admin_id],
                )
                .ok();
                updated_session_needed = true;
            }

            if current_hash.starts_with("scrypt$") || !verify_password(&env_pass, &current_hash) {
                if let Ok(hashed) = hash_password(&env_pass) {
                    conn.execute(
                        "UPDATE users SET password_hash = ?, role = 'admin', disabled = 0 WHERE id = ?",
                        params![hashed, admin_id],
                    )
                    .ok();
                    updated_session_needed = true;
                }
            }

            if reset_2fa {
                conn.execute(
                    "UPDATE users SET totp_enabled = 0, totp_secret = NULL, totp_pending_secret = NULL, totp_backup_codes = '[]' WHERE id = ?",
                    params![admin_id],
                )
                .ok();
                drop(conn);
                crate::config::Config::sync_dotenv_admin(None, None);
                self.invalidate_sessions();
                return;
            }

            drop(conn);
            if updated_session_needed {
                self.invalidate_sessions();
            }
        } else if let Ok(hashed) = hash_password(&env_pass) {
            let now = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as i64;
            conn.execute(
                "INSERT INTO users(id, username, password_hash, salt, role, disabled, permissions, allowed_projects, created_at) VALUES(1, ?, ?, '', 'admin', 0, '[\"*\"]', '[\"*\"]', ?)",
                params![&env_user, hashed, now],
            )
            .ok();
        }
    }

    pub fn get_user_by_id(&self, id: i64) -> Option<User> {
        let conn = self.db.lock().unwrap();
        conn.query_row(
            "SELECT id, username, role, disabled, permissions, allowed_projects, COALESCE(totp_enabled, 0), created_at FROM users WHERE id = ?",
            params![id],
            |r| {
                Ok(User::from_db(
                    r.get(0)?,
                    r.get(1)?,
                    r.get(2)?,
                    r.get::<_, Option<i64>>(3)?.unwrap_or(0),
                    r.get::<_, Option<String>>(4)?.unwrap_or_else(|| "[\"*\"]".into()),
                    r.get::<_, Option<String>>(5)?.unwrap_or_else(|| "[\"*\"]".into()),
                    r.get::<_, Option<i64>>(6)?.unwrap_or(0),
                    r.get(7)?,
                ))
            },
        )
        .ok()
    }

    pub fn get_user_by_username(&self, username: &str) -> Option<(User, String)> {
        let conn = self.db.lock().unwrap();
        conn.query_row(
            "SELECT id, username, role, disabled, permissions, allowed_projects, COALESCE(totp_enabled, 0), created_at, password_hash FROM users WHERE username = ?",
            params![username],
            |r| {
                Ok((
                    User::from_db(
                        r.get(0)?,
                        r.get(1)?,
                        r.get(2)?,
                        r.get::<_, Option<i64>>(3)?.unwrap_or(0),
                        r.get::<_, Option<String>>(4)?.unwrap_or_else(|| "[\"*\"]".into()),
                        r.get::<_, Option<String>>(5)?.unwrap_or_else(|| "[\"*\"]".into()),
                        r.get::<_, Option<i64>>(6)?.unwrap_or(0),
                        r.get(7)?,
                    ),
                    r.get(8)?,
                ))
            },
        )
        .ok()
    }

    pub fn create_session(&self, user_id: i64) -> Result<Session, rusqlite::Error> {
        let session_id = random_token(32);
        let csrf_token = random_token(24);
        let now_s = Self::now_secs();
        let expires_at = (now_s + self.session_ttl_s) as i64;

        let conn = self.db.lock().unwrap();
        conn.execute(
            "INSERT INTO sessions(id, user_id, expires_at, csrf_token) VALUES(?, ?, ?, ?)",
            params![session_id, user_id, expires_at, csrf_token],
        )?;
        drop(conn);

        Ok(Session {
            id: session_id,
            user_id,
            expires_at,
            csrf_token,
        })
    }

    pub fn get_session(&self, session_id: &str) -> Option<(Session, User)> {
        let now_s = Self::now_secs();

        // Fast-path: check in-memory session cache (30s TTL)
        if let Ok(cache) = self.session_cache.lock() {
            if let Some((sess, usr, cached_until)) = cache.get(session_id) {
                if *cached_until > now_s && sess.expires_at > (now_s as i64) && !usr.disabled {
                    return Some((sess.clone(), usr.clone()));
                }
            }
        }

        let conn = self.db.lock().unwrap();
        let res = conn.query_row(
            "SELECT s.id, s.user_id, s.expires_at, s.csrf_token, u.username, u.role, u.disabled, u.permissions, u.allowed_projects, COALESCE(u.totp_enabled, 0), u.created_at
             FROM sessions s
             JOIN users u ON u.id = s.user_id
             WHERE s.id = ? AND s.expires_at > ?",
            params![session_id, now_s as i64],
            |r| {
                let session = Session {
                    id: r.get(0)?,
                    user_id: r.get(1)?,
                    expires_at: r.get(2)?,
                    csrf_token: r.get(3)?,
                };
                let user = User::from_db(
                    r.get(1)?,
                    r.get(4)?,
                    r.get(5)?,
                    r.get::<_, Option<i64>>(6)?.unwrap_or(0),
                    r.get::<_, Option<String>>(7)?.unwrap_or_else(|| "[\"*\"]".into()),
                    r.get::<_, Option<String>>(8)?.unwrap_or_else(|| "[\"*\"]".into()),
                    r.get::<_, Option<i64>>(9)?.unwrap_or(0),
                    r.get(10)?,
                );
                Ok((session, user))
            },
        );
        drop(conn);

        let valid = res.ok().filter(|(_, u)| !u.disabled)?;
        if let Ok(mut cache) = self.session_cache.lock() {
            if cache.len() > 256 {
                cache.retain(|_, (_, _, exp)| *exp > now_s);
            }
            cache.insert(
                session_id.to_string(),
                (valid.0.clone(), valid.1.clone(), now_s + 30),
            );
        }
        Some(valid)
    }

    pub fn delete_session(&self, session_id: &str) {
        if let Ok(mut cache) = self.session_cache.lock() {
            cache.remove(session_id);
        }
        let conn = self.db.lock().unwrap();
        conn.execute("DELETE FROM sessions WHERE id = ?", params![session_id])
            .ok();
    }

    pub fn revoke_other_sessions(&self, user_id: i64, keep_session_id: &str) -> usize {
        self.invalidate_sessions();
        let conn = self.db.lock().unwrap();
        conn.execute(
            "DELETE FROM sessions WHERE user_id = ? AND id != ?",
            params![user_id, keep_session_id],
        )
        .unwrap_or(0)
    }

    pub fn count_active_sessions(&self, user_id: i64) -> usize {
        let now_s = Self::now_secs() as i64;
        let conn = self.db.lock().unwrap();
        conn.query_row(
            "SELECT COUNT(*) FROM sessions WHERE user_id = ? AND expires_at > ?",
            params![user_id, now_s],
            |r| r.get::<_, i64>(0),
        )
        .unwrap_or(1) as usize
    }

    pub fn purge_expired_sessions(&self) {
        let now_s = Self::now_secs();
        if let Ok(mut cache) = self.session_cache.lock() {
            cache.retain(|_, (_, _, exp)| *exp > now_s);
        }
        let conn = self.db.lock().unwrap();
        conn.execute("DELETE FROM sessions WHERE expires_at <= ?", params![now_s as i64])
            .ok();
    }
}
