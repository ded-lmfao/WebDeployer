use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Arc;

use crate::db::{now, DbPool};
use crate::vault::Vault;

fn default_branch() -> String { "main".to_string() }
fn default_project_type() -> String { "node".to_string() }
fn default_deploy_method() -> String { "managed".to_string() }
fn default_app_status() -> String { "stopped".to_string() }
fn default_health_timeout_s() -> i64 { 30 }
fn default_stability_s() -> i64 { 5 }
fn default_poll_interval_s() -> i64 { 60 }
fn default_retention() -> i64 { 5 }
fn default_true() -> bool { true }

#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct Project {
    #[serde(default)]
    pub id: i64,
    pub name: String,
    pub slug: String,
    pub repo_url: String,
    #[serde(default = "default_branch")]
    pub branch: String,
    #[serde(default = "default_project_type")]
    pub project_type: String,
    #[serde(default = "default_deploy_method")]
    pub deploy_method: String,
    #[serde(default)]
    pub deploy_dir: String,
    #[serde(default)]
    pub port: Option<u16>,
    #[serde(default)]
    pub install_cmd: String,
    #[serde(default)]
    pub build_cmd: String,
    #[serde(default)]
    pub start_cmd: String,
    #[serde(default)]
    pub health_url: String,
    #[serde(default)]
    pub health_cmd: String,
    #[serde(default = "default_health_timeout_s")]
    pub health_timeout_s: i64,
    #[serde(default = "default_stability_s")]
    pub stability_s: i64,
    #[serde(default = "default_true")]
    pub preflight: bool,
    #[serde(default)]
    pub auto_deploy: bool,
    #[serde(default = "default_poll_interval_s")]
    pub poll_interval_s: i64,
    #[serde(default)]
    pub webhook_secret: Option<String>,
    #[serde(default = "default_retention")]
    pub retention: i64,
    #[serde(default)]
    pub persistent_paths: Vec<String>,
    #[serde(default)]
    pub current_release_id: Option<i64>,
    #[serde(default)]
    pub deployed_sha: Option<String>,
    #[serde(default)]
    pub last_poll_at: Option<i64>,
    #[serde(default = "default_app_status")]
    pub app_status: String,
    #[serde(default)]
    pub app_pid: Option<u32>,
    #[serde(default)]
    pub app_started_at: Option<i64>,
    #[serde(default)]
    pub domains: Vec<String>,
    #[serde(default)]
    pub ssl_enabled: bool,
    #[serde(default)]
    pub ssl_email: String,
    #[serde(default)]
    pub nginx_configured: bool,
    #[serde(default)]
    pub created_at: i64,
    #[serde(default)]
    pub updated_at: i64,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct EnvVarView {
    pub key: String,
    pub value: String,
    pub is_secret: bool,
}

pub struct Projects {
    db: DbPool,
    vault: Arc<Vault>,
    data_dir: PathBuf,
}

impl Projects {
    pub fn new(db: DbPool, vault: Arc<Vault>, data_dir: PathBuf) -> Self {
        Self {
            db,
            vault,
            data_dir,
        }
    }

    pub fn list(&self) -> Result<Vec<Project>, rusqlite::Error> {
        let conn = self.db.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, name, slug, repo_url, branch, project_type, deploy_method, deploy_dir, port,
                    install_cmd, build_cmd, start_cmd, health_url, health_cmd, health_timeout_s,
                    stability_s, preflight, auto_deploy, poll_interval_s, webhook_secret, retention,
                    persistent_paths, current_release_id, deployed_sha, last_poll_at, app_status,
                    app_pid, app_started_at, domains, ssl_enabled, ssl_email, nginx_configured,
                    created_at, updated_at
             FROM projects ORDER BY id DESC",
        )?;

        let rows = stmt.query_map([], |r| {
            let p_paths_str: String = r.get(21)?;
            let p_paths: Vec<String> = serde_json::from_str(&p_paths_str).unwrap_or_default();
            let domains_str: String = r.get(28)?;
            let domains: Vec<String> = serde_json::from_str(&domains_str).unwrap_or_default();

            Ok(Project {
                id: r.get(0)?,
                name: r.get(1)?,
                slug: r.get(2)?,
                repo_url: r.get(3)?,
                branch: r.get(4)?,
                project_type: r.get(5)?,
                deploy_method: r.get(6)?,
                deploy_dir: r.get(7)?,
                port: r.get::<_, Option<u32>>(8)?.map(|p| p as u16),
                install_cmd: r.get(9)?,
                build_cmd: r.get(10)?,
                start_cmd: r.get(11)?,
                health_url: r.get(12)?,
                health_cmd: r.get(13)?,
                health_timeout_s: r.get(14)?,
                stability_s: r.get(15)?,
                preflight: r.get::<_, i64>(16)? != 0,
                auto_deploy: r.get::<_, i64>(17)? != 0,
                poll_interval_s: r.get(18)?,
                webhook_secret: r.get(19)?,
                retention: r.get(20)?,
                persistent_paths: p_paths,
                current_release_id: r.get(22)?,
                deployed_sha: r.get(23)?,
                last_poll_at: r.get(24)?,
                app_status: r.get(25)?,
                app_pid: r.get::<_, Option<u32>>(26)?,
                app_started_at: r.get(27)?,
                domains,
                ssl_enabled: r.get::<_, i64>(29)? != 0,
                ssl_email: r.get(30)?,
                nginx_configured: r.get::<_, i64>(31)? != 0,
                created_at: r.get(32)?,
                updated_at: r.get(33)?,
            })
        })?;

