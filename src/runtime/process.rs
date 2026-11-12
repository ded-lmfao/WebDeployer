use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use crate::db::now;
use crate::projects::Project;
use super::Runtime;

pub use super::tree::{detect_java_exe, is_pid_alive};

impl Runtime {
    pub async fn start_project(
        &self,
        p: &Project,
        env_vars: HashMap<String, String>,
        release_dir: Option<&Path>,
    ) -> Result<u32, String> {
        let proj_lock = self.get_project_lock(p.id);
        let _guard = proj_lock.lock().await;

        // First shut down any existing process or port listener for this website
        self.kill_project_everything(p).await;

        if p.start_cmd.trim().is_empty() {
            return Err("No start command configured for this project".to_string());
        }

        let container = self.ensure_container(p);
        let port_str = container.port.to_string();
        let resolved_cmd = p.start_cmd.replace("{{PORT}}", &port_str);

        // Normalize base deploy directory to an absolute OS path
        let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
        let raw_base = Path::new(&p.deploy_dir);
        let base_dir: PathBuf = if raw_base.is_absolute() {
            raw_base.to_path_buf()
        } else {
            let s = p.deploy_dir.trim_start_matches("./").trim_start_matches(".\\");
            cwd.join(s)
        };
        let _ = tokio::fs::create_dir_all(&base_dir).await;

        // Determine working directory where package.json/built files exist
        let current_path = base_dir.join("current");
        async fn check_dir(d: &Path) -> bool {
            tokio::fs::metadata(d).await.map(|m| m.is_dir()).unwrap_or(false)
        }

        let mut work_dir: Option<PathBuf> = None;
        if let Some(rd) = release_dir {
            let abs_rd = if rd.is_absolute() {
                rd.to_path_buf()
            } else {
                let s = rd.to_string_lossy();
                cwd.join(s.trim_start_matches("./").trim_start_matches(".\\"))
            };
            if check_dir(&abs_rd).await {
                work_dir = Some(abs_rd);
            }
        }
        if work_dir.is_none() && check_dir(&current_path).await {
            work_dir = Some(current_path);
        }
        if work_dir.is_none() {
            // Check releases directory for the latest release
            let releases_dir = base_dir.join("releases");
            if check_dir(&releases_dir).await {
                if let Ok(mut entries) = tokio::fs::read_dir(&releases_dir).await {
                    let mut max_id = 0i64;
                    let mut latest: Option<PathBuf> = None;
                    while let Ok(Some(e)) = entries.next_entry().await {
                        let path = e.path();
                        if check_dir(&path).await {
                            let n = e.file_name().to_string_lossy().to_string();
                            if let Some(id_str) = n.strip_prefix("rel-") {
                                if let Ok(id) = id_str.parse::<i64>() {
                                    if id > max_id {
                                        max_id = id;
                                        latest = Some(path);
                                    }
                                }
                            }
                        }
                    }
                    work_dir = latest;
                }
            }
        }

        let work_dir = match work_dir {
            Some(d) => d,
            None => {
                if p.project_kind == "service" {
                    let app_dir = base_dir.join("app");
                    let _ = tokio::fs::create_dir_all(&app_dir).await;
                    app_dir
                } else {
                    return Err("NOT_DEPLOYED_YET".to_string());
                }
            }
        };

        // Link `<work_dir>/data` into the isolated container's `db/` directory
        let is_service = p.project_kind == "service";
        if !is_service {
            self.link_work_dir_to_container(&work_dir, &container);
        }

        // Build isolated container environment and write `.env` into working directory
        // (backend services own their files, so their .env is never rewritten)
        let (isolated_env, dotenv_body) = self.build_container_env(p, &env_vars, &container);
        if !is_service {
            let _ = tokio::fs::write(work_dir.join(".env"), dotenv_body).await;
        }

        // Shell execution: supports npx, npm, node, yarn, python, uvicorn on any OS
        let mut final_cmd = resolved_cmd;
        if final_cmd.contains("vite preview") && work_dir.join("server.js").exists() {
            final_cmd = "node server.js".to_string();
        }

        #[cfg(unix)]
        {
            // Auto-resolve 'python' to 'python3' on Linux distributions (Ubuntu/Debian) where 'python' symlink is absent
            let has_python = std::path::Path::new("/usr/bin/python").exists()
                || std::path::Path::new("/usr/local/bin/python").exists()
                || work_dir.join(".venv/bin/python").exists()
                || work_dir.join("venv/bin/python").exists();

            if !has_python && final_cmd.contains("python") {
                let parts: Vec<&str> = final_cmd.split(' ').collect();
                final_cmd = parts
                    .into_iter()
                    .map(|token| if token == "python" { "python3" } else { token })
                    .collect::<Vec<_>>()
                    .join(" ");
            }
        }

        let java_info = detect_java_exe();

        #[cfg(windows)]
        let mut cmd = tokio::process::Command::new("cmd");
        #[cfg(windows)]
        {
            cmd.arg("/C");
            cmd.raw_arg(&final_cmd);
        }

        #[cfg(unix)]
        let mut cmd = tokio::process::Command::new("sh");
        #[cfg(unix)]
        cmd.args(["-c", &final_cmd]);

        cmd.current_dir(&work_dir);
        cmd.stdin(Stdio::null());
        cmd.stdout(Stdio::piped());
        cmd.stderr(Stdio::piped());
        // Do NOT kill the child process if WebDep drops its handle or restarts for an update!
        cmd.kill_on_drop(false);

        #[cfg(unix)]
        unsafe {
            cmd.pre_exec(|| {
                // Detach into independent session so panel restarts never signal or terminate the workload
                libc::setsid();
                Ok(())
            });
        }

        // Force UTF-8 output so Python/Node apps printing emoji or arrows never crash on the
        // Windows 'charmap' codec when stdout is piped. User env vars below can still override these.
        cmd.env("PYTHONIOENCODING", "utf-8");
        cmd.env("PYTHONUTF8", "1");
        cmd.env("PYTHONUNBUFFERED", "1");
        cmd.env("PIP_BREAK_SYSTEM_PACKAGES", "1");
        cmd.env("WEBDEP_PROJECT_ID", p.id.to_string());
        cmd.env("WEBDEP_PROJECT_SLUG", &p.slug);
        cmd.env("WEBDEP_CONTAINER_ID", &container.container_id);

        if let Some((_, ref java_home)) = java_info {
            let bin_dir = java_home.join("bin");
            let cur_path = std::env::var("PATH").unwrap_or_default();
            #[cfg(windows)]
            let new_path = format!("{};{}", bin_dir.display(), cur_path);
            #[cfg(unix)]
            let new_path = format!("{}:{}", bin_dir.display(), cur_path);

            cmd.env("PATH", new_path);
            cmd.env("JAVA_HOME", java_home);
        }

        // Auto-detect virtualenv (.venv or venv) in workspace and route python/node/bin tools to it
        let venv_dir = if work_dir.join(".venv").is_dir() {
            Some(work_dir.join(".venv"))
        } else if work_dir.join("venv").is_dir() {
            Some(work_dir.join("venv"))
        } else {
            None
        };
        if let Some(ref venv) = venv_dir {
            #[cfg(windows)]
            let venv_bin = venv.join("Scripts");
            #[cfg(not(windows))]
            let venv_bin = venv.join("bin");

            if venv_bin.exists() {
                let cur_path = std::env::var("PATH").unwrap_or_default();
                #[cfg(windows)]
                let new_path = format!("{};{}", venv_bin.display(), cur_path);
                #[cfg(not(windows))]
                let new_path = format!("{}:{}", venv_bin.display(), cur_path);

                cmd.env("PATH", new_path);
                cmd.env("VIRTUAL_ENV", venv);
            }
        }

        for (k, v) in &isolated_env {
            cmd.env(k, v);
        }

        let mut child = cmd.spawn().map_err(|e| {
            format!(
                "Failed to spawn process '{}' in '{}': {}",
                final_cmd,
                work_dir.display(),
                e
            )
        })?;

        let pid = child.id().unwrap_or(0);
        self.record_container_pid(&container, pid);

        // Asynchronously drain stdout and stderr to prevent OS pipe buffers from filling and blocking the child process
        let run_dir = container.run_dir.clone();
        if let Some(stdout) = child.stdout.take() {
            let logs_clone = self.logs.clone();
            let proj_id = p.id;
            let run_dir_clone = run_dir.clone();
            tokio::spawn(async move {
                use tokio::io::{AsyncBufReadExt, BufReader};
                let mut reader = BufReader::new(stdout).lines();
                while let Ok(Some(line)) = reader.next_line().await {
                    logs_clone.add(Some(proj_id), None, "app", "info", &line);
                    // Dynamically detect any child worker PIDs spawned by multi-bot launchers or subprocesses
                    // e.g. "[MULTI-BOT] Spawned bot 'bot1' (PID 75100)" or "PID: 1234"
                    if let Some(pos) = line.find("PID") {
                        let rem = &line[pos + 3..];
                        let num_str: String = rem
                            .chars()
                            .skip_while(|c| !c.is_ascii_digit())
                            .take_while(|c| c.is_ascii_digit())
                            .collect();
                        if let Ok(cpid) = num_str.parse::<u32>() {
                            if cpid > 0 {
                                let pid_file = run_dir_clone.join("pids.txt");
                                if let Ok(mut f) = std::fs::OpenOptions::new()
                                    .create(true)
                                    .append(true)
                                    .open(&pid_file)
                                {
                                    use std::io::Write;
                                    let _ = writeln!(f, "{}", cpid);
                                }
                            }
                        }
                    }
                }
            });
        }

        if let Some(stderr) = child.stderr.take() {
            let logs_clone = self.logs.clone();
            let proj_id = p.id;
            tokio::spawn(async move {
                use tokio::io::{AsyncBufReadExt, BufReader};
                let mut reader = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = reader.next_line().await {
                    logs_clone.add(Some(proj_id), None, "app", "warn", &line);
                }
            });
        }

        // Wait briefly (250ms) and verify child process didn't immediately fail/exit
        tokio::time::sleep(Duration::from_millis(250)).await;

        if let Ok(Some(status)) = child.try_wait() {
            self.mark_project_stopped(p.id);
            let err_msg = format!("Process exited immediately with code {}", status);
            self.logs.add(Some(p.id), None, "app", "warn", &err_msg);
            return Err(err_msg);
        }

        if p.port.is_some() {
            for port_pid in Self::find_pids_on_port(container.port) {
                self.record_container_pid(&container, port_pid);
            }
        }

        // Update database status
        let ts = now();
        {
            let conn = self.db.lock().unwrap();
            conn.execute(
                "UPDATE projects SET app_status='running', app_pid=?, app_started_at=? WHERE id=?",
                rusqlite::params![pid, ts, p.id],
            )
            .ok();
        }

        self.logs.add(
            Some(p.id),
            None,
            "app",
            "info",
            &if p.project_kind == "service" {
                format!(
                    "Started service '{}' with command '{}' (PID: {}, folder: {})",
                    p.name,
                    final_cmd,
                    pid,
                    work_dir.display()
                )
            } else {
                format!(
                    "Started container '{}' process '{}' (PID: {}, Port: {}, DB: {})",
                    container.container_id,
                    final_cmd,
                    pid,
                    container.port,
                    container.db_dir.display()
                )
            },
        );

        {
            let mut map = self.processes.lock().unwrap();
            map.insert(p.id, child);
        }
        Ok(pid)
    }



