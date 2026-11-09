use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use crate::projects::Project;
use crate::runtime::Runtime;

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

        let status_note = if p.app_status == "maintenance" {
            "# Status: Maintenance Page Responder active on upstream port"
        } else {
            "# Status: Live application upstream"
        };

        let mut config = format!(
            "# WebDep Auto-Generated Caddyfile\n# Project: {name} ({slug})\n# Automatic HTTPS, HTTP/3, and reverse proxy\n{status_note}\n\n{domains} {{\n    reverse_proxy 127.0.0.1:{port}\n",
            name = p.name,
            slug = p.slug,
            status_note = status_note,
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
            "# WebDep — Master Multi-Website Caddyfile\n# Generated automatically for all hosted projects\n\n{\n    # Global options\n    auto_https on\n}\n\n",
        );

        for p in projects {
            master.push_str(&self.generate_config(p));
            master.push('\n');
        }

        master
    }

    pub fn write_config(&self, p: &Project, all_projects: &[Project]) -> Result<PathBuf, std::io::Error> {
        // Write static maintenance HTML snapshot for reference/fallback
        let maint_html = Runtime::render_maintenance_html(
            &p.name,
            &p.slug,
            "Scheduled Maintenance • Developers Working",
        );
        let maint_path = self.caddy_dir.join(format!("{}-maintenance.html", p.slug));
        let _ = fs::write(&maint_path, maint_html);

        let conf = self.generate_config(p);
        let path = self.caddy_dir.join(format!("{}.caddy", p.slug));
        fs::write(&path, conf)?;

        // Also update master Caddyfile for all hosted websites
        let master_path = self.caddy_dir.join("Caddyfile");
        fs::write(&master_path, self.generate_master_caddyfile(all_projects))?;

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(&path, fs::Permissions::from_mode(0o644));
            let _ = fs::set_permissions(&master_path, fs::Permissions::from_mode(0o644));
        }

        Ok(path)
    }

    pub fn remove_project_config(&self, slug: &str, remaining_projects: &[Project]) {
        if !slug.trim().is_empty() {
            let _ = fs::remove_file(self.caddy_dir.join(format!("{}.caddy", slug)));
            let _ = fs::remove_file(self.caddy_dir.join(format!("{}-maintenance.html", slug)));
        }
        let master_path = self.caddy_dir.join("Caddyfile");
        let _ = fs::write(&master_path, self.generate_master_caddyfile(remaining_projects));
        let _ = self.reload();
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
        #[cfg(unix)]
        {
            if Path::new("/etc/caddy/Caddyfile").exists() {
                if let Ok(o) = Command::new("sudo")
                    .args(["-n", "systemctl", "reload", "caddy"])
                    .output()
                {
                    if o.status.success() {
                        return Ok(());
                    }
                }
            }
        }

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

