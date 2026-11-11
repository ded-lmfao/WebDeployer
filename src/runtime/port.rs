use std::collections::HashSet;
use std::process::Stdio;
use std::time::Duration;

use super::Runtime;

impl Runtime {
    /// Automatically open `port/tcp` in UFW and iptables on Linux so newly created servers/websites
    /// are reachable without manual firewall commands.
    pub fn allow_firewall_port(&self, port: u16, project_id: Option<i64>) {
        if port == 0 {
            return;
        }
        if let Ok(mut set) = self.allowed_ports.lock() {
            if !set.insert(port) {
                return;
            }
        }

        #[cfg(unix)]
        {
            let logs = self.logs.clone();
            std::thread::spawn(move || {
                let cmd = format!(
                    "(sudo -n ufw allow {p}/tcp >/dev/null 2>&1 || ufw allow {p}/tcp >/dev/null 2>&1 || true) && \
                     (sudo -n iptables -C INPUT -p tcp --dport {p} -m conntrack --ctstate NEW -j ACCEPT >/dev/null 2>&1 || \
                      sudo -n iptables -I INPUT 1 -p tcp --dport {p} -m conntrack --ctstate NEW -j ACCEPT >/dev/null 2>&1 || true)",
                    p = port
                );
                if let Ok(out) = std::process::Command::new("sh").arg("-c").arg(&cmd).output() {
                    if out.status.success() && project_id.is_some() {
                        logs.add(
                            project_id,
                            None,
                            "system",
                            "info",
                            &format!("Automatically allowed TCP port {}/tcp in UFW & iptables firewall", port),
                        );
                    }
                }
            });
        }
        #[cfg(not(unix))]
        {
            let _ = project_id;
        }
    }


    /// Find all OS process IDs currently listening on `port`.
    pub fn find_pids_on_port(port: u16) -> Vec<u32> {
        let mut pids = HashSet::new();
        let self_pid = std::process::id();

        #[cfg(windows)]
        {
            if let Ok(out) = std::process::Command::new("netstat")
                .args(["-ano", "-p", "TCP"])
                .stdin(Stdio::null())
                .stderr(Stdio::null())
                .output()
            {
                let text = String::from_utf8_lossy(&out.stdout);
                let port_suffix = format!(":{}", port);
                for line in text.lines() {
                    let parts: Vec<&str> = line.split_whitespace().collect();
                    // Proto LocalAddress ForeignAddress State PID
                    if parts.len() >= 5 && parts[3].eq_ignore_ascii_case("LISTENING") {
                        let local_addr = parts[1];
                        if local_addr.ends_with(&port_suffix) {
                            if let Ok(pid) = parts[4].parse::<u32>() {
                                if pid > 0 && pid != self_pid {
                                    pids.insert(pid);
                                }
                            }
                        }
                    }
                }
            }
        }

        #[cfg(unix)]
        {
            if let Ok(out) = std::process::Command::new("lsof")
                .args(["-ti", &format!("tcp:{}", port)])
                .stdin(Stdio::null())
                .stderr(Stdio::null())
                .output()
            {
                let text = String::from_utf8_lossy(&out.stdout);
                for line in text.lines() {
                    if let Ok(pid) = line.trim().parse::<u32>() {
                        if pid > 0 && pid != self_pid {
                            pids.insert(pid);
                        }
                    }
                }
            }
        }

        pids.into_iter().collect()
    }



    pub async fn is_port_accepting(port: u16) -> bool {
        tokio::time::timeout(
            Duration::from_millis(150),
            tokio::net::TcpStream::connect(("127.0.0.1", port)),
        )
        .await
        .map(|r| r.is_ok())
        .unwrap_or(false)
    }

}
