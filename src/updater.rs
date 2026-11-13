use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use rusqlite::params;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tracing::{info, warn};

use crate::db::DbPool;
use crate::git::Git;

const RELEASE_CACHE_TTL: Duration = Duration::from_secs(60);

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct UpdateStatus {
    pub status: String, // "idle" | "in_progress" | "restarting" | "success" | "error"
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
    pub remote_url: String,
    pub has_update: bool,
    pub update_in_progress: bool,
    pub ready_to_restart: bool,
    pub current_version: String,
    pub current_release_tag: String,
    pub remote_version: Option<String>,
    pub remote_tag: Option<String>,
    pub release_name: Option<String>,
    pub release_url: Option<String>,
    pub asset_name: Option<String>,
    pub asset_size_bytes: Option<u64>,
    pub published_at: Option<String>,
    pub update_source: String,
    pub check_error: Option<String>,
}

#[derive(Deserialize)]
pub struct TriggerUpdatePayload {
    #[allow(dead_code)]
    pub branch: Option<String>,
    pub tag: Option<String>,
}

#[derive(Deserialize)]
pub struct SetUpdateRepoPayload {
    pub repo: String,
}

#[derive(Clone, Debug, Deserialize)]
struct GhReleaseAsset {
    name: String,
    browser_download_url: String,
    url: String,
    size: u64,
}

#[derive(Clone, Debug, Deserialize)]
struct GhReleaseResponse {
    tag_name: String,
    name: Option<String>,
    html_url: String,
    target_commitish: Option<String>,
    published_at: Option<String>,
    body: Option<String>,
    draft: Option<bool>,
    assets: Vec<GhReleaseAsset>,
}

#[derive(Clone)]
struct CachedReleaseCheck {
    fetched_at: Instant,
    repo_slug: String,
    result: Result<GhReleaseResponse, String>,
}

pub struct Updater {
    db: Option<DbPool>,
    status: Arc<Mutex<UpdateStatus>>,
    release_cache: Arc<Mutex<Option<CachedReleaseCheck>>>,
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

fn current_arch_asset_name() -> Option<&'static str> {
    if cfg!(target_os = "linux") {
        match std::env::consts::ARCH {
            "x86_64" => Some("webdep-linux-x86_64.tar.gz"),
            "aarch64" => Some("webdep-linux-aarch64.tar.gz"),
            _ => None,
        }
    } else {
        None
    }
}

/// Asset name to display during version checks even on non-Linux dev machines.
fn display_asset_name() -> &'static str {
    current_arch_asset_name().unwrap_or("webdep-linux-x86_64.tar.gz")
}

/// Resolves the live executable path safely, stripping Linux `(deleted)` suffix if unlinked.
fn resolve_active_exe_path() -> PathBuf {
    let exe_name = if cfg!(windows) { "webdep.exe" } else { "webdep" };
    if let Ok(exe) = std::env::current_exe() {
        let s = exe.to_string_lossy();
        if let Some(clean) = s.strip_suffix(" (deleted)") {
            return PathBuf::from(clean);
        }
        return exe;
    }
    Path::new("target").join("release").join(exe_name)
}

fn extract_short_sha_from_release(rel: &GhReleaseResponse) -> Option<String> {
    // Tags produced by release workflow follow `v<ver>-<ts>-<short_sha>`
    if let Some(last) = rel.tag_name.rsplit('-').next() {
        if last.len() == 7 && last.chars().all(|c| c.is_ascii_hexdigit()) {
            return Some(last.to_ascii_lowercase());
        }
    }
    if let Some(body) = &rel.body {
        for marker in ["commit `", "commit "] {
            if let Some(idx) = body.find(marker) {
                let tail = &body[idx + marker.len()..];
                let token: String = tail
                    .chars()
                    .take_while(|c| c.is_ascii_hexdigit())
                    .collect();
                if (7..=40).contains(&token.len()) {
                    return Some(token[..7].to_ascii_lowercase());
                }
            }
        }
    }
    if let Some(commitish) = &rel.target_commitish {
        let c = commitish.trim();
        if c.len() >= 7 && c.chars().take(7).all(|ch| ch.is_ascii_hexdigit()) {
            return Some(c[..7].to_ascii_lowercase());
        }
    }
    None
}