        let mut list = Vec::new();
        for r in rows {
            list.push(r?);
        }
        Ok(list)
    }

    pub fn get(&self, id: i64) -> Result<Option<Project>, rusqlite::Error> {
        let conn = self.db.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, name, slug, repo_url, branch, project_type, deploy_method, deploy_dir, port,
                    install_cmd, build_cmd, start_cmd, health_url, health_cmd, health_timeout_s,
                    stability_s, preflight, auto_deploy, poll_interval_s, webhook_secret, retention,
                    persistent_paths, current_release_id, deployed_sha, last_poll_at, app_status,
                    app_pid, app_started_at, domains, ssl_enabled, ssl_email, nginx_configured,
                    created_at, updated_at
             FROM projects WHERE id = ?",
        )?;

        let res = stmt.query_row(params![id], |r| {
            let p_paths_str: String = r.get(21)?;
            let p_paths: Vec<String> = serde_json::from_str(&p_paths_str).unwrap_or_default();
            let domains_str: String = r.get(28)?;
            let domains: Vec<String> = serde_json::from_str(&domains_str).unwrap_or_default();

            Ok(Project {
                id: r.get(0)?,
                name: r.get(1)?,
                slug: r.get(2)?,
                repo_url: r.get(3)?,
                branch: r.get(4)?,
                project_type: r.get(5)?,
                deploy_method: r.get(6)?,
                deploy_dir: r.get(7)?,
                port: r.get::<_, Option<u32>>(8)?.map(|p| p as u16),
                install_cmd: r.get(9)?,
                build_cmd: r.get(10)?,
                start_cmd: r.get(11)?,
                health_url: r.get(12)?,
                health_cmd: r.get(13)?,
                health_timeout_s: r.get(14)?,
                stability_s: r.get(15)?,
                preflight: r.get::<_, i64>(16)? != 0,
                auto_deploy: r.get::<_, i64>(17)? != 0,
                poll_interval_s: r.get(18)?,
                webhook_secret: r.get(19)?,
                retention: r.get(20)?,
                persistent_paths: p_paths,
                current_release_id: r.get(22)?,
                deployed_sha: r.get(23)?,
                last_poll_at: r.get(24)?,
                app_status: r.get(25)?,
                app_pid: r.get::<_, Option<u32>>(26)?,
                app_started_at: r.get(27)?,
                domains,
                ssl_enabled: r.get::<_, i64>(29)? != 0,
                ssl_email: r.get(30)?,
                nginx_configured: r.get::<_, i64>(31)? != 0,
                created_at: r.get(32)?,
                updated_at: r.get(33)?,
            })
        }).optional()?;

        Ok(res)
    }

    pub fn create(&self, p: &Project) -> Result<i64, Box<dyn std::error::Error + Send + Sync>> {
        let ts = now();
        let p_paths_json = serde_json::to_string(&p.persistent_paths)?;
        let domains_json = serde_json::to_string(&p.domains)?;

        let conn = self.db.lock().unwrap();
        conn.execute(
            "INSERT INTO projects(
                name, slug, repo_url, branch, project_type, deploy_method, deploy_dir, port,
                install_cmd, build_cmd, start_cmd, health_url, health_cmd, health_timeout_s,
                stability_s, preflight, auto_deploy, poll_interval_s, webhook_secret, retention,
                persistent_paths, app_status, domains, ssl_enabled, ssl_email, nginx_configured,
                created_at, updated_at
            ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            params![
                p.name,
                p.slug,
                p.repo_url,
                p.branch,
                p.project_type,
                p.deploy_method,
                p.deploy_dir,
                p.port.map(|v| v as u32),
                p.install_cmd,
                p.build_cmd,
                p.start_cmd,
                p.health_url,
                p.health_cmd,
                p.health_timeout_s,
                p.stability_s,
                if p.preflight { 1 } else { 0 },
                if p.auto_deploy { 1 } else { 0 },
                p.poll_interval_s,
                p.webhook_secret,
                p.retention,
                p_paths_json,
                "stopped",
                domains_json,
                if p.ssl_enabled { 1 } else { 0 },
                p.ssl_email,
                if p.nginx_configured { 1 } else { 0 },
                ts,
                ts
            ],
        )?;

        let id = conn.last_insert_rowid();
        Ok(id)
    }

    pub fn update(&self, id: i64, p: &Project) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let ts = now();
        let p_paths_json = serde_json::to_string(&p.persistent_paths)?;
        let domains_json = serde_json::to_string(&p.domains)?;

        let conn = self.db.lock().unwrap();
        conn.execute(
            "UPDATE projects SET
                name=?, repo_url=?, branch=?, project_type=?, deploy_method=?, deploy_dir=?, port=?,
                install_cmd=?, build_cmd=?, start_cmd=?, health_url=?, health_cmd=?, health_timeout_s=?,
                stability_s=?, preflight=?, auto_deploy=?, poll_interval_s=?, retention=?,
                persistent_paths=?, domains=?, ssl_enabled=?, ssl_email=?, nginx_configured=?, updated_at=?
             WHERE id=?",
            params![
                p.name,
                p.repo_url,
                p.branch,
                p.project_type,
                p.deploy_method,
                p.deploy_dir,
                p.port.map(|v| v as u32),
                p.install_cmd,
                p.build_cmd,
                p.start_cmd,
                p.health_url,
                p.health_cmd,
                p.health_timeout_s,
                p.stability_s,
                if p.preflight { 1 } else { 0 },
                if p.auto_deploy { 1 } else { 0 },
                p.poll_interval_s,
                p.retention,
                p_paths_json,
                domains_json,
                if p.ssl_enabled { 1 } else { 0 },
                p.ssl_email,
                if p.nginx_configured { 1 } else { 0 },
                ts,
                id
            ],
        )?;

        Ok(())
    }

    pub fn delete(&self, id: i64) -> Result<(), rusqlite::Error> {
        let conn = self.db.lock().unwrap();
        conn.execute("DELETE FROM projects WHERE id=?", params![id])?;
        Ok(())
    }

    pub fn get_env_vars(&self, project_id: i64) -> Result<Vec<EnvVarView>, rusqlite::Error> {
        let conn = self.db.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT key, value_enc, is_secret FROM project_env WHERE project_id = ? ORDER BY key ASC",
        )?;

        let rows = stmt.query_map(params![project_id], |r| {
            let key: String = r.get(0)?;
            let is_secret: bool = r.get::<_, i64>(2)? != 0;
            let val_enc: String = r.get(1)?;
            let value = if is_secret {
                "********".to_string()
            } else {
                self.vault.decrypt(&val_enc).unwrap_or_else(|_| "".to_string())
            };
            Ok(EnvVarView {
                key,
                value,
                is_secret,
            })
        })?;

        let mut res = Vec::new();
        for r in rows {
            res.push(r?);
        }
        Ok(res)
    }

    pub fn set_env_var(
        &self,
        project_id: i64,
        key: &str,
        value: &str,
        is_secret: bool,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let enc = self.vault.encrypt(value)?;
        let conn = self.db.lock().unwrap();
        conn.execute(
            "INSERT INTO project_env(project_id, key, value_enc, is_secret) VALUES(?, ?, ?, ?)
             ON CONFLICT(project_id, key) DO UPDATE SET value_enc=excluded.value_enc, is_secret=excluded.is_secret",
            params![project_id, key, enc, if is_secret { 1 } else { 0 }],
        )?;
        Ok(())
    }

    pub fn delete_env_var(&self, project_id: i64, key: &str) -> Result<(), rusqlite::Error> {
        let conn = self.db.lock().unwrap();
        conn.execute(
            "DELETE FROM project_env WHERE project_id = ? AND key = ?",
            params![project_id, key],
        )?;
        Ok(())
    }

    pub fn reveal_env_var(&self, project_id: i64, key: &str) -> Option<String> {
        let conn = self.db.lock().unwrap();
        let enc: Result<String, _> = conn.query_row(
            "SELECT value_enc FROM project_env WHERE project_id = ? AND key = ?",
            params![project_id, key],
            |r| r.get(0),
        );

        if let Ok(val_enc) = enc {
            self.vault.decrypt(&val_enc).ok()
        } else {
            None
        }
    }

    pub fn get_env_map(&self, project_id: i64) -> std::collections::HashMap<String, String> {
        let mut map = std::collections::HashMap::new();
        let conn = self.db.lock().unwrap();
        let mut stmt = match conn.prepare("SELECT key, value_enc FROM project_env WHERE project_id = ?") {
            Ok(s) => s,
            Err(_) => return map,
        };

        if let Ok(rows) = stmt.query_map(params![project_id], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        }) {
            for item in rows.flatten() {
                if let Ok(dec) = self.vault.decrypt(&item.1) {
                    map.insert(item.0, dec);
                }
            }
        }
        map
    }
}
