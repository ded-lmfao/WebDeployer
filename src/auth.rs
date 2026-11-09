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

static REAL_TIME_OFFSET_SECS: std::sync::atomic::AtomicI64 = std::sync::atomic::AtomicI64::new(0);
static REAL_TIME_SYNCED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

fn query_ntp_unix_secs(host: &str) -> Option<u64> {
    use std::net::{ToSocketAddrs, UdpSocket};
    let addr = (host, 123).to_socket_addrs().ok()?.next()?;
    let bind_addr = if addr.is_ipv4() { "0.0.0.0:0" } else { "[::]:0" };
    let sock = UdpSocket::bind(bind_addr).ok()?;
    let timeout = std::time::Duration::from_millis(650);
    sock.set_read_timeout(Some(timeout)).ok()?;
    sock.set_write_timeout(Some(timeout)).ok()?;
    let mut req = [0u8; 48];
    req[0] = 0x1B; // LI=0, VN=3, Mode=3 (Client)
    sock.send_to(&req, addr).ok()?;
    let mut resp = [0u8; 48];
    let (n, _) = sock.recv_from(&mut resp).ok()?;
    if n < 48 {
        return None;
    }
    let secs_1900 = u32::from_be_bytes([resp[40], resp[41], resp[42], resp[43]]) as u64;
    if secs_1900 < 2_208_988_800 {
        return None;
    }
    Some(secs_1900 - 2_208_988_800)
}

fn parse_http_date_secs(line: &str) -> Option<u64> {
    // Format: "Date: Sun, 08 Nov 2026 06:58:12 GMT"
    let val = line.splitn(2, ':').nth(1)?.trim();
    let parts: Vec<&str> = val.split_whitespace().collect();
    if parts.len() < 5 {
        return None;
    }
    let day: i64 = parts[1].parse().ok()?;
    let month: i64 = match parts[2] {
        "Jan" => 1,
        "Feb" => 2,
        "Mar" => 3,
        "Apr" => 4,
        "May" => 5,
        "Jun" => 6,
        "Jul" => 7,
        "Aug" => 8,
        "Sep" => 9,
        "Oct" => 10,
        "Nov" => 11,
        "Dec" => 12,
        _ => return None,
    };
    let year: i64 = parts[3].parse().ok()?;
    let mut hms = parts[4].split(':');
    let hour: i64 = hms.next()?.parse().ok()?;
    let min: i64 = hms.next()?.parse().ok()?;
    let sec: i64 = hms.next()?.parse().ok()?;

    // Howard Hinnant civil-to-days since 1970-01-01
    let y = year - if month <= 2 { 1 } else { 0 };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = month + if month > 2 { -3 } else { 9 };
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146097 + doe - 719468;
    if days < 0 {
        return None;
    }
    Some((days as u64) * 86400 + (hour as u64) * 3600 + (min as u64) * 60 + (sec as u64))
}

fn query_http_date_unix_secs(host: &str) -> Option<u64> {
    use std::io::{Read, Write};
    use std::net::{TcpStream, ToSocketAddrs};
    let addr = (host, 80).to_socket_addrs().ok()?.next()?;
    let timeout = std::time::Duration::from_millis(750);
    let mut stream = TcpStream::connect_timeout(&addr, timeout).ok()?;
    stream.set_read_timeout(Some(timeout)).ok()?;
    stream.set_write_timeout(Some(timeout)).ok()?;
    let req = format!("HEAD / HTTP/1.1\r\nHost: {}\r\nConnection: close\r\n\r\n", host);
    stream.write_all(req.as_bytes()).ok()?;
    let mut buf = [0u8; 1024];
    let n = stream.read(&mut buf).ok()?;
    let text = String::from_utf8_lossy(&buf[..n]);
    for line in text.lines() {
        if line.len() > 6 && line[..5].eq_ignore_ascii_case("date:") {
            if let Some(ts) = parse_http_date_secs(line) {
                return Some(ts);
            }
        }
    }
    None
}

pub fn sync_real_utc_offset() {
    use std::sync::atomic::Ordering;
    let real_opt = query_ntp_unix_secs("time.google.com")
        .or_else(|| query_ntp_unix_secs("time.cloudflare.com"))
        .or_else(|| query_ntp_unix_secs("time.windows.com"))
        .or_else(|| query_http_date_unix_secs("1.1.1.1"))
        .or_else(|| query_http_date_unix_secs("www.google.com"));

    if let Some(real_s) = real_opt {
        let local_s = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        let offset = (real_s as i64) - (local_s as i64);
        REAL_TIME_OFFSET_SECS.store(offset, Ordering::Relaxed);
        REAL_TIME_SYNCED.store(true, Ordering::Relaxed);
    }
}

