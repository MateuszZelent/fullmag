//! Durable, diagnostic checkpoint of one native FEM eigen sample.
//!
//! This module stores the exact single-k plan bytes and the complete raw
//! AuxiliaryArtifact closure under a sample-local namespace. It does not
//! parse or accept solver results, change a run status, or qualify physics.

use fullmag_ir::{FemEigenPlanIR, KSamplingIR};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::error::Error;
use std::fmt;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::types::AuxiliaryArtifact;

const CHECKPOINT_SCHEMA_V1: &str = "fullmag.single_k_checkpoint.internal.v1";
const SPECTRUM_ARTIFACT: &str = "eigen/spectrum.json";
const MAX_RAW_CHECKPOINT_ATTEMPT_COLLISIONS: usize = 32;

static NEXT_RAW_CHECKPOINT_ATTEMPT_ID: AtomicU64 = AtomicU64::new(0);

#[derive(Debug)]
pub enum SingleKCheckpointError {
    InvalidInput(&'static str),
    Serialize(String),
    Io {
        operation: &'static str,
        path: PathBuf,
        source: io::Error,
    },
}

impl fmt::Display for SingleKCheckpointError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidInput(reason) => {
                write!(formatter, "invalid single-k checkpoint input: {reason}")
            }
            Self::Serialize(message) => write!(
                formatter,
                "single-k checkpoint serialization failed: {message}"
            ),
            Self::Io {
                operation,
                path,
                source,
            } => {
                write!(
                    formatter,
                    "single-k checkpoint {operation} failed at {}: {source}",
                    path.display()
                )
            }
        }
    }
}

impl Error for SingleKCheckpointError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Io { source, .. } => Some(source),
            Self::InvalidInput(_) | Self::Serialize(_) => None,
        }
    }
}

#[derive(Debug, Serialize)]
struct PointPlanRecord {
    relative_path: &'static str,
    size_bytes: u64,
    sha256: String,
}

#[derive(Debug, Serialize)]
struct ArtifactRecord {
    relative_path: String,
    source_relative_path: String,
    size_bytes: u64,
    sha256: String,
}

#[derive(Debug, Serialize)]
struct CheckpointManifestV1 {
    schema: &'static str,
    result_disposition: &'static str,
    requires_postsolve: bool,
    sample_index: usize,
    requested_global_k_rad_per_m: [f64; 3],
    point_plan: PointPlanRecord,
    artifacts: Vec<ArtifactRecord>,
    campaign_complete: bool,
    branch_tracking_complete: bool,
    scientific_qualification: &'static str,
}

struct PreparedArtifact<'a> {
    source: &'a AuxiliaryArtifact,
    components: Vec<&'a str>,
    record: ArtifactRecord,
}

