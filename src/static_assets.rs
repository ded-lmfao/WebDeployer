use axum::{
    body::{Body, Bytes},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
};
use rust_embed::RustEmbed;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

#[derive(RustEmbed)]
#[folder = "public/"]
pub struct Assets;

static ETAG_CACHE: OnceLock<HashMap<String, String>> = OnceLock::new();

struct DiskCacheEntry {
    mtime: std::time::SystemTime,
    etag: String,
    data: Bytes,
}

static DISK_ASSET_CACHE: OnceLock<std::sync::RwLock<HashMap<String, DiskCacheEntry>>> = OnceLock::new();

fn get_disk_cache() -> &'static std::sync::RwLock<HashMap<String, DiskCacheEntry>> {
    DISK_ASSET_CACHE.get_or_init(|| std::sync::RwLock::new(HashMap::new()))
}

fn get_etag_map() -> &'static HashMap<String, String> {
    ETAG_CACHE.get_or_init(|| {
        let mut map = HashMap::new();
        for file in Assets::iter() {
            let key = file.as_ref().to_string();
            if let Some(content) = Assets::get(&key) {
                let hash = hex::encode(content.metadata.sha256_hash());
                map.insert(key, format!("W/\"{}\"", &hash[..16]));
            }
        }
        map
    })
}

fn get_mime(path: &str) -> &'static str {
    if path.ends_with(".html") {
        "text/html; charset=utf-8"
    } else if path.ends_with(".css") {
        "text/css; charset=utf-8"
    } else if path.ends_with(".js") {
        "application/javascript; charset=utf-8"
    } else if path.ends_with(".json") {
        "application/json"
    } else if path.ends_with(".svg") {
        "image/svg+xml"
    } else if path.ends_with(".png") {
        "image/png"
    } else if path.ends_with(".ico") {
        "image/x-icon"
    } else {
        "application/octet-stream"
    }
}

/// Locate a static asset directly on the local filesystem if available.
/// Prevents directory traversal and symlink escape, supporting both cwd and exe directory.
fn find_disk_file(clean_path: &str) -> Option<PathBuf> {
    if clean_path.contains("..")
        || clean_path.contains('\\')
        || clean_path.contains(':')
        || clean_path.contains('\0')
        || clean_path.starts_with('/')
    {
        return None;
    }

    let check_base = |base: &Path| -> Option<PathBuf> {
        let candidate = base.join(clean_path);
        let canon_base = std::fs::canonicalize(base).ok()?;
        let canon_cand = std::fs::canonicalize(&candidate).ok()?;
        if canon_cand.starts_with(&canon_base) && canon_cand.is_file() {
            Some(canon_cand)
        } else {
            None
        }
    };

    // 1. Check local ./public/ folder in current working directory
    if let Some(found) = check_base(Path::new("public")) {
        return Some(found);
    }

    // 2. Check ./public/ next to the executable binary
    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(parent) = exe_path.parent() {
            if let Some(found) = check_base(&parent.join("public")) {
                return Some(found);
            }
        }
    }

    None
}

/// Resolves `@import './css/...'` directives in `style.css` into a single combined stylesheet
/// to eliminate a 12-request CSS waterfall on initial page load while preserving modular source files.
fn bundle_css_imports_from_disk(style_path: &Path, raw: &[u8]) -> Vec<u8> {
    let Ok(text) = std::str::from_utf8(raw) else {
        return raw.to_vec();
    };
    let parent = style_path.parent().unwrap_or_else(|| Path::new("public"));
    let mut out = String::with_capacity(72 * 1024);
    for line in text.lines() {
        let trimmed = line.trim();
        if let Some(rest) = trimmed.strip_prefix("@import ") {
            let rel = rest
                .trim_end_matches(';')
                .trim()
                .trim_matches('\'')
                .trim_matches('"')
                .trim_start_matches("./");
            if !rel.contains("..") {
                let target = parent.join(rel);
                if let Ok(sub) = std::fs::read_to_string(&target) {
                    out.push_str(&sub);
                    out.push('\n');
                    continue;
                }
            }
        }
        out.push_str(line);
        out.push('\n');
    }
    out.into_bytes()
}

