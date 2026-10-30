//! Owned per-run output reservation and temporary-directory lifecycle.
//! Results are removed by this owner only under the explicit `overwrite`
//! collision policy, and only when the existing directory is an inactive
//! fullmag result. Only a marked private scratch directory can be cleaned,
//! after the caller has joined its run workers.

use fullmag_ir::{ExistingOutputIR, OutputDataFormatIR, OutputStorageIR, ProblemIR, TempCleanupIR};
use serde::Serialize;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Component, Path, PathBuf};

const OWNER_FILE: &str = ".fullmag-tmp-owner.json";
const ACTIVE_FILE: &str = ".fullmag-active.lock";
const RESERVATION_GATE_SUFFIX: &str = ".fullmag-reservation.lock";

struct ReservationGate {
    path: PathBuf,
    token: String,
    file: Option<File>,
    ancestor_gates: Vec<(PathBuf, String)>,
}

impl ReservationGate {
    #[cfg(test)]
    fn acquire(output: &Path) -> Result<Self, String> {
        Self::try_acquire(output, &[])?.ok_or_else(|| {
            format!("an active run reservation is present: {}", output.display())
        })
    }

    fn try_acquire(output: &Path, ancestors: &[Self]) -> Result<Option<Self>, String> {
        let path = reservation_gate_path(output)?;
        ensure_no_reparse_ancestors(&path)?;
        let file = match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
        {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => return Ok(None),
            Err(error) => return Err(message(error)),
        };
        let mut gate = Self {
            path,
            token: uuid::Uuid::new_v4().to_string(),
            file: Some(file),
            ancestor_gates: ancestors.iter()
                .map(|gate| (gate.path.clone(), gate.token.clone()))
                .collect(),
        };
        let file = gate.file.as_mut().expect("created reservation gate");
        file.write_all(gate.token.as_bytes()).map_err(message)?;
        file.sync_all().map_err(message)?;
        gate.verify_identity()?;
        Ok(Some(gate))
    }

    fn verify_identity(&self) -> Result<(), String> {
        verify_ancestor_gates(&self.path, &self.ancestor_gates)?;
        ensure_no_reparse_ancestors(&self.path)?;
        if !fs::symlink_metadata(&self.path).map_err(message)?.is_file()
            || fs::read_to_string(&self.path).map_err(message)? != self.token
        {
            return Err("result preparation gate ownership changed; retained".into());
        }
        Ok(())
    }
}

impl Drop for ReservationGate {
    fn drop(&mut self) {
        let owned = self.verify_identity().is_ok();
        self.file.take();
        if owned {
            let _ = fs::remove_file(&self.path);
        }
    }
}

fn reservation_gate_path(output: &Path) -> Result<PathBuf, String> {
    let name = output.file_name().ok_or("output directory has no name")?;
    let mut gate_name = std::ffi::OsString::from(".");
    gate_name.push(name);
    gate_name.push(RESERVATION_GATE_SUFFIX);
    Ok(output.with_file_name(gate_name))
}

fn reservation_path_exists(path: &Path) -> Result<bool, String> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(message(error)),
    }
}

fn acquire_result_ancestor_gates(output: &Path) -> Result<Vec<ReservationGate>, String> {
    let mut ancestors: Vec<_> = output.ancestors().skip(1).collect();
    ancestors.reverse();
    let mut gates = Vec::new();
    for ancestor in ancestors {
        if ancestor.file_name().is_none() {
            continue;
        }
        let gate_path = reservation_gate_path(ancestor)?;
        // Check again after metadata reads: a remover can erase the metadata
        // while holding its sibling gate outside the tree being removed.
        if reservation_path_exists(&gate_path)?
            || reservation_path_exists(&ancestor.join(ACTIVE_FILE))?
            || is_fullmag_result_directory(ancestor)
            || reservation_path_exists(&gate_path)?
        {
            let gate = ReservationGate::try_acquire(ancestor, &gates)?
                .ok_or_else(|| format!(
                    "an active run reservation is present: {}", ancestor.display()
                ))?;
            gates.push(gate);
        }
    }
    Ok(gates)
}

fn verify_ancestor_gates(path: &Path, gates: &[(PathBuf, String)]) -> Result<(), String> {
    for ancestor in path.ancestors().skip(1) {
        if ancestor.file_name().is_none() {
            continue;
        }
        let path = reservation_gate_path(ancestor)?;
        if reservation_path_exists(&path)? {
            let owned = gates.iter().any(|(owned_path, token)| {
                *owned_path == path && fs::read_to_string(&path).ok().as_deref() == Some(token.as_str())
            });
            if !owned {
                return Err(format!(
                    "an active run reservation is present: {}", ancestor.display()
                ));
            }
        }
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize)]
pub struct ResolvedOutputStorage {
    pub output_dir: PathBuf,
    /// Private run directory, never the operator-selected temporary parent.
    pub temp_dir: PathBuf,
    pub run_id: String,
    pub data_format: OutputDataFormatIR,
    pub cleanup: TempCleanupIR,
}

pub struct ProjectStorageLease {
    resolved: ResolvedOutputStorage,
    temp_parent: PathBuf,
    token: String,
    active_file: Option<File>,
    finished: bool,
}

pub fn supported_data_formats() -> Vec<OutputDataFormatIR> {
    let formats = vec![OutputDataFormatIR::Zarr];
    #[cfg(feature = "stage-autosave-hdf5")]
    let formats = {
        let mut formats = formats;
        formats.push(OutputDataFormatIR::Hdf5);
        formats
    };
    formats
}