/// Persist a raw native single-k result under a new, sample-local namespace.
///
/// `point_plan` must be the exact FemEigenPlanIR used for the native call and
/// must identify the requested global k. Its serde_json bytes are preserved
/// verbatim as the digest preimage. `artifacts` must be the original artifact
/// slice returned by that ExecutedRun, including eigen/spectrum.json.
///
/// The returned path names the last-written manifest commit marker. A present
/// and parseable marker establishes only byte preservation; all native outputs
/// still require postsolve validation. This helper intentionally never changes
/// the canonical eigen/path/spectrum namespace or a run status.
pub fn write_raw_single_k_checkpoint(
    process_root: &Path,
    sample_index: usize,
    requested_global_k_rad_per_m: [f64; 3],
    point_plan: &FemEigenPlanIR,
    artifacts: &[AuxiliaryArtifact],
) -> Result<PathBuf, SingleKCheckpointError> {
    validate_global_k(requested_global_k_rad_per_m)?;
    validate_point_plan_k(point_plan, requested_global_k_rad_per_m)?;
    if artifacts.is_empty() {
        return Err(SingleKCheckpointError::InvalidInput(
            "artifact slice is empty",
        ));
    }

    let point_plan_bytes = serde_json::to_vec(point_plan)
        .map_err(|error| SingleKCheckpointError::Serialize(error.to_string()))?;
    let prepared_artifacts = prepare_artifacts(artifacts)?;
    let process_root = validate_managed_process_root(process_root)?;

    // Existing canonical output directories are accepted only as ordinary
    // directories. A symlink or reparse point is never followed for staging.
    let eigen_root = process_root.join("eigen");
    ensure_plain_directory(&eigen_root)?;
    let checkpoints_root = eigen_root.join("sample-checkpoints");
    ensure_plain_directory(&checkpoints_root)?;

    let sample_root = checkpoints_root.join(format!("sample-{sample_index:04}"));
    fs::create_dir(&sample_root)
        .map_err(|source| io_error("create sample namespace", &sample_root, source))?;
    ensure_existing_plain_directory(&sample_root)?;

    let artifact_root = sample_root.join("artifacts");
    fs::create_dir(&artifact_root)
        .map_err(|source| io_error("create artifacts directory", &artifact_root, source))?;
    ensure_existing_plain_directory(&artifact_root)?;

    let point_plan_path = sample_root.join("point-plan.json");
    write_new_synced_file(&point_plan_path, &point_plan_bytes)?;

    let mut manifest_artifacts = Vec::with_capacity(prepared_artifacts.len());
    let mut created_directories = BTreeSet::<String>::new();
    for artifact in &prepared_artifacts {
        let mut destination = artifact_root.clone();
        for (index, component) in artifact.components[..artifact.components.len() - 1]
            .iter()
            .enumerate()
        {
            destination.push(*component);
            let directory_key = artifact.components[..=index]
                .iter()
                .map(|part| part.to_lowercase())
                .collect::<Vec<_>>()
                .join("/");
            if created_directories.insert(directory_key) {
                // This invocation must create every new prefix on first use.
                fs::create_dir(&destination).map_err(|source| {
                    io_error("create artifact directory", &destination, source)
                })?;
            }
            ensure_existing_plain_directory(&destination)?;
        }
        destination.push(artifact.components[artifact.components.len() - 1]);
        write_new_synced_file(&destination, &artifact.source.bytes)?;
        manifest_artifacts.push(ArtifactRecord {
            relative_path: artifact.record.relative_path.clone(),
            source_relative_path: artifact.record.source_relative_path.clone(),
            size_bytes: artifact.record.size_bytes,
            sha256: artifact.record.sha256.clone(),
        });
    }

    let manifest = CheckpointManifestV1 {
        schema: CHECKPOINT_SCHEMA_V1,
        result_disposition: "raw_native_returned",
        requires_postsolve: true,
        sample_index,
        requested_global_k_rad_per_m,
        point_plan: PointPlanRecord {
            relative_path: "point-plan.json",
            size_bytes: checked_size(point_plan_bytes.len())?,
            sha256: sha256(&point_plan_bytes),
        },
        artifacts: manifest_artifacts,
        campaign_complete: false,
        branch_tracking_complete: false,
        scientific_qualification: "NOT VERIFIED",
    };
    let mut manifest_bytes = serde_json::to_vec_pretty(&manifest)
        .map_err(|error| SingleKCheckpointError::Serialize(error.to_string()))?;
    manifest_bytes.push(b'\n');
    let pending_manifest_path = sample_root.join("manifest.pending");
    write_new_synced_file(&pending_manifest_path, &manifest_bytes)?;
    let manifest_path = sample_root.join("manifest.json");
    // Publish already-synced bytes as an atomic no-replace hard link. If the
    // filesystem cannot create hard links, fail closed and retain the pending
    // file; there is deliberately no weaker direct-write fallback.
    fs::hard_link(&pending_manifest_path, &manifest_path)
        .map_err(|source| io_error("publish manifest commit marker", &manifest_path, source))?;
    Ok(manifest_path)
}

fn validate_global_k(k: [f64; 3]) -> Result<(), SingleKCheckpointError> {
    if k.iter().any(|component| !component.is_finite()) {
        return Err(SingleKCheckpointError::InvalidInput(
            "global k must be finite",
        ));
    }
    Ok(())
}

fn validate_point_plan_k(
    point_plan: &FemEigenPlanIR,
    requested_k: [f64; 3],
) -> Result<(), SingleKCheckpointError> {
    match point_plan.k_sampling.as_ref() {
        Some(KSamplingIR::Single { k_vector }) => {
            if k_vector.iter().any(|component| !component.is_finite()) || *k_vector != requested_k {
                return Err(SingleKCheckpointError::InvalidInput(
                    "single-k point plan does not numerically match requested global k",
                ));
            }
        }
        None if requested_k == [0.0, 0.0, 0.0] => {}
        None => {
            return Err(SingleKCheckpointError::InvalidInput(
                "point plan without k_sampling is valid only for exact Gamma",
            ));
        }
        Some(KSamplingIR::Path { .. }) => {
            return Err(SingleKCheckpointError::InvalidInput(
                "point plan must be single-k, not a path",
            ));
        }
    }
    Ok(())
}

