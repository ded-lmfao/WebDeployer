use serde::{Deserialize, Serialize};
use std::path::Path;
use std::process::Command;

#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct CommitInfo {
    pub sha: String,
    pub short_sha: String,
    pub author: String,
    pub date: i64,
    pub message: String,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct AheadBehind {
    pub ahead: u32,
    pub behind: u32,
}

pub struct Git;

fn copy_dir_all(src: &Path, dst: &Path, skip_git: bool) -> Result<(), String> {
    std::fs::create_dir_all(dst).map_err(|e| e.to_string())?;
    for entry in std::fs::read_dir(src).map_err(|e| e.to_string())?.flatten() {
        let name = entry.file_name();
        if skip_git && name == ".git" {
            continue;
        }
        let src_path = entry.path();
        let dst_path = dst.join(&name);
        if src_path.is_dir() {
            copy_dir_all(&src_path, &dst_path, false)?;
        } else {
            std::fs::copy(&src_path, &dst_path).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

impl Git {
    fn get_sqlite_github_token() -> Option<String> {
        let db_path = std::env::var("WEBDEP_DB")
            .or_else(|_| std::env::var("NEXUS_DB"))
            .unwrap_or_else(|_| "./data/webdep.sqlite".into());
        let conn = rusqlite::Connection::open(db_path).ok()?;
        let tok: String = conn
            .query_row(
                "SELECT value FROM settings WHERE key = 'github_token'",
                [],
                |r| r.get(0),
            )
            .ok()?;
        let trimmed = tok.trim().to_string();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed)
        }
    }

    fn inject_token_url(repo_url: &str) -> String {
        if let Some(tok) = Self::get_sqlite_github_token() {
            if let Some(rest) = repo_url.strip_prefix("https://github.com/") {
                return format!("https://x-access-token:{}@github.com/{}", tok, rest);
            }
        }
        repo_url.to_string()
    }

    pub fn resolve_head(repo_dir: &Path) -> Result<String, String> {
        let out = Command::new("git")
            .current_dir(repo_dir)
            .args(["rev-parse", "HEAD"])
            .output()
            .map_err(|e| format!("Failed to run git rev-parse: {}", e))?;

        if out.status.success() {
            Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
        } else {
            Err(String::from_utf8_lossy(&out.stderr).to_string())
        }
    }

    pub fn fetch(repo_dir: &Path, branch: &str) -> Result<(), String> {
        let out = Command::new("git")
            .current_dir(repo_dir)
            .args(["fetch", "origin", branch])
            .output()
            .map_err(|e| format!("Failed to run git fetch: {}", e))?;

        if out.status.success() {
            Ok(())
        } else {
            Err(String::from_utf8_lossy(&out.stderr).to_string())
        }
    }

    pub fn clone_or_fetch(repo_url: &str, target_dir: &Path, branch: &str) -> Result<(), String> {
        let auth_url = Self::inject_token_url(repo_url);
        if target_dir.join(".git").exists() {
            let _ = Command::new("git")
                .current_dir(target_dir)
                .args(["remote", "set-url", "origin", &auth_url])
                .output();
            Self::fetch(target_dir, branch)?;
        } else {
            std::fs::create_dir_all(target_dir).ok();
            let out = Command::new("git")
                .args(["clone", "--branch", branch, &auth_url, target_dir.to_str().unwrap_or(".")])
                .output()
                .map_err(|e| format!("Failed to run git clone: {}", e))?;

            if !out.status.success() {
                return Err(String::from_utf8_lossy(&out.stderr).to_string());
            }
        }
        Ok(())
    }

    pub fn checkout(repo_dir: &Path, sha: &str, destination_dir: &Path) -> Result<(), String> {
        std::fs::create_dir_all(destination_dir).map_err(|e| e.to_string())?;

        let out = Command::new("git")
            .current_dir(repo_dir)
            .args(["checkout", sha])
            .output()
            .map_err(|e| format!("Git checkout error: {}", e))?;

        if !out.status.success() {
            return Err(String::from_utf8_lossy(&out.stderr).to_string());
        }

        // Copy files recursively from repo_dir to release destination (excluding .git)
        copy_dir_all(repo_dir, destination_dir, true)?;

        Ok(())
    }

    pub fn get_commit_info(repo_dir: &Path, sha: &str) -> Result<CommitInfo, String> {
        let out = Command::new("git")
            .current_dir(repo_dir)
            .args(["log", "-1", "--format=%H%n%an%n%at%n%B", sha])
            .output()
            .map_err(|e| format!("Failed to read commit log: {}", e))?;

        if !out.status.success() {
            return Err(String::from_utf8_lossy(&out.stderr).to_string());
        }

        let raw = String::from_utf8_lossy(&out.stdout);
        let mut lines = raw.lines();
        let full_sha = lines.next().unwrap_or(sha).trim().to_string();
        let author = lines.next().unwrap_or("Unknown").trim().to_string();
        let date: i64 = lines.next().and_then(|d| d.trim().parse().ok()).unwrap_or(0);
        let message = lines.collect::<Vec<&str>>().join("\n").trim().to_string();

        let short_sha = if full_sha.len() >= 7 {
            full_sha[..7].to_string()
        } else {
            full_sha.clone()
        };

        Ok(CommitInfo {
            sha: full_sha,
            short_sha,
            author,
            date: date * 1000,
            message,
        })
    }

    pub fn ahead_behind(repo_dir: &Path, local_sha: &str, remote_ref: &str) -> AheadBehind {
        let out = Command::new("git")
            .current_dir(repo_dir)
            .args(["rev-list", "--left-right", "--count", &format!("{}...{}", local_sha, remote_ref)])
            .output();

        if let Ok(o) = out {
            if o.status.success() {
                let text = String::from_utf8_lossy(&o.stdout);
                let parts: Vec<&str> = text.split_whitespace().collect();
                if parts.len() == 2 {
                    let ahead = parts[0].parse().unwrap_or(0);
                    let behind = parts[1].parse().unwrap_or(0);
                    return AheadBehind { ahead, behind };
                }
            }
        }

        AheadBehind { ahead: 0, behind: 0 }
    }

    pub fn list_commits(repo_dir: &Path, branch: &str, limit: usize) -> Vec<CommitInfo> {
        let target = if branch.is_empty() { "HEAD".to_string() } else { format!("origin/{}", branch) };
        let out = Command::new("git")
            .current_dir(repo_dir)
            .args([
                "log",
                &format!("-{}", limit),
                "--format=%H\x1f%h\x1f%an\x1f%at\x1f%s",
                &target,
            ])
            .output()
            .or_else(|_| {
                Command::new("git")
                    .current_dir(repo_dir)
                    .args([
                        "log",
                        &format!("-{}", limit),
                        "--format=%H\x1f%h\x1f%an\x1f%at\x1f%s",
                    ])
                    .output()
            });

        let mut list = Vec::new();
        if let Ok(o) = out {
            let text = String::from_utf8_lossy(&o.stdout);
            for line in text.lines() {
                let parts: Vec<&str> = line.split('\x1f').collect();
                if parts.len() >= 5 {
                    let date_s: i64 = parts[3].parse().unwrap_or(0);
                    list.push(CommitInfo {
                        sha: parts[0].to_string(),
                        short_sha: parts[1].to_string(),
                        author: parts[2].to_string(),
                        date: date_s * 1000,
                        message: parts[4].to_string(),
                    });
                }
            }
        }
        list
    }

    pub fn ls_remote(repo_url: &str, branch: &str) -> Result<String, String> {
        let out = Command::new("git")
            .args(["ls-remote", repo_url, &format!("refs/heads/{}", branch)])
            .output()
            .map_err(|e| e.to_string())?;

        if out.status.success() {
            let text = String::from_utf8_lossy(&out.stdout);
            if let Some(first_line) = text.lines().next() {
                if let Some(sha) = first_line.split_whitespace().next() {
                    return Ok(sha.to_string());
                }
            }
            Ok(String::new())
        } else {
            Err(String::from_utf8_lossy(&out.stderr).to_string())
        }
    }
}
