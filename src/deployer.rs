use rusqlite::params;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::time::{sleep, Duration};

use crate::db::{now, DbPool};
use crate::git::{CommitInfo, Git};
use crate::logs::Logs;
use crate::projects::{Project, Projects};
use crate::runtime::Runtime;

#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct Deployment {
    pub id: i64,
    pub project_id: i64,
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
    pub error: Option<String>,
    pub created_at: i64,
    pub deployed_at: Option<i64>,
    pub live: bool,
    pub available: bool,
}

pub struct Deployer {
    db: DbPool,
    logs: Logs,
    projects: Arc<Projects>,
    runtime: Arc<Runtime>,
    data_dir: PathBuf,
}

impl Deployer {
    pub fn new(
        db: DbPool,
        logs: Logs,
        projects: Arc<Projects>,
        runtime: Arc<Runtime>,
        data_dir: PathBuf,
    ) -> Self {
        Self {
            db,
            logs,
            projects,
            runtime,
            data_dir,
        }
    }

    pub fn list_deployments(&self, project_id: Option<i64>, limit: usize) -> Vec<Deployment> {
        let conn = self.db.lock().unwrap();
        let mut sql = "SELECT id, project_id, release_id, from_release_id, kind, status, stage, sha, trigger, actor, error, started_at, finished_at FROM deployments".to_string();
        let mut params_vec: Vec<rusqlite::types::Value> = Vec::new();

        if let Some(pid) = project_id {
            sql.push_str(" WHERE project_id = ?");
            params_vec.push(pid.into());
        }
        sql.push_str(&format!(" ORDER BY id DESC LIMIT {}", limit));

        let mut stmt = match conn.prepare(&sql) {
            Ok(s) => s,
            Err(_) => return Vec::new(),
        };

        let params_slice: Vec<&dyn rusqlite::ToSql> = params_vec.iter().map(|v| v as &dyn rusqlite::ToSql).collect();
        let rows = stmt.query_map(params_slice.as_slice(), |r| {
            Ok(Deployment {
                id: r.get(0)?,
                project_id: r.get(1)?,
                release_id: r.get(2)?,
                from_release_id: r.get(3)?,
                kind: r.get(4)?,
                status: r.get(5)?,
                stage: r.get(6)?,
                sha: r.get(7)?,
                trigger: r.get(8)?,
                actor: r.get(9)?,
                error: r.get(10)?,
                started_at: r.get(11)?,
                finished_at: r.get(12)?,
            })
        });

        match rows {
            Ok(r) => r.flatten().collect(),
            Err(_) => Vec::new(),
        }
    }

    pub fn list_releases(&self, project_id: i64) -> Vec<Release> {
        let p = match self.projects.get(project_id) {
            Ok(Some(p)) => p,
            _ => return Vec::new(),
        };

        let conn = self.db.lock().unwrap();
        let mut stmt = match conn.prepare(
            "SELECT id, project_id, sha, short_sha, message, author, committed_at, dir, status, error, created_at, deployed_at
             FROM releases WHERE project_id = ? ORDER BY id DESC",
        ) {
            Ok(s) => s,
            Err(_) => return Vec::new(),
        };

        let rows = stmt.query_map(params![project_id], |r| {
            let id: i64 = r.get(0)?;
            let dir: String = r.get(7)?;
            let is_live = p.current_release_id == Some(id);
            let available = Path::new(&dir).exists();

            Ok(Release {
                id,
                project_id: r.get(1)?,
                sha: r.get(2)?,
                short_sha: r.get(3)?,
                message: r.get(4)?,
                author: r.get(5)?,
                committed_at: r.get(6)?,
                dir,
                status: r.get(8)?,
                error: r.get(9)?,
                created_at: r.get(10)?,
                deployed_at: r.get(11)?,
                live: is_live,
                available,
            })
        });

        match rows {
            Ok(r) => r.flatten().collect(),
            Err(_) => Vec::new(),
        }
    }

    pub fn create_deployment(&self, p: &Project, kind: &str, actor: &str, trigger: &str) -> i64 {
        let ts = now();
        let conn = self.db.lock().unwrap();
        conn.execute(
            "INSERT INTO deployments(project_id, kind, status, stage, trigger, actor, started_at) VALUES(?, ?, 'pending', 'pending', ?, ?, ?)",
            params![p.id, kind, trigger, actor, ts],
        ).ok();
        conn.last_insert_rowid()
    }

    pub fn update_stage(&self, dep_id: i64, stage: &str) {
        let conn = self.db.lock().unwrap();
        conn.execute(
            "UPDATE deployments SET stage=?, status='running' WHERE id=?",
            params![stage, dep_id],
        ).ok();
    }

    pub fn finish_deployment(&self, dep_id: i64, status: &str, error: Option<&str>) {
        let ts = now();
        let conn = self.db.lock().unwrap();
        conn.execute(
            "UPDATE deployments SET status=?, stage=?, error=?, finished_at=? WHERE id=?",
            params![status, status, error, ts, dep_id],
        ).ok();
    }

