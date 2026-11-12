use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    response::Response,
};
use serde::{Deserialize, Serialize};

use crate::api::common::*;

#[derive(Serialize)]
pub(crate) struct OverviewProjectItem {
    pub project: Project,
    pub app: OverviewAppStatus,
    pub active: Option<crate::deployer::Deployment>,
    pub behind: Option<u32>,
    pub ahead: Option<u32>,
    #[serde(rename = "lastSuccess")]
    pub last_success: Option<crate::deployer::Deployment>,
}

#[derive(Serialize)]
pub(crate) struct OverviewAppStatus {
    pub running: bool,
    pub pid: Option<u32>,
    #[serde(rename = "startedAt")]
    pub started_at: Option<i64>,
    #[serde(rename = "cpuPct")]
    pub cpu_pct: Option<f32>,
    #[serde(rename = "memoryBytes")]
    pub memory_bytes: Option<u64>,
    #[serde(rename = "memoryFormatted")]
    pub memory_formatted: Option<String>,
    #[serde(rename = "diskBytes")]
    pub disk_bytes: Option<u64>,
    #[serde(rename = "diskFormatted")]
    pub disk_formatted: Option<String>,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct ResourceItem {
    pub id: String,
    pub name: String,
    pub kind: String,          // "panel", "website", "service", "database"
    pub status: String,        // "running", "stopped", "error"
    pub pid: Option<u32>,
    pub port: Option<u16>,
    #[serde(rename = "cpuPct")]
    pub cpu_pct: f32,
    #[serde(rename = "memoryBytes")]
    pub memory_bytes: u64,
    #[serde(rename = "memoryFormatted")]
    pub memory_formatted: String,
    #[serde(rename = "memoryPct")]
    pub memory_pct: f32,
    #[serde(rename = "diskBytes")]
    pub disk_bytes: u64,
    #[serde(rename = "diskFormatted")]
    pub disk_formatted: String,
    #[serde(rename = "diskPct")]
    pub disk_pct: f32,
    #[serde(rename = "projectId")]
    pub project_id: Option<i64>,
    #[serde(rename = "databaseId")]
    pub database_id: Option<i64>,
    #[serde(rename = "commitSha")]
    pub commit_sha: Option<String>,
    pub domain: Option<String>,
    #[serde(rename = "projectType", skip_serializing_if = "Option::is_none")]
    pub project_type: Option<String>,
    #[serde(rename = "startCmd", skip_serializing_if = "Option::is_none")]
    pub start_cmd: Option<String>,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct ResourceSummary {
    #[serde(rename = "totalManagedMemory")]
    pub total_managed_memory: u64,
    #[serde(rename = "totalManagedMemoryFormatted")]
    pub total_managed_memory_formatted: String,
    #[serde(rename = "totalManagedCpu")]
    pub total_managed_cpu: f32,
    #[serde(rename = "totalManagedDisk")]
    pub total_managed_disk: u64,
    #[serde(rename = "totalManagedDiskFormatted")]
    pub total_managed_disk_formatted: String,
    #[serde(rename = "panelMemory")]
    pub panel_memory: u64,
    #[serde(rename = "panelMemoryFormatted")]
    pub panel_memory_formatted: String,
    #[serde(rename = "panelCpu")]
    pub panel_cpu: f32,
    #[serde(rename = "panelDisk")]
    pub panel_disk: u64,
    #[serde(rename = "panelDiskFormatted")]
    pub panel_disk_formatted: String,
    #[serde(rename = "systemOverheadMemory")]
    pub system_overhead_memory: u64,
    #[serde(rename = "systemOverheadMemoryFormatted")]
    pub system_overhead_memory_formatted: String,
    #[serde(rename = "systemOverheadCpu")]
    pub system_overhead_cpu: f32,
    #[serde(rename = "runningWorkloadsCount")]
    pub running_workloads_count: usize,
    #[serde(rename = "totalWorkloadsCount")]
    pub total_workloads_count: usize,
}

#[derive(Serialize)]
pub(crate) struct OverviewResponse {
    pub projects: Vec<OverviewProjectItem>,
    pub resources: Vec<ResourceItem>,
    pub summary: ResourceSummary,
    pub recent: Vec<crate::deployer::Deployment>,
    pub monitor: crate::monitor::SystemMetrics,
}

pub(crate) fn format_resource_bytes(bytes: u64) -> String {
    if bytes >= 1024 * 1024 * 1024 {
        format!("{:.2} GB", bytes as f64 / (1024.0 * 1024.0 * 1024.0))
    } else if bytes >= 1024 * 1024 {
        format!("{:.1} MB", bytes as f64 / (1024.0 * 1024.0))
    } else if bytes >= 1024 {
        format!("{:.0} KB", bytes as f64 / 1024.0)
    } else {
        format!("{} B", bytes)
    }
}

pub(crate) fn fetch_overview_deployment(
    conn: &rusqlite::Connection,
    status_filter: &str,
    project_id: i64,
    project_name: &str,
) -> Option<crate::deployer::Deployment> {
    let sql = format!(
        "SELECT id, project_id, release_id, from_release_id, kind, status, stage, sha, trigger, actor, error, started_at, finished_at \
         FROM deployments WHERE project_id = ? AND {} ORDER BY id DESC LIMIT 1",
        status_filter
    );
    conn.query_row(
        &sql,
        rusqlite::params![project_id],
        |r| Ok(crate::deployer::Deployment {
            id: r.get(0)?,
            project_id: r.get(1)?,
            project_name: Some(project_name.to_string()),
            release_id: r.get(2)?,
            from_release_id: r.get(3)?,
            kind: r.get(4)?,
            status: r.get(5)?,
            stage: r.get(6)?,
            sha: r.get(7)?,
            trigger: r.get(8)?,
            actor: r.get(9)?,
            error: r.get(10)?,
            started_at: r.get(11)?,
            finished_at: r.get(12)?,
        }),
    ).ok()
}

pub(crate) async fn overview_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Response, StatusCode> {
    let user_opt = current_user(&state, &headers);
    let uid = user_opt.as_ref().map(|u| u.id).unwrap_or(0);
    let cache_key = format!("overview:u{}", uid);

    if let Some(res) = check_api_cache(&state.cache, &cache_key) {
        return Ok(res);
    }

    let mut projs = state.projects.list().map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    if let Some(ref u) = user_opt {
        projs.retain(|p| u.can_access_project(p.id));
    }

    let mut monitor = state.monitor.sample();
    let total_vps_mem = monitor.memory.total.max(1);
    let total_vps_disk = monitor.disk.as_ref().map(|d| d.total).unwrap_or(1).max(1);
    let num_cores = monitor.cpu.cores.max(1) as f32;
    let total_vps_cpu = monitor.cpu.pct as f32;
    let cwd = std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("."));

    let panel_pid = std::process::id();
    // Isolate panel daemon metrics to the WebDep process itself so child workloads are never double-counted into the panel
    let (panel_raw_cpu, panel_mem) = state.monitor.get_process_metrics(panel_pid);
    let mut pids_to_query = Vec::new();

    let mut proj_effective_pids = std::collections::HashMap::new();
    for p in &projs {
        let mut eff_pid = p.app_pid;
        if eff_pid.is_none() || eff_pid.map(|pid| !crate::runtime::process::is_pid_alive(pid)).unwrap_or(true) {
            if let Some(port) = p.port {
                if let Some(&port_pid) = crate::runtime::Runtime::find_pids_on_port(port).first() {
                    eff_pid = Some(port_pid);
                }
            }
        }
        if let Some(pid) = eff_pid {
            if crate::runtime::process::is_pid_alive(pid) {
                proj_effective_pids.insert(p.id, pid);
                pids_to_query.push(pid);
            }
        }
    }

    let dbs = state.databases.list().unwrap_or_default();
    let mut db_pids = Vec::with_capacity(dbs.len());
    for db in &dbs {
        let mut d_pid = None;
        if let Some(ref cid) = db.container_id {
            if let Some(p_str) = cid.strip_prefix("pid-") {
                d_pid = p_str.parse::<u32>().ok();
            }
        }
        if d_pid.is_none() {
            let data_dir = std::path::PathBuf::from(&db.data_dir).join("data");
            d_pid = crate::databases::read_pg_pid(&data_dir);
        }
        if db.status == "running" {
            if let Some(pid) = d_pid {
                pids_to_query.push(pid);
            }
        }
        db_pids.push((db.id, d_pid));
    }

    let proc_metrics = state.monitor.get_tree_metrics(&pids_to_query);
    let mut resources = Vec::new();

    // 1. WebDep Panel daemon self metrics
    let panel_cpu = ((panel_raw_cpu / num_cores).min(100.0) * 10.0).round() / 10.0;
    let panel_mem_pct = ((panel_mem as f64 / total_vps_mem as f64 * 100.0) as f32 * 10.0).round() / 10.0;

    let panel_exe_size = std::env::current_exe().ok().map(|p| crate::monitor::get_path_disk_size(&p)).unwrap_or(0);
    let panel_db_size = crate::monitor::get_path_disk_size(&cwd.join("data").join("webdep.sqlite"))
        .saturating_add(crate::monitor::get_path_disk_size(&cwd.join("data").join("webdep.sqlite-wal")));
    let panel_disk = panel_exe_size.saturating_add(panel_db_size);
    let panel_disk_pct = ((panel_disk as f64 / total_vps_disk as f64 * 100.0) as f32 * 10.0).round() / 10.0;

    resources.push(ResourceItem {
        id: "panel".to_string(),
        name: "WebDep Control Panel".to_string(),
        kind: "panel".to_string(),
        status: "running".to_string(),
        pid: Some(panel_pid),
        port: Some(4600),
        cpu_pct: panel_cpu,
        memory_bytes: panel_mem,
        memory_formatted: format_resource_bytes(panel_mem),
        memory_pct: panel_mem_pct,
        disk_bytes: panel_disk,
        disk_formatted: format_resource_bytes(panel_disk),
        disk_pct: panel_disk_pct,
        project_id: None,
        database_id: None,
        commit_sha: None,
        domain: None,
        project_type: Some("panel".to_string()),
        start_cmd: None,
    });

    let mut items = Vec::new();

    for p in projs {
        let active_pid = proj_effective_pids.get(&p.id).copied().or(p.app_pid);
        let is_running = (p.app_status == "running" && active_pid.is_some())
            || (active_pid.map(crate::runtime::process::is_pid_alive).unwrap_or(false));
        let (raw_cpu, mem) = if is_running {
            if let Some(pid) = active_pid {
                proc_metrics.get(&pid).copied().unwrap_or((0.0, 0))
            } else {
                (0.0, 0)
            }
        } else {
            (0.0, 0)
        };
        let cpu = if is_running {
            ((raw_cpu / num_cores).min(100.0) * 10.0).round() / 10.0
        } else {
            0.0
        };
        let mem_pct = if is_running {
            ((mem as f64 / total_vps_mem as f64 * 100.0) as f32 * 10.0).round() / 10.0
        } else {
            0.0
        };
        let mem_fmt = if is_running && mem > 0 {
            format_resource_bytes(mem)
        } else if is_running {
            "< 1 MB".to_string()
        } else {
            "0 MB".to_string()
        };

        let deploy_dir = std::path::Path::new(&p.deploy_dir);
        let deploy_size = crate::monitor::get_path_disk_size(deploy_dir);
        let container_dir = cwd.join("data").join("containers").join(&p.slug);
        let container_size = if container_dir.as_path() != deploy_dir {
            crate::monitor::get_path_disk_size(&container_dir)
        } else {
            0
        };
        let disk_bytes = deploy_size.saturating_add(container_size);
        let disk_fmt = format_resource_bytes(disk_bytes);
        let disk_pct = ((disk_bytes as f64 / total_vps_disk as f64 * 100.0) as f32 * 10.0).round() / 10.0;

        let (last_success, active) = {
            let conn = state.db.lock().unwrap();
            (
                fetch_overview_deployment(&conn, "status = 'success'", p.id, &p.name),
                fetch_overview_deployment(&conn, "status IN ('running', 'pending')", p.id, &p.name),
            )
        };

        items.push(OverviewProjectItem {
            app: OverviewAppStatus {
                running: is_running,
                pid: active_pid,
                started_at: p.app_started_at,
                cpu_pct: if is_running { Some(cpu) } else { None },
                memory_bytes: if is_running { Some(mem) } else { None },
                memory_formatted: if is_running { Some(mem_fmt.clone()) } else { None },
                disk_bytes: Some(disk_bytes),
                disk_formatted: Some(disk_fmt.clone()),
            },
            project: p.clone(),
            active,
            behind: Some(0),
            ahead: Some(0),
            last_success,
        });

        let kind = if p.project_kind == "service" { "service" } else { "website" };
        resources.push(ResourceItem {
            id: format!("{}-{}", kind, p.id),
            name: p.name.clone(),
            kind: kind.to_string(),
            status: if is_running { "running".to_string() } else { p.app_status.clone() },
            pid: active_pid,
            port: p.port,
            cpu_pct: cpu,
            memory_bytes: mem,
            memory_formatted: mem_fmt,
            memory_pct: mem_pct,
            disk_bytes,
            disk_formatted: disk_fmt,
            disk_pct,
            project_id: Some(p.id),
            database_id: None,
            commit_sha: p.deployed_sha.clone(),
            domain: p.domains.first().cloned(),
            project_type: Some(p.project_type.clone()),
            start_cmd: Some(p.start_cmd.clone()),
        });
    }

    for db in dbs {
        let d_pid = db_pids.iter().find(|(id, _)| *id == db.id).and_then(|(_, p)| *p);
        let is_running = db.status == "running";
        let (raw_cpu, mem) = if is_running {
            if let Some(pid) = d_pid {
                proc_metrics.get(&pid).copied().unwrap_or((0.0, 0))
            } else {
                (0.0, 0)
            }
        } else {
            (0.0, 0)
        };
        let cpu = if is_running {
            ((raw_cpu / num_cores).min(100.0) * 10.0).round() / 10.0
        } else {
            0.0
        };
        let mem_pct = if is_running {
            ((mem as f64 / total_vps_mem as f64 * 100.0) as f32 * 10.0).round() / 10.0
        } else {
            0.0
        };
        let mem_fmt = if is_running && mem > 0 {
            format_resource_bytes(mem)
        } else if is_running {
            "< 1 MB".to_string()
        } else {
            "0 MB".to_string()
        };

        let db_dir = std::path::Path::new(&db.data_dir);
        let db_disk = crate::monitor::get_path_disk_size(db_dir);
        let db_disk_fmt = format_resource_bytes(db_disk);
        let db_disk_pct = ((db_disk as f64 / total_vps_disk as f64 * 100.0) as f32 * 10.0).round() / 10.0;

        resources.push(ResourceItem {
            id: format!("database-{}", db.id),
            name: db.name.clone(),
            kind: "database".to_string(),
            status: db.status.clone(),
            pid: d_pid,
            port: Some(db.port),
            cpu_pct: cpu,
            memory_bytes: mem,
            memory_formatted: mem_fmt,
            memory_pct: mem_pct,
            disk_bytes: db_disk,
            disk_formatted: db_disk_fmt,
            disk_pct: db_disk_pct,
            project_id: None,
            database_id: Some(db.id),
            commit_sha: None,
            domain: if db.domain.is_empty() { None } else { Some(db.domain.clone()) },
            project_type: Some("postgres".to_string()),
            start_cmd: None,
        });
    }

    // Sort: running workloads first, descending by memory usage
    resources.sort_by(|a, b| {
        let a_run = a.status == "running";
        let b_run = b.status == "running";
        match (a_run, b_run) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => b.memory_bytes.cmp(&a.memory_bytes),
        }
    });

