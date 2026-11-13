use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use axum::{
    extract::{Path as AxPath, State},
    http::{HeaderMap, StatusCode},
    Json,
};
use rusqlite::params;
use serde::Serialize;

use super::overview::format_resource_bytes;
use crate::api::common::*;
use crate::monitor::{get_path_disk_size, NetworkMetrics};
use crate::monitor_net::get_project_live_telemetry;
use crate::runtime::Runtime;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AppCpuUsage {
    pub percent: f32,
    pub host_cores: usize,
    pub active_pids: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AppRamUsage {
    pub bytes: u64,
    pub formatted: String,
    pub host_total_bytes: u64,
    pub host_total_formatted: String,
    pub percent_of_host: f32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AppDiskUsage {
    pub bytes: u64,
    pub formatted: String,
    pub vps_total_bytes: u64,
    pub vps_free_bytes: u64,
    pub vps_free_formatted: String,
    pub percent_of_vps: f32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AppUsageResponse {
    pub project_id: i64,
    pub project_kind: String,
    pub status: String,
    pub running: bool,
    pub port: Option<u16>,
    pub cpu: AppCpuUsage,
    pub ram: AppRamUsage,
    pub disk: AppDiskUsage,
    pub network: NetworkMetrics,
}

fn round_one_decimal(val: f64) -> f32 {
    ((val * 10.0).round() / 10.0) as f32
}

fn round_two_decimals(val: f64) -> f32 {
    ((val * 100.0).round() / 100.0) as f32
}

fn collect_project_seed_pids(state: &AppState, project_id: i64, slug: &str, deploy_dir: &Path, port: Option<u16>, db_pid: Option<i64>, cwd: &Path) -> Vec<u32> {
    let mut seeds: HashSet<u32> = HashSet::new();

    if let Some(pid) = db_pid {
        if pid > 0 && crate::runtime::is_pid_alive(pid as u32) {
            seeds.insert(pid as u32);
        }
    }

    if let Ok(map) = state.runtime.processes.lock() {
        if let Some(child) = map.get(&project_id) {
            if let Some(pid) = child.id() {
                if pid > 0 {
                    seeds.insert(pid);
                }
            }
        }
    }

    if let Some(p) = port {
        for port_pid in Runtime::find_pids_on_port(p) {
            if port_pid > 0 {
                seeds.insert(port_pid);
            }
        }
    }

    let pid_file = cwd.join("data").join("containers").join(slug).join("pids.txt");
    if let Ok(content) = fs::read_to_string(&pid_file) {
        for line in content.lines() {
            if let Ok(pid) = line.trim().parse::<u32>() {
                if pid > 0 && crate::runtime::is_pid_alive(pid) {
                    seeds.insert(pid);
                }
            }
        }
    }

    let sysinfo_pids = Runtime::find_project_processes_sysinfo(project_id, slug, deploy_dir, &seeds);
    for pid in sysinfo_pids {
        if pid > 0 {
            seeds.insert(pid);
        }
    }

    seeds.into_iter().collect()
}

struct EntityUsageInput<'a> {
    tracker_key: i64,
    public_id: i64,
    entity_kind: &'a str,
    status_str: &'a str,
    port: Option<u16>,
    seed_pids: Vec<u32>,
    runtime_running: bool,
    disk_dirs: Vec<PathBuf>,
}

fn compute_entity_usage(state: &AppState, input: EntityUsageInput<'_>) -> AppUsageResponse {
    let monitor = state.monitor.sample();
    let num_cores = monitor.cpu.cores.max(1);
    let total_vps_mem = monitor.memory.total.max(1);
    let total_vps_disk = monitor.disk.as_ref().map(|d| d.total).unwrap_or(1).max(1);
    let free_vps_disk = monitor.disk.as_ref().map(|d| d.free).unwrap_or(0);

    let (raw_cpu, mem_bytes, alive_pids, tree_pids) = state.monitor.get_combined_tree_details(&input.seed_pids);
    let running = (input.status_str == "running" && !input.seed_pids.is_empty()) || alive_pids > 0 || input.runtime_running;
    let active_pid_count = if running {
        alive_pids.max(input.seed_pids.len())
    } else {
        0
    };

    let mut all_pids = input.seed_pids.clone();
    for pid in tree_pids {
        if !all_pids.contains(&pid) {
            all_pids.push(pid);
        }
    }

    let (network, live_cpu_pct) = get_project_live_telemetry(input.tracker_key, running, &all_pids);
    let sysinfo_cpu_pct = ((raw_cpu / num_cores as f32).clamp(0.0, 100.0)) as f64;
    let cpu_pct = if running {
        round_two_decimals(live_cpu_pct.unwrap_or(sysinfo_cpu_pct).clamp(0.0, 100.0))
    } else {
        0.0
    };
    let effective_mem = if running { mem_bytes } else { 0 };
    let mem_pct = if running {
        round_one_decimal((effective_mem as f64 / total_vps_mem as f64) * 100.0)
    } else {
        0.0
    };

    let disk_bytes: u64 = input
        .disk_dirs
        .iter()
        .fold(0u64, |acc, dir| acc.saturating_add(get_path_disk_size(dir)));
    let disk_pct = round_one_decimal((disk_bytes as f64 / total_vps_disk as f64) * 100.0);

    let status = if running && input.status_str != "maintenance" {
        "running".to_string()
    } else {
        input.status_str.to_string()
    };

    AppUsageResponse {
        project_id: input.public_id,
        project_kind: input.entity_kind.to_string(),
        status,
        running,
        port: input.port,
        cpu: AppCpuUsage {
            percent: cpu_pct,
            host_cores: num_cores,
            active_pids: active_pid_count,
        },
        ram: AppRamUsage {
            bytes: effective_mem,
            formatted: format_resource_bytes(effective_mem),
            host_total_bytes: total_vps_mem,
            host_total_formatted: format_resource_bytes(total_vps_mem),
            percent_of_host: mem_pct,
        },
        disk: AppDiskUsage {
            bytes: disk_bytes,
            formatted: format_resource_bytes(disk_bytes),
            vps_total_bytes: total_vps_disk,
            vps_free_bytes: free_vps_disk,
            vps_free_formatted: format_resource_bytes(free_vps_disk),
            percent_of_vps: disk_pct,
        },
        network,
    }
}

/// Returns live per-app CPU, RAM, Disk, and Network Inbound/Outbound usage for any website or service.
pub(crate) async fn project_usage_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxPath(id): AxPath<i64>,
) -> Result<Json<AppUsageResponse>, (StatusCode, String)> {
    let _actor = verify_project_access(&state, &headers, id)?;

    let p = state
        .projects
        .get(id)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .ok_or_else(|| (StatusCode::NOT_FOUND, "Project not found".to_string()))?;

    let db_pid: Option<i64> = {
        let conn = state.db.lock().unwrap();
        conn.query_row(
            "SELECT app_pid FROM projects WHERE id = ?",
            params![id],
            |r| r.get::<_, Option<i64>>(0),
        )
        .ok()
        .flatten()
    };

    let cwd = std::env::current_dir().unwrap_or_else(|_| Path::new(".").to_path_buf());
    let deploy_dir = Path::new(&p.deploy_dir);
    let seed_pids = collect_project_seed_pids(&state, p.id, &p.slug, deploy_dir, p.port, db_pid, &cwd);

    // Include workspace deploy directory plus container persistent data outside deploy_dir.
    let mut disk_dirs = vec![deploy_dir.to_path_buf()];
    let container_dir = cwd.join("data").join("containers").join(&p.slug);
    if !container_dir.starts_with(deploy_dir) {
        disk_dirs.push(container_dir);
    }

    Ok(Json(compute_entity_usage(
        &state,
        EntityUsageInput {
            tracker_key: p.id,
            public_id: p.id,
            entity_kind: &p.project_kind,
            status_str: &p.app_status,
            port: p.port,
            seed_pids,
            runtime_running: state.runtime.is_running(p.id),
            disk_dirs,
        },
    )))
}

/// Returns live per-database CPU, RAM, Disk, and Network Inbound/Outbound usage for a managed database.
pub(crate) async fn database_usage_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxPath(id): AxPath<i64>,
) -> Result<Json<AppUsageResponse>, (StatusCode, String)> {
    let (_actor, db) = crate::api::databases::get_authorized_database(
        &state,
        &headers,
        &["databases", "databases_manage"],
        id,
    )?;

    let mut seeds: HashSet<u32> = HashSet::new();
    if let Some(pid) = db
        .container_id
        .as_deref()
        .and_then(|s| s.strip_prefix("pid-"))
        .and_then(|s| s.parse::<u32>().ok())
    {
        if pid > 0 && crate::runtime::is_pid_alive(pid) {
            seeds.insert(pid);
        }
    }

    let db_root = PathBuf::from(&db.data_dir);
    if let Some(pid) = crate::databases::read_pg_pid(&db_root.join("data")) {
        if pid > 0 && crate::runtime::is_pid_alive(pid) {
            seeds.insert(pid);
        }
    }

    if db.status == "running" {
        for port_pid in Runtime::find_pids_on_port(db.port) {
            if port_pid > 0 && crate::runtime::is_pid_alive(port_pid) {
                seeds.insert(port_pid);
            }
        }
    }

    let seed_pids: Vec<u32> = seeds.into_iter().collect();
    let runtime_running = !seed_pids.is_empty();

    Ok(Json(compute_entity_usage(
        &state,
        EntityUsageInput {
            tracker_key: -db.id,
            public_id: db.id,
            entity_kind: "database",
            status_str: &db.status,
            port: Some(db.port),
            seed_pids,
            runtime_running,
            disk_dirs: vec![db_root],
        },
    )))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_round_one_decimal_and_usage_serialization() {
        assert_eq!(round_one_decimal(12.349), 12.3);
        assert_eq!(round_one_decimal(12.351), 12.4);
        assert_eq!(round_two_decimals(0.034), 0.03);
        assert_eq!(round_two_decimals(12.346), 12.35);

        let resp = AppUsageResponse {
            project_id: 7,
            project_kind: "service".to_string(),
            status: "running".to_string(),
            running: true,
            port: Some(4000),
            cpu: AppCpuUsage {
                percent: 3.4,
                host_cores: 8,
                active_pids: 2,
            },
            ram: AppRamUsage {
                bytes: 128 * 1024 * 1024,
                formatted: "128.0 MB".to_string(),
                host_total_bytes: 1024 * 1024 * 1024,
                host_total_formatted: "1.0 GB".to_string(),
                percent_of_host: 12.5,
            },
            disk: AppDiskUsage {
                bytes: 64 * 1024 * 1024,
                formatted: "64.0 MB".to_string(),
                vps_total_bytes: 10 * 1024 * 1024 * 1024,
                vps_free_bytes: 5 * 1024 * 1024 * 1024,
                vps_free_formatted: "5.0 GB".to_string(),
                percent_of_vps: 0.6,
            },
            network: NetworkMetrics::default(),
        };

        let val = serde_json::to_value(&resp).unwrap();
        assert_eq!(val["projectId"], 7);
        assert_eq!(val["cpu"]["activePids"], 2);
        assert_eq!(val["ram"]["formatted"], "128.0 MB");
        assert_eq!(val["disk"]["formatted"], "64.0 MB");
        assert!(val["network"]["history"].is_array());
    }
}

