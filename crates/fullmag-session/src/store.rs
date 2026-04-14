//! Internal `SessionStore` — directory-based persistence layer.
//!
//! Layout under `.fullmag/local-live/session-store/`:
//! ```text
//! session-store/
//! ├── CURRENT          // path to the latest session manifest (atomic pointer)
//! ├── LOCK             // workspace-level file lock
//! ├── manifests/       // session manifest JSON files
//! ├── runs/            // per-run directories (manifests, checkpoints)
//! ├── objects/         // CAS blob store
//! │   └── sha256/
//! ├── temp/            // in-flight writes
//! └── recovery/        // crash recovery snapshots
//! ```

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};

use crate::cas::CasStore;
use crate::types::*;

/// The internal session store backed by a directory tree and a CAS.
pub struct SessionStore {
    root: PathBuf,
    cas: CasStore,
}

impl SessionStore {
    /// Open or initialize a `SessionStore` at the given root directory.
    pub fn open(root: impl Into<PathBuf>) -> Result<Self> {
        let root = root.into();
        for sub in &["manifests", "runs", "recovery", "temp"] {
            fs::create_dir_all(root.join(sub))?;
        }
        let cas = CasStore::open(root.join("objects"))?;
        Ok(Self { root, cas })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn cas(&self) -> &CasStore {
        &self.cas
    }

    // ── Sessions ───────────────────────────────────────────────────────

    /// Persist a session manifest and update the `CURRENT` pointer.
    pub fn commit_session(&self, manifest: &FmsSessionManifest) -> Result<()> {
        let json = serde_json::to_vec_pretty(manifest)?;
        let path = self
            .root
            .join("manifests")
            .join(format!("{}.json", manifest.session_id));
        atomic_write(&path, &json)?;
        // Atomically update CURRENT to point to this session.
        let current_path = self.root.join("CURRENT");
        atomic_write(&current_path, manifest.session_id.as_bytes())?;
        Ok(())
    }

    /// Read the currently active session manifest, if any.
    pub fn current_session(&self) -> Result<Option<FmsSessionManifest>> {
        let current_path = self.root.join("CURRENT");
        if !current_path.exists() {
            return Ok(None);
        }
        let session_id = fs::read_to_string(&current_path)?.trim().to_string();
        let manifest_path = self
            .root
            .join("manifests")
            .join(format!("{session_id}.json"));
        if !manifest_path.exists() {
            return Ok(None);
        }
        let data = fs::read(&manifest_path)?;
        let manifest: FmsSessionManifest = serde_json::from_slice(&data)
            .with_context(|| format!("parsing session manifest {}", manifest_path.display()))?;
        Ok(Some(manifest))
    }

    // ── Runs ───────────────────────────────────────────────────────────

    /// Create a run directory and persist a run manifest.
    pub fn commit_run(&self, manifest: &FmsRunManifest) -> Result<()> {
        let run_dir = self.root.join("runs").join(&manifest.run_id);
        fs::create_dir_all(run_dir.join("checkpoints"))?;
        fs::create_dir_all(run_dir.join("artifacts"))?;
        let json = serde_json::to_vec_pretty(manifest)?;
        atomic_write(&run_dir.join("run_manifest.json"), &json)?;
        Ok(())
    }

    /// Read a run manifest.
    pub fn read_run(&self, run_id: &str) -> Result<Option<FmsRunManifest>> {
        let path = self
            .root
            .join("runs")
            .join(run_id)
            .join("run_manifest.json");
        if !path.exists() {
            return Ok(None);
        }
        let data = fs::read(&path)?;
        Ok(Some(serde_json::from_slice(&data)?))
    }

    // ── Checkpoints ────────────────────────────────────────────────────

    /// Persist a checkpoint manifest and its common state.
    pub fn commit_checkpoint(
        &self,
        checkpoint: &FmsCheckpoint,
        common_state: &CommonSolverState,
    ) -> Result<()> {
        let cp_dir = self
            .root
            .join("runs")
            .join(&checkpoint.run_id)
            .join("checkpoints")
            .join(&checkpoint.checkpoint_id);
        fs::create_dir_all(&cp_dir)?;

        let cp_json = serde_json::to_vec_pretty(checkpoint)?;
        atomic_write(&cp_dir.join("checkpoint.json"), &cp_json)?;

        let state_json = serde_json::to_vec_pretty(common_state)?;
        atomic_write(&cp_dir.join("common_state.json"), &state_json)?;

        Ok(())
    }

    /// Read the latest checkpoint for a run.
    pub fn latest_checkpoint(&self, run_id: &str) -> Result<Option<FmsCheckpoint>> {
        let cp_base = self.root.join("runs").join(run_id).join("checkpoints");
        if !cp_base.exists() {
            return Ok(None);
        }
        let mut candidates: Vec<_> = fs::read_dir(&cp_base)?
            .filter_map(|e| e.ok())
            .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
            .collect();
        candidates.sort_by_key(|e| e.file_name());
        if let Some(latest) = candidates.last() {
            let path = latest.path().join("checkpoint.json");
            if path.exists() {
                let data = fs::read(&path)?;
                return Ok(Some(serde_json::from_slice(&data)?));
            }
        }
        Ok(None)
    }

    // ── Tensor storage ─────────────────────────────────────────────────

    /// Store a magnetization vector `Vec<[f64; 3]>` and return the CAS hash.
    pub fn store_magnetization(&self, m: &[[f64; 3]]) -> Result<String> {
        let bytes = magnetization_to_bytes(m);
        self.cas.put(&bytes)
    }

    /// Load magnetization from CAS by hash.
    pub fn load_magnetization(&self, hash: &str) -> Result<Option<Vec<[f64; 3]>>> {
        match self.cas.get(hash)? {
            Some(bytes) => Ok(Some(magnetization_from_bytes(&bytes))),
            None => Ok(None),
        }
    }

    /// Store arbitrary bytes in CAS.
    pub fn store_blob(&self, data: &[u8]) -> Result<String> {
        self.cas.put(data)
    }

    // ── JSON documents ─────────────────────────────────────────────────

    /// Write a JSON document relative to the store root.
    pub fn write_document(&self, relative_path: &str, data: &[u8]) -> Result<()> {
        let path = self.root.join(relative_path);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        atomic_write(&path, data)
    }

    /// Read a JSON document relative to the store root.
    pub fn read_document(&self, relative_path: &str) -> Result<Option<Vec<u8>>> {
        let path = self.root.join(relative_path);
        if !path.exists() {
            return Ok(None);
        }
        Ok(Some(fs::read(&path)?))
    }

    // ── Recovery ───────────────────────────────────────────────────────

    /// Write a crash-recovery snapshot.
    pub fn write_recovery(&self, session: &FmsSessionManifest) -> Result<()> {
        let data = serde_json::to_vec_pretty(session)?;
        let path = self
            .root
            .join("recovery")
            .join(format!("{}.json", session.session_id));
        atomic_write(&path, &data)
    }

    /// List available recovery snapshots.
    pub fn list_recovery(&self) -> Result<Vec<FmsSessionManifest>> {
        let dir = self.root.join("recovery");
        let mut result = Vec::new();
        if dir.exists() {
            for entry in fs::read_dir(&dir)? {
                let entry = entry?;
                if entry.path().extension().and_then(|e| e.to_str()) == Some("json") {
                    let data = fs::read(entry.path())?;
                    if let Ok(manifest) = serde_json::from_slice::<FmsSessionManifest>(&data) {
                        result.push(manifest);
                    }
                }
            }
        }
        result.sort_by(|a, b| b.saved_at.cmp(&a.saved_at));
        Ok(result)
    }

    /// Clear recovery snapshots.
    pub fn clear_recovery(&self) -> Result<()> {
        let dir = self.root.join("recovery");
        if dir.exists() {
            for entry in fs::read_dir(&dir)? {
                let entry = entry?;
                fs::remove_file(entry.path())?;
            }
        }
        Ok(())
    }

    // ── File lock ──────────────────────────────────────────────────────

    /// Attempt to acquire the workspace lock.
    pub fn try_lock(&self, session_id: &str) -> Result<bool> {
        let lock_path = self.root.join("LOCK");
        if lock_path.exists() {
            let data = fs::read_to_string(&lock_path)?;
            if let Ok(lock) = serde_json::from_str::<SessionFileLock>(&data) {
                // Check if the process that holds the lock is still alive.
                if is_pid_alive(lock.pid) {
                    return Ok(false);
                }
                // Stale lock — remove it.
                tracing::warn!(
                    old_pid = lock.pid,
                    old_host = %lock.host,
                    "removing stale session lock"
                );
            }
        }
        let lock = SessionFileLock {
            session_id: session_id.into(),
            host: hostname(),
            pid: std::process::id(),
            locked_at: chrono::Utc::now(),
            user: whoami(),
        };
        let data = serde_json::to_vec_pretty(&lock)?;
        atomic_write(&lock_path, &data)?;
        Ok(true)
    }

    /// Release the workspace lock.
    pub fn unlock(&self) -> Result<()> {
        let lock_path = self.root.join("LOCK");
        if lock_path.exists() {
            fs::remove_file(&lock_path)?;
        }
        Ok(())
    }

    // ── GC ─────────────────────────────────────────────────────────────

    /// Collect object hashes referenced by all known checkpoints.
    pub fn collect_live_refs(&self) -> Result<HashSet<String>> {
        let mut refs = HashSet::new();
        let runs_dir = self.root.join("runs");
        if runs_dir.exists() {
            for entry in fs::read_dir(&runs_dir)? {
                let entry = entry?;
                let cp_dir = entry.path().join("checkpoints");
                if cp_dir.exists() {
                    for cp_entry in fs::read_dir(&cp_dir)? {
                        let cp_entry = cp_entry?;
                        let cp_path = cp_entry.path().join("checkpoint.json");
                        if cp_path.exists() {
                            let data = fs::read(&cp_path)?;
                            if let Ok(cp) = serde_json::from_slice::<FmsCheckpoint>(&data) {
                                for field_ref in &cp.field_refs {
                                    // Extract object hash from tensor descriptor ref.
                                    refs.insert(field_ref.tensor_descriptor_ref.clone());
                                }
                            }
                        }
                    }
                }
            }
        }
        Ok(refs)
    }

    /// Run garbage collection on the CAS.
    pub fn gc(&self) -> Result<usize> {
        let live = self.collect_live_refs()?;
        self.cas.gc(&live)
    }
}

// ── Helpers ────────────────────────────────────────────────────────────

/// Atomic write: write to temp then rename.
fn atomic_write(dest: &Path, data: &[u8]) -> Result<()> {
    let temp = dest.with_extension("part");
    fs::write(&temp, data).with_context(|| format!("writing {}", temp.display()))?;
    fs::rename(&temp, dest)
        .with_context(|| format!("renaming {} → {}", temp.display(), dest.display()))?;
    Ok(())
}

/// Serialize magnetization to little-endian f64 bytes.
fn magnetization_to_bytes(m: &[[f64; 3]]) -> Vec<u8> {
    let mut buf = Vec::with_capacity(m.len() * 3 * 8);
    for cell in m {
        for component in cell {
            buf.extend_from_slice(&component.to_le_bytes());
        }
    }
    buf
}

/// Deserialize magnetization from little-endian f64 bytes.
fn magnetization_from_bytes(data: &[u8]) -> Vec<[f64; 3]> {
    let n = data.len() / 24; // 3 components * 8 bytes each
    let mut m = Vec::with_capacity(n);
    for i in 0..n {
        let off = i * 24;
        let mx = f64::from_le_bytes(data[off..off + 8].try_into().unwrap());
        let my = f64::from_le_bytes(data[off + 8..off + 16].try_into().unwrap());
        let mz = f64::from_le_bytes(data[off + 16..off + 24].try_into().unwrap());
        m.push([mx, my, mz]);
    }
    m
}

fn hostname() -> String {
    std::env::var("HOSTNAME")
        .or_else(|_| std::env::var("HOST"))
        .unwrap_or_else(|_| "unknown".into())
}

fn whoami() -> String {
    std::env::var("USER")
        .or_else(|_| std::env::var("USERNAME"))
        .unwrap_or_else(|_| "unknown".into())
}

#[cfg(unix)]
fn is_pid_alive(pid: u32) -> bool {
    unsafe { libc::kill(pid as i32, 0) == 0 }
}

#[cfg(not(unix))]
fn is_pid_alive(_pid: u32) -> bool {
    // Conservatively assume alive on non-Unix.
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn magnetization_round_trip() {
        let m = vec![[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]];
        let bytes = magnetization_to_bytes(&m);
        let m2 = magnetization_from_bytes(&bytes);
        assert_eq!(m, m2);
    }

    #[test]
    fn session_store_lifecycle() {
        let dir = tempfile::tempdir().unwrap();
        let store = SessionStore::open(dir.path().join("session-store")).unwrap();

        // No current session initially.
        assert!(store.current_session().unwrap().is_none());

        // Create and commit a session.
        let manifest = FmsSessionManifest::new("test-001", "Test Session", SaveProfile::Compact);
        store.commit_session(&manifest).unwrap();

        let loaded = store.current_session().unwrap().unwrap();
        assert_eq!(loaded.session_id, "test-001");
        assert_eq!(loaded.profile, SaveProfile::Compact);
    }

    #[test]
    fn checkpoint_lifecycle() {
        let dir = tempfile::tempdir().unwrap();
        let store = SessionStore::open(dir.path().join("session-store")).unwrap();

        let run = FmsRunManifest {
            run_id: "run-001".into(),
            status: RunStatus::Running,
            study_kind: "time_evolution".into(),
            backend: "cpu".into(),
            precision: "f64".into(),
            started_at: chrono::Utc::now(),
            finished_at: None,
            total_steps: 0,
            total_time_s: 0.0,
            plan_ref: None,
            live_state_ref: None,
            latest_checkpoint_ref: None,
            artifact_index_ref: None,
        };
        store.commit_run(&run).unwrap();

        // Store magnetization and create checkpoint.
        let m = vec![[1.0, 0.0, 0.0]; 100];
        let m_hash = store.store_magnetization(&m).unwrap();

        let cp = FmsCheckpoint::new("run-001", 42, 1e-9, 1e-13);
        let state = CommonSolverState {
            step: 42,
            time_s: 1e-9,
            dt: 1e-13,
            energies: SolverEnergies::default(),
            magnetization_ref: Some(m_hash.clone()),
        };
        store.commit_checkpoint(&cp, &state).unwrap();

        let latest = store.latest_checkpoint("run-001").unwrap().unwrap();
        assert_eq!(latest.step, 42);

        // Load magnetization back.
        let loaded_m = store.load_magnetization(&m_hash).unwrap().unwrap();
        assert_eq!(loaded_m.len(), 100);
        assert_eq!(loaded_m[0], [1.0, 0.0, 0.0]);
    }
}