fn prepare_artifacts<'a>(
    artifacts: &'a [AuxiliaryArtifact],
) -> Result<Vec<PreparedArtifact<'a>>, SingleKCheckpointError> {
    let mut prepared = Vec::with_capacity(artifacts.len());
    let mut spelling_by_folded_prefix = BTreeMap::<String, String>::new();
    let mut file_paths = BTreeSet::<String>::new();
    let mut directory_paths = BTreeSet::<String>::new();
    let mut has_spectrum = false;

    for artifact in artifacts {
        let components = validate_artifact_path(&artifact.relative_path)?;
        if artifact.relative_path == SPECTRUM_ARTIFACT {
            has_spectrum = true;
        }
        let mut original_prefix = Vec::with_capacity(components.len());
        let mut folded_prefix = Vec::with_capacity(components.len());
        for (index, component) in components.iter().enumerate() {
            original_prefix.push(*component);
            folded_prefix.push(component.to_lowercase());
            let original = original_prefix.join("/");
            let folded = folded_prefix.join("/");
            if let Some(previous) = spelling_by_folded_prefix.get(&folded) {
                if previous != &original {
                    return Err(SingleKCheckpointError::InvalidInput(
                        "artifact paths contain a case-insensitive alias",
                    ));
                }
            } else {
                spelling_by_folded_prefix.insert(folded.clone(), original);
            }
            if index + 1 == components.len() {
                if !file_paths.insert(folded) {
                    return Err(SingleKCheckpointError::InvalidInput(
                        "duplicate artifact path",
                    ));
                }
            } else {
                directory_paths.insert(folded);
            }
        }
        let relative_path = format!("artifacts/{}", artifact.relative_path);
        prepared.push(PreparedArtifact {
            source: artifact,
            components,
            record: ArtifactRecord {
                relative_path,
                source_relative_path: artifact.relative_path.clone(),
                size_bytes: checked_size(artifact.bytes.len())?,
                sha256: sha256(&artifact.bytes),
            },
        });
    }

    if !has_spectrum {
        return Err(SingleKCheckpointError::InvalidInput(
            "artifact slice is missing exact eigen/spectrum.json",
        ));
    }
    if file_paths.iter().any(|path| directory_paths.contains(path)) {
        return Err(SingleKCheckpointError::InvalidInput(
            "artifact paths contain a file/directory prefix collision",
        ));
    }
    Ok(prepared)
}

fn validate_artifact_path(path: &str) -> Result<Vec<&str>, SingleKCheckpointError> {
    if path.is_empty() || path.starts_with('/') || path.contains('\\') {
        return Err(SingleKCheckpointError::InvalidInput(
            "artifact path is empty, absolute, or uses backslashes",
        ));
    }
    let components = path.split('/').collect::<Vec<_>>();
    if components.iter().any(|component| {
        component.is_empty()
            || *component == "."
            || *component == ".."
            || component.ends_with('.')
            || component.ends_with(' ')
            || component.chars().any(|character| {
                character.is_control()
                    || matches!(character, ':' | '<' | '>' | '"' | '|' | '?' | '*')
            })
            || is_windows_reserved_component(component)
    }) {
        return Err(SingleKCheckpointError::InvalidInput(
            "artifact path contains a non-portable component",
        ));
    }
    Ok(components)
}

