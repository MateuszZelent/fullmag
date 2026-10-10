//! `fullmag-run.json`: the record every script or project run leaves in its
//! results folder (`fullmag.run_manifest.v1`).
//!
//! It is written atomically when the run starts (`status: running`) and again
//! when it ends, so a folder that was killed mid-run still says what it was.
//! The workspace scanner and the browser inspector read it to link a result
//! folder to the script or project that produced it. The manifest never
//! holds file text or environment values, and it lives in the results folder
//! only, never next to or inside the user's `.py` or `.fms`.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

/// File name of the manifest inside a results folder.
pub const RUN_MANIFEST_FILE: &str = "fullmag-run.json";
/// Value of `schema`.
pub const RUN_MANIFEST_SCHEMA: &str = "fullmag.run_manifest.v1";
/// A manifest larger than this is treated as damaged.
pub const MAX_RUN_MANIFEST_BYTES: u64 = 1024 * 1024;
/// Producer-owned digest binding for the terminal metadata and run manifest.
const RUN_ARTIFACT_ATTESTATION_FILE: &str = ".fullmag-run-artifacts.v1.json";
/// Value of the producer artifact attestation's `schema` field.
const RUN_ARTIFACT_ATTESTATION_SCHEMA: &str = "fullmag.run_artifact_attestation.v1";
// Persistent lock inode; its kernel lock is released on handle/process close.
const RUN_MANIFEST_WRITER_LOCK_FILE: &str = ".fullmag-run-manifest.writer.lock";

const METADATA_RELATIVE_PATH: &str = "artifacts/metadata.json";
const MAX_METADATA_ARTIFACT_BYTES: u64 = 16 * 1024 * 1024;
const MAX_RUN_ARTIFACT_ATTESTATION_BYTES: u64 = 64 * 1024;
static TEMPORARY_FILE_COUNTER: AtomicUsize = AtomicUsize::new(0);

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
struct RunArtifactAttestation {
    schema: String,
    status: String,
    exit_code: i32,
    run_id: String,
    session_id: String,
    source_sha256: String,
    metadata_relative_path: String,
    metadata_sha256: String,
    manifest_sha256: String,
}

struct RunManifestWriterGate {
    _file: File,
}

impl RunManifestWriterGate {
    fn acquire(results_dir: &Path) -> io::Result<Self> {
        // Never unlink this file: replacing an inode while a process holds its
        // lock could let a second publisher lock a different inode.
        let path = results_dir.join(RUN_MANIFEST_WRITER_LOCK_FILE);
        reject_reparse_ancestors(&path)?;
        let before = match fs::symlink_metadata(&path) {
            Ok(metadata) => Some(metadata),
            Err(error) if error.kind() == io::ErrorKind::NotFound => None,
            Err(error) => return Err(error),
        };
        if before.as_ref().is_some_and(|metadata| {
            is_link_or_reparse(metadata) || !metadata.is_file() || metadata.len() != 0
        }) {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "run manifest writer gate is not a regular file",
            ));
        }

        let mut options = OpenOptions::new();
        options.read(true).write(true).create(true);
        #[cfg(any(target_os = "linux", target_os = "android"))]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.custom_flags(0x20000 | 0x800); // O_NOFOLLOW | O_NONBLOCK
        }
        #[cfg(any(target_os = "macos", target_os = "ios", target_os = "freebsd"))]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.custom_flags(0x100 | 0x4); // O_NOFOLLOW | O_NONBLOCK
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            options
                .share_mode(0x3) // FILE_SHARE_READ | FILE_SHARE_WRITE; deny replacement.
                .custom_flags(0x0020_0000); // FILE_FLAG_OPEN_REPARSE_POINT
        }
        #[cfg(all(
            unix,
            not(any(
                target_os = "linux",
                target_os = "android",
                target_os = "macos",
                target_os = "ios",
                target_os = "freebsd"
            ))
        ))]
        {
            return Err(io::Error::new(
                io::ErrorKind::Unsupported,
                "run manifest writer locking is unsupported on this Unix target",
            ));
        }
        #[cfg(not(any(unix, windows)))]
        {
            return Err(io::Error::new(
                io::ErrorKind::Unsupported,
                "run manifest writer locking is unsupported on this target",
            ));
        }

        let file = options.open(&path)?;
        let opened = file.metadata()?;
        reject_reparse_ancestors(&path)?;
        let path_after = fs::symlink_metadata(&path)?;
        if is_link_or_reparse(&opened)
            || !opened.is_file()
            || opened.len() != 0
            || is_link_or_reparse(&path_after)
            || !path_after.is_file()
            || path_after.len() != 0
            || opened.len() != path_after.len()
            || opened.modified()? != path_after.modified()?
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "run manifest writer gate changed while opening",
            ));
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            if opened.dev() != path_after.dev() || opened.ino() != path_after.ino() {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "run manifest writer gate identity changed while opening",
                ));
            }
            if let Some(before) = before.as_ref() {
                if before.dev() != opened.dev() || before.ino() != opened.ino() {
                    return Err(io::Error::new(
                        io::ErrorKind::WouldBlock,
                        "run manifest writer gate path changed while opening",
                    ));
                }
            }
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            if opened.file_attributes() != path_after.file_attributes()
                || opened.file_size() != path_after.file_size()
                || opened.last_write_time() != path_after.last_write_time()
            {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "run manifest writer gate path changed while opening",
                ));
            }
            if let Some(before) = before.as_ref() {
                if before.file_attributes() != opened.file_attributes()
                    || before.file_size() != opened.file_size()
                    || before.last_write_time() != opened.last_write_time()
                {
                    return Err(io::Error::new(
                        io::ErrorKind::WouldBlock,
                        "run manifest writer gate path changed while opening",
                    ));
                }
            }
        }
        if before.is_none() {
            file.sync_all()?;
            sync_directory(results_dir)?;
        }
        match file.try_lock() {
            Ok(()) => Ok(Self { _file: file }),
            Err(std::fs::TryLockError::WouldBlock) => Err(io::Error::new(
                io::ErrorKind::WouldBlock,
                "another process is publishing this run manifest",
            )),
            Err(std::fs::TryLockError::Error(error)) => Err(error),
        }
    }
}

