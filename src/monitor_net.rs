use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use crate::monitor::{NetworkMetrics, NetworkSample};

pub const APP_NET_HISTORY_LIMIT: usize = 60;
const ACTIVE_PROJECT_TTL: Duration = Duration::from_secs(90);
const MIN_RESAMPLE_GAP: Duration = Duration::from_millis(850);

fn now_unix_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[derive(Clone, Copy, Hash, PartialEq, Eq, Debug)]
struct SocketConnKey {
    family: u8,
    local_addr: [u8; 16],
    local_port: u32,
    remote_addr: [u8; 16],
    remote_port: u32,
}

#[derive(Default)]
struct PidNetSnapshot {
    /// Whether kernel TCP socket byte counters could be sampled without access denial.
    socket_stats_ok: bool,
    /// Active socket `(pid, key, bytes_in, bytes_out)` tuples owned by requested PIDs.
    connections: Vec<(u32, SocketConnKey, u64, u64)>,
    /// Count of established TCP connections per PID.
    estab_by_pid: HashMap<u32, usize>,
    /// Cumulative OS process I/O `(read_bytes, write_bytes)` per PID.
    io_by_pid: HashMap<u32, (u64, u64)>,
    /// System-wide total CPU ticks across all logical cores (kernel+idle+user).
    sys_cpu_total: Option<u64>,
    /// Cumulative per-PID CPU time `(kernel + user)` in matching OS ticks.
    cpu_time_by_pid: HashMap<u32, u64>,
}

struct ProjectNetTracker {
    pids: Vec<u32>,
    running: bool,
    last_queried: Instant,
    last_sample_at: Instant,
    initialized: bool,
    seen_pids: HashSet<u32>,
    total_rx_bytes: u64,
    total_tx_bytes: u64,
    active_sockets: usize,
    conn_last: HashMap<(u32, SocketConnKey), (u64, u64)>,
    pid_io_last: HashMap<u32, (u64, u64)>,
    sys_cpu_last: Option<u64>,
    pid_cpu_last: HashMap<u32, u64>,
    cum_sys_cpu: u64,
    cum_proc_cpu: u64,
    cpu_window: VecDeque<(Instant, u64, u64)>,
    last_cpu_pct: Option<f64>,
    history: VecDeque<NetworkSample>,
}

impl ProjectNetTracker {
    fn new(pids: Vec<u32>) -> Self {
        let now = Instant::now();
        Self {
            pids,
            running: true,
            last_queried: now,
            last_sample_at: now,
            initialized: false,
            seen_pids: HashSet::new(),
            total_rx_bytes: 0,
            total_tx_bytes: 0,
            active_sockets: 0,
            conn_last: HashMap::new(),
            pid_io_last: HashMap::new(),
            sys_cpu_last: None,
            pid_cpu_last: HashMap::new(),
            cum_sys_cpu: 0,
            cum_proc_cpu: 0,
            cpu_window: VecDeque::with_capacity(8),
            last_cpu_pct: None,
            history: VecDeque::with_capacity(APP_NET_HISTORY_LIMIT),
        }
    }

    fn reset_offline(&mut self) {
        self.pids.clear();
        self.running = false;
        self.initialized = false;
        self.seen_pids.clear();
        self.total_rx_bytes = 0;
        self.total_tx_bytes = 0;
        self.active_sockets = 0;
        self.conn_last.clear();
        self.pid_io_last.clear();
        self.sys_cpu_last = None;
        self.pid_cpu_last.clear();
        self.cum_sys_cpu = 0;
        self.cum_proc_cpu = 0;
        self.cpu_window.clear();
        self.last_cpu_pct = None;
        self.history.clear();
    }

