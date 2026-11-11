use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;
use sysinfo::{
    CpuRefreshKind, Disks, MemoryRefreshKind, ProcessRefreshKind, RefreshKind, System,
};

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
            .filter(|(_, p)| p.thread_kind().is_none())
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
            let p_kind = ProcessRefreshKind::new()
                .with_cpu()
                .with_memory();
            sys.refresh_processes_specifics(sysinfo::ProcessesToUpdate::All, true, p_kind);
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
                // Refresh processes every 6s (every 2nd tick) for responsive metrics with near-zero overhead
                let include_procs = tick_count % 2 == 0;
                tick_count = tick_count.wrapping_add(1);
                let _ = tokio::task::spawn_blocking(move || {
                    m.refresh_now(include_procs);
                })
                .await;
                if tick_count % 20 == 0 {
                    #[cfg(target_os = "linux")]
                    unsafe {
                        extern "C" {
                            fn malloc_trim(pad: libc::size_t) -> libc::c_int;
                        }
                        malloc_trim(0);
                    }
                }
            }
        });
    }

    /// Returns process tree CPU usage (percentage) and resident memory (bytes)
    /// aggregated for each requested root PID (root process + all descendant children).
    /// Performs lock-read on in-memory sysinfo cache, zero OS syscalls or disk I/O.
    pub fn get_tree_metrics(&self, root_pids: &[u32]) -> HashMap<u32, (f32, u64)> {
        let sys = self.sys.lock().unwrap();
        let mut children_map: HashMap<u32, Vec<u32>> = HashMap::new();
        // Stores (cpu_usage, resident_memory_bytes, is_thread)
        let mut metrics_map: HashMap<u32, (f32, u64, bool)> = HashMap::new();

        for (pid, p) in sys.processes() {
            let pid_u32 = pid.as_u32();
            let is_thread = p.thread_kind().is_some();
            metrics_map.insert(pid_u32, (p.cpu_usage(), p.memory(), is_thread));
            if let Some(parent) = p.parent() {
                children_map.entry(parent.as_u32()).or_default().push(pid_u32);
            }
        }

        let mut results = HashMap::with_capacity(root_pids.len());
        for &root in root_pids {
            let mut total_cpu = 0.0f32;
            let mut total_mem = 0u64;
            let mut visited = HashSet::new();
            let mut queue = VecDeque::new();

            if metrics_map.contains_key(&root) {
                queue.push_back(root);
                visited.insert(root);
            }

            while let Some(curr) = queue.pop_front() {
                if let Some(&(cpu, mem, is_thread)) = metrics_map.get(&curr) {
                    total_cpu += cpu;
                    // In Linux, threads of a process share the same memory address space.
                    // Counting memory for every thread entry multiplies the true process RSS by thread count!
                    // Only count memory for real processes (or the root process itself).
                    if !is_thread || curr == root {
                        total_mem = total_mem.saturating_add(mem);
                    }
                }
                if let Some(kids) = children_map.get(&curr) {
                    for &k in kids {
                        if visited.insert(k) {
                            queue.push_back(k);
                        }
                    }
                }
            }

            results.insert(root, (total_cpu, total_mem));
        }

        results
    }

    /// Instantaneous (< 1 microsecond) lock-free/read-lock read of the cached telemetry snapshot.
    pub fn sample(&self) -> SystemMetrics {
        self.snapshot.read().unwrap().clone()
    }
}

