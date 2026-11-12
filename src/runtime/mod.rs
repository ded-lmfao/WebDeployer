#![allow(unused_imports)]

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use tokio::process::Child;

use crate::db::DbPool;
use crate::logs::Logs;

pub mod container;
pub mod port;
pub mod process;
pub mod tree;
pub mod maintenance;
pub mod supervisor;

pub use container::WebsiteContainer;
pub use tree::{detect_java_exe, is_pid_alive};

pub struct Runtime {
    pub(crate) db: DbPool,
    pub(crate) logs: Logs,
    pub(crate) processes: Arc<Mutex<HashMap<i64, Child>>>,
    pub(crate) project_locks: Arc<Mutex<HashMap<i64, Arc<tokio::sync::Mutex<()>>>>>,
    pub(crate) stop_seq: Arc<Mutex<HashMap<i64, u64>>>,
    pub(crate) maintenance_shutdowns: Arc<Mutex<HashMap<i64, tokio::sync::oneshot::Sender<()>>>>,
    pub(crate) allowed_ports: Arc<Mutex<HashSet<u16>>>,
}

impl Runtime {
    pub fn new(db: DbPool, logs: Logs) -> Self {
        Self {
            db,
            logs,
            processes: Arc::new(Mutex::new(HashMap::new())),
            project_locks: Arc::new(Mutex::new(HashMap::new())),
            stop_seq: Arc::new(Mutex::new(HashMap::new())),
            maintenance_shutdowns: Arc::new(Mutex::new(HashMap::new())),
            allowed_ports: Arc::new(Mutex::new(HashSet::new())),
        }
    }


    pub(crate) fn get_project_lock(&self, project_id: i64) -> Arc<tokio::sync::Mutex<()>> {
        let mut map = self.project_locks.lock().unwrap();
        map.entry(project_id).or_insert_with(|| Arc::new(tokio::sync::Mutex::new(()))).clone()
    }

    pub fn get_stop_seq(&self, project_id: i64) -> u64 {
        let map = self.stop_seq.lock().unwrap();
        *map.get(&project_id).unwrap_or(&0)
    }

    pub fn bump_stop_seq(&self, project_id: i64) -> u64 {
        let mut map = self.stop_seq.lock().unwrap();
        let entry = map.entry(project_id).or_insert(0);
        *entry += 1;
        *entry
    }


}