    fn apply_snapshot(&mut self, snap: &PidNetSnapshot, now: Instant, ts_ms: i64) {
        let pid_set: HashSet<u32> = self.pids.iter().copied().collect();
        let elapsed_secs = now
            .duration_since(self.last_sample_at)
            .as_secs_f64()
            .max(0.25);

        // Count active established TCP sockets strictly for this project's PIDs.
        let estab_count: usize = pid_set
            .iter()
            .map(|pid| snap.estab_by_pid.get(pid).copied().unwrap_or(0))
            .sum();
        self.active_sockets = estab_count;

        let mut next_conn_last = HashMap::new();
        let mut sock_delta_rx: u64 = 0;
        let mut sock_delta_tx: u64 = 0;
        let mut matched_socket_stats = 0usize;

        for (pid, key, bytes_in, bytes_out) in &snap.connections {
            if !pid_set.contains(pid) {
                continue;
            }
            matched_socket_stats += 1;
            let ck = (*pid, *key);
            if let Some(&(prev_in, prev_out)) = self.conn_last.get(&ck) {
                sock_delta_rx = sock_delta_rx.saturating_add(bytes_in.saturating_sub(prev_in));
                sock_delta_tx = sock_delta_tx.saturating_add(bytes_out.saturating_sub(prev_out));
            } else if self.initialized && self.seen_pids.contains(pid) {
                // Brand-new socket opened on an already-tracked PID during this interval.
                sock_delta_rx = sock_delta_rx.saturating_add(*bytes_in);
                sock_delta_tx = sock_delta_tx.saturating_add(*bytes_out);
            }
            next_conn_last.insert(ck, (*bytes_in, *bytes_out));
        }

        let mut next_io_last = HashMap::new();
        let mut io_delta_rx: u64 = 0;
        let mut io_delta_tx: u64 = 0;

        for &pid in &pid_set {
            if let Some(&(cur_read, cur_write)) = snap.io_by_pid.get(&pid) {
                if self.initialized {
                    if let Some(&(prev_read, prev_write)) = self.pid_io_last.get(&pid) {
                        io_delta_rx = io_delta_rx.saturating_add(cur_read.saturating_sub(prev_read));
                        io_delta_tx =
                            io_delta_tx.saturating_add(cur_write.saturating_sub(prev_write));
                    }
                }
                next_io_last.insert(pid, (cur_read, cur_write));
            }
        }

        // Prefer pure kernel TCP socket byte counters when permitted and sockets exist;
        // fall back cleanly to isolated per-PID OS I/O counters when socket EStats/Netlink
        // are denied (e.g. non-admin Windows) or UDP/pipe traffic has no TCP stats.
        let use_socket_deltas = self.initialized
            && snap.socket_stats_ok
            && (matched_socket_stats > 0 || estab_count > 0);

        let (delta_rx, delta_tx) = if !self.initialized {
            (0, 0)
        } else if use_socket_deltas {
            (sock_delta_rx, sock_delta_tx)
        } else {
            (io_delta_rx, io_delta_tx)
        };

        let inbound_bps = if self.initialized {
            ((delta_rx as f64) / elapsed_secs).round() as u64
        } else {
            0
        };
        let outbound_bps = if self.initialized {
            ((delta_tx as f64) / elapsed_secs).round() as u64
        } else {
            0
        };

        let mut next_cpu_last = HashMap::new();
        let mut proc_cpu_delta: u64 = 0;
        for &pid in &pid_set {
            if let Some(&cur_cpu) = snap.cpu_time_by_pid.get(&pid) {
                if self.initialized {
                    if let Some(&prev_cpu) = self.pid_cpu_last.get(&pid) {
                        proc_cpu_delta =
                            proc_cpu_delta.saturating_add(cur_cpu.saturating_sub(prev_cpu));
                    }
                }
                next_cpu_last.insert(pid, cur_cpu);
            }
        }
        if !self.initialized {
            if snap.sys_cpu_total.is_some() {
                self.cpu_window.clear();
                self.cpu_window.push_back((now, 0, 0));
            }
        } else if let (Some(cur_sys), Some(prev_sys)) = (snap.sys_cpu_total, self.sys_cpu_last) {
            let sys_delta = cur_sys.saturating_sub(prev_sys);
            if sys_delta > 0 {
                self.cum_sys_cpu = self.cum_sys_cpu.saturating_add(sys_delta);
                self.cum_proc_cpu = self.cum_proc_cpu.saturating_add(proc_cpu_delta);
                self.cpu_window
                    .push_back((now, self.cum_sys_cpu, self.cum_proc_cpu));

                // Average CPU across a rolling ~4s window to eliminate single-jiffy 1s quantization jitter.
                const CPU_SMOOTH_WINDOW: Duration = Duration::from_secs(4);
                while self.cpu_window.len() > 2
                    && now.duration_since(self.cpu_window[1].0) >= CPU_SMOOTH_WINDOW
                {
                    self.cpu_window.pop_front();
                }

                if let (Some(&(_, old_sys, old_proc)), Some(&(_, new_sys, new_proc))) =
                    (self.cpu_window.front(), self.cpu_window.back())
                {
                    let win_sys = new_sys.saturating_sub(old_sys);
                    let win_proc = new_proc.saturating_sub(old_proc);
                    if win_sys > 0 {
                        let raw_pct = ((win_proc as f64) / (win_sys as f64)) * 100.0;
                        let smoothed = match self.last_cpu_pct {
                            Some(prev) => prev * 0.3 + raw_pct * 0.7,
                            None => raw_pct,
                        };
                        self.last_cpu_pct = Some(smoothed.clamp(0.0, 100.0));
                    }
                }
            }
        }

        self.conn_last = next_conn_last;
        self.pid_io_last = next_io_last;
        self.sys_cpu_last = snap.sys_cpu_total;
        self.pid_cpu_last = next_cpu_last;
        self.seen_pids = pid_set;
        self.last_sample_at = now;
        self.initialized = true;

        self.total_rx_bytes = self.total_rx_bytes.saturating_add(delta_rx);
        self.total_tx_bytes = self.total_tx_bytes.saturating_add(delta_tx);

        if self.history.len() >= APP_NET_HISTORY_LIMIT {
            self.history.pop_front();
        }
        self.history.push_back(NetworkSample {
            ts: ts_ms,
            inbound_bps,
            outbound_bps,
        });
    }

    fn to_metrics(&self) -> NetworkMetrics {
        if !self.running {
            return NetworkMetrics::default();
        }
        let latest = self.history.back().cloned().unwrap_or_default();
        NetworkMetrics {
            inbound_bps: latest.inbound_bps,
            outbound_bps: latest.outbound_bps,
            total_rx_bytes: self.total_rx_bytes,
            total_tx_bytes: self.total_tx_bytes,
            interface_count: self.active_sockets,
            history: self.history.iter().cloned().collect(),
        }
    }
}

static APP_NET_REGISTRY: OnceLock<Mutex<HashMap<i64, ProjectNetTracker>>> = OnceLock::new();

fn registry() -> &'static Mutex<HashMap<i64, ProjectNetTracker>> {
    APP_NET_REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Normalize and deduplicate PID list before probing OS telemetry.
fn normalize_pids(pids: &[u32]) -> Vec<u32> {
    let mut seen = HashSet::new();
    let mut out = Vec::with_capacity(pids.len());
    for &pid in pids {
        if pid > 0 && seen.insert(pid) {
            out.push(pid);
        }
    }
    out
}

