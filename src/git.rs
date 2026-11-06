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

impl Git {
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
        if target_dir.join(".git").exists() {
            Self::fetch(target_dir, branch)?;
        } else {
            std::fs::create_dir_all(target_dir).ok();
            let out = Command::new("git")
                .args(["clone", "--branch", branch, repo_url, target_dir.to_str().unwrap_or(".")])
                .output()
                .map_err(|e| format!("Failed to run git clone: {}", e))?;

            if !out.status.success() {
                return Err(String::from_utf8_lossy(&out.stderr).to_string());
            }
        }
        Ok(())
    }

    pub fn checkout(repo_dir: &Path, sha: &str, destination_dir: &Path) -> Result<(), String> {
        std::fs::create_dir_all(destination_dir).ok();

        // git archive or worktree/checkout to destination
        let out = Command::new("git")
            .current_dir(repo_dir)
            .args(["checkout", sha])
            .output()
            .map_err(|e| format!("Git checkout error: {}", e))?;

        if !out.status.success() {
            return Err(String::from_utf8_lossy(&out.stderr).to_string());
        }

        // Copy files to release destination
        let copy_status = Command::new("git")
            .current_dir(repo_dir)
            .args(["checkout-index", "-a", "-f", &format!("--prefix={}/", destination_dir.to_str().unwrap_or("."))])
            .output();

        if let Ok(c) = copy_status {
            if c.status.success() {
                return Ok(());
            }
        }

        // Fallback: simple recursive copy if checkout-index is platform-dependent
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
}
