use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;
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
    disks: Mutex<Disks>,
    snapshot: RwLock<SystemMetrics>,
}

impl Monitor {
    pub fn new() -> Self {
        let mut sys = System::new_with_specifics(
            RefreshKind::new()
                .with_cpu(CpuRefreshKind::everything())
                .with_memory(MemoryRefreshKind::everything()),
        );
        sys.refresh_cpu_all();
        sys.refresh_memory();
        let disks = Disks::new_with_refreshed_list();
        let initial = Self::compute_snapshot(&mut sys, &disks);

        Self {
            sys: Mutex::new(sys),
            disks: Mutex::new(disks),
            snapshot: RwLock::new(initial),
        }
    }

    fn compute_snapshot(sys: &mut System, disks: &Disks) -> SystemMetrics {
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

        SystemMetrics {
            cpu: CpuMetrics {
                pct: cpu_pct,
                cores: cpus.len().max(1),
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
        }
    }

    pub fn refresh_now(&self, include_processes: bool) {
        let mut sys = self.sys.lock().unwrap();
        sys.refresh_cpu_all();
        sys.refresh_memory();
        if include_processes {
            sys.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
        }
        let mut disks = self.disks.lock().unwrap();
        disks.refresh();
        let next = Self::compute_snapshot(&mut sys, &disks);
        drop(disks);
        drop(sys);
        if let Ok(mut snap) = self.snapshot.write() {
            *snap = next;
        }
    }

    pub fn start_background_sampler(self: &Arc<Self>) {
        let mon = self.clone();
        tokio::spawn(async move {
            let mut tick_count: u64 = 0;
            let mut interval = tokio::time::interval(Duration::from_secs(3));
            loop {
                interval.tick().await;
                let m = mon.clone();
                let include_procs = tick_count % 3 == 0;
                tick_count = tick_count.wrapping_add(1);
                let _ = tokio::task::spawn_blocking(move || {
                    m.refresh_now(include_procs);
                })
                .await;
            }
        });
    }

    /// Instantaneous (< 1 microsecond) lock-free/read-lock read of the cached telemetry snapshot.
    pub fn sample(&self) -> SystemMetrics {
        self.snapshot.read().unwrap().clone()
    }
}

