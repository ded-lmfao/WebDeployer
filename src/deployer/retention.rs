use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use rusqlite::params;

use crate::db::{shrink_memory, DbPool};
use crate::monitor::invalidate_path_disk_cache;

/// Maximum number of deployment records kept per project.
pub const MAX_DEPLOYMENT_RECORDS: usize = 5;

#[cfg(windows)]
fn unlink_reparse_or_symlink(path: &Path) -> bool {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0000_0400;

    let Ok(meta) = fs::symlink_metadata(path) else {
        return false;
    };
    let is_reparse = (meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT) != 0;
    if !is_reparse && !meta.file_type().is_symlink() {
        return false;
    }

    if meta.is_dir() {
        if fs::remove_dir(path).is_err() {
            if let Some(s) = path.to_str() {
                let _ = std::process::Command::new("cmd")
                    .args(["/C", "rmdir", s])
                    .output();
            }
        }
    } else {
        let _ = fs::remove_file(path);
    }
    true
}

#[cfg(not(windows))]
fn unlink_reparse_or_symlink(path: &Path) -> bool {
    let Ok(meta) = fs::symlink_metadata(path) else {
        return false;
    };
    if !meta.file_type().is_symlink() {
        return false;
    }
    if fs::remove_file(path).is_err() {
        let _ = fs::remove_dir(path);
    }
    true
}

/// Safely remove a pruned release directory without following any `data` junction/symlink
/// pointing into persistent container storage.
pub(crate) fn safe_remove_release_dir(rel_dir: &Path) -> bool {
    if fs::symlink_metadata(rel_dir).is_err() {
        return false;
    }
    if unlink_reparse_or_symlink(rel_dir) {
        return fs::symlink_metadata(rel_dir).is_err();
    }

    // Unlink persistent `data` container mount before deleting the release tree.
    let data_mount = rel_dir.join("data");
    let _ = unlink_reparse_or_symlink(&data_mount);

    fs::remove_dir_all(rel_dir).is_ok()
}

fn is_safe_prunable_release_dir(
    cand: &Path,
    releases_root: &Path,
    protected_paths: &HashSet<PathBuf>,
) -> bool {
    if fs::symlink_metadata(cand).is_err() {
        return false;
    }
    let Some(name) = cand.file_name().and_then(|n| n.to_str()) else {
        return false;
    };
    if !name.starts_with("rel-") {
        return false;
    }

    let Some(parent) = cand.parent() else {
        return false;
    };
    let canon_releases = fs::canonicalize(releases_root).ok();
    let canon_parent = fs::canonicalize(parent).ok();
    let in_releases_dir = parent == releases_root
        || matches!((&canon_parent, &canon_releases), (Some(p), Some(r)) if p == r);
    if !in_releases_dir {
        return false;
    }

    if protected_paths.contains(cand) {
        return false;
    }
    if let Ok(canon_cand) = fs::canonicalize(cand) {
        if protected_paths.contains(&canon_cand) {
            return false;
        }
    }

    true
}

fn collect_protected_paths(
    deploy_dir: &Path,
    protected_db_dirs: &[String],
) -> HashSet<PathBuf> {
    let mut protected = HashSet::new();
    protected.insert(deploy_dir.to_path_buf());
    protected.insert(deploy_dir.join("app"));
    protected.insert(deploy_dir.join("releases"));

    let current_link = deploy_dir.join("current");
    if let Ok(canon_current) = fs::canonicalize(&current_link) {
        protected.insert(canon_current);
    }

    for dir_str in protected_db_dirs {
        let trimmed = dir_str.trim();
        if trimmed.is_empty() {
            continue;
        }
        let p = PathBuf::from(trimmed);
        if let Ok(canon) = fs::canonicalize(&p) {
            protected.insert(canon);
        }
        protected.insert(p);
    }

    protected
}

