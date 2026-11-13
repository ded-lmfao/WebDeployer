pub mod common;
pub mod auth;
pub mod projects;
pub mod files;
pub mod deployments;
pub mod caddy;
pub mod logs;
pub mod system;
pub mod databases;
pub mod users;

pub use common::AppState;

use axum::{
    extract::DefaultBodyLimit,
    http::StatusCode,
    middleware,
    routing::{delete, get, post, put},
    Router,
};
use tower_http::compression::CompressionLayer;

use self::auth::*;
use self::projects::*;
use self::files::*;
use self::deployments::*;
use self::caddy::*;
use self::logs::*;
use self::system::*;
use self::databases::*;
use self::users::*;
use self::common::{axum_static_fallback, security_middleware};

pub fn create_router(state: AppState) -> Router {
    Router::new()
        // Auth & 2FA endpoints
        .route("/api/auth/login", post(login_handler))
        .route("/api/auth/2fa/verify-login", post(verify_2fa_login_handler))
        .route("/api/auth/2fa/setup", post(setup_2fa_handler))
        .route("/api/auth/2fa/enable", post(enable_2fa_handler))
        .route("/api/auth/2fa/disable", post(disable_2fa_handler))
        .route("/api/auth/passkeys", get(list_passkeys_handler))
        .route("/api/auth/passkeys/register/start", post(passkey_register_start_handler))
        .route("/api/auth/passkeys/register/finish", post(passkey_register_finish_handler))
        .route("/api/auth/passkeys/:id", delete(delete_passkey_handler))
        .route("/api/auth/passkeys/login/start", post(passkey_login_start_handler))
        .route("/api/auth/passkeys/login/finish", post(passkey_login_finish_handler))
        .route("/api/auth/sessions/revoke-others", post(revoke_other_sessions_handler))
        .route("/api/auth/logout", post(logout_handler))
        .route("/api/auth/me", get(me_handler))
        .route("/api/auth/presence", post(presence_handler))
        .route("/api/auth/password", post(change_password_handler))
        // Projects
        .route("/api/projects", get(list_projects_handler).post(create_project_handler))
        .route(
            "/api/projects/:id",
            get(get_project_handler)
                .put(update_project_handler)
                .patch(update_project_handler)
                .delete(delete_project_handler),
        )
        .route("/api/projects/:id/detect", post(detect_project_handler))
        .route("/api/projects/:id/commits", get(project_commits_handler))
        .route("/api/projects/:id/check", post(project_check_handler))
        .route("/api/projects/:id/fetch", post(project_fetch_handler))
        .route("/api/projects/:id/deploy-key", post(project_deploy_key_handler))
        .route("/api/projects/:id/webhook-secret/rotate", post(rotate_webhook_secret_handler))
        .route("/api/projects/:id/backups", get(list_backups_handler))
        .route("/api/projects/:id/backup", post(create_backup_handler))
        .route("/api/projects/:id/backups/restore", post(restore_backup_handler))
        .route("/api/projects/:id/backups/:backup_id", delete(delete_backup_handler))
        // Project Env
        .route("/api/projects/:id/env", get(get_env_handler).put(set_env_handler).post(set_env_handler))
        .route("/api/projects/:id/env/bulk", post(bulk_set_env_handler))
        .route("/api/projects/:id/env/raw", get(get_raw_env_handler))
        .route("/api/projects/:id/env/reveal", post(reveal_env_handler))
        .route("/api/projects/:id/env/:key", delete(delete_env_handler))
        // Project Lifecycle & Actions
        .route("/api/projects/:id/deploy", post(deploy_project_handler))
        .route("/api/projects/:id/rollback", post(rollback_project_handler))
        .route("/api/projects/:id/start", post(start_project_handler))
        .route("/api/projects/:id/stop", post(stop_project_handler))
        .route("/api/projects/:id/restart", post(restart_project_handler))
        .route("/api/projects/:id/maintenance", post(toggle_maintenance_handler))
        .route("/api/projects/:id/releases", get(list_releases_handler).post(create_release_handler))
        .route("/api/projects/:id/releases/:release_id", delete(delete_release_handler))
        .route("/api/projects/:id/caddy", get(get_caddy_handler))
        .route("/api/projects/:id/caddy/apply", post(apply_caddy_handler))
        .route("/api/projects/:id/nginx", get(get_caddy_handler))
        .route("/api/projects/:id/nginx/apply", post(apply_caddy_handler))
        .route("/api/projects/:id/nginx/certbot", post(certbot_caddy_handler))
        .route("/api/projects/:id/app-logs", get(get_app_logs_handler))
        // Backend service file browser
        .route("/api/projects/:id/files", get(files_list_handler).delete(files_delete_handler))
        .route("/api/projects/:id/files/content", get(files_read_handler).put(files_write_handler))
        .route("/api/projects/:id/files/download", get(files_download_handler))
        .route("/api/projects/:id/files/rename", post(files_rename_handler))
        .route("/api/projects/:id/files/mkdir", post(files_mkdir_handler))
        .route(
            "/api/projects/:id/files/upload",
            post(files_upload_handler).layer(DefaultBodyLimit::max(500 * 1024 * 1024)),
        )
        // GitHub & Caddy Status
        .route("/api/github/repos", get(github_repos_handler))
        .route("/api/nginx/status", get(caddy_status_handler))
        .route("/api/caddy/status", get(caddy_status_handler))
        // Deployments & Releases
        .route("/api/deployments", get(list_deployments_handler))
        .route("/api/deployments/:id", get(get_deployment_handler))
        .route("/api/deployments/:id/logs", get(get_deployment_logs_handler))
        // Live Logs SSE, History & Download
        .route("/api/logs", get(list_logs_handler))
        .route("/api/logs/stream", get(logs_sse_handler))
        .route("/api/logs/download", get(logs_download_handler))
        // GitHub Webhooks
        .route("/api/webhooks/github/:slug", post(github_webhook_handler))
        // Overview, Telemetry & Cache Layer
        .route("/api/overview", get(overview_handler))
        .route("/api/projects/:id/usage", get(project_usage_handler))
        .route("/api/monitor", get(monitor_handler))
        .route("/api/audit", get(audit_handler))
        .route("/api/cache/stats", get(cache_stats_handler))
        .route("/api/cache/clear", post(cache_clear_handler))
        .route("/api/system/restart", post(restart_panel_handler))
        .route("/api/system/version", get(system_version_handler))
        .route("/api/system/update/status", get(system_update_status_handler))
        .route("/api/system/update/repo", post(system_update_repo_handler))
        .route("/api/system/update", post(system_update_handler))
        .route("/api/settings", get(get_settings_handler).put(update_settings_handler).patch(update_settings_handler))
        .route("/api/users", get(list_users_handler).post(create_user_handler))
        .route("/api/users/:id", put(update_user_handler).patch(update_user_handler).delete(delete_user_handler))
        .route("/api/users/:id/reset-2fa", post(admin_reset_user_2fa_handler))
        // Managed Databases (PostgreSQL)
        .route("/api/databases", get(list_databases_handler).post(create_database_handler))
        .route("/api/databases/:id", get(get_database_handler).delete(delete_database_handler))
        .route("/api/databases/:id/start", post(start_database_handler))
        .route("/api/databases/:id/stop", post(stop_database_handler))
        .route("/api/databases/:id/restart", post(restart_database_handler))
        .route("/api/databases/:id/access", put(update_database_access_handler))
        .route("/api/databases/:id/link", post(link_database_handler))
        .route("/api/databases/:id/unlink", post(unlink_database_handler))
        .route("/api/databases/:id/logs", get(get_database_logs_handler))
        .route("/healthz", get(|| async { (StatusCode::OK, "ok") }))
        // Static assets fallback
        .fallback(axum_static_fallback)
        .layer(middleware::from_fn_with_state(state.clone(), security_middleware))
        .layer(CompressionLayer::new())
        .with_state(state)
}
