pub mod builder;
pub mod worker;

use rusqlite::params;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tokio::sync::Semaphore;

use crate::cache::AppCache;
use crate::db::{now, DbPool};
use crate::logs::Logs;
use crate::projects::{Project, Projects};
use crate::runtime::Runtime;

#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct Deployment {
    pub id: i64,
    pub project_id: i64,
    #[serde(default)]
    pub project_name: Option<String>,
    pub release_id: Option<i64>,
    pub from_release_id: Option<i64>,
    pub kind: String,
    pub status: String,
    pub stage: String,
    pub sha: Option<String>,
    pub trigger: String,
    pub actor: String,
    pub error: Option<String>,
    pub started_at: i64,
    pub finished_at: Option<i64>,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct Release {
    pub id: i64,
    pub project_id: i64,
    pub sha: String,
    pub short_sha: String,
    pub message: Option<String>,
    pub author: Option<String>,
    pub committed_at: Option<i64>,
    pub dir: String,
    pub status: String,
    pub build_status: String,
    pub health_status: String,
    pub deployment_id: Option<i64>,
    pub error: Option<String>,
    pub created_at: i64,
    pub deployed_at: Option<i64>,
    pub live: bool,
    pub available: bool,
}

pub struct Deployer {
    data_dir: PathBuf,
    db: DbPool,
    cache: Arc<AppCache>,
    logs: Logs,
    projects: Arc<Projects>,
    runtime: Arc<Runtime>,
    /// Global FIFO concurrency limit: allows only 1 deployment/rollback at a time to protect 1 GB VPS RAM
    queue_semaphore: Arc<Semaphore>,
    /// Tracks active or queued deployment ID per project_id to prevent duplicate concurrent deployments for the same website
    active_projects: Arc<Mutex<HashMap<i64, i64>>>,
    /// Tracks deployment IDs that already have a worker task spawned
    spawned_deployments: Arc<Mutex<HashSet<i64>>>,
}

const SELECT_DEPLOYMENT_FIELDS: &str = "\
    d.id, d.project_id, p.name, d.release_id, d.from_release_id, d.kind, d.status, d.stage, \
    d.sha, d.trigger, d.actor, d.error, d.started_at, d.finished_at";

fn row_to_deployment(r: &rusqlite::Row) -> Result<Deployment, rusqlite::Error> {
    Ok(Deployment {
        id: r.get(0)?,
        project_id: r.get(1)?,
        project_name: r.get(2)?,
        release_id: r.get(3)?,
        from_release_id: r.get(4)?,
        kind: r.get(5)?,
        status: r.get(6)?,
        stage: r.get(7)?,
        sha: r.get(8)?,
        trigger: r.get(9)?,
        actor: r.get(10)?,
        error: r.get(11)?,
        started_at: r.get(12)?,
        finished_at: r.get(13)?,
    })
}

impl Deployer {
    pub fn new(
        db: DbPool,
        logs: Logs,
        projects: Arc<Projects>,
        runtime: Arc<Runtime>,
        cache: Arc<AppCache>,
        data_dir: PathBuf,
    ) -> Self {
        Self {
            data_dir,
            db,
            cache,
            logs,
            projects,
            runtime,
            queue_semaphore: Arc::new(Semaphore::new(1)),
            active_projects: Arc::new(Mutex::new(HashMap::new())),
            spawned_deployments: Arc::new(Mutex::new(HashSet::new())),
        }
    }

    /// Check if a project currently has an in-flight or queued deployment/rollback
    pub fn has_active_deployment(&self, project_id: i64) -> bool {
        if let Ok(active) = self.active_projects.lock() {
            if let Some(&dep_id) = active.get(&project_id) {
                let conn = self.db.lock().unwrap();
                let status: Option<String> = conn
                    .query_row(
                        "SELECT status FROM deployments WHERE id = ?",
                        params![dep_id],
                        |r| r.get(0),
                    )
                    .ok();
                if let Some(s) = status {
                    if s == "in_progress" || s == "queued" {
                        return true;
                    }
                }
            }
        }
        false
    }

    pub fn last_attempted_sha(&self, project_id: i64) -> Option<String> {
        let conn = self.db.lock().unwrap();
        conn.query_row(
            "SELECT sha FROM deployments WHERE project_id = ? AND sha IS NOT NULL AND trim(sha) != '' ORDER BY id DESC LIMIT 1",
            params![project_id],
            |r| r.get(0),
        )
        .ok()
    }