impl ProjectStorageLease {
    pub fn prepare(
        settings: &OutputStorageIR,
        default_output_dir: &Path,
        source_dir: &Path,
        run_id: &str,
    ) -> Result<Self, String> {
        settings.validate().map_err(|errors| errors.join("; "))?;
        if run_id.is_empty()
            || run_id.len() > 160
            || !run_id
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"-_.".contains(&c))
            || matches!(run_id, "." | "..")
        {
            return Err("run_id must be a nonempty safe directory identifier".into());
        }
        let (desired, scratch_parent) =
            preflight_project_storage(settings, default_output_dir, source_dir)?;
        let ancestor_gates = acquire_result_ancestor_gates(&desired)?;
        let parent = desired.parent().ok_or("output directory has no parent")?;
        ensure_real_directory(parent)?;
        let parent = fs::canonicalize(parent).map_err(message)?;
        let desired_name = desired.file_name().ok_or("output directory has no name")?;
        let desired = parent.join(desired_name);
        // All path/capability checks preceded any directory creation.
        ensure_real_directory(&scratch_parent)?;
        let temp_parent = fs::canonicalize(&scratch_parent).map_err(message)?;
        if desired.starts_with(&temp_parent) || temp_parent.starts_with(&desired) {
            return Err("result directory and temporary parent must be separate locations".into());
        }
        let mut output_dir = desired.clone();
        let mut output_gate = None;
        for attempt in 0..100 {
            // A sibling gate survives removal of the result tree. All writers
            // hold it until the active marker and receipt are published.
            if let Some(gate) = ReservationGate::try_acquire(&output_dir, &ancestor_gates)? {
                match fs::create_dir(&output_dir) {
                    Ok(()) => {
                        output_gate = Some(gate);
                        break;
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                        match settings.existing_output {
                            ExistingOutputIR::Error => {
                                return Err(format!(
                                    "result location already exists: {}",
                                    output_dir.display()
                                ));
                            }
                            ExistingOutputIR::Overwrite => {
                                remove_inactive_result(&output_dir)?;
                                fs::create_dir(&output_dir).map_err(message)?;
                                output_gate = Some(gate);
                                break;
                            }
                            ExistingOutputIR::Timestamp => {}
                        }
                    }
                    Err(error) => return Err(message(error)),
                }
            } else if settings.existing_output != ExistingOutputIR::Timestamp {
                return Err(format!(
                    "an active run reservation is present: {}",
                    output_dir.display()
                ));
            }
            let name = desired_name.to_string_lossy();
            let (stem, suffix) = name
                .strip_suffix(".zarr")
                .map(|stem| (stem, ".zarr"))
                .unwrap_or((&name, ""));
            output_dir = parent.join(format!("{stem}-{run_id}-{attempt}{suffix}"));
        }
        let _output_gate = output_gate
            .ok_or("unable to reserve a fresh result directory after 100 attempts")?;
        ensure_no_reparse_ancestors(&output_dir)?;
        let output_dir = fs::canonicalize(&output_dir).map_err(message)?;
        let token = uuid::Uuid::new_v4().to_string();
        let temp_dir = temp_parent.join(format!("fullmag-{run_id}-{token}"));
        create_private_temp_directory(&temp_dir)?;
        // From here every fallible operation is guarded by Drop. In particular,
        // a failed scratch marker/receipt cannot leave a live result reservation.
        let mut lease = Self {
            resolved: ResolvedOutputStorage {
                output_dir,
                temp_dir,
                run_id: run_id.to_owned(),
                data_format: settings.data_format,
                cleanup: settings.cleanup,
            },
            temp_parent,
            token,
            active_file: None,
            finished: false,
        };
        let active_path = lease.resolved.output_dir.join(ACTIVE_FILE);
        lease.active_file = Some(
            OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&active_path)
                .map_err(message)?,
        );
        let active_file = lease
            .active_file
            .as_mut()
            .expect("created reservation handle");
        active_file
            .write_all(lease.token.as_bytes())
            .map_err(message)?;
        active_file.sync_all().map_err(message)?;
        lease.verify_ancestor_reservations(&ancestor_gates)?;
        let owner = serde_json::json!({
            "schema": "fullmag.private_tmp.v1", "token": lease.token,
            "run_id": run_id, "output_dir": lease.resolved.output_dir, "pid": std::process::id(),
        });
        let mut marker = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(lease.resolved.temp_dir.join(OWNER_FILE))
            .map_err(message)?;
        marker
            .write_all(&serde_json::to_vec(&owner).map_err(message)?)
            .map_err(message)?;
        marker.sync_all().map_err(message)?;
        if settings.data_format == OutputDataFormatIR::Zarr {
            fs::write(
                lease.resolved.output_dir.join(".zgroup"),
                b"{\"zarr_format\":2}",
            )
            .map_err(message)?;
            fs::write(
                lease.resolved.output_dir.join(".zattrs"),
                b"{\"schema_version\":\"fullmag.project_results.v1\"}",
            )
            .map_err(message)?;
        }
        lease.write_receipt("running", false)?;
        Ok(lease)
    }

    pub fn resolved(&self) -> &ResolvedOutputStorage {
        &self.resolved
    }

    /// Call only when all children/worker handles that use scratch have terminated.
    pub fn finish(&mut self, success: bool) -> Result<(), String> {
        if self.finished {
            return Err("storage lease is already finalized".into());
        }
        self.verify_active_identity()?;
        let remove = self.resolved.cleanup == TempCleanupIR::Always
            || (success && self.resolved.cleanup == TempCleanupIR::OnSuccess);
        if remove {
            self.clean_private_temp()?;
        }
        self.write_receipt(if success { "succeeded" } else { "failed" }, remove)?;
        self.finished = true;
        self.release_active_file();
        Ok(())
    }

    fn clean_private_temp(&self) -> Result<(), String> {
        let path = &self.resolved.temp_dir;
        ensure_no_reparse_ancestors(path)?;
        let canonical = fs::canonicalize(path).map_err(message)?;
        if canonical != *path || canonical.parent() != Some(self.temp_parent.as_path()) {
            return Err("private temporary directory identity changed; retained".into());
        }
        let marker_path = canonical.join(OWNER_FILE);
        reject_reparse(&marker_path)?;
        let marker: serde_json::Value =
            serde_json::from_slice(&fs::read(&marker_path).map_err(message)?).map_err(message)?;
        if marker.get("schema").and_then(|v| v.as_str()) != Some("fullmag.private_tmp.v1")
            || marker.get("token").and_then(|v| v.as_str()) != Some(&self.token)
            || marker.get("run_id").and_then(|v| v.as_str()) != Some(&self.resolved.run_id)
        {
            return Err("temporary-directory ownership changed; retained".into());
        }
        reject_reparse_tree(&canonical)?;
        // remove_dir_all does not follow symbolic links; the preflight additionally
        // refuses Windows junctions/reparse points and leaves uncertain data intact.
        fs::remove_dir_all(&canonical).map_err(message)
    }

    /// Publish finalized numerical data staged in this run's private scratch.
    /// Existing result files are never truncated or merged with unknown data.
    pub fn publish_directory(&self, staged: &Path) -> Result<(), String> {
        self.verify_active_identity()?;
        ensure_no_reparse_ancestors(staged)?;
        let staged = fs::canonicalize(staged).map_err(message)?;
        if staged == self.resolved.temp_dir || !staged.starts_with(&self.resolved.temp_dir) {
            return Err(
                "publication source must be inside this run's private temporary directory".into(),
            );
        }
        reject_reparse_tree(&staged)?;
        copy_fresh_tree(&staged, &self.resolved.output_dir)
    }

    fn verify_ancestor_reservations(&self, gates: &[ReservationGate]) -> Result<(), String> {
        let identities = gates.iter()
            .map(|gate| (gate.path.clone(), gate.token.clone()))
            .collect::<Vec<_>>();
        verify_ancestor_gates(&self.resolved.output_dir, &identities)?;
        self.verify_active_identity()
    }

    fn verify_active_identity(&self) -> Result<(), String> {
        ensure_no_reparse_ancestors(&self.resolved.output_dir)?;
        if fs::canonicalize(&self.resolved.output_dir).map_err(message)? != self.resolved.output_dir
        {
            return Err("result directory identity changed; retained".into());
        }
        let active_path = self.resolved.output_dir.join(ACTIVE_FILE);
        reject_reparse(&active_path)?;
        if !fs::symlink_metadata(&active_path).map_err(message)?.is_file() {
            return Err("result reservation is not a regular file; retained".into());
        }
        if fs::read_to_string(active_path).map_err(message)? != self.token {
            return Err("result reservation ownership changed; retained".into());
        }
        Ok(())
    }

    fn write_receipt(&self, state: &str, cleaned: bool) -> Result<(), String> {
        self.verify_active_identity()?;
        let receipt = serde_json::json!({
            "schema": "fullmag.output_storage.resolved.v1", "state": state,
            "resolved": self.resolved, "temp_cleaned": cleaned,
        });
        let receipt_path = self.resolved.output_dir.join("output-storage.json");
        if receipt_path.exists() {
            reject_reparse(&receipt_path)?;
        }
        let mut file = File::create(receipt_path).map_err(message)?;
        file.write_all(&serde_json::to_vec_pretty(&receipt).map_err(message)?)
            .map_err(message)?;
        file.sync_all().map_err(message)
    }

    fn release_active_file(&mut self) {
        self.active_file.take();
        let path = self.resolved.output_dir.join(ACTIVE_FILE);
        if ensure_no_reparse_ancestors(&self.resolved.output_dir).is_ok()
            && reject_reparse(&path).is_ok()
            && fs::read_to_string(&path).ok().as_deref() == Some(&self.token)
        {
            let _ = fs::remove_file(path);
        }
    }
}

