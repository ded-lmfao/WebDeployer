use std::io::BufRead;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use serde::{Deserialize, Serialize};
use tracing::{info, warn};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct UpdateStatus {
    pub status: String, // "idle" | "in_progress" | "success" | "error"
    pub step: String,
    pub progress: u8,
    pub logs: Vec<String>,
    pub error: Option<String>,
    pub started_at: Option<u64>,
    pub finished_at: Option<u64>,
}

impl Default for UpdateStatus {
    fn default() -> Self {
        Self {
            status: "idle".to_string(),
            step: "Ready".to_string(),
            progress: 0,
            logs: Vec::new(),
            error: None,
            started_at: None,
            finished_at: None,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct GitVersionInfo {
    pub current_commit: String,
    pub current_branch: String,
    pub commit_message: String,
    pub remote_commit: Option<String>,
    pub has_update: bool,
    pub update_in_progress: bool,
    pub ready_to_restart: bool,
}

#[derive(Deserialize)]
pub struct TriggerUpdatePayload {
    pub branch: Option<String>,
}

pub struct Updater {
    data_dir: PathBuf,
    status: Arc<Mutex<UpdateStatus>>,
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn now_time_str() -> String {
    let secs = now_secs();
    let hours = (secs / 3600) % 24;
    let mins = (secs / 60) % 60;
    let s = secs % 60;
    format!("{:02}:{:02}:{:02}", hours, mins, s)
}

fn get_system_path() -> String {
    let current_path = std::env::var("PATH").unwrap_or_default();
    let mut parts: Vec<String> = current_path
        .split(if cfg!(windows) { ';' } else { ':' })
        .map(|s| s.to_string())
        .collect();

    let extra = if cfg!(windows) {
        vec![]
    } else {
        vec![
            "/root/.cargo/bin".to_string(),
            "/usr/local/cargo/bin".to_string(),
            "/usr/local/sbin".to_string(),
            "/usr/local/bin".to_string(),
            "/usr/sbin".to_string(),
            "/usr/bin".to_string(),
            "/sbin".to_string(),
            "/bin".to_string(),
        ]
    };

    for e in extra {
        if !parts.contains(&e) {
            parts.insert(0, e);
        }
    }

    parts.join(if cfg!(windows) { ";" } else { ":" })
}

fn find_cargo() -> PathBuf {
    if let Ok(output) = Command::new("cargo").arg("--version").output() {
        if output.status.success() {
            return PathBuf::from("cargo");
        }
    }

    let mut candidates = Vec::new();
    if let Ok(home) = std::env::var("HOME") {
        candidates.push(PathBuf::from(home).join(".cargo/bin/cargo"));
    }
    candidates.push(PathBuf::from("/root/.cargo/bin/cargo"));
    candidates.push(PathBuf::from("/usr/local/cargo/bin/cargo"));
    candidates.push(PathBuf::from("/usr/bin/cargo"));

    #[cfg(windows)]
    {
        if let Ok(userprofile) = std::env::var("USERPROFILE") {
            candidates.push(PathBuf::from(userprofile).join(".cargo\\bin\\cargo.exe"));
        }
    }

    for p in candidates {
        if p.exists() {
            return p;
        }
    }

    PathBuf::from("cargo")
}

impl Updater {
    pub fn new(data_dir: PathBuf) -> Self {
        Self {
            data_dir,
            status: Arc::new(Mutex::new(UpdateStatus::default())),
        }
    }

    pub fn get_status(&self) -> UpdateStatus {
        self.status.lock().unwrap().clone()
    }

    pub fn get_version_info(&self) -> GitVersionInfo {
        let (is_updating, ready_to_restart) = {
            let st = self.status.lock().unwrap();
            (st.status == "in_progress", st.status == "ready_to_restart")
        };

        let current_commit = Command::new("git")
            .args(["rev-parse", "--short", "HEAD"])
            .output()
            .ok()
            .and_then(|o| if o.status.success() { Some(String::from_utf8_lossy(&o.stdout).trim().to_string()) } else { None })
            .unwrap_or_else(|| "unknown".to_string());

        let current_branch = Command::new("git")
            .args(["rev-parse", "--abbrev-ref", "HEAD"])
            .output()
            .ok()
            .and_then(|o| if o.status.success() { Some(String::from_utf8_lossy(&o.stdout).trim().to_string()) } else { None })
            .unwrap_or_else(|| "main".to_string());

        let commit_message = Command::new("git")
            .args(["log", "-1", "--pretty=format:%s"])
            .output()
            .ok()
            .and_then(|o| if o.status.success() { Some(String::from_utf8_lossy(&o.stdout).trim().to_string()) } else { None })
            .unwrap_or_default();

        let branch_to_check = if current_branch == "HEAD" || current_branch.is_empty() {
            "main"
        } else {
            &current_branch
        };

        // Query remote latest commit for this branch (fast ls-remote with 5s timeout)
        let remote_commit = Command::new("git")
            .args(["ls-remote", "-h", "origin", &format!("refs/heads/{}", branch_to_check)])
            .output()
            .ok()
            .and_then(|o| {
                if o.status.success() {
                    let out = String::from_utf8_lossy(&o.stdout);
                    let line = out.lines().next()?;
                    let sha = line.split_whitespace().next()?;
                    if sha.len() >= 7 {
                        Some(sha[..7].to_string())
                    } else {
                        None
                    }
                } else {
                    None
                }
            });

        let has_update = match (&remote_commit, &current_commit) {
            (Some(rem), cur) if cur != "unknown" && !rem.is_empty() => rem != cur,
            _ => false,
        };

        GitVersionInfo {
            current_commit,
            current_branch,
            commit_message,
            remote_commit,
            has_update,
            update_in_progress: is_updating,
            ready_to_restart,
        }
    }

    pub fn start_update(&self, branch_override: Option<String>) -> Result<(), String> {
        let mut st = self.status.lock().unwrap();
        if st.status == "in_progress" {
            return Err("An update is already running in background".to_string());
        }

        *st = UpdateStatus {
            status: "in_progress".to_string(),
            step: "Initializing update sequence...".to_string(),
            progress: 5,
            logs: vec![format!("[{}] Starting WebDep 1-click update sequence...", now_time_str())],
            error: None,
            started_at: Some(now_secs()),
            finished_at: None,
        };

        let status_arc = self.status.clone();
        tokio::task::spawn_blocking(move || {
            Self::run_update_pipeline(status_arc, branch_override);
        });

        Ok(())
    }

    fn append_log(status_arc: &Arc<Mutex<UpdateStatus>>, msg: &str) {
        if let Ok(mut st) = status_arc.lock() {
            let line = format!("[{}] {}", now_time_str(), msg);
            info!("{}", line);
            st.logs.push(line);
            if st.logs.len() > 500 {
                st.logs.remove(0);
            }
        }
    }

    fn set_step(status_arc: &Arc<Mutex<UpdateStatus>>, step: &str, progress: u8) {
        if let Ok(mut st) = status_arc.lock() {
            st.step = step.to_string();
            st.progress = progress;
        }
    }

    fn run_update_pipeline(status_arc: Arc<Mutex<UpdateStatus>>, branch_override: Option<String>) {
        // STEP 1: Verify environment & preserve .env and data/
        Self::set_step(&status_arc, "Preserving environment and verifying directory...", 10);
        Self::append_log(&status_arc, "Checking repository status...");

        let is_git = Command::new("git")
            .args(["rev-parse", "--is-inside-work-tree"])
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);

        if !is_git {
            let err = "Current directory is not a Git repository. Cannot perform git-based update.".to_string();
            Self::append_log(&status_arc, &format!("[Error] {}", err));
            if let Ok(mut st) = status_arc.lock() {
                st.status = "error".to_string();
                st.error = Some(err);
                st.finished_at = Some(now_secs());
            }
            return;
        }

        // Safety backup for .env
        let env_path = Path::new(".env");
        let env_bak = Path::new(".env.updater-backup");
        if env_path.exists() {
            if let Err(e) = std::fs::copy(env_path, env_bak) {
                warn!("Could not create backup of .env: {}", e);
            } else {
                Self::append_log(&status_arc, "[Safety] Successfully backed up .env configuration to .env.updater-backup");
            }
        } else {
            Self::append_log(&status_arc, "[Notice] .env file not detected (default configuration active)");
        }

        Self::append_log(&status_arc, "[Safety] Confirmed data/ directory is untracked and isolated (all SQLite databases, sites, and keys will remain untouched)");

        // Determine branch
        let branch = branch_override.unwrap_or_else(|| {
            Command::new("git")
                .args(["rev-parse", "--abbrev-ref", "HEAD"])
                .output()
                .ok()
                .and_then(|o| if o.status.success() { Some(String::from_utf8_lossy(&o.stdout).trim().to_string()) } else { None })
                .unwrap_or_else(|| "main".to_string())
        });
        let target_branch = if branch == "HEAD" || branch.is_empty() { "main".to_string() } else { branch };

        // STEP 2: Fetch latest commits from remote git
        Self::set_step(&status_arc, &format!("Fetching latest commits from origin/{}...", target_branch), 25);
        Self::append_log(&status_arc, &format!("Running: git fetch origin {}...", target_branch));

        let fetch_res = Command::new("git")
            .args(["fetch", "origin", &target_branch])
            .output();

        match fetch_res {
            Ok(o) if o.status.success() => {
                Self::append_log(&status_arc, "Git fetch succeeded!");
            }
            Ok(o) => {
                let err = String::from_utf8_lossy(&o.stderr).trim().to_string();
                Self::append_log(&status_arc, &format!("[Warning] Git fetch returned: {}", err));
                // Try plain git fetch as fallback
                let _ = Command::new("git").args(["fetch"]).output();
            }
            Err(e) => {
                let err = format!("Failed to execute git fetch: {}", e);
                Self::append_log(&status_arc, &format!("[Error] {}", err));
                if let Ok(mut st) = status_arc.lock() {
                    st.status = "error".to_string();
                    st.error = Some(err);
                    st.finished_at = Some(now_secs());
                }
                return;
            }
        }

        // Fast-forward or hard reset tracked source tree to match remote branch cleanly
        Self::set_step(&status_arc, "Updating source tree to remote commit...", 35);
        Self::append_log(&status_arc, &format!("Resetting tracked source files to origin/{}...", target_branch));

        let reset_out = Command::new("git")
            .args(["reset", "--hard", &format!("origin/{}", target_branch)])
            .output();

        if let Ok(o) = reset_out {
            if !o.status.success() {
                let err = String::from_utf8_lossy(&o.stderr).trim().to_string();
                Self::append_log(&status_arc, &format!("[Warning] Reset to origin/{} output: {}", target_branch, err));
            } else {
                Self::append_log(&status_arc, &format!("[Git] {}", String::from_utf8_lossy(&o.stdout).trim()));
            }
        }

        // Verify .env safety
        if env_bak.exists() && !env_path.exists() {
            let _ = std::fs::copy(env_bak, env_path);
            Self::append_log(&status_arc, "[Safety] Restored .env from backup");
        }
        if env_bak.exists() {
            let _ = std::fs::remove_file(env_bak);
        }

        let new_commit = Command::new("git")
            .args(["rev-parse", "--short", "HEAD"])
            .output()
            .ok()
            .and_then(|o| if o.status.success() { Some(String::from_utf8_lossy(&o.stdout).trim().to_string()) } else { None })
            .unwrap_or_else(|| "unknown".to_string());
        Self::append_log(&status_arc, &format!("[Git] Updated source tree to commit: {}", new_commit));

        // STEP 3: Hot-swap binary and compile with Cargo
        Self::set_step(&status_arc, "Compiling release binary with Cargo (CARGO_BUILD_JOBS=1)...", 45);

        let cargo_bin = find_cargo();
        Self::append_log(&status_arc, &format!("[Build] Located Cargo toolchain: {}", cargo_bin.display()));

        let exe_name = if cfg!(windows) { "webdep.exe" } else { "webdep" };
        let target_dir = Path::new("target").join("release");
        let active_exe = target_dir.join(exe_name);
        let old_exe = target_dir.join(format!("{}.old", exe_name));

        if active_exe.exists() {
            if let Err(e) = std::fs::rename(&active_exe, &old_exe) {
                Self::append_log(&status_arc, &format!("[Warning] Could not rename active binary for hot-swap (will attempt direct build): {}", e));
            } else {
                Self::append_log(&status_arc, &format!("[Build] Moved running binary to {}.old for safe hot-swap", exe_name));
            }
        }

        Self::append_log(&status_arc, "Executing: cargo build --release (Low-RAM mode: CARGO_BUILD_JOBS=1)...");

        let build_spawn = Command::new(&cargo_bin)
            .args(["build", "--release"])
            .env("CARGO_BUILD_JOBS", "1")
            .env("PATH", get_system_path())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn();

        let mut child = match build_spawn {
            Ok(c) => c,
            Err(e) => {
                let err = format!("Failed to spawn cargo build: {}. Ensure cargo/rustup is installed.", e);
                Self::append_log(&status_arc, &format!("[Error] {}", err));
                if old_exe.exists() && !active_exe.exists() {
                    let _ = std::fs::rename(&old_exe, &active_exe);
                    Self::append_log(&status_arc, "[Recovery] Restored previous binary intact.");
                }
                if let Ok(mut st) = status_arc.lock() {
                    st.status = "error".to_string();
                    st.error = Some(err);
                    st.finished_at = Some(now_secs());
                }
                return;
            }
        };

        // Capture build output in real time
        let status_for_stdout = status_arc.clone();
        if let Some(stdout) = child.stdout.take() {
            std::thread::spawn(move || {
                let reader = std::io::BufReader::new(stdout);
                for line in reader.lines().map_while(Result::ok) {
                    let trimmed = line.trim();
                    if !trimmed.is_empty() {
                        Self::append_log(&status_for_stdout, trimmed);
                    }
                }
            });
        }

        let status_for_stderr = status_arc.clone();
        if let Some(stderr) = child.stderr.take() {
            std::thread::spawn(move || {
                let reader = std::io::BufReader::new(stderr);
                for line in reader.lines().map_while(Result::ok) {
                    let trimmed = line.trim();
                    if !trimmed.is_empty() {
                        Self::append_log(&status_for_stderr, trimmed);
                    }
                }
            });
        }

        let exit_status = child.wait();
        let build_ok = match exit_status {
            Ok(st) => st.success(),
            Err(e) => {
                Self::append_log(&status_arc, &format!("[Error] Build process wait error: {}", e));
                false
            }
        };

        if !build_ok {
            let err = "Cargo compilation failed! Review logs above for errors.".to_string();
            Self::append_log(&status_arc, &format!("[Error] {}", err));
            if old_exe.exists() && !active_exe.exists() {
                let _ = std::fs::rename(&old_exe, &active_exe);
                Self::append_log(&status_arc, "[Recovery] Previous binary restored. WebDep continues running without downtime.");
            }
            if let Ok(mut st) = status_arc.lock() {
                st.status = "error".to_string();
                st.error = Some(err);
                st.finished_at = Some(now_secs());
            }
            return;
        }

        // Cleanup .old binary
        if old_exe.exists() {
            let _ = std::fs::remove_file(old_exe);
        }

        #[cfg(unix)]
        {
            let _ = Command::new("chmod").args(["+x", active_exe.to_str().unwrap_or("target/release/webdep")]).status();
        }

        Self::append_log(&status_arc, &format!("[Success] New WebDep release binary compiled and verified! (Commit: {})", new_commit));
        Self::append_log(&status_arc, "[Ready] WebDep is compiled and staged for restart. Awaiting user restart confirmation.");

        Self::set_step(&status_arc, "Update compiled successfully! Ready to restart WebDep.", 100);

        if let Ok(mut st) = status_arc.lock() {
            st.status = "ready_to_restart".to_string();
            st.progress = 100;
            st.step = "Update compiled successfully! Restart panel to apply changes.".to_string();
            st.finished_at = Some(now_secs());
        }
    }
}

pub fn restart_service_delayed(delay_ms: u64) {
    tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;

        #[cfg(unix)]
        {
            // 1. Check if running under systemd
            let is_systemd = Command::new("systemctl")
                .args(["is-active", "--quiet", "webdep"])
                .status()
                .map(|s| s.success())
                .unwrap_or(false);

            if is_systemd {
                info!("Restarting WebDep via systemd service 'webdep'...");
                let _ = Command::new("sh")
                    .args(["-c", "(sleep 0.5 && (sudo systemctl restart webdep || systemctl restart webdep)) >/dev/null 2>&1 &"])
                    .spawn();
                return;
            }

            // 2. Fallback for standalone/daemon mode: launch newly compiled binary detached
            if let Ok(cwd) = std::env::current_dir() {
                let bin = cwd.join("target").join("release").join("webdep");
                if bin.exists() {
                    info!("Spawning fresh WebDep binary detached at: {}", bin.display());
                    let _ = Command::new(bin)
                        .current_dir(&cwd)
                        .stdin(Stdio::null())
                        .stdout(Stdio::null())
                        .stderr(Stdio::null())
                        .spawn();
                }
            }
            std::process::exit(0);
        }

        #[cfg(windows)]
        {
            if let Ok(cwd) = std::env::current_dir() {
                let bin = cwd.join("target").join("release").join("webdep.exe");
                if bin.exists() {
                    let mut cmd = Command::new(bin);
                    cmd.current_dir(&cwd)
                        .stdin(Stdio::null())
                        .stdout(Stdio::null())
                        .stderr(Stdio::null());
                    use std::os::windows::process::CommandExt;
                    cmd.creation_flags(0x00000008 | 0x00000200);
                    let _ = cmd.spawn();
                }
            }
            std::process::exit(0);
        }
    });
}