    pub fn list_deployments(&self, project_id: Option<i64>, limit: usize) -> Vec<Deployment> {
        let conn = self.db.lock().unwrap();
        let (sql, params_vec): (String, Vec<Box<dyn rusqlite::ToSql>>) = match project_id {
            Some(pid) => (
                format!(
                    "SELECT {} FROM deployments d LEFT JOIN projects p ON d.project_id = p.id \
                     WHERE d.project_id = ? ORDER BY d.id DESC LIMIT ?",
                    SELECT_DEPLOYMENT_FIELDS
                ),
                vec![Box::new(pid), Box::new(limit as i64)],
            ),
            None => (
                format!(
                    "SELECT {} FROM deployments d LEFT JOIN projects p ON d.project_id = p.id \
                     ORDER BY d.id DESC LIMIT ?",
                    SELECT_DEPLOYMENT_FIELDS
                ),
                vec![Box::new(limit as i64)],
            ),
        };

        let mut stmt = match conn.prepare(&sql) {
            Ok(s) => s,
            Err(_) => return Vec::new(),
        };
        let param_refs: Vec<&dyn rusqlite::ToSql> = params_vec.iter().map(|b| b.as_ref()).collect();
        stmt.query_map(param_refs.as_slice(), row_to_deployment)
            .map(|rows| rows.filter_map(Result::ok).collect())
            .unwrap_or_default()
    }

    pub fn get_deployment(&self, id: i64) -> Option<Deployment> {
        let conn = self.db.lock().unwrap();
        let sql = format!("SELECT {} FROM deployments d LEFT JOIN projects p ON d.project_id = p.id WHERE d.id = ?", SELECT_DEPLOYMENT_FIELDS);
        conn.query_row(&sql, params![id], row_to_deployment).ok()
    }

    pub fn list_releases(&self, project_id: i64) -> Vec<Release> {
        let conn = self.db.lock().unwrap();
        let current_rel_id: Option<i64> = conn
            .query_row(
                "SELECT current_release_id FROM projects WHERE id = ?",
                params![project_id],
                |r| r.get(0),
            )
            .ok()
            .flatten();

        let mut stmt = match conn.prepare(
            "SELECT id, project_id, sha, short_sha, message, author, committed_at, dir, \
                    status, build_status, health_status, deployment_id, error, created_at, deployed_at \
             FROM releases WHERE project_id = ? ORDER BY id DESC LIMIT 50",
        ) {
            Ok(s) => s,
            Err(_) => return Vec::new(),
        };

        let rows = stmt
            .query_map(params![project_id], |r| {
                let id: i64 = r.get(0)?;
                let dir_str: String = r.get(7)?;
                let status: String = r.get(8)?;
                let dir_path = Path::new(&dir_str);
                let available = dir_path.exists() && status == "succeeded";
                let live = current_rel_id == Some(id);

                Ok(Release {
                    id,
                    project_id: r.get(1)?,
                    sha: r.get(2)?,
                    short_sha: r.get(3)?,
                    message: r.get(4)?,
                    author: r.get(5)?,
                    committed_at: r.get(6)?,
                    dir: dir_str,
                    status,
                    build_status: r.get(9)?,
                    health_status: r.get(10)?,
                    deployment_id: r.get(11)?,
                    error: r.get(12)?,
                    created_at: r.get(13)?,
                    deployed_at: r.get(14)?,
                    live,
                    available,
                })
            })
            .map(|iter| iter.filter_map(Result::ok).collect())
            .unwrap_or_default();

        rows
    }

    pub fn create_deployment(&self, p: &Project, kind: &str, actor: &str, trigger: &str) -> i64 {
        let conn = self.db.lock().unwrap();
        let ts = now();
        conn.execute(
            "INSERT INTO deployments(project_id, kind, status, stage, trigger, actor, started_at) \
             VALUES(?, ?, 'in_progress', 'queued', ?, ?, ?)",
            params![p.id, kind, trigger, actor, ts],
        )
        .ok();
        let id = conn.last_insert_rowid();

        if let Ok(mut active) = self.active_projects.lock() {
            active.insert(p.id, id);
        }

        self.cache.invalidate_project(p.id);

        let action_name = if kind == "rollback" { "rollback.start" } else { "deploy.start" };
        let action_title = if kind == "rollback" { "Rollback" } else { "Deployment" };
        conn.execute(
            "INSERT INTO audit_logs(project_id, action, actor, target, detail, ts) VALUES(?, ?, ?, ?, ?, ?)",
            params![
                p.id,
                action_name,
                actor,
                p.name,
                format!("Triggered {} #{} (Trigger: {})", action_title, id, trigger),
                ts,
            ],
        )
        .ok();

        self.logs.add(
            Some(p.id),
            Some(id),
            if kind == "rollback" { "rollback" } else { "deployment" },
            "info",
            &format!("{} #{} queued by {} ({})", action_title, id, actor, trigger),
        );

        id
    }

