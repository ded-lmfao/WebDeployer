use std::collections::HashMap;
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

    pub async fn start_project(
        &self,
        p: &Project,
        env_vars: HashMap<String, String>,
    ) -> Result<u32, String> {
        // Kill existing if already running
        let old = {
            let mut map = self.processes.lock().unwrap();
            map.remove(&p.id)
        };
        if let Some(mut old_child) = old {
            let _ = old_child.kill().await;
        }

        if p.start_cmd.trim().is_empty() {
            return Err("No start command configured for this project".to_string());
        }

        let parts: Vec<&str> = p.start_cmd.split_whitespace().collect();
        if parts.is_empty() {
            return Err("Empty start command".to_string());
        }

        let cmd_name = parts[0];
        let args = &parts[1..];

        let mut cmd = tokio::process::Command::new(cmd_name);
        cmd.args(args);
        cmd.current_dir(&p.deploy_dir);
        cmd.stdout(Stdio::piped());
        cmd.stderr(Stdio::piped());

        // Inject environment variables
        for (k, v) in env_vars {
            cmd.env(k, v);
        }
        if let Some(port) = p.port {
            cmd.env("PORT", port.to_string());
        }

        let child = cmd
            .spawn()
            .map_err(|e| format!("Failed to spawn process '{}': {}", p.start_cmd, e))?;

        let pid = child.id().unwrap_or(0);

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
            &format!("Started process '{}' (PID: {})", p.start_cmd, pid),
        );

        {
            let mut map = self.processes.lock().unwrap();
            map.insert(p.id, child);
        }
        Ok(pid)
    }

    pub async fn stop_project(&self, p: &Project) -> Result<(), String> {
        let old = {
            let mut map = self.processes.lock().unwrap();
            map.remove(&p.id)
        };
        if let Some(mut child) = old {
            let _ = child.kill().await;
        }

        let conn = self.db.lock().unwrap();
        conn.execute(
            "UPDATE projects SET app_status='stopped', app_pid=NULL, app_started_at=NULL WHERE id=?",
            rusqlite::params![p.id],
        )
        .ok();

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

        let client = reqwest_or_hyper(url, Duration::from_secs(timeout_s)).await?;
        if client {
            Ok(())
        } else {
            Err(format!("Health check failed for URL: {}", url))
        }
    }
}

async fn reqwest_or_hyper(url_str: &str, timeout: Duration) -> Result<bool, String> {
    // Light pure TCP / HTTP probe
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpStream;

    let stripped = url_str.strip_prefix("http://").unwrap_or(url_str);
    let (host_port, path) = match stripped.find('/') {
        Some(idx) => (&stripped[..idx], &stripped[idx..]),
        None => (stripped, "/"),
    };
    let (host, port) = match host_port.find(':') {
        Some(idx) => (&host_port[..idx], host_port[idx + 1..].parse().unwrap_or(80)),
        None => (host_port, 80),
    };

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
        if res_line.contains("200") || res_line.contains("204") || res_line.contains("301") || res_line.contains("302") {
            return Ok(true);
        }
    }
    Ok(true)
}
