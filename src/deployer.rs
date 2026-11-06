use rusqlite::params;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::time::{sleep, Duration};

use crate::cache::AppCache;
use crate::db::{now, DbPool};
use crate::git::{CommitInfo, Git};
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
    db: DbPool,
    logs: Logs,
    projects: Arc<Projects>,
    runtime: Arc<Runtime>,
    cache: Arc<AppCache>,
    data_dir: PathBuf,
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
            db,
            logs,
            projects,
            runtime,
            cache,
            data_dir,
        }
    }

    pub fn list_deployments(&self, project_id: Option<i64>, limit: usize) -> Vec<Deployment> {
        let conn = self.db.lock().unwrap();
        let mut sql = "SELECT d.id, d.project_id, p.name, d.release_id, d.from_release_id, d.kind, d.status, d.stage, d.sha, d.trigger, d.actor, d.error, d.started_at, d.finished_at FROM deployments d LEFT JOIN projects p ON p.id = d.project_id".to_string();
        let mut params_vec: Vec<rusqlite::types::Value> = Vec::new();

        if let Some(pid) = project_id {
            sql.push_str(" WHERE d.project_id = ?");
            params_vec.push(pid.into());
        }
        sql.push_str(&format!(" ORDER BY d.id DESC LIMIT {}", limit));

        let mut stmt = match conn.prepare(&sql) {
            Ok(s) => s,
            Err(_) => return Vec::new(),
        };

        let params_slice: Vec<&dyn rusqlite::ToSql> = params_vec.iter().map(|v| v as &dyn rusqlite::ToSql).collect();
        let rows = stmt.query_map(params_slice.as_slice(), |r| {
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
        });

        match rows {
            Ok(r) => r.flatten().collect(),
            Err(_) => Vec::new(),
        }
    }

    pub fn get_deployment(&self, id: i64) -> Option<Deployment> {
        let conn = self.db.lock().unwrap();
        conn.query_row(
            "SELECT d.id, d.project_id, p.name, d.release_id, d.from_release_id, d.kind, d.status, d.stage, d.sha, d.trigger, d.actor, d.error, d.started_at, d.finished_at
             FROM deployments d LEFT JOIN projects p ON p.id = d.project_id WHERE d.id = ?",
            rusqlite::params![id],
            |r| {
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
            },
        ).ok()
    }

    pub fn list_releases(&self, project_id: i64) -> Vec<Release> {
        let p = match self.projects.get(project_id) {
            Ok(Some(p)) => p,
            _ => return Vec::new(),
        };

        let conn = self.db.lock().unwrap();
        let mut stmt = match conn.prepare(
            "SELECT r.id, r.project_id, r.sha, r.short_sha, r.message, r.author, r.committed_at, r.dir, r.status, r.error, r.created_at, r.deployed_at,
                    (SELECT id FROM deployments WHERE release_id = r.id ORDER BY id DESC LIMIT 1) as dep_id
             FROM releases r WHERE r.project_id = ? ORDER BY r.id DESC",
        ) {
            Ok(s) => s,
            Err(_) => return Vec::new(),
        };

        let rows = stmt.query_map(params![project_id], |r| {
            let id: i64 = r.get(0)?;
            let dir: String = r.get(7)?;
            let status: String = r.get(8)?;
            let is_live = p.current_release_id == Some(id);
            let available = Path::new(&dir).exists();
            let build_status = if status == "succeeded" || status == "pulled" {
                "success".to_string()
            } else {
                status.clone()
            };
            let health_status = if status == "succeeded" {
                "ok".to_string()
            } else {
                "pending".to_string()
            };

            Ok(Release {
                id,
                project_id: r.get(1)?,
                sha: r.get(2)?,
                short_sha: r.get(3)?,
                message: r.get(4)?,
                author: r.get(5)?,
                committed_at: r.get(6)?,
                dir,
                status,
                build_status,
                health_status,
                deployment_id: r.get(12)?,
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
        let id = {
            let conn = self.db.lock().unwrap();
            conn.execute(
                "INSERT INTO deployments(project_id, kind, status, stage, trigger, actor, started_at) VALUES(?, ?, 'pending', 'pending', ?, ?, ?)",
                params![p.id, kind, trigger, actor, ts],
            ).ok();
            conn.last_insert_rowid()
        };
        self.cache.invalidate_project(p.id);
        id
    }

    pub fn update_stage(&self, dep_id: i64, stage: &str) {
        let conn = self.db.lock().unwrap();
        conn.execute(
            "UPDATE deployments SET stage=?, status='running' WHERE id=?",
            params![stage, dep_id],
        ).ok();
        drop(conn);
        self.cache.invalidate_prefix("overview:");
        self.cache.invalidate_prefix("deployments:");
    }

    pub fn finish_deployment(&self, dep_id: i64, status: &str, error: Option<&str>) {
        let ts = now();
        let conn = self.db.lock().unwrap();
        conn.execute(
            "UPDATE deployments SET status=?, stage=?, error=?, finished_at=? WHERE id=?",
            params![status, status, error, ts, dep_id],
        ).ok();

        let mut pid_opt = None;
        if let Ok((proj_id, kind, actor, sha, proj_name)) = conn.query_row(
            "SELECT d.project_id, d.kind, d.actor, COALESCE(d.sha, ''), COALESCE(p.name, '')
             FROM deployments d LEFT JOIN projects p ON p.id = d.project_id WHERE d.id = ?",
            params![dep_id],
            |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, String>(3)?, r.get::<_, String>(4)?)),
        ) {
            pid_opt = Some(proj_id);
            let short = if sha.len() >= 7 { &sha[..7] } else { &sha };
            let action = format!("{}.{}", kind, status);
            let detail = match error {
                Some(err) => format!("Deployment #{} failed: {}", dep_id, err),
                None => format!("Deployment #{} completed ({})", dep_id, if short.is_empty() { "live" } else { short }),
            };
            conn.execute(
                "INSERT INTO audit(project_id, ts, actor, action, target, detail, ip) VALUES(?, ?, ?, ?, ?, ?, '127.0.0.1')",
                params![proj_id, ts, actor, action, proj_name, detail],
            ).ok();
        }
        drop(conn);
        if let Some(pid) = pid_opt {
            self.cache.invalidate_project(pid);
        } else {
            self.cache.invalidate_all();
        }
    }

    pub async fn run_deploy(self: Arc<Self>, project_id: i64, dep_id: i64) {
        let p = match self.projects.get(project_id) {
            Ok(Some(p)) => p,
            _ => {
                self.finish_deployment(dep_id, "failed", Some("Project not found"));
                return;
            }
        };

        let start_stop_seq = self.runtime.get_stop_seq(p.id);
        let container = self.runtime.ensure_container(&p);
        self.logs.add(
            Some(p.id),
            Some(dep_id),
            "deployment",
            "info",
            &format!(
                "Starting deployment #{} for {} in isolated container '{}' (Port: {}, DB: {})",
                dep_id,
                p.name,
                container.container_id,
                container.port,
                container.db_dir.display()
            ),
        );

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

        // Link release `data/` folder to isolated container DB and write container-isolated .env
        self.runtime.link_work_dir_to_container(&release_dir, &container);
        let env_map = self.projects.get_env_map(p.id);
        let (_isolated_env, dotenv_body) = self.runtime.build_container_env(&p, &env_map, &container);
        let _ = fs::write(release_dir.join(".env"), dotenv_body);

        // Stage 3: Installing dependencies
        let has_pkg_json = release_dir.join("package.json").exists();
        let effective_install_cmd = if !p.install_cmd.trim().is_empty() {
            p.install_cmd.clone()
        } else if has_pkg_json {
            "npm install".to_string()
        } else {
            String::new()
        };

        if !effective_install_cmd.trim().is_empty() {
            self.update_stage(dep_id, "installing");
            self.logs.add(Some(p.id), Some(dep_id), "build", "info", &format!("Running install: {}", effective_install_cmd));
            if let Err(e) = run_shell_cmd(&effective_install_cmd, &release_dir, &self.logs, p.id, dep_id).await {
                if effective_install_cmd.contains("npm ci") && has_pkg_json {
                    self.logs.add(Some(p.id), Some(dep_id), "build", "warn", "npm ci failed, falling back to npm install...");
                    if let Err(e2) = run_shell_cmd("npm install", &release_dir, &self.logs, p.id, dep_id).await {
                        self.logs.add(Some(p.id), Some(dep_id), "build", "error", &format!("Install failed: {}", e2));
                        self.finish_deployment(dep_id, "failed", Some(&e2));
                        return;
                    }
                } else {
                    self.logs.add(Some(p.id), Some(dep_id), "build", "error", &format!("Install failed: {}", e));
                    self.finish_deployment(dep_id, "failed", Some(&e));
                    return;
                }
            }
        }

        // Stage 4: Building (auto-detect 'npm run build' if build_cmd is empty but package.json has a build script)
        let effective_build_cmd = if !p.build_cmd.trim().is_empty() {
            p.build_cmd.clone()
        } else {
            let pkg_path = release_dir.join("package.json");
            if pkg_path.exists() {
                if let Ok(pkg_txt) = fs::read_to_string(&pkg_path) {
                    if pkg_txt.contains("\"build\"") {
                        "npm run build".to_string()
                    } else {
                        String::new()
                    }
                } else {
                    String::new()
                }
            } else {
                String::new()
            }
        };

        if !effective_build_cmd.trim().is_empty() {
            self.update_stage(dep_id, "building");
            self.logs.add(Some(p.id), Some(dep_id), "build", "info", &format!("Running build: {}", effective_build_cmd));
            if let Err(e) = run_shell_cmd(&effective_build_cmd, &release_dir, &self.logs, p.id, dep_id).await {
                self.logs.add(Some(p.id), Some(dep_id), "build", "error", &format!("Build failed: {}", e));
                self.finish_deployment(dep_id, "failed", Some(&e));
                return;
            }
        }

        // Stage 5: Deploying (Atomic Symlink Switch)
        self.update_stage(dep_id, "deploying");
        let current_symlink = Path::new(&p.deploy_dir).join("current");
        switch_current(&current_symlink, &release_dir);

        // Stage 6: Health Checking
        if self.runtime.get_stop_seq(p.id) != start_stop_seq {
            self.logs.add(
                Some(p.id),
                Some(dep_id),
                "deployment",
                "warn",
                "Website was stopped by user during deployment — release built and linked without starting process.",
            );
            let ts = now();
            {
                let conn = self.db.lock().unwrap();
                conn.execute("UPDATE releases SET status='succeeded', deployed_at=? WHERE id=?", params![ts, release_id]).ok();
                conn.execute("UPDATE projects SET current_release_id=?, deployed_sha=?, updated_at=? WHERE id=?", params![release_id, head, ts, p.id]).ok();
            }
            self.finish_deployment(dep_id, "success", None);
            return;
        }

        self.update_stage(dep_id, "health_checking");
        let env_map = self.projects.get_env_map(p.id);
        if let Err(e) = self.runtime.start_project(&p, env_map, Some(&release_dir)).await {
            self.logs.add(Some(p.id), Some(dep_id), "app", "error", &format!("Start failed: {}", e));
            self.finish_deployment(dep_id, "failed", Some(&e));
            return;
        }

        if !p.health_url.trim().is_empty() {
            let port_str = p.port.unwrap_or(3000).to_string();
            let resolved_health_url = p.health_url.replace("{{PORT}}", &port_str);
            self.logs.add(Some(p.id), Some(dep_id), "health", "info", &format!("Probing health check URL: {}", resolved_health_url));
            if let Err(e) = self.runtime.health_check(&resolved_health_url, p.health_timeout_s as u64).await {
                self.logs.add(Some(p.id), Some(dep_id), "health", "error", &format!("Health check failed: {}", e));
                self.finish_deployment(dep_id, "failed", Some(&e));
                return;
            }
        }

        // Stability window
        if p.stability_s > 0 {
            sleep(Duration::from_secs(p.stability_s as u64)).await;
        }

        // Mark success & record backup snapshot in SQLite
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
            conn.execute(
                "INSERT INTO backups(project_id, path, size_bytes, note, created_at) VALUES(?, ?, ?, ?, ?)",
                params![
                    p.id,
                    release_dir.to_str().unwrap_or(""),
                    5 * 1024 * 1024i64,
                    format!("Auto-snapshot for Release #{} ({})", release_id, commit_info.short_sha),
                    ts
                ],
            ).ok();
        }

        self.logs.add(Some(p.id), Some(dep_id), "deployment", "info", "Deployment completed successfully! Version is live.");
        self.finish_deployment(dep_id, "success", None);
    }

    pub async fn run_rollback(self: Arc<Self>, project_id: i64, dep_id: i64, target_release_id: i64) {
        let p = match self.projects.get(project_id) {
            Ok(Some(p)) => p,
            _ => {
                self.finish_deployment(dep_id, "failed", Some("Project not found"));
                return;
            }
        };

        let releases = self.list_releases(project_id);
        let target = releases
            .into_iter()
            .find(|r| r.id == target_release_id)
            .or_else(|| self.list_releases(project_id).into_iter().find(|r| r.status == "succeeded"));

        let target = match target {
            Some(r) => r,
            None => {
                self.run_deploy(project_id, dep_id).await;
                return;
            }
        };

        self.logs.add(
            Some(p.id),
            Some(dep_id),
            "rollback",
            "info",
            &format!("Rolling back {} to Release #{} ({})", p.name, target.id, target.short_sha),
        );

        {
            let conn = self.db.lock().unwrap();
            conn.execute(
                "UPDATE deployments SET release_id=?, from_release_id=?, sha=? WHERE id=?",
                params![target.id, p.current_release_id, target.sha, dep_id],
            ).ok();
        }

        self.update_stage(dep_id, "deploying");
        let release_dir = PathBuf::from(&target.dir);
        if !release_dir.exists() {
            self.run_deploy(project_id, dep_id).await;
            return;
        }

        let current_symlink = Path::new(&p.deploy_dir).join("current");
        switch_current(&current_symlink, &release_dir);

        self.update_stage(dep_id, "health_checking");
        let env_map = self.projects.get_env_map(p.id);
        if let Err(e) = self.runtime.start_project(&p, env_map, Some(&release_dir)).await {
            self.logs.add(Some(p.id), Some(dep_id), "rollback", "error", &format!("Start failed: {}", e));
            self.finish_deployment(dep_id, "failed", Some(&e));
            return;
        }

        let ts = now();
        {
            let conn = self.db.lock().unwrap();
            conn.execute(
                "UPDATE projects SET current_release_id=?, deployed_sha=?, updated_at=? WHERE id=?",
                params![target.id, target.sha, ts, p.id],
            ).ok();
        }

        self.logs.add(Some(p.id), Some(dep_id), "rollback", "info", &format!("Rollback to Release #{} succeeded!", target.id));
        self.finish_deployment(dep_id, "success", None);
    }
}

