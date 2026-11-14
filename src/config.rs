use rand::Rng;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use tracing::warn;

const CONTROL_PLANE_SENSITIVE_ENV_KEYS: &[&str] = &[
    "ADMIN_USERNAME",
    "ADMIN_PASSWORD",
    "ADMIN_USER",
    "ADMIN_PASS",
    "ADMIN_RESET_2FA",
    "SESSION_TTL_S",
    "SESSION_IDLE_TIMEOUT_S",
    "FORCE_SECURE_COOKIES",
    "ENCRYPTION_KEY",
    "JWT_SECRET",
    "GITHUB_TOKEN",
    "GH_TOKEN",
];

#[derive(Clone, Debug)]
pub struct Config {
    pub port: u16,
    pub host: String,
    pub data_dir: PathBuf,
    pub session_ttl_s: u64,
    pub session_idle_timeout_s: u64,
    pub force_secure_cookies: bool,
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

    pub fn generate_bootstrap_password() -> String {
        const CHARSET: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
        let mut rng = rand::thread_rng();
        (0..20)
            .map(|_| {
                let idx = rng.gen_range(0..CHARSET.len());
                CHARSET[idx] as char
            })
            .collect()
    }

    fn render_default_dotenv(admin_pass: &str) -> String {
        format!(
            "# ============================================================================\n\
             # WebDep — Main Admin Login ID & Password Configuration\n\
             # ============================================================================\n\
             # Edit ADMIN_USERNAME and ADMIN_PASSWORD below to set or change the Main Admin\n\
             # login ID and password. Changes take effect immediately (even without restart).\n\
             # ============================================================================\n\n\
             ADMIN_USERNAME=admin\n\
             ADMIN_PASSWORD={}\n\n\
             # Set to true if you ever need to reset 2FA on the Main Admin account\n\
             ADMIN_RESET_2FA=false\n\n\
             # ============================================================================\n\
             # Platform Server & Security Settings\n\
             # ============================================================================\n\
             HOST=0.0.0.0\n\
             PORT=4600\n\
             DATA_DIR=./data\n\
             SESSION_TTL_S=604800\n\
             SESSION_IDLE_TIMEOUT_S=1800\n\
             FORCE_SECURE_COOKIES=false\n",
            admin_pass
        )
    }

    fn write_private_file(path: &Path, content: &str) {
        if std::fs::write(path, content).is_ok() {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
            }
        }
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
            let generated = Self::generate_bootstrap_password();
            Self::write_private_file(&path, &Self::render_default_dotenv(&generated));
            warn!(
                "Generated first-boot Main Admin password in {} -> ADMIN_USERNAME=admin ADMIN_PASSWORD={} (change immediately or keep .env private)",
                path.display(),
                generated
            );
        }

        let mut map = Self::parse_dotenv_file(&path);
        let cur_pass = map
            .get("ADMIN_PASSWORD")
            .or_else(|| map.get("ADMIN_PASS"))
            .map(|s| s.trim().to_string())
            .unwrap_or_default();

        if cur_pass.is_empty() || cur_pass == "admin123" {
            let generated = Self::generate_bootstrap_password();
            Self::sync_dotenv_admin(None, Some(&generated));
            map.insert("ADMIN_PASSWORD".to_string(), generated.clone());
            warn!(
                "Replaced empty or legacy default ADMIN_PASSWORD in {} -> new bootstrap password: {}",
                path.display(),
                generated
            );
        }

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

        let raw_password = map
            .get("ADMIN_PASSWORD")
            .or_else(|| map.get("ADMIN_PASS"))
            .cloned()
            .or_else(|| std::env::var("ADMIN_PASSWORD").ok())
            .unwrap_or_default();

        let reset_2fa = map
            .get("ADMIN_RESET_2FA")
            .map(|s| s.eq_ignore_ascii_case("true") || s == "1")
            .unwrap_or(false);

        let clean_user = if username.trim().is_empty() {
            "admin".to_string()
        } else {
            username.trim().to_string()
        };

        let trimmed_pass = raw_password.trim();
        let clean_pass = if trimmed_pass.is_empty() || trimmed_pass == "admin123" {
            let generated = Self::generate_bootstrap_password();
            if path.exists() {
                Self::sync_dotenv_admin(None, Some(&generated));
                warn!(
                    "Generated secure replacement ADMIN_PASSWORD in {} (user '{}'): {}",
                    path.display(),
                    clean_user,
                    generated
                );
            }
            generated
        } else {
            trimmed_pass.to_string()
        };

        (clean_user, clean_pass, reset_2fa)
    }

    /// Updates `ADMIN_USERNAME` and/or `ADMIN_PASSWORD` in `.env` when the Main Admin changes their credentials via the UI.
    pub fn sync_dotenv_admin(new_username: Option<&str>, new_password: Option<&str>) {
        let path = Self::dotenv_path();
        let existing = std::fs::read_to_string(&path)
            .unwrap_or_else(|_| Self::render_default_dotenv(new_password.unwrap_or("")));
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
        Self::write_private_file(&path, &output);
    }

    /// Removes WebDep control-plane secrets from spawned build/runtime child processes.
    pub fn scrub_control_plane_env(cmd: &mut tokio::process::Command) {
        for key in CONTROL_PLANE_SENSITIVE_ENV_KEYS {
            cmd.env_remove(key);
        }
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
        let session_idle_timeout_s = std::env::var("SESSION_IDLE_TIMEOUT_S")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(1800); // 30 minutes idle timeout (0 disables)
        let force_secure_cookies = std::env::var("FORCE_SECURE_COOKIES")
            .map(|v| v.eq_ignore_ascii_case("true") || v == "1")
            .unwrap_or(false);

        std::fs::create_dir_all(&data_dir).ok();

        Self {
            port,
            host,
            data_dir,
            session_ttl_s,
            session_idle_timeout_s,
            force_secure_cookies,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_bootstrap_password_strength() {
        let p1 = Config::generate_bootstrap_password();
        let p2 = Config::generate_bootstrap_password();
        assert!(p1.len() >= 20);
        assert_ne!(p1, "admin123");
        assert_ne!(p1, p2);
    }
}