fn parse_checksum_for_asset(checksums_text: &str, asset_name: &str) -> Option<String> {
    for raw_line in checksums_text.lines() {
        let line = raw_line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let mut parts = line.split_whitespace();
        let digest = parts.next()?;
        let file_part = parts.next()?.trim_start_matches('*');
        let file_base = Path::new(file_part)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or(file_part);
        if file_base == asset_name
            && digest.len() == 64
            && digest.chars().all(|c| c.is_ascii_hexdigit())
        {
            return Some(digest.to_ascii_lowercase());
        }
    }
    None
}

fn compute_file_sha256_hex(path: &Path) -> Result<String, String> {
    let mut file = std::fs::File::open(path)
        .map_err(|e| format!("Failed to open downloaded file for hashing: {}", e))?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = file
            .read(&mut buf)
            .map_err(|e| format!("Failed to read file for SHA-256 verification: {}", e))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hex::encode(hasher.finalize()))
}

fn read_git_origin_slug() -> Option<&'static str> {
    static GIT_ORIGIN_SLUG: OnceLock<Option<String>> = OnceLock::new();
    GIT_ORIGIN_SLUG
        .get_or_init(|| {
            Command::new("git")
                .args(["remote", "get-url", "origin"])
                .output()
                .ok()
                .filter(|o| o.status.success())
                .and_then(|o| Git::extract_github_slug(&String::from_utf8_lossy(&o.stdout)))
        })
        .as_deref()
}

fn resolve_repo_slug_from_db(db: Option<&DbPool>) -> String {
    if let Some(pool) = db {
        if let Ok(conn) = pool.lock() {
            if let Ok(val) = conn.query_row(
                "SELECT value FROM settings WHERE key = 'update_repo'",
                [],
                |r| r.get::<_, String>(0),
            ) {
                if let Some(slug) = Git::extract_github_slug(&val) {
                    return slug;
                }
            }
        }
    }
    if let Some(slug) = read_git_origin_slug() {
        return slug.to_string();
    }
    env!("WEBDEP_DEFAULT_REPO").to_string()
}

fn resolve_github_token_from_db(db: Option<&DbPool>) -> Option<String> {
    if let Some(pool) = db {
        if let Ok(conn) = pool.lock() {
            if let Some(first) = Git::read_github_tokens_from_conn(&conn).into_iter().next() {
                return Some(first.token);
            }
            return None;
        }
    }
    Git::get_sqlite_github_tokens().into_iter().next().map(|t| t.token)
}

fn curl_get_text(url: &str, token: Option<&str>, accept: &str, timeout_secs: u64) -> Result<(u16, String), String> {
    let mut cmd = Command::new("curl");
    let timeout_str = timeout_secs.to_string();
    cmd.args([
        "-sSL",
        "--max-time",
        &timeout_str,
        "-w",
        "\n%{http_code}",
        "-H",
        &format!("Accept: {}", accept),
        "-H",
        "User-Agent: WebDep-Updater",
    ]);
    if let Some(tok) = token {
        cmd.args(["-H", &format!("Authorization: Bearer {}", tok.trim())]);
    }
    cmd.arg(url);

    let out = cmd
        .output()
        .map_err(|e| format!("Failed to run curl for {}: {}", url, e))?;

    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            format!("Network error while requesting {}", url)
        } else {
            stderr
        });
    }

    let raw = String::from_utf8_lossy(&out.stdout);
    let (body, code_str) = match raw.rsplit_once('\n') {
        Some((b, c)) => (b.to_string(), c.trim()),
        None => (String::new(), raw.trim()),
    };
    let status = code_str.parse::<u16>().unwrap_or(0);
    Ok((status, body))
}

