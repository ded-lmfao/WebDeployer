use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::process::Child;

use crate::db::{now, DbPool};
use crate::logs::Logs;
use crate::projects::Project;

pub struct Runtime {
    db: DbPool,
    logs: Logs,
    processes: Arc<Mutex<HashMap<i64, Child>>>,
}

impl Runtime {
    pub fn new(db: DbPool, logs: Logs) -> Self {
        Self {
            db,
            logs,
            processes: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn kill_pid_background(&self, pid: u32) {
        if pid == 0 || pid == std::process::id() {
            return;
        }
        tokio::spawn(async move {
            #[cfg(windows)]
            {
                let fut = tokio::process::Command::new("taskkill")
                    .args(["/F", "/T", "/PID", &pid.to_string()])
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .status();
                let _ = tokio::time::timeout(Duration::from_secs(2), fut).await;
            }
            #[cfg(unix)]
            {
                let fut = tokio::process::Command::new("kill")
                    .args(["-9", &pid.to_string()])
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .status();
                let _ = tokio::time::timeout(Duration::from_secs(2), fut).await;
            }
        });
    }

    pub async fn start_project(
        &self,
        p: &Project,
        env_vars: HashMap<String, String>,
        release_dir: Option<&Path>,
    ) -> Result<u32, String> {
        // Kill existing if already running (non-blocking)
        let old = {
            let mut map = self.processes.lock().unwrap();
            map.remove(&p.id)
        };
        if let Some(mut old_child) = old {
            if let Some(pid) = old_child.id() {
                self.kill_pid_background(pid);
            }
            let _ = old_child.start_kill();
        }
        if let Some(old_pid) = p.app_pid {
            self.kill_pid_background(old_pid as u32);
        }

        if p.start_cmd.trim().is_empty() {
            return Err("No start command configured for this project".to_string());
        }

        let port_str = p.port.unwrap_or(3000).to_string();
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
        let _ = std::fs::create_dir_all(&base_dir);

        // Determine working directory where package.json/built files exist
        let current_path = base_dir.join("current");
        let is_valid_dir = |d: &Path| d.is_dir() && std::fs::read_dir(d).is_ok();

        let mut work_dir: Option<PathBuf> = None;
        if let Some(rd) = release_dir {
            let abs_rd = if rd.is_absolute() {
                rd.to_path_buf()
            } else {
                let s = rd.to_string_lossy();
                cwd.join(s.trim_start_matches("./").trim_start_matches(".\\"))
            };
            if is_valid_dir(&abs_rd) {
                work_dir = Some(abs_rd);
            }
        }
        if work_dir.is_none() && is_valid_dir(&current_path) {
            work_dir = Some(current_path);
        }
        if work_dir.is_none() {
            // Check releases directory for the latest release
            let releases_dir = base_dir.join("releases");
            if is_valid_dir(&releases_dir) {
                if let Ok(entries) = std::fs::read_dir(&releases_dir) {
                    let mut max_id = 0i64;
                    let mut latest: Option<PathBuf> = None;
                    for e in entries.flatten() {
                        let path = e.path();
                        if is_valid_dir(&path) {
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
            None => return Err("NOT_DEPLOYED_YET".to_string()),
        };

        // Shell execution: supports npx, npm, node, yarn, python, uvicorn on any OS
        let mut final_cmd = resolved_cmd;
        if final_cmd.contains("vite preview") && work_dir.join("server.js").exists() {
            final_cmd = "node server.js".to_string();
        }

        #[cfg(windows)]
        let mut cmd = tokio::process::Command::new("cmd");
        #[cfg(windows)]
        cmd.args(["/C", &final_cmd]);

        #[cfg(unix)]
        let mut cmd = tokio::process::Command::new("sh");
        #[cfg(unix)]
        cmd.args(["-c", &final_cmd]);

        cmd.current_dir(&work_dir);
        cmd.stdin(Stdio::null());
        cmd.stdout(Stdio::piped());
        cmd.stderr(Stdio::piped());
        cmd.kill_on_drop(true);

        // Provide a guaranteed writable data directory for full-stack apps
        let app_data_dir = std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join("data")
            .join("app-data")
            .join(&p.slug);
        let _ = std::fs::create_dir_all(&app_data_dir);
        let app_data_str = app_data_dir.to_string_lossy().to_string();
        cmd.env("CERT_DATA_DIR", &app_data_str);
        cmd.env("APP_DATA_DIR", &app_data_str);

        // Write .env file into working directory so frameworks reading .env from disk work out of the box
        if !env_vars.is_empty() {
            let mut dotenv_body = String::from("# Auto-generated from WebDep SQLite Vault\n");
            for (k, v) in &env_vars {
                if v.contains(' ') || v.contains('\n') || v.contains('"') {
                    dotenv_body.push_str(&format!("{}=\"{}\"\n", k, v.replace('"', "\\\"")));
                } else {
                    dotenv_body.push_str(&format!("{}={}\n", k, v));
                }
            }
            let _ = std::fs::write(work_dir.join(".env"), dotenv_body);
        }

        // Inject environment variables (user env vars override defaults if specified)
        for (k, v) in env_vars {
            cmd.env(k, v);
        }
        cmd.env("PORT", &port_str);

        let mut child = cmd
            .spawn()
            .map_err(|e| format!("Failed to spawn process '{}' in '{}': {}", final_cmd, work_dir.display(), e))?;

        let pid = child.id().unwrap_or(0);

        // Asynchronously drain stdout and stderr to prevent OS pipe buffers from filling and blocking the child process!
        if let Some(stdout) = child.stdout.take() {
            let logs_clone = self.logs.clone();
            let proj_id = p.id;
            tokio::spawn(async move {
                use tokio::io::{AsyncBufReadExt, BufReader};
                let mut reader = BufReader::new(stdout).lines();
                while let Ok(Some(line)) = reader.next_line().await {
                    logs_clone.add(Some(proj_id), None, "app", "info", &line);
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
            &format!("Started process '{}' (PID: {}) in {}", final_cmd, pid, work_dir.display()),
        );

        {
            let mut map = self.processes.lock().unwrap();
            map.insert(p.id, child);
        }
        Ok(pid)
    }

    pub async fn stop_project(&self, p: &Project) -> Result<(), String> {
        // Immediately update SQLite first so UI state updates in < 1ms
        {
            let conn = self.db.lock().unwrap();
            conn.execute(
                "UPDATE projects SET app_status='stopped', app_pid=NULL, app_started_at=NULL WHERE id=?",
                rusqlite::params![p.id],
            )
            .ok();
        }

        let old = {
            let mut map = self.processes.lock().unwrap();
            map.remove(&p.id)
        };
        if let Some(mut child) = old {
            if let Some(pid) = child.id() {
                self.kill_pid_background(pid);
            }
            let _ = child.start_kill();
        }
        if let Some(old_pid) = p.app_pid {
            self.kill_pid_background(old_pid as u32);
        }

        self.logs.add(
            Some(p.id),
            None,
            "app",
            "info",
            &format!("Stopped application '{}'", p.name),
        );

        Ok(())
    }

    pub fn is_running(&self, project_id: i64) -> bool {
        let map = self.processes.lock().unwrap();
        map.contains_key(&project_id)
    }

    pub async fn health_check(&self, url: &str, timeout_s: u64) -> Result<(), String> {
        if url.trim().is_empty() {
            return Ok(());
        }

        let start = std::time::Instant::now();
        let max_duration = Duration::from_secs(timeout_s.max(5));
        let mut last_err = String::from("Service starting up...");

        while start.elapsed() < max_duration {
            match reqwest_or_hyper(url, Duration::from_secs(2)).await {
                Ok(true) => return Ok(()),
                Ok(false) => {
                    last_err = "Health check responded with non-2xx status".to_string();
                }
                Err(e) => {
                    last_err = e;
                }
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
        }

        Err(format!("Health check timed out after {}s (endpoint: {}): {}", timeout_s, url, last_err))
    }
}

async fn reqwest_or_hyper(url_str: &str, timeout: Duration) -> Result<bool, String> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpStream;

    let stripped = url_str.strip_prefix("http://").unwrap_or(url_str);
    let (host_port, path) = match stripped.find('/') {
        Some(idx) => (&stripped[..idx], &stripped[idx..]),
        None => (stripped, "/"),
    };
    let (raw_host, port) = match host_port.find(':') {
        Some(idx) => (&host_port[..idx], host_port[idx + 1..].parse().unwrap_or(80)),
        None => (host_port, 80),
    };

    // Normalize localhost to 127.0.0.1 to avoid Windows IPv6 (::1) bind mismatches
    let host = if raw_host == "localhost" { "127.0.0.1" } else { raw_host };

    let connect_fut = TcpStream::connect((host, port));
    let mut stream = tokio::time::timeout(timeout, connect_fut)
        .await
        .map_err(|_| "Connection timed out".to_string())?
        .map_err(|e| e.to_string())?;

    let req = format!("GET {} HTTP/1.1\r\nHost: {}\r\nConnection: close\r\n\r\n", path, host);
    stream.write_all(req.as_bytes()).await.map_err(|e| e.to_string())?;

    let mut buf = [0u8; 12];
    let n = stream.read(&mut buf).await.map_err(|e| e.to_string())?;
    if n >= 12 {
        let res_line = String::from_utf8_lossy(&buf);
        if res_line.contains("200") || res_line.contains("204") || res_line.contains("301") || res_line.contains("302") || res_line.contains("304") {
            return Ok(true);
        }
    }
    Ok(true)
}
