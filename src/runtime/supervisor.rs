use std::sync::Arc;
use std::time::Duration;

use super::process::is_pid_alive;
use super::Runtime;

impl Runtime {

    /// Background task to continuously supervise long-running processes (services, bots, servers)
    /// and immediately mark them stopped in SQLite and log warnings when they exit or crash.
    pub fn start_background_monitor(self: &Arc<Self>) {
        let rt = self.clone();
        tokio::spawn(async move {
            let mut tick = 0u64;
            loop {
                tokio::time::sleep(Duration::from_secs(2)).await;
                tick = tick.wrapping_add(1);
                let mut exited = Vec::new();
                {
                    if let Ok(mut map) = rt.processes.lock() {
                        for (&proj_id, child) in map.iter_mut() {
                            match child.try_wait() {
                                Ok(Some(status)) => {
                                    exited.push((proj_id, Some(status)));
                                }
                                Err(_) => {
                                    exited.push((proj_id, None));
                                }
                                Ok(None) => {}
                            }
                        }
                        for (proj_id, _) in &exited {
                            map.remove(proj_id);
                        }
                    }
                }
                for (proj_id, status) in exited {
                    rt.mark_project_stopped(proj_id);
                    let msg = match status {
                        Some(s) => format!("Process exited ({})", s),
                        None => "Process terminated unexpectedly".to_string(),
                    };
                    rt.logs.add(Some(proj_id), None, "system", "warn", &msg);
                }

                // Every 6s (every 3rd tick), also check preserved workloads from previous panel instances
                if tick % 3 == 0 {
                    let external_running: Vec<(i64, u32)> = {
                        if let Ok(conn) = rt.db.lock() {
                            if let Ok(mut stmt) = conn.prepare("SELECT id, app_pid FROM projects WHERE app_status = 'running'") {
                                let rows = stmt.query_map([], |r| {
                                    Ok((r.get::<_, i64>(0)?, r.get::<_, Option<u32>>(1)?))
                                });
                                if let Ok(mapped) = rows {
                                    mapped
                                        .flatten()
                                        .filter_map(|(id, opt_pid)| opt_pid.map(|p| (id, p)))
                                        .collect()
                                } else {
                                    Vec::new()
                                }
                            } else {
                                Vec::new()
                            }
                        } else {
                            Vec::new()
                        }
                    };

                    for (proj_id, pid) in external_running {
                        let is_in_memory = rt.processes.lock().map(|m| m.contains_key(&proj_id)).unwrap_or(false);
                        if !is_in_memory && !is_pid_alive(pid) {
                            let still_listening = {
                                if let Ok(conn) = rt.db.lock() {
                                    conn.query_row("SELECT port FROM projects WHERE id = ?", rusqlite::params![proj_id], |r| r.get::<_, Option<u16>>(0))
                                        .ok()
                                        .flatten()
                                        .map(|port| !Runtime::find_pids_on_port(port).is_empty())
                                        .unwrap_or(false)
                                } else {
                                    false
                                }
                            };
                            if !still_listening {
                                rt.mark_project_stopped(proj_id);
                                rt.logs.add(Some(proj_id), None, "system", "warn", "Process terminated");
                            }
                        }
                    }
                }
            }
        });
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

        Err(format!(
            "Health check timed out after {}s (endpoint: {}): {}",
            timeout_s, url, last_err
        ))
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
        if res_line.contains("200")
            || res_line.contains("204")
            || res_line.contains("301")
            || res_line.contains("302")
            || res_line.contains("304")
        {
            return Ok(true);
        }
    }
    Ok(true)
}