fn curl_download_file(
    asset: &GhReleaseAsset,
    token: Option<&str>,
    dest: &Path,
    timeout_secs: u64,
) -> Result<(), String> {
    let dest_str = dest.to_str().ok_or("Invalid temporary file path")?;
    let timeout_str = timeout_secs.to_string();
    let mut cmd = Command::new("curl");
    cmd.args([
        "-fsSL",
        "--max-time",
        &timeout_str,
        "-H",
        "User-Agent: WebDep-Updater",
    ]);

    // For private repositories with a token, GitHub API asset URL with octet-stream avoids
    // forwarding the Authorization header to pre-signed external S3 redirects incorrectly.
    let target_url = if let Some(tok) = token {
        cmd.args([
            "-H",
            "Accept: application/octet-stream",
            "-H",
            &format!("Authorization: Bearer {}", tok.trim()),
        ]);
        &asset.url
    } else {
        &asset.browser_download_url
    };

    cmd.args(["-o", dest_str, target_url]);
    let out = cmd
        .output()
        .map_err(|e| format!("Failed to spawn curl to download {}: {}", asset.name, e))?;

    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            format!("Download failed for {} (exit code {:?})", asset.name, out.status.code())
        } else {
            format!("Download failed for {}: {}", asset.name, stderr)
        });
    }
    Ok(())
}

fn fetch_github_release(
    repo_slug: &str,
    tag: Option<&str>,
    token: Option<&str>,
) -> Result<GhReleaseResponse, String> {
    let url = match tag {
        Some(t) if !t.trim().is_empty() => format!(
            "https://api.github.com/repos/{}/releases/tags/{}",
            repo_slug,
            t.trim()
        ),
        _ => format!("https://api.github.com/repos/{}/releases/latest", repo_slug),
    };

    let (status, body) = curl_get_text(&url, token, "application/vnd.github+json", 12)?;
    match status {
        200 => serde_json::from_str::<GhReleaseResponse>(&body)
            .map_err(|e| format!("Invalid JSON from GitHub Releases API: {}", e)),
        404 => Err(format!(
            "No published GitHub Release found for '{}' yet. Push to main to trigger the release workflow.",
            repo_slug
        )),
        403 | 429 => Err(
            "GitHub API rate limit or permission error (403/429). Configure a GitHub token in Settings if this repository is private or rate-limited.".to_string()
        ),
        _ => Err(format!("GitHub Releases API returned HTTP {}", status)),
    }
}

fn find_extracted_binary(extract_dir: &Path, exe_name: &str) -> Option<PathBuf> {
    let direct = extract_dir.join(exe_name);
    if direct.is_file() {
        return Some(direct);
    }
    if let Ok(entries) = std::fs::read_dir(extract_dir) {
        for entry in entries.flatten() {
            let p = entry.path();
            if p.is_file() && p.file_name().and_then(|n| n.to_str()) == Some(exe_name) {
                return Some(p);
            }
            if p.is_dir() {
                let nested = p.join(exe_name);
                if nested.is_file() {
                    return Some(nested);
                }
            }
        }
    }
    None
}

impl Updater {
    pub fn with_db(db: DbPool) -> Self {
        Self {
            db: Some(db),
            status: Arc::new(Mutex::new(UpdateStatus::default())),
            release_cache: Arc::new(Mutex::new(None)),
        }
    }

    pub fn get_status(&self) -> UpdateStatus {
        self.status.lock().unwrap().clone()
    }

    fn get_latest_release_cached(&self, repo_slug: &str, force_refresh: bool) -> Result<GhReleaseResponse, String> {
        if !force_refresh {
            if let Ok(guard) = self.release_cache.lock() {
                if let Some(cached) = guard.as_ref() {
                    if cached.repo_slug == repo_slug && cached.fetched_at.elapsed() < RELEASE_CACHE_TTL {
                        return cached.result.clone();
                    }
                }
            }
        }

        let token = resolve_github_token_from_db(self.db.as_ref());
        let result = fetch_github_release(repo_slug, None, token.as_deref());
        if let Ok(mut guard) = self.release_cache.lock() {
            *guard = Some(CachedReleaseCheck {
                fetched_at: Instant::now(),
                repo_slug: repo_slug.to_string(),
                result: result.clone(),
            });
        }
        result
    }