fn is_windows_reserved_component(component: &str) -> bool {
    let before_extension = component.split('.').next().unwrap_or(component);
    let base = before_extension.trim_end_matches(|character| character == '.' || character == ' ');
    let upper = base.to_ascii_uppercase();
    matches!(upper.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || ["COM", "LPT"].iter().any(|prefix| {
            upper.strip_prefix(prefix).is_some_and(|suffix| {
                suffix.len() == 1 && matches!(suffix.as_bytes()[0], b'1'..=b'9')
            })
        })
}

/// Resolve and prepare the solver's output directory before native execution.
///
/// Every path prefix is checked as an ordinary directory before dot or parent
/// components can affect the resolved path. Missing ordinary directories are
/// created one component at a time; symlinks and reparse points are rejected.
pub(super) fn prepare_checkpoint_process_root(
    output_dir: &Path,
) -> Result<PathBuf, SingleKCheckpointError> {
    let current_dir = std::env::current_dir()
        .map_err(|source| io_error("read current directory", output_dir, source))?;
    prepare_checkpoint_process_root_from_base(output_dir, &current_dir)
}

fn prepare_checkpoint_process_root_from_base(
    output_dir: &Path,
    base_dir: &Path,
) -> Result<PathBuf, SingleKCheckpointError> {
    if !base_dir.is_absolute() {
        return Err(SingleKCheckpointError::InvalidInput(
            "checkpoint output base must be absolute",
        ));
    }
    if !output_dir.is_absolute()
        && output_dir
            .components()
            .any(|component| matches!(component, std::path::Component::Prefix(_)))
    {
        return Err(SingleKCheckpointError::InvalidInput(
            "checkpoint output directory must not be drive-relative",
        ));
    }

    let requested = if output_dir.is_absolute() {
        output_dir.to_path_buf()
    } else {
        base_dir.join(output_dir)
    };
    if !requested.is_absolute() {
        return Err(SingleKCheckpointError::InvalidInput(
            "checkpoint output directory must resolve to an absolute path",
        ));
    }

    let mut current = PathBuf::new();
    for component in requested.components() {
        match component {
            std::path::Component::Prefix(_) => current.push(component.as_os_str()),
            std::path::Component::RootDir => {
                current.push(component.as_os_str());
                ensure_existing_plain_directory(&current)?;
            }
            std::path::Component::CurDir => ensure_existing_plain_directory(&current)?,
            std::path::Component::ParentDir => {
                // Inspect the directory being left before applying parent traversal.
                ensure_existing_plain_directory(&current)?;
                if let Some(parent) = current.parent() {
                    current = parent.to_path_buf();
                }
                ensure_existing_plain_directory(&current)?;
            }
            std::path::Component::Normal(name) => {
                current.push(name);
                ensure_plain_directory(&current)?;
            }
        }
    }
    ensure_existing_plain_directory(&current)?;
    validate_managed_process_root(&current)
}

/// Allocate a fresh immutable namespace for raw checkpoints from one run.
pub(super) fn create_raw_checkpoint_attempt(
    process_root: &Path,
) -> Result<PathBuf, SingleKCheckpointError> {
    let process_root = validate_managed_process_root(process_root)?;
    let eigen_root = process_root.join("eigen");
    ensure_plain_directory(&eigen_root)?;
    let attempts_root = eigen_root.join("raw-checkpoint-attempts");
    ensure_plain_directory(&attempts_root)?;

    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| {
            SingleKCheckpointError::InvalidInput(
                "system clock is before the Unix epoch for checkpoint attempt naming",
            )
        })?
        .as_nanos();
    let mut last_attempt = attempts_root.clone();
    for _ in 0..MAX_RAW_CHECKPOINT_ATTEMPT_COLLISIONS {
        let counter = NEXT_RAW_CHECKPOINT_ATTEMPT_ID.fetch_add(1, Ordering::Relaxed);
        let attempt_root = attempts_root.join(format!(
            "attempt-{}-{timestamp}-{counter}",
            std::process::id()
        ));
        last_attempt = attempt_root.clone();
        match fs::create_dir(&attempt_root) {
            Ok(()) => {
                ensure_existing_plain_directory(&attempt_root)?;
                return validate_managed_process_root(&attempt_root);
            }
            Err(source) if source.kind() == io::ErrorKind::AlreadyExists => {
                // A collision is never reused. Inspect it immediately so an
                // unexpected symlink or reparse point fails closed.
                ensure_existing_plain_directory(&attempt_root)?;
            }
            Err(source) => {
                return Err(io_error(
                    "create raw checkpoint attempt",
                    &attempt_root,
                    source,
                ));
            }
        }
    }
    Err(io_error(
        "allocate unique raw checkpoint attempt",
        &last_attempt,
        io::Error::new(
            io::ErrorKind::AlreadyExists,
            "exhausted bounded attempt-name collision retries",
        ),
    ))
}

fn validate_managed_process_root(root: &Path) -> Result<PathBuf, SingleKCheckpointError> {
    if !root.is_absolute() {
        return Err(SingleKCheckpointError::InvalidInput(
            "managed process_root must be absolute",
        ));
    }
    if root
        .components()
        .any(|component| matches!(component, std::path::Component::ParentDir))
    {
        return Err(SingleKCheckpointError::InvalidInput(
            "managed process_root must not contain parent traversal",
        ));
    }
    let metadata = fs::symlink_metadata(root)
        .map_err(|source| io_error("inspect managed process root", root, source))?;
    ensure_not_link_or_reparse(root, &metadata)?;
    if !metadata.is_dir() {
        return Err(SingleKCheckpointError::InvalidInput(
            "managed process_root must be an existing directory",
        ));
    }
    for ancestor in root.ancestors().skip(1) {
        let metadata = fs::symlink_metadata(ancestor)
            .map_err(|source| io_error("inspect process-root ancestor", ancestor, source))?;
        ensure_not_link_or_reparse(ancestor, &metadata)?;
        if !metadata.is_dir() {
            return Err(SingleKCheckpointError::InvalidInput(
                "managed process_root has a non-directory ancestor",
            ));
        }
    }
    fs::canonicalize(root).map_err(|source| io_error("canonicalize process root", root, source))
}

