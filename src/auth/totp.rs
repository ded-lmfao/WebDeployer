use rand::RngCore;
use std::time::{SystemTime, UNIX_EPOCH};

use super::password::constant_time_eq;

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

