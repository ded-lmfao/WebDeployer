use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use crate::projects::Project;
use super::Runtime;

pub fn is_pid_alive(pid: u32) -> bool {
    if pid == 0 {
        return false;
    }
    #[cfg(unix)]
    unsafe {
        libc::kill(pid as libc::pid_t, 0) == 0
    }
    #[cfg(not(unix))]
    {
        let mut sys = sysinfo::System::new();
        sys.refresh_processes(sysinfo::ProcessesToUpdate::Some(&[sysinfo::Pid::from(pid as usize)]), true);
        sys.process(sysinfo::Pid::from(pid as usize)).is_some()
    }
}

/// Locate Java executable and JDK/JRE home across environment variables, common installation directories, and system PATH.
pub fn detect_java_exe() -> Option<(PathBuf, PathBuf)> {
    // 1. Check JAVA_HOME environment variable
    if let Ok(jh) = std::env::var("JAVA_HOME") {
        let p = PathBuf::from(&jh);
        #[cfg(windows)]
        let exe = p.join("bin").join("java.exe");
        #[cfg(not(windows))]
        let exe = p.join("bin").join("java");
        if exe.exists() {
            return Some((exe, p));
        }
    }

    #[cfg(windows)]
    {
        // 2. Scan standard Windows JDK/JRE directories
        let search_dirs = [
            r"C:\Program Files\Eclipse Adoptium",
            r"C:\Program Files\Java",
            r"C:\Program Files\Microsoft",
            r"C:\Program Files\Amazon Corretto",
            r"C:\Program Files\BellSoft",
            r"C:\Program Files\Zulu",
            r"C:\Program Files (x86)\Java",
        ];

        for root_str in &search_dirs {
            let root = Path::new(root_str);
            if let Ok(entries) = std::fs::read_dir(root) {
                for entry in entries.flatten() {
                    let path = entry.path();
                    if path.is_dir() {
                        let java_exe = path.join("bin").join("java.exe");
                        if java_exe.exists() {
                            return Some((java_exe, path));
                        }
                        if let Ok(subentries) = std::fs::read_dir(&path) {
                            for sub in subentries.flatten() {
                                let subpath = sub.path();
                                if subpath.is_dir() {
                                    let sub_java = subpath.join("bin").join("java.exe");
                                    if sub_java.exists() {
                                        return Some((sub_java, subpath));
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    #[cfg(not(windows))]
    {
        // 2. Scan standard Linux JVM / JDK directories
        let search_dirs = [
            "/usr/lib/jvm",
            "/usr/java",
            "/opt/java",
            "/opt/jdk",
        ];
        for root_str in &search_dirs {
            let root = Path::new(root_str);
            if let Ok(entries) = std::fs::read_dir(root) {
                for entry in entries.flatten() {
                    let path = entry.path();
                    let java_exe = path.join("bin").join("java");
                    if java_exe.exists() {
                        return Some((java_exe, path));
                    }
                }
            }
        }
    }

    // 3. Scan PATH
    #[cfg(windows)]
    let java_name = "java.exe";
    #[cfg(not(windows))]
    let java_name = "java";

    if let Ok(path_var) = std::env::var("PATH") {
        let separator = if cfg!(windows) { ';' } else { ':' };
        for part in path_var.split(separator) {
            let candidate = Path::new(part).join(java_name);
            if candidate.exists() {
                let home = Path::new(part).parent().unwrap_or(Path::new(part)).to_path_buf();
                return Some((candidate, home));
            }
        }
    }

    None
}

impl Runtime {
    pub async fn kill_pid_tree(pid: u32) {
        if pid == 0 || pid == std::process::id() {
            return;
        }
        #[cfg(windows)]
        {
            // 1. First taskkill /F /T /PID to take out the entire process tree while parent is still recognized
            let _ = tokio::process::Command::new("taskkill")
                .args(["/F", "/T", "/PID", &pid.to_string()])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .await;
            // 2. Also taskkill /F /PID directly in case /T fails because the process has no children
            let _ = tokio::process::Command::new("taskkill")
                .args(["/F", "/PID", &pid.to_string()])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .await;
        }
        #[cfg(unix)]
        {
            let _ = tokio::process::Command::new("kill")
                .args(["-9", &format!("-{}", pid)])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .await;
            let _ = tokio::process::Command::new("kill")
                .args(["-9", &pid.to_string()])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .await;
        }
    }

    /// Comprehensively locate ALL OS processes belonging to this project (parent, children,
    /// detached subprocesses, multi-bot workers) using sysinfo inspection.
    pub fn find_project_processes_sysinfo(
        project_id: i64,
        slug: &str,
        base_dir: &Path,
        known_pids: &HashSet<u32>,
    ) -> HashSet<u32> {
        let mut sys = sysinfo::System::new();
        sys.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
        let mut matched_pids = HashSet::new();
        let self_pid = std::process::id();

        let base_dir_str = base_dir.to_string_lossy().to_lowercase();
        let base_dir_norm = PathBuf::from(&base_dir_str);
        let has_specific_base_dir = !base_dir_str.is_empty() && base_dir.components().count() > 1;
        let slug_lower = slug.to_lowercase();
        let env_proj_id = format!("WEBDEP_PROJECT_ID={}", project_id);
        let env_slug = format!("WEBDEP_PROJECT_SLUG={}", slug);

        for (pid, proc_) in sys.processes() {
            // Skip OS thread entries (`/proc/<tgid>/task/<tid>` on Linux); only match real processes.
            if proc_.thread_kind().is_some() {
                continue;
            }
            let pid_u32 = pid.as_u32();
            if pid_u32 == 0 || pid_u32 == self_pid {
                continue;
            }

            // 1. Direct PID match with known project PIDs
            if known_pids.contains(&pid_u32) {
                matched_pids.insert(pid_u32);
                continue;
            }

            // 2. Direct parent PID match
            if let Some(parent) = proc_.parent() {
                if known_pids.contains(&parent.as_u32()) {
                    matched_pids.insert(pid_u32);
                    continue;
                }
            }

            // 3. Environment variable match (injected by WebDep on process spawn)
            let mut env_match = false;
            for env in proc_.environ() {
                let s = env.to_string_lossy();
                if s == env_proj_id || s == env_slug {
                    env_match = true;
                    break;
                }
            }
            if env_match {
                matched_pids.insert(pid_u32);
                continue;
            }

            // 4. Working directory match (component-safe inside base_dir)
            if has_specific_base_dir {
                if let Some(cwd) = proc_.cwd() {
                    let cwd_norm = PathBuf::from(cwd.to_string_lossy().to_lowercase());
                    if cwd_norm == base_dir_norm || cwd_norm.starts_with(&base_dir_norm) {
                        matched_pids.insert(pid_u32);
                        continue;
                    }
                }
            }

            // 5. Command line match (references services/<slug> or containers/<slug>)
            let mut cmd_match = false;
            for arg in proc_.cmd() {
                let arg_lower = arg.to_string_lossy().to_lowercase();
                if (has_specific_base_dir && arg_lower.contains(&base_dir_str))
                    || arg_lower.contains(&format!("services\\{}", slug_lower))
                    || arg_lower.contains(&format!("services/{}", slug_lower))
                    || arg_lower.contains(&format!("containers\\{}", slug_lower))
                    || arg_lower.contains(&format!("containers/{}", slug_lower))
                {
                    cmd_match = true;
                    break;
                }
            }
            if cmd_match {
                matched_pids.insert(pid_u32);
            }
        }

        // 6. Transitive child expansion: find all children and grandchildren of any matched process
        let mut expanded = true;
        while expanded {
            expanded = false;
            for (pid, proc_) in sys.processes() {
                if proc_.thread_kind().is_some() {
                    continue;
                }
                let pid_u32 = pid.as_u32();
                if pid_u32 == 0 || pid_u32 == self_pid || matched_pids.contains(&pid_u32) {
                    continue;
                }
                if let Some(parent) = proc_.parent() {
                    if matched_pids.contains(&parent.as_u32()) {
                        matched_pids.insert(pid_u32);
                        expanded = true;
                    }
                }
            }
        }

        matched_pids
    }

    /// Comprehensively shut down all processes, child trees, port listeners, and containers for a website or service.
    /// Returns true if any active processes or listening ports were terminated.
    pub(crate) async fn kill_project_everything(&self, p: &Project) -> bool {
        // First stop any maintenance responder bound to this project's port
        self.stop_maintenance_server(p.id);
        tokio::time::sleep(Duration::from_millis(40)).await;

        let container = self.ensure_container(p);
        let mut pids_to_kill: HashSet<u32> = HashSet::new();

        // 1. In-memory Child handle: record PID, but DO NOT call start_kill() yet!
        let old_child = {
            let mut map = self.processes.lock().unwrap();
            map.remove(&p.id)
        };
        let had_child = old_child.is_some();
        if let Some(ref child) = old_child {
            if let Some(pid) = child.id() {
                pids_to_kill.insert(pid);
            }
        }

        // 2. SQLite recorded PID
        if let Some(old_pid) = p.app_pid {
            if old_pid > 0 {
                pids_to_kill.insert(old_pid);
            }
        }
        if let Ok(conn) = self.db.lock() {
            if let Ok(Some(db_pid)) = conn.query_row(
                "SELECT app_pid FROM projects WHERE id = ?",
                rusqlite::params![p.id],
                |r| r.get::<_, Option<u32>>(0),
            ) {
                if db_pid > 0 {
                    pids_to_kill.insert(db_pid);
                }
            }
        }

        // 3. Container pidfile PIDs
        for cpid in self.read_container_pids(&container) {
            pids_to_kill.insert(cpid);
        }

        // 4. All processes listening on the website's port
        if let Some(port) = p.port {
            for port_pid in Self::find_pids_on_port(port) {
                pids_to_kill.insert(port_pid);
            }
        }

        // 5. Deep Scan with sysinfo: Find ALL child, grandchild, detached, and matching processes
        let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
        let base_dir = if Path::new(&p.deploy_dir).is_absolute() {
            PathBuf::from(&p.deploy_dir)
        } else {
            cwd.join(p.deploy_dir.trim_start_matches("./").trim_start_matches(".\\"))
        };
        let sysinfo_pids = Self::find_project_processes_sysinfo(p.id, &p.slug, &base_dir, &pids_to_kill);
        for spid in sysinfo_pids {
            pids_to_kill.insert(spid);
        }

        // 6. Kill all collected PIDs and their process trees while the parents are still known
        for pid in &pids_to_kill {
            Self::kill_pid_tree(*pid).await;
        }

        // 7. Now reap the old child handle
        if let Some(mut child) = old_child {
            let _ = child.start_kill();
        }

        // 8. Re-scan sysinfo with up to 6 rounds of verification to catch and kill any stubborn or surviving child processes
        for _ in 0..6 {
            tokio::time::sleep(Duration::from_millis(60)).await;
            let lingering = Self::find_project_processes_sysinfo(p.id, &p.slug, &base_dir, &HashSet::new());
            if lingering.is_empty() {
                break;
            }
            for pid in lingering {
                Self::kill_pid_tree(pid).await;
            }
        }

        // 9. Verify the website's port is completely freed (retry up to 1.5s if child processes re-bound)
        if let Some(port) = p.port {
            for _ in 0..12 {
                let remaining_pids = Self::find_pids_on_port(port);
                if remaining_pids.is_empty() && !Self::is_port_accepting(port).await {
                    break;
                }
                for pid in remaining_pids {
                    Self::kill_pid_tree(pid).await;
                }
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
        }

        self.clear_container_pids(&container);
        !pids_to_kill.is_empty() || had_child
    }
}