fn ensure_plain_directory(path: &Path) -> Result<(), SingleKCheckpointError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => {
            ensure_not_link_or_reparse(path, &metadata)?;
            if !metadata.is_dir() {
                return Err(SingleKCheckpointError::InvalidInput(
                    "checkpoint parent exists but is not a directory",
                ));
            }
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            match fs::create_dir(path) {
                Ok(()) => ensure_existing_plain_directory(path)?,
                Err(source) if source.kind() == io::ErrorKind::AlreadyExists => {
                    // Another invocation may have created this ordinary
                    // directory. Verify it immediately, including link bits.
                    ensure_existing_plain_directory(path)?;
                }
                Err(source) => {
                    return Err(io_error("create checkpoint parent", path, source));
                }
            }
        }
        Err(source) => return Err(io_error("inspect checkpoint parent", path, source)),
    }
    Ok(())
}

fn ensure_existing_plain_directory(path: &Path) -> Result<(), SingleKCheckpointError> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|source| io_error("verify checkpoint directory", path, source))?;
    ensure_not_link_or_reparse(path, &metadata)?;
    if !metadata.is_dir() {
        return Err(SingleKCheckpointError::InvalidInput(
            "checkpoint path is not an ordinary directory",
        ));
    }
    Ok(())
}

fn ensure_not_link_or_reparse(
    path: &Path,
    metadata: &fs::Metadata,
) -> Result<(), SingleKCheckpointError> {
    if metadata.file_type().is_symlink() || is_reparse_point(metadata) {
        return Err(SingleKCheckpointError::InvalidInput(
            "checkpoint path traverses a symlink or reparse point",
        ));
    }
    let _ = path;
    Ok(())
}

#[cfg(windows)]
fn is_reparse_point(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
    metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
fn is_reparse_point(_metadata: &fs::Metadata) -> bool {
    false
}

fn write_new_synced_file(path: &Path, bytes: &[u8]) -> Result<(), SingleKCheckpointError> {
    let file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|source| io_error("create file without overwrite", path, source))?;
    write_and_sync(file, path, bytes)
}

fn write_and_sync(mut file: File, path: &Path, bytes: &[u8]) -> Result<(), SingleKCheckpointError> {
    file.write_all(bytes)
        .map_err(|source| io_error("write file", path, source))?;
    file.sync_all()
        .map_err(|source| io_error("sync file contents", path, source))
}

fn checked_size(size: usize) -> Result<u64, SingleKCheckpointError> {
    u64::try_from(size)
        .map_err(|_| SingleKCheckpointError::InvalidInput("artifact size exceeds u64"))
}

fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn io_error(operation: &'static str, path: &Path, source: io::Error) -> SingleKCheckpointError {
    SingleKCheckpointError::Io {
        operation,
        path: path.to_path_buf(),
        source,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT_TEMP_ID: AtomicU64 = AtomicU64::new(0);

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new() -> Self {
            let id = NEXT_TEMP_ID.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!(
                "fullmag-single-k-checkpoint-{}-{id}",
                std::process::id()
            ));
            fs::create_dir(&path).expect("create test-owned temporary directory");
            let canonical = fs::canonicalize(&path).expect("canonicalize test directory");
            Self(canonical)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            // This guard owns the unique path it created above.
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn single_k_plan(k: [f64; 3]) -> FemEigenPlanIR {
        let mut plan = crate::fem::eigen_tests::minimal_native_modal_plan();
        plan.k_sampling = Some(KSamplingIR::Single { k_vector: k });
        plan
    }

    fn artifacts() -> Vec<AuxiliaryArtifact> {
        vec![AuxiliaryArtifact {
            relative_path: SPECTRUM_ARTIFACT.into(),
            bytes: br#"{"schema_version":"Spectrum.v1","modes":[]}"#.to_vec(),
        }]
    }

    fn run(
        root: &Path,
        index: usize,
        k: [f64; 3],
        plan: &FemEigenPlanIR,
        files: &[AuxiliaryArtifact],
    ) -> Result<PathBuf, SingleKCheckpointError> {
        write_raw_single_k_checkpoint(root, index, k, plan, files)
    }

    #[test]
    fn writes_exact_plan_artifact_hashes_and_diagnostic_manifest_last() {
        let root = TestDirectory::new();
        let k = [0.0, 0.0, 0.0];
        let plan = single_k_plan(k);
        let files = artifacts();
        let manifest_path = run(root.path(), 7, k, &plan, &files).expect("checkpoint write");
        let sample_root = manifest_path.parent().expect("sample directory");
        let point_plan = fs::read(sample_root.join("point-plan.json")).expect("point plan");
        assert_eq!(
            point_plan,
            serde_json::to_vec(&plan).expect("serialize exact plan")
        );
        let artifact_path = sample_root.join("artifacts/eigen/spectrum.json");
        assert_eq!(
            fs::read(&artifact_path).expect("raw spectrum"),
            files[0].bytes
        );
        let manifest: serde_json::Value =
            serde_json::from_slice(&fs::read(&manifest_path).expect("manifest bytes"))
                .expect("manifest JSON");
        assert_eq!(manifest["schema"], CHECKPOINT_SCHEMA_V1);
        assert_eq!(manifest["result_disposition"], "raw_native_returned");
        assert_eq!(manifest["requires_postsolve"], true);
        assert_eq!(manifest["sample_index"], 7);
        assert_eq!(manifest["point_plan"]["relative_path"], "point-plan.json");
        assert_eq!(
            manifest["point_plan"]["size_bytes"],
            point_plan.len() as u64
        );
        assert_eq!(manifest["point_plan"]["sha256"], sha256(&point_plan));
        for digest in [
            manifest["point_plan"]["sha256"]
                .as_str()
                .expect("plan digest"),
            manifest["artifacts"][0]["sha256"]
                .as_str()
                .expect("artifact digest"),
        ] {
            assert_eq!(digest.len(), 64);
            assert!(digest
                .chars()
                .all(|character| character.is_ascii_digit() || ('a'..='f').contains(&character)));
        }
        assert_eq!(
            manifest["artifacts"][0]["relative_path"],
            "artifacts/eigen/spectrum.json"
        );
        assert_eq!(manifest["artifacts"][0]["sha256"], sha256(&files[0].bytes));
        assert_eq!(manifest["campaign_complete"], false);
        assert_eq!(manifest["branch_tracking_complete"], false);
        assert_eq!(manifest["scientific_qualification"], "NOT VERIFIED");
        assert!(sample_root.join("manifest.pending").is_file());
    }

    #[test]
    fn writes_multiple_artifacts_with_a_shared_parent_directory() {
        let root = TestDirectory::new();
        let k = [0.0, 0.0, 0.0];
        let plan = single_k_plan(k);
        let files = [
            AuxiliaryArtifact {
                relative_path: SPECTRUM_ARTIFACT.into(),
                bytes: b"spectrum".to_vec(),
            },
            AuxiliaryArtifact {
                relative_path: "eigen/diagnostics.json".into(),
                bytes: b"diagnostics".to_vec(),
            },
        ];
        let manifest_path = run(root.path(), 10, k, &plan, &files).expect("checkpoint write");
        let sample_root = manifest_path.parent().expect("sample directory");
        assert_eq!(
            fs::read(sample_root.join("artifacts/eigen/spectrum.json")).expect("spectrum"),
            b"spectrum"
        );
        assert_eq!(
            fs::read(sample_root.join("artifacts/eigen/diagnostics.json")).expect("diagnostics"),
            b"diagnostics"
        );
        assert!(sample_root.join("manifest.pending").is_file());
        assert!(manifest_path.is_file());
    }

    #[test]
    fn gamma_without_explicit_sampling_is_bound_to_exact_zero_only() {
        let root = TestDirectory::new();
        let mut plan = single_k_plan([0.0, 0.0, 0.0]);
        plan.k_sampling = None;
        assert!(run(root.path(), 0, [0.0, 0.0, 0.0], &plan, &artifacts()).is_ok());
        assert!(matches!(
            run(root.path(), 1, [0.0, 1.0, 0.0], &plan, &artifacts()),
            Err(SingleKCheckpointError::InvalidInput(_))
        ));
    }

    #[test]
    fn rejects_nonfinite_or_mismatched_k_and_path_plans_before_writing() {
        let root = TestDirectory::new();
        let files = artifacts();
        let plan = single_k_plan([1.0, 0.0, 0.0]);
        assert!(run(root.path(), 0, [f64::NAN, 0.0, 0.0], &plan, &files).is_err());
        assert!(run(root.path(), 1, [2.0, 0.0, 0.0], &plan, &files).is_err());
        let mut path_plan = plan.clone();
        path_plan.k_sampling = Some(KSamplingIR::Path {
            points: Vec::new(),
            samples_per_segment: Vec::new(),
            closed: false,
        });
        assert!(run(root.path(), 2, [1.0, 0.0, 0.0], &path_plan, &files).is_err());
        assert!(!root.path().join("eigen").exists());
    }

    #[test]
    fn rejects_empty_artifacts_missing_spectrum_and_unsafe_paths_before_writing() {
        let root = TestDirectory::new();
        let k = [0.0, 0.0, 0.0];
        let plan = single_k_plan(k);
        assert!(run(root.path(), 0, k, &plan, &[]).is_err());
        assert!(run(
            root.path(),
            1,
            k,
            &plan,
            &[AuxiliaryArtifact {
                relative_path: "eigen/other.json".into(),
                bytes: vec![]
            }],
        )
        .is_err());
        for path in [
            "",
            ".",
            "eigen/../spectrum.json",
            "/eigen/spectrum.json",
            "eigen\\spectrum.json",
            "C:/eigen/spectrum.json",
            "eigen/CON.json",
            "eigen/PRN.txt",
            "eigen/AUX",
            "eigen/NUL.json",
            "eigen/COM1.log",
            "eigen/LPT9.dat",
            "eigen/name.",
            "eigen/name ",
            "eigen/bad?name.json",
        ] {
            let bad = [AuxiliaryArtifact {
                relative_path: path.into(),
                bytes: vec![],
            }];
            assert!(
                run(root.path(), 3, k, &plan, &bad).is_err(),
                "accepted {path:?}"
            );
        }
        assert!(!root.path().join("eigen").exists());
    }

    #[test]
    fn rejects_case_alias_duplicate_and_file_directory_prefix_collisions() {
        let root = TestDirectory::new();
        let k = [0.0, 0.0, 0.0];
        let plan = single_k_plan(k);
        let cases = [
            vec![
                AuxiliaryArtifact {
                    relative_path: SPECTRUM_ARTIFACT.into(),
                    bytes: vec![],
                },
                AuxiliaryArtifact {
                    relative_path: SPECTRUM_ARTIFACT.into(),
                    bytes: vec![],
                },
            ],
            vec![
                AuxiliaryArtifact {
                    relative_path: SPECTRUM_ARTIFACT.into(),
                    bytes: vec![],
                },
                AuxiliaryArtifact {
                    relative_path: "Eigen/other.json".into(),
                    bytes: vec![],
                },
            ],
            vec![
                AuxiliaryArtifact {
                    relative_path: SPECTRUM_ARTIFACT.into(),
                    bytes: vec![],
                },
                AuxiliaryArtifact {
                    relative_path: "eigen".into(),
                    bytes: vec![],
                },
            ],
        ];
        for files in cases {
            assert!(run(root.path(), 4, k, &plan, &files).is_err());
        }
        assert!(!root.path().join("eigen").exists());
    }

    #[test]
    fn existing_namespace_is_never_overwritten() {
        let root = TestDirectory::new();
        let namespace = root.path().join("eigen/sample-checkpoints/sample-0005");
        fs::create_dir_all(&namespace).expect("prepare occupied namespace");
        fs::write(namespace.join("sentinel"), b"keep").expect("write sentinel");
        let plan = single_k_plan([0.0, 0.0, 0.0]);
        assert!(run(root.path(), 5, [0.0, 0.0, 0.0], &plan, &artifacts()).is_err());
        assert_eq!(
            fs::read(namespace.join("sentinel")).expect("sentinel bytes"),
            b"keep"
        );
        assert!(!namespace.join("manifest.json").exists());
    }

    #[test]
    fn earlier_sample_survives_later_failure_without_campaign_publication() {
        let root = TestDirectory::new();
        let first_k = [0.0, -10_000_000.0, 0.0];
        let first_plan = single_k_plan(first_k);
        let first_files = artifacts();
        let first_manifest = run(root.path(), 0, first_k, &first_plan, &first_files)
            .expect("preserve first raw sample");
        let first_bytes = fs::read(&first_manifest).expect("read first manifest");
        let later_plan = single_k_plan([0.0, 10_000_000.0, 0.0]);
        assert!(run(root.path(), 1, first_k, &later_plan, &artifacts()).is_err());
        assert_eq!(
            fs::read(&first_manifest).expect("first still readable"),
            first_bytes
        );
        let spectrum = first_manifest
            .parent()
            .unwrap()
            .join("artifacts/eigen/spectrum.json");
        assert_eq!(
            fs::read(spectrum).expect("first raw spectrum"),
            first_files[0].bytes
        );
        assert!(!root.path().join("eigen/path.json").exists());
        assert!(!root.path().join("eigen/branches.json").exists());
        assert!(!root
            .path()
            .join("eigen/sample-checkpoints/sample-0001/manifest.json")
            .exists());
    }

    #[test]
    fn io_failure_leaves_partial_namespace_but_no_manifest_marker() {
        let root = TestDirectory::new();
        let k = [0.0, 0.0, 0.0];
        let plan = single_k_plan(k);
        let long_component = "x".repeat(300);
        let files = [
            AuxiliaryArtifact {
                relative_path: SPECTRUM_ARTIFACT.into(),
                bytes: vec![1],
            },
            AuxiliaryArtifact {
                relative_path: format!("eigen/{long_component}/bad.bin"),
                bytes: vec![2],
            },
        ];
        assert!(run(root.path(), 8, k, &plan, &files).is_err());
        let sample_root = root.path().join("eigen/sample-checkpoints/sample-0008");
        assert!(sample_root.is_dir(), "partial namespace is preserved");
        assert!(
            !sample_root.join("manifest.json").exists(),
            "commit marker is last"
        );
        assert!(!sample_root.join("manifest.pending").exists());
    }

    #[test]
    fn prepares_relative_nonexistent_output_root_against_explicit_base() {
        let base = TestDirectory::new();
        let output = Path::new("new-run/nested");
        let resolved = prepare_checkpoint_process_root_from_base(output, base.path())
            .expect("prepare relative output root");
        assert_eq!(
            resolved,
            fs::canonicalize(base.path().join(output)).expect("canonical output root")
        );
        assert!(resolved.is_absolute());
        assert!(resolved.is_dir());
    }

    #[test]
    fn verifies_components_before_parent_normalization() {
        let base = TestDirectory::new();
        let output = Path::new("created-before-parent/../resolved/./nested");
        let resolved = prepare_checkpoint_process_root_from_base(output, base.path())
            .expect("normalize checked ordinary directories");
        assert!(base.path().join("created-before-parent").is_dir());
        assert_eq!(
            resolved,
            fs::canonicalize(base.path().join("resolved/nested"))
                .expect("canonical normalized root")
        );
    }

    #[test]
    fn rejects_non_directory_before_parent_normalization() {
        let base = TestDirectory::new();
        fs::write(base.path().join("file"), b"keep").expect("create non-directory prefix");
        assert!(prepare_checkpoint_process_root_from_base(
            Path::new("file/../output"),
            base.path()
        )
        .is_err());
        assert!(!base.path().join("output").exists());
    }

    #[test]
    fn same_sample_index_is_isolated_by_fresh_attempt_roots() {
        let root = TestDirectory::new();
        let first_root =
            create_raw_checkpoint_attempt(root.path()).expect("first checkpoint attempt");
        let second_root =
            create_raw_checkpoint_attempt(root.path()).expect("second checkpoint attempt");
        assert_ne!(first_root, second_root);

        let k = [0.0, 0.0, 0.0];
        let plan = single_k_plan(k);
        let mut first_files = artifacts();
        first_files[0].bytes = b"first raw spectrum".to_vec();
        let first_manifest =
            run(&first_root, 0, k, &plan, &first_files).expect("write first sample zero");
        let first_spectrum = first_manifest
            .parent()
            .expect("first sample namespace")
            .join("artifacts/eigen/spectrum.json");
        let first_bytes = fs::read(&first_spectrum).expect("read first raw spectrum");

        let mut second_files = artifacts();
        second_files[0].bytes = b"second raw spectrum".to_vec();
        let second_manifest =
            run(&second_root, 0, k, &plan, &second_files).expect("write second sample zero");
        let second_spectrum = second_manifest
            .parent()
            .expect("second sample namespace")
            .join("artifacts/eigen/spectrum.json");
        assert_eq!(
            fs::read(&first_spectrum).expect("first remains immutable"),
            first_bytes
        );
        assert_eq!(
            fs::read(&second_spectrum).expect("second raw spectrum"),
            second_files[0].bytes
        );
        assert!(first_manifest.is_file());
        assert!(second_manifest.is_file());
    }

    #[test]
    fn concurrent_attempt_allocations_are_unique() {
        let root = TestDirectory::new();
        let handles = (0..8)
            .map(|_| {
                let process_root = root.path().to_path_buf();
                std::thread::spawn(move || {
                    create_raw_checkpoint_attempt(&process_root)
                        .expect("allocate concurrent checkpoint attempt")
                })
            })
            .collect::<Vec<_>>();
        let paths = handles
            .into_iter()
            .map(|handle| handle.join().expect("attempt allocation thread"))
            .collect::<BTreeSet<_>>();
        assert_eq!(paths.len(), 8);
        assert!(paths.iter().all(|path| path.is_dir()));
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlink_prefix_before_parent_normalization() {
        use std::os::unix::fs::symlink;

        let base = TestDirectory::new();
        let external = TestDirectory::new();
        symlink(external.path(), base.path().join("link")).expect("create test symlink");
        assert!(prepare_checkpoint_process_root_from_base(
            Path::new("link/../output"),
            base.path()
        )
        .is_err());
        assert!(!base.path().join("output").exists());
        assert_eq!(
            fs::read_dir(external.path())
                .expect("external directory")
                .count(),
            0
        );
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlink_checkpoint_parent_without_writing_through_it() {
        use std::os::unix::fs::symlink;

        let root = TestDirectory::new();
        let external = TestDirectory::new();
        symlink(external.path(), root.path().join("eigen")).expect("create test symlink");
        let plan = single_k_plan([0.0, 0.0, 0.0]);
        assert!(run(root.path(), 9, [0.0, 0.0, 0.0], &plan, &artifacts()).is_err());
        assert_eq!(
            fs::read_dir(external.path())
                .expect("external directory")
                .count(),
            0
        );
    }
}
