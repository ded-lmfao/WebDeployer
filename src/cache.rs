use axum::body::Bytes;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};
use tokio::sync::watch;

struct CacheEntry {
    bytes: Bytes,
    expires_at: Instant,
}

#[derive(Serialize, Clone, Debug)]
pub struct CacheStats {
    pub hits: u64,
    pub misses: u64,
    pub invalidations: u64,
    pub entries: usize,
    #[serde(rename = "hitRatePct")]
    pub hit_rate_pct: f64,
}

pub struct AppCache {
    store: RwLock<HashMap<String, CacheEntry>>,
    inflight: Arc<Mutex<HashMap<String, watch::Sender<bool>>>>,
    generation: AtomicU64,
    hits: AtomicU64,
    misses: AtomicU64,
    invalidations: AtomicU64,
}

pub enum InflightRole {
    Leader(InflightGuard),
    Follower(watch::Receiver<bool>),
}

pub struct InflightGuard {
    key: String,
    tx: watch::Sender<bool>,
    inflight: Arc<Mutex<HashMap<String, watch::Sender<bool>>>>,
}

impl Drop for InflightGuard {
    fn drop(&mut self) {
        if let Ok(mut map) = self.inflight.lock() {
            if let Some(current) = map.get(&self.key) {
                if current.same_channel(&self.tx) {
                    map.remove(&self.key);
                }
            }
        }
        let _ = self.tx.send(true);
    }
}

impl AppCache {
    pub fn new() -> Self {
        Self {
            store: RwLock::new(HashMap::with_capacity(32)),
            inflight: Arc::new(Mutex::new(HashMap::with_capacity(16))),
            generation: AtomicU64::new(0),
            hits: AtomicU64::new(0),
            misses: AtomicU64::new(0),
            invalidations: AtomicU64::new(0),
        }
    }

    pub fn generation(&self) -> u64 {
        self.generation.load(Ordering::Acquire)
    }

    pub fn acquire_inflight(&self, key: &str) -> InflightRole {
        let mut map = self.inflight.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(existing) = map.get(key) {
            return InflightRole::Follower(existing.subscribe());
        }
        let (tx, _rx) = watch::channel(false);
        map.insert(key.to_string(), tx.clone());
        InflightRole::Leader(InflightGuard {
            key: key.to_string(),
            tx,
            inflight: Arc::clone(&self.inflight),
        })
    }

    /// Returns pre-serialized JSON bytes directly as an `axum::body::Bytes`.
    /// Zero allocations, zero deserialization, zero copy when converting to Axum response body.
    pub fn get_bytes(&self, key: &str) -> Option<Bytes> {
        let now = Instant::now();
        if let Ok(map) = self.store.read() {
            if let Some(entry) = map.get(key) {
                if entry.expires_at > now {
                    self.hits.fetch_add(1, Ordering::Relaxed);
                    return Some(entry.bytes.clone());
                }
            }
        }
        self.misses.fetch_add(1, Ordering::Relaxed);
        None
    }

    /// Stores pre-serialized Bytes directly.
    pub fn set_bytes(&self, key: String, bytes: Bytes, ttl: Duration) {
        let now = Instant::now();
        if let Ok(mut map) = self.store.write() {
            if map.len() >= 64 {
                map.retain(|_, v| v.expires_at > now);
            }
            map.insert(
                key,
                CacheEntry {
                    bytes,
                    expires_at: now + ttl,
                },
            );
        }
    }

    /// Stores pre-serialized Bytes only if no invalidation happened since `expected_gen`.
    pub fn set_bytes_if_gen(&self, key: String, bytes: Bytes, ttl: Duration, expected_gen: u64) {
        if self.generation.load(Ordering::Acquire) == expected_gen {
            self.set_bytes(key, bytes, ttl);
        }
    }

    pub fn prune_expired(&self) {
        let now = Instant::now();
        if let Ok(mut map) = self.store.write() {
            map.retain(|_, v| v.expires_at > now);
        }
    }

    pub fn invalidate_prefix(&self, prefix: &str) {
        self.generation.fetch_add(1, Ordering::Release);
        self.invalidations.fetch_add(1, Ordering::Relaxed);
        if let Ok(mut map) = self.store.write() {
            map.retain(|k, _| !k.starts_with(prefix));
        }
    }

    pub fn invalidate_project(&self, project_id: i64) {
        self.generation.fetch_add(1, Ordering::Release);
        self.invalidations.fetch_add(1, Ordering::Relaxed);
        let p_tag = format!(":p{}:", project_id);
        if let Ok(mut map) = self.store.write() {
            map.retain(|k, _| {
                !k.contains(&p_tag)
                    && !k.starts_with("overview:")
                    && !k.starts_with("monitor:")
                    && !k.starts_with("projects:")
                    && !k.starts_with("deployments:")
                    && !k.starts_with("audit:")
                    && !k.starts_with("databases:")
            });
        }
    }

    pub fn invalidate_all(&self) {
        self.generation.fetch_add(1, Ordering::Release);
        self.invalidations.fetch_add(1, Ordering::Relaxed);
        if let Ok(mut map) = self.store.write() {
            map.clear();
        }
    }

    pub fn stats(&self) -> CacheStats {
        let hits = self.hits.load(Ordering::Relaxed);
        let misses = self.misses.load(Ordering::Relaxed);
        let invalidations = self.invalidations.load(Ordering::Relaxed);
        let total = hits + misses;
        let hit_rate_pct = if total > 0 {
            ((hits as f64 / total as f64) * 1000.0).round() / 10.0
        } else {
            100.0
        };
        let now = Instant::now();
        let entries = self
            .store
            .read()
            .map(|m| m.values().filter(|e| e.expires_at > now).count())
            .unwrap_or(0);

        CacheStats {
            hits,
            misses,
            invalidations,
            entries,
            hit_rate_pct,
        }
    }
}
