//! Internal `SessionStore` — directory-based persistence layer.
//!
//! Layout under `.fullmag/local-live/session-store/`:
//! ```text
//! session-store/
//! ├── CURRENT          // path to the latest session manifest (atomic pointer)
//! ├── WRITER.lock      // stable native lock descriptor
//! ├── WRITER.owner.json // atomic owner metadata
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
use std::sync::{Arc, Mutex};

use anyhow::{Context, Result};

use crate::cas::CasStore;
use crate::durability::{atomic_write, sync_directory};
use crate::repository_path::{checked_path, create_parent, reject_link, validate_store_id};
use crate::types::*;
use crate::writer::{WriteTransaction, Writer};

/// The internal session store backed by a directory tree and a CAS.
pub struct SessionStore {
    root: PathBuf,
    cas: CasStore,
    writer: Arc<Writer>,
    explicit_lease: Mutex<Option<WriteTransaction>>,
}

impl SessionStore {
    /// Open or initialize a `SessionStore` at the given root directory.
    pub fn open(root: impl Into<PathBuf>) -> Result<Self> {
        let root = root.into();
        reject_link(&root)?;
        crate::writer::require_local_filesystem(&root)?;
        fs::create_dir_all(&root)?;
        let root = fs::canonicalize(root)?;
        let writer = Writer::new(root.clone());
        let mut initialized = true;
        for sub in [
            "manifests",
            "runs",
            "recovery",
            "temp",
            "objects/sha256",
            "objects/pins",
        ] {
            initialized &= checked_path(&root, sub)?.is_dir();
        }
        if !initialized {
            let _lease = writer.acquire()?;
            for sub in ["manifests", "runs", "recovery", "temp", "objects"] {
                fs::create_dir_all(checked_path(&root, sub)?)?;
            }
            let _ = CasStore::with_writer(checked_path(&root, "objects")?, writer.clone())?;
            sync_directory(&root)?;
        }
        let cas = CasStore::existing(checked_path(&root, "objects")?, writer.clone())?;
        Ok(Self {
            root,
            cas,
            writer,
            explicit_lease: Mutex::new(None),
        })
    }

