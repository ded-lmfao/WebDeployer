pub mod binaries;
pub mod security;

pub use binaries::*;
pub use security::*;

use rusqlite::params;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::process::Command;
use tracing::{info, warn};

use crate::db::{now, DbPool};
use crate::logs::Logs;
use crate::vault::Vault;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedDatabase {
    pub id: i64,
    pub name: String,
    pub engine: String,
    pub db_name: String,
    pub db_user: String,
    pub db_password: Option<String>,
    pub port: u16,
    pub is_superuser: bool,
    pub access_mode: String,
    pub allowed_ips: String,
    pub domain: String,
    pub status: String,
    pub container_id: Option<String>,
    pub data_dir: String,
    pub linked_project_id: Option<i64>,
    pub linked_project_name: Option<String>,
    pub internal_url: String,
    pub external_url: String,
    pub psql_command: String,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Deserialize)]
pub struct CreateDatabaseInput {
    pub name: String,
    #[serde(default)]
    pub engine: Option<String>,
    #[serde(alias = "dbName", alias = "db_name")]
    pub db_name: String,
    #[serde(alias = "dbUser", alias = "db_user")]
    pub db_user: String,
    #[serde(alias = "dbPassword", alias = "db_password")]
    pub db_password: String,
    #[serde(default)]
    pub port: Option<u16>,
    #[serde(default, alias = "isSuperuser", alias = "is_superuser")]
    pub is_superuser: Option<bool>,
    #[serde(default, alias = "accessMode", alias = "access_mode")]
    pub access_mode: Option<String>,
    #[serde(default, alias = "allowedIps", alias = "allowed_ips")]
    pub allowed_ips: Option<String>,
    #[serde(default)]
    pub domain: Option<String>,
    #[serde(default, alias = "linkedProjectId", alias = "linked_project_id")]
    pub linked_project_id: Option<i64>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateDatabaseAccessInput {
    #[serde(alias = "accessMode", alias = "access_mode")]
    pub access_mode: String,
    #[serde(default, alias = "allowedIps", alias = "allowed_ips")]
    pub allowed_ips: Option<String>,
    #[serde(default)]
    pub domain: Option<String>,
}

pub struct Databases {
    db: DbPool,
    vault: Arc<Vault>,
    logs: Logs,
    base_dir: PathBuf,
    public_ip: String,
}

impl Databases {
    pub fn new(db: DbPool, vault: Arc<Vault>, logs: Logs, data_dir: &Path) -> Self {
        let abs_dir = std::fs::canonicalize(data_dir.join("databases"))
            .unwrap_or_else(|_| data_dir.join("databases"));
        let _ = std::fs::create_dir_all(&abs_dir);

        let public_ip = std::env::var("PUBLIC_IP")
            .ok()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| "127.0.0.1".to_string());

        Self {
            db,
            vault,
            logs,
            base_dir: abs_dir,
            public_ip,
        }
    }

    pub fn set_public_ip(&mut self, ip: String) {
        if !ip.trim().is_empty() {
            self.public_ip = ip;
        }
    }

    pub fn list(&self) -> Result<Vec<ManagedDatabase>, String> {
        let conn = self.db.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT d.id, d.name, d.engine, d.db_name, d.db_user, d.db_password, d.port,
                        d.is_superuser, d.access_mode, d.allowed_ips, d.status, d.container_id,
                        d.data_dir, d.linked_project_id, p.name, d.domain, d.created_at, d.updated_at
                 FROM databases d
                 LEFT JOIN projects p ON p.id = d.linked_project_id
                 ORDER BY d.id DESC",
            )
            .map_err(|e| e.to_string())?;

