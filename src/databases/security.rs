use std::path::Path;
#[cfg(unix)]
use tokio::process::Command;

pub fn generate_pg_hba(access_mode: &str, allowed_ips: &str) -> String {
    let mut hba = String::new();
    hba.push_str("# PostgreSQL Client Authentication Configuration File (WebDep Managed)\n");
    hba.push_str("# TYPE  DATABASE        USER            ADDRESS                 METHOD\n");
    // Unix-socket ("local") rules are not supported on Windows and make PostgreSQL reject pg_hba.conf
    if !cfg!(windows) {
        hba.push_str("local   all             all                                     trust\n");
    }
    hba.push_str("host    all             all             127.0.0.1/32            scram-sha-256\n");
    hba.push_str("host    all             all             ::1/128                 scram-sha-256\n");

    if access_mode == "public" {
        hba.push_str("host    all             all             0.0.0.0/0               scram-sha-256\n");
        hba.push_str("host    all             all             ::/0                    scram-sha-256\n");
    } else if access_mode == "allowlist" {
        for raw in allowed_ips.split(|c| c == ',' || c == '\n' || c == ';') {
            let ip = raw.trim();
            if ip.is_empty() {
                continue;
            }
            let cidr = if ip.contains('/') {
                ip.to_string()
            } else if ip.contains(':') {
                format!("{}/128", ip)
            } else {
                format!("{}/32", ip)
            };
            hba.push_str(&format!("host    all             all             {:<23} scram-sha-256\n", cidr));
        }
    }

    hba
}

pub fn to_clean_path_str(path: &Path) -> String {
    let s = path.to_string_lossy().to_string();
    if let Some(stripped) = s.strip_prefix(r"\\?\") {
        stripped.to_string()
    } else {
        s
    }
}

pub fn read_pg_pid(data_dir: &Path) -> Option<u32> {
    let pid_file = data_dir.join("postmaster.pid");
    if let Ok(content) = std::fs::read_to_string(pid_file) {
        if let Some(first_line) = content.lines().next() {
            if let Ok(pid) = first_line.trim().parse::<u32>() {
                return Some(pid);
            }
        }
    }
    None
}

pub async fn wait_for_pg_ready(port: u16, data_dir: &Path, max_wait_ms: u64) -> Option<u32> {
    let start = std::time::Instant::now();
    let addr = format!("127.0.0.1:{}", port);
    while start.elapsed().as_millis() < max_wait_ms as u128 {
        if let Some(pid) = read_pg_pid(data_dir) {
            if is_process_alive(pid) && tokio::net::TcpStream::connect(&addr).await.is_ok() {
                return Some(pid);
            }
        }
        tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;
    }
    None
}

pub fn is_process_alive(pid: u32) -> bool {
    if pid == 0 {
        return false;
    }
    let mut sys = sysinfo::System::new();
    let sys_pid = sysinfo::Pid::from_u32(pid);
    sys.refresh_processes(sysinfo::ProcessesToUpdate::Some(&[sys_pid]), true);
    sys.process(sys_pid).is_some()
}

pub async fn sync_firewall_rules(port: u16, access_mode: &str, allowed_ips: &str) {
    #[cfg(unix)]
    {
        if access_mode == "local" {
            let _ = Command::new("sudo").args(["ufw", "delete", "allow", &format!("{}/tcp", port)]).output().await;
        } else if access_mode == "public" {
            let _ = Command::new("sudo").args(["ufw", "allow", &format!("{}/tcp", port)]).output().await;
        } else if access_mode == "allowlist" {
            let _ = Command::new("sudo").args(["ufw", "delete", "allow", &format!("{}/tcp", port)]).output().await;
            for ip in allowed_ips.split(|c| c == ',' || c == '\n' || c == ';') {
                let ip = ip.trim();
                if !ip.is_empty() {
                    let _ = Command::new("sudo")
                        .args(["ufw", "allow", "proto", "tcp", "from", ip, "to", "any", "port", &port.to_string()])
                        .output()
                        .await;
                }
            }
        }
    }
    #[cfg(not(unix))]
    {
        let _ = (port, access_mode, allowed_ips);
    }
}

pub async fn remove_firewall_rules(port: u16, allowed_ips: &str) {
    #[cfg(unix)]
    {
        let _ = Command::new("sudo").args(["ufw", "delete", "allow", &format!("{}/tcp", port)]).output().await;
        for ip in allowed_ips.split(|c| c == ',' || c == '\n' || c == ';') {
            let ip = ip.trim();
            if !ip.is_empty() {
                let _ = Command::new("sudo")
                    .args(["ufw", "delete", "allow", "proto", "tcp", "from", ip, "to", "any", "port", &port.to_string()])
                    .output()
                    .await;
            }
        }
    }
    #[cfg(not(unix))]
    {
        let _ = (port, allowed_ips);
    }
}
