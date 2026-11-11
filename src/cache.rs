use serde::Serialize;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant};

struct CacheEntry {
    json: Arc<str>,
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
    hits: AtomicU64,
    misses: AtomicU64,
    invalidations: AtomicU64,
}

impl AppCache {
    pub fn new() -> Self {
        Self {
            store: RwLock::new(HashMap::with_capacity(32)),
            hits: AtomicU64::new(0),
            misses: AtomicU64::new(0),
            invalidations: AtomicU64::new(0),
        }
    }

    /// Returns the pre-serialized compact JSON string directly as an Arc<str>
    /// with zero allocations and zero deserialization/re-serialization overhead.
    pub fn get_json(&self, key: &str) -> Option<Arc<str>> {
        let now = Instant::now();
        if let Ok(map) = self.store.read() {
            if let Some(entry) = map.get(key) {
                if entry.expires_at > now {
                    self.hits.fetch_add(1, Ordering::Relaxed);
                    return Some(entry.json.clone());
                }
            }
        }
        self.misses.fetch_add(1, Ordering::Relaxed);
        None
    }

    /// Stores a pre-serialized compact JSON string directly.
    pub fn set_json(&self, key: String, json: String, ttl: Duration) {
        let now = Instant::now();
        if let Ok(mut map) = self.store.write() {
            if map.len() >= 64 {
                map.retain(|_, v| v.expires_at > now);
            }
            map.insert(
                key,
                CacheEntry {
                    json: Arc::from(json),
                    expires_at: now + ttl,
                },
            );
        }
    }

    /// Serializes and stores a JSON value as compact UTF-8, avoiding heavy in-memory node trees.
    pub fn set(&self, key: String, value: serde_json::Value, ttl: Duration) {
        if let Ok(s) = serde_json::to_string(&value) {
            self.set_json(key, s, ttl);
        }
    }

    /// Fallback deserialization if a caller specifically requires a serde_json::Value
    pub fn get(&self, key: &str) -> Option<serde_json::Value> {
        self.get_json(key).and_then(|s| serde_json::from_str(&s).ok())
    }

    pub fn prune_expired(&self) {
        let now = Instant::now();
        if let Ok(mut map) = self.store.write() {
            map.retain(|_, v| v.expires_at > now);
        }
    }

    pub fn invalidate_prefix(&self, prefix: &str) {
        self.invalidations.fetch_add(1, Ordering::Relaxed);
        if let Ok(mut map) = self.store.write() {
            map.retain(|k, _| !k.starts_with(prefix));
        }
    }

    pub fn invalidate_project(&self, project_id: i64) {
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
            });
        }
    }

    pub fn invalidate_all(&self) {
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

