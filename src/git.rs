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
    fn resolve_sqlite_path() -> std::path::PathBuf {
        if let Some(active) = crate::db::active_db_path() {
            if active.exists() {
                return active;
            }
        }
        if let Ok(p) = std::env::var("WEBDEP_DB").or_else(|_| std::env::var("NEXUS_DB")) {
            let pb = std::path::PathBuf::from(p);
            if pb.exists() {
                return pb;
            }
        }
        if let Ok(data_dir) = std::env::var("DATA_DIR") {
            let pb = std::path::PathBuf::from(data_dir).join("webdep.sqlite");
            if pb.exists() {
                return pb;
            }
        }
        let default_pb = std::path::PathBuf::from("./data/webdep.sqlite");
        if default_pb.exists() {
            return default_pb;
        }
        if let Ok(exe) = std::env::current_exe() {
            if let Some(exe_dir) = exe.parent() {
                for rel in ["data/webdep.sqlite", "../data/webdep.sqlite", "../../data/webdep.sqlite"] {
                    let cand = exe_dir.join(rel);
                    if cand.exists() {
                        return cand;
                    }
                }
            }
        }
        default_pb
    }

    pub fn get_sqlite_github_tokens() -> Vec<StoredGithubToken> {
        let mut list: Vec<StoredGithubToken> = Vec::new();
        let mut seen = std::collections::HashSet::new();

        let db_path = Self::resolve_sqlite_path();
        if let Ok(conn) = rusqlite::Connection::open(db_path) {
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
                } else if let Ok(parsed_strs) = serde_json::from_str::<Vec<String>>(&raw_json) {
                    for raw_t in parsed_strs {
                        let t = raw_t.trim().to_string();
                        if !t.is_empty() && seen.insert(t.clone()) {
                            list.push(StoredGithubToken {
                                label: format!("Token #{}", list.len() + 1),
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
        }

        // 3. Also include GITHUB_TOKEN env var if set
        if let Ok(env_tok) = std::env::var("GITHUB_TOKEN") {
            for part in env_tok.split(|c| c == ',' || c == '\n' || c == ';') {
                let t = part.trim().to_string();
                if !t.is_empty() && seen.insert(t.clone()) {
                    list.push(StoredGithubToken {
                        label: format!("Env Token #{}", list.len() + 1),
                        token: t,
                    });
                }
            }
        }

        list
    }

    pub fn extract_github_slug(repo_url: &str) -> Option<String> {
        let s = repo_url.trim().trim_end_matches('/');
        if s.is_empty() {
            return None;
        }
        let rest = if let Some(idx) = s.find("github.com/") {
            &s[idx + "github.com/".len()..]
        } else if let Some(idx) = s.find("github.com:") {
            &s[idx + "github.com:".len()..]
        } else if !s.contains("://")
            && !s.contains('@')
            && !s.contains('\\')
            && !s.starts_with('.')
            && !s.starts_with('/')
            && s.matches('/').count() == 1
            && !Path::new(s).exists()
        {
            s
        } else {
            return None;
        };
        let clean = rest
            .trim_start_matches('/')
            .trim_end_matches('/')
            .trim_end_matches(".git");
        let parts: Vec<&str> = clean.split('/').filter(|p| !p.is_empty()).collect();
        if parts.len() >= 2 {
            Some(format!("{}/{}", parts[0], parts[1]))
        } else {
            None
        }
    }

    fn sanitize_err(err: &str, tokens: &[StoredGithubToken]) -> String {
        let mut out = err.to_string();
        for t in tokens {
            if !t.token.is_empty() {
                out = out.replace(&t.token, "***");
            }
        }
        out
    }

    fn candidate_auth_urls(repo_url: &str) -> Vec<String> {
        let tokens = Self::get_sqlite_github_tokens();
        if let Some(slug) = Self::extract_github_slug(repo_url) {
            let mut urls: Vec<String> = Vec::new();
            for t in &tokens {
                let tok = t.token.trim();
                if !tok.is_empty() {
                    urls.push(format!("https://x-access-token:{}@github.com/{}.git", tok, slug));
                    urls.push(format!("https://{}@github.com/{}.git", tok, slug));
                }
            }
            // Always keep unauthenticated HTTPS URL as final fallback for public repos
            urls.push(format!("https://github.com/{}.git", slug));
            urls
        } else {
            vec![repo_url.trim().to_string()]
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

    fn validate_git_ref(branch: &str) -> Result<String, String> {
        let b = branch.trim();
        if b.is_empty() {
            return Ok(String::new());
        }
        if b.starts_with('-')
            || b.contains("..")
            || b.chars().any(|c| c.is_whitespace() || c.is_control() || matches!(c, '~' | '^' | ':' | '\\' | '\0'))
        {
            return Err(format!("Invalid git branch/ref: '{}'", b));
        }
        Ok(b.to_string())
    }

    fn validate_git_url(repo_url: &str) -> Result<(), String> {
        let u = repo_url.trim();
        if u.is_empty()
            || u.starts_with('-')
            || u.starts_with("ext::")
            || u.chars().any(|c| c.is_control() || c == '\0')
        {
            return Err("Invalid repository URL".to_string());
        }
        Ok(())
    }

    pub fn fetch(repo_dir: &Path, branch: &str) -> Result<(), String> {
        let clean_branch = Self::validate_git_ref(branch)?;
        let target_branch = if clean_branch.is_empty() { "main" } else { &clean_branch };
        let refspec = format!(
            "+refs/heads/{}:refs/remotes/origin/{}",
            target_branch, target_branch
        );

        let out = Command::new("git")
            .current_dir(repo_dir)
            .env("GIT_TERMINAL_PROMPT", "0")
            .args([
                "-c",
                "credential.helper=",
                "fetch",
                "--prune",
                "--force",
                "origin",
                &refspec,
            ])
            .output()
            .map_err(|e| format!("Failed to run git fetch: {}", e))?;

        if !out.status.success() {
            // Fallback: fetch all remote branches (handles repos whose default branch differs or when branch is a tag/SHA)
            let fallback = Command::new("git")
                .current_dir(repo_dir)
                .env("GIT_TERMINAL_PROMPT", "0")
                .args(["-c", "credential.helper=", "fetch", "--prune", "--force", "origin"])
                .output()
                .map_err(|e| format!("Failed to run git fetch: {}", e))?;

            if !fallback.status.success() {
                let tokens = Self::get_sqlite_github_tokens();
                return Err(Self::sanitize_err(
                    &String::from_utf8_lossy(&out.stderr),
                    &tokens,
                ));
            }
        }

        // Advance repo_dir HEAD and working tree to the newly fetched remote tip so resolve_head & list_commits always see the latest pull
        let remote_ref = format!("origin/{}", target_branch);
        let reset = Command::new("git")
            .current_dir(repo_dir)
            .args(["reset", "--hard", &remote_ref])
            .output();
        if reset.map(|o| !o.status.success()).unwrap_or(true) {
            let _ = Command::new("git")
                .current_dir(repo_dir)
                .args(["reset", "--hard", "FETCH_HEAD"])
                .output();
        }

        Ok(())
    }

    pub fn clone_or_fetch(repo_url: &str, target_dir: &Path, branch: &str) -> Result<(), String> {
        Self::validate_git_url(repo_url)?;
        let clean_branch = Self::validate_git_ref(branch)?;
        let tokens = Self::get_sqlite_github_tokens();
        let candidates = Self::candidate_auth_urls(repo_url);
        let mut last_err = String::from("Git operation failed");

        if target_dir.join(".git").exists() {
            for auth_url in &candidates {
                let _ = Command::new("git")
                    .current_dir(target_dir)
                    .args(["remote", "set-url", "origin", auth_url])
                    .output();
                match Self::fetch(target_dir, &clean_branch) {
                    Ok(()) => return Ok(()),
                    Err(e) => last_err = Self::sanitize_err(&e, &tokens),
                }
            }
            return Err(last_err);
        }

        // Clean any partial non-git directory before cloning
        if target_dir.exists() {
            let _ = std::fs::remove_dir_all(target_dir);
        }
        if let Some(parent) = target_dir.parent() {
            let _ = std::fs::create_dir_all(parent);
        }

        for auth_url in &candidates {
            let _ = std::fs::remove_dir_all(target_dir);
            let out = if !clean_branch.is_empty() {
                Command::new("git")
                    .env("GIT_TERMINAL_PROMPT", "0")
                    .args([
                        "-c",
                        "credential.helper=",
                        "clone",
                        "--branch",
                        &clean_branch,
                        "--",
                        auth_url,
                        target_dir.to_str().unwrap_or("."),
                    ])
                    .output()
                    .map_err(|e| format!("Failed to run git clone: {}", e))?
            } else {
                Command::new("git")
                    .env("GIT_TERMINAL_PROMPT", "0")
                    .args([
                        "-c",
                        "credential.helper=",
                        "clone",
                        "--",
                        auth_url,
                        target_dir.to_str().unwrap_or("."),
                    ])
                    .output()
                    .map_err(|e| format!("Failed to run git clone: {}", e))?
            };

            if out.status.success() {
                return Ok(());
            }

            // If --branch failed because the repo default branch is different, try cloning default branch with this token
            let err_str = String::from_utf8_lossy(&out.stderr).to_string();
            if err_str.contains("Remote branch") && err_str.contains("not found") {
                let _ = std::fs::remove_dir_all(target_dir);
                if let Ok(out2) = Command::new("git")
                    .env("GIT_TERMINAL_PROMPT", "0")
                    .args([
                        "-c",
                        "credential.helper=",
                        "clone",
                        "--",
                        auth_url,
                        target_dir.to_str().unwrap_or("."),
                    ])
                    .output()
                {
                    if out2.status.success() {
                        return Ok(());
                    }
                }
            }

            last_err = Self::sanitize_err(&err_str, &tokens);
        }
        Err(last_err)
    }

    pub fn checkout(repo_dir: &Path, sha: &str, destination_dir: &Path) -> Result<(), String> {
        let clean_sha = Self::validate_git_ref(sha)?;
        if clean_sha.is_empty() {
            return Err("Missing commit SHA".to_string());
        }
        std::fs::create_dir_all(destination_dir).map_err(|e| e.to_string())?;

        let out = Command::new("git")
            .current_dir(repo_dir)
            .args(["checkout", "--force", &clean_sha, "--"])
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
        let target = if branch.trim().is_empty() {
            "HEAD".to_string()
        } else {
            format!("origin/{}", branch.trim())
        };
        let mut out = Command::new("git")
            .current_dir(repo_dir)
            .args([
                "log",
                &format!("-{}", limit),
                "--format=%H\x1f%h\x1f%an\x1f%at\x1f%s",
                &target,
            ])
            .output();

        if out.as_ref().map(|o| !o.status.success() || o.stdout.is_empty()).unwrap_or(true) {
            out = Command::new("git")
                .current_dir(repo_dir)
                .args([
                    "log",
                    &format!("-{}", limit),
                    "--format=%H\x1f%h\x1f%an\x1f%at\x1f%s",
                ])
                .output();
        }

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
        Self::validate_git_url(repo_url)?;
        let clean_branch = Self::validate_git_ref(branch)?;
        let tokens = Self::get_sqlite_github_tokens();
        let candidates = Self::candidate_auth_urls(repo_url);
        let mut last_err = String::from("Failed to query remote repository");
        let ref_arg = if clean_branch.is_empty() {
            "HEAD".to_string()
        } else {
            format!("refs/heads/{}", clean_branch)
        };

        for auth_url in &candidates {
            let out = Command::new("git")
                .env("GIT_TERMINAL_PROMPT", "0")
                .args(["-c", "credential.helper=", "ls-remote", "--", auth_url, &ref_arg])
                .output()
                .map_err(|e| e.to_string())?;

            if out.status.success() {
                let text = String::from_utf8_lossy(&out.stdout);
                if let Some(first_line) = text.lines().next() {
                    if let Some(sha) = first_line.split_whitespace().next() {
                        return Ok(sha.to_string());
                    }
                }
                // If refs/heads/<branch> returned empty, query HEAD on this same authenticated URL
                if let Ok(head_out) = Command::new("git")
                    .env("GIT_TERMINAL_PROMPT", "0")
                    .args(["-c", "credential.helper=", "ls-remote", auth_url, "HEAD"])
                    .output()
                {
                    if head_out.status.success() {
                        let htext = String::from_utf8_lossy(&head_out.stdout);
                        if let Some(first_line) = htext.lines().next() {
                            if let Some(sha) = first_line.split_whitespace().next() {
                                return Ok(sha.to_string());
                            }
                        }
                    }
                }
                return Ok(String::new());
            }
            last_err = Self::sanitize_err(&String::from_utf8_lossy(&out.stderr), &tokens);
        }
        Err(last_err)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_extract_github_slug_and_pull_advances_head() {
        assert_eq!(
            Git::extract_github_slug("https://github.com/acme/webapp.git"),
            Some("acme/webapp".to_string())
        );
        assert_eq!(
            Git::extract_github_slug("https://x-access-token:ghp_abc123@github.com/acme/webapp"),
            Some("acme/webapp".to_string())
        );
        assert_eq!(
            Git::extract_github_slug("git@github.com:acme/webapp.git"),
            Some("acme/webapp".to_string())
        );
        assert_eq!(
            Git::extract_github_slug("acme/webapp"),
            Some("acme/webapp".to_string())
        );

        let tmp = std::path::PathBuf::from(format!("./target/test-git-mirror-{}", crate::db::now()));
        let mirror_dir = tmp.join("mirror_repo");
        let rel1_dir = tmp.join("rel1");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&mirror_dir).unwrap();

        let run_git = |dir: &Path, args: &[&str]| {
            let status = Command::new("git").current_dir(dir).args(args).status().unwrap();
            assert!(status.success(), "git {:?} failed", args);
        };

        run_git(&mirror_dir, &["init", "-b", "main"]);
        run_git(&mirror_dir, &["config", "user.email", "test@example.com"]);
        run_git(&mirror_dir, &["config", "user.name", "Tester"]);
        std::fs::write(mirror_dir.join("index.js"), "console.log('v1');").unwrap();
        run_git(&mirror_dir, &["add", "."]);
        run_git(&mirror_dir, &["commit", "-m", "Initial commit v1"]);
        let sha1 = Git::resolve_head(&mirror_dir).unwrap();
        run_git(&mirror_dir, &["update-ref", "refs/remotes/origin/main", &sha1]);

        // Create a second commit on origin/main while detaching HEAD at sha1 (simulating post-deploy state)
        std::fs::write(mirror_dir.join("index.js"), "console.log('v2');").unwrap();
        run_git(&mirror_dir, &["add", "."]);
        run_git(&mirror_dir, &["commit", "-m", "Second commit v2"]);
        let sha2 = Git::resolve_head(&mirror_dir).unwrap();
        run_git(&mirror_dir, &["update-ref", "refs/remotes/origin/main", &sha2]);

        // Simulate deployment checkout of sha1 (which detaches HEAD at sha1)
        Git::checkout(&mirror_dir, &sha1, &rel1_dir).unwrap();
        assert_eq!(Git::resolve_head(&mirror_dir).unwrap(), sha1);

        // Verify list_commits reads from origin/main (sha2) even when HEAD is detached at sha1,
        // and resetting to origin/main advances resolve_head to sha2
        let commits = Git::list_commits(&mirror_dir, "main", 10);
        assert_eq!(commits.len(), 2);
        assert_eq!(commits[0].sha, sha2);

        run_git(&mirror_dir, &["reset", "--hard", "origin/main"]);
        assert_eq!(Git::resolve_head(&mirror_dir).unwrap(), sha2);

        let _ = std::fs::remove_dir_all(&tmp);
    }
}