    // Sum of CPU across all workloads (including panel)
    let sum_all_cpu: f32 = resources.iter().map(|r| r.cpu_pct).sum();
    let sum_all_cpu = (sum_all_cpu * 10.0).round() / 10.0;

    // Harmonize VPS total CPU:
    // A system's total CPU usage is at least the sum of CPU used by its running processes.
    // If the top card's instantaneous snapshot was lower than the active workloads, raise it so
    // the top card and the workload breakdown table never contradict each other.
    let effective_vps_cpu = (total_vps_cpu).max(sum_all_cpu).min(100.0);
    monitor.cpu.pct = effective_vps_cpu.round() as u8;

    let final_panel_cpu = resources.iter().find(|r| r.id == "panel").map(|r| r.cpu_pct).unwrap_or(panel_cpu);

    let total_managed_mem: u64 = resources.iter().filter(|r| r.id != "panel").map(|r| r.memory_bytes).sum();
    let total_managed_disk: u64 = resources.iter().filter(|r| r.id != "panel").map(|r| r.disk_bytes).sum();
    let total_managed_cpu: f32 = resources.iter().filter(|r| r.id != "panel").map(|r| r.cpu_pct).sum();
    let total_managed_cpu = (total_managed_cpu * 10.0).round() / 10.0;