    pub async fn run_deploy(self: Arc<Self>, project_id: i64, dep_id: i64) {
        let p = match self.projects.get(project_id) {
            Ok(Some(p)) => p,
            _ => {
                self.finish_deployment(dep_id, "failed", Some("Project not found"));
                return;
            }
        };

        self.logs.add(Some(p.id), Some(dep_id), "deployment", "info", &format!("Starting deployment #{} for {}", dep_id, p.name));

        // Stage 1: Fetching
        self.update_stage(dep_id, "fetching");
        let repo_dir = Path::new(&p.deploy_dir).join("repo");
        if let Err(e) = Git::clone_or_fetch(&p.repo_url, &repo_dir, &p.branch) {
            self.logs.add(Some(p.id), Some(dep_id), "github", "error", &format!("Git fetch failed: {}", e));
            self.finish_deployment(dep_id, "failed", Some(&e));
            return;
        }

        let head = match Git::resolve_head(&repo_dir) {
            Ok(h) => h,
            Err(e) => {
                self.finish_deployment(dep_id, "failed", Some(&e));
                return;
            }
        };

        // Stage 2: Pulling
        self.update_stage(dep_id, "pulling");
        let release_dir = Path::new(&p.deploy_dir).join("releases").join(format!("rel-{}", dep_id));
        if let Err(e) = Git::checkout(&repo_dir, &head, &release_dir) {
            self.logs.add(Some(p.id), Some(dep_id), "deployment", "error", &format!("Checkout error: {}", e));
            self.finish_deployment(dep_id, "failed", Some(&e));
            return;
        }

        let commit_info = Git::get_commit_info(&repo_dir, &head).unwrap_or(CommitInfo {
            sha: head.clone(),
            short_sha: head[..7.min(head.len())].to_string(),
            author: "System".to_string(),
            date: now(),
            message: "Deploy".to_string(),
        });

        // Insert release record
        let release_id = {
            let conn = self.db.lock().unwrap();
            conn.execute(
                "INSERT INTO releases(project_id, sha, short_sha, message, author, committed_at, dir, status, created_at)
                 VALUES(?, ?, ?, ?, ?, ?, ?, 'pulled', ?)",
                params![p.id, head, commit_info.short_sha, commit_info.message, commit_info.author, commit_info.date, release_dir.to_str().unwrap_or(""), now()],
            ).ok();
            conn.last_insert_rowid()
        };

        {
            let conn = self.db.lock().unwrap();
            conn.execute("UPDATE deployments SET release_id=?, sha=? WHERE id=?", params![release_id, head, dep_id]).ok();
        }

        // Stage 3: Installing dependencies
        if !p.install_cmd.trim().is_empty() {
            self.update_stage(dep_id, "installing");
            self.logs.add(Some(p.id), Some(dep_id), "build", "info", &format!("Running install: {}", p.install_cmd));
            if let Err(e) = run_shell_cmd(&p.install_cmd, &release_dir).await {
                self.finish_deployment(dep_id, "failed", Some(&e));
                return;
            }
        }

        // Stage 4: Building
        if !p.build_cmd.trim().is_empty() {
            self.update_stage(dep_id, "building");
            self.logs.add(Some(p.id), Some(dep_id), "build", "info", &format!("Running build: {}", p.build_cmd));
            if let Err(e) = run_shell_cmd(&p.build_cmd, &release_dir).await {
                self.finish_deployment(dep_id, "failed", Some(&e));
                return;
            }
        }

        // Stage 5: Deploying (Atomic Symlink Switch)
        self.update_stage(dep_id, "deploying");
        let current_symlink = Path::new(&p.deploy_dir).join("current");
        switch_current(&current_symlink, &release_dir);

        // Stage 6: Health Checking
        self.update_stage(dep_id, "health_checking");
        let env_map = self.projects.get_env_map(p.id);
        if let Err(e) = self.runtime.start_project(&p, env_map).await {
            self.logs.add(Some(p.id), Some(dep_id), "app", "error", &format!("Start failed: {}", e));
            self.finish_deployment(dep_id, "failed", Some(&e));
            return;
        }

        if !p.health_url.trim().is_empty() {
            self.logs.add(Some(p.id), Some(dep_id), "health", "info", &format!("Probing health check URL: {}", p.health_url));
            if let Err(e) = self.runtime.health_check(&p.health_url, p.health_timeout_s as u64).await {
                self.logs.add(Some(p.id), Some(dep_id), "health", "error", &format!("Health check failed: {}", e));
                self.finish_deployment(dep_id, "failed", Some(&e));
                return;
            }
        }

        // Stability window
        if p.stability_s > 0 {
            sleep(Duration::from_secs(p.stability_s as u64)).await;
        }

        // Mark success
        let ts = now();
        {
            let conn = self.db.lock().unwrap();
            conn.execute(
                "UPDATE releases SET status='succeeded', deployed_at=? WHERE id=?",
                params![ts, release_id],
            ).ok();
            conn.execute(
                "UPDATE projects SET current_release_id=?, deployed_sha=?, updated_at=? WHERE id=?",
                params![release_id, head, ts, p.id],
            ).ok();
        }

        self.logs.add(Some(p.id), Some(dep_id), "deployment", "info", "Deployment completed successfully! Version is live.");
        self.finish_deployment(dep_id, "success", None);
    }
}

fn switch_current(current_link: &Path, target_dir: &Path) {
    if current_link.exists() || fs::symlink_metadata(current_link).is_ok() {
        let _ = fs::remove_file(current_link);
        let _ = fs::remove_dir_all(current_link);
    }
    #[cfg(windows)]
    {
        let _ = std::os::windows::fs::symlink_dir(target_dir, current_link);
    }
    #[cfg(unix)]
    {
        let _ = std::os::unix::fs::symlink(target_dir, current_link);
    }
}

async fn run_shell_cmd(cmd_str: &str, cwd: &Path) -> Result<(), String> {
    #[cfg(windows)]
    let mut cmd = tokio::process::Command::new("cmd");
    #[cfg(windows)]
    cmd.args(["/C", cmd_str]);

    #[cfg(unix)]
    let mut cmd = tokio::process::Command::new("sh");
    #[cfg(unix)]
    cmd.args(["-c", cmd_str]);

    cmd.current_dir(cwd);
    let out = cmd.output().await.map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).to_string())
    }
}