    /// Open without creating repository directories or files. Mutations still
    /// require the same writer lease; useful for inspection and GC previews.
    pub fn open_existing(root: impl Into<PathBuf>) -> Result<Self> {
        let root = root.into();
        reject_link(&root)?;
        let root = fs::canonicalize(root)?;
        let writer = Writer::new(root.clone());
        let cas = CasStore::existing(checked_path(&root, "objects")?, writer.clone())?;
        Ok(Self {
            root,
            cas,
            writer,
            explicit_lease: Mutex::new(None),
        })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn cas(&self) -> &CasStore {
        &self.cas
    }

    /// Bind a multi-file operation to one native writer lease.
    pub fn write_transaction(&self) -> Result<WriteTransaction> {
        self.writer.acquire()
    }

    // ── Sessions ───────────────────────────────────────────────────────

    /// Persist a session manifest and update the `CURRENT` pointer.
    pub fn commit_session(&self, manifest: &FmsSessionManifest) -> Result<()> {
        validate_store_id(&manifest.session_id)?;
        if manifest.format != "fullmag.session.v1" {
            anyhow::bail!("unsupported session schema");
        }
        let _lease = self.write_transaction()?;
        validate_session_references(&self.root, manifest)?;
        let json = serde_json::to_vec_pretty(manifest)?;
        // Immutable generation: a crash cannot update a manifest behind the
        // old CURRENT pointer before the new generation is committed.
        let generation = format!("generation-{}", uuid::Uuid::new_v4());
        let path = create_parent(&self.root, &format!("manifests/{generation}.json"))?;
        atomic_write(&path, &json)?;
        // Atomically update CURRENT to point to this session.
        let current_path = checked_path(&self.root, "CURRENT")?;
        atomic_write(&current_path, generation.as_bytes())?;
        Ok(())
    }

    /// Read the currently active session manifest, if any.
    pub fn current_session(&self) -> Result<Option<FmsSessionManifest>> {
        let current_path = checked_path(&self.root, "CURRENT")?;
        if !current_path.exists() {
            return Ok(None);
        }
        let session_id = fs::read_to_string(&current_path)?.trim().to_string();
        validate_store_id(&session_id)?;
        let manifest_path = checked_path(&self.root, &format!("manifests/{session_id}.json"))?;
        if !manifest_path.exists() {
            anyhow::bail!("CURRENT points to a missing manifest");
        }
        let data = fs::read(&manifest_path)?;
        let manifest: FmsSessionManifest = serde_json::from_slice(&data)
            .with_context(|| format!("parsing session manifest {}", manifest_path.display()))?;
        validate_store_id(&manifest.session_id)?;
        if manifest.format != "fullmag.session.v1"
            || (!session_id.starts_with("generation-") && session_id != manifest.session_id)
        {
            anyhow::bail!("CURRENT manifest identity or schema mismatch");
        }
        Ok(Some(manifest))
    }

    // ── Runs ───────────────────────────────────────────────────────────

    /// Create a run directory and persist a run manifest.
    pub fn commit_run(&self, manifest: &FmsRunManifest) -> Result<()> {
        validate_store_id(&manifest.run_id)?;
        let _lease = self.write_transaction()?;
        for reference in [
            &manifest.plan_ref,
            &manifest.live_state_ref,
            &manifest.latest_checkpoint_ref,
            &manifest.artifact_index_ref,
        ]
        .into_iter()
        .flatten()
        {
            if !reference.starts_with(&format!("runs/{}/", manifest.run_id)) {
                anyhow::bail!("run reference must belong to its run");
            }
            if !checked_path(&self.root, reference)?.is_file() {
                anyhow::bail!("run reference is missing: {reference}");
            }
        }
        if let Some(reference) = &manifest.latest_checkpoint_ref {
            let prefix = format!("runs/{}/checkpoints/", manifest.run_id);
            let id = reference
                .strip_prefix(&prefix)
                .and_then(|rest| rest.strip_suffix("/checkpoint.json"))
                .context("invalid latest checkpoint reference")?;
            self.read_checkpoint(&manifest.run_id, id)?
                .context("latest checkpoint is missing")?;
        }
        let relative = format!("runs/{}/run_manifest.json", manifest.run_id);
        let path = create_parent(&self.root, &relative)?;
        for child in ["checkpoints", "artifacts"] {
            fs::create_dir_all(checked_path(
                &self.root,
                &format!("runs/{}/{child}", manifest.run_id),
            )?)?;
        }
        let json = serde_json::to_vec_pretty(manifest)?;
        atomic_write(&path, &json)?;
        Ok(())
    }

    /// Read a run manifest.
    pub fn read_run(&self, run_id: &str) -> Result<Option<FmsRunManifest>> {
        validate_store_id(run_id)?;
        let path = checked_path(&self.root, &format!("runs/{run_id}/run_manifest.json"))?;
        if !path.exists() {
            return Ok(None);
        }
        let data = fs::read(&path)?;
        let manifest: FmsRunManifest = serde_json::from_slice(&data)?;
        if manifest.run_id != run_id {
            anyhow::bail!("run manifest identity does not match its path");
        }
        Ok(Some(manifest))
    }

    // ── Checkpoints ────────────────────────────────────────────────────

    /// Persist a checkpoint manifest and its common state.
    pub fn commit_checkpoint(
        &self,
        checkpoint: &FmsCheckpoint,
        common_state: &CommonSolverState,
    ) -> Result<()> {
        validate_store_id(&checkpoint.run_id)?;
        validate_store_id(&checkpoint.checkpoint_id)?;
        let prefix = format!(
            "runs/{}/checkpoints/{}",
            checkpoint.run_id, checkpoint.checkpoint_id
        );
        if checkpoint.common_state_ref != format!("{prefix}/common_state.json") {
            anyhow::bail!("checkpoint common state must be owned by the checkpoint");
        }
        if checkpoint.step != common_state.step
            || checkpoint.time_s != common_state.time_s
            || checkpoint.dt != common_state.dt
        {
            anyhow::bail!("checkpoint/common-state identity mismatch");
        }
        let _lease = self.write_transaction()?;
        let path = create_parent(&self.root, &format!("{prefix}/checkpoint.json"))?;
        if path.exists() {
            anyhow::bail!("checkpoint is immutable; capture a new checkpoint ID");
        }
        // The state and all referenced payloads precede the commit marker.
        let state_json = serde_json::to_vec_pretty(common_state)?;
        atomic_write(
            &checked_path(&self.root, &checkpoint.common_state_ref)?,
            &state_json,
        )?;
        crate::reachability::walk_checkpoint(&self.root, checkpoint)?.require_complete()?;
        let cp_json = serde_json::to_vec_pretty(checkpoint)?;
        atomic_write(&path, &cp_json)?;
        Ok(())
    }

    /// Read the latest checkpoint for a run.
    pub fn latest_checkpoint(&self, run_id: &str) -> Result<Option<FmsCheckpoint>> {
        let checkpoints = self.list_checkpoints(run_id)?;
        Ok(checkpoints.into_iter().last())
    }

    /// Read committed checkpoints ordered by step and capture time.
    pub fn list_checkpoints(&self, run_id: &str) -> Result<Vec<FmsCheckpoint>> {
        validate_store_id(run_id)?;
        let cp_base = checked_path(&self.root, &format!("runs/{run_id}/checkpoints"))?;
        if !cp_base.exists() {
            return Ok(Vec::new());
        }
        let mut candidates = fs::read_dir(&cp_base)?.collect::<std::io::Result<Vec<_>>>()?;
        candidates.sort_by_key(|e| e.file_name());

        let mut checkpoints = Vec::new();
        for candidate in candidates {
            let id = candidate
                .file_name()
                .into_string()
                .map_err(|_| anyhow::anyhow!("invalid checkpoint directory"))?;
            if let Some(checkpoint) = self.read_checkpoint(run_id, &id)? {
                checkpoints.push(checkpoint);
            }
        }
        checkpoints.sort_by(|a, b| {
            a.step
                .cmp(&b.step)
                .then(a.created_at.cmp(&b.created_at))
                .then(a.checkpoint_id.cmp(&b.checkpoint_id))
        });
        Ok(checkpoints)
    }

    /// Read one checkpoint for a run.
    pub fn read_checkpoint(
        &self,
        run_id: &str,
        checkpoint_id: &str,
    ) -> Result<Option<FmsCheckpoint>> {
        validate_store_id(run_id)?;
        validate_store_id(checkpoint_id)?;
        let prefix = format!("runs/{run_id}/checkpoints/{checkpoint_id}");
        let path = checked_path(&self.root, &format!("{prefix}/checkpoint.json"))?;
        if !path.exists() {
            return Ok(None);
        }
        let data = fs::read(&path)?;
        let checkpoint: FmsCheckpoint = serde_json::from_slice(&data)?;
        if checkpoint.run_id != run_id
            || checkpoint.checkpoint_id != checkpoint_id
            || checkpoint.common_state_ref != format!("{prefix}/common_state.json")
        {
            anyhow::bail!("checkpoint path/content identity mismatch");
        }
        let state_bytes = self
            .read_document(&checkpoint.common_state_ref)?
            .context("checkpoint common state is missing")?;
        let state: CommonSolverState = serde_json::from_slice(&state_bytes)?;
        if state.step != checkpoint.step
            || state.time_s != checkpoint.time_s
            || state.dt != checkpoint.dt
        {
            anyhow::bail!("checkpoint/common-state identity mismatch");
        }
        crate::reachability::walk_checkpoint(&self.root, &checkpoint)?.require_complete()?;
        Ok(Some(checkpoint))
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
            Some(bytes) => {
                if bytes.len() % 24 != 0 {
                    anyhow::bail!("truncated f64 magnetization payload");
                }
                Ok(Some(magnetization_from_bytes(&bytes)))
            }
            None => Ok(None),
        }
    }

