use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use sysinfo::{
    CpuRefreshKind, Disks, MemoryRefreshKind, ProcessRefreshKind, RefreshKind, System,
};

fn epoch_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

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
    last_queried_ms: AtomicU64,
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
            last_queried_ms: AtomicU64::new(epoch_ms()),
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

        // Sort lightweight references first so String allocations only happen for the top 8 processes
        let mut raw_procs: Vec<(u32, f32, u64, &std::ffi::OsStr)> = sys
            .processes()
            .iter()
            .filter(|(_, p)| p.thread_kind().is_none())
            .map(|(pid, p)| (pid.as_u32(), p.cpu_usage(), p.memory(), p.name()))
            .collect();
        raw_procs.sort_unstable_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        raw_procs.truncate(8);

        let procs: Vec<ProcessMetrics> = raw_procs
            .into_iter()
            .map(|(pid, cpu, memory, name)| ProcessMetrics {
                pid,
                name: name.to_string_lossy().to_string(),
                cpu,
                memory,
            })
            .collect();

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

    pub fn refresh_now(&self, include_processes: bool, refresh_disks: bool) {
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
        if refresh_disks {
            disks.refresh();
        }
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
            let mut interval = tokio::time::interval(Duration::from_secs(4));
            loop {
                interval.tick().await;
                tick_count = tick_count.wrapping_add(1);

                // Demand-driven telemetry: only scan OS process table when a dashboard client was active in the last 18s
                let idle_ms = epoch_ms().saturating_sub(mon.last_queried_ms.load(Ordering::Relaxed));
                let is_active = idle_ms < 18_000;

                if !is_active && tick_count % 15 != 0 {
                    continue;
                }

                let m = mon.clone();
                let refresh_disks = tick_count % 8 == 0;
                let _ = tokio::task::spawn_blocking(move || {
                    m.refresh_now(is_active, refresh_disks);
                })
                .await;

                if tick_count % 15 == 0 {
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
    /// Filters out OS threads so thread pools never multiply CPU or memory metrics.
    /// Performs lock-read on in-memory sysinfo cache, zero OS syscalls or disk I/O.
    pub fn get_tree_metrics(&self, root_pids: &[u32]) -> HashMap<u32, (f32, u64)> {
        self.last_queried_ms.store(epoch_ms(), Ordering::Relaxed);
        let sys = self.sys.lock().unwrap();
        let mut children_map: HashMap<u32, Vec<u32>> = HashMap::new();
        // Stores (cpu_usage, resident_memory_bytes) for true OS processes
        let mut metrics_map: HashMap<u32, (f32, u64)> = HashMap::new();

        for (pid, p) in sys.processes() {
            let pid_u32 = pid.as_u32();
            // On Linux /proc, thread entries have `thread_kind().is_some()`.
            // Threads share the same address space and their CPU times are already reported
            // in the thread group leader's `/proc/[pid]/stat`.
            // Skipping threads prevents multiplying memory and CPU across thread pools!
            if p.thread_kind().is_some() {
                continue;
            }
            metrics_map.insert(pid_u32, (p.cpu_usage(), p.memory()));
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
                if let Some(&(cpu, mem)) = metrics_map.get(&curr) {
                    total_cpu += cpu;
                    total_mem = total_mem.saturating_add(mem);
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
        self.last_queried_ms.store(epoch_ms(), Ordering::Relaxed);
        self.snapshot.read().unwrap().clone()
    }
}

static DISK_USAGE_CACHE: RwLock<Option<HashMap<std::path::PathBuf, (u64, std::time::Instant)>>> =
    RwLock::new(None);

/// Returns on-disk storage size in bytes for a directory or file.
/// Traverses filesystem safely without following symlinks to prevent loops.
/// Employs a non-blocking in-memory cache (120s TTL) with background refresh so HTTP threads never stall on I/O.
pub fn get_path_disk_size(path: &std::path::Path) -> u64 {
    let key = path.to_path_buf();

    // 1. Fast read-lock check (zero OS syscalls on cache hit!)
    if let Ok(guard) = DISK_USAGE_CACHE.read() {
        if let Some(map) = guard.as_ref() {
            if let Some(&(bytes, last_updated)) = map.get(&key) {
                if last_updated.elapsed() < Duration::from_secs(120) {
                    return bytes;
                }
                // Stale cache hit: mark refreshed timestamp and recompute asynchronously in background
                drop(guard);
                if let Ok(mut wguard) = DISK_USAGE_CACHE.write() {
                    if let Some(wmap) = wguard.as_mut() {
                        wmap.insert(key.clone(), (bytes, std::time::Instant::now()));
                    }
                }
                let bg_key = key;
                tokio::task::spawn_blocking(move || {
                    let fresh_bytes = compute_disk_size(&bg_key);
                    if let Ok(mut wguard) = DISK_USAGE_CACHE.write() {
                        let map = wguard.get_or_insert_with(HashMap::new);
                        map.insert(bg_key, (fresh_bytes, std::time::Instant::now()));
                    }
                });
                return bytes;
            }
        }
    }

    if !path.exists() {
        return 0;
    }

    // Cold cache miss on first run: compute and store
    let bytes = compute_disk_size(&key);
    if let Ok(mut guard) = DISK_USAGE_CACHE.write() {
        let map = guard.get_or_insert_with(HashMap::new);
        map.insert(key, (bytes, std::time::Instant::now()));
    }

    bytes
}

fn compute_disk_size(path: &std::path::Path) -> u64 {
    let mut total = 0u64;
    if let Ok(meta) = std::fs::symlink_metadata(path) {
        if meta.is_file() {
            return meta.len();
        }
        if meta.is_dir() && !meta.file_type().is_symlink() {
            if let Ok(entries) = std::fs::read_dir(path) {
                for entry in entries.flatten() {
                    let child = entry.path();
                    total = total.saturating_add(compute_disk_size(&child));
                }
            }
        }
    }
    total
}

