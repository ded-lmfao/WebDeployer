use axum::{
    body::Body,
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
};
use rust_embed::RustEmbed;
use std::collections::HashMap;
use std::sync::OnceLock;

#[derive(RustEmbed)]
#[folder = "public/"]
pub struct Assets;

static ETAG_CACHE: OnceLock<HashMap<String, String>> = OnceLock::new();

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

pub async fn static_handler(path: &str, req_headers: &HeaderMap, query: Option<&str>) -> Response {
    let clean_path = if path.is_empty() || path == "/" {
        "index.html"
    } else {
        path.trim_start_matches('/')
    };

    let is_html = clean_path.ends_with(".html");
    let has_version_query = query.map(|q| q.contains("v=")).unwrap_or(false);
    let cache_control = if is_html {
        "no-cache, must-revalidate"
    } else if has_version_query {
        "public, max-age=31536000, immutable"
    } else {
        "public, max-age=3600, stale-while-revalidate=86400"
    };

    let etag_map = get_etag_map();
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
                .header(header::ETAG, HeaderValue::from_str(&etag).unwrap())
                .header(header::CACHE_CONTROL, HeaderValue::from_static(cache_control))
                .header("x-cache", HeaderValue::from_static("MEMORY-EMBED"))
                .body(Body::from(content.data))
                .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
        }
        None => (StatusCode::NOT_FOUND, "404 Not Found").into_response(),
    }
}
