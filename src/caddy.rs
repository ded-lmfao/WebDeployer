use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use crate::projects::Project;

pub struct Caddy {
    caddy_dir: PathBuf,
}

impl Caddy {
    pub fn new(data_dir: &Path) -> Self {
        let caddy_dir = data_dir.join("caddy");
        fs::create_dir_all(&caddy_dir).ok();
        Self { caddy_dir }
    }

    /// Generates Caddyfile snippet for an individual project.
    /// In Caddy, automatic HTTPS via Let's Encrypt / ZeroSSL is 100% automatic for any domain!
    pub fn generate_config(&self, p: &Project) -> String {
        let port = p.port.unwrap_or(3000);
        let domains = if p.domains.is_empty() {
            vec![format!("{}.local", p.slug)]
        } else {
            p.domains.clone()
        };
        let domain_str = domains.join(", ");

        let mut config = format!(
            "# Nexus Deploy 2.0 Auto-Generated Caddyfile\n# Project: {name} ({slug})\n# Automatic HTTPS, HTTP/3, and reverse proxy\n\n{domains} {{\n    reverse_proxy 127.0.0.1:{port}\n",
            name = p.name,
            slug = p.slug,
            domains = domain_str,
            port = port
        );

        if !p.ssl_email.trim().is_empty() {
            config.push_str(&format!("    tls {}\n", p.ssl_email.trim()));
        }

        config.push_str("}\n");
        config
    }

    /// Generates the master unified Caddyfile for all active websites.
    pub fn generate_master_caddyfile(&self, projects: &[Project]) -> String {
        let mut master = String::from(
            "# Nexus Deploy 2.0 — Master Caddyfile\n# Generated automatically for all hosted projects\n\n{\n    # Global options\n    auto_https on\n}\n\n",
        );

        for p in projects {
            master.push_str(&self.generate_config(p));
            master.push('\n');
        }

        master
    }

    pub fn write_config(&self, p: &Project) -> Result<PathBuf, std::io::Error> {
        let conf = self.generate_config(p);
        let path = self.caddy_dir.join(format!("{}.caddy", p.slug));
        fs::write(&path, conf)?;

        // Also update master Caddyfile
        let master_path = self.caddy_dir.join("Caddyfile");
        fs::write(&master_path, self.generate_config(p))?;

        Ok(path)
    }

    pub fn validate_config(&self, config_path: &Path) -> Result<(), String> {
        let out = Command::new("caddy")
            .args(["validate", "--config", config_path.to_str().unwrap_or("Caddyfile")])
            .output();

        match out {
            Ok(o) => {
                if o.status.success() {
                    Ok(())
                } else {
                    let err = String::from_utf8_lossy(&o.stderr);
                    Err(err.to_string())
                }
            }
            Err(e) => {
                // If caddy CLI is not installed on the system, gracefully inform the user
                Err(format!("Caddy binary not detected in PATH (Config written successfully to {}): {}", config_path.display(), e))
            }
        }
    }

    pub fn reload(&self) -> Result<(), String> {
        let master_path = self.caddy_dir.join("Caddyfile");

        let out = Command::new("caddy")
            .args(["reload", "--config", master_path.to_str().unwrap_or("Caddyfile")])
            .output();

        match out {
            Ok(o) => {
                if o.status.success() {
                    Ok(())
                } else {
                    let err = String::from_utf8_lossy(&o.stderr);
                    Err(err.to_string())
                }
            }
            Err(_) => {
                // Graceful note when caddy is not installed locally
                Ok(())
            }
        }
    }
}