    let total_all_mem = panel_mem.saturating_add(total_managed_mem);

    // Baseline operating system kernel & system daemon overhead (minimum 64MB or 1.5% of RAM)
    // Avoids misleading '0 B' system overhead when process RSS sums overcount shared physical pages.
    let min_os_overhead = (total_vps_mem as f64 * 0.015).max(64.0 * 1024.0 * 1024.0) as u64;
    let system_overhead = if monitor.memory.used > total_all_mem.saturating_add(min_os_overhead) {
        monitor.memory.used.saturating_sub(total_all_mem)
    } else {
        min_os_overhead
    };
    let effective_used_mem = total_all_mem.saturating_add(system_overhead).min(total_vps_mem);
    monitor.memory.used = effective_used_mem;
    monitor.memory.pct = ((effective_used_mem as f64 / total_vps_mem as f64 * 100.0).round() as u8).min(100);

    let system_overhead_cpu = (((effective_vps_cpu - (final_panel_cpu + total_managed_cpu)).max(0.0)) * 10.0).round() / 10.0;
    let running_count = resources.iter().filter(|r| r.id != "panel" && r.status == "running").count();
    let total_count = resources.iter().filter(|r| r.id != "panel").count();

    let summary = ResourceSummary {
        total_managed_memory: total_managed_mem,
        total_managed_memory_formatted: format_resource_bytes(total_managed_mem),
        total_managed_cpu,
        total_managed_disk,
        total_managed_disk_formatted: format_resource_bytes(total_managed_disk),
        panel_memory: panel_mem,
        panel_memory_formatted: format_resource_bytes(panel_mem),
        panel_cpu: final_panel_cpu,
        panel_disk,
        panel_disk_formatted: format_resource_bytes(panel_disk),
        system_overhead_memory: system_overhead,
        system_overhead_memory_formatted: format_resource_bytes(system_overhead),
        system_overhead_cpu,
        running_workloads_count: running_count,
        total_workloads_count: total_count,
    };

