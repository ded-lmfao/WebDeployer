use std::collections::HashMap;
use std::path::{Path, PathBuf};

const DEFAULT_DOTENV: &str = "\
# ============================================================================
# WebDep — Main Admin Login ID & Password Configuration
# ============================================================================
# Edit ADMIN_USERNAME and ADMIN_PASSWORD below to set or change the Main Admin
# login ID and password. Changes take effect immediately (even without restart).
# ============================================================================

ADMIN_USERNAME=admin
ADMIN_PASSWORD=admin123

# Set to true if you ever need to reset 2FA on the Main Admin account
ADMIN_RESET_2FA=false

# ============================================================================
# Platform Server Settings
# ============================================================================
HOST=0.0.0.0
PORT=4600
DATA_DIR=./data
SESSION_TTL_S=604800
";

#[derive(Clone, Debug)]
pub struct Config {
    pub port: u16,
    pub host: String,
    pub data_dir: PathBuf,
    pub session_ttl_s: u64,
}

impl Config {
    pub fn dotenv_path() -> PathBuf {
        let cwd_env = PathBuf::from(".env");
        if cwd_env.exists() {
            return cwd_env;
        }
        if let Ok(exe) = std::env::current_exe() {
            if let Some(dir) = exe.parent() {
                let exe_env = dir.join(".env");
                if exe_env.exists() {
                    return exe_env;
                }
            }
        }
        cwd_env
    }

    pub fn parse_dotenv_file(path: &Path) -> HashMap<String, String> {
        let mut map = HashMap::new();
        let Ok(content) = std::fs::read_to_string(path) else {
            return map;
        };
        for raw_line in content.lines() {
            let line = raw_line.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            let line = line.strip_prefix("export ").unwrap_or(line).trim();
            if let Some((k, v)) = line.split_once('=') {
                let key = k.trim().to_string();
                let mut val = v.trim().to_string();
                if (val.starts_with('"') && val.ends_with('"') && val.len() >= 2)
                    || (val.starts_with('\'') && val.ends_with('\'') && val.len() >= 2)
                {
                    val = val[1..val.len() - 1].to_string();
                }
                if !key.is_empty() {
                    map.insert(key, val);
                }
            }
        }
        map
    }

    pub fn load_dotenv() -> HashMap<String, String> {
        let path = Self::dotenv_path();
        if !path.exists() {
            let _ = std::fs::write(&path, DEFAULT_DOTENV);
        }
        let map = Self::parse_dotenv_file(&path);
        for (k, v) in &map {
            std::env::set_var(k, v);
        }
        map
    }

    /// Reads the latest Main Admin credentials from `.env` (supports live-editing `.env` without restart).
    pub fn read_dotenv_admin() -> (String, String, bool) {
        let path = Self::dotenv_path();
        let map = Self::parse_dotenv_file(&path);

        let username = map
            .get("ADMIN_USERNAME")
            .or_else(|| map.get("ADMIN_ID"))
            .or_else(|| map.get("ADMIN_USER"))
            .cloned()
            .or_else(|| std::env::var("ADMIN_USERNAME").ok())
            .unwrap_or_else(|| "admin".to_string());

        let password = map
            .get("ADMIN_PASSWORD")
            .or_else(|| map.get("ADMIN_PASS"))
            .cloned()
            .or_else(|| std::env::var("ADMIN_PASSWORD").ok())
            .unwrap_or_else(|| "admin123".to_string());

        let reset_2fa = map
            .get("ADMIN_RESET_2FA")
            .map(|s| s.eq_ignore_ascii_case("true") || s == "1")
            .unwrap_or(false);

        let clean_user = if username.trim().is_empty() {
            "admin".to_string()
        } else {
            username.trim().to_string()
        };
        let clean_pass = if password.trim().is_empty() {
            "admin123".to_string()
        } else {
            password.trim().to_string()
        };

        (clean_user, clean_pass, reset_2fa)
    }

    /// Updates `ADMIN_USERNAME` and/or `ADMIN_PASSWORD` in `.env` when the Main Admin changes their credentials via the UI.
    pub fn sync_dotenv_admin(new_username: Option<&str>, new_password: Option<&str>) {
        let path = Self::dotenv_path();
        let existing = std::fs::read_to_string(&path).unwrap_or_else(|_| DEFAULT_DOTENV.to_string());
        let mut lines: Vec<String> = Vec::new();
        let mut found_user = false;
        let mut found_pass = false;

        for raw_line in existing.lines() {
            let trimmed = raw_line.trim();
            if !trimmed.starts_with('#') {
                if let Some((k, _)) = trimmed.split_once('=') {
                    let key = k.trim();
                    if key == "ADMIN_USERNAME" {
                        found_user = true;
                        if let Some(u) = new_username {
                            lines.push(format!("ADMIN_USERNAME={}", u));
                            std::env::set_var("ADMIN_USERNAME", u);
                            continue;
                        }
                    } else if key == "ADMIN_PASSWORD" {
                        found_pass = true;
                        if let Some(p) = new_password {
                            lines.push(format!("ADMIN_PASSWORD={}", p));
                            std::env::set_var("ADMIN_PASSWORD", p);
                            continue;
                        }
                    } else if key == "ADMIN_RESET_2FA" {
                        lines.push("ADMIN_RESET_2FA=false".to_string());
                        continue;
                    }
                }
            }
            lines.push(raw_line.to_string());
        }

        if !found_user {
            if let Some(u) = new_username {
                lines.insert(0, format!("ADMIN_USERNAME={}", u));
                std::env::set_var("ADMIN_USERNAME", u);
            }
        }
        if !found_pass {
            if let Some(p) = new_password {
                lines.insert(1, format!("ADMIN_PASSWORD={}", p));
                std::env::set_var("ADMIN_PASSWORD", p);
            }
        }

        let mut output = lines.join("\n");
        if !output.ends_with('\n') {
            output.push('\n');
        }
        let _ = std::fs::write(&path, output);
    }

    pub fn from_env() -> Self {
        Self::load_dotenv();

        let port = std::env::var("PORT")
            .ok()
            .and_then(|p| p.parse().ok())
            .unwrap_or(4600);
        let host = std::env::var("HOST").unwrap_or_else(|_| "0.0.0.0".to_string());
        let data_dir = std::env::var("DATA_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from("./data"));
        let session_ttl_s = std::env::var("SESSION_TTL_S")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(60 * 60 * 24 * 7); // 7 days

        std::fs::create_dir_all(&data_dir).ok();

        Self {
            port,
            host,
            data_dir,
            session_ttl_s,
        }
    }
}
