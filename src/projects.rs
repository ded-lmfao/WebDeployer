use rusqlite::{params, OptionalExtension};
use std::sync::Arc;

use crate::db::{now, DbPool};
use crate::vault::Vault;

pub mod models;
pub use models::*;

pub struct Projects {
    db: DbPool,
    vault: Arc<Vault>,
}

impl Projects {
    pub fn new(db: DbPool, vault: Arc<Vault>) -> Self {
        Self { db, vault }
    }

    pub fn list(&self) -> Result<Vec<Project>, rusqlite::Error> {
        let conn = self.db.lock().unwrap();
        let query = format!("SELECT {} FROM projects ORDER BY id DESC", SELECT_PROJECT_FIELDS);
        let mut stmt = conn.prepare(&query)?;

        let rows = stmt.query_map([], row_to_project)?;

        let mut list = Vec::new();
        for r in rows {
            let mut p = r?;
            if p.port.is_none() || p.port == Some(0) {
                let default_start = if p.project_kind == "service" { 8000 } else { 3000 };
                if let Ok(new_port) = crate::db::allocate_global_unique_port(&conn, None, default_start, Some(p.id), None) {
                    let _ = conn.execute("UPDATE projects SET port = ? WHERE id = ?", params![new_port as u32, p.id]);
                    p.port = Some(new_port);
                }
            }
            list.push(p);
        }
        Ok(list)
    }

    pub fn get(&self, id: i64) -> Result<Option<Project>, rusqlite::Error> {
        let conn = self.db.lock().unwrap();
        let query = format!("SELECT {} FROM projects WHERE id = ?", SELECT_PROJECT_FIELDS);
        let mut stmt = conn.prepare(&query)?;

        let res = stmt.query_row(params![id], row_to_project).optional()?;

        if let Some(mut p) = res {
            if p.port.is_none() || p.port == Some(0) {
                let default_start = if p.project_kind == "service" { 8000 } else { 3000 };
                if let Ok(new_port) = crate::db::allocate_global_unique_port(&conn, None, default_start, Some(p.id), None) {
                    let _ = conn.execute("UPDATE projects SET port = ? WHERE id = ?", params![new_port as u32, p.id]);
                    p.port = Some(new_port);
                }
            }
            return Ok(Some(p));
        }

        Ok(None)
    }

    pub fn create(&self, p: &Project) -> Result<i64, Box<dyn std::error::Error + Send + Sync>> {
        let ts = now();
        let domains_json = serde_json::to_string(&p.domains)?;

        let conn = self.db.lock().unwrap();
        let final_port = if let Some(req) = p.port.filter(|&pt| pt > 0) {
            crate::db::allocate_global_unique_port(&conn, Some(req), req, None, None).unwrap_or(req)
        } else {
            let default_start = if p.project_kind == "service" { 8000 } else { 3000 };
            crate::db::allocate_global_unique_port(&conn, None, default_start, None, None).unwrap_or(default_start)
        };

        conn.execute(
            "INSERT INTO projects(
                name, slug, repo_url, branch, project_type, deploy_method, deploy_dir, port,
                install_cmd, build_cmd, start_cmd, health_url, health_timeout_s,
                stability_s, auto_deploy, webhook_secret,
                app_status, domains, ssl_email,
                created_at, updated_at, project_kind, access_mode, allowed_ips
            ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            params![
                p.name,
                p.slug,
                p.repo_url,
                p.branch,
                p.project_type,
                p.deploy_method,
                p.deploy_dir,
                final_port as u32,
                p.install_cmd,
                p.build_cmd,
                p.start_cmd,
                p.health_url,
                p.health_timeout_s,
                p.stability_s,
                if p.auto_deploy { 1 } else { 0 },
                p.webhook_secret,
                "stopped",
                domains_json,
                p.ssl_email,
                ts,
                ts,
                p.project_kind,
                p.access_mode,
                p.allowed_ips,
            ],
        )?;

        let id = conn.last_insert_rowid();
        Ok(id)
    }