    /// Store arbitrary bytes in CAS.
    pub fn store_blob(&self, data: &[u8]) -> Result<String> {
        self.cas.put(data)
    }

    // ── JSON documents ─────────────────────────────────────────────────

    /// Write a project document. Control records use validated dedicated writers.
    pub fn write_document(&self, relative_path: &str, data: &[u8]) -> Result<()> {
        if !relative_path.starts_with("project/") {
            anyhow::bail!("public document writes must stay within project/");
        }
        self.write_import_document(relative_path, data)
    }

    /// Internal import adapter; only call after validating the complete archive.
    pub(crate) fn write_import_document(&self, relative_path: &str, data: &[u8]) -> Result<()> {
        validate_document_namespace(relative_path)?;
        let _lease = self.write_transaction()?;
        let components: Vec<_> = relative_path.split('/').collect();
        if components.len() >= 5 && components[0] == "runs" && components[2] == "checkpoints" {
            validate_store_id(components[1])?;
            validate_store_id(components[3])?;
            let marker = format!(
                "runs/{}/checkpoints/{}/checkpoint.json",
                components[1], components[3]
            );
            if checked_path(&self.root, &marker)?.exists() {
                anyhow::bail!("committed checkpoint documents are immutable");
            }
        }
        let path = create_parent(&self.root, relative_path)?;
        atomic_write(&path, data)
    }

