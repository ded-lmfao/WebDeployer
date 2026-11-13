use std::path::Path;
#[cfg(unix)]
use tokio::process::Command;

/// Parse and validate an IPv4/IPv6 address or CIDR notation so malformed/injected rules cannot enter pg_hba.conf or ufw.
pub fn parse_valid_ip_or_cidr(raw: &str) -> Option<String> {
    let s = raw.trim();
    if s.is_empty() {
        return None;
    }
    if let Some((ip_str, mask_str)) = s.split_once('/') {
        let addr: std::net::IpAddr = ip_str.parse().ok()?;
        let mask: u8 = mask_str.parse().ok()?;
        let max_mask = if addr.is_ipv4() { 32 } else { 128 };
        if mask > max_mask {
            return None;
        }
        Some(format!("{}/{}", addr, mask))
    } else {
        let addr: std::net::IpAddr = s.parse().ok()?;
        let mask = if addr.is_ipv4() { 32 } else { 128 };
        Some(format!("{}/{}", addr, mask))
    }
}

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
            if let Some(cidr) = parse_valid_ip_or_cidr(raw) {
                hba.push_str(&format!("host    all             all             {:<23} scram-sha-256\n", cidr));
            }
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

/// Reads PostgreSQL's start timestamp from line 3 of `postmaster.pid` (Unix seconds) in milliseconds.
pub fn read_pg_started_at(data_dir: &Path) -> Option<i64> {
    let pid_file = data_dir.join("postmaster.pid");
    if let Ok(content) = std::fs::read_to_string(pid_file) {
        if let Some(third_line) = content.lines().nth(2) {
            if let Ok(secs) = third_line.trim().parse::<i64>() {
                if secs > 0 {
                    return Some(secs * 1000);
                }
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
            for raw in allowed_ips.split(|c| c == ',' || c == '\n' || c == ';') {
                if let Some(cidr) = parse_valid_ip_or_cidr(raw) {
                    let _ = Command::new("sudo")
                        .args(["ufw", "allow", "proto", "tcp", "from", &cidr, "to", "any", "port", &port.to_string()])
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
        for raw in allowed_ips.split(|c| c == ',' || c == '\n' || c == ';') {
            if let Some(cidr) = parse_valid_ip_or_cidr(raw) {
                let _ = Command::new("sudo")
                    .args(["ufw", "delete", "allow", "proto", "tcp", "from", &cidr, "to", "any", "port", &port.to_string()])
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_ip_allowlist_validation() {
        assert_eq!(parse_valid_ip_or_cidr("192.168.1.10"), Some("192.168.1.10/32".into()));
        assert_eq!(parse_valid_ip_or_cidr("10.0.0.0/8"), Some("10.0.0.0/8".into()));
        assert_eq!(parse_valid_ip_or_cidr("2001:db8::/32"), Some("2001:db8::/32".into()));
        // Reject pg_hba / ufw directive injection
        assert_eq!(parse_valid_ip_or_cidr("0.0.0.0/0 trust"), None);
        assert_eq!(parse_valid_ip_or_cidr("127.0.0.1/99"), None);
        assert_eq!(parse_valid_ip_or_cidr("all"), None);
    }
}