    pub fn get_version_info(&self, force_refresh: bool) -> GitVersionInfo {
        let (is_updating, ready_to_restart) = {
            let st = self.status.lock().unwrap();
            (st.status == "in_progress", st.status == "ready_to_restart")
        };

        let current_version = env!("WEBDEP_VERSION").to_string();
        let current_commit = env!("WEBDEP_COMMIT_SHA").to_string();
        let current_release_tag = env!("WEBDEP_RELEASE_TAG").to_string();
        let commit_message = env!("WEBDEP_COMMIT_MSG").to_string();

        let repo_slug = resolve_repo_slug_from_db(self.db.as_ref());
        let remote_url = format!("https://github.com/{}", repo_slug);
        let desired_asset = display_asset_name();

        let (
            remote_tag,
            remote_commit,
            remote_version,
            release_name,
            release_url,
            asset_name,
            asset_size_bytes,
            published_at,
            check_error,
        ) = match self.get_latest_release_cached(&repo_slug, force_refresh) {
            Ok(rel) => {
                let sha = extract_short_sha_from_release(&rel);
                let matched_asset = rel
                    .assets
                    .iter()
                    .find(|a| a.name == desired_asset && !rel.draft.unwrap_or(false));
                let fallback_asset = matched_asset.or_else(|| {
                    rel.assets
                        .iter()
                        .find(|a| a.name.ends_with(".tar.gz"))
                });
                (
                    Some(rel.tag_name.clone()),
                    sha,
                    Some(rel.tag_name.clone()),
                    rel.name.or_else(|| Some(rel.tag_name)),
                    Some(rel.html_url),
                    fallback_asset.map(|a| a.name.clone()),
                    fallback_asset.map(|a| a.size),
                    rel.published_at,
                    None,
                )
            }
            Err(err) => (None, None, None, None, None, None, None, None, Some(err)),
        };

        let has_update = match (&remote_tag, &remote_commit) {
            (Some(r_tag), Some(r_sha))
                if current_commit != "unknown" && !current_commit.is_empty() =>
            {
                r_tag != &current_release_tag && !r_sha.eq_ignore_ascii_case(&current_commit)
            }
            (Some(r_tag), _) => r_tag != &current_release_tag,
            _ => false,
        };

        GitVersionInfo {
            current_commit,
            current_branch: current_release_tag.clone(),
            commit_message,
            remote_commit: remote_commit.or_else(|| remote_tag.clone()),
            remote_url,
            has_update,
            update_in_progress: is_updating,
            ready_to_restart,
            current_version,
            current_release_tag,
            remote_version,
            remote_tag,
            release_name,
            release_url,
            asset_name,
            asset_size_bytes,
            published_at,
            update_source: "github_release".to_string(),
            check_error,
        }
    }

    pub fn set_remote_repo(&self, repo_input: &str) -> Result<String, String> {
        let trimmed = repo_input.trim();
        if trimmed.is_empty() {
            return Err("Repository name or URL cannot be empty".to_string());
        }
        if trimmed.chars().any(|c| c.is_whitespace()) {
            return Err("Repository name or URL cannot contain spaces".to_string());
        }

        let slug = Git::extract_github_slug(trimmed)
            .ok_or_else(|| "Enter a valid GitHub repo (e.g. owner/repo or https://github.com/owner/repo)".to_string())?;

        if let Some(pool) = &self.db {
            if let Ok(conn) = pool.lock() {
                conn.execute(
                    "INSERT INTO settings(key, value) VALUES('update_repo', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                    params![&slug],
                )
                .map_err(|e| format!("Failed to save update repository setting: {}", e))?;
            }
        }

        // Keep local git origin synchronized on best-effort basis if running inside a git checkout
        let git_url = format!("https://github.com/{}.git", slug);
        if Path::new(".git").exists() {
            let set_out = Command::new("git")
                .args(["remote", "set-url", "origin", &git_url])
                .output();
            if let Ok(o) = set_out {
                if !o.status.success() {
                    let _ = Command::new("git")
                        .args(["remote", "add", "origin", &git_url])
                        .output();
                }
            }
        }

        if let Ok(mut guard) = self.release_cache.lock() {
            *guard = None;
        }

        Ok(format!("https://github.com/{}", slug))
    }