fn switch_current(current_link: &Path, target_dir: &Path) {
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let abs_link = if current_link.is_absolute() {
        current_link.to_path_buf()
    } else {
        let stripped = current_link.to_string_lossy();
        let clean = stripped.strip_prefix("./").or_else(|| stripped.strip_prefix(".\\")).unwrap_or(&stripped);
        cwd.join(clean)
    };
    let abs_target = std::fs::canonicalize(target_dir).unwrap_or_else(|_| {
        if target_dir.is_absolute() {
            target_dir.to_path_buf()
        } else {
            let stripped = target_dir.to_string_lossy();
            let clean = stripped.strip_prefix("./").or_else(|| stripped.strip_prefix(".\\")).unwrap_or(&stripped);
            cwd.join(clean)
        }
    });
    // Strip Windows \\?\ extended-length prefix if canonicalize added it, as cmd mklink /J prefers standard paths
    let target_str = abs_target.to_string_lossy().trim_start_matches(r"\\?\").to_string();
    let link_str = abs_link.to_string_lossy().trim_start_matches(r"\\?\").to_string();

    if abs_link.exists() || fs::symlink_metadata(&abs_link).is_ok() {
        #[cfg(windows)]
        {
            let _ = std::process::Command::new("cmd")
                .args(["/C", "rmdir", &link_str])
                .output();
        }
        let _ = fs::remove_file(&abs_link);
        let _ = fs::remove_dir_all(&abs_link);
    }
    #[cfg(windows)]
    {
        // Try mklink /J (NTFS junction, does not require admin rights) with absolute paths
        let _ = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J", &link_str, &target_str])
            .output();
    }
    #[cfg(unix)]
    {
        let _ = std::os::unix::fs::symlink(&abs_target, &abs_link);
    }
}

async fn run_shell_cmd(
    cmd_str: &str,
    cwd: &Path,
    logs: &Logs,
    project_id: i64,
    dep_id: i64,
) -> Result<(), String> {
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

    let stdout_str = String::from_utf8_lossy(&out.stdout);
    for line in stdout_str.lines() {
        let trimmed = line.trim();
        if !trimmed.is_empty() {
            logs.add(Some(project_id), Some(dep_id), "build", "info", trimmed);
        }
    }

    let stderr_str = String::from_utf8_lossy(&out.stderr);
    for line in stderr_str.lines() {
        let trimmed = line.trim();
        if !trimmed.is_empty() {
            let lvl = if out.status.success() { "info" } else { "error" };
            logs.add(Some(project_id), Some(dep_id), "build", lvl, trimmed);
        }
    }

    if out.status.success() {
        Ok(())
    } else {
        Err(stderr_str.to_string())
    }
}

