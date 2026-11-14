use axum::{
    body::{Body, Bytes},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
};
use flate2::{write::GzEncoder, Compression};
use rust_embed::RustEmbed;
use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

#[derive(RustEmbed)]
#[folder = "public/"]
pub struct Assets;

struct EmbeddedAssetEntry {
    data: Bytes,
    gzip_data: Option<Bytes>,
    mime: &'static str,
    etag: String,
    etag_hdr: HeaderValue,
}

static EMBEDDED_ASSETS: OnceLock<HashMap<String, EmbeddedAssetEntry>> = OnceLock::new();
static BUNDLED_EMBEDDED_CSS: OnceLock<(Bytes, String)> = OnceLock::new();
static DISK_PUBLIC_ROOTS: OnceLock<Vec<PathBuf>> = OnceLock::new();

struct DiskCacheEntry {
    mtime: std::time::SystemTime,
    etag: String,
    etag_hdr: HeaderValue,
    data: Bytes,
    gzip_data: Option<Bytes>,
}

const MIN_GZIP_BYTES: usize = 1024;

pub(crate) fn is_compressible_mime(mime: &str) -> bool {
    mime.starts_with("text/html")
        || mime.starts_with("text/css")
        || mime.starts_with("application/javascript")
        || mime.starts_with("application/json")
        || mime.starts_with("image/svg+xml")
}

pub(crate) fn gzip_compress_bytes(data: &[u8]) -> Option<Bytes> {
    if data.len() < MIN_GZIP_BYTES {
        return None;
    }
    let mut encoder = GzEncoder::new(Vec::with_capacity(data.len() / 2), Compression::default());
    encoder.write_all(data).ok()?;
    let compressed = encoder.finish().ok()?;
    (compressed.len() < data.len()).then(|| Bytes::from(compressed))
}

