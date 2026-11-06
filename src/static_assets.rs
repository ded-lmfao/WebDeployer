use axum::{
    body::Body,
    http::{header, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
};
use rust_embed::RustEmbed;

#[derive(RustEmbed)]
#[folder = "public/"]
pub struct Assets;

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

pub async fn static_handler(path: &str) -> Response {
    let clean_path = if path.is_empty() || path == "/" {
        "index.html"
    } else {
        path.trim_start_matches('/')
    };

    match Assets::get(clean_path) {
        Some(content) => {
            let mime = get_mime(clean_path);
            let hash = hex::encode(content.metadata.sha256_hash());
            let etag = format!("\"{}\"", hash);

            Response::builder()
                .status(StatusCode::OK)
                .header(header::CONTENT_TYPE, HeaderValue::from_static(mime))
                .header(header::ETAG, HeaderValue::from_str(&etag).unwrap())
                .header(header::CACHE_CONTROL, HeaderValue::from_static("no-cache, no-store, must-revalidate"))
                .body(Body::from(content.data))
                .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
        }
        None => (StatusCode::NOT_FOUND, "404 Not Found").into_response(),
    }
}