    pub fn start_update(&self, tag_override: Option<String>) -> Result<(), String> {
        let mut st = self.status.lock().unwrap();
        if st.status == "in_progress" {
            return Err("An update is already running in background".to_string());
        }

        *st = UpdateStatus {
            status: "in_progress".to_string(),
            step: "Initializing release update...".to_string(),
            progress: 5,
            logs: vec![format!(
                "[{}] Starting WebDep prebuilt GitHub Release update...",
                now_time_str()
            )],
            error: None,
            started_at: Some(now_secs()),
            finished_at: None,
        };

        let status_arc = self.status.clone();
        let cache_arc = self.release_cache.clone();
        let db = self.db.clone();
        tokio::task::spawn_blocking(move || {
            Self::run_update_pipeline(status_arc, cache_arc, db, tag_override);
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

    fn fail_update(status_arc: &Arc<Mutex<UpdateStatus>>, err: String) {
        Self::append_log(status_arc, &format!("[Error] {}", err));
        if let Ok(mut st) = status_arc.lock() {
            st.status = "error".to_string();
            st.error = Some(err);
            st.finished_at = Some(now_secs());
        }
    }

    fn run_update_pipeline(
        status_arc: Arc<Mutex<UpdateStatus>>,
        cache_arc: Arc<Mutex<Option<CachedReleaseCheck>>>,
        db: Option<DbPool>,
        tag_override: Option<String>,
    ) {
        // STEP 1: Verify platform support, target binary path, and preserve .env/data
        Self::set_step(&status_arc, "Verifying environment & binary path...", 10);

        let asset_name = match current_arch_asset_name() {
            Some(name) => name,
            None => {
                Self::fail_update(
                    &status_arc,
                    format!(
                        "Prebuilt GitHub Release updates target Linux (x86_64 / aarch64); automatic binary update is unsupported on {}/{}.",
                        std::env::consts::OS,
                        std::env::consts::ARCH
                    ),
                );
                return;
            }
        };

        let active_exe = resolve_active_exe_path();
        let exe_dir = active_exe
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| PathBuf::from("."));
        let exe_name = active_exe
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("webdep")
            .to_string();

        Self::append_log(
            &status_arc,
            &format!("[Target] Active binary path: {} (asset: {})", active_exe.display(), asset_name),
        );

        let env_path = Path::new(".env");
        let env_bak = Path::new(".env.updater-backup");
        if env_path.exists() {
            if let Err(e) = std::fs::copy(env_path, env_bak) {
                warn!("Could not back up .env: {}", e);
            } else {
                Self::append_log(&status_arc, "[Safety] Backed up .env configuration before binary swap");
            }
        }
        Self::append_log(&status_arc, "[Safety] data/ directory and SQLite databases remain untouched");

        // STEP 2: Query GitHub Releases API
        Self::set_step(&status_arc, "Fetching latest GitHub Release metadata...", 25);
        let repo_slug = resolve_repo_slug_from_db(db.as_ref());
        let token = resolve_github_token_from_db(db.as_ref());
        Self::append_log(&status_arc, &format!("[GitHub] Checking releases on {}...", repo_slug));

        let release = match fetch_github_release(&repo_slug, tag_override.as_deref(), token.as_deref()) {
            Ok(r) => r,
            Err(e) => {
                Self::fail_update(&status_arc, e);
                return;
            }
        };

        let target_asset = match release.assets.iter().find(|a| a.name == asset_name) {
            Some(a) => a.clone(),
            None => {
                Self::fail_update(
                    &status_arc,
                    format!(
                        "Release '{}' does not contain asset '{}'. Check GitHub Actions release build.",
                        release.tag_name, asset_name
                    ),
                );
                return;
            }
        };
        let checksum_asset = match release.assets.iter().find(|a| a.name == "checksums.txt") {
            Some(a) => a.clone(),
            None => {
                Self::fail_update(
                    &status_arc,
                    format!(
                        "Release '{}' is missing checksums.txt required for SHA-256 verification.",
                        release.tag_name
                    ),
                );
                return;
            }
        };

        Self::append_log(
            &status_arc,
            &format!(
                "[GitHub] Found release '{}' ({} bytes for {})",
                release.tag_name, target_asset.size, target_asset.name
            ),
        );

        // STEP 3: Download archive & checksums into isolated staging folder
        Self::set_step(&status_arc, &format!("Downloading {}...", target_asset.name), 50);

        let stage_dir = PathBuf::from(format!("data/tmp/updater-{}", now_secs()));
        if let Err(e) = std::fs::create_dir_all(&stage_dir) {
            Self::fail_update(
                &status_arc,
                format!("Failed to create staging directory {}: {}", stage_dir.display(), e),
            );
            return;
        }

        let archive_path = stage_dir.join(&target_asset.name);
        let checksums_path = stage_dir.join("checksums.txt");
        let extract_dir = stage_dir.join("extract");

        if let Err(e) = curl_download_file(&checksum_asset, token.as_deref(), &checksums_path, 15) {
            let _ = std::fs::remove_dir_all(&stage_dir);
            Self::fail_update(&status_arc, e);
            return;
        }
        if let Err(e) = curl_download_file(&target_asset, token.as_deref(), &archive_path, 180) {
            let _ = std::fs::remove_dir_all(&stage_dir);
            Self::fail_update(&status_arc, e);
            return;
        }
        Self::append_log(&status_arc, "[Download] Downloaded release archive and checksums.txt");

        // STEP 4: Verify SHA-256 checksum strictly before extracting
        Self::set_step(&status_arc, "Verifying SHA-256 checksum & extracting binary...", 70);
        let checksums_text = match std::fs::read_to_string(&checksums_path) {
            Ok(s) => s,
            Err(e) => {
                let _ = std::fs::remove_dir_all(&stage_dir);
                Self::fail_update(&status_arc, format!("Failed to read checksums.txt: {}", e));
                return;
            }
        };
        let expected_sha = match parse_checksum_for_asset(&checksums_text, &target_asset.name) {
            Some(h) => h,
            None => {
                let _ = std::fs::remove_dir_all(&stage_dir);
                Self::fail_update(
                    &status_arc,
                    format!("No SHA-256 entry for '{}' found in checksums.txt", target_asset.name),
                );
                return;
            }
        };
        let actual_sha = match compute_file_sha256_hex(&archive_path) {
            Ok(h) => h,
            Err(e) => {
                let _ = std::fs::remove_dir_all(&stage_dir);
                Self::fail_update(&status_arc, e);
                return;
            }
        };
        if actual_sha != expected_sha {
            let _ = std::fs::remove_dir_all(&stage_dir);
            Self::fail_update(
                &status_arc,
                format!(
                    "SHA-256 verification FAILED for {}: expected {}, got {}",
                    target_asset.name, expected_sha, actual_sha
                ),
            );
            return;
        }
        Self::append_log(&status_arc, &format!("[Verify] SHA-256 verified: {}", actual_sha));

        if let Err(e) = std::fs::create_dir_all(&extract_dir) {
            let _ = std::fs::remove_dir_all(&stage_dir);
            Self::fail_update(&status_arc, format!("Failed to create extract dir: {}", e));
            return;
        }
        let tar_out = Command::new("tar")
            .args([
                "-xzf",
                archive_path.to_str().unwrap_or_default(),
                "-C",
                extract_dir.to_str().unwrap_or_default(),
            ])
            .output();
        match tar_out {
            Ok(o) if o.status.success() => {}
            Ok(o) => {
                let _ = std::fs::remove_dir_all(&stage_dir);
                let err = String::from_utf8_lossy(&o.stderr).trim().to_string();
                Self::fail_update(&status_arc, format!("Failed to extract tarball: {}", err));
                return;
            }
            Err(e) => {
                let _ = std::fs::remove_dir_all(&stage_dir);
                Self::fail_update(&status_arc, format!("Failed to execute tar: {}", e));
                return;
            }
        }

        let extracted_bin = match find_extracted_binary(&extract_dir, &exe_name) {
            Some(p) => p,
            None => {
                let _ = std::fs::remove_dir_all(&stage_dir);
                Self::fail_update(
                    &status_arc,
                    format!("Archive '{}' did not contain '{}'", target_asset.name, exe_name),
                );
                return;
            }
        };

        // Stage next to active_exe so the final rename swap is atomic on the same filesystem
        let staged_new = exe_dir.join(format!("{}.new", exe_name));
        let old_exe = exe_dir.join(format!("{}.old", exe_name));
        if let Err(e) = std::fs::copy(&extracted_bin, &staged_new) {
            let _ = std::fs::remove_dir_all(&stage_dir);
            let _ = std::fs::remove_file(&staged_new);
            Self::fail_update(
                &status_arc,
                format!("Failed to stage binary at {}: {}", staged_new.display(), e),
            );
            return;
        }

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&staged_new, std::fs::Permissions::from_mode(0o755));
        }

        // Smoke-check executable runs cleanly before touching live binary
        match Command::new(&staged_new).arg("--version").output() {
            Ok(o) if o.status.success() => {
                let ver_line = String::from_utf8_lossy(&o.stdout).trim().to_string();
                Self::append_log(&status_arc, &format!("[Verify] New binary smoke test OK: {}", ver_line));
            }
            Ok(o) => {
                let _ = std::fs::remove_file(&staged_new);
                let _ = std::fs::remove_dir_all(&stage_dir);
                let err = String::from_utf8_lossy(&o.stderr).trim().to_string();
                Self::fail_update(
                    &status_arc,
                    format!("New binary failed `--version` smoke check: {}", err),
                );
                return;
            }
            Err(e) => {
                let _ = std::fs::remove_file(&staged_new);
                let _ = std::fs::remove_dir_all(&stage_dir);
                Self::fail_update(
                    &status_arc,
                    format!("Failed to execute new binary smoke check: {}", e),
                );
                return;
            }
        }

        // STEP 5: Atomic binary hot-swap with automatic rollback
        Self::set_step(&status_arc, "Swapping WebDep binary...", 90);
        if active_exe.exists() {
            if old_exe.exists() {
                let _ = std::fs::remove_file(&old_exe);
            }
            if let Err(e) = std::fs::rename(&active_exe, &old_exe) {
                let _ = std::fs::remove_file(&staged_new);
                let _ = std::fs::remove_dir_all(&stage_dir);
                Self::fail_update(
                    &status_arc,
                    format!("Could not move active binary aside for hot-swap: {}", e),
                );
                return;
            }
        }

        if let Err(e) = std::fs::rename(&staged_new, &active_exe) {
            if old_exe.exists() && !active_exe.exists() {
                let _ = std::fs::rename(&old_exe, &active_exe);
                Self::append_log(&status_arc, "[Recovery] Restored previous binary intact after swap failure.");
            }
            let _ = std::fs::remove_file(&staged_new);
            let _ = std::fs::remove_dir_all(&stage_dir);
            Self::fail_update(&status_arc, format!("Failed to activate new binary: {}", e));
            return;
        }

        if old_exe.exists() {
            let _ = std::fs::remove_file(&old_exe);
        }
        let _ = std::fs::remove_dir_all(&stage_dir);

        if env_bak.exists() && !env_path.exists() {
            let _ = std::fs::copy(env_bak, env_path);
        }
        if env_bak.exists() {
            let _ = std::fs::remove_file(env_bak);
        }

        if let Ok(mut guard) = cache_arc.lock() {
            *guard = None;
        }

        Self::append_log(
            &status_arc,
            &format!("[Success] Upgraded WebDep binary to release {}", release.tag_name),
        );
        Self::append_log(&status_arc, "[Restart] Automatically restarting WebDep panel now...");
        Self::set_step(&status_arc, "Update complete! Restarting WebDep panel...", 100);

        if let Ok(mut st) = status_arc.lock() {
            st.status = "restarting".to_string();
            st.progress = 100;
            st.step = "Update complete! Restarting WebDep panel...".to_string();
            st.finished_at = Some(now_secs());
        }

        restart_service_delayed(1200);
    }
}