fn remove_unreferenced_release_rows(
    conn: &rusqlite::Connection,
    candidates: Vec<(i64, String)>,
    current_release_id: Option<i64>,
    retained_release_ids: &HashSet<i64>,
    candidate_dirs: &mut Vec<PathBuf>,
) -> bool {
    let mut removed_any = false;
    for (rel_id, rel_dir) in candidates {
        if retained_release_ids.contains(&rel_id) || Some(rel_id) == current_release_id {
            continue;
        }
        candidate_dirs.push(PathBuf::from(&rel_dir));
        conn.execute(
            "UPDATE backups SET release_id = NULL WHERE release_id = ? AND kind = 'manual'",
            params![rel_id],
        )
        .ok();
        conn.execute("DELETE FROM backups WHERE release_id = ?", params![rel_id])
            .ok();
        conn.execute("DELETE FROM releases WHERE id = ?", params![rel_id])
            .ok();
        removed_any = true;
    }
    removed_any
}

/// Retain at most `keep` newest deployments for `project_id`, removing excess DB records
/// (deployments, deployment logs, non-live releases, auto snapshot backups) and freeing
/// unreferenced `rel-*` release directories on disk.
pub fn prune_project_deployments(db: &DbPool, project_id: i64, keep: usize) -> usize {
    let mut candidate_dirs: Vec<PathBuf> = Vec::new();
    let mut protected_db_dirs: Vec<String> = Vec::new();
    let mut remaining_dep_ids: HashSet<i64> = HashSet::new();
    let deploy_dir_str: String;
    let pruned_count: usize;

    {
        let conn = db.lock().unwrap();
        let proj_row: Option<(String, Option<i64>)> = conn
            .query_row(
                "SELECT deploy_dir, current_release_id FROM projects WHERE id = ?",
                params![project_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .ok();

        let Some((dep_dir, current_release_id)) = proj_row else {
            return 0;
        };
        deploy_dir_str = dep_dir;

        // Collect excess deployments ordered newest-first beyond `keep`.
        let mut excess_deps: Vec<i64> = Vec::new();
        if let Ok(mut stmt) = conn.prepare(
            "SELECT id FROM deployments WHERE project_id = ? ORDER BY id DESC LIMIT -1 OFFSET ?",
        ) {
            if let Ok(rows) = stmt.query_map(params![project_id, keep as i64], |r| r.get::<_, i64>(0)) {
                for row in rows.flatten() {
                    excess_deps.push(row);
                }
            }
        }

        // Collect release IDs referenced by kept deployments so rollbacks stay intact.
        let mut retained_release_ids: HashSet<i64> = HashSet::new();
        if let Ok(mut stmt) = conn.prepare(
            "SELECT id, release_id FROM deployments WHERE project_id = ? ORDER BY id DESC LIMIT ?",
        ) {
            if let Ok(rows) = stmt.query_map(params![project_id, keep as i64], |r| {
                Ok((r.get::<_, i64>(0)?, r.get::<_, Option<i64>>(1)?))
            }) {
                for (dep_id, rel_id) in rows.flatten() {
                    remaining_dep_ids.insert(dep_id);
                    if let Some(rid) = rel_id {
                        retained_release_ids.insert(rid);
                    }
                }
            }
        }
        if let Some(cid) = current_release_id {
            retained_release_ids.insert(cid);
        }

        pruned_count = excess_deps.len();

        let releases_root = Path::new(&deploy_dir_str).join("releases");
        for dep_id in &excess_deps {
            candidate_dirs.push(releases_root.join(format!("rel-{}", dep_id)));

            // Find releases built specifically by this pruned deployment.
            let mut dep_releases: Vec<(i64, String)> = Vec::new();
            if let Ok(mut stmt) = conn.prepare(
                "SELECT id, dir FROM releases WHERE project_id = ? AND deployment_id = ?",
            ) {
                if let Ok(rows) = stmt.query_map(params![project_id, dep_id], |r| {
                    Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))
                }) {
                    for pair in rows.flatten() {
                        dep_releases.push(pair);
                    }
                }
            }

            remove_unreferenced_release_rows(
                &conn,
                dep_releases,
                current_release_id,
                &retained_release_ids,
                &mut candidate_dirs,
            );

            conn.execute("DELETE FROM logs WHERE deployment_id = ?", params![dep_id])
                .ok();
            conn.execute("DELETE FROM deployments WHERE id = ?", params![dep_id])
                .ok();
        }

        // Clean up any previously spared release rows whose owning deployment was already pruned
        // (including rows whose `deployment_id` became NULL via ON DELETE SET NULL) once they
        // are no longer `current_release_id` or referenced by any kept deployment.
        let mut stale_releases: Vec<(i64, String)> = Vec::new();
        if let Ok(mut stmt) = conn.prepare(
            "SELECT id, deployment_id, dir FROM releases WHERE project_id = ?",
        ) {
            if let Ok(rows) = stmt.query_map(params![project_id], |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, Option<i64>>(1)?,
                    r.get::<_, String>(2)?,
                ))
            }) {
                for (rel_id, dep_id_opt, rel_dir) in rows.flatten() {
                    let pruned_by_dep_id = matches!(dep_id_opt, Some(did) if !remaining_dep_ids.contains(&did));
                    let pruned_by_rel_dir = Path::new(&rel_dir)
                        .file_name()
                        .and_then(|n| n.to_str())
                        .and_then(|n| n.strip_prefix("rel-"))
                        .and_then(|d| d.parse::<i64>().ok())
                        .map(|did| !remaining_dep_ids.contains(&did))
                        .unwrap_or(false);
                    if pruned_by_dep_id || pruned_by_rel_dir {
                        stale_releases.push((rel_id, rel_dir));
                    }
                }
            }
        }
        let removed_stale_rel = remove_unreferenced_release_rows(
            &conn,
            stale_releases,
            current_release_id,
            &retained_release_ids,
            &mut candidate_dirs,
        );

        // Gather all still-referenced release directories (live + retained).
        if let Some(cid) = current_release_id {
            if let Ok(dir) = conn.query_row(
                "SELECT dir FROM releases WHERE id = ?",
                params![cid],
                |r| r.get::<_, String>(0),
            ) {
                protected_db_dirs.push(dir);
            }
        }
        if let Ok(mut stmt) =
            conn.prepare("SELECT dir FROM releases WHERE project_id = ?")
        {
            if let Ok(rows) = stmt.query_map(params![project_id], |r| r.get::<_, String>(0)) {
                for dir in rows.flatten() {
                    protected_db_dirs.push(dir);
                }
            }
        }

        if pruned_count > 0 || removed_stale_rel {
            let freelist_count: i64 = conn
                .query_row("PRAGMA freelist_count", [], |r| r.get(0))
                .unwrap_or(0);
            if freelist_count >= 128 {
                conn.execute_batch("VACUUM;").ok();
            }
            conn.execute_batch("PRAGMA wal_checkpoint(PASSIVE); PRAGMA optimize;")
                .ok();
            shrink_memory(&conn);
        }
    }

    // Perform filesystem cleanup outside the DB lock.
    let base_dir = PathBuf::from(&deploy_dir_str);
    let releases_root = base_dir.join("releases");
    let protected_paths = collect_protected_paths(&base_dir, &protected_db_dirs);

    // Also sweep leftover numeric `rel-<id>` directories whose deployment was previously
    // deleted (e.g., if `rel-1` was live when pruned, and can now be cleaned after replacement).
    if let Ok(entries) = fs::read_dir(&releases_root) {
        for entry in entries.flatten() {
            let path = entry.path();
            if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                if let Some(id_str) = name.strip_prefix("rel-") {
                    if let Ok(dep_id) = id_str.parse::<i64>() {
                        if !remaining_dep_ids.contains(&dep_id) {
                            candidate_dirs.push(path);
                        }
                    }
                }
            }
        }
    }

    let mut seen: HashSet<PathBuf> = HashSet::new();
    let mut removed_any_dir = false;
    for cand in candidate_dirs {
        if !seen.insert(cand.clone()) {
            continue;
        }
        if is_safe_prunable_release_dir(&cand, &releases_root, &protected_paths) {
            if safe_remove_release_dir(&cand) {
                removed_any_dir = true;
            }
        }
    }

    if removed_any_dir {
        invalidate_path_disk_cache(&base_dir);
    }

    pruned_count
}

