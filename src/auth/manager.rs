use rusqlite::params;
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::db::DbPool;
use super::password::{constant_time_eq, hash_password, random_token, verify_password};
use super::session::Session;
use super::totp::{sync_real_utc_offset, verify_totp_code};
use super::user::User;

#[derive(Clone, Default)]
pub(crate) struct FailureRecord {
    pub(crate) count: u32,
    pub(crate) first_at_s: u64,
    pub(crate) locked_until_s: u64,
}

const PRESENCE_TTL_MS: u64 = 95_000;

pub struct Auth {
    pub(crate) db: DbPool,
    pub session_ttl_s: u64,
    pub(crate) mfa_challenges: Mutex<HashMap<String, (i64, u64)>>,
    pub(crate) passkey_challenges: Mutex<HashMap<String, (Option<i64>, String, u64)>>,
    pub(crate) failures: Mutex<HashMap<String, FailureRecord>>,
    pub(crate) session_cache: Mutex<HashMap<String, (Session, User, u64)>>,
    pub(crate) session_presence: Mutex<HashMap<String, (i64, u64, bool)>>,
}


impl Auth {
    pub fn new(db: DbPool, session_ttl_s: u64) -> Self {
        let auth = Self {
            db,
            session_ttl_s,
            mfa_challenges: Mutex::new(HashMap::new()),
            passkey_challenges: Mutex::new(HashMap::new()),
            failures: Mutex::new(HashMap::new()),
            session_cache: Mutex::new(HashMap::new()),
            session_presence: Mutex::new(HashMap::new()),
        };
        auth.ensure_admin();
        std::thread::spawn(|| {
            sync_real_utc_offset();
        });
        auth
    }

