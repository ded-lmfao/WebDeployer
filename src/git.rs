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

#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct StoredGithubToken {
    #[serde(default)]
    pub label: String,
    pub token: String,
}

impl Git {
    pub fn get_sqlite_github_tokens() -> Vec<StoredGithubToken> {
        let db_path = std::env::var("WEBDEP_DB")
            .or_else(|_| std::env::var("NEXUS_DB"))
            .unwrap_or_else(|_| "./data/webdep.sqlite".into());
        let Ok(conn) = rusqlite::Connection::open(db_path) else {
            return Vec::new();
        };

        let mut list: Vec<StoredGithubToken> = Vec::new();
        let mut seen = std::collections::HashSet::new();

        // 1. Read structured multi-token JSON list (`github_tokens`)
        if let Ok(raw_json) = conn.query_row(
            "SELECT value FROM settings WHERE key = 'github_tokens'",
            [],
            |r| r.get::<_, String>(0),
        ) {
            if let Ok(parsed) = serde_json::from_str::<Vec<StoredGithubToken>>(&raw_json) {
                for item in parsed {
                    let t = item.token.trim().to_string();
                    if !t.is_empty() && seen.insert(t.clone()) {
                        list.push(StoredGithubToken {
                            label: if item.label.trim().is_empty() {
                                format!("Token #{}", list.len() + 1)
                            } else {
                                item.label.trim().to_string()
                            },
                            token: t,
                        });
                    }
                }
            }
        }

        // 2. Also include any token(s) in `github_token` (supports single or comma/newline-separated tokens)
        if let Ok(raw_single) = conn.query_row(
            "SELECT value FROM settings WHERE key = 'github_token'",
            [],
            |r| r.get::<_, String>(0),
        ) {
            for part in raw_single.split(|c| c == ',' || c == '\n' || c == ';') {
                let t = part.trim().to_string();
                if !t.is_empty() && seen.insert(t.clone()) {
                    list.push(StoredGithubToken {
                        label: format!("Token #{}", list.len() + 1),
                        token: t,
                    });
                }
            }
        }

        list
    }

    fn candidate_auth_urls(repo_url: &str) -> Vec<String> {
        let tokens = Self::get_sqlite_github_tokens();
        if let Some(rest) = repo_url.strip_prefix("https://github.com/") {
            let mut urls: Vec<String> = tokens
                .into_iter()
                .map(|t| format!("https://x-access-token:{}@github.com/{}", t.token, rest))
                .collect();
            // Always keep unauthenticated URL as final fallback for public repos
            urls.push(repo_url.to_string());
            urls
        } else {
            vec![repo_url.to_string()]
        }
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
        let candidates = Self::candidate_auth_urls(repo_url);
        let mut last_err = String::from("Git operation failed");

        if target_dir.join(".git").exists() {
            for auth_url in &candidates {
                let _ = Command::new("git")
                    .current_dir(target_dir)
                    .args(["remote", "set-url", "origin", auth_url])
                    .output();
                match Self::fetch(target_dir, branch) {
                    Ok(()) => return Ok(()),
                    Err(e) => last_err = e,
                }
            }
            Err(last_err)
        } else {
            std::fs::create_dir_all(target_dir).ok();
            for auth_url in &candidates {
                let out = Command::new("git")
                    .args(["clone", "--branch", branch, auth_url, target_dir.to_str().unwrap_or(".")])
                    .output()
                    .map_err(|e| format!("Failed to run git clone: {}", e))?;

                if out.status.success() {
                    return Ok(());
                }
                last_err = String::from_utf8_lossy(&out.stderr).to_string();
            }
            Err(last_err)
        }
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
        let candidates = Self::candidate_auth_urls(repo_url);
        let mut last_err = String::from("Failed to query remote repository");

        for auth_url in &candidates {
            let out = Command::new("git")
                .args(["ls-remote", auth_url, &format!("refs/heads/{}", branch)])
                .output()
                .map_err(|e| e.to_string())?;

            if out.status.success() {
                let text = String::from_utf8_lossy(&out.stdout);
                if let Some(first_line) = text.lines().next() {
                    if let Some(sha) = first_line.split_whitespace().next() {
                        return Ok(sha.to_string());
                    }
                }
                return Ok(String::new());
            }
            last_err = String::from_utf8_lossy(&out.stderr).to_string();
        }
        Err(last_err)
    }
}