/// What produced the results.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "utoipa", derive(utoipa::ToSchema))]
pub struct RunSource {
    /// `script` or `project`.
    pub kind: String,
    /// Absolute path as the user would type it (no `\\?\` prefix). Empty when
    /// the producer does not know the file (accepted project runs record the
    /// project id and revision instead).
    #[serde(default)]
    pub path: String,
    /// SHA-256 of the script bytes (or of the archive) when known.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sha256: Option<String>,
    /// Stable project id (projects only).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    /// Definition revision that was run (projects only).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub revision: Option<u64>,
}

/// One stage of a run.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "utoipa", derive(utoipa::ToSchema))]
pub struct StageSummary {
    pub id: String,
    #[serde(default)]
    pub kind: Option<String>,
    #[serde(default)]
    pub steps: Option<u64>,
    #[serde(default)]
    pub time_s: Option<f64>,
}

/// One output the run produced, relative to the results folder.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "utoipa", derive(utoipa::ToSchema))]
pub struct RunOutput {
    pub path: String,
    pub kind: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "utoipa", derive(utoipa::ToSchema))]
pub struct RunManifest {
    pub schema: String,
    pub run_id: String,
    pub source: RunSource,
    /// What the user asked for (backend, device, precision, mode, ...).
    #[cfg_attr(feature = "utoipa", schema(value_type = Object))]
    pub requested: Value,
    /// What the run resolved to; `null` until the runtime is selected.
    #[cfg_attr(feature = "utoipa", schema(value_type = Object))]
    pub resolved: Value,
    pub started_at: String,
    #[serde(default)]
    pub finished_at: Option<String>,
    /// `running`, `completed`, `failed`, `cancelled` or `not_started`.
    pub status: String,
    #[serde(default)]
    pub exit_code: Option<i32>,
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub stages: Vec<StageSummary>,
    #[serde(default)]
    pub outputs: Vec<RunOutput>,
    pub fullmag_version: String,
    /// `cli`, `desktop`, `api`, ...
    #[serde(default)]
    pub launched_by: Option<String>,
    #[serde(default)]
    pub session_id: Option<String>,
    /// Digest of the accepted run specification (project runs only).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_spec_sha256: Option<String>,
}

impl RunManifest {
    pub fn new(
        run_id: impl Into<String>,
        source: RunSource,
        fullmag_version: impl Into<String>,
        started_at: impl Into<String>,
    ) -> Self {
        Self {
            schema: RUN_MANIFEST_SCHEMA.to_string(),
            run_id: run_id.into(),
            source,
            requested: Value::Null,
            resolved: Value::Null,
            started_at: started_at.into(),
            finished_at: None,
            status: "running".to_string(),
            exit_code: None,
            error: None,
            stages: Vec::new(),
            outputs: Vec::new(),
            fullmag_version: fullmag_version.into(),
            launched_by: None,
            session_id: None,
            run_spec_sha256: None,
        }
    }
}

/// Path of the manifest inside `results_dir`.
pub fn manifest_path(results_dir: &Path) -> PathBuf {
    results_dir.join(RUN_MANIFEST_FILE)
}

/// Write the manifest through a temporary sibling and a rename, so a reader
/// never sees a partial document. Eligible successful runs publish a digest
/// attestation before the terminal manifest; an already-terminal record is
/// immutable, except for an exact retry with its original attestation.
pub fn write_run_manifest(results_dir: &Path, manifest: &RunManifest) -> std::io::Result<()> {
    let results_dir = prepare_results_dir(results_dir)?;
    let target = manifest_path(&results_dir);
    let bytes = serde_json::to_vec_pretty(manifest)
        .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error))?;
    if bytes.len() as u64 > MAX_RUN_MANIFEST_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "serialized run manifest exceeds its byte limit",
        ));
    }

    let _writer_gate = RunManifestWriterGate::acquire(&results_dir)?;
    let existing = read_optional_bounded_file(&target, MAX_RUN_MANIFEST_BYTES)?;
    if let Some(existing_bytes) = existing.as_deref() {
        let previous: RunManifest = serde_json::from_slice(existing_bytes).map_err(|error| {
            io::Error::new(
                io::ErrorKind::InvalidData,
                format!("existing {RUN_MANIFEST_FILE} is malformed: {error}"),
            )
        })?;
        if previous.schema != RUN_MANIFEST_SCHEMA {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!("existing {RUN_MANIFEST_FILE} has an unsupported schema"),
            ));
        }
        if previous.status != "running" {
            if existing_bytes != bytes {
                return Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "refusing to replace an already-terminal run manifest",
                ));
            }
            return verify_terminal_retry(&results_dir, manifest, &bytes);
        }
    }

    let attestation = if is_attestation_eligible(manifest) {
        Some(build_artifact_attestation(&results_dir, manifest, &bytes)?)
    } else {
        None
    };
    if let Some(attestation) = attestation.as_deref() {
        publish_attestation_once(&results_dir, attestation)?;
    }

    match existing.as_deref() {
        Some(previous) => replace_running_manifest(&results_dir, previous, &bytes),
        None => publish_new_file(&results_dir, RUN_MANIFEST_FILE, &bytes),
    }
}

