use std::path::{Path, PathBuf};
use tokio::process::Command;

#[derive(Debug, Clone)]
pub struct PgBinaries {
    pub initdb: PathBuf,
    pub pg_ctl: PathBuf,
    pub psql: PathBuf,
}

impl PgBinaries {
    pub fn detect() -> Result<Self, String> {
        // 1. Check explicit environment override
        if let Ok(dir_str) = std::env::var("PG_BIN_DIR") {
            let dir = PathBuf::from(dir_str);
            if let Some(bins) = Self::from_dir(&dir) {
                return Ok(bins);
            }
        }

        // 2. Windows standard paths
        #[cfg(windows)]
        {
            let base_dirs = [
                PathBuf::from(r"C:\Program Files\PostgreSQL"),
                PathBuf::from(r"C:\Program Files (x86)\PostgreSQL"),
            ];

            for base in &base_dirs {
                if let Ok(entries) = std::fs::read_dir(base) {
                    let mut versions: Vec<PathBuf> = entries
                        .flatten()
                        .map(|e| e.path())
                        .filter(|p| p.is_dir())
                        .collect();
                    versions.sort_by(|a, b| b.cmp(a));

                    for ver_dir in versions {
                        let bin_dir = ver_dir.join("bin");
                        if let Some(bins) = Self::from_dir(&bin_dir) {
                            return Ok(bins);
                        }
                    }
                }
            }
        }

        // 3. Linux / Unix standard paths
        #[cfg(unix)]
        {
            let unix_dirs = [
                "/usr/lib/postgresql/17/bin",
                "/usr/lib/postgresql/16/bin",
                "/usr/lib/postgresql/15/bin",
                "/usr/lib/postgresql/14/bin",
                "/usr/lib/postgresql/13/bin",
                "/usr/lib/postgresql/12/bin",
                "/usr/pgsql-16/bin",
                "/usr/pgsql-15/bin",
                "/usr/pgsql-14/bin",
                "/opt/homebrew/opt/postgresql@16/bin",
                "/opt/homebrew/opt/postgresql@15/bin",
                "/opt/homebrew/bin",
                "/usr/local/pgsql/bin",
                "/usr/local/bin",
                "/usr/bin",
            ];

            for d in &unix_dirs {
                let path = PathBuf::from(d);
                if let Some(bins) = Self::from_dir(&path) {
                    return Ok(bins);
                }
            }
        }

        // 4. Try PATH lookup
        if let Ok(path_var) = std::env::var("PATH") {
            let separator = if cfg!(windows) { ';' } else { ':' };
            for part in path_var.split(separator) {
                let dir = PathBuf::from(part.trim());
                if let Some(bins) = Self::from_dir(&dir) {
                    return Ok(bins);
                }
            }
        }

        Err("PostgreSQL binaries (pg_ctl, initdb) were not found on this system. Please install PostgreSQL (e.g. 'sudo apt install -y postgresql postgresql-contrib' on Ubuntu/Debian) or set the PG_BIN_DIR environment variable.".to_string())
    }

    pub fn from_dir(dir: &Path) -> Option<Self> {
        let ext = if cfg!(windows) { ".exe" } else { "" };
        let pg_ctl = dir.join(format!("pg_ctl{}", ext));
        let initdb = dir.join(format!("initdb{}", ext));
        let psql = dir.join(format!("psql{}", ext));

        if pg_ctl.is_file() && initdb.is_file() {
            Some(Self {
                initdb,
                pg_ctl,
                psql,
            })
        } else {
            None
        }
    }
}

#[cfg(unix)]
pub fn is_running_as_root() -> bool {
    #[cfg(unix)]
    {
        std::process::Command::new("id")
            .arg("-u")
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).trim() == "0")
            .unwrap_or(false)
    }
    #[cfg(not(unix))]
    {
        false
    }
}

pub fn make_pg_server_command(prog: &Path, args: &[&str]) -> Command {
    #[cfg(unix)]
    {
        if is_running_as_root() {
            let has_pg_user = std::process::Command::new("id")
                .arg("postgres")
                .output()
                .map(|o| o.status.success())
                .unwrap_or(false);

            if has_pg_user {
                let runuser_bin = if Path::new("/sbin/runuser").exists() {
                    "/sbin/runuser"
                } else if Path::new("/usr/sbin/runuser").exists() {
                    "/usr/sbin/runuser"
                } else {
                    "runuser"
                };

                let mut cmd = Command::new(runuser_bin);
                cmd.arg("-u").arg("postgres").arg("--").arg(prog);
                for a in args {
                    cmd.arg(a);
                }
                return cmd;
            }
        }
    }
    let mut cmd = Command::new(prog);
    for a in args {
        cmd.arg(a);
    }
    cmd
}

pub fn ensure_pg_permissions(_db_dir: &Path, _data_dir: Option<&Path>) {
    #[cfg(unix)]
    {
        if is_running_as_root() {
            ensure_parent_traverse_permissions(_db_dir);
            let _ = std::process::Command::new("chown")
                .args(["-R", "postgres:postgres", &_db_dir.to_string_lossy()])
                .status();
            if let Some(d) = _data_dir {
                let _ = std::process::Command::new("chmod")
                    .args(["0700", &d.to_string_lossy()])
                    .status();
            }
        }
    }
}

#[cfg(unix)]
pub fn ensure_parent_traverse_permissions(_path: &Path) {
    #[cfg(unix)]
    {
        if is_running_as_root() {
            let mut curr = _path.parent();
            while let Some(dir) = curr {
                if dir == Path::new("/") || dir.as_os_str().is_empty() {
                    break;
                }
                if let Ok(meta) = std::fs::metadata(dir) {
                    use std::os::unix::fs::PermissionsExt;
                    let mode = meta.permissions().mode();
                    if mode & 0o001 == 0 {
                        let new_mode = mode | 0o001;
                        let _ = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(new_mode));
                    }
                }
                curr = dir.parent();
            }
        }
    }
}
