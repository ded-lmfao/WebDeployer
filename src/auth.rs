use argon2::{
    password_hash::{rand_core::OsRng, PasswordHash, PasswordHasher, PasswordVerifier, SaltString},
    Argon2,
};
use rand::RngCore;
use rusqlite::params;
use serde::{Deserialize, Serialize};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::db::DbPool;

#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct User {
    pub id: i64,
    pub username: String,
    pub role: String,
    pub created_at: i64,
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

pub struct Auth {
    db: DbPool,
    pub session_ttl_s: u64,
}

impl Auth {
    pub fn new(db: DbPool, session_ttl_s: u64) -> Self {
        let auth = Self { db, session_ttl_s };
        auth.ensure_admin();
        auth
    }

    pub fn ensure_admin(&self) {
        let conn = self.db.lock().unwrap();
        let admin_hash: Option<String> = conn
            .query_row(
                "SELECT password_hash FROM users WHERE username = 'admin'",
                [],
                |r| r.get(0),
            )
            .ok();

        if let Some(h) = admin_hash {
            if h.starts_with("scrypt$") {
                if let Ok(hashed) = hash_password("admin123") {
                    conn.execute(
                        "UPDATE users SET password_hash = ? WHERE username = 'admin'",
                        params![hashed],
                    )
                    .ok();
                }
            }
        } else {
            if let Ok(hashed) = hash_password("admin123") {
                let now = SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis() as i64;
                conn.execute(
                    "INSERT INTO users(username, password_hash, salt, role, created_at) VALUES(?, ?, ?, ?, ?)",
                    params!["admin", hashed, "", "admin", now],
                )
                .ok();
            }
        }
    }

    pub fn get_user_by_id(&self, id: i64) -> Option<User> {
        let conn = self.db.lock().unwrap();
        conn.query_row(
            "SELECT id, username, role, created_at FROM users WHERE id = ?",
            params![id],
            |r| {
                Ok(User {
                    id: r.get(0)?,
                    username: r.get(1)?,
                    role: r.get(2)?,
                    created_at: r.get(3)?,
                })
            },
        )
        .ok()
    }

    pub fn get_user_by_username(&self, username: &str) -> Option<(User, String)> {
        let conn = self.db.lock().unwrap();
        conn.query_row(
            "SELECT id, username, role, created_at, password_hash FROM users WHERE username = ?",
            params![username],
            |r| {
                Ok((
                    User {
                        id: r.get(0)?,
                        username: r.get(1)?,
                        role: r.get(2)?,
                        created_at: r.get(3)?,
                    },
                    r.get(4)?,
                ))
            },
        )
        .ok()
    }

    pub fn create_session(&self, user_id: i64) -> Result<Session, rusqlite::Error> {
        let session_id = random_token(32);
        let csrf_token = random_token(24);
        let now_s = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        let expires_at = (now_s + self.session_ttl_s) as i64;

        let conn = self.db.lock().unwrap();
        conn.execute(
            "INSERT INTO sessions(id, user_id, expires_at, csrf_token) VALUES(?, ?, ?, ?)",
            params![session_id, user_id, expires_at, csrf_token],
        )?;

        Ok(Session {
            id: session_id,
            user_id,
            expires_at,
            csrf_token,
        })
    }

    pub fn get_session(&self, session_id: &str) -> Option<(Session, User)> {
        let now_s = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64;

        let conn = self.db.lock().unwrap();
        let res = conn.query_row(
            "SELECT s.id, s.user_id, s.expires_at, s.csrf_token, u.username, u.role, u.created_at
             FROM sessions s
             JOIN users u ON u.id = s.user_id
             WHERE s.id = ? AND s.expires_at > ?",
            params![session_id, now_s],
            |r| {
                let session = Session {
                    id: r.get(0)?,
                    user_id: r.get(1)?,
                    expires_at: r.get(2)?,
                    csrf_token: r.get(3)?,
                };
                let user = User {
                    id: r.get(1)?,
                    username: r.get(4)?,
                    role: r.get(5)?,
                    created_at: r.get(6)?,
                };
                Ok((session, user))
            },
        );

        res.ok()
    }

    pub fn delete_session(&self, session_id: &str) {
        let conn = self.db.lock().unwrap();
        conn.execute("DELETE FROM sessions WHERE id = ?", params![session_id])
            .ok();
    }

    pub fn purge_expired_sessions(&self) {
        let now_s = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64;
        let conn = self.db.lock().unwrap();
        conn.execute("DELETE FROM sessions WHERE expires_at <= ?", params![now_s])
            .ok();
    }
}