/// Sample all actively viewed running projects into their isolated per-project buffers.
/// Safe to invoke every 1 second from the background monitor task.
pub fn sample_active_projects() {
    let targets: Vec<(i64, Vec<u32>)> = {
        let Ok(mut map) = registry().lock() else {
            return;
        };
        map.retain(|_, tr| tr.running && tr.last_queried.elapsed() <= ACTIVE_PROJECT_TTL);
        map.iter()
            .filter(|(_, tr)| {
                tr.running && !tr.pids.is_empty() && tr.last_sample_at.elapsed() >= MIN_RESAMPLE_GAP
            })
            .map(|(&id, tr)| (id, tr.pids.clone()))
            .collect()
    };

    if targets.is_empty() {
        return;
    }

    let mut all_pids = Vec::new();
    let mut pid_seen = HashSet::new();
    for (_, pids) in &targets {
        for &pid in pids {
            if pid_seen.insert(pid) {
                all_pids.push(pid);
            }
        }
    }

    let snap = probe_pids_telemetry(&all_pids);
    let now = Instant::now();
    let ts_ms = now_unix_ms();

    let Ok(mut map) = registry().lock() else {
        return;
    };
    for (id, _) in targets {
        if let Some(tr) = map.get_mut(&id) {
            if tr.running && !tr.pids.is_empty() && tr.last_sample_at.elapsed() >= MIN_RESAMPLE_GAP
            {
                tr.apply_snapshot(&snap, now, ts_ms);
            }
        }
    }
}

/// Return isolated genuine `(NetworkMetrics, Option<host_cpu_percent>)` for a single project.
/// Offline projects immediately clear active streaming state and return zeroed metrics.
pub fn get_project_live_telemetry(
    project_id: i64,
    running: bool,
    pids: &[u32],
) -> (NetworkMetrics, Option<f64>) {
    let clean_pids = normalize_pids(pids);
    if !running || clean_pids.is_empty() {
        if let Ok(mut map) = registry().lock() {
            if let Some(tr) = map.get_mut(&project_id) {
                tr.reset_offline();
            }
        }
        return (NetworkMetrics::default(), Some(0.0));
    }

    let needs_immediate_sample = {
        let Ok(mut map) = registry().lock() else {
            return (NetworkMetrics::default(), None);
        };
        let tr = map
            .entry(project_id)
            .or_insert_with(|| ProjectNetTracker::new(clean_pids.clone()));
        tr.pids = clean_pids.clone();
        tr.running = true;
        tr.last_queried = Instant::now();
        !tr.initialized
            || tr.last_sample_at.elapsed() >= Duration::from_millis(1600)
            || (tr.last_cpu_pct.is_none() && tr.last_sample_at.elapsed() >= MIN_RESAMPLE_GAP)
    };

    if needs_immediate_sample {
        let snap = probe_pids_telemetry(&clean_pids);
        let now = Instant::now();
        let ts_ms = now_unix_ms();
        let Ok(mut map) = registry().lock() else {
            return (NetworkMetrics::default(), None);
        };
        if let Some(tr) = map.get_mut(&project_id) {
            if tr.running && !tr.pids.is_empty() {
                if !tr.initialized || tr.last_sample_at.elapsed() >= MIN_RESAMPLE_GAP {
                    tr.apply_snapshot(&snap, now, ts_ms);
                }
                return (tr.to_metrics(), tr.last_cpu_pct);
            }
        }
        return (NetworkMetrics::default(), None);
    }

    let Ok(map) = registry().lock() else {
        return (NetworkMetrics::default(), None);
    };
    map.get(&project_id)
        .map(|tr| (tr.to_metrics(), tr.last_cpu_pct))
        .unwrap_or((NetworkMetrics::default(), None))
}

fn probe_pids_telemetry(pids: &[u32]) -> PidNetSnapshot {
    let pid_set: HashSet<u32> = pids.iter().copied().collect();
    if pid_set.is_empty() {
        return PidNetSnapshot::default();
    }
    platform::probe_pids_telemetry_impl(&pid_set)
}

#[cfg(windows)]
mod platform {
    use super::{PidNetSnapshot, SocketConnKey};
    use std::collections::HashSet;
    use std::ffi::c_void;
    use std::mem::size_of;
    use std::ptr;

    const AF_INET: u32 = 2;
    const AF_INET6: u32 = 23;
    const TCP_TABLE_OWNER_PID_ALL: u32 = 5;
    const TCP_CONNECTION_ESTATS_DATA: u32 = 1;
    const NO_ERROR: u32 = 0;
    const ERROR_ACCESS_DENIED: u32 = 5;
    const ERROR_INSUFFICIENT_BUFFER: u32 = 122;
    const MIB_TCP_STATE_ESTAB: u32 = 5;
    const MIB_TCP_STATE_LAST_ACK: u32 = 10;
    const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct MibTcpRowOwnerPid {
        dw_state: u32,
        dw_local_addr: u32,
        dw_local_port: u32,
        dw_remote_addr: u32,
        dw_remote_port: u32,
        dw_owning_pid: u32,
    }

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct MibTcpRow {
        state: u32,
        local_addr: u32,
        local_port: u32,
        remote_addr: u32,
        remote_port: u32,
    }

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct MibTcp6RowOwnerPid {
        uc_local_addr: [u8; 16],
        dw_local_scope_id: u32,
        dw_local_port: u32,
        uc_remote_addr: [u8; 16],
        dw_remote_scope_id: u32,
        dw_remote_port: u32,
        dw_state: u32,
        dw_owning_pid: u32,
    }

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct MibTcp6Row {
        state: u32,
        local_addr: [u8; 16],
        local_scope_id: u32,
        local_port: u32,
        remote_addr: [u8; 16],
        remote_scope_id: u32,
        remote_port: u32,
    }

    #[repr(C)]
    struct TcpEstatsDataRwV0 {
        enable_collection: u8,
    }

    #[repr(C)]
    #[derive(Default)]
    struct TcpEstatsDataRodV0 {
        data_bytes_out: u64,
        data_segs_out: u64,
        data_bytes_in: u64,
        data_segs_in: u64,
        segs_out: u64,
        segs_in: u64,
        soft_errors: u32,
        soft_error_reason: u32,
        snd_una: u32,
        snd_nxt: u32,
        snd_max: u32,
        thru_bytes_acked: u64,
        rcv_nxt: u32,
        thru_bytes_received: u64,
    }

    #[repr(C)]
    #[derive(Default)]
    struct IoCounters {
        read_operation_count: u64,
        write_operation_count: u64,
        other_operation_count: u64,
        read_transfer_count: u64,
        write_transfer_count: u64,
        other_transfer_count: u64,
    }