fn is_attestation_eligible(manifest: &RunManifest) -> bool {
    manifest.schema == RUN_MANIFEST_SCHEMA
        && manifest.status == "completed"
        && manifest.exit_code == Some(0)
        && !manifest.run_id.trim().is_empty()
        && manifest
            .session_id
            .as_deref()
            .is_some_and(|session_id| !session_id.trim().is_empty())
        && manifest
            .source
            .sha256
            .as_deref()
            .is_some_and(is_lower_sha256)
        && manifest
            .outputs
            .iter()
            .filter(|output| output.path == METADATA_RELATIVE_PATH)
            .count()
            == 1
        && manifest
            .outputs
            .iter()
            .any(|output| output.path == METADATA_RELATIVE_PATH && output.kind == "metadata")
}

fn is_lower_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn build_artifact_attestation(
    results_dir: &Path,
    manifest: &RunManifest,
    manifest_bytes: &[u8],
) -> io::Result<Vec<u8>> {
    let metadata_path = results_dir.join(METADATA_RELATIVE_PATH);
    let metadata_bytes = read_bounded_regular_file(&metadata_path, MAX_METADATA_ARTIFACT_BYTES)?;
    let source_sha256 = manifest.source.sha256.as_deref().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            "eligible run has no source digest",
        )
    })?;
    let session_id = manifest.session_id.as_deref().ok_or_else(|| {
        io::Error::new(io::ErrorKind::InvalidData, "eligible run has no session id")
    })?;
    let attestation = RunArtifactAttestation {
        schema: RUN_ARTIFACT_ATTESTATION_SCHEMA.into(),
        status: "completed".into(),
        exit_code: 0,
        run_id: manifest.run_id.clone(),
        session_id: session_id.into(),
        source_sha256: source_sha256.into(),
        metadata_relative_path: METADATA_RELATIVE_PATH.into(),
        metadata_sha256: sha256_hex(&metadata_bytes),
        manifest_sha256: sha256_hex(manifest_bytes),
    };
    serde_json::to_vec_pretty(&attestation)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))
}

fn verify_terminal_retry(
    results_dir: &Path,
    manifest: &RunManifest,
    manifest_bytes: &[u8],
) -> io::Result<()> {
    if is_attestation_eligible(manifest) {
        let expected = build_artifact_attestation(results_dir, manifest, manifest_bytes)?;
        let path = results_dir.join(RUN_ARTIFACT_ATTESTATION_FILE);
        let existing = read_optional_bounded_file(&path, MAX_RUN_ARTIFACT_ATTESTATION_BYTES)?
            .ok_or_else(|| {
                io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "refusing to backfill an attestation for an already-terminal legacy run",
                )
            })?;
        if existing != expected {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "terminal run manifest or metadata differs from its producer attestation",
            ));
        }
    }
    Ok(())
}

fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn prepare_results_dir(results_dir: &Path) -> io::Result<PathBuf> {
    let absolute = if results_dir.is_absolute() {
        results_dir.to_path_buf()
    } else {
        std::env::current_dir()?.join(results_dir)
    };
    if absolute
        .components()
        .any(|component| component == std::path::Component::ParentDir)
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "run results path must not contain parent traversal",
        ));
    }
    reject_reparse_ancestors(&absolute)?;
    fs::create_dir_all(&absolute)?;
    reject_reparse_ancestors(&absolute)?;
    let canonical = fs::canonicalize(&absolute)?;
    reject_reparse_ancestors(&canonical)?;
    if !fs::metadata(&canonical)?.is_dir() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "run results path is not a directory",
        ));
    }
    Ok(canonical)
}

fn reject_reparse_ancestors(path: &Path) -> io::Result<()> {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()?.join(path)
    };
    for ancestor in absolute.ancestors() {
        match fs::symlink_metadata(ancestor) {
            Ok(metadata) if is_link_or_reparse(&metadata) => {
                return Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    format!(
                        "run results path contains a link or reparse point: {}",
                        ancestor.display()
                    ),
                ));
            }
            Ok(_) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
    }
    Ok(())
}

fn is_link_or_reparse(metadata: &fs::Metadata) -> bool {
    if metadata.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    {
        false
    }
}

fn read_optional_bounded_file(path: &Path, maximum: u64) -> io::Result<Option<Vec<u8>>> {
    match read_bounded_regular_file(path, maximum) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

fn read_bounded_regular_file(path: &Path, maximum: u64) -> io::Result<Vec<u8>> {
    let (mut file, before, opened) = open_verified_regular_file(path, maximum)?;
    let mut bytes = Vec::new();
    Read::take(&mut file, maximum.saturating_add(1)).read_to_end(&mut bytes)?;
    let after = file.metadata()?;
    let path_after = fs::symlink_metadata(path)?;
    if bytes.len() as u64 > maximum
        || is_link_or_reparse(&path_after)
        || !path_after.is_file()
        || !same_file_snapshot(&opened, &after)?
        || !same_file_snapshot(&after, &path_after)?
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "run artifact changed or exceeded its byte limit",
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if before.dev() != opened.dev()
            || before.ino() != opened.ino()
            || opened.dev() != after.dev()
            || opened.ino() != after.ino()
            || after.dev() != path_after.dev()
            || after.ino() != path_after.ino()
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "run artifact identity changed while it was read",
            ));
        }
    }
    Ok(bytes)
}

