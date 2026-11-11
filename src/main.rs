#![allow(dead_code)]

mod api;
mod auth;
mod cache;
mod caddy;
mod config;
mod databases;
mod db;
mod deployer;
mod git;
mod logs;
mod monitor;
mod projects;
mod runtime;
mod static_assets;
mod updater;
mod vault;

use std::net::SocketAddr;
use std::sync::Arc;
use tracing::info;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

use crate::api::{create_router, AppState};
use crate::auth::Auth;
use crate::cache::AppCache;
use crate::caddy::Caddy;
use crate::config::Config;
use crate::db::open_db;
use crate::deployer::Deployer;
use crate::logs::Logs;
use crate::monitor::Monitor;
use crate::projects::Projects;
use crate::runtime::Runtime;
use crate::updater::Updater;
use crate::vault::Vault;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    // Fast, zero-overhead tracing subscriber
    tracing_subscriber::registry()
        .with(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "webdep=info,tower_http=info".into()),
        )
        .with(tracing_subscriber::fmt::layer())
        .init();

    let config = Config::from_env();
    info!("Starting WebDep — Multi-Website Deployment & Hosting Platform");
    info!("Data directory: {}", config.data_dir.display());

    let db = open_db(&config.data_dir)?;
    let vault = Arc::new(Vault::new(&config.data_dir)?);
    let auth = Arc::new(Auth::new(db.clone(), config.session_ttl_s));
    let projects = Arc::new(Projects::new(db.clone(), vault.clone(), config.data_dir.clone()));
    let logs = Arc::new(Logs::new(db.clone()));
    logs.add(
        None,
        None,
        "system",
        "info",
        "WebDep engine initialized (SQLite database connected and live log stream active)",
    );
    let monitor = Arc::new(Monitor::new());
    monitor.start_background_sampler();
    let cache = Arc::new(AppCache::new());
    let caddy = Arc::new(Caddy::new(&config.data_dir));
    let runtime = Arc::new(Runtime::new(db.clone(), (*logs).clone()));
    runtime.start_background_monitor();
    let deployer = Arc::new(Deployer::new(
        db.clone(),
        (*logs).clone(),
        projects.clone(),
        runtime.clone(),
        cache.clone(),
        config.data_dir.clone(),
    ));
    let databases = Arc::new(crate::databases::Databases::new(
        db.clone(),
        vault.clone(),
        (*logs).clone(),
        &config.data_dir,
    ));
    let updater = Arc::new(Updater::new(config.data_dir.clone()));

    // Auto-resume any websites marked 'running' in SQLite on platform startup,
    // and ensure any websites marked 'stopped' have no orphan processes left on their ports
    {
        let resume_projects = projects.clone();
        let resume_runtime = runtime.clone();
        let resume_logs = logs.clone();
        let platform_port = config.port;
        tokio::spawn(async move {
            resume_runtime.allow_firewall_port(80, None);
            resume_runtime.allow_firewall_port(443, None);
            resume_runtime.allow_firewall_port(platform_port, None);
            if let Ok(list) = resume_projects.list() {
                for p in list {
                    let _ = resume_runtime.ensure_container(&p);
                    if p.app_status == "running" {
                        let env = resume_projects.get_env_map(p.id);
                        match resume_runtime.start_project(&p, env, None).await {
                            Ok(pid) => {
                                resume_logs.add(
                                    Some(p.id),
                                    None,
                                    "system",
                                    "info",
                                    &format!("Auto-resumed website '{}' in isolated container (PID: {})", p.name, pid),
                                );
                            }
                            Err(e) => {
                                resume_logs.add(
                                    Some(p.id),
                                    None,
                                    "system",
                                    "warn",
                                    &format!("Could not auto-resume '{}': {}", p.name, e),
                                );
                            }
                        }
                    } else if p.app_status == "maintenance" {
                        let _ = resume_runtime.set_maintenance_mode(&p, true).await;
                    } else {
                        let _ = resume_runtime.stop_project(&p).await;
                    }
                }
            }
        });
    }

    let state = AppState {
        db,
        auth,
        projects: projects.clone(),
        logs: logs.clone(),
        monitor,
        caddy,
        runtime,
        deployer: deployer.clone(),
        cache,
        databases,
        updater,
    };

    let app = create_router(state);

    // Background binary hot-reload watcher: if target/release/webdep.exe is rebuilt on disk,
    // automatically hand off to the new binary so changes take effect without manual restarts.
    tokio::spawn(async move {
        let exe_path = std::path::PathBuf::from("target")
            .join("release")
            .join(if cfg!(windows) { "webdep.exe" } else { "webdep" });
        let initial_mtime = tokio::fs::metadata(&exe_path)
            .await
            .and_then(|m| m.modified())
            .ok();
        let mut interval = tokio::time::interval(tokio::time::Duration::from_secs(2));
        loop {
            interval.tick().await;
            if let (Some(init_t), Ok(meta)) = (initial_mtime, tokio::fs::metadata(&exe_path).await) {
                if let Ok(cur_t) = meta.modified() {
                    if cur_t > init_t && meta.len() > 1_000_000 {
                        tokio::time::sleep(tokio::time::Duration::from_millis(800)).await;
                        let mut cmd = std::process::Command::new(&exe_path);
                        cmd.env("WEBDEP_RESTARTED", "1")
                            .stdin(std::process::Stdio::null())
                            .stdout(std::process::Stdio::null())
                            .stderr(std::process::Stdio::null());
                        #[cfg(windows)]
                        {
                            use std::os::windows::process::CommandExt;
                            cmd.creation_flags(0x00000008 | 0x00000200);
                        }
                        if cmd.spawn().is_ok() {
                            tokio::time::sleep(tokio::time::Duration::from_millis(200)).await;
                            std::process::exit(0);
                        }
                    }
                }
            }
        }
    });

    let addr: SocketAddr = format!("{}:{}", config.host, config.port)
        .parse()
        .expect("Invalid HOST or PORT");

    info!("WebDep listening on http://{}", addr);

    // Retry binding up to 30s if a previous instance is shutting down
    let max_attempts = 60;
    let mut attempt = 0;
    let listener = loop {
        match tokio::net::TcpListener::bind(addr).await {
            Ok(l) => break l,
            Err(e) => {
                attempt += 1;
                if attempt >= max_attempts {
                    return Err(e.into());
                }
                tokio::time::sleep(std::time::Duration::from_millis(500)).await;
            }
        }
    };
    axum::serve(listener, app).await?;

    Ok(())
}