    #[repr(C)]
    #[derive(Default, Clone, Copy)]
    struct FileTime {
        dw_low_date_time: u32,
        dw_high_date_time: u32,
    }

    impl FileTime {
        #[inline]
        fn to_u64(self) -> u64 {
            ((self.dw_high_date_time as u64) << 32) | (self.dw_low_date_time as u64)
        }
    }

    #[link(name = "iphlpapi")]
    extern "system" {
        fn GetExtendedTcpTable(
            p_tcp_table: *mut c_void,
            pdw_size: *mut u32,
            b_order: i32,
            ul_af: u32,
            table_class: u32,
            reserved: u32,
        ) -> u32;

        fn GetPerTcpConnectionEStats(
            row: *mut MibTcpRow,
            estats_type: u32,
            rw: *mut u8,
            rw_version: u32,
            rw_size: u32,
            ros: *mut u8,
            ros_version: u32,
            ros_size: u32,
            rod: *mut u8,
            rod_version: u32,
            rod_size: u32,
        ) -> u32;

        fn SetPerTcpConnectionEStats(
            row: *mut MibTcpRow,
            estats_type: u32,
            rw: *mut u8,
            rw_version: u32,
            rw_size: u32,
            offset: u32,
        ) -> u32;

        fn GetPerTcp6ConnectionEStats(
            row: *mut MibTcp6Row,
            estats_type: u32,
            rw: *mut u8,
            rw_version: u32,
            rw_size: u32,
            ros: *mut u8,
            ros_version: u32,
            ros_size: u32,
            rod: *mut u8,
            rod_version: u32,
            rod_size: u32,
        ) -> u32;

        fn SetPerTcp6ConnectionEStats(
            row: *mut MibTcp6Row,
            estats_type: u32,
            rw: *mut u8,
            rw_version: u32,
            rw_size: u32,
            offset: u32,
        ) -> u32;
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn OpenProcess(dw_desired_access: u32, b_inherit_handle: i32, dw_process_id: u32) -> *mut c_void;
        fn GetProcessIoCounters(h_process: *mut c_void, lp_io_counters: *mut IoCounters) -> i32;
        fn GetProcessTimes(
            h_process: *mut c_void,
            lp_creation_time: *mut FileTime,
            lp_exit_time: *mut FileTime,
            lp_kernel_time: *mut FileTime,
            lp_user_time: *mut FileTime,
        ) -> i32;
        fn GetSystemTimes(
            lp_idle_time: *mut FileTime,
            lp_kernel_time: *mut FileTime,
            lp_user_time: *mut FileTime,
        ) -> i32;
        fn CloseHandle(h_object: *mut c_void) -> i32;
    }

    fn fetch_tcp_table_bytes(af: u32) -> Option<Vec<u8>> {
        let mut size: u32 = 0;
        let first = unsafe {
            GetExtendedTcpTable(ptr::null_mut(), &mut size, 0, af, TCP_TABLE_OWNER_PID_ALL, 0)
        };
        if first != ERROR_INSUFFICIENT_BUFFER && first != NO_ERROR {
            return None;
        }
        if size < 4 {
            return None;
        }

        for _ in 0..3 {
            let mut buf = vec![0u8; size as usize];
            let ret = unsafe {
                GetExtendedTcpTable(
                    buf.as_mut_ptr() as *mut c_void,
                    &mut size,
                    0,
                    af,
                    TCP_TABLE_OWNER_PID_ALL,
                    0,
                )
            };
            if ret == NO_ERROR {
                return Some(buf);
            }
            if ret != ERROR_INSUFFICIENT_BUFFER {
                return None;
            }
        }
        None
    }

    fn read_v4_estats(row: &MibTcpRowOwnerPid, estats_denied: &mut bool) -> Option<(u64, u64)> {
        let mut tcp_row = MibTcpRow {
            state: row.dw_state,
            local_addr: row.dw_local_addr,
            local_port: row.dw_local_port,
            remote_addr: row.dw_remote_addr,
            remote_port: row.dw_remote_port,
        };
        let mut rw = TcpEstatsDataRwV0 {
            enable_collection: 0,
        };
        let mut rod = TcpEstatsDataRodV0::default();
        let ret = unsafe {
            GetPerTcpConnectionEStats(
                &mut tcp_row,
                TCP_CONNECTION_ESTATS_DATA,
                &mut rw as *mut _ as *mut u8,
                0,
                size_of::<TcpEstatsDataRwV0>() as u32,
                ptr::null_mut(),
                0,
                0,
                &mut rod as *mut _ as *mut u8,
                0,
                size_of::<TcpEstatsDataRodV0>() as u32,
            )
        };
        if ret == ERROR_ACCESS_DENIED {
            *estats_denied = true;
            return None;
        }
        if ret == NO_ERROR && rw.enable_collection != 0 {
            return Some((rod.data_bytes_in, rod.data_bytes_out));
        }

        // Enable data EStats collection once (succeeds when elevated; returns ERROR_ACCESS_DENIED otherwise).
        let mut enable_rw = TcpEstatsDataRwV0 {
            enable_collection: 1,
        };
        let set_ret = unsafe {
            SetPerTcpConnectionEStats(
                &mut tcp_row,
                TCP_CONNECTION_ESTATS_DATA,
                &mut enable_rw as *mut _ as *mut u8,
                0,
                size_of::<TcpEstatsDataRwV0>() as u32,
                0,
            )
        };
        if set_ret == ERROR_ACCESS_DENIED {
            *estats_denied = true;
            return None;
        }
        if set_ret != NO_ERROR {
            return None;
        }

        let mut rod2 = TcpEstatsDataRodV0::default();
        let ret2 = unsafe {
            GetPerTcpConnectionEStats(
                &mut tcp_row,
                TCP_CONNECTION_ESTATS_DATA,
                &mut enable_rw as *mut _ as *mut u8,
                0,
                size_of::<TcpEstatsDataRwV0>() as u32,
                ptr::null_mut(),
                0,
                0,
                &mut rod2 as *mut _ as *mut u8,
                0,
                size_of::<TcpEstatsDataRodV0>() as u32,
            )
        };
        if ret2 == NO_ERROR {
            Some((rod2.data_bytes_in, rod2.data_bytes_out))
        } else {
            None
        }
    }

