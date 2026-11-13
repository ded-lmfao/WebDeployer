use axum::{
    body::Body,
    extract::{Path as AxPath, Query, State},
    http::{HeaderMap, StatusCode},
    response::{
        sse::{Event, KeepAlive, Sse},
        Response,
    },
    Json,
};
use futures_util::stream::Stream;
use serde::{Deserialize, Serialize};
use std::convert::Infallible;
use tokio_stream::wrappers::BroadcastStream;
use tokio_stream::StreamExt;

use super::common::*;

#[derive(Serialize)]
pub(crate) struct AppLogsResponse {
    lines: Vec<String>,
}

pub(crate) async fn get_app_logs_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxPath(id): AxPath<i64>,
) -> Result<Json<AppLogsResponse>, (StatusCode, String)> {
    let _actor = verify_power(&state, &headers, "logs", Some(id))?;
    let entries = state.logs.list(Some(id), None, Some("app"), None, 200);
    let logs = entries
        .into_iter()
        .map(|l| l.message)
        .collect();

    Ok(Json(AppLogsResponse { lines: logs }))
}


// ---------------------------------------------------------------------------
// Real-Time SSE Log Streaming & Log History
// ---------------------------------------------------------------------------
#[derive(Deserialize)]
pub(crate) struct LogsQuery {
    project: Option<i64>,
    #[allow(dead_code)]
    channel: Option<String>,
    level: Option<String>,
    backlog: Option<usize>,
    limit: Option<usize>,
}

pub(crate) async fn list_logs_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<LogsQuery>,
) -> Result<Json<Vec<crate::logs::LogEntry>>, (StatusCode, String)> {
    let Some(pid) = q.project else {
        let _actor = require_current_user(&state, &headers)?;
        return Ok(Json(Vec::new()));
    };
    let _actor = verify_power(&state, &headers, "logs", Some(pid))?;
    let limit = q.limit.or(q.backlog).unwrap_or(300).min(2000);
    let logs = state.logs.list(
        Some(pid),
        None,
        Some("app"),
        q.level.as_deref(),
        limit,
    );
    Ok(Json(logs))
}

pub(crate) async fn logs_sse_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<LogsQuery>,
) -> Result<Sse<impl Stream<Item = Result<Event, Infallible>>>, (StatusCode, String)> {
    if let Some(pid) = q.project {
        let _actor = verify_power(&state, &headers, "logs", Some(pid))?;
    } else {
        let _actor = require_current_user(&state, &headers)?;
    }
    let backlog_limit = q.backlog.unwrap_or(200).min(1000);
    let initial_logs = match q.project {
        Some(pid) => state.logs.list(
            Some(pid),
            None,
            Some("app"),
            q.level.as_deref(),
            backlog_limit,
        ),
        None => Vec::new(),
    };
    let project_filter = q.project;
    let level_filter = q.level;

    let initial_event = if !initial_logs.is_empty() {
        serde_json::to_string(&initial_logs)
            .ok()
            .map(|json| Ok(Event::default().data(json)))
    } else {
        None
    };

    let rx = state.logs.subscribe();
    let live_stream = BroadcastStream::new(rx).filter_map(move |msg| {
        if let Ok(entry) = msg {
            // Strict per-app console isolation: only emit `app` channel logs for this exact project.
            let Some(pid) = project_filter else {
                return None;
            };
            if entry.project_id != Some(pid) || entry.channel != "app" {
                return None;
            }
            if let Some(ref lvl) = level_filter {
                if !lvl.is_empty() && &entry.level != lvl {
                    return None;
                }
            }
            if let Ok(json) = serde_json::to_string(&vec![entry]) {
                return Some(Ok(Event::default().data(json)));
            }
        }
        None
    });

    let combined = futures_util::stream::iter(initial_event.into_iter()).chain(live_stream);
    Ok(Sse::new(combined).keep_alive(KeepAlive::default()))
}

#[derive(Deserialize)]
pub(crate) struct DownloadLogsQuery {
    project: Option<i64>,
}

pub(crate) async fn logs_download_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<DownloadLogsQuery>,
) -> Result<Response, (StatusCode, String)> {
    let logs = match q.project {
        Some(pid) => {
            let _actor = verify_power(&state, &headers, "logs", Some(pid))?;
            state.logs.list(Some(pid), None, Some("app"), None, 5000)
        }
        None => {
            let _actor = require_current_user(&state, &headers)?;
            Vec::new()
        }
    };
    let mut out = String::new();
    for l in logs {
        out.push_str(&format!("[{}] {}\n", l.ts, l.message));
    }

    let res = Response::builder()
        .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
        .header(header::CONTENT_DISPOSITION, "attachment; filename=\"webdep-logs.txt\"")
        .body(Body::from(out))
        .map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, "Failed to build response".to_string()))?;

    Ok(res)
}