impl Drop for ProjectStorageLease {
    fn drop(&mut self) {
        // An interrupted owner preserves scratch for diagnosis/reconciliation.
        // Completion of a process alone does not prove completion of its workers.
        self.release_active_file();
    }
}

fn resolve_path(path: &Path, source_dir: &Path) -> Result<PathBuf, String> {
    if path.as_os_str().is_empty() || path.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err("storage paths must be nonempty and must not contain '..'".into());
    }
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        source_dir.join(path)
    };
    // Components normalize internal '.' without touching the filesystem.
    Ok(absolute
        .components()
        .filter(|part| !matches!(part, Component::CurDir))
        .collect())
}

fn ensure_real_directory(path: &Path) -> Result<(), String> {
    ensure_no_reparse_ancestors(path)?;
    fs::create_dir_all(path).map_err(message)?;
    ensure_no_reparse_ancestors(path)
}

fn ensure_no_reparse_ancestors(path: &Path) -> Result<(), String> {
    for ancestor in path.ancestors() {
        match fs::symlink_metadata(ancestor) {
            Ok(_) => reject_reparse(ancestor)?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(message(error)),
        }
    }
    Ok(())
}

fn reject_reparse(path: &Path) -> Result<(), String> {
    let metadata = fs::symlink_metadata(path).map_err(message)?;
    #[cfg(windows)]
    let reparse = {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes() & 0x400 != 0
    };
    #[cfg(not(windows))]
    let reparse = false;
    if metadata.file_type().is_symlink() || reparse {
        return Err(format!(
            "storage path contains a link/reparse point: {}",
            path.display()
        ));
    }
    Ok(())
}