    fn read_v6_estats(row: &MibTcp6RowOwnerPid, estats_denied: &mut bool) -> Option<(u64, u64)> {
        let mut tcp_row = MibTcp6Row {
            state: row.dw_state,
            local_addr: row.uc_local_addr,
            local_scope_id: row.dw_local_scope_id,
            local_port: row.dw_local_port,
            remote_addr: row.uc_remote_addr,
            remote_scope_id: row.dw_remote_scope_id,
            remote_port: row.dw_remote_port,
        };
        let mut rw = TcpEstatsDataRwV0 {
            enable_collection: 0,
        };
        let mut rod = TcpEstatsDataRodV0::default();
        let ret = unsafe {
            GetPerTcp6ConnectionEStats(
                &mut tcp_row,
                TCP_CONNECTION_ESTATS_DATA,
                &mut rw as *mut _ as *mut u8,
                0,
                size_of::<TcpEstatsDataRwV0>() as u32,
                ptr::null_mut(),
                0,
                0,
                &mut rod as *mut _ as *mut u8,
                0,
                size_of::<TcpEstatsDataRodV0>() as u32,
            )
        };
        if ret == ERROR_ACCESS_DENIED {
            *estats_denied = true;
            return None;
        }
        if ret == NO_ERROR && rw.enable_collection != 0 {
            return Some((rod.data_bytes_in, rod.data_bytes_out));
        }

        let mut enable_rw = TcpEstatsDataRwV0 {
            enable_collection: 1,
        };
        let set_ret = unsafe {
            SetPerTcp6ConnectionEStats(
                &mut tcp_row,
                TCP_CONNECTION_ESTATS_DATA,
                &mut enable_rw as *mut _ as *mut u8,
                0,
                size_of::<TcpEstatsDataRwV0>() as u32,
                0,
            )
        };
        if set_ret == ERROR_ACCESS_DENIED {
            *estats_denied = true;
            return None;
        }
        if set_ret != NO_ERROR {
            return None;
        }

        let mut rod2 = TcpEstatsDataRodV0::default();
        let ret2 = unsafe {
            GetPerTcp6ConnectionEStats(
                &mut tcp_row,
                TCP_CONNECTION_ESTATS_DATA,
                &mut enable_rw as *mut _ as *mut u8,
                0,
                size_of::<TcpEstatsDataRwV0>() as u32,
                ptr::null_mut(),
                0,
                0,
                &mut rod2 as *mut _ as *mut u8,
                0,
                size_of::<TcpEstatsDataRodV0>() as u32,
            )
        };
        if ret2 == NO_ERROR {
            Some((rod2.data_bytes_in, rod2.data_bytes_out))
        } else {
            None
        }
    }

    pub(super) fn probe_pids_telemetry_impl(pid_set: &HashSet<u32>) -> PidNetSnapshot {
        let mut snap = PidNetSnapshot::default();
        let mut estats_denied = false;
        let mut table_ok = false;

        if let Some(buf) = fetch_tcp_table_bytes(AF_INET) {
            if buf.len() >= 4 {
                table_ok = true;
                let count = u32::from_ne_bytes([buf[0], buf[1], buf[2], buf[3]]) as usize;
                let row_size = size_of::<MibTcpRowOwnerPid>();
                let safe_count = count.min((buf.len() - 4) / row_size);
                for i in 0..safe_count {
                    let row = unsafe {
                        (buf.as_ptr().add(4 + i * row_size) as *const MibTcpRowOwnerPid)
                            .read_unaligned()
                    };
                    if !pid_set.contains(&row.dw_owning_pid) {
                        continue;
                    }
                    if row.dw_state == MIB_TCP_STATE_ESTAB {
                        *snap.estab_by_pid.entry(row.dw_owning_pid).or_insert(0) += 1;
                    }
                    if !estats_denied
                        && (MIB_TCP_STATE_ESTAB..=MIB_TCP_STATE_LAST_ACK).contains(&row.dw_state)
                    {
                        if let Some((bytes_in, bytes_out)) = read_v4_estats(&row, &mut estats_denied)
                        {
                            let mut local_addr = [0u8; 16];
                            local_addr[0..4].copy_from_slice(&row.dw_local_addr.to_ne_bytes());
                            let mut remote_addr = [0u8; 16];
                            remote_addr[0..4].copy_from_slice(&row.dw_remote_addr.to_ne_bytes());
                            snap.connections.push((
                                row.dw_owning_pid,
                                SocketConnKey {
                                    family: 4,
                                    local_addr,
                                    local_port: row.dw_local_port & 0xFFFF,
                                    remote_addr,
                                    remote_port: row.dw_remote_port & 0xFFFF,
                                },
                                bytes_in,
                                bytes_out,
                            ));
                        }
                    }
                }
            }
        }

        if let Some(buf) = fetch_tcp_table_bytes(AF_INET6) {
            if buf.len() >= 4 {
                table_ok = true;
                let count = u32::from_ne_bytes([buf[0], buf[1], buf[2], buf[3]]) as usize;
                let row_size = size_of::<MibTcp6RowOwnerPid>();
                let safe_count = count.min((buf.len() - 4) / row_size);
                for i in 0..safe_count {
                    let row = unsafe {
                        (buf.as_ptr().add(4 + i * row_size) as *const MibTcp6RowOwnerPid)
                            .read_unaligned()
                    };
                    if !pid_set.contains(&row.dw_owning_pid) {
                        continue;
                    }
                    if row.dw_state == MIB_TCP_STATE_ESTAB {
                        *snap.estab_by_pid.entry(row.dw_owning_pid).or_insert(0) += 1;
                    }
                    if !estats_denied
                        && (MIB_TCP_STATE_ESTAB..=MIB_TCP_STATE_LAST_ACK).contains(&row.dw_state)
                    {
                        if let Some((bytes_in, bytes_out)) = read_v6_estats(&row, &mut estats_denied)
                        {
                            snap.connections.push((
                                row.dw_owning_pid,
                                SocketConnKey {
                                    family: 6,
                                    local_addr: row.uc_local_addr,
                                    local_port: row.dw_local_port & 0xFFFF,
                                    remote_addr: row.uc_remote_addr,
                                    remote_port: row.dw_remote_port & 0xFFFF,
                                },
                                bytes_in,
                                bytes_out,
                            ));
                        }
                    }
                }
            }
        }

        snap.socket_stats_ok = table_ok && !estats_denied;

        let mut sys_idle = FileTime::default();
        let mut sys_kernel = FileTime::default();
        let mut sys_user = FileTime::default();
        if unsafe { GetSystemTimes(&mut sys_idle, &mut sys_kernel, &mut sys_user) } != 0 {
            snap.sys_cpu_total = Some(sys_kernel.to_u64().saturating_add(sys_user.to_u64()));
        }

        // Collect isolated per-PID Win32 IO_COUNTERS and 1s process CPU times via the same handle.
        for &pid in pid_set {
            let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
            if !handle.is_null() {
                let mut counters = IoCounters::default();
                let ok_io = unsafe { GetProcessIoCounters(handle, &mut counters) };
                let mut creation = FileTime::default();
                let mut exit = FileTime::default();
                let mut kernel = FileTime::default();
                let mut user = FileTime::default();
                let ok_cpu = unsafe {
                    GetProcessTimes(handle, &mut creation, &mut exit, &mut kernel, &mut user)
                };
                unsafe {
                    CloseHandle(handle);
                }
                if ok_io != 0 {
                    snap.io_by_pid
                        .insert(pid, (counters.read_transfer_count, counters.write_transfer_count));
                }
                if ok_cpu != 0 {
                    snap.cpu_time_by_pid
                        .insert(pid, kernel.to_u64().saturating_add(user.to_u64()));
                }
            }
        }

        snap
    }
}