fn open_verified_regular_file(
    path: &Path,
    maximum: u64,
) -> io::Result<(File, fs::Metadata, fs::Metadata)> {
    reject_reparse_ancestors(path)?;
    let before = fs::symlink_metadata(path)?;
    if is_link_or_reparse(&before) || !before.is_file() || before.len() > maximum {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "run artifact is not a bounded regular file",
        ));
    }
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(any(target_os = "linux", target_os = "android"))]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(0x20000 | 0x800); // O_NOFOLLOW | O_NONBLOCK
    }
    #[cfg(any(target_os = "macos", target_os = "ios", target_os = "freebsd"))]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(0x100 | 0x4); // O_NOFOLLOW | O_NONBLOCK
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        // Rust stable does not expose the Windows file index. This share mode
        // allows read handles but prevents writes/replacement after open; the
        // opened handle is authoritative if the name changed before open.
        options.share_mode(0x1); // FILE_SHARE_READ
        options.custom_flags(0x0020_0000); // FILE_FLAG_OPEN_REPARSE_POINT
    }
    #[cfg(all(
        unix,
        not(any(
            target_os = "linux",
            target_os = "android",
            target_os = "macos",
            target_os = "ios",
            target_os = "freebsd"
        ))
    ))]
    {
        return Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "safe bounded artifact reads are unsupported on this Unix target",
        ));
    }
    #[cfg(not(any(unix, windows)))]
    {
        return Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "safe bounded artifact reads are unsupported on this target",
        ));
    }
    let file = options.open(path)?;
    let opened = file.metadata()?;
    let path_after = fs::symlink_metadata(path)?;
    if is_link_or_reparse(&opened)
        || !opened.is_file()
        || opened.len() > maximum
        || is_link_or_reparse(&path_after)
        || !path_after.is_file()
        || !same_file_snapshot(&before, &opened)?
        || !same_file_snapshot(&opened, &path_after)?
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "opened run artifact is not a stable bounded regular file",
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if before.dev() != opened.dev()
            || before.ino() != opened.ino()
            || opened.dev() != path_after.dev()
            || opened.ino() != path_after.ino()
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "run artifact identity changed while it was read",
            ));
        }
    }
    Ok((file, before, opened))
}

fn same_file_snapshot(left: &fs::Metadata, right: &fs::Metadata) -> io::Result<bool> {
    if left.len() != right.len() || left.modified()? != right.modified()? {
        return Ok(false);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if left.file_attributes() != right.file_attributes()
            || left.file_size() != right.file_size()
            || left.last_write_time() != right.last_write_time()
        {
            return Ok(false);
        }
    }
    Ok(true)
}

fn write_temporary(results_dir: &Path, target_name: &str, bytes: &[u8]) -> io::Result<PathBuf> {
    for _ in 0..32 {
        let sequence = TEMPORARY_FILE_COUNTER.fetch_add(1, Ordering::Relaxed);
        let name = format!(".{target_name}.{}.{}.tmp", std::process::id(), sequence);
        let temporary = results_dir.join(name);
        reject_reparse_ancestors(&temporary)?;
        let mut file = match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
        {
            Ok(file) => file,
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error),
        };
        file.write_all(bytes)?;
        file.sync_all()?;
        return Ok(temporary);
    }
    Err(io::Error::new(
        io::ErrorKind::AlreadyExists,
        "could not allocate a unique run manifest temporary file",
    ))
}

fn publish_new_file(results_dir: &Path, target_name: &str, bytes: &[u8]) -> io::Result<()> {
    let temporary = write_temporary(results_dir, target_name, bytes)?;
    let target = results_dir.join(target_name);
    verify_file_contents(&temporary, bytes)?;
    reject_reparse_ancestors(&target)?;
    if let Err(error) = fs::hard_link(&temporary, &target) {
        if verify_file_contents(&temporary, bytes).is_ok() {
            let _ = fs::remove_file(&temporary);
        }
        return Err(error);
    }
    reject_reparse_ancestors(&target)?;
    verify_file_contents(&target, bytes)?;
    fs::remove_file(&temporary)?;
    sync_directory(results_dir)
}

fn verify_file_contents(path: &Path, expected: &[u8]) -> io::Result<()> {
    let observed = read_bounded_regular_file(path, expected.len() as u64)?;
    if observed != expected {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "run manifest temporary or published bytes changed",
        ));
    }
    Ok(())
}

fn publish_attestation_once(results_dir: &Path, bytes: &[u8]) -> io::Result<()> {
    let path = results_dir.join(RUN_ARTIFACT_ATTESTATION_FILE);
    if let Some(existing) = read_optional_bounded_file(&path, MAX_RUN_ARTIFACT_ATTESTATION_BYTES)? {
        if existing == bytes {
            return Ok(());
        }
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "refusing to replace an existing producer artifact attestation",
        ));
    }
    publish_new_file(results_dir, RUN_ARTIFACT_ATTESTATION_FILE, bytes)
}

