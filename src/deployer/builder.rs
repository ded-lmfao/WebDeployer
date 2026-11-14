use std::fs;
use std::path::{Path, PathBuf};
use crate::logs::Logs;

/// Recursively copy `src` into `dst`, overwriting same-named files but never deleting anything in `dst`.
/// The `.git` folder is skipped.
pub fn merge_copy_dir(src: &Path, dst: &Path) -> Result<(), String> {
    fs::create_dir_all(dst).map_err(|e| e.to_string())?;
    for entry in fs::read_dir(src).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name();
        if name == ".git" {
            continue;
        }
        let from = entry.path();
        let to = dst.join(&name);
        let ft = entry.file_type().map_err(|e| e.to_string())?;
        if ft.is_dir() {
            merge_copy_dir(&from, &to)?;
        } else if ft.is_file() {
            fs::copy(&from, &to).map_err(|e| format!("{}: {}", to.display(), e))?;
        }
    }
    Ok(())
}

pub fn switch_current(current_link: &Path, target_dir: &Path) {
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let abs_link = if current_link.is_absolute() {
        current_link.to_path_buf()
    } else {
        let stripped = current_link.to_string_lossy();
        let clean = stripped.strip_prefix("./").or_else(|| stripped.strip_prefix(".\\")).unwrap_or(&stripped);
        cwd.join(clean)
    };
    let abs_target = std::fs::canonicalize(target_dir).unwrap_or_else(|_| {
        if target_dir.is_absolute() {
            target_dir.to_path_buf()
        } else {
            let stripped = target_dir.to_string_lossy();
            let clean = stripped.strip_prefix("./").or_else(|| stripped.strip_prefix(".\\")).unwrap_or(&stripped);
            cwd.join(clean)
        }
    });
    // Strip Windows \\?\ extended-length prefix if canonicalize added it, and ensure clean backslashes for cmd.exe
    #[cfg(windows)]
    let target_str = abs_target.to_string_lossy().replace('/', "\\").trim_start_matches(r"\\?\").to_string();
    #[cfg(windows)]
    let link_str = abs_link.to_string_lossy().replace('/', "\\").trim_start_matches(r"\\?\").to_string();

    if abs_link.exists() || fs::symlink_metadata(&abs_link).is_ok() {
        #[cfg(windows)]
        {
            let _ = std::process::Command::new("cmd")
                .args(["/C", "rmdir", &link_str])
                .output();
        }
        let _ = fs::remove_file(&abs_link);
        let _ = fs::remove_dir_all(&abs_link);
    }
    #[cfg(windows)]
    {
        // Try mklink /J (NTFS junction, does not require admin rights) with absolute paths
        let out = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J", &link_str, &target_str])
            .output();
        if out.map(|o| !o.status.success()).unwrap_or(true) {
            let _ = std::os::windows::fs::symlink_dir(&abs_target, &abs_link);
        }
    }
    #[cfg(unix)]
    {
        let _ = std::os::unix::fs::symlink(&abs_target, &abs_link);
    }
}

pub async fn run_shell_cmd(
    cmd_str: &str,
    cwd: &Path,
    logs: &Logs,
    project_id: i64,
    dep_id: i64,
) -> Result<(), String> {
    #[cfg(windows)]
    let mut cmd = tokio::process::Command::new("cmd");
    #[cfg(windows)]
    {
        cmd.arg("/C");
        cmd.raw_arg(cmd_str);
    }

    #[cfg(unix)]
    let mut resolved_shell_cmd = cmd_str.to_string();
    #[cfg(unix)]
    {
        let has_python = std::path::Path::new("/usr/bin/python").exists()
            || std::path::Path::new("/usr/local/bin/python").exists()
            || cwd.join(".venv/bin/python").exists()
            || cwd.join("venv/bin/python").exists();

        if !has_python && resolved_shell_cmd.contains("python") {
            let parts: Vec<&str> = resolved_shell_cmd.split(' ').collect();
            resolved_shell_cmd = parts
                .into_iter()
                .map(|token| if token == "python" { "python3" } else { token })
                .collect::<Vec<_>>()
                .join(" ");
        }
    }

    #[cfg(unix)]
    let mut cmd = tokio::process::Command::new("sh");
    #[cfg(unix)]
    cmd.args(["-c", &resolved_shell_cmd]);

    crate::config::Config::scrub_control_plane_env(&mut cmd);

    cmd.current_dir(cwd)
        .env("CI", "true")
        .env("npm_config_jobs", "1")
        .env("npm_config_audit", "false")
        .env("npm_config_fund", "false")
        .env("npm_config_progress", "false")
        .env("PIP_BREAK_SYSTEM_PACKAGES", "1");
    if std::env::var("NODE_OPTIONS").is_err() {
        cmd.env("NODE_OPTIONS", "--max-old-space-size=448");
    }
    if let Some((_, ref java_home)) = crate::runtime::detect_java_exe() {
        let bin_dir = java_home.join("bin");
        let cur_path = std::env::var("PATH").unwrap_or_default();
        #[cfg(windows)]
        let new_path = format!("{};{}", bin_dir.display(), cur_path);
        #[cfg(unix)]
        let new_path = format!("{}:{}", bin_dir.display(), cur_path);

        cmd.env("PATH", new_path);
        cmd.env("JAVA_HOME", java_home);
    }

    // Auto-detect virtualenv (.venv or venv) in workspace and route python/pip to it
    let venv_dir = if cwd.join(".venv").is_dir() {
        Some(cwd.join(".venv"))
    } else if cwd.join("venv").is_dir() {
        Some(cwd.join("venv"))
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
    let out = cmd.output().await.map_err(|e| e.to_string())?;

    let stdout_str = String::from_utf8_lossy(&out.stdout);
    for line in stdout_str.lines() {
        let trimmed = line.trim();
        if !trimmed.is_empty() {
            logs.add(Some(project_id), Some(dep_id), "build", "info", trimmed);
        }
    }

    let stderr_str = String::from_utf8_lossy(&out.stderr);
    for line in stderr_str.lines() {
        let trimmed = line.trim();
        if !trimmed.is_empty() {
            let lvl = if out.status.success() { "info" } else { "error" };
            logs.add(Some(project_id), Some(dep_id), "build", lvl, trimmed);
        }
    }

    if out.status.success() {
        Ok(())
    } else {
        Err(stderr_str.to_string())
    }
}