        let rows = stmt
            .query_map([], |r| {
                let id: i64 = r.get(0)?;
                let name: String = r.get(1)?;
                let engine: String = r.get(2)?;
                let db_name: String = r.get(3)?;
                let db_user: String = r.get(4)?;
                let enc_pass: String = r.get(5)?;
                let port: u16 = r.get(6)?;
                let is_superuser: bool = r.get::<_, i64>(7)? != 0;
                let access_mode: String = r.get(8)?;
                let allowed_ips: String = r.get(9)?;
                let status: String = r.get(10)?;
                let container_id: Option<String> = r.get(11)?;
                let data_dir: String = r.get(12)?;
                let linked_project_id: Option<i64> = r.get(13)?;
                let linked_project_name: Option<String> = r.get(14)?;
                let domain: String = r.get::<_, Option<String>>(15)?.unwrap_or_default();
                let created_at: i64 = r.get(16)?;
                let updated_at: i64 = r.get(17)?;

                let raw_pass = self.vault.decrypt(&enc_pass).unwrap_or(enc_pass);
                let internal_url = format!("postgresql://{}:{}@127.0.0.1:{}/{}", db_user, raw_pass, port, db_name);
                let host = if !domain.trim().is_empty() {
                    domain.trim()
                } else {
                    &self.public_ip
                };
                let external_url = format!("postgresql://{}:{}@{}:{}/{}?sslmode=prefer", db_user, raw_pass, host, port, db_name);
                let psql_command = format!("psql -h {} -p {} -U {} -d {}", host, port, db_user, db_name);

                Ok(ManagedDatabase {
                    id,
                    name,
                    engine,
                    db_name,
                    db_user,
                    db_password: Some(raw_pass),
                    port,
                    is_superuser,
                    access_mode,
                    allowed_ips,
                    domain,
                    status,
                    container_id,
                    data_dir,
                    linked_project_id,
                    linked_project_name,
                    internal_url,
                    external_url,
                    psql_command,
                    created_at,
                    updated_at,
                })
            })
            .map_err(|e| e.to_string())?;