pub fn restart_service_delayed(delay_ms: u64) {
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(delay_ms)).await;

        #[cfg(unix)]
        {
            let is_systemd = tokio::process::Command::new("systemctl")
                .args(["is-active", "--quiet", "webdep"])
                .status()
                .await
                .map(|s| s.success())
                .unwrap_or(false);

            if is_systemd {
                info!("Restarting WebDep via systemd service 'webdep'...");
                let _ = tokio::process::Command::new("sh")
                    .args(["-c", "if [ -f /etc/systemd/system/webdep.service ] && ! grep -q KillMode=process /etc/systemd/system/webdep.service; then (sudo sed -i '/RestartSec=/a KillMode=process' /etc/systemd/system/webdep.service && sudo systemctl daemon-reload) >/dev/null 2>&1; fi; (sleep 0.5 && (sudo systemctl restart webdep || systemctl restart webdep)) >/dev/null 2>&1 &"])
                    .spawn();
                return;
            }

            if let Ok(cwd) = std::env::current_dir() {
                let bin = resolve_active_exe_path();
                if bin.exists() {
                    info!("Spawning fresh WebDep binary detached at: {}", bin.display());
                    let _ = tokio::process::Command::new(bin)
                        .current_dir(&cwd)
                        .env("MALLOC_ARENA_MAX", "2")
                        .env("MALLOC_TRIM_THRESHOLD_", "65536")
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
                let bin = resolve_active_exe_path();
                if tokio::fs::try_exists(&bin).await.unwrap_or(false) {
                    let mut cmd = tokio::process::Command::new(bin);
                    cmd.current_dir(&cwd)
                        .stdin(Stdio::null())
                        .stdout(Stdio::null())
                        .stderr(Stdio::null());
                    cmd.creation_flags(0x00000008 | 0x00000200);
                    let _ = cmd.spawn();
                }
            }
            std::process::exit(0);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_checksum_for_asset_and_sha256_hash() {
        let checksums = "\
e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855  webdep-linux-x86_64.tar.gz\n\
ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff *dist/webdep-linux-aarch64.tar.gz\n";
        assert_eq!(
            parse_checksum_for_asset(checksums, "webdep-linux-x86_64.tar.gz").as_deref(),
            Some("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")
        );
        assert_eq!(
            parse_checksum_for_asset(checksums, "webdep-linux-aarch64.tar.gz").as_deref(),
            Some("ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff")
        );
        assert_eq!(parse_checksum_for_asset(checksums, "missing.tar.gz"), None);

        let tmp = std::env::temp_dir().join(format!("webdep-sha-test-{}.bin", now_secs()));
        std::fs::write(&tmp, b"").unwrap();
        assert_eq!(
            compute_file_sha256_hex(&tmp).unwrap(),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        let _ = std::fs::remove_file(&tmp);
    }

    #[test]
    fn test_extract_short_sha_from_release_tag_or_body() {
        let rel = GhReleaseResponse {
            tag_name: "v2.0.0-20261114015000-4db0a40".to_string(),
            name: None,
            html_url: "https://github.com/a/b/releases/tag/v2.0.0-20261114015000-4db0a40".to_string(),
            target_commitish: Some("main".to_string()),
            published_at: None,
            body: None,
            draft: Some(false),
            assets: vec![],
        };
        assert_eq!(extract_short_sha_from_release(&rel).as_deref(), Some("4db0a40"));

        let tagged = GhReleaseResponse {
            tag_name: "v2.1.0".to_string(),
            body: Some("Automated build for commit `abc1234`.".to_string()),
            ..rel
        };
        assert_eq!(extract_short_sha_from_release(&tagged).as_deref(), Some("abc1234"));
    }

    #[test]
    fn test_set_remote_repo_persists_slug_in_db() {
        let dir = std::env::temp_dir().join(format!("webdep-updater-repo-{}", now_secs()));
        std::fs::create_dir_all(&dir).unwrap();
        let db = crate::db::open_db(&dir).unwrap();
        let updater = Updater::with_db(db);
        let saved = updater.set_remote_repo("acme/webdep-panel.git").unwrap();
        assert_eq!(saved, "https://github.com/acme/webdep-panel");
        assert_eq!(
            resolve_repo_slug_from_db(updater.db.as_ref()),
            "acme/webdep-panel"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
