use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

use crate::projects::Project;
use super::Runtime;

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



impl Runtime {
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

        let port = if let Some(p_port) = p.port.filter(|&pt| pt > 0) {
            p_port
        } else {
            let default_start = if p.project_kind == "service" { 8000 } else { 3000 };
            let allocated = if let Ok(conn) = self.db.lock() {
                let alloc = crate::db::allocate_global_unique_port(&conn, None, default_start, Some(p.id), None).unwrap_or(default_start);
                let _ = conn.execute("UPDATE projects SET port = ? WHERE id = ?", rusqlite::params![alloc as u32, p.id]);
                alloc
            } else {
                default_start
            };
            allocated
        };
        self.allow_firewall_port(port, Some(p.id));

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
                    let link_str = data_subdir.to_string_lossy().replace('/', "\\").trim_start_matches(r"\\?\").to_string();
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
                let link_str = data_subdir.to_string_lossy().replace('/', "\\").trim_start_matches(r"\\?\").to_string();
                let target_str = target_db_dir.to_string_lossy().replace('/', "\\").trim_start_matches(r"\\?\").to_string();
                let out = std::process::Command::new("cmd")
                    .args(["/C", "mklink", "/J", &link_str, &target_str])
                    .output();
                if out.map(|o| !o.status.success()).unwrap_or(true) {
                    let _ = std::os::windows::fs::symlink_dir(target_db_dir, &data_subdir);
                }
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

    pub(crate) fn record_container_pid(&self, container: &WebsiteContainer, pid: u32) {
        if pid == 0 {
            return;
        }
        let pid_file = container.run_dir.join("pids.txt");
        let mut existing = std::fs::read_to_string(&pid_file).unwrap_or_default();
        existing.push_str(&format!("{}\n", pid));
        let _ = std::fs::write(&pid_file, existing);
    }

    pub(crate) fn read_container_pids(&self, container: &WebsiteContainer) -> Vec<u32> {
        let pid_file = container.run_dir.join("pids.txt");
        let content = std::fs::read_to_string(&pid_file).unwrap_or_default();
        content
            .lines()
            .filter_map(|l| l.trim().parse::<u32>().ok())
            .filter(|&pid| pid > 0 && pid != std::process::id())
            .collect()
    }

    pub(crate) fn clear_container_pids(&self, container: &WebsiteContainer) {
        let pid_file = container.run_dir.join("pids.txt");
        let _ = std::fs::remove_file(pid_file);
    }


}
