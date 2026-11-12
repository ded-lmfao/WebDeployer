use serde::{Deserialize, Serialize};

fn default_presence() -> String {
    "offline".to_string()
}

#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct User {
    pub id: i64,
    pub username: String,
    pub disabled: bool,
    pub permissions: Vec<String>,
    #[serde(rename = "allowedProjects")]
    pub allowed_projects: Vec<i64>,
    #[serde(rename = "allProjects")]
    pub all_projects: bool,
    #[serde(rename = "isMainAdmin")]
    pub is_main_admin: bool,
    #[serde(rename = "totpEnabled")]
    pub totp_enabled: bool,
    #[serde(default = "default_presence")]
    pub presence: String,
    pub created_at: i64,
}

impl User {
    pub fn from_db(
        id: i64,
        username: String,
        disabled_int: i64,
        perms_json: String,
        proj_json: String,
        totp_enabled_int: i64,
        created_at: i64,
    ) -> Self {
        let is_main_admin = id == 1 || username.eq_ignore_ascii_case("admin");
        let disabled = !is_main_admin && disabled_int != 0;

        let mut permissions: Vec<String> = serde_json::from_str(&perms_json).unwrap_or_default();
        if is_main_admin {
            permissions = vec!["*".to_string()];
        }

        let mut all_projects = is_main_admin;
        let mut allowed_projects = Vec::new();
        if !is_main_admin {
            if let Ok(vals) = serde_json::from_str::<Vec<serde_json::Value>>(&proj_json) {
                for v in vals {
                    if v.as_str() == Some("*") {
                        all_projects = true;
                    } else if let Some(pid) = v.as_i64() {
                        allowed_projects.push(pid);
                    } else if let Some(s) = v.as_str() {
                        if let Ok(pid) = s.parse::<i64>() {
                            allowed_projects.push(pid);
                        }
                    }
                }
            } else {
                all_projects = true;
            }
        }

        Self {
            id,
            username,
            disabled,
            permissions,
            allowed_projects,
            all_projects,
            is_main_admin,
            totp_enabled: totp_enabled_int != 0,
            presence: default_presence(),
            created_at,
        }
    }

    pub fn from_row(r: &rusqlite::Row) -> rusqlite::Result<Self> {
        Ok(Self::from_db(
            r.get(0)?,
            r.get(1)?,
            r.get::<_, Option<i64>>(2)?.unwrap_or(0),
            r.get::<_, Option<String>>(3)?.unwrap_or_else(|| "[\"*\"]".into()),
            r.get::<_, Option<String>>(4)?.unwrap_or_else(|| "[\"*\"]".into()),
            r.get::<_, Option<i64>>(5)?.unwrap_or(0),
            r.get(6)?,
        ))
    }

    pub fn has_power(&self, power: &str) -> bool {
        if self.is_main_admin {
            return true;
        }
        self.permissions.iter().any(|p| p == "*" || p == power)
    }

    pub fn can_access_project(&self, project_id: i64) -> bool {
        if self.is_main_admin || self.all_projects {
            return true;
        }
        self.allowed_projects.contains(&project_id)
    }
}