    pub(crate) fn write_checkpoint_payload(
        &self,
        checkpoint: &FmsCheckpoint,
        name: &str,
        data: &[u8],
    ) -> Result<()> {
        validate_store_id(&checkpoint.run_id)?;
        validate_store_id(&checkpoint.checkpoint_id)?;
        if !matches!(
            name,
            "backend_state.json" | "integrator_state.json" | "rng_state.json"
        ) {
            anyhow::bail!("unsupported checkpoint payload document");
        }
        self.write_import_document(
            &format!(
                "runs/{}/checkpoints/{}/{name}",
                checkpoint.run_id, checkpoint.checkpoint_id
            ),
            data,
        )
    }

    /// Read a JSON document relative to the store root.
    pub fn read_document(&self, relative_path: &str) -> Result<Option<Vec<u8>>> {
        let path = checked_path(&self.root, relative_path)?;
        if !path.exists() {
            return Ok(None);
        }
        Ok(Some(fs::read(&path)?))
    }

    /// Snapshot portable project files, preserving scripts, UI, assets and unknown documents.
    pub fn project_documents(&self) -> Result<std::collections::HashMap<String, Vec<u8>>> {
        let _lease = self.write_transaction()?;
        fn visit(
            store: &SessionStore,
            relative: &str,
            output: &mut std::collections::HashMap<String, Vec<u8>>,
        ) -> Result<()> {
            let path = checked_path(store.root(), relative)?;
            if !path.exists() {
                return Ok(());
            }
            if path.is_dir() {
                for entry in fs::read_dir(path)? {
                    let name = entry?
                        .file_name()
                        .into_string()
                        .map_err(|_| anyhow::anyhow!("non-UTF8 project path"))?;
                    visit(store, &format!("{relative}/{name}"), output)?;
                }
            } else if path.is_file() {
                output.insert(relative.to_owned(), fs::read(path)?);
            } else {
                anyhow::bail!("unsupported project document");
            }
            Ok(())
        }
        let mut output = std::collections::HashMap::new();
        visit(self, "project", &mut output)?;
        Ok(output)
    }

    // ── Recovery ───────────────────────────────────────────────────────

    /// Write a crash-recovery snapshot.
    pub fn write_recovery(&self, session: &FmsSessionManifest) -> Result<()> {
        validate_store_id(&session.session_id)?;
        if session.format != "fullmag.session.v1" {
            anyhow::bail!("unsupported recovery schema");
        }
        let _lease = self.write_transaction()?;
        let data = serde_json::to_vec_pretty(session)?;
        let path = create_parent(&self.root, &format!("recovery/{}.json", session.session_id))?;
        atomic_write(&path, &data)
    }

    /// List available recovery snapshots.
    pub fn list_recovery(&self) -> Result<Vec<FmsSessionManifest>> {
        let dir = checked_path(&self.root, "recovery")?;
        let mut result = Vec::new();
        if dir.exists() {
            for entry in fs::read_dir(&dir)? {
                let entry = entry?;
                if entry.path().extension().and_then(|e| e.to_str()) == Some("json") {
                    reject_link(&entry.path())?;
                    let data = fs::read(entry.path())?;
                    let manifest: FmsSessionManifest = serde_json::from_slice(&data)?;
                    validate_store_id(&manifest.session_id)?;
                    if manifest.format != "fullmag.session.v1" {
                        anyhow::bail!("unknown recovery schema");
                    }
                    result.push(manifest);
                }
            }
        }
        result.sort_by(|a, b| b.saved_at.cmp(&a.saved_at));
        Ok(result)
    }

    /// Clear recovery snapshots.
    pub fn clear_recovery(&self) -> Result<()> {
        let _lease = self.write_transaction()?;
        let dir = checked_path(&self.root, "recovery")?;
        if dir.exists() {
            for entry in fs::read_dir(&dir)? {
                let entry = entry?;
                reject_link(&entry.path())?;
                fs::remove_file(entry.path())?;
            }
        }
        sync_directory(&dir)
    }

