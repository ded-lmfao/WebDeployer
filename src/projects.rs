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

fn deserialize_bool_or_int<'de, D>(deserializer: D) -> Result<bool, D::Error>
where
    D: serde::Deserializer<'de>,
{
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum BoolOrInt {
        Bool(bool),
        Int(i64),
        Str(String),
    }
    match BoolOrInt::deserialize(deserializer)? {
        BoolOrInt::Bool(b) => Ok(b),
        BoolOrInt::Int(i) => Ok(i != 0),
        BoolOrInt::Str(s) => Ok(s == "1" || s.eq_ignore_ascii_case("true")),
    }
}

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
    #[serde(default = "default_true", deserialize_with = "deserialize_bool_or_int")]
    pub preflight: bool,
    #[serde(default, deserialize_with = "deserialize_bool_or_int")]
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
    #[serde(default, deserialize_with = "deserialize_bool_or_int")]
    pub ssl_enabled: bool,
    #[serde(default)]
    pub ssl_email: String,
    #[serde(default, deserialize_with = "deserialize_bool_or_int")]
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
    #[serde(default)]
    pub real_value: String,
    pub is_secret: bool,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct EnvVarInput {
    pub key: String,
    pub value: String,
    #[serde(default = "default_true")]
    pub is_secret: bool,
}

const SELECT_PROJECT_FIELDS: &str = "\
    id, name, slug, repo_url, branch, project_type, deploy_method, deploy_dir, port, \
    install_cmd, build_cmd, start_cmd, health_url, health_cmd, health_timeout_s, \
    stability_s, preflight, auto_deploy, poll_interval_s, webhook_secret, retention, \
    persistent_paths, current_release_id, deployed_sha, last_poll_at, app_status, \
    app_pid, app_started_at, domains, ssl_enabled, ssl_email, nginx_configured, \
    created_at, updated_at";