fn reject_reparse_tree(path: &Path) -> Result<(), String> {
    reject_reparse(path)?;
    for entry in fs::read_dir(path).map_err(message)? {
        let entry = entry.map_err(message)?;
        let entry_path = entry.path();
        reject_reparse(&entry_path)?;
        if entry.file_type().map_err(message)?.is_dir() {
            reject_reparse_tree(&entry_path)?;
        }
    }
    Ok(())
}

fn message(error: impl std::fmt::Display) -> String {
    error.to_string()
}

/// Remove an existing result directory for the `overwrite` policy. Only an
/// inactive fullmag result without links/reparse points is removed; any other
/// directory is refused and left untouched. The caller holds the target and
/// result ancestor gates until the new active marker is published.
fn remove_inactive_result(path: &Path) -> Result<(), String> {
    let refuse = |reason: &str| {
        format!(
            "refusing to overwrite a directory that is not an inactive fullmag result \
             ({reason}): {}",
            path.display()
        )
    };
    ensure_no_reparse_ancestors(path).map_err(|error| refuse(error.as_str()))?;
    if !fs::symlink_metadata(path).map_err(message)?.is_dir() {
        return Err(refuse("not a directory"));
    }
    for ancestor in path.ancestors().skip(1) {
        if reservation_path_exists(&ancestor.join(ACTIVE_FILE))? {
            return Err(refuse("an active run reservation is present in an ancestor"));
        }
    }
    reject_reparse_tree(path).map_err(|error| refuse(error.as_str()))?;
    if contains_active_reservation(path)? {
        return Err(refuse("an active run reservation is present"));
    }
    if !is_fullmag_result_directory(path) {
        return Err(refuse("no fullmag result metadata"));
    }
    fs::remove_dir_all(path).map_err(message)
}

/// Any reservation file in the tree marks a live (or crashed, unreconciled)
/// writer; such data is never removed automatically.
fn contains_active_reservation(path: &Path) -> Result<bool, String> {
    for entry in fs::read_dir(path).map_err(message)? {
        let entry = entry.map_err(message)?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name == ACTIVE_FILE
            || (name.starts_with('.') && name.ends_with(RESERVATION_GATE_SUFFIX))
        {
            return Ok(true);
        }
        if entry.file_type().map_err(message)?.is_dir()
            && contains_active_reservation(&entry.path())?
        {
            return Ok(true);
        }
    }
    Ok(false)
}

fn is_fullmag_result_directory(path: &Path) -> bool {
    let read_json = |name: &str| -> Option<serde_json::Value> {
        serde_json::from_slice(&fs::read(path.join(name)).ok()?).ok()
    };
    let zattrs_marked = read_json(".zattrs").is_some_and(|attributes| {
        attributes
            .get("schema_version")
            .and_then(serde_json::Value::as_str)
            .is_some_and(|schema| schema.starts_with("fullmag."))
    });
    let receipt_marked = read_json("output-storage.json").is_some_and(|receipt| {
        receipt.get("schema").and_then(serde_json::Value::as_str)
            == Some("fullmag.output_storage.resolved.v1")
    });
    let sequence_marked = read_json("sequence_manifest.json").is_some_and(|manifest| {
        manifest.get("kind").and_then(serde_json::Value::as_str) == Some("flat_sequence")
    });
    zattrs_marked || receipt_marked || sequence_marked
}

/// Add the primary field/table writer before planning. Runtime writer
/// availability is checked here; the shared IR owner materializes the policy.
pub fn configure_project_autosave(
    problem: &mut ProblemIR,
    data_format: OutputDataFormatIR,
    until_seconds: f64,
) -> Result<(), String> {
    if !supported_data_formats().contains(&data_format) {
        return Err("HDF5 output is unavailable in this runtime".into());
    }
    fullmag_ir::configure_project_autosave_policy(problem, data_format, until_seconds)
}

fn copy_fresh_tree(source: &Path, destination: &Path) -> Result<(), String> {
    ensure_no_reparse_ancestors(destination)?;
    for entry in fs::read_dir(source).map_err(message)? {
        let entry = entry.map_err(message)?;
        let from = entry.path();
        reject_reparse(&from)?;
        let to = destination.join(entry.file_name());
        if entry.file_type().map_err(message)?.is_dir() {
            fs::create_dir(&to).map_err(message)?;
            copy_fresh_tree(&from, &to)?;
        } else {
            let mut input = File::open(&from).map_err(message)?;
            let mut output = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&to)
                .map_err(message)?;
            std::io::copy(&mut input, &mut output).map_err(message)?;
            output.sync_all().map_err(message)?;
        }
    }
    Ok(())
}