#[derive(Serialize)]
pub(crate) struct AuditItem {
    id: i64,
    #[serde(rename = "projectId")]
    project_id: Option<i64>,
    ts: i64,
    actor: String,
    action: String,
    target: Option<String>,
    detail: Option<String>,
    ip: Option<String>,
}

pub(crate) fn row_to_audit_item(r: &rusqlite::Row, default_target: Option<String>) -> rusqlite::Result<AuditItem> {
    Ok(AuditItem {
        id: r.get(0)?,
        project_id: r.get(1)?,
        ts: r.get(2)?,
        actor: r.get(3)?,
        action: r.get(4)?,
        target: r.get::<_, Option<String>>(5)?.or(default_target),
        detail: r.get(6)?,
        ip: r.get(7)?,
    })
}

#[derive(Deserialize)]
pub(crate) struct AuditQuery {
    #[serde(rename = "projectId")]
    project_id: Option<i64>,
    #[serde(rename = "databaseId")]
    database_id: Option<i64>,
    limit: Option<usize>,
}

pub(crate) async fn audit_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<AuditQuery>,
) -> Result<Response, (StatusCode, String)> {
    let (u, db_opt) = if let Some(db_id) = q.database_id {
        let (user, db) = crate::api::databases::get_authorized_database(
            &state,
            &headers,
            &["databases", "databases_manage", "audit"],
            db_id,
        )?;
        (user, Some(db))
    } else {
        (verify_power(&state, &headers, "audit", q.project_id)?, None)
    };
    let max_limit = q.limit.unwrap_or(500).min(1000);
    let cache_key = format!(
        "audit:d{}:p{}:u{}:l{}",
        q.database_id.unwrap_or(0),
        q.project_id.unwrap_or(0),
        u.id,
        max_limit
    );
    if let Some(res) = check_api_cache(&state.cache, &cache_key) {
        return Ok(res);
    }

    let conn = state.db.lock().unwrap();

    let mut list = Vec::new();
    if let Some(db) = db_opt {
        let db_tag = format!("DB #{}", db.id);
        let sql = format!(
            "SELECT id, project_id, ts, actor, action, target, detail, ip
             FROM audit
             WHERE LOWER(COALESCE(target, '')) = LOWER(?1)
                OR (LOWER(COALESCE(target, '')) = LOWER(?2) AND action LIKE 'database.%')
             ORDER BY ts DESC, id DESC LIMIT {}",
            max_limit
        );
        let mut stmt = conn
            .prepare(&sql)
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
        let rows = stmt
            .query_map(rusqlite::params![db_tag, db.name], |r| {
                row_to_audit_item(r, Some(db.name.clone()))
            })
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
        for r in rows.flatten() {
            list.push(r);
        }
    } else if let Some(pid) = q.project_id {
        let p_info: Option<(String, String)> = conn
            .query_row("SELECT name, slug FROM projects WHERE id = ?", rusqlite::params![pid], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .ok();
        let (p_name, p_slug) = p_info.unwrap_or_default();

        let sql = format!(
            "SELECT id, project_id, ts, actor, action, target, detail, ip
             FROM audit
             WHERE project_id = ?1
                OR LOWER(COALESCE(target, '')) = LOWER(?2)
                OR LOWER(COALESCE(target, '')) = LOWER(?3)
                OR COALESCE(target, '') = CAST(?1 AS TEXT)
             ORDER BY ts DESC, id DESC LIMIT {}",
            max_limit
        );
        let mut stmt = conn
            .prepare(&sql)
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
        let rows = stmt
            .query_map(rusqlite::params![pid, p_name, p_slug], |r| {
                row_to_audit_item(r, Some(p_name.clone()))
            })
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
        for r in rows.flatten() {
            list.push(r);
        }

        // Also include historical deployments & rollbacks from the `deployments` table
        // that predate per-website audit rows so the Activity tab shows the full timeline.
        if let Ok(mut dstmt) = conn.prepare(
            "SELECT id, kind, status, sha, trigger, actor, error, started_at, finished_at, release_id
             FROM deployments WHERE project_id = ? ORDER BY id DESC LIMIT 200",
        ) {
            if let Ok(drows) = dstmt.query_map(rusqlite::params![pid], |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, Option<String>>(3)?,
                    r.get::<_, String>(4)?,
                    r.get::<_, String>(5)?,
                    r.get::<_, Option<String>>(6)?,
                    r.get::<_, i64>(7)?,
                    r.get::<_, Option<i64>>(8)?,
                    r.get::<_, Option<i64>>(9)?,
                ))
            }) {
                for d in drows.flatten() {
                    let (dep_id, kind, status, sha, trigger, actor, error, started_at, finished_at, rel_id) = d;
                    let dep_tag = format!("#{}", dep_id);
                    let already_logged = list.iter().any(|a| {
                        a.detail.as_deref().map(|s| s.contains(&dep_tag)).unwrap_or(false)
                    });
                    if !already_logged {
                        let short_sha = sha.as_deref().map(|s| &s[..s.len().min(7)]).unwrap_or("HEAD");
                        let action = match (kind.as_str(), status.as_str()) {
                            ("rollback", "success") => "rollback.success",
                            ("rollback", "failed") => "rollback.failed",
                            ("rollback", _) => "rollback.trigger",
                            (_, "success") => "deploy.success",
                            (_, "failed") => "deploy.failed",
                            _ => "deploy.trigger",
                        };
                        let detail = match status.as_str() {
                            "success" => format!(
                                "{} #{} succeeded (commit {}, release #{}, trigger: {})",
                                if kind == "rollback" { "Rollback" } else { "Deployment" },
                                dep_id,
                                short_sha,
                                rel_id.unwrap_or(0),
                                trigger
                            ),
                            "failed" => format!(
                                "{} #{} failed (commit {}): {}",
                                if kind == "rollback" { "Rollback" } else { "Deployment" },
                                dep_id,
                                short_sha,
                                error.unwrap_or_else(|| "build/runtime error".to_string())
                            ),
                            _ => format!(
                                "{} #{} started (commit {}, trigger: {})",
                                if kind == "rollback" { "Rollback" } else { "Deployment" },
                                dep_id,
                                short_sha,
                                trigger
                            ),
                        };
                        list.push(AuditItem {
                            id: 1_000_000 + dep_id,
                            project_id: Some(pid),
                            ts: finished_at.unwrap_or(started_at),
                            actor,
                            action: action.to_string(),
                            target: Some(p_name.clone()),
                            detail: Some(detail),
                            ip: None,
                        });
                    }
                }
            }
        }

        // Also include historical snapshots from the `backups` table if not already in audit
        if let Ok(mut bstmt) = conn.prepare(
            "SELECT id, kind, note, size_bytes, created_at FROM backups WHERE project_id = ? ORDER BY id DESC LIMIT 100",
        ) {
            if let Ok(brows) = bstmt.query_map(rusqlite::params![pid], |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, Option<String>>(2)?,
                    r.get::<_, i64>(3)?,
                    r.get::<_, i64>(4)?,
                ))
            }) {
                for b in brows.flatten() {
                    let (bid, bkind, bnote, bsize, bts) = b;
                    let note_str = bnote.unwrap_or_else(|| "Snapshot".to_string());
                    let already_logged = list.iter().any(|a| {
                        a.action.starts_with("backup.") && (a.ts - bts).abs() < 5000
                    });
                    if !already_logged && bts > 0 {
                        list.push(AuditItem {
                            id: 2_000_000 + bid,
                            project_id: Some(pid),
                            ts: bts,
                            actor: "system".to_string(),
                            action: "backup.create".to_string(),
                            target: Some(p_name.clone()),
                            detail: Some(format!(
                                "Backup #{}: {} ({}, {} KB)",
                                bid,
                                note_str,
                                bkind,
                                (bsize / 1024).max(1)
                            )),
                            ip: None,
                        });
                    }
                }
            }
        }

        list.sort_by(|a, b| b.ts.cmp(&a.ts).then_with(|| b.id.cmp(&a.id)));
        list.truncate(max_limit);
    } else {
        let sql = format!(
            "SELECT id, project_id, ts, actor, action, target, detail, ip FROM audit ORDER BY id DESC LIMIT {}",
            max_limit
        );
        let mut stmt = conn
            .prepare(&sql)
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
        let rows = stmt
            .query_map([], |r| row_to_audit_item(r, None))
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
        let can_global = u.is_main_admin || u.has_power("settings_manage");
        for r in rows.flatten() {
            match r.project_id {
                Some(pid) if !u.can_access_project(pid) => continue,
                None if !can_global => continue,
                _ => {}
            }
            list.push(r);
        }
    }
    drop(conn);

    cached_json_response(&state.cache, cache_key, &list, std::time::Duration::from_secs(5))
        .map_err(|c| (c, "Serialization error".to_string()))
}