pub fn verify_totp_code(secret_b32: &str, code: &str) -> bool {
    use std::sync::atomic::Ordering;
    let clean: String = code.chars().filter(|c| c.is_ascii_digit()).collect();
    if clean.len() != 6 {
        return false;
    }
    if !REAL_TIME_SYNCED.load(Ordering::Relaxed) {
        sync_real_utc_offset();
    }
    let local_now_s = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();

    let offset_s = REAL_TIME_OFFSET_SECS.load(Ordering::Relaxed);
    let real_now_s = (local_now_s as i64).saturating_add(offset_s).max(0) as u64;

    // Check both real-world UTC time (synced via NTP/HTTP for phones on network time)
    // and local machine clock (with ±2 steps = ±60s drift window)
    let mut candidate_steps = Vec::with_capacity(12);
    let real_step = (real_now_s / 30) as i64;
    let local_step = (local_now_s / 30) as i64;
    for delta in [-2i64, -1, 0, 1, 2] {
        candidate_steps.push((real_step + delta) as u64);
        if (real_step - local_step).abs() > 2 {
            candidate_steps.push((local_step + delta) as u64);
        }
    }

    for counter in candidate_steps {
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
    passkey_challenges: Mutex<HashMap<String, (Option<i64>, String, u64)>>,
    failures: Mutex<HashMap<String, FailureRecord>>,
    session_cache: Mutex<HashMap<String, (Session, User, u64)>>,
}

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
    pub fn new(db: DbPool, session_ttl_s: u64) -> Self {
        let auth = Self {
            db,
            session_ttl_s,
            mfa_challenges: Mutex::new(HashMap::new()),
            passkey_challenges: Mutex::new(HashMap::new()),
            failures: Mutex::new(HashMap::new()),
            session_cache: Mutex::new(HashMap::new()),
        };
        auth.ensure_admin();
        std::thread::spawn(|| {
            sync_real_utc_offset();
        });
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
            "SELECT id, username, role, disabled, permissions, allowed_projects, COALESCE(totp_enabled, 0), created_at, password_hash FROM users WHERE LOWER(username) = LOWER(?)",
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

// ===========================================================================
// Base64URL & Pure-Rust NIST P-256 (secp256r1 / ES256) WebAuthn Verifier
// ===========================================================================
pub fn b64url_encode(data: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(data)
}

pub fn b64url_decode(input: &str) -> Option<Vec<u8>> {
    use base64::Engine;
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return None;
    }
    let mut norm: String = trimmed
        .chars()
        .filter(|c| !c.is_whitespace() && *c != '=')
        .map(|c| match c {
            '+' => '-',
            '/' => '_',
            other => other,
        })
        .collect();
    base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(&norm)
        .ok()
        .or_else(|| {
            while norm.len() % 4 != 0 {
                norm.push('=');
            }
            base64::engine::general_purpose::URL_SAFE.decode(&norm).ok()
        })
}

pub fn extract_p256_pubkey(raw: &[u8]) -> Option<[u8; 65]> {
    if raw.len() == 65 && raw[0] == 0x04 {
        let mut out = [0u8; 65];
        out.copy_from_slice(raw);
        if is_valid_p256_point(&out) {
            return Some(out);
        }
    }
    if raw.len() >= 66 {
        let tail = &raw[raw.len() - 65..];
        if tail[0] == 0x04 {
            let mut out = [0u8; 65];
            out.copy_from_slice(tail);
            if is_valid_p256_point(&out) {
                return Some(out);
            }
        }
    }
    let mut x_opt: Option<[u8; 32]> = None;
    let mut y_opt: Option<[u8; 32]> = None;
    if raw.len() >= 70 {
        for i in 0..raw.len().saturating_sub(35) {
            if raw[i] == 0x21 && raw[i + 1] == 0x58 && raw[i + 2] == 0x20 {
                let mut x = [0u8; 32];
                x.copy_from_slice(&raw[i + 3..i + 35]);
                x_opt = Some(x);
            } else if raw[i] == 0x22 && raw[i + 1] == 0x58 && raw[i + 2] == 0x20 {
                let mut y = [0u8; 32];
                y.copy_from_slice(&raw[i + 3..i + 35]);
                y_opt = Some(y);
            }
            if let (Some(x), Some(y)) = (x_opt, y_opt) {
                let mut cand = [0u8; 65];
                cand[0] = 0x04;
                cand[1..33].copy_from_slice(&x);
                cand[33..65].copy_from_slice(&y);
                if is_valid_p256_point(&cand) {
                    return Some(cand);
                }
            }
        }
    }
    None
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
struct U256([u64; 4]);

const P256_ZERO: U256 = U256([0, 0, 0, 0]);
const P256_ONE: U256 = U256([1, 0, 0, 0]);

const P256_P: U256 = U256([
    0xFFFFFFFFFFFFFFFF,
    0x00000000FFFFFFFF,
    0x0000000000000000,
    0xFFFFFFFF00000001,
]);

const P256_N: U256 = U256([
    0xF3B9CAC2FC632551,
    0xBCE6FAADA7179E84,
    0xFFFFFFFFFFFFFFFF,
    0xFFFFFFFF00000000,
]);

const P256_B: U256 = U256([
    0x3BCE3C3E27D2604B,
    0x651D06B0CC53B0F6,
    0xB3EBBD55769886BC,
    0x5AC635D8AA3A93E7,
]);

const P256_GX: U256 = U256([
    0xF4A13945D898C296,
    0x77037D812DEB33A0,
    0xF8BCE6E563A440F2,
    0x6B17D1F2E12C4247,
]);

const P256_GY: U256 = U256([
    0xCBB6406837BF51F5,
    0x2BCE33576B315ECE,
    0x8EE7EB4A7C0F9E16,
    0x4FE342E2FE1A7F9B,
]);

impl U256 {
    fn from_be_bytes(b: &[u8; 32]) -> Self {
        let l3 = u64::from_be_bytes([b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7]]);
        let l2 = u64::from_be_bytes([b[8], b[9], b[10], b[11], b[12], b[13], b[14], b[15]]);
        let l1 = u64::from_be_bytes([b[16], b[17], b[18], b[19], b[20], b[21], b[22], b[23]]);
        let l0 = u64::from_be_bytes([b[24], b[25], b[26], b[27], b[28], b[29], b[30], b[31]]);
        Self([l0, l1, l2, l3])
    }

    fn is_zero(&self) -> bool {
        (self.0[0] | self.0[1] | self.0[2] | self.0[3]) == 0
    }

    fn bit(&self, idx: usize) -> bool {
        let word = idx / 64;
        let bit = idx % 64;
        if word >= 4 {
            false
        } else {
            ((self.0[word] >> bit) & 1) == 1
        }
    }

    fn ge(&self, other: &Self) -> bool {
        for i in (0..4).rev() {
            if self.0[i] > other.0[i] {
                return true;
            }
            if self.0[i] < other.0[i] {
                return false;
            }
        }
        true
    }

    fn add_raw(&self, other: &Self) -> (Self, u64) {
        let mut out = [0u64; 4];
        let mut carry = 0u128;
        for i in 0..4 {
            let sum = (self.0[i] as u128) + (other.0[i] as u128) + carry;
            out[i] = sum as u64;
            carry = sum >> 64;
        }
        (Self(out), carry as u64)
    }

    fn sub_raw(&self, other: &Self) -> (Self, u64) {
        let mut out = [0u64; 4];
        let mut borrow = 0u128;
        for i in 0..4 {
            let a = self.0[i] as u128;
            let b = (other.0[i] as u128) + borrow;
            if a >= b {
                out[i] = (a - b) as u64;
                borrow = 0;
            } else {
                out[i] = ((1u128 << 64) + a - b) as u64;
                borrow = 1;
            }
        }
        (Self(out), borrow as u64)
    }

    fn rem_mod(&self, m: &Self) -> Self {
        let mut cur = *self;
        while cur.ge(m) {
            cur = cur.sub_raw(m).0;
        }
        cur
    }

    fn add_mod(&self, other: &Self, m: &Self) -> Self {
        let (sum, carry) = self.add_raw(other);
        if carry > 0 || sum.ge(m) {
            sum.sub_raw(m).0
        } else {
            sum
        }
    }

    fn sub_mod(&self, other: &Self, m: &Self) -> Self {
        if self.ge(other) {
            self.sub_raw(other).0
        } else {
            let diff = other.sub_raw(self).0;
            m.sub_raw(&diff).0
        }
    }

    fn mul_mod(&self, other: &Self, m: &Self) -> Self {
        let mut acc = P256_ZERO;
        let a = self.rem_mod(m);
        for i in (0..256).rev() {
            acc = acc.add_mod(&acc, m);
            if other.bit(i) {
                acc = acc.add_mod(&a, m);
            }
        }
        acc
    }

    fn pow_mod(&self, exp: &Self, m: &Self) -> Self {
        let mut res = P256_ONE;
        let base = self.rem_mod(m);
        for i in (0..256).rev() {
            res = res.mul_mod(&res, m);
            if exp.bit(i) {
                res = res.mul_mod(&base, m);
            }
        }
        res
    }

    fn inv_mod(&self, m: &Self) -> Option<Self> {
        if self.is_zero() {
            return None;
        }
        let two = U256([2, 0, 0, 0]);
        let exp = m.sub_raw(&two).0;
        Some(self.pow_mod(&exp, m))
    }
}

#[derive(Clone, Copy, Debug)]
struct P256Point {
    x: U256,
    y: U256,
    infinity: bool,
}

impl P256Point {
    fn infinity() -> Self {
        Self {
            x: P256_ZERO,
            y: P256_ZERO,
            infinity: true,
        }
    }

    fn generator() -> Self {
        Self {
            x: P256_GX,
            y: P256_GY,
            infinity: false,
        }
    }

    fn add(&self, other: &Self) -> Self {
        if self.infinity {
            return *other;
        }
        if other.infinity {
            return *self;
        }
        let p = &P256_P;
        if self.x == other.x {
            if self.y != other.y || self.y.is_zero() {
                return Self::infinity();
            }
            let x_sq = self.x.mul_mod(&self.x, p);
            let three = U256([3, 0, 0, 0]);
            let num = three.mul_mod(&x_sq, p).sub_mod(&three, p);
            let den = self.y.add_mod(&self.y, p);
            let Some(den_inv) = den.inv_mod(p) else {
                return Self::infinity();
            };
            let lambda = num.mul_mod(&den_inv, p);
            let rx = lambda
                .mul_mod(&lambda, p)
                .sub_mod(&self.x, p)
                .sub_mod(&other.x, p);
            let ry = lambda
                .mul_mod(&self.x.sub_mod(&rx, p), p)
                .sub_mod(&self.y, p);
            Self {
                x: rx,
                y: ry,
                infinity: false,
            }
        } else {
            let num = other.y.sub_mod(&self.y, p);
            let den = other.x.sub_mod(&self.x, p);
            let Some(den_inv) = den.inv_mod(p) else {
                return Self::infinity();
            };
            let lambda = num.mul_mod(&den_inv, p);
            let rx = lambda
                .mul_mod(&lambda, p)
                .sub_mod(&self.x, p)
                .sub_mod(&other.x, p);
            let ry = lambda
                .mul_mod(&self.x.sub_mod(&rx, p), p)
                .sub_mod(&self.y, p);
            Self {
                x: rx,
                y: ry,
                infinity: false,
            }
        }
    }

    fn scalar_mul(&self, k: &U256) -> Self {
        let mut acc = Self::infinity();
        for i in (0..256).rev() {
            acc = acc.add(&acc);
            if k.bit(i) {
                acc = acc.add(self);
            }
        }
        acc
    }
}

pub fn is_valid_p256_point(uncompressed: &[u8]) -> bool {
    if uncompressed.len() != 65 || uncompressed[0] != 0x04 {
        return false;
    }
    let mut xb = [0u8; 32];
    let mut yb = [0u8; 32];
    xb.copy_from_slice(&uncompressed[1..33]);
    yb.copy_from_slice(&uncompressed[33..65]);
    let x = U256::from_be_bytes(&xb);
    let y = U256::from_be_bytes(&yb);
    if x.ge(&P256_P) || y.ge(&P256_P) || (x.is_zero() && y.is_zero()) {
        return false;
    }
    let p = &P256_P;
    let lhs = y.mul_mod(&y, p);
    let x2 = x.mul_mod(&x, p);
    let x3 = x2.mul_mod(&x, p);
    let three_x = x.add_mod(&x, p).add_mod(&x, p);
    let rhs = x3.sub_mod(&three_x, p).add_mod(&P256_B, p);
    lhs == rhs
}

fn parse_ecdsa_sig_rs(sig: &[u8]) -> Option<(U256, U256)> {
    if sig.len() == 64 {
        let mut rb = [0u8; 32];
        let mut sb = [0u8; 32];
        rb.copy_from_slice(&sig[0..32]);
        sb.copy_from_slice(&sig[32..64]);
        return Some((U256::from_be_bytes(&rb), U256::from_be_bytes(&sb)));
    }
    if sig.len() < 8 || sig[0] != 0x30 {
        return None;
    }
    let mut idx = 1;
    let _seq_len = if (sig[idx] & 0x80) == 0 {
        let l = sig[idx] as usize;
        idx += 1;
        l
    } else {
        let nbytes = (sig[idx] & 0x7f) as usize;
        if nbytes == 0 || nbytes > 2 || idx + nbytes >= sig.len() {
            return None;
        }
        idx += 1 + nbytes;
        0
    };

    let read_int = |pos: &mut usize| -> Option<U256> {
        if *pos + 2 > sig.len() || sig[*pos] != 0x02 {
            return None;
        }
        let len = sig[*pos + 1] as usize;
        *pos += 2;
        if *pos + len > sig.len() || len == 0 {
            return None;
        }
        let mut slice = &sig[*pos..*pos + len];
        *pos += len;
        while slice.len() > 1 && slice[0] == 0x00 {
            slice = &slice[1..];
        }
        if slice.len() > 32 {
            return None;
        }
        let mut buf = [0u8; 32];
        buf[32 - slice.len()..].copy_from_slice(slice);
        Some(U256::from_be_bytes(&buf))
    };

    let r = read_int(&mut idx)?;
    let s = read_int(&mut idx)?;
    Some((r, s))
}

pub fn verify_p256_ecdsa(pub_key_uncompressed: &[u8], msg_hash: &[u8; 32], sig: &[u8]) -> bool {
    if !is_valid_p256_point(pub_key_uncompressed) {
        return false;
    }
    let Some((r, s)) = parse_ecdsa_sig_rs(sig) else {
        return false;
    };
    let n = &P256_N;
    if r.is_zero() || r.ge(n) || s.is_zero() || s.ge(n) {
        return false;
    }
    let mut xb = [0u8; 32];
    let mut yb = [0u8; 32];
    xb.copy_from_slice(&pub_key_uncompressed[1..33]);
    yb.copy_from_slice(&pub_key_uncompressed[33..65]);
    let q = P256Point {
        x: U256::from_be_bytes(&xb),
        y: U256::from_be_bytes(&yb),
        infinity: false,
    };

    let z = U256::from_be_bytes(msg_hash).rem_mod(n);
    let Some(w) = s.inv_mod(n) else {
        return false;
    };
    let u1 = z.mul_mod(&w, n);
    let u2 = r.mul_mod(&w, n);

    let g = P256Point::generator();
    let p1 = g.scalar_mul(&u1);
    let p2 = q.scalar_mul(&u2);
    let pt = p1.add(&p2);
    if pt.infinity {
        return false;
    }
    let v = pt.x.rem_mod(n);
    v == r
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_p256_generator_and_ecdsa_verification() {
        let mut g_bytes = [0u8; 65];
        g_bytes[0] = 0x04;
        g_bytes[1..33].copy_from_slice(
            &hex::decode("6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296")
                .unwrap(),
        );
        g_bytes[33..65].copy_from_slice(
            &hex::decode("4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5")
                .unwrap(),
        );
        assert!(is_valid_p256_point(&g_bytes));

        let mut q_bytes = [0u8; 65];
        q_bytes[0] = 0x04;
        q_bytes[1..33].copy_from_slice(
            &hex::decode("60FED4BA255A9D31C961EB74C6356D68C049B8923B61FA6CE669622E60F29FB6")
                .unwrap(),
        );
        q_bytes[33..65].copy_from_slice(
            &hex::decode("7903FE1008B8BC99A41AE9E95628BC64F2F1B20C2D7E9F5177A3C294D4462299")
                .unwrap(),
        );
        assert!(is_valid_p256_point(&q_bytes));

        use sha2::{Digest, Sha256};
        let digest = Sha256::digest(b"sample");
        let mut msg_hash = [0u8; 32];
        msg_hash.copy_from_slice(&digest);

        let raw_sig = hex::decode(
            "EFD48B2AACB6A8FD1140DD9CD45E81D69D2C877B56AAF991C34D0EA84EAF3716\
             F7CB1C942D657C41D436C7A1B6E29F65F3E900DBB9AFF4064DC4AB2F843ACDA8",
        )
        .unwrap();
        assert!(verify_p256_ecdsa(&q_bytes, &msg_hash, &raw_sig));

        let mut bad_sig = raw_sig.clone();
        bad_sig[10] ^= 0x01;
        assert!(!verify_p256_ecdsa(&q_bytes, &msg_hash, &bad_sig));
    }
}