/// A project/run container may gain fresh child groups. Never rewrite existing
/// Zarr metadata or result content while establishing the parent hierarchy.
pub fn initialize_result_container(
    path: &Path,
    data_format: OutputDataFormatIR,
) -> Result<(), String> {
    ensure_real_directory(path)?;
    if data_format != OutputDataFormatIR::Zarr {
        return Ok(());
    }
    let group_path = path.join(".zgroup");
    match OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&group_path)
    {
        Ok(mut file) => {
            file.write_all(b"{\"zarr_format\":2}").map_err(message)?;
            file.sync_all().map_err(message)?;
        }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            reject_reparse(&group_path)?;
            let group: serde_json::Value =
                serde_json::from_slice(&fs::read(&group_path).map_err(message)?)
                    .map_err(message)?;
            if group.get("zarr_format").and_then(serde_json::Value::as_u64) != Some(2) {
                return Err("existing output container is not a supported Zarr v2 group".into());
            }
        }
        Err(error) => return Err(message(error)),
    }
    let attributes = path.join(".zattrs");
    match OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&attributes)
    {
        Ok(mut file) => {
            file.write_all(b"{}").map_err(message)?;
            file.sync_all().map_err(message)?;
        }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            reject_reparse(&attributes)?;
        }
        Err(error) => return Err(message(error)),
    }
    Ok(())
}

/// Check policy and path ownership without creating result/tmp directories.
pub fn preflight_project_storage(
    settings: &OutputStorageIR,
    default_output_dir: &Path,
    source_dir: &Path,
) -> Result<(PathBuf, PathBuf), String> {
    settings.validate().map_err(|errors| errors.join("; "))?;
    if !supported_data_formats().contains(&settings.data_format) {
        return Err(
            "HDF5 output is unavailable in this runtime (stage-autosave-hdf5 is not enabled)"
                .into(),
        );
    }
    let source_dir = fs::canonicalize(source_dir).map_err(message)?;
    let output = resolve_path(
        settings
            .output_dir
            .as_deref()
            .map(Path::new)
            .unwrap_or(default_output_dir),
        &source_dir,
    )?;
    let parent = output.parent().ok_or("output directory has no parent")?;
    let scratch = settings
        .temp_dir
        .as_deref()
        .map(|path| resolve_path(Path::new(path), &source_dir))
        .transpose()?
        .unwrap_or_else(|| parent.join(".fullmag-tmp"));
    ensure_no_reparse_ancestors(&output)?;
    ensure_no_reparse_ancestors(&scratch)?;
    // Resolve aliases of existing prefixes (including Windows drive/UNC
    // spelling) before comparing leaves that have not been created yet.
    let output = canonicalize_existing_prefix(&output)?;
    let scratch = canonicalize_existing_prefix(&scratch)?;
    let key = |path: &Path| {
        let value = path
            .to_string_lossy()
            .replace('\\', "/")
            .trim_end_matches('/')
            .to_string();
        let value = value.strip_prefix("//?/").unwrap_or(&value).to_string();
        if cfg!(windows) {
            value.to_lowercase()
        } else {
            value
        }
    };
    let out_key = key(&output);
    let temp_key = key(&scratch);
    if out_key == temp_key
        || out_key.starts_with(&format!("{temp_key}/"))
        || temp_key.starts_with(&format!("{out_key}/"))
    {
        return Err("result directory and temporary parent must be separate locations".into());
    }
    Ok((output, scratch))
}

fn canonicalize_existing_prefix(path: &Path) -> Result<PathBuf, String> {
    for ancestor in path.ancestors() {
        match fs::symlink_metadata(ancestor) {
            Ok(_) => {
                let prefix = fs::canonicalize(ancestor).map_err(message)?;
                let suffix = path.strip_prefix(ancestor).map_err(message)?;
                return Ok(prefix.join(suffix));
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(message(error)),
        }
    }
    Err("storage path has no existing absolute prefix".into())
}

#[cfg(unix)]
fn create_private_temp_directory(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
    fs::DirBuilder::new()
        .mode(0o700)
        .create(path)
        .map_err(message)?;
    if fs::metadata(path).map_err(message)?.permissions().mode() & 0o077 != 0 {
        return Err("private scratch directory has unsafe access permissions".into());
    }
    Ok(())
}

#[cfg(windows)]
fn create_private_temp_directory(path: &Path) -> Result<(), String> {
    use std::ffi::c_void;
    use std::os::windows::ffi::OsStrExt;
    #[repr(C)]
    struct SecurityAttributes {
        length: u32,
        descriptor: *mut c_void,
        inherit_handle: i32,
    }
    #[link(name = "advapi32")]
    unsafe extern "system" {
        fn ConvertStringSecurityDescriptorToSecurityDescriptorW(
            text: *const u16,
            revision: u32,
            descriptor: *mut *mut c_void,
            size: *mut u32,
        ) -> i32;
    }
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn CreateDirectoryW(path: *const u16, attributes: *const SecurityAttributes) -> i32;
        fn LocalFree(pointer: *mut c_void) -> *mut c_void;
    }
    // Protected DACL: owner and SYSTEM only, inherited by this run's children.
    // This applies only at creation of our fresh directory, never to its parent.
    let descriptor_text: Vec<u16> = "D:P(A;OICI;FA;;;OW)(A;OICI;FA;;;SY)"
        .encode_utf16()
        .chain(Some(0))
        .collect();
    let path_text: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    let mut descriptor = std::ptr::null_mut();
    unsafe {
        if ConvertStringSecurityDescriptorToSecurityDescriptorW(
            descriptor_text.as_ptr(),
            1,
            &mut descriptor,
            std::ptr::null_mut(),
        ) == 0
        {
            return Err(message(std::io::Error::last_os_error()));
        }
        let attributes = SecurityAttributes {
            length: std::mem::size_of::<SecurityAttributes>() as u32,
            descriptor,
            inherit_handle: 0,
        };
        let created = CreateDirectoryW(path_text.as_ptr(), &attributes);
        let error = (created == 0).then(std::io::Error::last_os_error);
        LocalFree(descriptor);
        error.map_or(Ok(()), |error| Err(message(error)))
    }
}