        Ok(rows.flatten().collect())
    }

    pub fn get(&self, id: i64) -> Result<Option<ManagedDatabase>, String> {
        let all = self.list()?;
        Ok(all.into_iter().find(|d| d.id == id))
    }

    pub fn get_logs(&self, id: i64) -> Result<String, String> {
        let db_rec = self.get(id)?.ok_or_else(|| "Database not found".to_string())?;
        let db_dir = PathBuf::from(&db_rec.data_dir);
        let log_file = db_dir.join("postgresql.log");
        if log_file.is_file() {
            match std::fs::read_to_string(&log_file) {
                Ok(content) => {
                    let lines: Vec<&str> = content.lines().collect();
                    if lines.len() > 300 {
                        Ok(lines[lines.len() - 300..].join("\n"))
                    } else {
                        Ok(content)
                    }
                }
                Err(e) => Ok(format!("Failed to read log file: {}", e)),
            }
        } else {
            Ok(format!("No log file exists yet for database #{} ({})", id, db_rec.name))
        }
    }

    pub async fn create(&self, input: CreateDatabaseInput) -> Result<ManagedDatabase, String> {
        let name = input.name.trim();
        if name.is_empty() {
            return Err("Database display name is required".to_string());
        }
        let db_name = input.db_name.trim();
        if db_name.is_empty() {
            return Err("Database name is required".to_string());
        }
        let db_user = input.db_user.trim();
        if db_user.is_empty() {
            return Err("Database username is required".to_string());
        }
        let db_password = input.db_password.trim();
        if db_password.is_empty() {
            return Err("Database password is required".to_string());
        }

        let engine = input.engine.unwrap_or_else(|| "postgres".to_string());
        let access_mode = input.access_mode.unwrap_or_else(|| "local".to_string());
        let allowed_ips = input.allowed_ips.unwrap_or_default().trim().to_string();
        let domain = input.domain.unwrap_or_default().trim().to_string();
        let is_superuser = input.is_superuser.unwrap_or(false);

        let port = {
            let conn = self.db.lock().map_err(|e| e.to_string())?;
            crate::db::allocate_global_unique_port(&conn, input.port, 5432, None, None)?
        };

        let enc_password = self
            .vault
            .encrypt(db_password)
            .map_err(|e| format!("Vault encryption error: {}", e))?;

        let ts = now();
        let id = {
            let conn = self.db.lock().map_err(|e| e.to_string())?;
            conn.execute(
                "INSERT INTO databases(name, engine, db_name, db_user, db_password, port, is_superuser, access_mode, allowed_ips, domain, status, data_dir, linked_project_id, created_at, updated_at)
                 VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'stopped', '', ?, ?, ?)",
                params![
                    name,
                    engine,
                    db_name,
                    db_user,
                    enc_password,
                    port,
                    if is_superuser { 1 } else { 0 },
                    access_mode,
                    allowed_ips,
                    domain,
                    input.linked_project_id,
                    ts,
                    ts,
                ],
            )
            .map_err(|e| e.to_string())?;
            conn.last_insert_rowid()
        };

        let db_dir = self.base_dir.join(format!("db-{}", id));
        let data_dir_str = db_dir.to_string_lossy().to_string();
        let _ = tokio::fs::create_dir_all(&db_dir).await;

        {
            let conn = self.db.lock().map_err(|e| e.to_string())?;
            let _ = conn.execute(
                "UPDATE databases SET data_dir = ? WHERE id = ?",
                params![data_dir_str, id],
            );
        }

        // Apply network firewall rules (UFW/iptables)
        Self::sync_firewall_rules(port, &access_mode, &allowed_ips).await;

        // Initialize and start process container
        match self
            .init_and_start(
                id,
                port,
                db_name,
                db_user,
                db_password,
                is_superuser,
                &access_mode,
                &allowed_ips,
                &db_dir,
            )
            .await
        {
            Ok(cid) => {
                let conn = self.db.lock().map_err(|e| e.to_string())?;
                let _ = conn.execute(
                    "UPDATE databases SET status = 'running', container_id = ?, updated_at = ? WHERE id = ?",
                    params![cid, now(), id],
                );
            }
            Err(err) => {
                warn!("Database process container start failed: {}", err);
                let conn = self.db.lock().map_err(|e| e.to_string())?;
                let _ = conn.execute(
                    "UPDATE databases SET status = 'error', updated_at = ? WHERE id = ?",
                    params![now(), id],
                );
                return Err(err);
            }
        }

        self.get(id)?.ok_or_else(|| "Failed to retrieve created database".to_string())
    }

    pub async fn start(&self, id: i64) -> Result<(), String> {
        let db_rec = self.get(id)?.ok_or_else(|| "Database not found".to_string())?;
        let password = db_rec.db_password.unwrap_or_default();
        let db_dir = PathBuf::from(&db_rec.data_dir);

        Self::sync_firewall_rules(db_rec.port, &db_rec.access_mode, &db_rec.allowed_ips).await;

        // Quick check: if postgres is already running and accepting TCP connections, update status immediately!
        let own_pid = read_pg_pid(&db_dir.join("data")).filter(|p| is_process_alive(*p));
        if own_pid.is_some() && tokio::net::TcpStream::connect(format!("127.0.0.1:{}", db_rec.port)).await.is_ok() {
            let pid = own_pid.unwrap_or_else(std::process::id);
            let conn = self.db.lock().map_err(|e| e.to_string())?;
            conn.execute(
                "UPDATE databases SET status = 'running', container_id = ?, updated_at = ? WHERE id = ?",
                params![format!("pid-{}", pid), now(), id],
            )
            .map_err(|e| e.to_string())?;
            return Ok(());
        }

        let cid = self
            .init_and_start(
                id,
                db_rec.port,
                &db_rec.db_name,
                &db_rec.db_user,
                &password,
                db_rec.is_superuser,
                &db_rec.access_mode,
                &db_rec.allowed_ips,
                &db_dir,
            )
            .await?;

        let conn = self.db.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE databases SET status = 'running', container_id = ?, updated_at = ? WHERE id = ?",
            params![cid, now(), id],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub async fn stop(&self, id: i64) -> Result<(), String> {
        let db_rec = self.get(id)?.ok_or_else(|| "Database not found".to_string())?;
        let db_dir = PathBuf::from(&db_rec.data_dir);
        let data_dir = db_dir.join("data");

        if let Ok(pg_bins) = PgBinaries::detect() {
            let data_str = to_clean_path_str(&data_dir);
            let mut stop_cmd = make_pg_server_command(&pg_bins.pg_ctl, &["-D", &data_str, "-m", "fast", "stop"]);
            stop_cmd.stdin(std::process::Stdio::null());
            stop_cmd.stdout(std::process::Stdio::null());
            stop_cmd.stderr(std::process::Stdio::null());
            let _ = tokio::time::timeout(tokio::time::Duration::from_secs(3), stop_cmd.status()).await;
        }

        let mut pids_to_kill = Vec::new();
        if let Some(pid) = read_pg_pid(&data_dir) {
            pids_to_kill.push(pid);
        }
        for port_pid in crate::runtime::Runtime::find_pids_on_port(db_rec.port) {
            pids_to_kill.push(port_pid);
        }

        for pid in pids_to_kill {
            crate::runtime::Runtime::kill_pid_tree(pid).await;
        }

        let pid_file = data_dir.join("postmaster.pid");
        if pid_file.exists() {
            let _ = tokio::fs::remove_file(&pid_file).await;
        }

        let conn = self.db.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE databases SET status = 'stopped', updated_at = ? WHERE id = ?",
            params![now(), id],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub async fn restart(&self, id: i64) -> Result<(), String> {
        self.stop(id).await?;
        tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;
        self.start(id).await
    }

    pub async fn update_access(&self, id: i64, input: UpdateDatabaseAccessInput) -> Result<(), String> {
        let db_rec = self.get(id)?.ok_or_else(|| "Database not found".to_string())?;
        let allowed_ips = input.allowed_ips.unwrap_or_default().trim().to_string();

        Self::remove_firewall_rules(db_rec.port, &db_rec.allowed_ips).await;
        Self::sync_firewall_rules(db_rec.port, &input.access_mode, &allowed_ips).await;

        let db_dir = PathBuf::from(&db_rec.data_dir);
        let data_dir = db_dir.join("data");
        let hba_content = generate_pg_hba(&input.access_mode, &allowed_ips);
        let hba_path = data_dir.join("pg_hba.conf");
        let _ = tokio::fs::write(&hba_path, hba_content).await;

        // Hot reload pg_hba.conf without dropping client connections
        if let Ok(pg_bins) = PgBinaries::detect() {
            let data_str = to_clean_path_str(&data_dir);
            let _ = make_pg_server_command(&pg_bins.pg_ctl, &["-D", &data_str, "reload"])
                .output()
                .await;
        }

        let domain = input.domain.unwrap_or_else(|| db_rec.domain.clone()).trim().to_string();
        {
            let conn = self.db.lock().map_err(|e| e.to_string())?;
            conn.execute(
                "UPDATE databases SET access_mode = ?, allowed_ips = ?, domain = ?, updated_at = ? WHERE id = ?",
                params![input.access_mode, allowed_ips, domain, now(), id],
            )
            .map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    pub async fn delete(&self, id: i64) -> Result<(), String> {
        let db_rec = self.get(id)?.ok_or_else(|| "Database not found".to_string())?;

        // 1. Stop PostgreSQL instance
        let _ = self.stop(id).await;

        // 2. Remove firewall rules
        Self::remove_firewall_rules(db_rec.port, &db_rec.allowed_ips).await;

        // 3. Remove physical data directory
        let db_dir = PathBuf::from(&db_rec.data_dir);
        if db_dir.exists() {
            let _ = tokio::fs::remove_dir_all(&db_dir).await;
        }

        // 4. Delete database row
        let conn = self.db.lock().map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM databases WHERE id = ?", params![id])
            .map_err(|e| e.to_string())?;

        Ok(())
    }

    pub fn set_linked_project(&self, id: i64, project_id: Option<i64>) -> Result<(), String> {
        let conn = self.db.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE databases SET linked_project_id = ?, updated_at = ? WHERE id = ?",
            params![project_id, now(), id],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    // --- Isolated Process Container Lifecycle ---
    #[allow(clippy::too_many_arguments)]
    async fn init_and_start(
        &self,
        id: i64,
        port: u16,
        db_name: &str,
        db_user: &str,
        db_pass: &str,
        is_superuser: bool,
        access_mode: &str,
        allowed_ips: &str,
        db_dir: &Path,
    ) -> Result<String, String> {
        let pg_bins = PgBinaries::detect()?;
        let data_dir = db_dir.join("data");
        let log_file = db_dir.join("postgresql.log");

        self.logs.add(
            None,
            None,
            "database",
            "info",
            &format!("[DB #{}] Preparing isolated sandbox for '{}' on port {}...", id, db_name, port),
        );

        // 1. Initialize cluster if not already initialized
        let is_new = !data_dir.join("PG_VERSION").exists();
        if is_new {
            // Ensure data directory is empty before running initdb
            if data_dir.exists() {
                let _ = tokio::fs::remove_dir_all(&data_dir).await;
            }
            let _ = tokio::fs::create_dir_all(&data_dir).await;

            let pw_tmp = db_dir.join("pw.tmp");
            tokio::fs::write(&pw_tmp, db_pass)
                .await
                .map_err(|e| format!("Failed to write temporary initdb credential: {}", e))?;

            let pw_str = to_clean_path_str(&pw_tmp);
            let data_str = to_clean_path_str(&data_dir);

            self.logs.add(
                None,
                None,
                "database",
                "info",
                &format!("[DB #{}] Initializing PostgreSQL data cluster via initdb (SCRAM-SHA-256)...", id),
            );

            ensure_pg_permissions(db_dir, Some(&data_dir));
            let mut init_cmd = make_pg_server_command(
                &pg_bins.initdb,
                &[
                    "-D",
                    &data_str,
                    "-U",
                    db_user,
                    "-A",
                    "scram-sha-256",
                    "--pwfile",
                    &pw_str,
                    "-E",
                    "UTF8",
                    "--no-locale",
                ],
            );

            let out = init_cmd.output().await.map_err(|e| {
                format!("Failed to execute initdb: {}", e)
            })?;

            let _ = tokio::fs::remove_file(&pw_tmp).await;

            if !out.status.success() {
                let stderr = String::from_utf8_lossy(&out.stderr);
                let stdout = String::from_utf8_lossy(&out.stdout);
                return Err(format!("initdb failed: {} {}", stdout.trim(), stderr.trim()));
            }

            // Append WebDep configuration to postgresql.conf
            let conf_path = data_dir.join("postgresql.conf");
            let extra_conf = format!(
                "\n# --- WebDep Isolated Process Container Settings ---\nlisten_addresses = '*'\nport = {}\nmax_connections = 100\n",
                port
            );
            if let Ok(mut f) = tokio::fs::OpenOptions::new().append(true).open(&conf_path).await {
                use tokio::io::AsyncWriteExt;
                let _ = f.write_all(extra_conf.as_bytes()).await;
            }
        }

        // 2. Configure pg_hba.conf rules
        self.logs.add(
            None,
            None,
            "database",
            "info",
            &format!("[DB #{}] Applying network firewall & client authentication rules (mode: '{}')...", id, access_mode),
        );
        let hba_content = generate_pg_hba(access_mode, allowed_ips);
        let hba_path = data_dir.join("pg_hba.conf");
        let _ = tokio::fs::write(&hba_path, hba_content).await;

        // 3. Start PostgreSQL using pg_ctl
        self.logs.add(
            None,
            None,
            "database",
            "info",
            &format!("[DB #{}] Spawning isolated PostgreSQL engine process on port {}...", id, port),
        );
        let data_str = to_clean_path_str(&data_dir);
        let log_str = to_clean_path_str(&log_file);
        // Pin the port in postgresql.conf (passing '-o "-p N"' is mangled by Windows argument quoting)
        {
            let conf_path = data_dir.join("postgresql.conf");
            if let Ok(existing) = tokio::fs::read_to_string(&conf_path).await {
                let mut cleaned: Vec<&str> = existing
                    .lines()
                    .filter(|l| !l.trim_start().starts_with("port =") && !l.trim_start().starts_with("port="))
                    .collect();
                let pin = format!("port = {}", port);
                cleaned.push(&pin);
                let _ = tokio::fs::write(&conf_path, cleaned.join("\n") + "\n").await;
            }
        }

        // Check if there is a stale postmaster.pid from an unexpected termination
        let pid_file = data_dir.join("postmaster.pid");
        if pid_file.exists() {
            if let Some(old_pid) = read_pg_pid(&data_dir) {
                if is_process_alive(old_pid) {
                    info!("PostgreSQL for db #{} is already running (PID: {})", id, old_pid);
                    return Ok(format!("pid-{}", old_pid));
                }
            }
            let _ = tokio::fs::remove_file(&pid_file).await;
        }

        ensure_pg_permissions(db_dir, Some(&data_dir));
        let mut start_cmd = make_pg_server_command(
            &pg_bins.pg_ctl,
            &[
                "-D",
                &data_str,
                "-l",
                &log_str,
                "-W",
                "start",
            ],
        );
        start_cmd.stdin(std::process::Stdio::null());
        start_cmd.stdout(std::process::Stdio::null());
        start_cmd.stderr(std::process::Stdio::null());

        let _ = tokio::time::timeout(tokio::time::Duration::from_secs(5), start_cmd.status()).await;

        let pid = match wait_for_pg_ready(port, &data_dir, 20000).await {
            Some(p) => p,
            None => {
                let tail = std::fs::read_to_string(&log_file)
                    .map(|s| {
                        let lines: Vec<&str> = s.lines().collect();
                        lines[lines.len().saturating_sub(8)..].join(" | ")
                    })
                    .unwrap_or_default();
                let foreign = tokio::net::TcpStream::connect(format!("127.0.0.1:{}", port)).await.is_ok();
                let reason = if foreign {
                    format!("Port {} is already used by another program (for example a system PostgreSQL service). Stop it or delete and recreate this database so it gets a free port.", port)
                } else {
                    format!("PostgreSQL failed to start on port {}.", port)
                };
                return Err(format!("{} Log: {}", reason, tail));
            }
        };
        self.logs.add(
            None,
            None,
            "database",
            "info",
            &format!("[DB #{}] PostgreSQL engine running (PID: {}) on port {}. Ready for connections.", id, pid, port),
        );

        // 4. Ensure custom database exists and is owned by db_user (only for newly initialized clusters)
        if is_new && db_name != "postgres" {
            let sql = format!(r#"CREATE DATABASE "{}" OWNER "{}";"#, db_name, db_user);
            let mut psql_cmd = Command::new(&pg_bins.psql);
            psql_cmd.args([
                "-h",
                "127.0.0.1",
                "-p",
                &port.to_string(),
                "-U",
                db_user,
                "-d",
                "postgres",
                "-c",
                &sql,
            ]);
            psql_cmd.stdin(std::process::Stdio::null());
            psql_cmd.env("PGPASSWORD", db_pass);
            let _ = tokio::time::timeout(tokio::time::Duration::from_secs(6), psql_cmd.output()).await;
        }

        // 5. Restrict superuser privileges if is_superuser is false and cluster is new
        if is_new && !is_superuser {
            let sql = format!(r#"ALTER ROLE "{}" NOSUPERUSER NOCREATEDB NOCREATEROLE;"#, db_user);
            let mut psql_cmd = Command::new(&pg_bins.psql);
            psql_cmd.args([
                "-h",
                "127.0.0.1",
                "-p",
                &port.to_string(),
                "-U",
                db_user,
                "-d",
                "postgres",
                "-c",
                &sql,
            ]);
            psql_cmd.stdin(std::process::Stdio::null());
            psql_cmd.env("PGPASSWORD", db_pass);
            let _ = tokio::time::timeout(tokio::time::Duration::from_secs(4), psql_cmd.output()).await;
        }

        info!(
            "Started isolated PostgreSQL process container for db #{} on port {} (PID: {})",
            id, port, pid
        );
        Ok(format!("pid-{}", pid))
    }

    // --- Port Finder Helper ---
    fn find_next_free_port(&self, start: u16) -> Result<u16, String> {
        let conn = self.db.lock().map_err(|e| e.to_string())?;
        crate::db::allocate_global_unique_port(&conn, None, start, None, None)
    }

    // --- Firewall Synchronization (UFW / iptables) ---
    pub async fn sync_firewall_rules(port: u16, access_mode: &str, allowed_ips: &str) {
        security::sync_firewall_rules(port, access_mode, allowed_ips).await;
    }

    pub async fn remove_firewall_rules(port: u16, allowed_ips: &str) {
        security::remove_firewall_rules(port, allowed_ips).await;
    }
}