fn row_to_project(r: &rusqlite::Row) -> Result<Project, rusqlite::Error> {
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
        let query = format!("SELECT {} FROM projects ORDER BY id DESC", SELECT_PROJECT_FIELDS);
        let mut stmt = conn.prepare(&query)?;

        let rows = stmt.query_map([], row_to_project)?;

        let mut list = Vec::new();
        for r in rows {
            list.push(r?);
        }
        Ok(list)
    }

    pub fn get(&self, id: i64) -> Result<Option<Project>, rusqlite::Error> {
        let conn = self.db.lock().unwrap();
        let query = format!("SELECT {} FROM projects WHERE id = ?", SELECT_PROJECT_FIELDS);
        let mut stmt = conn.prepare(&query)?;

        let res = stmt.query_row(params![id], row_to_project).optional()?;

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
        let mut conn = self.db.lock().unwrap();
        let _ = conn.execute_batch("PRAGMA foreign_keys = OFF;");
        let res = (|| -> Result<(), rusqlite::Error> {
            let tx = conn.transaction()?;
            tx.execute("UPDATE projects SET current_release_id = NULL WHERE id = ?", params![id]).ok();
            tx.execute("DELETE FROM logs WHERE project_id = ?", params![id]).ok();
            tx.execute("DELETE FROM backups WHERE project_id = ?", params![id]).ok();
            tx.execute("DELETE FROM deployments WHERE project_id = ?", params![id]).ok();
            tx.execute("DELETE FROM releases WHERE project_id = ?", params![id]).ok();
            tx.execute("DELETE FROM project_env WHERE project_id = ?", params![id]).ok();
            tx.execute("DELETE FROM project_keys WHERE project_id = ?", params![id]).ok();
            tx.execute("DELETE FROM jobs WHERE project_id = ?", params![id]).ok();
            tx.execute("DELETE FROM audit WHERE project_id = ? AND action != 'website.delete'", params![id]).ok();
            tx.execute("DELETE FROM projects WHERE id = ?", params![id])?;
            tx.commit()?;
            Ok(())
        })();
        let _ = conn.execute_batch("PRAGMA foreign_keys = ON;");
        crate::db::purge_orphaned_project_data(&conn);
        res
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
            let decrypted = self.vault.decrypt(&val_enc).unwrap_or_else(|_| "".to_string());
            let value = if is_secret {
                "********".to_string()
            } else {
                decrypted.clone()
            };
            Ok(EnvVarView {
                key,
                value,
                real_value: decrypted,
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
        self.set_env_var_with_rename(project_id, key, value, is_secret, None)
    }

    pub fn set_env_var_with_rename(
        &self,
        project_id: i64,
        key: &str,
        value: &str,
        is_secret: bool,
        previous_key: Option<&str>,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let clean_key = key.trim();
        if clean_key.is_empty() {
            return Err("Variable key cannot be empty".into());
        }
        let enc = self.vault.encrypt(value)?;
        let mut conn = self.db.lock().unwrap();
        let tx = conn.transaction()?;
        if let Some(prev) = previous_key.map(|s| s.trim()).filter(|s| !s.is_empty()) {
            if prev != clean_key {
                tx.execute(
                    "DELETE FROM project_env WHERE project_id = ? AND key = ?",
                    params![project_id, prev],
                )?;
            }
        }
        tx.execute(
            "INSERT INTO project_env(project_id, key, value_enc, is_secret) VALUES(?, ?, ?, ?)
             ON CONFLICT(project_id, key) DO UPDATE SET value_enc=excluded.value_enc, is_secret=excluded.is_secret",
            params![project_id, clean_key, enc, if is_secret { 1 } else { 0 }],
        )?;
        tx.commit()?;
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

    pub fn set_bulk_env(
        &self,
        project_id: i64,
        raw_or_vars: &str,
        is_secret: bool,
        replace_all: bool,
    ) -> Result<usize, Box<dyn std::error::Error + Send + Sync>> {
        let pairs = parse_dotenv(raw_or_vars);
        if pairs.is_empty() && !replace_all {
            return Ok(0);
        }

        let mut conn = self.db.lock().unwrap();
        let tx = conn.transaction()?;

        if replace_all {
            tx.execute("DELETE FROM project_env WHERE project_id = ?", params![project_id])?;
        }

        let mut count = 0;
        for (k, v) in &pairs {
            let enc = self.vault.encrypt(v)?;
            tx.execute(
                "INSERT INTO project_env(project_id, key, value_enc, is_secret) VALUES(?, ?, ?, ?)
                 ON CONFLICT(project_id, key) DO UPDATE SET value_enc=excluded.value_enc, is_secret=excluded.is_secret",
                params![project_id, k, enc, if is_secret { 1 } else { 0 }],
            )?;
            count += 1;
        }

        tx.commit()?;
        Ok(count)
    }

    pub fn set_batch_env_items(
        &self,
        project_id: i64,
        items: &[EnvVarInput],
        replace_all: bool,
    ) -> Result<usize, Box<dyn std::error::Error + Send + Sync>> {
        let mut conn = self.db.lock().unwrap();
        let tx = conn.transaction()?;

        if replace_all {
            tx.execute("DELETE FROM project_env WHERE project_id = ?", params![project_id])?;
        }

        let mut count = 0;
        for item in items {
            let k = item.key.trim();
            if k.is_empty() {
                continue;
            }
            let enc = self.vault.encrypt(&item.value)?;
            tx.execute(
                "INSERT INTO project_env(project_id, key, value_enc, is_secret) VALUES(?, ?, ?, ?)
                 ON CONFLICT(project_id, key) DO UPDATE SET value_enc=excluded.value_enc, is_secret=excluded.is_secret",
                params![project_id, k, enc, if item.is_secret { 1 } else { 0 }],
            )?;
            count += 1;
        }

        tx.commit()?;
        Ok(count)
    }

    pub fn export_raw_env(&self, project_id: i64) -> Result<String, rusqlite::Error> {
        let conn = self.db.lock().unwrap();
        let mut stmt = conn.prepare("SELECT key, value_enc, is_secret FROM project_env WHERE project_id = ? ORDER BY key ASC")?;
        let rows = stmt.query_map(params![project_id], |r| {
            let key: String = r.get(0)?;
            let val_enc: String = r.get(1)?;
            let is_secret: bool = r.get::<_, i64>(2)? != 0;
            let val = self.vault.decrypt(&val_enc).unwrap_or_default();
            Ok((key, val, is_secret))
        })?;

        let mut out = String::new();
        for r in rows {
            let (k, v, _) = r?;
            if v.contains(' ') || v.contains('\n') || v.contains('"') {
                out.push_str(&format!("{}=\"{}\"\n", k, v.replace('"', "\\\"")));
            } else {
                out.push_str(&format!("{}={}\n", k, v));
            }
        }
        Ok(out)
    }
}

pub fn parse_dotenv(input: &str) -> Vec<(String, String)> {
    let mut vars = Vec::new();
    for raw_line in input.lines() {
        let line = raw_line.trim();
        // Ignore comments and empty lines
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        // Strip optional leading 'export '
        let line = if let Some(stripped) = line.strip_prefix("export ") {
            stripped.trim()
        } else {
            line
        };
        // Split on first '='
        if let Some((k, v)) = line.split_once('=') {
            let key = k.trim().to_string();
            if key.is_empty() {
                continue;
            }
            let mut val = v.trim();
            // Strip matching surrounding quotes if present
            if (val.starts_with('"') && val.ends_with('"') && val.len() >= 2)
                || (val.starts_with('\'') && val.ends_with('\'') && val.len() >= 2)
            {
                val = &val[1..val.len() - 1];
            } else if let Some(idx) = val.find(" #") {
                // If unquoted, strip trailing comment
                val = val[..idx].trim_end();
            }
            vars.push((key, val.to_string()));
        }
    }
    vars
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_dotenv() {
        let sample = r#"
        # Comment line
        PORT=3000
        APP_URL="http://localhost:3000"
        export JWT_SECRET='super-secret-key-123'
        DEBUG=true # inline comment
        SPACED_KEY = value with spaces
        EMPTY_LINE_BEFORE=123
        "#;

        let parsed = parse_dotenv(sample);
        assert_eq!(parsed.len(), 6);
        assert_eq!(parsed[0], ("PORT".into(), "3000".into()));
        assert_eq!(parsed[1], ("APP_URL".into(), "http://localhost:3000".into()));
        assert_eq!(parsed[2], ("JWT_SECRET".into(), "super-secret-key-123".into()));
        assert_eq!(parsed[3], ("DEBUG".into(), "true".into()));
        assert_eq!(parsed[4], ("SPACED_KEY".into(), "value with spaces".into()));
        assert_eq!(parsed[5], ("EMPTY_LINE_BEFORE".into(), "123".into()));
    }
}