fn replace_running_manifest(
    results_dir: &Path,
    previous_bytes: &[u8],
    bytes: &[u8],
) -> io::Result<()> {
    let path = manifest_path(results_dir);
    let current = read_optional_bounded_file(&path, MAX_RUN_MANIFEST_BYTES)?.ok_or_else(|| {
        io::Error::new(io::ErrorKind::NotFound, "running run manifest disappeared")
    })?;
    if current != previous_bytes {
        return Err(io::Error::new(
            io::ErrorKind::WouldBlock,
            "run manifest changed during terminal publication",
        ));
    }
    let temporary = write_temporary(results_dir, RUN_MANIFEST_FILE, bytes)?;
    verify_file_contents(&temporary, bytes)?;
    let current = read_optional_bounded_file(&path, MAX_RUN_MANIFEST_BYTES)?.ok_or_else(|| {
        io::Error::new(io::ErrorKind::NotFound, "running run manifest disappeared")
    })?;
    if current != previous_bytes {
        return Err(io::Error::new(
            io::ErrorKind::WouldBlock,
            "run manifest changed during terminal publication",
        ));
    }
    reject_reparse_ancestors(&path)?;
    reject_reparse_ancestors(&temporary)?;
    fs::rename(&temporary, &path)?;
    reject_reparse_ancestors(&path)?;
    verify_file_contents(&path, bytes)?;
    sync_directory(results_dir)
}

fn sync_directory(directory: &Path) -> io::Result<()> {
    #[cfg(unix)]
    {
        fs::File::open(directory)?.sync_all()
    }
    #[cfg(not(unix))]
    {
        let _ = directory;
        Ok(())
    }
}

/// Read the manifest of a results folder. `Ok(None)` when there is none; an
/// error when it exists but is damaged, oversized or of another schema.
pub fn read_run_manifest(results_dir: &Path) -> Result<Option<RunManifest>, String> {
    let path = manifest_path(results_dir);
    let meta = match std::fs::metadata(&path) {
        Ok(meta) => meta,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("cannot read {RUN_MANIFEST_FILE}: {error}")),
    };
    if !meta.is_file() {
        return Err(format!("{RUN_MANIFEST_FILE} is not a file"));
    }
    if meta.len() > MAX_RUN_MANIFEST_BYTES {
        return Err(format!("{RUN_MANIFEST_FILE} is larger than 1 MiB"));
    }
    let bytes = std::fs::read(&path)
        .map_err(|error| format!("cannot read {RUN_MANIFEST_FILE}: {error}"))?;
    let manifest: RunManifest = serde_json::from_slice(&bytes)
        .map_err(|error| format!("{RUN_MANIFEST_FILE} is not a valid run manifest: {error}"))?;
    if manifest.schema != RUN_MANIFEST_SCHEMA {
        return Err(format!(
            "{RUN_MANIFEST_FILE} has schema `{}`, expected `{RUN_MANIFEST_SCHEMA}`",
            manifest.schema
        ));
    }
    Ok(Some(manifest))
}

/// The outputs worth listing in a manifest: known files and stores found in
/// the folder, its `artifacts` group and `stages/*` (at most depth 3, 200
/// entries). Paths are relative with `/` separators.
pub fn collect_outputs(results_dir: &Path) -> Vec<RunOutput> {
    let mut found = Vec::new();
    let mut directories = vec![(results_dir.to_path_buf(), 0_usize)];
    while let Some((dir, depth)) = directories.pop() {
        let Ok(read) = std::fs::read_dir(&dir) else {
            continue;
        };
        let mut entries: Vec<_> = read.flatten().collect();
        entries.sort_by_key(|entry| entry.file_name());
        for entry in entries {
            if found.len() >= 200 {
                return found;
            }
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if file_type.is_symlink() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            let relative = entry
                .path()
                .strip_prefix(results_dir)
                .map(|p| p.to_string_lossy().replace('\\', "/"))
                .unwrap_or_else(|_| name.clone());
            if file_type.is_dir() {
                if name.to_ascii_lowercase().ends_with(".zarr") {
                    found.push(RunOutput {
                        path: relative,
                        kind: "zarr_store".into(),
                    });
                } else if depth < 3 && !name.starts_with('.') {
                    directories.push((entry.path(), depth + 1));
                }
            } else if let Some(kind) = output_kind(&name) {
                found.push(RunOutput {
                    path: relative,
                    kind: kind.into(),
                });
            }
        }
    }
    found.sort_by(|a, b| a.path.cmp(&b.path));
    found
}

