use rusqlite::params;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::sync::broadcast;

use crate::db::{now, DbPool};

#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct LogEntry {
    pub id: i64,
    pub project_id: Option<i64>,
    pub deployment_id: Option<i64>,
    pub channel: String,
    pub level: String,
    pub message: String,
    pub ts: i64,
}

#[derive(Clone)]
pub struct Logs {
    db: DbPool,
    sender: Arc<broadcast::Sender<LogEntry>>,
}

impl Logs {
    pub fn new(db: DbPool) -> Self {
        let (sender, _) = broadcast::channel(2048);
        Self {
            db,
            sender: Arc::new(sender),
        }
    }

    pub fn subscribe(&self) -> broadcast::Receiver<LogEntry> {
        self.sender.subscribe()
    }

    pub fn add(
        &self,
        project_id: Option<i64>,
        deployment_id: Option<i64>,
        channel: &str,
        level: &str,
        message: &str,
    ) -> i64 {
        let ts = now();
        let id = {
            let conn = self.db.lock().unwrap();
            conn.execute(
                "INSERT INTO logs(project_id, deployment_id, channel, level, message, ts) VALUES(?, ?, ?, ?, ?, ?)",
                params![project_id, deployment_id, channel, level, message, ts],
            )
            .ok();
            conn.last_insert_rowid()
        };

        let entry = LogEntry {
            id,
            project_id,
            deployment_id,
            channel: channel.to_string(),
            level: level.to_string(),
            message: message.to_string(),
            ts,
        };

        // Broadcast to SSE clients (ignore if no listeners)
        let _ = self.sender.send(entry);

        id
    }

    pub fn list(
        &self,
        project_id: Option<i64>,
        deployment_id: Option<i64>,
        channel: Option<&str>,
        level: Option<&str>,
        limit: usize,
    ) -> Vec<LogEntry> {
        let conn = self.db.lock().unwrap();
        let mut sql = "SELECT id, project_id, deployment_id, channel, level, message, ts FROM logs WHERE 1=1".to_string();
        let mut params_vec: Vec<rusqlite::types::Value> = Vec::new();

        if let Some(pid) = project_id {
            sql.push_str(" AND (project_id = ? OR project_id IS NULL)");
            params_vec.push(pid.into());
        }
        if let Some(did) = deployment_id {
            sql.push_str(" AND deployment_id = ?");
            params_vec.push(did.into());
        }
        if let Some(ch) = channel {
            if !ch.is_empty() {
                sql.push_str(" AND channel = ?");
                params_vec.push(ch.to_string().into());
            }
        }
        if let Some(lvl) = level {
            if !lvl.is_empty() {
                sql.push_str(" AND level = ?");
                params_vec.push(lvl.to_string().into());
            }
        }

        sql.push_str(&format!(" ORDER BY id DESC LIMIT {}", limit));

        let mut stmt = match conn.prepare(&sql) {
            Ok(s) => s,
            Err(_) => return Vec::new(),
        };

        let params_slice: Vec<&dyn rusqlite::ToSql> = params_vec.iter().map(|v| v as &dyn rusqlite::ToSql).collect();
        let rows = stmt.query_map(params_slice.as_slice(), |r| {
            Ok(LogEntry {
                id: r.get(0)?,
                project_id: r.get(1)?,
                deployment_id: r.get(2)?,
                channel: r.get(3)?,
                level: r.get(4)?,
                message: r.get(5)?,
                ts: r.get(6)?,
            })
        });

        match rows {
            Ok(r) => {
                let mut list: Vec<LogEntry> = r.flatten().collect();
                list.reverse(); // Chronological order
                list
            }
            Err(_) => Vec::new(),
        }
    }
}