    pub fn update_stage(&self, dep_id: i64, stage: &str) {
        let conn = self.db.lock().unwrap();
        let _ = conn.execute(
            "UPDATE deployments SET stage = ? WHERE id = ?",
            params![stage, dep_id],
        );
    }

    pub fn fail_deployment_step(&self, dep_id: i64, project_id: i64, channel: &str, error: &str) {
        self.logs.add(Some(project_id), Some(dep_id), channel, "error", error);
        self.finish_deployment(dep_id, "failed", Some(error));
    }

    pub fn finish_deployment(&self, dep_id: i64, status: &str, error: Option<&str>) {
        let (project_id, prev_stage, kind, actor, target_name) = {
            let conn = self.db.lock().unwrap();
            let _ = conn.execute(
                "UPDATE deployments SET status = ?, error = ?, finished_at = ? WHERE id = ?",
                params![status, error, now(), dep_id],
            );
            conn.query_row(
                "SELECT d.project_id, d.stage, d.kind, d.actor, p.name FROM deployments d LEFT JOIN projects p ON d.project_id = p.id WHERE d.id = ?",
                params![dep_id],
                |r| Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, Option<String>>(4)?.unwrap_or_else(|| "project".to_string())
                )),
            ).unwrap_or((0, "queued".to_string(), "deploy".to_string(), "system".to_string(), "project".to_string()))
        };

        if status == "success" {
            self.update_stage(dep_id, "ready");
        } else if prev_stage == "queued" {
            self.update_stage(dep_id, "failed_queue");
        }

        let is_rollback = kind == "rollback";
        let action_name = if status == "success" {
            if is_rollback { "rollback.success" } else { "deploy.success" }
        } else {
            if is_rollback { "rollback.fail" } else { "deploy.fail" }
        };

        let action_title = if is_rollback { "Rollback" } else { "Deployment" };
        let detail_msg = if status == "success" {
            format!("{} #{} finished successfully", action_title, dep_id)
        } else {
            format!("{} #{} failed: {}", action_title, dep_id, error.unwrap_or("unknown error"))
        };

        {
            let conn = self.db.lock().unwrap();
            conn.execute(
                "INSERT INTO audit_logs(project_id, action, actor, target, detail, ts) VALUES(?, ?, ?, ?, ?, ?)",
                params![project_id, action_name, actor, target_name, detail_msg, now()],
            ).ok();
        }

        if project_id > 0 {
            let pid = project_id;
            if let Ok(mut active_map) = self.active_projects.lock() {
                if active_map.get(&pid) == Some(&dep_id) {
                    active_map.remove(&pid);
                }
            }
            self.cache.invalidate_project(pid);
        } else {
            self.cache.invalidate_all();
        }
        if let Ok(mut spawned) = self.spawned_deployments.lock() {
            spawned.remove(&dep_id);
        }
    }

    async fn acquire_queue_permit(
        &self,
        project_id: i64,
        dep_id: i64,
        action_name: &str,
    ) -> Option<tokio::sync::OwnedSemaphorePermit> {
        match self.queue_semaphore.clone().try_acquire_owned() {
            Ok(p) => Some(p),
            Err(_) => {
                let action_title = if action_name == "rollback" { "Rollback" } else { "Deployment" };
                self.logs.add(
                    Some(project_id),
                    Some(dep_id),
                    action_name,
                    "info",
                    &format!(
                        "{} #{} queued — waiting for current active deployment to finish (1-at-a-time concurrency limit)",
                        action_title, dep_id
                    ),
                );
                match self.queue_semaphore.clone().acquire_owned().await {
                    Ok(p) => Some(p),
                    Err(_) => {
                        self.finish_deployment(dep_id, "failed", Some("Deployment queue closed"));
                        None
                    }
                }
            }
        }
    }
}