#[cfg(target_os = "linux")]
mod platform {
    use super::{PidNetSnapshot, SocketConnKey};
    use std::collections::{HashMap, HashSet};
    use std::fs;
    use std::mem::{size_of, zeroed};

    const NETLINK_SOCK_DIAG: i32 = 4;
    const SOCK_DIAG_BY_FAMILY: u16 = 20;
    const NLM_F_REQUEST: u16 = 0x01;
    const NLM_F_DUMP: u16 = 0x300;
    const NLMSG_DONE: u16 = 3;
    const NLMSG_ERROR: u16 = 2;
    const INET_DIAG_INFO: u16 = 2;
    const TCP_ESTABLISHED: u8 = 1;

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct NlMsgHdr {
        nlmsg_len: u32,
        nlmsg_type: u16,
        nlmsg_flags: u16,
        nlmsg_seq: u32,
        nlmsg_pid: u32,
    }

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct InetDiagSockId {
        idiag_sport: [u8; 2],
        idiag_dport: [u8; 2],
        idiag_src: [u32; 4],
        idiag_dst: [u32; 4],
        idiag_if: u32,
        idiag_cookie: [u32; 2],
    }

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct InetDiagReqV2 {
        sdiag_family: u8,
        sdiag_protocol: u8,
        idiag_ext: u8,
        pad: u8,
        idiag_states: u32,
        id: InetDiagSockId,
    }

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct InetDiagMsg {
        idiag_family: u8,
        idiag_state: u8,
        idiag_timer: u8,
        idiag_retrans: u8,
        id: InetDiagSockId,
        idiag_expires: u32,
        idiag_rqueue: u32,
        idiag_wqueue: u32,
        idiag_uid: u32,
        idiag_inode: u32,
    }

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct RtAttr {
        rta_len: u16,
        rta_type: u16,
    }

    #[inline]
    const fn nlmsg_align(len: usize) -> usize {
        (len + 3) & !3
    }

    fn collect_socket_inodes(pid_set: &HashSet<u32>) -> HashMap<u32, u32> {
        let mut inode_to_pid = HashMap::new();
        for &pid in pid_set {
            let Ok(entries) = fs::read_dir(format!("/proc/{pid}/fd")) else {
                continue;
            };
            for entry in entries.flatten() {
                let Ok(target) = fs::read_link(entry.path()) else {
                    continue;
                };
                if let Some(s) = target.to_str() {
                    if let Some(rest) = s.strip_prefix("socket:[") {
                        if let Some(num) = rest.strip_suffix(']') {
                            if let Ok(inode) = num.parse::<u32>() {
                                inode_to_pid.insert(inode, pid);
                            }
                        }
                    }
                }
            }
        }
        inode_to_pid
    }

    fn read_tcp_info_bytes(payload: &[u8]) -> Option<(u64, u64)> {
        // Offsets in Linux UAPI struct tcp_info verified against libc::tcp_info:
        // tcpi_bytes_acked @ 120, tcpi_bytes_received @ 128, optional tcpi_bytes_sent @ 200.
        if payload.len() < 136 {
            return None;
        }
        let acked = u64::from_ne_bytes(payload[120..128].try_into().ok()?);
        let recv = u64::from_ne_bytes(payload[128..136].try_into().ok()?);
        let sent = if payload.len() >= 208 {
            u64::from_ne_bytes(payload[200..208].try_into().ok()?)
        } else {
            0
        };
        Some((recv, sent.max(acked)))
    }

