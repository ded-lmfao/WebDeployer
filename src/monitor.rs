use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use sysinfo::{CpuRefreshKind, Disks, MemoryRefreshKind, RefreshKind, System};

#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct CpuMetrics {
    pub pct: u8,
    pub cores: usize,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct MemoryMetrics {
    pub total: u64,
    pub used: u64,
    pub free: u64,
    pub pct: u8,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct DiskMetrics {
    pub total: u64,
    pub used: u64,
    pub free: u64,
    pub pct: u8,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct ProcessMetrics {
    pub pid: u32,
    pub name: String,
    pub cpu: f32,
    pub memory: u64,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct SystemMetrics {
    pub cpu: CpuMetrics,
    pub memory: MemoryMetrics,
    pub disk: Option<DiskMetrics>,
    pub uptime_s: u64,
    pub processes: Vec<ProcessMetrics>,
}

pub struct Monitor {
    sys: Mutex<System>,
    last_sample_time: Mutex<Instant>,
    last_sample: Mutex<Option<SystemMetrics>>,
}

impl Monitor {
    pub fn new() -> Self {
        let sys = System::new_with_specifics(
            RefreshKind::new()
                .with_cpu(CpuRefreshKind::everything())
                .with_memory(MemoryRefreshKind::everything()),
        );
        Self {
            sys: Mutex::new(sys),
            last_sample_time: Mutex::new(Instant::now() - Duration::from_secs(10)),
            last_sample: Mutex::new(None),
        }
    }

    pub fn sample(&self) -> SystemMetrics {
        let mut last_time = self.last_sample_time.lock().unwrap();
        let mut cached = self.last_sample.lock().unwrap();

        // 1.5s memoization window to avoid high-frequency hardware polling
        if let Some(metrics) = cached.as_ref() {
            if last_time.elapsed() < Duration::from_millis(1500) {
                return metrics.clone();
            }
        }

        let mut sys = self.sys.lock().unwrap();
        sys.refresh_cpu_all();
        sys.refresh_memory();
        sys.refresh_processes(sysinfo::ProcessesToUpdate::All, true);

        let cpus = sys.cpus();
        let cpu_pct = if !cpus.is_empty() {
            let sum: f32 = cpus.iter().map(|c| c.cpu_usage()).sum();
            (sum / cpus.len() as f32).round() as u8
        } else {
            0
        };

        let total_mem = sys.total_memory();
        let used_mem = sys.used_memory();
        let free_mem = sys.free_memory();
        let mem_pct = if total_mem > 0 {
            ((used_mem as f64 / total_mem as f64) * 100.0).round() as u8
        } else {
            0
        };

        // Disks
        let disks = Disks::new_with_refreshed_list();
        let disk_metrics = disks.first().map(|d| {
            let total = d.total_space();
            let free = d.available_space();
            let used = total.saturating_sub(free);
            let pct = if total > 0 {
                ((used as f64 / total as f64) * 100.0).round() as u8
            } else {
                0
            };
            DiskMetrics {
                total,
                used,
                free,
                pct,
            }
        });

        // Top processes
        let mut procs: Vec<ProcessMetrics> = sys
            .processes()
            .iter()
            .map(|(pid, p)| ProcessMetrics {
                pid: pid.as_u32(),
                name: p.name().to_string_lossy().to_string(),
                cpu: p.cpu_usage(),
                memory: p.memory(),
            })
            .collect();
        procs.sort_by(|a, b| b.cpu.partial_cmp(&a.cpu).unwrap_or(std::cmp::Ordering::Equal));
        procs.truncate(8);

        let metrics = SystemMetrics {
            cpu: CpuMetrics {
                pct: cpu_pct,
                cores: cpus.len(),
            },
            memory: MemoryMetrics {
                total: total_mem,
                used: used_mem,
                free: free_mem,
                pct: mem_pct,
            },
            disk: disk_metrics,
            uptime_s: System::uptime(),
            processes: procs,
        };

        *last_time = Instant::now();
        *cached = Some(metrics.clone());

        metrics
    }
}

