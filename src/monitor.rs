use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock, RwLock};
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
    pid_refresh_hits: Mutex<HashMap<u32, u8>>,
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
            pid_refresh_hits: Mutex::new(HashMap::new()),
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

        // Partition top 8 processes in O(P) so String allocations only happen for the top 8
        let mut raw_procs: Vec<(u32, f32, u64, &std::ffi::OsStr)> = sys
            .processes()
            .iter()
            .filter(|(_, p)| p.thread_kind().is_none())
            .map(|(pid, p)| (pid.as_u32(), p.cpu_usage(), p.memory(), p.name()))
            .collect();
        let cmp_desc = |a: &(u32, f32, u64, &std::ffi::OsStr), b: &(u32, f32, u64, &std::ffi::OsStr)| {
            b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal)
        };
        if raw_procs.len() > 8 {
            raw_procs.select_nth_unstable_by(7, cmp_desc);
            raw_procs.truncate(8);
        }
        raw_procs.sort_unstable_by(cmp_desc);

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
            if let Ok(mut hits) = self.pid_refresh_hits.lock() {
                let mut next_hits = HashMap::with_capacity(sys.processes().len());
                for (pid, p) in sys.processes() {
                    if p.thread_kind().is_some() {
                        continue;
                    }
                    let pid_u32 = pid.as_u32();
                    let prev = hits.get(&pid_u32).copied().unwrap_or(0);
                    next_hits.insert(pid_u32, prev.saturating_add(1).min(4));
                }
                *hits = next_hits;
            }
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

    /// Mark the monitor as actively observed by a client so the 1s sampler stays awake.
    pub fn touch_activity(&self) {
        self.last_queried_ms.store(epoch_ms(), Ordering::Relaxed);
    }

    /// Returns true once `Monitor` has observed at least one PID in `pids` across >= 2 process
    /// refresh cycles, ensuring `sysinfo` CPU percentages have a valid differential baseline
    /// matching the Overview view.
    pub fn has_settled_process_cpu(&self, pids: &[u32]) -> bool {
        if pids.is_empty() {
            return false;
        }
        let Ok(hits) = self.pid_refresh_hits.lock() else {
            return false;
        };
        pids.iter()
            .any(|pid| hits.get(pid).copied().unwrap_or(0) >= 2)
    }

    pub fn start_background_sampler(self: &Arc<Self>) {
        let mon = self.clone();
        tokio::spawn(async move {
            let mut tick_count: u64 = 0;
            let mut interval = tokio::time::interval(Duration::from_secs(1));
            loop {
                interval.tick().await;
                tick_count = tick_count.wrapping_add(1);

                // Demand-driven telemetry: sample active project network every 1s and host stats every 4s
                let idle_ms = epoch_ms().saturating_sub(mon.last_queried_ms.load(Ordering::Relaxed));
                let is_active = idle_ms < 18_000;

                if !is_active && tick_count % 60 != 0 {
                    continue;
                }

                let m = mon.clone();
                let should_refresh_host = tick_count % 4 == 0 || !is_active;
                let refresh_disks = tick_count % 32 == 0;
                let _ = tokio::task::spawn_blocking(move || {
                    if is_active {
                        crate::monitor::record_network_sample();
                        crate::monitor_net::sample_active_projects();
                    }
                    if should_refresh_host {
                        m.refresh_now(is_active, refresh_disks);
                    }
                })
                .await;

                if tick_count % 60 == 0 {
                    crate::trim_process_heap();
                }
            }
        });
    }

    /// Returns process tree CPU usage (percentage) and resident memory (bytes)
    /// aggregated for each requested root PID (root process + all descendant children).
    /// Filters out OS threads so thread pools never multiply CPU or memory metrics.
    /// Performs lock-read on in-memory sysinfo cache, zero OS syscalls or disk I/O.
    /// Build parent->children and pid->(cpu_usage, memory_bytes) indices for real OS processes,
    /// skipping Linux thread entries (`thread_kind().is_some()`) so thread pools never multiply
    /// CPU or resident memory across threads that share an address space.
    fn build_process_tree_index(sys: &sysinfo::System) -> (HashMap<u32, Vec<u32>>, HashMap<u32, (f32, u64)>) {
        let mut children_map: HashMap<u32, Vec<u32>> = HashMap::new();
        let mut metrics_map: HashMap<u32, (f32, u64)> = HashMap::new();

        for (pid, p) in sys.processes() {
            if p.thread_kind().is_some() {
                continue;
            }
            let pid_u32 = pid.as_u32();
            metrics_map.insert(pid_u32, (p.cpu_usage(), p.memory()));
            if let Some(parent) = p.parent() {
                children_map.entry(parent.as_u32()).or_default().push(pid_u32);
            }
        }

        (children_map, metrics_map)
    }

    fn sum_tree_metrics_from_index(
        children_map: &HashMap<u32, Vec<u32>>,
        metrics_map: &HashMap<u32, (f32, u64)>,
        root_pids: &[u32],
    ) -> HashMap<u32, (f32, u64)> {
        let root_set: Option<HashSet<u32>> = (root_pids.len() > 8)
            .then(|| root_pids.iter().copied().collect());
        let mut results = HashMap::with_capacity(root_pids.len());
        let mut visited = HashSet::with_capacity(16);
        let mut queue = VecDeque::with_capacity(16);
        for &root in root_pids {
            let mut total_cpu = 0.0f32;
            let mut total_mem = 0u64;
            visited.clear();
            queue.clear();

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
                        // Do not cross into another monitored root workload to avoid double-counting
                        let is_other_root = k != root
                            && match &root_set {
                                Some(set) => set.contains(&k),
                                None => root_pids.contains(&k),
                            };
                        if is_other_root {
                            continue;
                        }
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

    pub fn get_tree_metrics(&self, root_pids: &[u32]) -> HashMap<u32, (f32, u64)> {
        self.last_queried_ms.store(epoch_ms(), Ordering::Relaxed);
        if root_pids.is_empty() {
            return HashMap::new();
        }
        let sys = self.sys.lock().unwrap();
        let (children_map, metrics_map) = Self::build_process_tree_index(&sys);
        Self::sum_tree_metrics_from_index(&children_map, &metrics_map, root_pids)
    }

    /// Reads strict single-process panel metrics plus descendant-aggregated tree metrics for
    /// all managed root PIDs under a single `sys` lock. Skips process-table map allocation when
    /// no workload PIDs need inspection.
    pub fn get_panel_and_tree_metrics(
        &self,
        panel_pid: u32,
        root_pids: &[u32],
    ) -> ((f32, u64), HashMap<u32, (f32, u64)>) {
        self.last_queried_ms.store(epoch_ms(), Ordering::Relaxed);
        let sys = self.sys.lock().unwrap();
        let panel_metrics = sys
            .process(sysinfo::Pid::from_u32(panel_pid))
            .map(|p| (p.cpu_usage(), p.memory()))
            .unwrap_or((0.0, 0));
        if root_pids.is_empty() {
            return (panel_metrics, HashMap::new());
        }
        let (children_map, metrics_map) = Self::build_process_tree_index(&sys);
        let tree = Self::sum_tree_metrics_from_index(&children_map, &metrics_map, root_pids);
        (panel_metrics, tree)
    }

    /// Returns (cpu_usage, resident_memory_bytes) strictly for a single process
    /// without traversing into descendant or child processes.
    pub fn get_process_metrics(&self, pid: u32) -> (f32, u64) {
        self.last_queried_ms.store(epoch_ms(), Ordering::Relaxed);
        let sys = self.sys.lock().unwrap();
        let pid_obj = sysinfo::Pid::from_u32(pid);
        if let Some(p) = sys.process(pid_obj) {
            (p.cpu_usage(), p.memory())
        } else {
            (0.0, 0)
        }
    }

    /// Instantaneous (< 1 microsecond) lock-free/read-lock read of the cached telemetry snapshot.
    pub fn sample(&self) -> SystemMetrics {
        self.last_queried_ms.store(epoch_ms(), Ordering::Relaxed);
        self.snapshot.read().unwrap().clone()
    }
}

static DISK_USAGE_CACHE: RwLock<Option<HashMap<std::path::PathBuf, (u64, std::time::Instant)>>> =
    RwLock::new(None);

/// Invalidate any cached disk footprint entries covering `path` or its children.
pub fn invalidate_path_disk_cache(path: &std::path::Path) {
    if let Ok(mut guard) = DISK_USAGE_CACHE.write() {
        if let Some(map) = guard.as_mut() {
            map.retain(|k, _| !k.starts_with(path) && !path.starts_with(k));
        }
    }
}

/// Returns on-disk storage size in bytes for a directory or file.
/// Traverses filesystem safely without following symlinks to prevent loops.
/// Employs a non-blocking in-memory cache (120s TTL) with background refresh so HTTP threads never stall on I/O.
pub fn get_path_disk_size(path: &std::path::Path) -> u64 {
    let key = path.to_path_buf();

    // 1. Fast read-lock check (zero OS syscalls on cache hit!)
    if let Ok(guard) = DISK_USAGE_CACHE.read() {
        if let Some(map) = guard.as_ref() {
            if let Some(&(bytes, last_updated)) = map.get(&key) {
                let ttl = if bytes == 0 {
                    Duration::from_secs(10)
                } else {
                    Duration::from_secs(120)
                };
                if last_updated.elapsed() < ttl {
                    return bytes;
                }
                if bytes == 0 && !path.exists() {
                    drop(guard);
                    if let Ok(mut wguard) = DISK_USAGE_CACHE.write() {
                        if let Some(wmap) = wguard.as_mut() {
                            wmap.insert(key, (0, std::time::Instant::now()));
                        }
                    }
                    return 0;
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
        if let Ok(mut guard) = DISK_USAGE_CACHE.write() {
            let map = guard.get_or_insert_with(HashMap::new);
            map.insert(key, (0, std::time::Instant::now()));
        }
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


impl Monitor {
    /// Aggregate unique process-tree CPU (%), RSS memory (bytes), alive count, and alive tree PIDs
    /// across all `seed_pids` without double-counting shared descendants or OS threads.
    pub fn get_combined_tree_details(&self, seed_pids: &[u32]) -> (f32, u64, usize, Vec<u32>) {
        self.last_queried_ms.store(epoch_ms(), Ordering::Relaxed);
        if seed_pids.is_empty() {
            return (0.0, 0, 0, Vec::new());
        }
        let sys = self.sys.lock().unwrap();
        let (children_map, metrics_map) = Self::build_process_tree_index(&sys);

        let mut visited: HashSet<u32> = HashSet::new();
        let mut queue: VecDeque<u32> = VecDeque::new();
        for &root in seed_pids {
            if root > 0 && metrics_map.contains_key(&root) && visited.insert(root) {
                queue.push_back(root);
            }
        }

        let mut total_cpu = 0.0f32;
        let mut total_mem = 0u64;
        let mut alive_count = 0usize;
        let mut tree_pids = Vec::new();
        while let Some(curr) = queue.pop_front() {
            if let Some(&(cpu, mem)) = metrics_map.get(&curr) {
                total_cpu += cpu;
                total_mem = total_mem.saturating_add(mem);
                alive_count += 1;
                tree_pids.push(curr);
            }
            if let Some(kids) = children_map.get(&curr) {
                for &k in kids {
                    if visited.insert(k) {
                        queue.push_back(k);
                    }
                }
            }
        }
        (total_cpu, total_mem, alive_count, tree_pids)
    }
}

const NET_HISTORY_LIMIT: usize = 60;

#[derive(Clone, Serialize, Deserialize, Default, Debug)]
#[serde(rename_all = "camelCase")]
pub struct NetworkSample {
    pub ts: i64,
    pub inbound_bps: u64,
    pub outbound_bps: u64,
}

#[derive(Clone, Serialize, Deserialize, Default, Debug)]
#[serde(rename_all = "camelCase")]
pub struct NetworkMetrics {
    pub inbound_bps: u64,
    pub outbound_bps: u64,
    pub total_rx_bytes: u64,
    pub total_tx_bytes: u64,
    pub interface_count: usize,
    pub history: Vec<NetworkSample>,
}

struct NetworkTracker {
    networks: sysinfo::Networks,
    last_tick: std::time::Instant,
    total_rx_bytes: u64,
    total_tx_bytes: u64,
    interface_count: usize,
    history: VecDeque<NetworkSample>,
}

static NETWORK_TRACKER: OnceLock<Mutex<NetworkTracker>> = OnceLock::new();

fn is_loopback_iface(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower == "lo" || lower.starts_with("lo") && lower[2..].chars().all(|c| c.is_ascii_digit())
        || lower.contains("loopback")
}

fn is_virtual_bridge_iface(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower == "docker0"
        || lower.starts_with("docker")
        || lower.starts_with("veth")
        || lower.starts_with("br-")
        || lower.starts_with("virbr")
        || lower.starts_with("cni")
        || lower.starts_with("flannel")
        || lower.starts_with("cali")
        || lower.contains("vethernet")
}

#[derive(Default)]
struct NetBucket {
    rx_delta: u64,
    tx_delta: u64,
    rx_total: u64,
    tx_total: u64,
    count: usize,
}

impl NetBucket {
    fn add(&mut self, rx_d: u64, tx_d: u64, rx_t: u64, tx_t: u64) {
        self.rx_delta = self.rx_delta.saturating_add(rx_d);
        self.tx_delta = self.tx_delta.saturating_add(tx_d);
        self.rx_total = self.rx_total.saturating_add(rx_t);
        self.tx_total = self.tx_total.saturating_add(tx_t);
        self.count += 1;
    }

    fn into_tuple(self) -> (u64, u64, u64, u64, usize) {
        (self.rx_delta, self.tx_delta, self.rx_total, self.tx_total, self.count)
    }
}

fn aggregate_network_stats(networks: &sysinfo::Networks) -> (u64, u64, u64, u64, usize) {
    let mut phys = NetBucket::default();
    let mut non_lo = NetBucket::default();
    let mut all = NetBucket::default();

    for (name, data) in networks.iter() {
        let rx_d = data.received();
        let tx_d = data.transmitted();
        let rx_t = data.total_received();
        let tx_t = data.total_transmitted();

        all.add(rx_d, tx_d, rx_t, tx_t);
        if !is_loopback_iface(name) {
            non_lo.add(rx_d, tx_d, rx_t, tx_t);
            if !is_virtual_bridge_iface(name) {
                phys.add(rx_d, tx_d, rx_t, tx_t);
            }
        }
    }

    if phys.count > 0 {
        phys.into_tuple()
    } else if non_lo.count > 0 {
        non_lo.into_tuple()
    } else {
        all.into_tuple()
    }
}

fn now_unix_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

fn get_tracker() -> &'static Mutex<NetworkTracker> {
    NETWORK_TRACKER.get_or_init(|| {
        let networks = sysinfo::Networks::new_with_refreshed_list();
        let (_, _, rx_total, tx_total, iface_count) = aggregate_network_stats(&networks);
        let mut history = VecDeque::with_capacity(NET_HISTORY_LIMIT);
        history.push_back(NetworkSample {
            ts: now_unix_ms(),
            inbound_bps: 0,
            outbound_bps: 0,
        });
        Mutex::new(NetworkTracker {
            networks,
            last_tick: std::time::Instant::now(),
            total_rx_bytes: rx_total,
            total_tx_bytes: tx_total,
            interface_count: iface_count,
            history,
        })
    })
}

fn sample_tracker(tracker: &mut NetworkTracker) {
    let elapsed = tracker.last_tick.elapsed();
    if elapsed < Duration::from_millis(200) {
        return;
    }

    tracker.networks.refresh();
    let dt = elapsed.as_secs_f64().max(0.2);
    let (rx_d, tx_d, rx_total, tx_total, iface_count) = aggregate_network_stats(&tracker.networks);

    let inbound_bps = ((rx_d as f64) / dt).round() as u64;
    let outbound_bps = ((tx_d as f64) / dt).round() as u64;

    tracker.last_tick = std::time::Instant::now();
    tracker.total_rx_bytes = rx_total;
    tracker.total_tx_bytes = tx_total;
    tracker.interface_count = iface_count;

    if tracker.history.len() >= NET_HISTORY_LIMIT {
        tracker.history.pop_front();
    }
    tracker.history.push_back(NetworkSample {
        ts: now_unix_ms(),
        inbound_bps,
        outbound_bps,
    });
}

/// Record a fresh network interface I/O sample into the rolling telemetry ring buffer.
pub fn record_network_sample() {
    if let Ok(mut guard) = get_tracker().lock() {
        sample_tracker(&mut guard);
    }
}

/// Return current host network inbound/outbound rates plus up to `NET_HISTORY_LIMIT` rolling samples.
pub fn get_network_metrics() -> NetworkMetrics {
    let Ok(mut guard) = get_tracker().lock() else {
        return NetworkMetrics::default();
    };
    if guard.last_tick.elapsed() >= Duration::from_secs(2) {
        sample_tracker(&mut guard);
    }
    let latest = guard.history.back().cloned().unwrap_or_default();
    NetworkMetrics {
        inbound_bps: latest.inbound_bps,
        outbound_bps: latest.outbound_bps,
        total_rx_bytes: guard.total_rx_bytes,
        total_tx_bytes: guard.total_tx_bytes,
        interface_count: guard.interface_count,
        history: guard.history.iter().cloned().collect(),
    }
}

#[cfg(test)]
mod network_tests {
    use super::*;

    #[test]
    fn test_loopback_detection_and_metrics_shape() {
        assert!(is_loopback_iface("lo"));
        assert!(is_loopback_iface("lo0"));
        assert!(is_loopback_iface("Loopback Pseudo-Interface 1"));
        assert!(!is_loopback_iface("eth0"));
        assert!(!is_loopback_iface("Wi-Fi"));
        assert!(!is_loopback_iface("enp3s0"));
        assert!(is_virtual_bridge_iface("docker0"));
        assert!(is_virtual_bridge_iface("veth8a91f2"));
        assert!(is_virtual_bridge_iface("br-0a1b2c"));
        assert!(!is_virtual_bridge_iface("eth0"));
        assert!(!is_virtual_bridge_iface("enp3s0"));

        let metrics = get_network_metrics();
        assert!(!metrics.history.is_empty());
        assert!(metrics.history.len() <= NET_HISTORY_LIMIT);
        let serialized = serde_json::to_value(&metrics).expect("serialize NetworkMetrics");
        assert!(serialized.get("inboundBps").is_some());
        assert!(serialized.get("outboundBps").is_some());
        assert!(serialized.get("totalRxBytes").is_some());
        assert!(serialized.get("totalTxBytes").is_some());
        assert!(serialized.get("interfaceCount").is_some());
        assert!(serialized.get("history").is_some());
    }

    #[test]
    fn test_monitor_cpu_measures_active_self_process() {
        let m = Monitor::new();
        m.refresh_now(true, false);
        let pid = std::process::id();
        // Spin briefly on a worker thread so the current process accumulates measurable CPU time.
        let end = std::time::Instant::now() + std::time::Duration::from_millis(350);
        let mut acc: u64 = 0;
        while std::time::Instant::now() < end {
            acc = acc.wrapping_add(1);
            std::hint::black_box(acc);
        }
        let _threads: Vec<_> = (0..4)
            .map(|_| {
                std::thread::spawn(|| {
                    std::thread::sleep(std::time::Duration::from_millis(120));
                })
            })
            .collect();
        m.refresh_now(true, false);
        let (raw_cpu, mem, alive, _) = m.get_combined_tree_details(&[pid]);
        let tree_map = m.get_tree_metrics(&[pid]);
        let (single_cpu, single_mem) = tree_map.get(&pid).copied().unwrap_or((0.0, 0));
        eprintln!(
            "DIAGNOSTIC CPU TEST -> pid={pid}, alive={alive}, mem={mem}, single_mem={single_mem}, raw_cpu={raw_cpu}, cores={}",
            m.sample().cpu.cores
        );
        assert!(m.has_settled_process_cpu(&[pid]), "Expected process CPU baseline to be settled after 2 refreshes");
        assert!(alive >= 1);
        assert_eq!(mem, single_mem, "Combined tree memory must match get_tree_metrics memory");
        assert!((raw_cpu - single_cpu).abs() < 1e-3, "Combined tree CPU must match get_tree_metrics CPU");
        assert!(raw_cpu > 0.0, "Expected non-zero raw_cpu, got {raw_cpu}");
    }

    #[test]
    fn test_get_tree_metrics_empty_and_top_processes_sorted() {
        let m = Monitor::new();
        assert!(m.get_tree_metrics(&[]).is_empty());
        let snap = m.sample();
        assert!(snap.processes.len() <= 8);
        for pair in snap.processes.windows(2) {
            assert!(pair[0].cpu >= pair[1].cpu);
        }
    }
}