    fn query_netlink_family(
        fd: i32,
        family: u8,
        inode_to_pid: &HashMap<u32, u32>,
        snap: &mut PidNetSnapshot,
    ) -> bool {
        #[repr(C)]
        struct ReqPacket {
            hdr: NlMsgHdr,
            req: InetDiagReqV2,
        }

        let pkt = ReqPacket {
            hdr: NlMsgHdr {
                nlmsg_len: size_of::<ReqPacket>() as u32,
                nlmsg_type: SOCK_DIAG_BY_FAMILY,
                nlmsg_flags: NLM_F_REQUEST | NLM_F_DUMP,
                nlmsg_seq: 1,
                nlmsg_pid: 0,
            },
            req: InetDiagReqV2 {
                sdiag_family: family,
                sdiag_protocol: libc::IPPROTO_TCP as u8,
                idiag_ext: 1 << (INET_DIAG_INFO - 1),
                pad: 0,
                idiag_states: u32::MAX,
                id: unsafe { zeroed() },
            },
        };

        let mut addr: libc::sockaddr_nl = unsafe { zeroed() };
        addr.nl_family = libc::AF_NETLINK as libc::sa_family_t;

        let sent = unsafe {
            libc::sendto(
                fd,
                &pkt as *const _ as *const libc::c_void,
                size_of::<ReqPacket>(),
                0,
                &addr as *const _ as *const libc::sockaddr,
                size_of::<libc::sockaddr_nl>() as libc::socklen_t,
            )
        };
        if sent < 0 {
            return false;
        }

        let mut buf = vec![0u8; 32768];
        loop {
            let n = unsafe {
                libc::recv(
                    fd,
                    buf.as_mut_ptr() as *mut libc::c_void,
                    buf.len(),
                    0,
                )
            };
            if n <= 0 {
                return false;
            }
            let slice = &buf[..n as usize];
            let mut offset = 0usize;
            while offset + size_of::<NlMsgHdr>() <= slice.len() {
                let hdr = unsafe {
                    (slice.as_ptr().add(offset) as *const NlMsgHdr).read_unaligned()
                };
                let msg_len = hdr.nlmsg_len as usize;
                if msg_len < size_of::<NlMsgHdr>() || offset + msg_len > slice.len() {
                    break;
                }
                if hdr.nlmsg_type == NLMSG_DONE {
                    return true;
                }
                if hdr.nlmsg_type == NLMSG_ERROR {
                    return false;
                }
                if hdr.nlmsg_type == SOCK_DIAG_BY_FAMILY
                    && msg_len >= size_of::<NlMsgHdr>() + size_of::<InetDiagMsg>()
                {
                    let msg_off = offset + size_of::<NlMsgHdr>();
                    let msg = unsafe {
                        (slice.as_ptr().add(msg_off) as *const InetDiagMsg).read_unaligned()
                    };
                    if let Some(&pid) = inode_to_pid.get(&msg.idiag_inode) {
                        if msg.idiag_state == TCP_ESTABLISHED {
                            *snap.estab_by_pid.entry(pid).or_insert(0) += 1;
                        }
                        let mut attr_off = msg_off + nlmsg_align(size_of::<InetDiagMsg>());
                        let msg_end = offset + msg_len;
                        while attr_off + size_of::<RtAttr>() <= msg_end {
                            let attr = unsafe {
                                (slice.as_ptr().add(attr_off) as *const RtAttr).read_unaligned()
                            };
                            let rta_len = attr.rta_len as usize;
                            if rta_len < size_of::<RtAttr>() || attr_off + rta_len > msg_end {
                                break;
                            }
                            if attr.rta_type == INET_DIAG_INFO {
                                let payload = &slice[attr_off + size_of::<RtAttr>()..attr_off + rta_len];
                                if let Some((rx, tx)) = read_tcp_info_bytes(payload) {
                                    let mut local_addr = [0u8; 16];
                                    let mut remote_addr = [0u8; 16];
                                    for i in 0..4 {
                                        local_addr[i * 4..(i + 1) * 4]
                                            .copy_from_slice(&msg.id.idiag_src[i].to_ne_bytes());
                                        remote_addr[i * 4..(i + 1) * 4]
                                            .copy_from_slice(&msg.id.idiag_dst[i].to_ne_bytes());
                                    }
                                    snap.connections.push((
                                        pid,
                                        SocketConnKey {
                                            family: msg.idiag_family,
                                            local_addr,
                                            local_port: u16::from_be_bytes(msg.id.idiag_sport) as u32,
                                            remote_addr,
                                            remote_port: u16::from_be_bytes(msg.id.idiag_dport) as u32,
                                        },
                                        rx,
                                        tx,
                                    ));
                                }
                            }
                            attr_off += nlmsg_align(rta_len);
                        }
                    }
                }
                offset += nlmsg_align(msg_len);
            }
        }
    }

    pub(super) fn probe_pids_telemetry_impl(pid_set: &HashSet<u32>) -> PidNetSnapshot {
        let mut snap = PidNetSnapshot::default();
        let inode_to_pid = collect_socket_inodes(pid_set);

        let fd = unsafe { libc::socket(libc::AF_NETLINK, libc::SOCK_DGRAM, NETLINK_SOCK_DIAG) };
        if fd >= 0 {
            let v4 = query_netlink_family(fd, libc::AF_INET as u8, &inode_to_pid, &mut snap);
            let v6 = query_netlink_family(fd, libc::AF_INET6 as u8, &inode_to_pid, &mut snap);
            unsafe {
                libc::close(fd);
            }
            snap.socket_stats_ok = v4 || v6;
        }

        if let Ok(stat_text) = fs::read_to_string("/proc/stat") {
            if let Some(cpu_line) = stat_text.lines().find(|l| l.starts_with("cpu ")) {
                let sum: u64 = cpu_line
                    .split_whitespace()
                    .skip(1)
                    .filter_map(|v| v.parse::<u64>().ok())
                    .sum();
                if sum > 0 {
                    snap.sys_cpu_total = Some(sum);
                }
            }
        }

        for &pid in pid_set {
            if let Ok(content) = fs::read_to_string(format!("/proc/{pid}/io")) {
                let mut rchar = 0u64;
                let mut wchar = 0u64;
                for line in content.lines() {
                    if let Some(val) = line.strip_prefix("rchar:") {
                        rchar = val.trim().parse::<u64>().unwrap_or(0);
                    } else if let Some(val) = line.strip_prefix("wchar:") {
                        wchar = val.trim().parse::<u64>().unwrap_or(0);
                    }
                }
                snap.io_by_pid.insert(pid, (rchar, wchar));
            }
            if let Ok(stat_line) = fs::read_to_string(format!("/proc/{pid}/stat")) {
                if let Some(rparen) = stat_line.rfind(')') {
                    let fields: Vec<&str> = stat_line[rparen + 1..].split_whitespace().collect();
                    if fields.len() > 12 {
                        let utime = fields[11].parse::<u64>().unwrap_or(0);
                        let stime = fields[12].parse::<u64>().unwrap_or(0);
                        snap.cpu_time_by_pid.insert(pid, utime.saturating_add(stime));
                    }
                }
            }
        }

        snap
    }
}