fn bundle_css_imports_embedded(raw: &[u8]) -> Vec<u8> {
    let Ok(text) = std::str::from_utf8(raw) else {
        return raw.to_vec();
    };
    let mut out = String::with_capacity(72 * 1024);
    for line in text.lines() {
        let trimmed = line.trim();
        if let Some(rest) = trimmed.strip_prefix("@import ") {
            let rel = rest
                .trim_end_matches(';')
                .trim()
                .trim_matches('\'')
                .trim_matches('"')
                .trim_start_matches("./");
            if let Some(sub) = Assets::get(rel) {
                if let Ok(sub_str) = std::str::from_utf8(&sub.data) {
                    out.push_str(sub_str);
                    out.push('\n');
                    continue;
                }
            }
        }
        out.push_str(line);
        out.push('\n');
    }
    out.into_bytes()
}

pub async fn static_handler(path: &str, req_headers: &HeaderMap, query: Option<&str>) -> Response {
    let clean_path = if path.is_empty() || path == "/" {
        "index.html"
    } else {
        path.trim_start_matches('/')
    };

    let is_html = clean_path.ends_with(".html");
    let is_vendor = clean_path.starts_with("vendor/");
    let has_version_query = query.map(|q| q.contains("v=")).unwrap_or(false);

    let cache_control = if is_html {
        "no-cache, must-revalidate, private"
    } else if has_version_query {
        "public, max-age=31536000, immutable"
    } else if is_vendor {
        "public, max-age=604800, stale-while-revalidate=86400"
    } else {
        "no-cache, must-revalidate, private"
    };

    // FAST-PATH: If the file exists directly on disk in ./public, serve with RAM-backed cache & 304 ETag verification!
    // This provides 0ms responses, automatic live hot-reload on save, and 0 bytes 304 Not Modified!
    if let Some(disk_path) = find_disk_file(clean_path) {
        if let Ok(meta) = tokio::fs::metadata(&disk_path).await {
            let mut mtime = meta.modified().unwrap_or(std::time::SystemTime::UNIX_EPOCH);
            if clean_path == "style.css" {
                if let Some(parent) = disk_path.parent() {
                    if let Ok(entries) = std::fs::read_dir(parent.join("css")) {
                        for entry in entries.flatten() {
                            if let Ok(m) = entry.metadata().and_then(|m| m.modified()) {
                                if m > mtime {
                                    mtime = m;
                                }
                            }
                        }
                    }
                }
            }
            let cache_lock = get_disk_cache();

            let cached = {
                let r = cache_lock.read().ok();
                r.and_then(|map| {
                    if let Some(entry) = map.get(clean_path) {
                        if entry.mtime == mtime {
                            return Some((entry.etag.clone(), entry.data.clone()));
                        }
                    }
                    None
                })
            };

            let (etag, data, is_ram_hit) = if let Some((etag, data)) = cached {
                (etag, data, true)
            } else if let Ok(raw_data) = tokio::fs::read(&disk_path).await {
                let final_vec = if clean_path == "style.css" {
                    bundle_css_imports_from_disk(&disk_path, &raw_data)
                } else {
                    raw_data
                };
                let data = Bytes::from(final_vec);
                let mtime_secs = mtime
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_millis())
                    .unwrap_or(0);
                let etag = format!("W/\"{:x}-{:x}\"", mtime_secs, data.len());
                if let Ok(mut w) = cache_lock.write() {
                    w.insert(
                        clean_path.to_string(),
                        DiskCacheEntry {
                            mtime,
                            etag: etag.clone(),
                            data: data.clone(),
                        },
                    );
                }
                (etag, data, false)
            } else {
                return (StatusCode::NOT_FOUND, "Not Found").into_response();
            };

            // Check client ETag for instant 304 Not Modified
            if let Some(if_none_match) = req_headers.get(header::IF_NONE_MATCH).and_then(|v| v.to_str().ok()) {
                if if_none_match.trim() == etag || if_none_match.contains(&etag) {
                    return Response::builder()
                        .status(StatusCode::NOT_MODIFIED)
                        .header(header::ETAG, HeaderValue::from_str(&etag).unwrap_or_else(|_| HeaderValue::from_static("")))
                        .header(header::CACHE_CONTROL, HeaderValue::from_static(cache_control))
                        .header("x-cache", HeaderValue::from_static("DISK-304"))
                        .body(Body::empty())
                        .unwrap_or_else(|_| StatusCode::NOT_MODIFIED.into_response());
                }
            }

            let mime = get_mime(clean_path);
            let cache_status = if is_ram_hit { "DISK-RAM-HIT" } else { "DISK-LIVE" };
            return Response::builder()
                .status(StatusCode::OK)
                .header(header::CONTENT_TYPE, HeaderValue::from_static(mime))
                .header(header::ETAG, HeaderValue::from_str(&etag).unwrap_or_else(|_| HeaderValue::from_static("")))
                .header(header::CACHE_CONTROL, HeaderValue::from_static(cache_control))
                .header("x-cache", HeaderValue::from_static(cache_status))
                .body(Body::from(data))
                .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response());
        }
    }

    // FALLBACK: When running as a standalone binary where ./public is not present on disk
    let is_html = clean_path.ends_with(".html");
    let is_vendor = clean_path.starts_with("vendor/");
    let has_version_query = query.map(|q| q.contains("v=")).unwrap_or(false);
    let cache_control = if is_html {
        "no-store, no-cache, must-revalidate, private"
    } else if has_version_query {
        "public, max-age=31536000, immutable"
    } else if is_vendor {
        "public, max-age=604800, stale-while-revalidate=86400"
    } else {
        "no-cache, must-revalidate, private"
    };

    let etag_map = get_etag_map();
    if !is_html {
        if let Some(etag) = etag_map.get(clean_path) {
            if let Some(if_none_match) = req_headers.get(header::IF_NONE_MATCH).and_then(|v| v.to_str().ok()) {
                if if_none_match.trim() == etag || if_none_match.contains(etag) {
                    return Response::builder()
                        .status(StatusCode::NOT_MODIFIED)
                        .header(header::ETAG, HeaderValue::from_str(etag).unwrap_or_else(|_| HeaderValue::from_static("")))
                        .header(header::CACHE_CONTROL, HeaderValue::from_static(cache_control))
                        .header("x-cache", HeaderValue::from_static("HIT-304"))
                        .body(Body::empty())
                        .unwrap_or_else(|_| StatusCode::NOT_MODIFIED.into_response());
                }
            }
        }
    }

    match Assets::get(clean_path) {
        Some(content) => {
            let mime = get_mime(clean_path);
            let etag = etag_map
                .get(clean_path)
                .cloned()
                .unwrap_or_else(|| {
                    let hash = hex::encode(content.metadata.sha256_hash());
                    format!("W/\"{}\"", &hash[..16])
                });
            let body = if clean_path == "style.css" {
                Body::from(bundle_css_imports_embedded(&content.data))
            } else {
                Body::from(content.data)
            };

            Response::builder()
                .status(StatusCode::OK)
                .header(header::CONTENT_TYPE, HeaderValue::from_static(mime))
                .header(header::ETAG, HeaderValue::from_str(&etag).unwrap())
                .header(header::CACHE_CONTROL, HeaderValue::from_static(cache_control))
                .header("x-cache", HeaderValue::from_static("MEMORY-EMBED"))
                .body(body)
                .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
        }
        None => (StatusCode::NOT_FOUND, "404 Not Found").into_response(),
    }
}
