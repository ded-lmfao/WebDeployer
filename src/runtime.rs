use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::process::Child;

use crate::db::{now, DbPool};
use crate::logs::Logs;
use crate::projects::Project;

#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct WebsiteContainer {
    pub container_id: String,
    pub project_id: i64,
    pub slug: String,
    pub port: u16,
    pub root_dir: PathBuf,
    pub db_dir: PathBuf,
    pub storage_dir: PathBuf,
    pub tmp_dir: PathBuf,
    pub home_dir: PathBuf,
    pub cache_dir: PathBuf,
    pub run_dir: PathBuf,
}

fn copy_dir_files_if_missing(src_dir: &Path, dst_dir: &Path) {
    if let Ok(entries) = std::fs::read_dir(src_dir) {
        for entry in entries.flatten() {
            let src = entry.path();
            if src.is_file() {
                let dst = dst_dir.join(entry.file_name());
                if !dst.exists() {
                    let _ = std::fs::copy(&src, &dst);
                }
            }
        }
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

pub struct Runtime {
    db: DbPool,
    logs: Logs,
    processes: Arc<Mutex<HashMap<i64, Child>>>,
    project_locks: Arc<Mutex<HashMap<i64, Arc<tokio::sync::Mutex<()>>>>>,
    stop_seq: Arc<Mutex<HashMap<i64, u64>>>,
    maintenance_shutdowns: Arc<Mutex<HashMap<i64, tokio::sync::oneshot::Sender<()>>>>,
    allowed_ports: Arc<Mutex<HashSet<u16>>>,
}

impl Runtime {
    pub fn new(db: DbPool, logs: Logs) -> Self {
        Self {
            db,
            logs,
            processes: Arc::new(Mutex::new(HashMap::new())),
            project_locks: Arc::new(Mutex::new(HashMap::new())),
            stop_seq: Arc::new(Mutex::new(HashMap::new())),
            maintenance_shutdowns: Arc::new(Mutex::new(HashMap::new())),
            allowed_ports: Arc::new(Mutex::new(HashSet::new())),
        }
    }

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

    pub fn stop_maintenance_server(&self, project_id: i64) {
        if let Ok(mut map) = self.maintenance_shutdowns.lock() {
            if let Some(tx) = map.remove(&project_id) {
                let _ = tx.send(());
            }
        }
    }

    pub fn render_maintenance_html(name: &str, slug: &str, status_text: &str) -> String {
        let safe_name = name
            .replace('&', "&amp;")
            .replace('<', "&lt;")
            .replace('>', "&gt;");
        let safe_slug = slug
            .replace('&', "&amp;")
            .replace('<', "&lt;")
            .replace('>', "&gt;");
        let safe_status = status_text
            .replace('&', "&amp;")
            .replace('<', "&lt;")
            .replace('>', "&gt;");

        format!(
            r#"<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>{safe_name} — Under Maintenance</title>
<style>
  * {{ box-sizing: border-box; margin: 0; padding: 0; }}
  body {{
    min-height: 100vh;
    background: #070b14;
    background-image:
      radial-gradient(circle at 50% 0%, rgba(37, 99, 235, 0.14), transparent 55%),
      radial-gradient(circle at 85% 85%, rgba(245, 158, 11, 0.08), transparent 45%);
    color: #f1f5f9;
    font-family: -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", Roboto, sans-serif;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
  }}
  .card {{
    width: 100%;
    max-width: 560px;
    background: #0d1527;
    border: 1px solid #1a2744;
    border-radius: 8px;
    padding: 38px 34px 30px;
    box-shadow: 0 24px 60px rgba(2, 6, 18, 0.78);
    position: relative;
    overflow: hidden;
  }}
  .top-bar {{
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 3px;
    background: linear-gradient(90deg, #2563eb, #f59e0b, #3b82f6);
    background-size: 200% 100%;
    animation: slideBar 3.2s linear infinite;
  }}
  @keyframes slideBar {{
    0% {{ background-position: 0% 0%; }}
    100% {{ background-position: 200% 0%; }}
  }}
  .badge {{
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 5px 12px;
    background: rgba(245, 158, 11, 0.12);
    border: 1px solid rgba(245, 158, 11, 0.32);
    border-radius: 6px;
    color: #fbbf24;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    margin-bottom: 20px;
  }}
  .dot {{
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: #f59e0b;
    box-shadow: 0 0 10px #f59e0b;
    animation: pulse 1.8s ease-in-out infinite;
  }}
  @keyframes pulse {{
    0%, 100% {{ opacity: 1; transform: scale(1); }}
    50% {{ opacity: 0.45; transform: scale(0.88); }}
  }}
  .icon-box {{
    width: 48px;
    height: 48px;
    border-radius: 8px;
    background: #111d35;
    border: 1px solid #1e3158;
    display: flex;
    align-items: center;
    justify-content: center;
    color: #60a5fa;
    margin-bottom: 18px;
  }}
  h1 {{
    font-size: 24px;
    font-weight: 700;
    color: #f8fafc;
    letter-spacing: -0.02em;
    margin-bottom: 10px;
  }}
  .subtitle {{
    font-size: 14.5px;
    line-height: 1.65;
    color: #94a3b8;
    margin-bottom: 24px;
  }}
  .info-panel {{
    background: #080e1c;
    border: 1px solid #17233d;
    border-radius: 6px;
    padding: 14px 16px;
    margin-bottom: 22px;
  }}
  .info-row {{
    display: flex;
    justify-content: space-between;
    align-items: center;
    font-size: 12.5px;
    padding: 5px 0;
  }}
  .info-row + .info-row {{
    border-top: 1px solid rgba(255, 255, 255, 0.05);
    margin-top: 5px;
    padding-top: 10px;
  }}
  .info-label {{ color: #64748b; font-weight: 500; }}
  .info-val {{ color: #e2e8f0; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; }}
  .footer {{
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding-top: 16px;
    border-top: 1px solid #16223b;
    font-size: 12px;
    color: #64748b;
  }}
  .btn {{
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 8px 14px;
    background: #162442;
    hover: #1e3158;
    border: 1px solid #263b66;
    border-radius: 6px;
    color: #e2e8f0;
    font-size: 12px;
    font-weight: 600;
    text-decoration: none;
    cursor: pointer;
    transition: all 0.15s ease;
  }}
  .btn:hover {{
    background: #1f335c;
    border-color: #3b82f6;
    color: #ffffff;
  }}
</style>
</head>
<body>
  <div class="card">
    <div class="top-bar"></div>
    <div class="badge"><span class="dot"></span> {safe_status}</div>
    <div class="icon-box">
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>
      </svg>
    </div>
    <h1>{safe_name} is Under Maintenance</h1>
    <p class="subtitle">
      Our developers and engineering team are currently working on updates, scheduled maintenance, or system improvements for this website. It will be back online shortly.
    </p>
    <div class="info-panel">
      <div class="info-row">
        <span class="info-label">Service</span>
        <span class="info-val">{safe_name} ({safe_slug})</span>
      </div>
      <div class="info-row">
        <span class="info-label">Status</span>
        <span class="info-val" style="color:#fbbf24;">Developers Working &bull; Maintenance Mode</span>
      </div>
      <div class="info-row">
        <span class="info-label">Auto-Retry</span>
        <span class="info-val" id="retry-status">Every 30 seconds</span>
      </div>
    </div>
    <div class="footer">
      <span>Managed by WebDep Deployment Platform</span>
      <button class="btn" id="check-btn" onclick="checkBackendReady(true)">Check Again</button>
    </div>
  </div>
  <script>
    async function checkBackendReady(manual) {{
      const btn = document.getElementById('check-btn');
      if (manual && btn) {{
        btn.disabled = true;
        btn.textContent = 'Checking...';
      }}
      try {{
        const res = await fetch(window.location.href, {{
          method: 'GET',
          cache: 'no-store',
          headers: {{ 'X-Maintenance-Probe': '1' }}
        }});
        const isMaint = res.status === 503 || res.headers.get('x-webdep-maintenance') === '1';
        if (res.ok && !isMaint) {{
          window.location.reload();
          return;
        }}
      }} catch (_) {{
        // Backend not reachable yet — keep maintenance page as is
      }}
      if (manual && btn) {{
        btn.disabled = false;
        btn.textContent = 'Check Again';
      }}
    }}
    setInterval(() => checkBackendReady(false), 30000);
  </script>
</body>
</html>"#
        )
    }

    pub fn start_maintenance_server(
        &self,
        project_id: i64,
        name: &str,
        slug: &str,
        port: u16,
        status_text: &str,
    ) {
        self.stop_maintenance_server(project_id);

        let (tx, mut rx) = tokio::sync::oneshot::channel::<()>();
        if let Ok(mut map) = self.maintenance_shutdowns.lock() {
            map.insert(project_id, tx);
        }

        let html = Self::render_maintenance_html(name, slug, status_text);
        let response_bytes = format!(
            "HTTP/1.1 503 Service Unavailable\r\nContent-Type: text/html; charset=utf-8\r\nX-WebDep-Maintenance: 1\r\nCache-Control: no-store, no-cache, must-revalidate\r\nRetry-After: 30\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            html.len(),
            html
        )
        .into_bytes();

        tokio::spawn(async move {
            use tokio::io::{AsyncReadExt, AsyncWriteExt};

            let mut listener_opt = None;
            for _ in 0..8 {
                if let Ok(l) = tokio::net::TcpListener::bind(("0.0.0.0", port)).await {
                    listener_opt = Some(l);
                    break;
                }
                if let Ok(l) = tokio::net::TcpListener::bind(("127.0.0.1", port)).await {
                    listener_opt = Some(l);
                    break;
                }
                tokio::select! {
                    _ = &mut rx => return,
                    _ = tokio::time::sleep(Duration::from_millis(120)) => {}
                }
            }

            let listener = match listener_opt {
                Some(l) => l,
                None => return,
            };

            loop {
                tokio::select! {
                    _ = &mut rx => {
                        break;
                    }
                    accept_res = listener.accept() => {
                        if let Ok((mut stream, _)) = accept_res {
                            let resp = response_bytes.clone();
                            tokio::spawn(async move {
                                let mut buf = [0u8; 1024];
                                let _ = tokio::time::timeout(Duration::from_millis(250), stream.read(&mut buf)).await;
                                let _ = stream.write_all(&resp).await;
                                let _ = stream.shutdown().await;
                            });
                        }
                    }
                }
            }
        });
    }

    fn get_project_lock(&self, project_id: i64) -> Arc<tokio::sync::Mutex<()>> {
        let mut map = self.project_locks.lock().unwrap();
        map.entry(project_id)
            .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
            .clone()
    }

    pub fn get_stop_seq(&self, project_id: i64) -> u64 {
        let map = self.stop_seq.lock().unwrap();
        *map.get(&project_id).unwrap_or(&0)
    }

    pub fn bump_stop_seq(&self, project_id: i64) -> u64 {
        let mut map = self.stop_seq.lock().unwrap();
        let entry = map.entry(project_id).or_insert(0);
        *entry += 1;
        *entry
    }

    /// Provision an isolated container directory structure for a website (`data/containers/<slug>/`)
    /// so its database, uploads, temp files, caches, and environment never clash with any other website.
    pub fn ensure_container(&self, p: &Project) -> WebsiteContainer {
        let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
        let safe_slug = if p.slug.trim().is_empty() {
            format!("site-{}", p.id)
        } else {
            p.slug.trim().to_string()
        };

        let root_dir = cwd.join("data").join("containers").join(&safe_slug);
        let db_dir = root_dir.join("db");
        let storage_dir = root_dir.join("storage");
        let tmp_dir = root_dir.join("tmp");
        let home_dir = root_dir.join("home");
        let cache_dir = root_dir.join("cache");
        let run_dir = root_dir.join("run");

        let _ = std::fs::create_dir_all(&db_dir);
        let _ = std::fs::create_dir_all(&storage_dir);
        let _ = std::fs::create_dir_all(&tmp_dir);
        let _ = std::fs::create_dir_all(&home_dir);
        let _ = std::fs::create_dir_all(&cache_dir);
        let _ = std::fs::create_dir_all(&run_dir);

        // Seamless migration from legacy `data/app-data/<slug>` into `data/containers/<slug>/db`
        let legacy_app_data = cwd.join("data").join("app-data").join(&safe_slug);
        if legacy_app_data.is_dir() {
            copy_dir_files_if_missing(&legacy_app_data, &db_dir);
        }

        let port = p.port.unwrap_or(3000);
        if p.port.is_some() {
            self.allow_firewall_port(port, Some(p.id));
        }

        let container = WebsiteContainer {
            container_id: format!("webdep-ctr-{}-{}", p.id, safe_slug),
            project_id: p.id,
            slug: safe_slug,
            port,
            root_dir: root_dir.clone(),
            db_dir,
            storage_dir,
            tmp_dir,
            home_dir,
            cache_dir,
            run_dir,
        };

        let manifest_path = root_dir.join("container.json");
        if let Ok(json_str) = serde_json::to_string_pretty(&container) {
            let _ = std::fs::write(manifest_path, json_str);
        }

        container
    }

    /// Delete all on-disk directories, releases, git clones, backups, isolated container DB/cache/storage,
    /// and deploy keys associated with a deleted website, after verifying no other active website shares them.
    pub fn cleanup_project_files(&self, p: &Project, remaining_projects: &[Project]) {
        let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
        let safe_slug = p.slug.trim().to_string();

        // 1. Clean up in-memory runtime maps for this project
        if let Ok(mut map) = self.processes.lock() {
            map.remove(&p.id);
        }
        if let Ok(mut map) = self.project_locks.lock() {
            map.remove(&p.id);
        }
        if let Ok(mut map) = self.stop_seq.lock() {
            map.remove(&p.id);
        }

        // 2. Remove SSH deploy keys specific to this project ID (`data/keys/deploy_key_<id>*`)
        let key_dir = cwd.join("data").join("keys");
        let _ = std::fs::remove_file(key_dir.join(format!("deploy_key_{}", p.id)));
        let _ = std::fs::remove_file(key_dir.join(format!("deploy_key_{}.pub", p.id)));

        if safe_slug.is_empty() || safe_slug.contains("..") || safe_slug.contains('/') || safe_slug.contains('\\') {
            return;
        }

        // Ensure no other remaining website shares the same slug before deleting slug-based directories
        let slug_shared = remaining_projects
            .iter()
            .any(|other| other.id != p.id && other.slug.trim().eq_ignore_ascii_case(&safe_slug));
        if slug_shared {
            return;
        }

        // 3. Remove isolated container directory (`data/containers/<slug>` including `db/`, `cache/`, `storage/`, `tmp/`, `home/`, `run/`)
        let container_root = cwd.join("data").join("containers").join(&safe_slug);
        if container_root.exists() {
            let _ = std::fs::remove_dir_all(&container_root);
        }
        let legacy_app_data = cwd.join("data").join("app-data").join(&safe_slug);
        if legacy_app_data.exists() {
            let _ = std::fs::remove_dir_all(&legacy_app_data);
        }

        // 4. Remove deployment directory (`data/sites/<slug>` and `p.deploy_dir` if it specifically ends with `/<slug>`)
        let mut dirs_to_remove = vec![cwd.join("data").join("sites").join(&safe_slug)];
        let dep_trimmed = p.deploy_dir.trim();
        if !dep_trimmed.is_empty() {
            let dep_path = PathBuf::from(dep_trimmed);
            let ends_with_slug = dep_path
                .file_name()
                .map(|n| n.to_string_lossy().eq_ignore_ascii_case(&safe_slug))
                .unwrap_or(false);
            let dir_shared = remaining_projects
                .iter()
                .any(|other| other.id != p.id && other.deploy_dir.trim() == dep_trimmed);
            if ends_with_slug && !dir_shared && dep_path.components().count() >= 3 {
                dirs_to_remove.push(dep_path);
            }
        }

        for dir in dirs_to_remove {
            if dir.exists() || std::fs::symlink_metadata(&dir).is_ok() {
                #[cfg(windows)]
                {
                    let current_link = dir.join("current");
                    let cur_str = current_link.to_string_lossy().trim_start_matches(r"\\?\").to_string();
                    let _ = std::process::Command::new("cmd").args(["/C", "rmdir", &cur_str]).output();
                }
                let _ = std::fs::remove_dir_all(&dir);
            }
        }
    }

    /// Link `<work_dir>/data` to the website's isolated container `db/` folder so relative `./data` paths
    /// inside any Node/Python app stay isolated per container and persist across releases.
    pub fn link_work_dir_to_container(&self, work_dir: &Path, container: &WebsiteContainer) {
        let data_subdir = work_dir.join("data");
        let target_db_dir = &container.db_dir;

        // If `work_dir/data` is a real directory (not a symlink/junction), migrate any files inside it first
        if let Ok(meta) = std::fs::symlink_metadata(&data_subdir) {
            if meta.is_dir() && !meta.file_type().is_symlink() {
                copy_dir_files_if_missing(&data_subdir, target_db_dir);
                #[cfg(windows)]
                {
                    let link_str = data_subdir.to_string_lossy().trim_start_matches(r"\\?\").to_string();
                    let _ = std::process::Command::new("cmd")
                        .args(["/C", "rmdir", &link_str])
                        .output();
                }
                let _ = std::fs::remove_dir_all(&data_subdir);
            }
        }

        if !data_subdir.exists() && std::fs::symlink_metadata(&data_subdir).is_err() {
            #[cfg(windows)]
            {
                let link_str = data_subdir.to_string_lossy().trim_start_matches(r"\\?\").to_string();
                let target_str = target_db_dir.to_string_lossy().trim_start_matches(r"\\?\").to_string();
                let _ = std::process::Command::new("cmd")
                    .args(["/C", "mklink", "/J", &link_str, &target_str])
                    .output();
            }
            #[cfg(unix)]
            {
                let _ = std::os::unix::fs::symlink(target_db_dir, &data_subdir);
            }
        }
    }

    /// Build isolated environment variables and `.env` file content for a website container.
    /// Ensures `PORT`, `CERT_DATA_DIR`, `APP_DATA_DIR`, `DATA_DIR`, `STORAGE_DIR`, and `APP_URL`
    /// never clash with another website even if the user copied `.env` from another project.
    pub fn build_container_env(
        &self,
        p: &Project,
        user_env: &HashMap<String, String>,
        container: &WebsiteContainer,
    ) -> (HashMap<String, String>, String) {
        let mut final_env = user_env.clone();
        let port = p.port.unwrap_or(3000);
        let port_str = port.to_string();

        let db_dir_str = container
            .db_dir
            .to_string_lossy()
            .trim_start_matches(r"\\?\")
            .to_string();
        let storage_dir_str = container
            .storage_dir
            .to_string_lossy()
            .trim_start_matches(r"\\?\")
            .to_string();
        let tmp_dir_str = container
            .tmp_dir
            .to_string_lossy()
            .trim_start_matches(r"\\?\")
            .to_string();
        let cache_dir_str = container
            .cache_dir
            .to_string_lossy()
            .trim_start_matches(r"\\?\")
            .to_string();

        // Force container port & container identity
        final_env.insert("PORT".to_string(), port_str.clone());
        final_env.insert("WEBDEP_CONTAINER_ID".to_string(), container.container_id.clone());
        final_env.insert("WEBDEP_SITE_SLUG".to_string(), container.slug.clone());

        // Force isolated database and storage directories so two websites NEVER share SQLite files
        final_env.insert("CERT_DATA_DIR".to_string(), db_dir_str.clone());
        final_env.insert("APP_DATA_DIR".to_string(), db_dir_str.clone());
        final_env.insert("DATA_DIR".to_string(), db_dir_str.clone());
        final_env.insert("DB_DIR".to_string(), db_dir_str.clone());
        final_env.insert("SQLITE_DIR".to_string(), db_dir_str.clone());
        final_env.insert("STORAGE_DIR".to_string(), storage_dir_str.clone());
        final_env.insert("UPLOAD_DIR".to_string(), storage_dir_str.clone());
        final_env.insert("TEMP".to_string(), tmp_dir_str.clone());
        final_env.insert("TMP".to_string(), tmp_dir_str.clone());
        final_env.insert("TMPDIR".to_string(), tmp_dir_str);
        final_env.insert("NPM_CONFIG_CACHE".to_string(), cache_dir_str);

        // Ensure APP_URL on localhost/127.0.0.1 uses THIS container's assigned port so OAuth/CSRF never redirect to another website
        if let Some(app_url) = final_env.get("APP_URL").cloned() {
            let trimmed = app_url.trim();
            if trimmed.starts_with("http://localhost:") || trimmed.starts_with("http://127.0.0.1:") {
                let host_prefix = if trimmed.starts_with("http://localhost:") {
                    "http://localhost"
                } else {
                    "http://127.0.0.1"
                };
                final_env.insert("APP_URL".to_string(), format!("{}:{}", host_prefix, port));
            } else if trimmed.is_empty() {
                final_env.insert("APP_URL".to_string(), format!("http://127.0.0.1:{}", port));
            }
        }

        // Ensure each container has a valid, isolated AUTH_ENCRYPTION_KEY if blank or missing
        let needs_auth_key = match final_env.get("AUTH_ENCRYPTION_KEY") {
            Some(v) => v.trim().len() != 64 || !v.trim().chars().all(|c| c.is_ascii_hexdigit()),
            None => true,
        };
        if needs_auth_key {
            let mut hasher = Sha256::new();
            hasher.update(format!("webdep-container-auth-key-{}-{}-{}", p.id, p.slug, port).as_bytes());
            let hex_key = format!("{:x}", hasher.finalize());
            final_env.insert("AUTH_ENCRYPTION_KEY".to_string(), hex_key);
        }

        // Build .env file content with user variables first and container isolation overrides at the bottom
        let mut dotenv_body = format!(
            "# Auto-generated by WebDep Container Engine ({})\n# Isolated DB: {}\n",
            container.container_id, db_dir_str
        );

        let mut keys: Vec<&String> = final_env.keys().collect();
        keys.sort();
        for k in keys {
            if let Some(v) = final_env.get(k) {
                if v.contains(' ') || v.contains('\n') || v.contains('"') || v.contains('#') {
                    dotenv_body.push_str(&format!("{}=\"{}\"\n", k, v.replace('"', "\\\"")));
                } else {
                    dotenv_body.push_str(&format!("{}={}\n", k, v));
                }
            }
        }

        (final_env, dotenv_body)
    }

    fn record_container_pid(&self, container: &WebsiteContainer, pid: u32) {
        if pid == 0 {
            return;
        }
        let pid_file = container.run_dir.join("pids.txt");
        let mut existing = std::fs::read_to_string(&pid_file).unwrap_or_default();
        existing.push_str(&format!("{}\n", pid));
        let _ = std::fs::write(&pid_file, existing);
    }

    fn read_container_pids(&self, container: &WebsiteContainer) -> Vec<u32> {
        let pid_file = container.run_dir.join("pids.txt");
        let content = std::fs::read_to_string(&pid_file).unwrap_or_default();
        content
            .lines()
            .filter_map(|l| l.trim().parse::<u32>().ok())
            .filter(|&pid| pid > 0 && pid != std::process::id())
            .collect()
    }

    fn clear_container_pids(&self, container: &WebsiteContainer) {
        let pid_file = container.run_dir.join("pids.txt");
        let _ = std::fs::remove_file(pid_file);
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
        let slug_lower = slug.to_lowercase();
        let env_proj_id = format!("WEBDEP_PROJECT_ID={}", project_id);
        let env_slug = format!("WEBDEP_PROJECT_SLUG={}", slug);

        for (pid, proc_) in sys.processes() {
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

            // 4. Working directory match (inside base_dir or app dir)
            if let Some(cwd) = proc_.cwd() {
                let cwd_str = cwd.to_string_lossy().to_lowercase();
                if !base_dir_str.is_empty() && (cwd_str == base_dir_str || cwd_str.starts_with(&base_dir_str)) {
                    matched_pids.insert(pid_u32);
                    continue;
                }
            }

            // 5. Command line match (references services/<slug> or containers/<slug>)
            let mut cmd_match = false;
            for arg in proc_.cmd() {
                let arg_lower = arg.to_string_lossy().to_lowercase();
                if (!base_dir_str.is_empty() && arg_lower.contains(&base_dir_str))
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

    pub async fn is_port_accepting(port: u16) -> bool {
        tokio::time::timeout(
            Duration::from_millis(150),
            tokio::net::TcpStream::connect(("127.0.0.1", port)),
        )
        .await
        .map(|r| r.is_ok())
        .unwrap_or(false)
    }

    /// Comprehensively shut down all processes, child trees, port listeners, and containers for a website or service.
    async fn kill_project_everything(&self, p: &Project) {
        // First stop any maintenance responder bound to this project's port
        self.stop_maintenance_server(p.id);
        tokio::time::sleep(Duration::from_millis(40)).await;

        let container = self.ensure_container(p);
        let mut pids_to_kill: HashSet<u32> = HashSet::new();

        // 1. In-memory Child handle: record PID, but DO NOT call start_kill() yet!
        // Calling start_kill() terminates the parent prematurely, causing taskkill /T to fail
        // on Windows because the dead parent's process tree link is broken.
        let old_child = {
            let mut map = self.processes.lock().unwrap();
            map.remove(&p.id)
        };
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
    }

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
        cmd.kill_on_drop(true);

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

    fn mark_project_stopped(&self, project_id: i64) {
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

    pub async fn set_maintenance_mode(&self, p: &Project, enabled: bool) -> Result<(), String> {
        if enabled {
            self.bump_stop_seq(p.id);
            {
                let conn = self.db.lock().unwrap();
                conn.execute(
                    "UPDATE projects SET app_status='maintenance', app_pid=NULL, app_started_at=NULL WHERE id=?",
                    rusqlite::params![p.id],
                )
                .ok();
            }

            let proj_lock = self.get_project_lock(p.id);
            let _guard = proj_lock.lock().await;
            self.kill_project_everything(p).await;

            {
                let conn = self.db.lock().unwrap();
                conn.execute(
                    "UPDATE projects SET app_status='maintenance', app_pid=NULL, app_started_at=NULL WHERE id=?",
                    rusqlite::params![p.id],
                )
                .ok();
            }

            if let Some(port) = p.port {
                self.start_maintenance_server(
                    p.id,
                    &p.name,
                    &p.slug,
                    port,
                    "Scheduled Maintenance • Developers Working",
                );
            }

            self.logs.add(
                Some(p.id),
                None,
                "app",
                "info",
                &format!(
                    "Enabled Maintenance Mode for '{}' (Port {} serving Maintenance Page)",
                    p.name,
                    p.port.unwrap_or(3000)
                ),
            );
        } else {
            self.stop_maintenance_server(p.id);
        }
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
            false
        }
    }

    /// Background task to continuously supervise long-running processes (services, bots, servers)
    /// and immediately mark them stopped in SQLite and log warnings when they exit or crash.
    pub fn start_background_monitor(self: &Arc<Self>) {
        let rt = self.clone();
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_secs(2)).await;
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
                    rt.logs.add(Some(proj_id), None, "app", "warn", &msg);
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