#[cfg(all(not(windows), not(target_os = "linux")))]
mod platform {
    use super::PidNetSnapshot;
    use std::collections::HashSet;

    pub(super) fn probe_pids_telemetry_impl(_pid_set: &HashSet<u32>) -> PidNetSnapshot {
        PidNetSnapshot::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_key(port: u32) -> SocketConnKey {
        SocketConnKey {
            family: 4,
            local_addr: [127, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
            local_port: port,
            remote_addr: [1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
            remote_port: 443,
        }
    }

    #[test]
    fn test_projects_have_completely_isolated_graphs() {
        let t0 = Instant::now();
        let mut app_a = ProjectNetTracker::new(vec![101]);
        let mut app_b = ProjectNetTracker::new(vec![202]);

        let mut snap0 = PidNetSnapshot {
            socket_stats_ok: true,
            connections: vec![
                (101, test_key(4173), 10_000, 5_000),
                (202, test_key(1112), 90_000, 80_000),
            ],
            ..Default::default()
        };
        snap0.estab_by_pid.insert(101, 2);
        snap0.estab_by_pid.insert(202, 1);

        // Baseline sample emits 0 rate even for sockets with existing lifetime bytes.
        app_a.apply_snapshot(&snap0, t0, 1000);
        app_b.apply_snapshot(&snap0, t0, 1000);
        assert_eq!(app_a.to_metrics().inbound_bps, 0);
        assert_eq!(app_b.to_metrics().inbound_bps, 0);

        // App A downloads 40 KB, uploads 12 KB in 1s; App B stays idle.
        let t1 = t0 + Duration::from_secs(1);
        let mut snap1 = PidNetSnapshot {
            socket_stats_ok: true,
            connections: vec![
                (101, test_key(4173), 50_000, 17_000),
                (202, test_key(1112), 90_000, 80_000),
            ],
            ..Default::default()
        };
        snap1.estab_by_pid.insert(101, 2);
        snap1.estab_by_pid.insert(202, 1);

        app_a.apply_snapshot(&snap1, t1, 2000);
        app_b.apply_snapshot(&snap1, t1, 2000);

        let ma = app_a.to_metrics();
        let mb = app_b.to_metrics();
        assert_eq!(ma.inbound_bps, 40_000);
        assert_eq!(ma.outbound_bps, 12_000);
        assert_eq!(ma.total_rx_bytes, 40_000);
        assert_eq!(ma.total_tx_bytes, 12_000);
        assert_eq!(ma.interface_count, 2);

        assert_eq!(mb.inbound_bps, 0);
        assert_eq!(mb.outbound_bps, 0);
        assert_eq!(mb.total_rx_bytes, 0);
        assert_eq!(mb.total_tx_bytes, 0);
        assert_eq!(mb.history.len(), 2);
        assert_eq!(ma.history.len(), 2);
    }

    #[test]
    fn test_offline_project_resets_and_returns_zero() {
        let project_id = 987_654;
        let my_pid = std::process::id();

        let (running_first, _) = get_project_live_telemetry(project_id, true, &[my_pid]);
        assert_eq!(running_first.history.len(), 1);
        assert_eq!(running_first.inbound_bps, 0);

        let (offline, _) = get_project_live_telemetry(project_id, false, &[]);
        assert_eq!(offline.inbound_bps, 0);
        assert_eq!(offline.outbound_bps, 0);
        assert_eq!(offline.total_rx_bytes, 0);
        assert_eq!(offline.total_tx_bytes, 0);
        assert!(offline.history.is_empty());
    }

    #[test]
    fn test_live_self_cpu_measurement_reports_activity() {
        let project_id = 987_655;
        let my_pid = std::process::id();
        let pids = vec![my_pid];

        let (net0, cpu0) = get_project_live_telemetry(project_id, true, &pids);
        assert_eq!(net0.history.len(), 1);
        assert!(cpu0.is_none(), "initial baseline sample should defer delta cpu to next interval");

        // Burn real user CPU for ~950ms so MIN_RESAMPLE_GAP passes and OS process times advance.
        let start = Instant::now();
        let mut acc: u64 = 1;
        while start.elapsed() < Duration::from_millis(950) {
            for i in 1..20_000u64 {
                acc = acc.wrapping_mul(6364136223846793005).wrapping_add(i);
            }
        }
        std::hint::black_box(acc);

        let (_net1, cpu1) = get_project_live_telemetry(project_id, true, &pids);
        let pct = cpu1.expect("second sample after MIN_RESAMPLE_GAP must yield OS CPU%");
        assert!(pct > 0.05 && pct <= 100.0, "expected positive CPU%, got {pct}");

        let (_net_off, cpu_off) = get_project_live_telemetry(project_id, false, &[]);
        assert_eq!(cpu_off, Some(0.0));
    }
}