    // ── File lock ──────────────────────────────────────────────────────

    /// Attempt to acquire the workspace lock.
    pub fn try_lock(&self, session_id: &str) -> Result<bool> {
        validate_store_id(session_id)?;
        let mut slot = self
            .explicit_lease
            .lock()
            .map_err(|_| anyhow::anyhow!("lease mutex poisoned"))?;
        if slot.is_some() {
            return Ok(false);
        }
        match self.write_transaction() {
            Ok(lease) => {
                *slot = Some(lease);
                Ok(true)
            }
            Err(error) if error.to_string().contains("writer is busy") => Ok(false),
            Err(error) => Err(error),
        }
    }

    /// Release the workspace lock.
    pub fn unlock(&self) -> Result<()> {
        let mut slot = self
            .explicit_lease
            .lock()
            .map_err(|_| anyhow::anyhow!("lease mutex poisoned"))?;
        let lease = slot
            .take()
            .context("this store does not own an explicit writer lease")?;
        drop(lease);
        Ok(())
    }

    // ── GC ─────────────────────────────────────────────────────────────

    /// Collect object hashes referenced by all known checkpoints.
    pub fn collect_live_refs(&self) -> Result<HashSet<String>> {
        let _lease = self.write_transaction()?;
        let report = crate::reachability::walk_store_root(
            &self.root,
            crate::reachability::ReachabilityMode::Gc,
        )?;
        if !report.complete {
            anyhow::bail!("incomplete reference graph; GC blocked");
        }
        let mut refs = report.object_refs;
        refs.extend(self.cas.pinned_refs()?);
        Ok(refs)
    }

    /// Compatibility entry point: preview only, never an implicit apply.
    pub fn gc(&self) -> Result<usize> {
        Ok(self.gc_preview()?.candidates.len())
    }

    /// Produce a reviewable preview without deleting objects.
    pub fn gc_preview(&self) -> Result<GcPlan> {
        let _lease = self.write_transaction()?;
        let live = self.collect_live_refs()?;
        let mut candidates = Vec::new();
        for hash in self.cas.list()? {
            if !live.contains(&hash) {
                self.cas.get(&hash)?.context("CAS candidate disappeared")?;
                candidates.push(hash);
            }
        }
        candidates.sort();
        Ok(GcPlan {
            schema: "fullmag.gc-plan.v1".into(),
            root: self.root.clone(),
            generation: repository_generation(&self.root)?,
            candidates,
        })
    }

    /// Re-mark under the same exclusive lease immediately before any sweep.
    pub fn gc_apply(&self, scope: &Path, plan: &GcPlan) -> Result<usize> {
        let _lease = self.write_transaction()?;
        if fs::canonicalize(scope)? != self.root
            || plan.root != self.root
            || plan.schema != "fullmag.gc-plan.v1"
        {
            anyhow::bail!("GC scope does not match the reviewed plan");
        }
        let fresh = self.gc_preview()?;
        if &fresh != plan {
            anyhow::bail!("GC generation changed; produce and review a new preview");
        }
        for hash in &fresh.candidates {
            self.cas.remove_verified(hash)?;
        }
        Ok(fresh.candidates.len())
    }

