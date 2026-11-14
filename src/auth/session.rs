use serde::{Deserialize, Serialize};

#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct Session {
    pub id: String,
    pub user_id: i64,
    pub expires_at: i64,
    pub last_active_at: i64,
    pub csrf_token: String,
}


