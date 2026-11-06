use std::path::PathBuf;

#[derive(Clone, Debug)]
pub struct Config {
    pub port: u16,
    pub host: String,
    pub data_dir: PathBuf,
    pub log_dir: PathBuf,
    pub session_ttl_s: u64,
}

impl Config {
    pub fn from_env() -> Self {
        let port = std::env::var("PORT")
            .ok()
            .and_then(|p| p.parse().ok())
            .unwrap_or(4600);
        let host = std::env::var("HOST").unwrap_or_else(|_| "127.0.0.1".to_string());
        let data_dir = std::env::var("DATA_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from("./data"));
        let log_dir = std::env::var("LOG_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|_| data_dir.join("logs"));
        let session_ttl_s = std::env::var("SESSION_TTL_S")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(60 * 60 * 24 * 7); // 7 days

        std::fs::create_dir_all(&data_dir).ok();
        std::fs::create_dir_all(&log_dir).ok();

        Self {
            port,
            host,
            data_dir,
            log_dir,
            session_ttl_s,
        }
    }
}