#[cfg(not(any(unix, windows)))]
fn create_private_temp_directory(_path: &Path) -> Result<(), String> {
    Err("private temporary directory creation is unsupported on this platform".into())
}

/// Copy one artifact opened without following links in its source hierarchy.
pub fn copy_owned_artifact(
    source_root: &Path,
    relative: &Path,
    destination: &Path,
) -> Result<(), String> {
    if relative
        .components()
        .any(|part| !matches!(part, Component::Normal(_)))
    {
        return Err("artifact path must contain only normal relative components".into());
    }
    ensure_no_reparse_ancestors(source_root)?;
    let root = fs::canonicalize(source_root).map_err(message)?;
    let source = root.join(relative);
    ensure_no_reparse_ancestors(&source)?;
    let mut input = open_verified_artifact(&root, relative)?;
    if !input.metadata().map_err(message)?.is_file() {
        return Err("artifact is not a regular file".into());
    }
    ensure_no_reparse_ancestors(destination)?;
    let mut output = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(destination)
        .map_err(message)?;
    std::io::copy(&mut input, &mut output).map_err(message)?;
    output.sync_all().map_err(message)
}

#[cfg(unix)]
pub(crate) fn open_verified_artifact(root: &Path, relative: &Path) -> Result<File, String> {
    use std::ffi::CString;
    use std::os::fd::{AsRawFd, FromRawFd};
    use std::os::unix::ffi::OsStrExt;
    let name = CString::new(root.as_os_str().as_bytes()).map_err(message)?;
    let fd = unsafe {
        libc::open(
            name.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    if fd < 0 {
        return Err(message(std::io::Error::last_os_error()));
    }
    let mut parent = unsafe { File::from_raw_fd(fd) };
    let components: Vec<_> = relative.components().collect();
    for (index, component) in components.iter().enumerate() {
        let name = CString::new(component.as_os_str().as_bytes()).map_err(message)?;
        let directory = index + 1 < components.len();
        let flags = libc::O_RDONLY
            | libc::O_NOFOLLOW
            | libc::O_CLOEXEC
            | libc::O_NONBLOCK
            | if directory { libc::O_DIRECTORY } else { 0 };
        let fd = unsafe { libc::openat(parent.as_raw_fd(), name.as_ptr(), flags) };
        if fd < 0 {
            return Err(message(std::io::Error::last_os_error()));
        }
        parent = unsafe { File::from_raw_fd(fd) };
    }
    Ok(parent)
}

#[cfg(windows)]
pub(crate) fn open_verified_artifact(root: &Path, relative: &Path) -> Result<File, String> {
    use std::ffi::c_void;
    use std::os::windows::fs::OpenOptionsExt;
    use std::os::windows::io::AsRawHandle;
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetFinalPathNameByHandleW(
            handle: *mut c_void,
            path: *mut u16,
            length: u32,
            flags: u32,
        ) -> u32;
    }
    let expected = root.join(relative);
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(0x00200000)
        .open(&expected)
        .map_err(message)?;
    let mut buffer = vec![0u16; 32768];
    let length = unsafe {
        GetFinalPathNameByHandleW(
            file.as_raw_handle(),
            buffer.as_mut_ptr(),
            buffer.len() as u32,
            0,
        )
    };
    if length == 0 || length as usize >= buffer.len() {
        return Err("cannot verify artifact handle path".into());
    }
    let observed = PathBuf::from(String::from_utf16(&buffer[..length as usize]).map_err(message)?);
    if observed != expected {
        return Err("artifact source identity changed while opening; refused".into());
    }
    ensure_no_reparse_ancestors(&expected)?;
    Ok(file)
}

#[cfg(not(any(unix, windows)))]
pub(crate) fn open_verified_artifact(_root: &Path, _relative: &Path) -> Result<File, String> {
    Err("verified artifact copy is unsupported on this platform".into())
}

#[cfg(test)]
mod overwrite_tests {
    use super::*;

    fn settings(output_dir: &Path, temp_dir: &Path) -> OutputStorageIR {
        OutputStorageIR {
            output_dir: Some(output_dir.to_string_lossy().into_owned()),
            temp_dir: Some(temp_dir.to_string_lossy().into_owned()),
            data_format: OutputDataFormatIR::Zarr,
            cleanup: TempCleanupIR::Always,
            existing_output: ExistingOutputIR::Overwrite,
        }
    }

    #[test]
    fn overwrite_replaces_an_inactive_fullmag_result() {
        let root = tempfile::tempdir().expect("temporary root");
        let output = root.path().join("results.zarr");
        let temp = root.path().join("scratch");
        let settings = settings(&output, &temp);
        let mut first = ProjectStorageLease::prepare(&settings, &output, root.path(), "first")
            .expect("first reservation");
        fs::write(output.join("stale.bin"), b"old").expect("stale result data");
        first.finish(true).expect("finish first run");
        drop(first);

        let mut second = ProjectStorageLease::prepare(&settings, &output, root.path(), "second")
            .expect("overwrite inactive result");
        assert_eq!(second.resolved().output_dir, fs::canonicalize(&output).unwrap());
        assert!(!output.join("stale.bin").exists());
        assert!(output.join(ACTIVE_FILE).exists());
        second.finish(true).expect("finish second run");
    }

    #[test]
    fn overwrite_refuses_a_foreign_directory() {
        let root = tempfile::tempdir().expect("temporary root");
        let output = root.path().join("results.zarr");
        let temp = root.path().join("scratch");
        fs::create_dir(&output).expect("foreign directory");
        fs::write(output.join("notes.txt"), b"user data").expect("foreign file");

        let settings = settings(&output, &temp);
        let error = ProjectStorageLease::prepare(&settings, &output, root.path(), "run")
            .err()
            .expect("foreign directory must be refused");
        let canonical = fs::canonicalize(&output).expect("canonical output");
        assert!(error.contains("refusing to overwrite"), "{error}");
        assert!(error.contains(&canonical.display().to_string()), "{error}");
        assert_eq!(fs::read(output.join("notes.txt")).unwrap(), b"user data");
    }

    #[test]
    fn overwrite_refuses_a_result_with_an_active_reservation() {
        let root = tempfile::tempdir().expect("temporary root");
        let output = root.path().join("results.zarr");
        let temp = root.path().join("scratch");
        let settings = settings(&output, &temp);
        let _active = ProjectStorageLease::prepare(&settings, &output, root.path(), "active")
            .expect("active reservation");

        let error = ProjectStorageLease::prepare(&settings, &output, root.path(), "other")
            .err()
            .expect("active result must be refused");
        assert!(error.contains("active run reservation"), "{error}");
        assert!(output.join(ACTIVE_FILE).exists());
    }

    #[test]
    fn overwrite_refuses_a_held_reservation_gate() {
        let root = tempfile::tempdir().expect("temporary root");
        let output = root.path().join("results.zarr");
        let temp = root.path().join("scratch");
        let settings = settings(&output, &temp);
        let gate = ReservationGate::acquire(&output).expect("reservation gate");

        let error = ProjectStorageLease::prepare(&settings, &output, root.path(), "other")
            .err()
            .expect("held gate must refuse a second writer");
        assert!(error.contains("active run reservation"), "{error}");
        assert!(!output.exists());
        assert!(reservation_gate_path(&output).unwrap().exists());

        drop(gate);
        let mut lease = ProjectStorageLease::prepare(&settings, &output, root.path(), "owner")
            .expect("released gate permits reservation");
        lease.finish(true).expect("finish owner");
    }

    #[test]
    fn timestamp_selects_a_fresh_path_when_the_target_gate_is_held() {
        let root = tempfile::tempdir().expect("temporary root");
        let output = root.path().join("results.zarr");
        let temp = root.path().join("scratch");
        let mut settings = settings(&output, &temp);
        settings.existing_output = ExistingOutputIR::Timestamp;
        let _gate = ReservationGate::acquire(&output).expect("reservation gate");

        let mut lease = ProjectStorageLease::prepare(&settings, &output, root.path(), "other")
            .expect("timestamp reservation");
        assert_eq!(
            lease.resolved().output_dir,
            fs::canonicalize(root.path().join("results-other-0.zarr")).unwrap()
        );
        assert!(!output.exists());
        assert!(reservation_gate_path(&output).unwrap().exists());
        lease.finish(true).expect("finish timestamp run");
    }

    #[test]
    fn parent_removal_gate_refuses_a_new_stage_writer() {
        let root = tempfile::tempdir().expect("temporary root");
        let output = root.path().join("results.zarr");
        fs::create_dir(&output).expect("sequence root");
        fs::write(
            output.join(".zattrs"),
            b"{\"schema_version\":\"fullmag.project_results.v1\"}",
        )
        .expect("result metadata");
        let _gate = ReservationGate::acquire(&output).expect("parent removal gate");
        let stage = output.join("stage_02_run.zarr");
        let settings = settings(&stage, &root.path().join("scratch"));

        let error = ProjectStorageLease::prepare(&settings, &stage, root.path(), "stage")
            .err()
            .expect("parent gate must refuse a new stage");
        assert!(error.contains("active run reservation"), "{error}");
        assert!(!stage.exists());
    }

    #[test]
    fn entering_stage_holds_the_parent_removal_gate() {
        let root = tempfile::tempdir().expect("temporary root");
        let output = root.path().join("results.zarr");
        fs::create_dir(&output).expect("sequence root");
        fs::write(
            output.join("sequence_manifest.json"),
            b"{\"kind\":\"flat_sequence\"}",
        )
        .expect("sequence metadata");
        let stage = output.join("stage_02_run.zarr");
        let _gates = acquire_result_ancestor_gates(&stage).expect("stage ancestor gates");
        let settings = settings(&output, &root.path().join("scratch"));

        let error = ProjectStorageLease::prepare(&settings, &output, root.path(), "overwrite")
            .err()
            .expect("entering stage must refuse parent removal");
        assert!(error.contains("active run reservation"), "{error}");
        assert!(output.join("sequence_manifest.json").exists());
    }

    #[test]
    fn active_sequence_protects_completed_stages_but_allows_fresh_children() {
        for stage_parent in ["", "stages"] {
            let root = tempfile::tempdir().expect("temporary root");
            let output = root.path().join("results.zarr");
            let temp = root.path().join("scratch");
            let sequence_settings = settings(&output, &temp);
            let mut sequence = ProjectStorageLease::prepare(
                &sequence_settings, &output, root.path(), "sequence",
            )
            .expect("sequence reservation");
            let stage = output.join(stage_parent).join("stage_01_run.zarr");
            let stage_settings = settings(&stage, &temp);
            let mut first = ProjectStorageLease::prepare(
                &stage_settings, &stage, root.path(), "first",
            )
            .expect("fresh first stage");
            fs::write(stage.join("result.bin"), b"first stage").expect("stage result");
            first.finish(true).expect("finish first stage");
            drop(first);
            assert!(!stage.join(ACTIVE_FILE).exists());

            let error = ProjectStorageLease::prepare(
                &stage_settings, &stage, root.path(), "other",
            )
            .err()
            .expect("active ancestor must protect completed stage");
            assert!(error.contains("active run reservation"), "{error}");
            assert_eq!(fs::read(stage.join("result.bin")).unwrap(), b"first stage");
            assert!(output.join(ACTIVE_FILE).exists());

            let next_stage = stage.parent().unwrap().join("stage_02_run.zarr");
            let next_settings = settings(&next_stage, &temp);
            let mut next = ProjectStorageLease::prepare(
                &next_settings, &next_stage, root.path(), "next",
            )
            .expect("active sequence permits fresh stages");
            next.finish(true).expect("finish next stage");
            sequence.finish(true).expect("finish sequence");

            let mut replacement = ProjectStorageLease::prepare(
                &stage_settings, &stage, root.path(), "replacement",
            )
            .expect("inactive ancestor permits stage replacement");
            assert!(!stage.join("result.bin").exists());
            replacement.finish(true).expect("finish replacement");
        }
    }

    #[test]
    fn published_child_refuses_an_unowned_ancestor_gate() {
        let root = tempfile::tempdir().expect("temporary root");
        let parent = root.path().join("parent");
        let stage = parent.join("stage.zarr");
        let settings = settings(&stage, &root.path().join("scratch"));
        let mut lease = ProjectStorageLease::prepare(&settings, &stage, root.path(), "stage")
            .expect("stage reservation");
        let gate = ReservationGate::acquire(&parent).expect("parent removal gate");

        let error = lease.verify_ancestor_reservations(&[])
            .expect_err("commit must detect a previously skipped ancestor gate");
        assert!(error.contains("active run reservation"), "{error}");
        lease.verify_ancestor_reservations(std::slice::from_ref(&gate))
            .expect("owned ancestor gate is permitted");
        drop(gate);
        lease.finish(true).expect("finish stage");
    }

    #[test]
    fn published_child_requires_its_original_marker_after_ancestor_checks() {
        let root = tempfile::tempdir().expect("temporary root");
        let output = root.path().join("stage.zarr");
        let settings = settings(&output, &root.path().join("scratch"));
        let mut lease = ProjectStorageLease::prepare(&settings, &output, root.path(), "stage")
            .expect("stage reservation");
        let original = fs::read(output.join(ACTIVE_FILE)).expect("original marker");
        fs::write(output.join(ACTIVE_FILE), b"another generation").expect("replaced marker");

        let error = lease.verify_ancestor_reservations(&[])
            .expect_err("commit must detect a replaced generation");
        assert!(error.contains("ownership changed"), "{error}");
        fs::write(output.join(ACTIVE_FILE), original).expect("restore owned marker");
        lease.finish(true).expect("finish stage");
    }

    #[test]
    fn pending_descendant_gate_prevents_ancestor_removal() {
        let root = tempfile::tempdir().expect("temporary root");
        let output = root.path().join("results.zarr");
        fs::create_dir(&output).expect("result root");
        fs::write(
            output.join(".zattrs"),
            b"{\"schema_version\":\"fullmag.project_results.v1\"}",
        )
        .expect("result metadata");
        fs::write(output.join("result.bin"), b"old result").expect("existing result");
        let _gate = ReservationGate::acquire(&output.join("stage.zarr"))
            .expect("pending stage gate");
        let settings = settings(&output, &root.path().join("scratch"));

        let error = ProjectStorageLease::prepare(&settings, &output, root.path(), "overwrite")
            .err()
            .expect("pending descendant gate must prevent removal");
        assert!(error.contains("active run reservation"), "{error}");
        assert_eq!(fs::read(output.join("result.bin")).unwrap(), b"old result");
    }

    #[test]
    fn gate_cleanup_preserves_another_owner_token() {
        let root = tempfile::tempdir().expect("temporary root");
        let output = root.path().join("results.zarr");
        let gate = ReservationGate::acquire(&output).expect("target gate");
        let path = gate.path.clone();
        fs::write(&path, b"another owner").expect("changed gate owner");
        drop(gate);
        assert_eq!(fs::read(path).unwrap(), b"another owner");
    }
}