    pub fn update(&self, id: i64, p: &Project) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let ts = now();
        let domains_json = serde_json::to_string(&p.domains)?;

        let conn = self.db.lock().unwrap();
        let final_port = if let Some(req) = p.port.filter(|&pt| pt > 0) {
            crate::db::allocate_global_unique_port(&conn, Some(req), req, Some(id), None).unwrap_or(req)
        } else {
            let default_start = if p.project_kind == "service" { 8000 } else { 3000 };
            crate::db::allocate_global_unique_port(&conn, None, default_start, Some(id), None).unwrap_or(default_start)
        };

        conn.execute(
            "UPDATE projects SET
                name=?, repo_url=?, branch=?, project_type=?, deploy_method=?, deploy_dir=?, port=?,
                install_cmd=?, build_cmd=?, start_cmd=?, health_url=?, health_timeout_s=?,
                stability_s=?, auto_deploy=?,
                domains=?, ssl_email=?, updated_at=?,
                project_kind=?, access_mode=?, allowed_ips=?
             WHERE id=?",
            params![
                p.name,
                p.repo_url,
                p.branch,
                p.project_type,
                p.deploy_method,
                p.deploy_dir,
                final_port as u32,
                p.install_cmd,
                p.build_cmd,
                p.start_cmd,
                p.health_url,
                p.health_timeout_s,
                p.stability_s,
                if p.auto_deploy { 1 } else { 0 },
                domains_json,
                p.ssl_email,
                ts,
                p.project_kind,
                p.access_mode,
                p.allowed_ips,
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

    #[test]
    fn test_project_kind_service_and_default() {
        let json_default = r#"{
            "name": "My Web App",
            "slug": "my-web-app",
            "repo_url": "https://github.com/org/repo"
        }"#;
        let proj_web: Project = serde_json::from_str(json_default).unwrap();
        assert_eq!(proj_web.project_kind, "web");

        let json_service = r#"{
            "name": "Discord Music Bot",
            "slug": "discord-music-bot",
            "repo_url": "https://github.com/org/bot",
            "project_kind": "service",
            "project_type": "discord-node",
            "start_cmd": "node index.js"
        }"#;
        let proj_service: Project = serde_json::from_str(json_service).unwrap();
        assert_eq!(proj_service.project_kind, "service");
        assert_eq!(proj_service.project_type, "discord-node");
        assert_eq!(proj_service.start_cmd, "node index.js");
    }

    #[test]
    fn test_project_db_roundtrip() {
        let temp_dir = std::env::temp_dir().join(format!("webdep-test-{}", now()));
        std::fs::create_dir_all(&temp_dir).unwrap();
        let pool = crate::db::open_db(&temp_dir).unwrap();
        let vault = Arc::new(crate::vault::Vault::new(&temp_dir).unwrap());
        let projects = Projects::new(pool, vault);

        let json_service = r#"{
            "name": "Discord Music Bot",
            "slug": "discord-music-bot",
            "repo_url": "https://github.com/org/bot",
            "project_kind": "service",
            "project_type": "discord-node",
            "start_cmd": "node index.js"
        }"#;
        let mut proj: Project = serde_json::from_str(json_service).unwrap();
        proj.deploy_dir = temp_dir.to_string_lossy().to_string();
        let id = projects.create(&proj).unwrap();
        let fetched = projects.get(id).unwrap().unwrap();
        assert_eq!(fetched.project_kind, "service");
        assert_eq!(fetched.name, "Discord Music Bot");
        assert!(fetched.port.is_some() && fetched.port.unwrap() >= 8000);

        let list = projects.list().unwrap();
        assert!(list.iter().any(|p| p.id == id && p.project_kind == "service"));

        std::fs::remove_dir_all(&temp_dir).ok();
    }
}
