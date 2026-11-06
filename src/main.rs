#![allow(dead_code)]

mod api;
mod auth;
mod caddy;
mod config;
mod db;
mod deployer;
mod git;
mod logs;
mod monitor;
mod projects;
mod runtime;
mod static_assets;
mod vault;

use std::net::SocketAddr;
use std::sync::Arc;
use tracing::info;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

use crate::api::{create_router, AppState};
use crate::auth::Auth;
use crate::caddy::Caddy;
use crate::config::Config;
use crate::db::open_db;
use crate::deployer::Deployer;
use crate::git::Git;
use crate::logs::Logs;
use crate::monitor::Monitor;
use crate::projects::Projects;
use crate::runtime::Runtime;
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
    let caddy = Arc::new(Caddy::new(&config.data_dir));
    let runtime = Arc::new(Runtime::new(db.clone(), (*logs).clone()));
    let deployer = Arc::new(Deployer::new(
        db.clone(),
        (*logs).clone(),
        projects.clone(),
        runtime.clone(),
        config.data_dir.clone(),
    ));

    // Auto-resume any websites marked 'running' in SQLite on platform startup
    {
        let resume_projects = projects.clone();
        let resume_runtime = runtime.clone();
        let resume_logs = logs.clone();
        tokio::spawn(async move {
            if let Ok(list) = resume_projects.list() {
                for p in list {
                    if p.app_status == "running" {
                        let env = resume_projects.get_env_map(p.id);
                        match resume_runtime.start_project(&p, env, None).await {
                            Ok(pid) => {
                                resume_logs.add(
                                    Some(p.id),
                                    None,
                                    "system",
                                    "info",
                                    &format!("Auto-resumed website '{}' (PID: {}) from SQLite state", p.name, pid),
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
    };

    let app = create_router(state);

    // Background auto-deploy poller (polls every 30s for projects with auto_deploy=1)
    let poll_projects = projects.clone();
    let poll_deployer = deployer.clone();
    let poll_logs = logs.clone();
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(tokio::time::Duration::from_secs(30));
        loop {
            interval.tick().await;
            if let Ok(list) = poll_projects.list() {
                for p in list {
                    if !p.auto_deploy {
                        continue;
                    }
                    let repo_dir = std::path::Path::new(&p.deploy_dir).join("repo");
                    if repo_dir.exists() {
                        if let Ok(()) = Git::fetch(&repo_dir, &p.branch) {
                            if let Ok(head) = Git::resolve_head(&repo_dir) {
                                if p.deployed_sha.as_deref() != Some(&head) {
                                    poll_logs.add(
                                        Some(p.id),
                                        None,
                                        "github",
                                        "info",
                                        &format!("Auto-deploy: new commit {} detected on branch {}", &head[..7.min(head.len())], p.branch),
                                    );
                                    let dep_id = poll_deployer.create_deployment(&p, "deploy", "auto-poller", "auto");
                                    let d = poll_deployer.clone();
                                    tokio::spawn(async move {
                                        d.run_deploy(p.id, dep_id).await;
                                    });
                                }
                            }
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

    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;

    Ok(())
}