    let recent = state.deployer.list_deployments(None, 10);

    let payload = OverviewResponse {
        projects: items,
        resources,
        summary,
        recent,
        monitor,
    };

    cached_json_response(&state.cache, cache_key, &payload, std::time::Duration::from_secs(2))
}

pub(crate) async fn monitor_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Response, StatusCode> {
    let user_opt = current_user(&state, &headers);
    let uid = user_opt.as_ref().map(|u| u.id).unwrap_or(0);
    let cache_key = format!("monitor:u{}", uid);

    if let Some(res) = check_api_cache(&state.cache, &cache_key) {
        return Ok(res);
    }

    let sample = state.monitor.sample();
    let mut projs = state.projects.list().unwrap_or_default();
    if let Some(ref u) = user_opt {
        projs.retain(|p| u.can_access_project(p.id));
    }
    let now_ms = now();

    let proj_metrics: Vec<serde_json::Value> = projs
        .into_iter()
        .map(|p| {
            let running = p.app_status == "running";
            let uptime_ms = if running {
                p.app_started_at.map(|s| (now_ms - s).max(0))
            } else {
                None
            };
            serde_json::json!({
                "id": p.id,
                "name": p.name,
                "slug": p.slug,
                "deployedSha": p.deployed_sha,
                "status": {
                    "running": running,
                    "appStatus": p.app_status,
                    "pid": p.app_pid,
                    "uptimeMs": uptime_ms,
                },
                "disk": {
                    "used": 15 * 1024 * 1024u64
                },
                "deployStatus": {
                    "status": if p.deployed_sha.is_some() { "success" } else { "idle" }
                }
            })
        })
        .collect();

    let hostname = std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_else(|_| "webdep-server".to_string());

    let val = serde_json::json!({
        "cpu": sample.cpu,
        "memory": sample.memory,
        "disk": sample.disk,
        "uptime_s": sample.uptime_s,
        "processes": sample.processes,
        "cache": state.cache.stats(),
        "system": {
            "hostname": hostname,
            "platform": format!("{} ({})", std::env::consts::OS, std::env::consts::ARCH),
            "uptime": sample.uptime_s,
            "cpu": {
                "cores": sample.cpu.cores,
                "pct": sample.cpu.pct,
                "load": [sample.cpu.pct as f64 / 100.0]
            }
        },
        "projects": proj_metrics
    });

    cached_json_response(&state.cache, cache_key, &val, std::time::Duration::from_secs(2))
}

