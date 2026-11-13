use std::process::Command;

fn clean_env_line(s: String) -> String {
    s.replace(['\r', '\n'], " ").trim().to_string()
}

fn non_empty_env(key: &str) -> Option<String> {
    std::env::var(key)
        .ok()
        .map(clean_env_line)
        .filter(|s| !s.is_empty())
}

fn git_output(args: &[&str]) -> Option<String> {
    Command::new("git")
        .args(args)
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| clean_env_line(String::from_utf8_lossy(&o.stdout).into_owned()))
        .filter(|s| !s.is_empty())
}

fn normalize_github_repo_slug(input: &str) -> Option<String> {
    let trimmed = input.trim().trim_end_matches(".git").trim_end_matches('/');
    if let Some(rest) = trimmed.strip_prefix("git@github.com:") {
        return (!rest.is_empty() && rest.contains('/')).then(|| rest.to_string());
    }
    if let Some(idx) = trimmed.find("github.com/") {
        let rest = &trimmed[idx + "github.com/".len()..];
        let mut parts = rest.split('/').filter(|p| !p.is_empty());
        if let (Some(owner), Some(repo)) = (parts.next(), parts.next()) {
            return Some(format!("{}/{}", owner, repo));
        }
    }
    let parts: Vec<&str> = trimmed.split('/').filter(|p| !p.is_empty()).collect();
    if parts.len() == 2 && !trimmed.contains(':') && !trimmed.contains(' ') {
        return Some(format!("{}/{}", parts[0], parts[1]));
    }
    None
}

fn emit_public_watch_paths(dir: &std::path::Path) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.file_name().and_then(|n| n.to_str()) == Some("vendor") {
            continue;
        }
        if path.is_dir() {
            emit_public_watch_paths(&path);
        } else {
            println!("cargo:rerun-if-changed={}", path.display());
        }
    }
}

fn main() {
    println!("cargo:rerun-if-changed=public");
    emit_public_watch_paths(std::path::Path::new("public"));
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-changed=.git/HEAD");
    println!("cargo:rerun-if-changed=.git/refs/heads");
    for key in [
        "WEBDEP_RELEASE_TAG",
        "WEBDEP_COMMIT_SHA",
        "WEBDEP_COMMIT_MSG",
        "WEBDEP_DEFAULT_REPO",
        "GITHUB_SHA",
        "GITHUB_REPOSITORY",
    ] {
        println!("cargo:rerun-if-env-changed={}", key);
    }

    let pkg_version = env!("CARGO_PKG_VERSION");

    let commit_sha = non_empty_env("WEBDEP_COMMIT_SHA")
        .or_else(|| {
            non_empty_env("GITHUB_SHA").map(|s| s.chars().take(7).collect::<String>())
        })
        .or_else(|| git_output(&["rev-parse", "--short", "HEAD"]))
        .unwrap_or_else(|| "unknown".to_string());

    let commit_msg = non_empty_env("WEBDEP_COMMIT_MSG")
        .or_else(|| git_output(&["log", "-1", "--pretty=format:%s"]))
        .unwrap_or_else(|| "Self-hosted WebDep deployment platform".to_string());

    let release_tag = non_empty_env("WEBDEP_RELEASE_TAG").unwrap_or_else(|| {
        if commit_sha != "unknown" {
            format!("v{}-{}", pkg_version, commit_sha)
        } else {
            format!("v{}", pkg_version)
        }
    });

    let default_repo = non_empty_env("WEBDEP_DEFAULT_REPO")
        .or_else(|| {
            non_empty_env("GITHUB_REPOSITORY").and_then(|r| normalize_github_repo_slug(&r))
        })
        .or_else(|| {
            git_output(&["remote", "get-url", "origin"])
                .and_then(|u| normalize_github_repo_slug(&u))
        })
        .unwrap_or_else(|| "ded-lmfao/WebDeployer".to_string());

    println!("cargo:rustc-env=WEBDEP_VERSION={}", pkg_version);
    println!("cargo:rustc-env=WEBDEP_COMMIT_SHA={}", commit_sha);
    println!("cargo:rustc-env=WEBDEP_COMMIT_MSG={}", commit_msg);
    println!("cargo:rustc-env=WEBDEP_RELEASE_TAG={}", release_tag);
    println!("cargo:rustc-env=WEBDEP_DEFAULT_REPO={}", default_repo);
}