    pub(crate) fn mark_project_stopped(&self, project_id: i64) {
        if let Ok(conn) = self.db.lock() {
            let _ = conn.execute(
                "UPDATE projects SET app_status='stopped', app_pid=NULL, app_started_at=NULL WHERE id=?",
                rusqlite::params![project_id],
            );
        }
    }



    pub async fn stop_project(&self, p: &Project) -> Result<(), String> {
        // Bump stop_seq first so any in-progress deployment knows Stop was requested
        self.bump_stop_seq(p.id);

        // Immediately update SQLite status to stopped
        self.mark_project_stopped(p.id);

        // Acquire per-project lock and synchronously terminate all processes + port listeners for this website
        let proj_lock = self.get_project_lock(p.id);
        let _guard = proj_lock.lock().await;
        self.kill_project_everything(p).await;

        // Re-ensure SQLite status is stopped in case a concurrent start finished just before the lock
        self.mark_project_stopped(p.id);

        self.logs.add(
            Some(p.id),
            None,
            "app",
            "info",
            &if p.project_kind == "service" {
                format!("Stopped service '{}' (all processes terminated)", p.name)
            } else {
                format!(
                    "Stopped website container '{}' (Port {} released and all processes terminated)",
                    p.name,
                    p.port.unwrap_or(3000)
                )
            },
        );

        Ok(())
    }



    pub fn is_running(&self, project_id: i64) -> bool {
        let mut map = match self.processes.lock() {
            Ok(m) => m,
            Err(_) => return false,
        };
        if let Some(child) = map.get_mut(&project_id) {
            match child.try_wait() {
                Ok(Some(_status)) => {
                    map.remove(&project_id);
                    false
                }
                Ok(None) => true,
                Err(_) => {
                    map.remove(&project_id);
                    false
                }
            }
        } else {
            // If process was started by a previous panel instance before update/restart,
            // check if the recorded SQLite app_pid is still alive on the system
            if let Ok(conn) = self.db.lock() {
                if let Ok(Some(pid)) = conn.query_row(
                    "SELECT app_pid FROM projects WHERE id = ? AND app_status = 'running'",
                    rusqlite::params![project_id],
                    |r| r.get::<_, Option<u32>>(0),
                ) {
                    if pid > 0 && is_pid_alive(pid) {
                        return true;
                    }
                }
            }
            false
        }
    }

}
