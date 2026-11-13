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
static BUNDLED_EMBEDDED_CSS: OnceLock<(Bytes, String)> = OnceLock::new();
static DISK_PUBLIC_ROOTS: OnceLock<Vec<PathBuf>> = OnceLock::new();

struct DiskCacheEntry {
    mtime: std::time::SystemTime,
    etag: String,
    data: Bytes,
}

static DISK_ASSET_CACHE: OnceLock<std::sync::RwLock<HashMap<String, DiskCacheEntry>>> = OnceLock::new();

fn get_disk_cache() -> &'static std::sync::RwLock<HashMap<String, DiskCacheEntry>> {
    DISK_ASSET_CACHE.get_or_init(|| std::sync::RwLock::new(HashMap::new()))
}

fn get_disk_public_roots() -> &'static [PathBuf] {
    DISK_PUBLIC_ROOTS
        .get_or_init(|| {
            let mut roots = Vec::with_capacity(2);
            if let Ok(canon) = std::fs::canonicalize(Path::new("public")) {
                roots.push(canon);
            }
            if let Ok(exe_path) = std::env::current_exe() {
                if let Some(parent) = exe_path.parent() {
                    if let Ok(canon) = std::fs::canonicalize(parent.join("public")) {
                        if !roots.contains(&canon) {
                            roots.push(canon);
                        }
                    }
                }
            }
            roots
        })
        .as_slice()
}

fn fnv1a_hex(data: &[u8]) -> String {
    let mut hash: u64 = 0xcbf29ce484222325;
    for &b in data {
        hash ^= b as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{:016x}", hash)
}

fn get_bundled_embedded_css() -> Option<&'static (Bytes, String)> {
    if BUNDLED_EMBEDDED_CSS.get().is_none() {
        let content = Assets::get("style.css")?;
        let bundled = Bytes::from(bundle_css_imports(&content.data, |rel| {
            Assets::get(rel).and_then(|sub| std::str::from_utf8(&sub.data).ok().map(str::to_owned))
        }));
        let base_hash = hex::encode(content.metadata.sha256_hash());
        let etag = format!("W/\"{}-{}\"", &base_hash[..8], fnv1a_hex(&bundled));
        let _ = BUNDLED_EMBEDDED_CSS.set((bundled, etag));
    }
    BUNDLED_EMBEDDED_CSS.get()
}