    /// Retire pins backed by immutable checkpoint roots. Mutable recovery/run
    /// records alone cannot retire another in-flight ingest's hash pin.
    pub fn release_published_pins(&self) -> Result<()> {
        let _lease = self.write_transaction()?;
        let graph = crate::reachability::walk_store_root(
            &self.root,
            crate::reachability::ReachabilityMode::Gc,
        )?;
        if !graph.complete {
            anyhow::bail!("incomplete reference graph; retain pins");
        }
        let mut permanent = HashSet::new();
        for reference in &graph.file_refs {
            if !reference.ends_with("/checkpoint.json") {
                continue;
            }
            let parts: Vec<_> = reference.split('/').collect();
            if parts.len() != 5 || parts[0] != "runs" || parts[2] != "checkpoints" {
                continue;
            }
            let checkpoint = self
                .read_checkpoint(parts[1], parts[3])?
                .context("checkpoint disappeared under lease")?;
            permanent
                .extend(crate::reachability::walk_checkpoint(&self.root, &checkpoint)?.object_refs);
        }
        self.cas.release_referenced_pins(&permanent)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct GcPlan {
    pub schema: String,
    pub root: PathBuf,
    pub generation: String,
    pub candidates: Vec<String>,
}

fn repository_generation(root: &Path) -> Result<String> {
    fn visit(root: &Path, path: &Path, entries: &mut Vec<(String, String)>) -> Result<()> {
        reject_link(path)?;
        let mut children = fs::read_dir(path)?.collect::<std::io::Result<Vec<_>>>()?;
        children.sort_by_key(|entry| entry.file_name());
        for child in children {
            let path = child.path();
            let relative = path
                .strip_prefix(root)?
                .to_str()
                .context("non-UTF8 repository path")?
                .replace('\\', "/");
            if matches!(relative.as_str(), "WRITER.lock" | "WRITER.owner.json") {
                continue;
            }
            reject_link(&path)?;
            if child.file_type()?.is_dir() {
                visit(root, &path, entries)?;
            } else if child.file_type()?.is_file() {
                entries.push((relative, crate::cas::hex_sha256(&fs::read(path)?)));
            } else {
                anyhow::bail!("unsupported repository entry");
            }
        }
        Ok(())
    }
    let mut entries = Vec::new();
    visit(root, root, &mut entries)?;
    Ok(crate::cas::hex_sha256(&serde_json::to_vec(&entries)?))
}

fn validate_session_references(root: &Path, manifest: &FmsSessionManifest) -> Result<()> {
    if manifest.workspace_ref != "manifest/workspace.json"
        || manifest.export_profile_ref != "manifest/export_profile.json"
    {
        anyhow::bail!("unsupported session workspace or export profile reference");
    }
    let mut seen = HashSet::new();
    for reference in &manifest.run_refs {
        let id = reference
            .strip_prefix("runs/")
            .and_then(|rest| rest.strip_suffix("/run_manifest.json"))
            .context("invalid session run reference")?;
        validate_store_id(id)?;
        if !seen.insert(id) {
            anyhow::bail!("duplicate session run reference");
        }
        let path = checked_path(root, reference)?;
        let run: FmsRunManifest =
            serde_json::from_slice(&fs::read(path).context("session references a missing run")?)?;
        if run.run_id != id {
            anyhow::bail!("session run reference identity mismatch");
        }
    }
    Ok(())
}

fn validate_document_namespace(relative: &str) -> Result<()> {
    crate::repository_path::validate_relative_path(relative)?;
    if !matches!(
        relative.split('/').next(),
        Some("project" | "manifest" | "runs" | "recovery")
    ) {
        anyhow::bail!("document writer cannot modify repository control files or CAS");
    }
    Ok(())
}

// ── Helpers ────────────────────────────────────────────────────────────

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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn interrupted_checkpoint_never_publishes_a_marker() {
        let dir = tempfile::tempdir().unwrap();
        let store = SessionStore::open(dir.path().join("store")).unwrap();
        let cp = FmsCheckpoint::new("run-1", 1, 0.0, 1e-12);
        let state = CommonSolverState {
            step: 1,
            time_s: 0.0,
            dt: 1e-12,
            energies: SolverEnergies::default(),
            magnetization_ref: None,
        };
        crate::durability::fail_publication_after(1);
        assert!(store.commit_checkpoint(&cp, &state).is_err());
        assert!(store.read_document(&cp.common_state_ref).unwrap().is_some());
        assert!(store.latest_checkpoint("run-1").unwrap().is_none());
        store.commit_checkpoint(&cp, &state).unwrap();
        assert_eq!(store.latest_checkpoint("run-1").unwrap().unwrap().step, 1);
    }

    #[test]
    fn interrupted_session_pointer_preserves_previous_generation() {
        let dir = tempfile::tempdir().unwrap();
        let store = SessionStore::open(dir.path().join("store")).unwrap();
        let first = FmsSessionManifest::new("one", "first", SaveProfile::Compact);
        store.commit_session(&first).unwrap();
        crate::durability::fail_publication_after(1);
        let second = FmsSessionManifest::new("two", "candidate", SaveProfile::Compact);
        assert!(store.commit_session(&second).is_err());
        assert_eq!(store.current_session().unwrap().unwrap().session_id, "one");
    }

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