fn output_kind(file_name: &str) -> Option<&'static str> {
    let lower = file_name.to_ascii_lowercase();
    match lower.as_str() {
        "metadata.json" => Some("metadata"),
        "scalars.csv" => Some("table"),
        "m_final.json" | "m_initial.json" => Some("field"),
        "sequence_manifest.json" => Some("sequence_manifest"),
        "output-storage.json" => Some("storage_receipt"),
        _ if lower.ends_with(".autosave.json") => Some("autosave_manifest"),
        _ if lower.ends_with(".h5") || lower.ends_with(".hdf5") => Some("hdf5"),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::process::{Child, Command};
    use std::time::{Duration, Instant};

    const GATE_CHILD_ROOT_ENV: &str = "FULLMAG_RUN_MANIFEST_GATE_CHILD_ROOT";
    const GATE_CHILD_MODE_ENV: &str = "FULLMAG_RUN_MANIFEST_GATE_CHILD_MODE";
    const GATE_CHILD_READY_FILE: &str = ".test-run-manifest-gate-held";

    fn sample() -> RunManifest {
        let mut manifest = RunManifest::new(
            "run-1",
            RunSource {
                kind: "script".into(),
                path: "C:/sim/wall.py".into(),
                sha256: Some("ab".repeat(32)),
                project_id: None,
                revision: None,
            },
            "0.1.0",
            "2026-10-05T10:00:00.000Z",
        );
        manifest.requested = json!({"backend": "fdm", "device": "gpu"});
        manifest.launched_by = Some("cli".into());
        manifest
    }

    fn successful_sample() -> RunManifest {
        let mut manifest = sample();
        manifest.status = "completed".into();
        manifest.exit_code = Some(0);
        manifest.session_id = Some("session-1".into());
        manifest.outputs.push(RunOutput {
            path: METADATA_RELATIVE_PATH.into(),
            kind: "metadata".into(),
        });
        manifest
    }

    fn write_metadata(root: &Path, bytes: &[u8]) {
        std::fs::create_dir_all(root.join("artifacts")).unwrap();
        std::fs::write(root.join(METADATA_RELATIVE_PATH), bytes).unwrap();
    }

    struct GateChild(Child);

    impl GateChild {
        fn terminate(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }

    impl Drop for GateChild {
        fn drop(&mut self) {
            self.terminate();
        }
    }

    fn spawn_gate_holder(root: &Path) -> GateChild {
        GateChild(
            Command::new(std::env::current_exe().unwrap())
                .arg("run_manifest_writer_gate_process_helper")
                .arg("--nocapture")
                .env(GATE_CHILD_ROOT_ENV, root)
                .env(GATE_CHILD_MODE_ENV, "hold")
                .spawn()
                .unwrap(),
        )
    }

    fn wait_for_gate_child(root: &Path, child: &mut GateChild) {
        let marker = root.join(GATE_CHILD_READY_FILE);
        let deadline = Instant::now() + Duration::from_secs(15);
        loop {
            if marker.is_file() {
                return;
            }
            if let Some(status) = child.0.try_wait().unwrap() {
                panic!("writer-gate child exited before acquiring its lock: {status}");
            }
            assert!(
                Instant::now() < deadline,
                "writer-gate child did not acquire lock"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    #[test]
    fn run_manifest_writer_gate_process_helper() {
        let Ok(root) = std::env::var(GATE_CHILD_ROOT_ENV) else {
            return;
        };
        let root = PathBuf::from(root);
        assert_eq!(std::env::var(GATE_CHILD_MODE_ENV).unwrap(), "hold");
        let _gate = RunManifestWriterGate::acquire(&root).unwrap();
        std::fs::write(root.join(GATE_CHILD_READY_FILE), b"held").unwrap();
        loop {
            std::thread::sleep(Duration::from_secs(1));
        }
    }

    #[test]
    fn write_then_read_round_trips_and_leaves_no_temporaries() {
        let dir = tempfile::tempdir().unwrap();
        let mut manifest = sample();
        write_run_manifest(dir.path(), &manifest).unwrap();
        let read = read_run_manifest(dir.path()).unwrap().unwrap();
        assert_eq!(read, manifest);
        assert_eq!(read.status, "running");

        manifest.status = "completed".into();
        manifest.finished_at = Some("2026-10-05T10:01:00.000Z".into());
        write_run_manifest(dir.path(), &manifest).unwrap();
        assert_eq!(
            read_run_manifest(dir.path()).unwrap().unwrap().status,
            "completed"
        );
        let names: Vec<String> = std::fs::read_dir(dir.path())
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names.len(), 2);
        assert!(names.contains(&RUN_MANIFEST_FILE.to_string()));
        assert!(names.contains(&RUN_MANIFEST_WRITER_LOCK_FILE.to_string()));
    }

    #[test]
    fn initial_manifest_publication_does_not_clobber_an_existing_file() {
        let dir = tempfile::tempdir().unwrap();
        let target = manifest_path(dir.path());
        let original = b"preexisting manifest bytes";
        std::fs::write(&target, original).unwrap();

        assert!(
            publish_new_file(dir.path(), RUN_MANIFEST_FILE, b"concurrent writer bytes").is_err()
        );
        assert_eq!(std::fs::read(target).unwrap(), original);
    }

    #[test]
    fn cross_process_writer_gate_blocks_initial_and_terminal_writes_then_retries_after_process_exit(
    ) {
        let dir = tempfile::tempdir().unwrap();
        let terminal = successful_sample();
        let mut running = terminal.clone();
        running.status = "running".into();
        running.exit_code = None;
        running.finished_at = None;

        let mut initial_holder = spawn_gate_holder(dir.path());
        wait_for_gate_child(dir.path(), &mut initial_holder);
        let initial_error = write_run_manifest(dir.path(), &running).unwrap_err();
        assert_eq!(initial_error.kind(), io::ErrorKind::WouldBlock);
        assert_eq!(read_run_manifest(dir.path()).unwrap(), None);
        initial_holder.terminate();

        write_run_manifest(dir.path(), &running).unwrap();
        let running_bytes = std::fs::read(manifest_path(dir.path())).unwrap();
        write_metadata(dir.path(), b"metadata before terminal");

        std::fs::remove_file(dir.path().join(GATE_CHILD_READY_FILE)).unwrap();
        let mut terminal_holder = spawn_gate_holder(dir.path());
        wait_for_gate_child(dir.path(), &mut terminal_holder);
        let terminal_error = write_run_manifest(dir.path(), &terminal).unwrap_err();
        assert_eq!(terminal_error.kind(), io::ErrorKind::WouldBlock);
        assert_eq!(
            std::fs::read(manifest_path(dir.path())).unwrap(),
            running_bytes
        );
        assert!(!dir.path().join(RUN_ARTIFACT_ATTESTATION_FILE).exists());
        terminal_holder.terminate();

        write_run_manifest(dir.path(), &terminal).unwrap();
        assert_eq!(
            read_run_manifest(dir.path()).unwrap().unwrap().status,
            "completed"
        );
        assert!(dir.path().join(RUN_ARTIFACT_ATTESTATION_FILE).is_file());
    }

    #[test]
    fn interrupted_attestation_publication_retries_without_reissuing_stamp() {
        let dir = tempfile::tempdir().unwrap();
        let terminal = successful_sample();
        let mut running = terminal.clone();
        running.status = "running".into();
        running.exit_code = None;
        running.finished_at = None;
        write_run_manifest(dir.path(), &running).unwrap();
        write_metadata(dir.path(), b"metadata before terminal");
        let running_bytes = std::fs::read(manifest_path(dir.path())).unwrap();
        let terminal_bytes = serde_json::to_vec_pretty(&terminal).unwrap();
        let candidate = build_artifact_attestation(dir.path(), &terminal, &terminal_bytes).unwrap();

        // Model process exit after the stamp was durably published but before
        // the terminal manifest replaced its running predecessor.
        publish_attestation_once(dir.path(), &candidate).unwrap();
        assert_eq!(
            std::fs::read(manifest_path(dir.path())).unwrap(),
            running_bytes
        );
        write_run_manifest(dir.path(), &terminal).unwrap();
        let first_stamp = std::fs::read(dir.path().join(RUN_ARTIFACT_ATTESTATION_FILE)).unwrap();
        assert_eq!(first_stamp, candidate);

        write_run_manifest(dir.path(), &terminal).unwrap();
        assert_eq!(
            std::fs::read(dir.path().join(RUN_ARTIFACT_ATTESTATION_FILE)).unwrap(),
            first_stamp
        );
    }

    #[cfg(windows)]
    #[test]
    fn windows_bounded_read_handle_blocks_regular_file_replacement() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("metadata.json");
        let replacement = dir.path().join("replacement.json");
        std::fs::write(&path, b"original metadata").unwrap();
        std::fs::write(&replacement, b"replacement metadata").unwrap();
        let (opened, _, _) = open_verified_regular_file(&path, 1024).unwrap();

        assert!(std::fs::rename(&replacement, &path).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), b"original metadata");
        drop(opened);
    }

    #[test]
    fn first_successful_terminal_write_attests_exact_manifest_and_metadata_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let manifest = successful_sample();
        let metadata = br#"{"source_hash":"ab"}"#;
        write_metadata(dir.path(), metadata);

        write_run_manifest(dir.path(), &manifest).unwrap();
        let manifest_bytes = std::fs::read(manifest_path(dir.path())).unwrap();
        let attestation_path = dir.path().join(RUN_ARTIFACT_ATTESTATION_FILE);
        let attestation_bytes = std::fs::read(&attestation_path).unwrap();
        let attestation: RunArtifactAttestation =
            serde_json::from_slice(&attestation_bytes).unwrap();
        assert_eq!(attestation.schema, RUN_ARTIFACT_ATTESTATION_SCHEMA);
        assert_eq!(attestation.status, "completed");
        assert_eq!(attestation.exit_code, 0);
        assert_eq!(attestation.run_id, manifest.run_id);
        assert_eq!(attestation.session_id, "session-1");
        assert_eq!(attestation.source_sha256, "ab".repeat(32));
        assert_eq!(attestation.metadata_relative_path, METADATA_RELATIVE_PATH);
        assert_eq!(attestation.metadata_sha256, sha256_hex(metadata));
        assert_eq!(attestation.manifest_sha256, sha256_hex(&manifest_bytes));

        write_run_manifest(dir.path(), &manifest).unwrap();
        assert_eq!(
            std::fs::read(manifest_path(dir.path())).unwrap(),
            manifest_bytes
        );
        assert_eq!(std::fs::read(attestation_path).unwrap(), attestation_bytes);
    }

    #[test]
    fn eligible_attestation_read_failure_preserves_running_manifest_for_retry() {
        let fresh = tempfile::tempdir().unwrap();
        let terminal = successful_sample();
        assert!(write_run_manifest(fresh.path(), &terminal).is_err());
        assert_eq!(read_run_manifest(fresh.path()).unwrap(), None);
        assert!(!fresh.path().join(RUN_ARTIFACT_ATTESTATION_FILE).exists());

        let running_dir = tempfile::tempdir().unwrap();
        let mut running = terminal.clone();
        running.status = "running".into();
        running.exit_code = None;
        running.finished_at = None;
        write_run_manifest(running_dir.path(), &running).unwrap();
        let running_path = manifest_path(running_dir.path());
        let running_bytes = std::fs::read(&running_path).unwrap();

        let invalid_metadata = running_dir.path().join(METADATA_RELATIVE_PATH);
        std::fs::create_dir_all(&invalid_metadata).unwrap();
        assert!(write_run_manifest(running_dir.path(), &terminal).is_err());
        assert_eq!(std::fs::read(&running_path).unwrap(), running_bytes);
        assert_eq!(
            read_run_manifest(running_dir.path())
                .unwrap()
                .unwrap()
                .status,
            "running"
        );
        assert!(!running_dir
            .path()
            .join(RUN_ARTIFACT_ATTESTATION_FILE)
            .exists());

        std::fs::remove_dir(&invalid_metadata).unwrap();
        std::fs::write(&invalid_metadata, b"valid metadata bytes").unwrap();
        write_run_manifest(running_dir.path(), &terminal).unwrap();
        assert_eq!(
            read_run_manifest(running_dir.path())
                .unwrap()
                .unwrap()
                .status,
            "completed"
        );
        assert!(running_dir
            .path()
            .join(RUN_ARTIFACT_ATTESTATION_FILE)
            .is_file());
    }

    #[test]
    fn terminal_metadata_or_manifest_rewrites_are_refused_without_changing_evidence() {
        let dir = tempfile::tempdir().unwrap();
        let manifest = successful_sample();
        let metadata = b"original metadata";
        write_metadata(dir.path(), metadata);
        write_run_manifest(dir.path(), &manifest).unwrap();
        let manifest_path = manifest_path(dir.path());
        let attestation_path = dir.path().join(RUN_ARTIFACT_ATTESTATION_FILE);
        let original_manifest = std::fs::read(&manifest_path).unwrap();
        let original_attestation = std::fs::read(&attestation_path).unwrap();

        std::fs::write(dir.path().join(METADATA_RELATIVE_PATH), b"edited metadata").unwrap();
        assert!(write_run_manifest(dir.path(), &manifest).is_err());
        assert_eq!(std::fs::read(&manifest_path).unwrap(), original_manifest);
        assert_eq!(
            std::fs::read(&attestation_path).unwrap(),
            original_attestation
        );

        std::fs::write(dir.path().join(METADATA_RELATIVE_PATH), metadata).unwrap();
        let mut changed_manifest = manifest.clone();
        changed_manifest.error = Some("same identity, changed terminal record".into());
        assert!(write_run_manifest(dir.path(), &changed_manifest).is_err());
        assert_eq!(std::fs::read(&manifest_path).unwrap(), original_manifest);
        assert_eq!(
            std::fs::read(&attestation_path).unwrap(),
            original_attestation
        );
    }

    #[test]
    fn eligible_legacy_terminal_manifest_is_never_backfilled() {
        let dir = tempfile::tempdir().unwrap();
        let manifest = successful_sample();
        write_metadata(dir.path(), b"legacy metadata");
        let original = serde_json::to_vec_pretty(&manifest).unwrap();
        std::fs::write(manifest_path(dir.path()), &original).unwrap();

        assert!(write_run_manifest(dir.path(), &manifest).is_err());
        assert_eq!(std::fs::read(manifest_path(dir.path())).unwrap(), original);
        assert!(!dir.path().join(RUN_ARTIFACT_ATTESTATION_FILE).exists());
    }

    #[test]
    fn nonqualifying_api_terminal_record_keeps_existing_manifest_semantics() {
        let dir = tempfile::tempdir().unwrap();
        let mut manifest = successful_sample();
        manifest.session_id = None;
        manifest.exit_code = None;

        write_run_manifest(dir.path(), &manifest).unwrap();
        assert!(!dir.path().join(RUN_ARTIFACT_ATTESTATION_FILE).exists());
        let original = std::fs::read(manifest_path(dir.path())).unwrap();
        write_run_manifest(dir.path(), &manifest).unwrap();
        assert_eq!(std::fs::read(manifest_path(dir.path())).unwrap(), original);

        manifest.error = Some("attempted terminal restamp".into());
        assert!(write_run_manifest(dir.path(), &manifest).is_err());
        assert_eq!(std::fs::read(manifest_path(dir.path())).unwrap(), original);
    }

    #[test]
    fn missing_damaged_and_foreign_manifests_are_distinguished() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(read_run_manifest(dir.path()).unwrap(), None);
        std::fs::write(manifest_path(dir.path()), b"{not json").unwrap();
        assert!(read_run_manifest(dir.path())
            .unwrap_err()
            .contains("not a valid"));
        let mut value = serde_json::to_value(sample()).unwrap();
        value["schema"] = json!("other.v9");
        std::fs::write(manifest_path(dir.path()), value.to_string()).unwrap();
        assert!(read_run_manifest(dir.path())
            .unwrap_err()
            .contains("other.v9"));
    }

    #[test]
    fn outputs_list_known_files_and_stores_with_relative_paths() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("artifacts/main.zarr")).unwrap();
        std::fs::create_dir_all(root.join("stages/stage_00_relax")).unwrap();
        std::fs::write(root.join("artifacts/metadata.json"), "{}").unwrap();
        std::fs::write(root.join(RUN_ARTIFACT_ATTESTATION_FILE), "{}").unwrap();
        std::fs::write(root.join(RUN_MANIFEST_WRITER_LOCK_FILE), "").unwrap();
        std::fs::write(root.join("artifacts/scalars.csv"), "step,time\n").unwrap();
        std::fs::write(root.join("artifacts/main.autosave.json"), "{}").unwrap();
        std::fs::write(root.join("stages/stage_00_relax/m_final.json"), "{}").unwrap();
        std::fs::write(root.join("notes.txt"), "x").unwrap();
        let outputs = collect_outputs(root);
        let pairs: Vec<(&str, &str)> = outputs
            .iter()
            .map(|o| (o.path.as_str(), o.kind.as_str()))
            .collect();
        assert_eq!(
            pairs,
            vec![
                ("artifacts/main.autosave.json", "autosave_manifest"),
                ("artifacts/main.zarr", "zarr_store"),
                ("artifacts/metadata.json", "metadata"),
                ("artifacts/scalars.csv", "table"),
                ("stages/stage_00_relax/m_final.json", "field"),
            ]
        );
    }
}