/// Sweep excess deployment records across every existing project (used at startup).
pub fn prune_all_projects(db: &DbPool, keep: usize) -> usize {
    let project_ids: Vec<i64> = {
        let conn = db.lock().unwrap();
        let Ok(mut stmt) = conn.prepare("SELECT id FROM projects") else {
            return 0;
        };
        let Ok(rows) = stmt.query_map([], |r| r.get::<_, i64>(0)) else {
            return 0;
        };
        rows.flatten().collect()
    };

    project_ids
        .into_iter()
        .map(|pid| prune_project_deployments(db, pid, keep))
        .sum()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{now, open_db};

    fn test_temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "webdep-retention-{}-{}",
            name,
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn insert_test_project(db: &DbPool, deploy_dir: &Path, kind: &str) -> i64 {
        let conn = db.lock().unwrap();
        let ts = now();
        let slug = format!(
            "retention-{}-{}",
            ts,
            deploy_dir.file_name().and_then(|s| s.to_str()).unwrap_or("app")
        );
        conn.execute(
            "INSERT INTO projects(name, slug, project_kind, repo_url, branch, deploy_dir, created_at, updated_at) \
             VALUES('Retention Test App', ?, ?, 'https://github.com/example/app', 'main', ?, ?, ?)",
            params![slug, kind, deploy_dir.to_string_lossy().to_string(), ts, ts],
        )
        .unwrap();
        conn.last_insert_rowid()
    }

    #[test]
    fn test_prune_keeps_latest_five_and_cleans_non_live_storage() {
        let root = test_temp_dir("cap5");
        let db = open_db(&root).unwrap();
        let deploy_dir = root.join("apps").join("site");
        let releases_dir = deploy_dir.join("releases");
        fs::create_dir_all(&releases_dir).unwrap();

        // Persistent container DB target outside the release folders
        let container_db_dir = root.join("containers").join("site").join("db");
        fs::create_dir_all(&container_db_dir).unwrap();
        fs::write(container_db_dir.join("app.db"), b"keep-me").unwrap();

        let project_id = insert_test_project(&db, &deploy_dir, "website");
        let mut dep_ids = Vec::new();
        let mut rel_ids = Vec::new();

        for i in 1..=7 {
            let conn = db.lock().unwrap();
            conn.execute(
                "INSERT INTO deployments(project_id, kind, status, stage, trigger, actor, started_at) \
                 VALUES(?, 'deploy', 'success', 'cleanup', 'manual', 'admin', ?)",
                params![project_id, 1000 + i],
            )
            .unwrap();
            let dep_id = conn.last_insert_rowid();
            let rel_path = releases_dir.join(format!("rel-{}", dep_id));
            fs::create_dir_all(&rel_path).unwrap();
            fs::write(rel_path.join("bundle.js"), vec![b'x'; 256]).unwrap();

            // Simulate container `data` mount link on rel-1
            if i == 1 {
                let data_mount = rel_path.join("data");
                #[cfg(windows)]
                {
                    let _ = std::process::Command::new("cmd")
                        .args([
                            "/C",
                            "mklink",
                            "/J",
                            data_mount.to_str().unwrap(),
                            container_db_dir.to_str().unwrap(),
                        ])
                        .output();
                }
                #[cfg(unix)]
                {
                    let _ = std::os::unix::fs::symlink(&container_db_dir, &data_mount);
                }
            }

            conn.execute(
                "INSERT INTO releases(project_id, deployment_id, sha, short_sha, message, author, committed_at, dir, status, created_at) \
                 VALUES(?, ?, ?, ?, 'msg', 'dev', 1000, ?, 'ready', ?)",
                params![
                    project_id,
                    dep_id,
                    format!("sha{}", i),
                    format!("s{}", i),
                    rel_path.to_string_lossy().to_string(),
                    1000 + i
                ],
            )
            .unwrap();
            let rel_id = conn.last_insert_rowid();

            conn.execute(
                "UPDATE deployments SET release_id = ? WHERE id = ?",
                params![rel_id, dep_id],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO logs(project_id, deployment_id, channel, level, message, ts) VALUES(?, ?, 'build', 'info', 'log line', ?)",
                params![project_id, dep_id, 1000 + i],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO backups(project_id, release_id, kind, path, size_bytes, note, created_at) VALUES(?, ?, 'snapshot', ?, 256, 'auto', ?)",
                params![project_id, rel_id, rel_path.to_string_lossy().to_string(), 1000 + i],
            )
            .unwrap();
            if i == 1 {
                conn.execute(
                    "INSERT INTO backups(project_id, release_id, kind, path, size_bytes, note, created_at) VALUES(?, ?, 'manual', 'manual.tar.gz', 100, 'keep', ?)",
                    params![project_id, rel_id, 1000 + i],
                )
                .unwrap();
            }

            dep_ids.push(dep_id);
            rel_ids.push(rel_id);
        }

        // Point live deployment to release #7
        {
            let conn = db.lock().unwrap();
            conn.execute(
                "UPDATE projects SET current_release_id = ? WHERE id = ?",
                params![rel_ids[6], project_id],
            )
            .unwrap();
        }

        let pruned = prune_project_deployments(&db, project_id, MAX_DEPLOYMENT_RECORDS);
        assert_eq!(pruned, 2);

        let conn = db.lock().unwrap();
        let kept_ids: Vec<i64> = {
            let mut stmt = conn
                .prepare("SELECT id FROM deployments WHERE project_id = ? ORDER BY id ASC")
                .unwrap();
            stmt.query_map(params![project_id], |r| r.get(0))
                .unwrap()
                .flatten()
                .collect()
        };
        assert_eq!(kept_ids, dep_ids[2..].to_vec());

        // Logs & non-manual backups for pruned deployments (1 & 2) removed; manual backup preserved with NULL release_id
        let log_count_pruned: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM logs WHERE deployment_id IN (?, ?)",
                params![dep_ids[0], dep_ids[1]],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(log_count_pruned, 0);

        let manual_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM backups WHERE project_id = ? AND kind = 'manual' AND release_id IS NULL",
                params![project_id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(manual_count, 1);

        let auto_backup_pruned: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM backups WHERE project_id = ? AND kind = 'snapshot' AND path LIKE ?",
                params![project_id, format!("%rel-{}", dep_ids[0])],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(auto_backup_pruned, 0);
        drop(conn);

        // Old release dirs deleted; newer 5 intact; persistent container DB intact!
        assert!(!releases_dir.join(format!("rel-{}", dep_ids[0])).exists());
        assert!(!releases_dir.join(format!("rel-{}", dep_ids[1])).exists());
        for d in &dep_ids[2..] {
            assert!(releases_dir.join(format!("rel-{}", d)).exists());
        }
        assert_eq!(fs::read(container_db_dir.join("app.db")).unwrap(), b"keep-me");

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn test_prune_spares_live_dir_until_replaced() {
        let root = test_temp_dir("live-guard");
        let db = open_db(&root).unwrap();
        let deploy_dir = root.join("apps").join("svc");
        let releases_dir = deploy_dir.join("releases");
        let app_dir = deploy_dir.join("app");
        fs::create_dir_all(&releases_dir).unwrap();
        fs::create_dir_all(&app_dir).unwrap();
        fs::write(app_dir.join("index.js"), b"service-code").unwrap();

        let project_id = insert_test_project(&db, &deploy_dir, "website");
        let mut dep_ids = Vec::new();
        let mut rel_ids = Vec::new();

        for i in 1..=6 {
            let conn = db.lock().unwrap();
            conn.execute(
                "INSERT INTO deployments(project_id, kind, status, stage, trigger, actor, started_at) \
                 VALUES(?, 'deploy', 'success', 'cleanup', 'manual', 'admin', ?)",
                params![project_id, 2000 + i],
            )
            .unwrap();
            let dep_id = conn.last_insert_rowid();
            let rel_path = releases_dir.join(format!("rel-{}", dep_id));
            fs::create_dir_all(&rel_path).unwrap();
            conn.execute(
                "INSERT INTO releases(project_id, deployment_id, sha, short_sha, message, author, committed_at, dir, status, created_at) \
                 VALUES(?, ?, ?, ?, 'msg', 'dev', 1000, ?, 'ready', ?)",
                params![
                    project_id,
                    dep_id,
                    format!("sha{}", i),
                    format!("s{}", i),
                    rel_path.to_string_lossy().to_string(),
                    2000 + i
                ],
            )
            .unwrap();
            let rel_id = conn.last_insert_rowid();
            conn.execute(
                "UPDATE deployments SET release_id = ? WHERE id = ?",
                params![rel_id, dep_id],
            )
            .unwrap();
            dep_ids.push(dep_id);
            rel_ids.push(rel_id);
        }

        // Suppose rel-1 was STILL live when #6 started!
        {
            let conn = db.lock().unwrap();
            conn.execute(
                "UPDATE projects SET current_release_id = ? WHERE id = ?",
                params![rel_ids[0], project_id],
            )
            .unwrap();
        }

        prune_project_deployments(&db, project_id, MAX_DEPLOYMENT_RECORDS);
        // Record #1 is removed from deployments (5 records left), but rel-1 dir is spared while live.
        let count: i64 = {
            let conn = db.lock().unwrap();
            conn.query_row(
                "SELECT COUNT(*) FROM deployments WHERE project_id = ?",
                params![project_id],
                |r| r.get(0),
            )
            .unwrap()
        };
        assert_eq!(count, 5);
        assert!(releases_dir.join(format!("rel-{}", dep_ids[0])).exists());
        assert!(app_dir.join("index.js").exists());

        // Now live swaps to rel-6; sweeping on completion removes old rel-1 dir cleanly.
        {
            let conn = db.lock().unwrap();
            conn.execute(
                "UPDATE projects SET current_release_id = ? WHERE id = ?",
                params![rel_ids[5], project_id],
            )
            .unwrap();
        }
        prune_project_deployments(&db, project_id, MAX_DEPLOYMENT_RECORDS);
        assert!(!releases_dir.join(format!("rel-{}", dep_ids[0])).exists());

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn test_create_deployment_immediately_prunes_oldest_on_sixth_start() {
        let root = test_temp_dir("create-dep-cap");
        let db = open_db(&root).unwrap();
        let deploy_dir = root.join("apps").join("myapp");
        let releases_dir = deploy_dir.join("releases");
        fs::create_dir_all(&releases_dir).unwrap();

        let vault = std::sync::Arc::new(crate::vault::Vault::new(&root).unwrap());
        let projects = std::sync::Arc::new(crate::projects::Projects::new(
            db.clone(),
            vault,
            root.clone(),
        ));
        let logs = crate::logs::Logs::new(db.clone());
        let cache = std::sync::Arc::new(crate::cache::AppCache::new());
        let runtime = std::sync::Arc::new(crate::runtime::Runtime::new(db.clone(), logs.clone()));
        let deployer = crate::deployer::Deployer::new(
            db.clone(),
            logs,
            projects.clone(),
            runtime,
            cache,
            root.clone(),
        );

        let project_id = insert_test_project(&db, &deploy_dir, "website");
        let project = projects.get(project_id).unwrap().unwrap();

        let mut created_ids = Vec::new();
        for i in 1..=6 {
            let dep_id = deployer.create_deployment(&project, "deploy", "tester", "manual");
            let rel_dir = releases_dir.join(format!("rel-{}", dep_id));
            fs::create_dir_all(&rel_dir).unwrap();
            fs::write(rel_dir.join("artifact.txt"), format!("build-{}", i)).unwrap();
            created_ids.push(dep_id);

            let listed = deployer.list_deployments(Some(project_id), 20);
            assert!(listed.len() <= MAX_DEPLOYMENT_RECORDS);
        }

        // Starting deployment #6 should have pruned deployment #1 and freed `rel-<id1>` immediately.
        let remaining = deployer.list_deployments(Some(project_id), 20);
        let remaining_ids: Vec<i64> = remaining.into_iter().map(|d| d.id).collect();
        assert_eq!(remaining_ids.len(), 5);
        assert!(!remaining_ids.contains(&created_ids[0]));
        assert!(remaining_ids.contains(&created_ids[5]));
        assert!(!releases_dir.join(format!("rel-{}", created_ids[0])).exists());
        for id in &created_ids[1..] {
            assert!(releases_dir.join(format!("rel-{}", id)).exists());
        }

        let _ = fs::remove_dir_all(&root);
    }
}