pub(crate) fn accepts_gzip(req_headers: &HeaderMap) -> bool {
    let Some(raw) = req_headers
        .get(header::ACCEPT_ENCODING)
        .and_then(|v| v.to_str().ok())
    else {
        return false;
    };
    for part in raw.split(',') {
        let mut segments = part.trim().split(';');
        let encoding = segments.next().unwrap_or("").trim();
        if !encoding.eq_ignore_ascii_case("gzip") && !encoding.eq_ignore_ascii_case("x-gzip") {
            continue;
        }
        let mut disabled = false;
        for param in segments {
            let param = param.trim();
            if let Some(q) = param.strip_prefix("q=").or_else(|| param.strip_prefix("Q=")) {
                if q.trim().parse::<f32>().ok().is_some_and(|v| v <= 0.0) {
                    disabled = true;
                }
            }
        }
        if !disabled {
            return true;
        }
    }
    false
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

fn get_embedded_assets() -> &'static HashMap<String, EmbeddedAssetEntry> {
    EMBEDDED_ASSETS.get_or_init(|| {
        let mut map = HashMap::new();
        for file in Assets::iter() {
            let key = file.as_ref().to_string();
            let mime = get_mime(&key);
            if key == "style.css" {
                if let Some((bundled, bundled_etag)) = get_bundled_embedded_css() {
                    let etag_hdr = HeaderValue::from_str(bundled_etag)
                        .unwrap_or_else(|_| HeaderValue::from_static(""));
                    let gzip_data = gzip_compress_bytes(bundled);
                    map.insert(
                        key,
                        EmbeddedAssetEntry {
                            data: bundled.clone(),
                            gzip_data,
                            mime,
                            etag: bundled_etag.clone(),
                            etag_hdr,
                        },
                    );
                    continue;
                }
            }
            if let Some(content) = Assets::get(&key) {
                let hash = hex::encode(content.metadata.sha256_hash());
                let etag = format!("W/\"{}\"", &hash[..16]);
                let etag_hdr =
                    HeaderValue::from_str(&etag).unwrap_or_else(|_| HeaderValue::from_static(""));
                let data = match content.data {
                    std::borrow::Cow::Borrowed(slice) => Bytes::from_static(slice),
                    std::borrow::Cow::Owned(vec) => Bytes::from(vec),
                };
                let gzip_data = if is_compressible_mime(mime) {
                    gzip_compress_bytes(&data)
                } else {
                    None
                };
                map.insert(
                    key,
                    EmbeddedAssetEntry {
                        data,
                        gzip_data,
                        mime,
                        etag,
                        etag_hdr,
                    },
                );
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

fn cache_control_header(is_html: bool, is_vendor: bool, has_version_query: bool) -> &'static str {
    if is_html {
        "no-cache, must-revalidate, private"
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

fn is_spa_route_path(raw: &str) -> bool {
    let trimmed = raw.trim_matches('/');
    if trimmed.is_empty() || trimmed.contains("..") || trimmed.contains('.') {
        return false;
    }
    let first = trimmed.split('/').next().unwrap_or("");
    matches!(
        first,
        "overview"
            | "projects"
            | "services"
            | "databases"
            | "deployments"
            | "github"
            | "logs"
            | "env"
            | "files"
            | "releases"
            | "backups"
            | "rollbacks"
            | "monitor"
            | "settings"
            | "audit"
    )
}

pub async fn static_handler(path: &str, req_headers: &HeaderMap, query: Option<&str>) -> Response {
    let trimmed = path.trim_start_matches('/');
    let clean_path = if trimmed.is_empty() || is_spa_route_path(trimmed) {
        "index.html"
    } else {
        trimmed
    };

    let is_html = clean_path.ends_with(".html");
    let is_vendor = clean_path.starts_with("vendor/");
    let has_version_query = query.map(|q| q.contains("v=")).unwrap_or(false);

    let cache_control = cache_control_header(is_html, is_vendor, has_version_query);

    // FAST-PATH (dev / explicit opt-in only): In release binaries updated via GitHub Releases,
    // embedded `Assets` are authoritative so stale ./public files on disk cannot shadow new UI releases.
    if allow_disk_public_override() {
        if let Some((disk_path, mtime)) = resolve_disk_asset(clean_path).await {
        let cache_lock = get_disk_cache();

        let cached = {
            let r = cache_lock.read().ok();
            r.and_then(|map| {
                if let Some(entry) = map.get(clean_path) {
                    if entry.mtime == mtime {
                        return Some((
                            entry.etag.clone(),
                            entry.etag_hdr.clone(),
                            entry.data.clone(),
                            entry.gzip_data.clone(),
                        ));
                    }
                }
                None
            })
        };

        let mime = get_mime(clean_path);
        let (etag, etag_hdr, data, gzip_data, is_ram_hit) = if let Some((etag, etag_hdr, data, gzip_data)) = cached {
            (etag, etag_hdr, data, gzip_data, true)
        } else if let Ok(raw_data) = tokio::fs::read(&disk_path).await {
            let final_vec = if clean_path == "style.css" {
                bundle_css_imports_from_disk(&disk_path, &raw_data)
            } else {
                raw_data
            };
            let data = Bytes::from(final_vec);
            let gzip_data = if is_compressible_mime(mime) {
                gzip_compress_bytes(&data)
            } else {
                None
            };
            let mtime_secs = mtime
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0);
            let etag = format!("W/\"{:x}-{:x}\"", mtime_secs, data.len());
            let etag_hdr = HeaderValue::from_str(&etag).unwrap_or_else(|_| HeaderValue::from_static(""));
            if let Ok(mut w) = cache_lock.write() {
                w.insert(
                    clean_path.to_string(),
                    DiskCacheEntry {
                        mtime,
                        etag: etag.clone(),
                        etag_hdr: etag_hdr.clone(),
                        data: data.clone(),
                        gzip_data: gzip_data.clone(),
                    },
                );
            }
            (etag, etag_hdr, data, gzip_data, false)
        } else {
            return (StatusCode::NOT_FOUND, "Not Found").into_response();
        };

        // Check client ETag for instant 304 Not Modified
        if let Some(if_none_match) = req_headers.get(header::IF_NONE_MATCH).and_then(|v| v.to_str().ok()) {
            if if_none_match.trim() == etag || if_none_match.contains(&etag) {
                return Response::builder()
                    .status(StatusCode::NOT_MODIFIED)
                    .header(header::ETAG, etag_hdr)
                    .header(header::CACHE_CONTROL, HeaderValue::from_static(cache_control))
                    .header("x-cache", HeaderValue::from_static("DISK-304"))
                    .body(Body::empty())
                    .unwrap_or_else(|_| StatusCode::NOT_MODIFIED.into_response());
            }
        }

        let cache_status = if is_ram_hit { "DISK-RAM-HIT" } else { "DISK-LIVE" };
        return build_asset_response(
            mime,
            etag_hdr,
            cache_control,
            cache_status,
            data,
            gzip_data,
            accepts_gzip(req_headers),
        );
        }
    }

    // Production release builds serve embedded `Assets` directly from RAM with precomputed headers.
    let assets = get_embedded_assets();
    let Some(entry) = assets.get(clean_path) else {
        return (StatusCode::NOT_FOUND, "404 Not Found").into_response();
    };

    if let Some(if_none_match) = req_headers.get(header::IF_NONE_MATCH).and_then(|v| v.to_str().ok()) {
        if if_none_match.trim() == entry.etag || if_none_match.contains(&entry.etag) {
            return Response::builder()
                .status(StatusCode::NOT_MODIFIED)
                .header(header::ETAG, entry.etag_hdr.clone())
                .header(header::CACHE_CONTROL, HeaderValue::from_static(cache_control))
                .header("x-cache", HeaderValue::from_static("HIT-304"))
                .body(Body::empty())
                .unwrap_or_else(|_| StatusCode::NOT_MODIFIED.into_response());
        }
    }

    build_asset_response(
        entry.mime,
        entry.etag_hdr.clone(),
        cache_control,
        "MEMORY-EMBED",
        entry.data.clone(),
        entry.gzip_data.clone(),
        accepts_gzip(req_headers),
    )
}

fn build_asset_response(
    mime: &'static str,
    etag_hdr: HeaderValue,
    cache_control: &'static str,
    cache_status: &'static str,
    data: Bytes,
    gzip_data: Option<Bytes>,
    client_accepts_gzip: bool,
) -> Response {
    let has_gzip = gzip_data.is_some();
    let mut builder = Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, HeaderValue::from_static(mime))
        .header(header::ETAG, etag_hdr)
        .header(header::CACHE_CONTROL, HeaderValue::from_static(cache_control))
        .header("x-cache", HeaderValue::from_static(cache_status));

    if has_gzip {
        builder = builder.header(header::VARY, HeaderValue::from_static("Accept-Encoding"));
    }

    let body = if client_accepts_gzip {
        if let Some(gz) = gzip_data {
            builder = builder.header(header::CONTENT_ENCODING, HeaderValue::from_static("gzip"));
            Body::from(gz)
        } else {
            Body::from(data)
        }
    } else {
        Body::from(data)
    };

    builder
        .body(body)
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
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
        let assets = get_embedded_assets();
        assert_eq!(assets.get("style.css").map(|e| &e.etag), Some(etag));
    }

    #[tokio::test]
    async fn test_static_handler_304_on_matching_etag() {
        let (_, expected_etag) = get_bundled_embedded_css().expect("embedded style.css missing");
        for target in ["/style.css", "/"] {
            let resp_200 = static_handler(target, &HeaderMap::new(), None).await;
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
            let resp_304 = static_handler(target, &req_headers, None).await;
            assert_eq!(resp_304.status(), StatusCode::NOT_MODIFIED);
        }
        let _ = expected_etag;
    }

    #[tokio::test]
    async fn test_static_handler_spa_fallback_and_404() {
        let ok_projects = static_handler("/projects", &HeaderMap::new(), None).await;
        assert_eq!(ok_projects.status(), StatusCode::OK);

        let ok_nested = static_handler("/deployments/db-12", &HeaderMap::new(), None).await;
        assert_eq!(ok_nested.status(), StatusCode::OK);

        let missing_asset = static_handler("/projects/missing.js", &HeaderMap::new(), None).await;
        assert_eq!(missing_asset.status(), StatusCode::NOT_FOUND);

        let unknown_route = static_handler("/not-a-real-view", &HeaderMap::new(), None).await;
        assert_eq!(unknown_route.status(), StatusCode::NOT_FOUND);
    }

    #[test]
    fn test_accepts_gzip_header_parsing() {
        let mut h = HeaderMap::new();
        assert!(!accepts_gzip(&h));

        h.insert(header::ACCEPT_ENCODING, HeaderValue::from_static("gzip, deflate, br"));
        assert!(accepts_gzip(&h));

        h.insert(header::ACCEPT_ENCODING, HeaderValue::from_static("br, gzip;q=0"));
        assert!(!accepts_gzip(&h));

        h.insert(header::ACCEPT_ENCODING, HeaderValue::from_static("br, x-gzip;q=0.8"));
        assert!(accepts_gzip(&h));
    }

    #[tokio::test]
    async fn test_static_handler_precompressed_gzip_parity() {
        use axum::body::to_bytes;
        use flate2::read::GzDecoder;
        use std::io::Read;

        let raw_resp = static_handler("/style.css", &HeaderMap::new(), None).await;
        assert_eq!(raw_resp.status(), StatusCode::OK);
        assert!(raw_resp.headers().get(header::CONTENT_ENCODING).is_none());
        let raw_body = to_bytes(raw_resp.into_body(), usize::MAX).await.unwrap();

        let mut gz_headers = HeaderMap::new();
        gz_headers.insert(header::ACCEPT_ENCODING, HeaderValue::from_static("gzip, deflate"));
        let gz_resp = static_handler("/style.css", &gz_headers, None).await;
        assert_eq!(gz_resp.status(), StatusCode::OK);
        assert_eq!(
            gz_resp.headers().get(header::CONTENT_ENCODING).and_then(|v| v.to_str().ok()),
            Some("gzip")
        );
        assert_eq!(
            gz_resp.headers().get(header::VARY).and_then(|v| v.to_str().ok()),
            Some("Accept-Encoding")
        );
        let gz_body = to_bytes(gz_resp.into_body(), usize::MAX).await.unwrap();
        assert!(gz_body.len() < raw_body.len());

        let mut decoder = GzDecoder::new(&gz_body[..]);
        let mut decoded = Vec::with_capacity(raw_body.len());
        decoder.read_to_end(&mut decoded).unwrap();
        assert_eq!(decoded.as_slice(), &raw_body[..]);
    }
}
