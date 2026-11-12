use serde::{Deserialize, Serialize};

pub fn default_branch() -> String { "main".to_string() }
pub fn default_project_kind() -> String { "web".to_string() }
pub fn default_access_mode() -> String { "local".to_string() }
pub fn default_project_type() -> String { "node".to_string() }
pub fn default_deploy_method() -> String { "managed".to_string() }
pub fn default_app_status() -> String { "stopped".to_string() }
pub fn default_health_timeout_s() -> i64 { 30 }
pub fn default_stability_s() -> i64 { 5 }
pub fn default_poll_interval_s() -> i64 { 60 }
pub fn default_retention() -> i64 { 5 }
pub fn default_true() -> bool { true }

pub fn deserialize_bool_or_int<'de, D>(deserializer: D) -> Result<bool, D::Error>
where
    D: serde::Deserializer<'de>,
{
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum BoolOrInt {
        Bool(bool),
        Int(i64),
        Str(String),
    }
    match BoolOrInt::deserialize(deserializer)? {
        BoolOrInt::Bool(b) => Ok(b),
        BoolOrInt::Int(i) => Ok(i != 0),
        BoolOrInt::Str(s) => Ok(s == "1" || s.eq_ignore_ascii_case("true")),
    }
}

#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct Project {
    #[serde(default)]
    pub id: i64,
    pub name: String,
    pub slug: String,
    pub repo_url: String,
    #[serde(default = "default_branch")]
    pub branch: String,
    #[serde(default = "default_project_type")]
    pub project_type: String,
    #[serde(default = "default_deploy_method")]
    pub deploy_method: String,
    #[serde(default)]
    pub deploy_dir: String,
    #[serde(default)]
    pub port: Option<u16>,
    #[serde(default)]
    pub install_cmd: String,
    #[serde(default)]
    pub build_cmd: String,
    #[serde(default)]
    pub start_cmd: String,
    #[serde(default)]
    pub health_url: String,
    #[serde(default)]
    pub health_cmd: String,
    #[serde(default = "default_health_timeout_s")]
    pub health_timeout_s: i64,
    #[serde(default = "default_stability_s")]
    pub stability_s: i64,
    #[serde(default = "default_true", deserialize_with = "deserialize_bool_or_int")]
    pub preflight: bool,
    #[serde(default, deserialize_with = "deserialize_bool_or_int")]
    pub auto_deploy: bool,
    #[serde(default = "default_poll_interval_s")]
    pub poll_interval_s: i64,
    #[serde(default)]
    pub webhook_secret: Option<String>,
    #[serde(default = "default_retention")]
    pub retention: i64,
    #[serde(default)]
    pub persistent_paths: Vec<String>,
    #[serde(default)]
    pub current_release_id: Option<i64>,
    #[serde(default)]
    pub deployed_sha: Option<String>,
    #[serde(default)]
    pub last_poll_at: Option<i64>,
    #[serde(default = "default_app_status")]
    pub app_status: String,
    #[serde(default)]
    pub app_pid: Option<u32>,
    #[serde(default)]
    pub app_started_at: Option<i64>,
    #[serde(default)]
    pub domains: Vec<String>,
    #[serde(default, deserialize_with = "deserialize_bool_or_int")]
    pub ssl_enabled: bool,
    #[serde(default)]
    pub ssl_email: String,
    #[serde(default, deserialize_with = "deserialize_bool_or_int")]
    pub nginx_configured: bool,
    #[serde(default)]
    pub created_at: i64,
    #[serde(default)]
    pub updated_at: i64,
    #[serde(default = "default_project_kind")]
    pub project_kind: String,
    #[serde(default = "default_access_mode")]
    pub access_mode: String,
    #[serde(default)]
    pub allowed_ips: String,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct EnvVarView {
    pub key: String,
    pub value: String,
    #[serde(default)]
    pub real_value: String,
    pub is_secret: bool,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct EnvVarInput {
    pub key: String,
    pub value: String,
    #[serde(default = "default_true")]
    pub is_secret: bool,
}

pub const SELECT_PROJECT_FIELDS: &str = "\
    id, name, slug, repo_url, branch, project_type, deploy_method, deploy_dir, port, \
    install_cmd, build_cmd, start_cmd, health_url, health_cmd, health_timeout_s, \
    stability_s, preflight, auto_deploy, poll_interval_s, webhook_secret, retention, \
    persistent_paths, current_release_id, deployed_sha, last_poll_at, app_status, \
    app_pid, app_started_at, domains, ssl_enabled, ssl_email, nginx_configured, \
    created_at, updated_at, project_kind, access_mode, allowed_ips";

pub fn row_to_project(r: &rusqlite::Row) -> Result<Project, rusqlite::Error> {
    let p_paths_str: String = r.get(21)?;
    let p_paths: Vec<String> = serde_json::from_str(&p_paths_str).unwrap_or_default();
    let domains_str: String = r.get(28)?;
    let domains: Vec<String> = serde_json::from_str(&domains_str).unwrap_or_default();

    Ok(Project {
        id: r.get(0)?,
        name: r.get(1)?,
        slug: r.get(2)?,
        repo_url: r.get(3)?,
        branch: r.get(4)?,
        project_type: r.get(5)?,
        deploy_method: r.get(6)?,
        deploy_dir: r.get(7)?,
        port: r.get::<_, Option<u32>>(8)?.map(|p| p as u16),
        install_cmd: r.get(9)?,
        build_cmd: r.get(10)?,
        start_cmd: r.get(11)?,
        health_url: r.get(12)?,
        health_cmd: r.get(13)?,
        health_timeout_s: r.get(14)?,
        stability_s: r.get(15)?,
        preflight: r.get::<_, i64>(16)? != 0,
        auto_deploy: r.get::<_, i64>(17)? != 0,
        poll_interval_s: r.get(18)?,
        webhook_secret: r.get(19)?,
        retention: r.get(20)?,
        persistent_paths: p_paths,
        current_release_id: r.get(22)?,
        deployed_sha: r.get(23)?,
        last_poll_at: r.get(24)?,
        app_status: r.get(25)?,
        app_pid: r.get::<_, Option<u32>>(26)?,
        app_started_at: r.get(27)?,
        domains,
        ssl_enabled: r.get::<_, i64>(29)? != 0,
        ssl_email: r.get(30)?,
        nginx_configured: r.get::<_, i64>(31)? != 0,
        created_at: r.get(32)?,
        updated_at: r.get(33)?,
        project_kind: r.get::<_, Option<String>>(34)?.unwrap_or_else(default_project_kind),
        access_mode: r.get::<_, Option<String>>(35)?.unwrap_or_else(default_access_mode),
        allowed_ips: r.get::<_, Option<String>>(36)?.unwrap_or_default(),
    })
}

pub fn parse_dotenv(input: &str) -> Vec<(String, String)> {
    let mut vars = Vec::new();
    for raw_line in input.lines() {
        let line = raw_line.trim();
        // Ignore comments and empty lines
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        // Strip optional leading 'export '
        let line = if let Some(stripped) = line.strip_prefix("export ") {
            stripped.trim()
        } else {
            line
        };
        // Split on first '='
        if let Some((k, v)) = line.split_once('=') {
            let key = k.trim().to_string();
            if key.is_empty() {
                continue;
            }
            let mut val = v.trim();
            // Strip matching surrounding quotes if present
            if (val.starts_with('"') && val.ends_with('"') && val.len() >= 2)
                || (val.starts_with('\'') && val.ends_with('\'') && val.len() >= 2)
            {
                val = &val[1..val.len() - 1];
            } else if let Some(idx) = val.find(" #") {
                // If unquoted, strip trailing comment
                val = val[..idx].trim_end();
            }
            vars.push((key, val.to_string()));
        }
    }
    vars
}