fn get_etag_map() -> &'static HashMap<String, String> {
    ETAG_CACHE.get_or_init(|| {
        let mut map = HashMap::new();
        for file in Assets::iter() {
            let key = file.as_ref().to_string();
            if key == "style.css" {
                if let Some((_, bundled_etag)) = get_bundled_embedded_css() {
                    map.insert(key, bundled_etag.clone());
                    continue;
                }
            }
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

/// Locate a static asset on disk and compute its effective modification timestamp in a single
/// blocking I/O step while enforcing directory confinement and symlink escape protection.
async fn resolve_disk_asset(clean_path: &str) -> Option<(PathBuf, std::time::SystemTime)> {
    if clean_path.contains("..")
        || clean_path.contains('\\')
        || clean_path.contains(':')
        || clean_path.contains('\0')
        || clean_path.starts_with('/')
    {
        return None;
    }

    let roots = get_disk_public_roots();
    if roots.is_empty() {
        return None;
    }

    let rel = clean_path.to_string();
    tokio::task::spawn_blocking(move || {
        for canon_base in roots {
            let candidate = canon_base.join(&rel);
            if let Ok(canon_cand) = std::fs::canonicalize(&candidate) {
                if canon_cand.starts_with(canon_base) {
                    if let Ok(meta) = std::fs::metadata(&canon_cand) {
                        if meta.is_file() {
                            let mut mtime = meta.modified().unwrap_or(std::time::SystemTime::UNIX_EPOCH);
                            if rel == "style.css" {
                                if let Some(parent) = canon_cand.parent() {
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
                            return Some((canon_cand, mtime));
                        }
                    }
                }
            }
        }
        None
    })
    .await
    .ok()
    .flatten()
}

/// Resolves `@import './css/...'` directives in `style.css` into a single combined stylesheet
/// to eliminate a 12-request CSS waterfall on initial page load while preserving modular source files.
fn bundle_css_imports<F: FnMut(&str) -> Option<String>>(raw: &[u8], mut resolve: F) -> Vec<u8> {
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
            if !rel.contains("..") {
                if let Some(sub) = resolve(rel) {
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

fn bundle_css_imports_from_disk(style_path: &Path, raw: &[u8]) -> Vec<u8> {
    let parent = style_path.parent().unwrap_or_else(|| Path::new("public"));
    bundle_css_imports(raw, |rel| std::fs::read_to_string(parent.join(rel)).ok())
}

fn cache_control_header(is_html: bool, is_vendor: bool, has_version_query: bool, embedded: bool) -> &'static str {
    if is_html {
        if embedded {
            "no-store, no-cache, must-revalidate, private"
        } else {
            "no-cache, must-revalidate, private"
        }
    } else if is_vendor && has_version_query {
        "public, max-age=31536000, immutable"
    } else if is_vendor {
        "public, max-age=604800, stale-while-revalidate=86400"
    } else {
        "no-cache, must-revalidate, private"
    }
}

fn allow_disk_public_override() -> bool {
    cfg!(debug_assertions)
        || std::env::var("WEBDEP_DEV_PUBLIC")
            .map(|v| matches!(v.trim(), "1" | "true" | "TRUE" | "yes"))
            .unwrap_or(false)
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

    // FAST-PATH (dev / explicit opt-in only): In release binaries updated via GitHub Releases,
    // embedded `Assets` are authoritative so stale ./public files on disk cannot shadow new UI releases.
    if allow_disk_public_override() {
        if let Some((disk_path, mtime)) = resolve_disk_asset(clean_path).await {
        let cache_control = cache_control_header(is_html, is_vendor, has_version_query, false);
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

    // Production release builds serve embedded `Assets` directly from RAM without touching ./public.
    let cache_control = cache_control_header(is_html, is_vendor, has_version_query, true);

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

    if clean_path == "style.css" {
        if let Some((bundled, etag)) = get_bundled_embedded_css() {
            return Response::builder()
                .status(StatusCode::OK)
                .header(header::CONTENT_TYPE, HeaderValue::from_static("text/css; charset=utf-8"))
                .header(header::ETAG, HeaderValue::from_str(etag).unwrap_or_else(|_| HeaderValue::from_static("")))
                .header(header::CACHE_CONTROL, HeaderValue::from_static(cache_control))
                .header("x-cache", HeaderValue::from_static("MEMORY-EMBED"))
                .body(Body::from(bundled.clone()))
                .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response());
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

            Response::builder()
                .status(StatusCode::OK)
                .header(header::CONTENT_TYPE, HeaderValue::from_static(mime))
                .header(header::ETAG, HeaderValue::from_str(&etag).unwrap_or_else(|_| HeaderValue::from_static("")))
                .header(header::CACHE_CONTROL, HeaderValue::from_static(cache_control))
                .header("x-cache", HeaderValue::from_static("MEMORY-EMBED"))
                .body(Body::from(content.data))
                .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
        }
        None => (StatusCode::NOT_FOUND, "404 Not Found").into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_embedded_css_bundle_and_etag_consistency() {
        let (bundled, etag) = get_bundled_embedded_css().expect("embedded style.css missing");
        let css_str = std::str::from_utf8(bundled).expect("CSS must be valid UTF-8");
        assert!(!css_str.is_empty());
        assert!(
            !css_str.lines().any(|l| l.trim_start().starts_with("@import './css/")),
            "Bundled style.css should inline all @import './css/...' directives"
        );
        let etag_map = get_etag_map();
        assert_eq!(etag_map.get("style.css"), Some(etag));
    }

    #[tokio::test]
    async fn test_static_handler_304_on_matching_etag() {
        let (_, expected_etag) = get_bundled_embedded_css().expect("embedded style.css missing");
        let resp_200 = static_handler("/style.css", &HeaderMap::new(), None).await;
        assert_eq!(resp_200.status(), StatusCode::OK);
        let actual_etag = resp_200
            .headers()
            .get(header::ETAG)
            .and_then(|v| v.to_str().ok())
            .expect("ETag header missing")
            .to_string();
        assert!(!actual_etag.is_empty());

        let mut req_headers = HeaderMap::new();
        req_headers.insert(
            header::IF_NONE_MATCH,
            HeaderValue::from_str(&actual_etag).unwrap(),
        );
        let resp_304 = static_handler("/style.css", &req_headers, None).await;
        assert_eq!(resp_304.status(), StatusCode::NOT_MODIFIED);
        let _ = expected_etag;
    }
}