    pub(crate) fn now_millis() -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64
    }

    pub fn set_session_presence(&self, session_id: &str, user_id: i64, state_str: &str) {
        let now_ms = Self::now_millis();
        if let Ok(mut map) = self.session_presence.lock() {
            map.retain(|_, (_, seen_ms, _)| now_ms.saturating_sub(*seen_ms) <= PRESENCE_TTL_MS);
            match state_str {
                "offline" => {
                    map.remove(session_id);
                }
                "idle" => {
                    map.insert(session_id.to_string(), (user_id, now_ms, false));
                }
                _ => {
                    map.insert(session_id.to_string(), (user_id, now_ms, true));
                }
            }
        }
    }

    pub fn ensure_session_presence(&self, session_id: &str, user_id: i64) {
        let now_ms = Self::now_millis();
        if let Ok(mut map) = self.session_presence.lock() {
            map.retain(|_, (_, seen_ms, _)| now_ms.saturating_sub(*seen_ms) <= PRESENCE_TTL_MS);
            map.entry(session_id.to_string())
                .or_insert((user_id, now_ms, true));
        }
    }

    pub fn clear_user_presence(&self, user_id: i64) {
        self.invalidate_sessions();
        if let Ok(mut map) = self.session_presence.lock() {
            map.retain(|_, (uid, _, _)| *uid != user_id);
        }
    }

    pub fn presence_for_user(&self, user_id: i64) -> String {
        let now_ms = Self::now_millis();
        if let Ok(mut map) = self.session_presence.lock() {
            map.retain(|_, (_, seen_ms, _)| now_ms.saturating_sub(*seen_ms) <= PRESENCE_TTL_MS);
            let mut has_session = false;
            for &(uid, _, active) in map.values() {
                if uid == user_id {
                    if active {
                        return "online".to_string();
                    }
                    has_session = true;
                }
            }
            if has_session {
                return "idle".to_string();
            }
        }
        "offline".to_string()
    }

    pub fn invalidate_sessions(&self) {
        if let Ok(mut cache) = self.session_cache.lock() {
            cache.clear();
        }
    }

    pub(crate) fn now_secs() -> u64 {
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
        let max_attempts = if key.starts_with("2fa:") || key.starts_with("2fa_user:") {
            3
        } else {
            5
        };
        if entry.count >= max_attempts {
            entry.locked_until_s = now + 600; // 10-minute lockout
            return Some(600);
        }
        None
    }

    pub fn clear_failures(&self, key: &str) {
        let mut map = self.failures.lock().unwrap();
        map.remove(key);
    }

    pub fn create_mfa_challenge(&self, user_id: i64) -> String {
        let now = Self::now_secs();
        let token = random_token(32);
        let mut map = self.mfa_challenges.lock().unwrap();
        // Invalidate any older pending MFA challenges for this user so only the newest challenge is valid
        map.retain(|_, (uid, exp)| *exp > now && *uid != user_id);
        map.insert(token.clone(), (user_id, now + 180)); // valid for 3 minutes
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
                "SELECT id, username, password_hash FROM users WHERE id = 1 OR LOWER(username) = LOWER(?) ORDER BY CASE WHEN id = 1 THEN 0 ELSE 1 END, id ASC LIMIT 1",
                params![&env_user],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .ok();

        if let Some((admin_id, current_username, current_hash)) = existing_main {
            let mut updated_session_needed = false;

            if current_username != env_user {
                conn.execute(
                    "UPDATE users SET username = ?, disabled = 0 WHERE id = ?",
                    params![&env_user, admin_id],
                )
                .ok();
                updated_session_needed = true;
            }

            if current_hash.starts_with("scrypt$") || !verify_password(&env_pass, &current_hash) {
                if let Ok(hashed) = hash_password(&env_pass) {
                    conn.execute(
                        "UPDATE users SET password_hash = ?, disabled = 0 WHERE id = ?",
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
                "INSERT INTO users(id, username, password_hash, disabled, permissions, allowed_projects, created_at) VALUES(1, ?, ?, 0, '[\"*\"]', '[\"*\"]', ?)",
                params![&env_user, hashed, now],
            )
            .ok();
        }
    }

    pub fn get_user_by_id(&self, id: i64) -> Option<User> {
        let conn = self.db.lock().unwrap();
        let mut u = conn
            .query_row(
                "SELECT id, username, disabled, permissions, allowed_projects, COALESCE(totp_enabled, 0), created_at FROM users WHERE id = ?",
                params![id],
                User::from_row,
            )
            .ok()?;
        drop(conn);
        u.presence = if u.disabled {
            "offline".to_string()
        } else {
            self.presence_for_user(u.id)
        };
        Some(u)
    }

    pub fn list_users(&self) -> rusqlite::Result<Vec<User>> {
        let conn = self.db.lock().unwrap();
        let mut stmt = conn.prepare("SELECT id, username, disabled, permissions, allowed_projects, COALESCE(totp_enabled, 0), created_at FROM users ORDER BY id ASC")?;
        let mut list: Vec<User> = stmt.query_map([], User::from_row)?.flatten().collect();
        drop(stmt);
        drop(conn);
        for u in &mut list {
            u.presence = if u.disabled {
                "offline".to_string()
            } else {
                self.presence_for_user(u.id)
            };
        }
        Ok(list)
    }

    pub fn get_user_by_username(&self, username: &str) -> Option<(User, String)> {
        let conn = self.db.lock().unwrap();
        conn.query_row(
            "SELECT id, username, disabled, permissions, allowed_projects, COALESCE(totp_enabled, 0), created_at, password_hash FROM users WHERE LOWER(username) = LOWER(?)",
            params![username],
            |r| Ok((User::from_row(r)?, r.get(7)?)),
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

        self.set_session_presence(&session_id, user_id, "online");

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
                    self.ensure_session_presence(session_id, usr.id);
                    return Some((sess.clone(), usr.clone()));
                }
            }
        }

        let conn = self.db.lock().unwrap();
        let res = conn.query_row(
            "SELECT s.id, s.user_id, s.expires_at, s.csrf_token, u.username, u.disabled, u.permissions, u.allowed_projects, COALESCE(u.totp_enabled, 0), u.created_at
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
                    r.get::<_, Option<i64>>(5)?.unwrap_or(0),
                    r.get::<_, Option<String>>(6)?.unwrap_or_else(|| "[\"*\"]".into()),
                    r.get::<_, Option<String>>(7)?.unwrap_or_else(|| "[\"*\"]".into()),
                    r.get::<_, Option<i64>>(8)?.unwrap_or(0),
                    r.get(9)?,
                );
                Ok((session, user))
            },
        );
        drop(conn);

        let valid = res.ok().filter(|(_, u)| !u.disabled)?;
        self.ensure_session_presence(session_id, valid.1.id);
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
        if let Ok(mut map) = self.session_presence.lock() {
            map.remove(session_id);
        }
        let conn = self.db.lock().unwrap();
        conn.execute("DELETE FROM sessions WHERE id = ?", params![session_id])
            .ok();
    }

    pub fn revoke_other_sessions(&self, user_id: i64, keep_session_id: &str) -> usize {
        self.invalidate_sessions();
        if let Ok(mut map) = self.session_presence.lock() {
            map.retain(|sid, (uid, _, _)| *uid != user_id || sid == keep_session_id);
        }
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

    /// Evict stale in-memory auth state (MFA/WebAuthn challenges, expired failure lockouts,
    /// idle presence heartbeats, and oversized caches) so long-running daemons never leak RAM.
    pub fn prune_in_memory(&self) {
        let now_s = Self::now_secs();
        let now_ms = Self::now_millis();

        if let Ok(mut mfa) = self.mfa_challenges.lock() {
            mfa.retain(|_, (_, exp)| *exp > now_s);
        }
        if let Ok(mut pk) = self.passkey_challenges.lock() {
            pk.retain(|_, (_, _, exp)| *exp > now_s);
        }
        if let Ok(mut fails) = self.failures.lock() {
            fails.retain(|_, rec| {
                rec.locked_until_s > now_s || now_s.saturating_sub(rec.first_at_s) < 900
            });
            if fails.len() > 2048 {
                fails.clear();
            }
        }
        if let Ok(mut cache) = self.session_cache.lock() {
            cache.retain(|_, (_, _, exp)| *exp > now_s);
            if cache.len() > 1024 {
                cache.clear();
            }
        }
        if let Ok(mut presence) = self.session_presence.lock() {
            presence.retain(|_, (_, seen_ms, _)| now_ms.saturating_sub(*seen_ms) < PRESENCE_TTL_MS);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_session_presence_transitions() {
        let temp_dir = std::env::temp_dir().join(format!("webdep-auth-presence-{}", Auth::now_millis()));
        std::fs::create_dir_all(&temp_dir).unwrap();
        let db = crate::db::open_db(&temp_dir).unwrap();
        let auth = Auth::new(db, 3600);

        assert_eq!(auth.presence_for_user(2), "offline");
        auth.set_session_presence("sid-a", 2, "online");
        assert_eq!(auth.presence_for_user(2), "online");

        auth.set_session_presence("sid-b", 2, "idle");
        assert_eq!(auth.presence_for_user(2), "online");

        auth.set_session_presence("sid-a", 2, "idle");
        assert_eq!(auth.presence_for_user(2), "idle");

        auth.set_session_presence("sid-a", 2, "offline");
        assert_eq!(auth.presence_for_user(2), "idle");

        auth.set_session_presence("sid-b", 2, "offline");
        assert_eq!(auth.presence_for_user(2), "offline");

        drop(auth);
        std::fs::remove_dir_all(&temp_dir).ok();
    }
}
