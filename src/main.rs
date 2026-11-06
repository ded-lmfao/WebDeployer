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
                .unwrap_or_else(|_| "nexus_deploy=info,tower_http=info".into()),
        )
        .with(tracing_subscriber::fmt::layer())
        .init();

    let config = Config::from_env();
    info!("Starting Nexus Deploy 2.0 (Rust Engine)");
    info!("Data directory: {}", config.data_dir.display());

    let db = open_db(&config.data_dir)?;
    let vault = Arc::new(Vault::new(&config.data_dir)?);
    let auth = Arc::new(Auth::new(db.clone(), config.session_ttl_s));
    let projects = Arc::new(Projects::new(db.clone(), vault.clone(), config.data_dir.clone()));
    let logs = Arc::new(Logs::new(db.clone()));
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

    let state = AppState {
        db,
        auth,
        projects,
        logs,
        monitor,
        caddy,
        runtime,
        deployer,
    };

    let app = create_router(state);

    let addr: SocketAddr = format!("{}:{}", config.host, config.port)
        .parse()
        .expect("Invalid HOST or PORT");

    info!("Nexus Deploy 2.0 listening on http://{}", addr);

    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;

    Ok(())
}
