//! Publication for the separate inspection-only external-lead carrier.
//! Trusted local writers: std path checks/rename do not defeat hostile TOCTOU.
use super::{
    load_antenna_external_lead_solution, load_antenna_external_lead_solution_manifest,
    validate_reference, AntennaExternalLeadSolutionArtifact, AntennaExternalLeadSolutionManifest,
    AntennaExternalLeadSolutionRef, LoadedAntennaExternalLeadSolution,
};
use crate::types::{AuxiliaryArtifact, RunError};
use std::collections::BTreeSet;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

const MANIFEST: &str = "manifest.v1.json";
const PAYLOADS: [&str; 5] = [
    "bundle.v1.bin",
    "sample_positions.f64le.bin",
    "H.f64le.bin",
    "device_vertex_ids.u64le.bin",
    "device_V.f64le.bin",
];
const MANIFEST_LIMIT: usize = 1 << 20;
const BINARY_LIMIT: usize = 128 << 20;
const CHUNK: usize = 64 << 10;

#[derive(Debug, Clone)]
pub struct PublishedAntennaExternalLeadSolution {
    pub reference: AntennaExternalLeadSolutionRef,
    pub manifest_path: PathBuf,
    pub reused_existing: bool,
}
fn fail(message: impl Into<String>) -> RunError {
    RunError {
        message: message.into(),
    }
}
fn require(ok: bool, message: &str) -> Result<(), RunError> {
    if ok {
        Ok(())
    } else {
        Err(fail(message))
    }
}
fn cancel(flag: Option<&AtomicBool>) -> Result<(), RunError> {
    require(
        !flag.is_some_and(|f| f.load(Ordering::Acquire)),
        "external-lead solution publication cancelled: interrupt_requested",
    )
}
fn io(context: &str, error: std::io::Error) -> RunError {
    fail(format!("{context}: {error}"))
}
fn exists(path: &Path) -> Result<bool, RunError> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(io("inspect external-lead solution path", e)),
    }
}
fn directory(path: &Path, root: &Path) -> Result<(), RunError> {
    let meta = fs::symlink_metadata(path).map_err(|e| io("inspect external-lead directory", e))?;
    require(
        meta.is_dir() && !meta.file_type().is_symlink(),
        "external-lead descendant must be a real directory, not a symlink",
    )?;
    let canonical =
        fs::canonicalize(path).map_err(|e| io("canonicalize external-lead directory", e))?;
    require(
        canonical.starts_with(root) && canonical == path,
        "external-lead descendant escapes or aliases its canonical output root",
    )
}
fn revision_paths(
    output_root: &Path,
    reference: &AntennaExternalLeadSolutionRef,
    create: bool,
    interrupt: Option<&AtomicBool>,
) -> Result<(PathBuf, PathBuf, PathBuf), RunError> {
    validate_reference(reference)?;
    cancel(interrupt)?;
    if create {
        fs::create_dir_all(output_root).map_err(|e| io("create external-lead output root", e))?;
    }
    // Operator-selected root aliases are allowed; all descendants remain unaliased.
    let root =
        fs::canonicalize(output_root).map_err(|e| io("resolve external-lead output root", e))?;
    require(
        fs::metadata(&root)
            .map_err(|e| io("inspect external-lead output root", e))?
            .is_dir(),
        "external-lead output root is not a directory",
    )?;
    let mut parent = root.clone();
    for component in [
        "antenna",
        "external_lead_solutions",
        reference.output_id.as_str(),
    ] {
        cancel(interrupt)?;
        parent.push(component);
        if create && !exists(&parent)? {
            match fs::create_dir(&parent) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(e) => return Err(io("create external-lead namespace", e)),
            }
        }
        directory(&parent, &root)?;
    }
    let digest = reference
        .content_digest
        .strip_prefix("sha256:")
        .ok_or_else(|| fail("external-lead digest lacks sha256 prefix"))?;
    Ok((root, parent.clone(), parent.join(digest)))
}
fn regular(path: &Path, maximum: usize) -> Result<u64, RunError> {
    let meta = fs::symlink_metadata(path).map_err(|e| io("inspect external-lead payload", e))?;
    require(
        meta.is_file() && !meta.file_type().is_symlink(),
        "external-lead entries must be regular files, not directories or symlinks",
    )?;
    require(
        meta.len() <= maximum as u64,
        "external-lead file exceeds bounded read support",
    )?;
    Ok(meta.len())
}
fn read_bounded(
    path: &Path,
    maximum: usize,
    interrupt: Option<&AtomicBool>,
) -> Result<Vec<u8>, RunError> {
    cancel(interrupt)?;
    let length = regular(path, maximum)?;
    let mut file = File::open(path).map_err(|e| io("open external-lead payload", e))?;
    let meta = file
        .metadata()
        .map_err(|e| io("inspect opened external-lead payload", e))?;
    require(
        meta.is_file() && meta.len() == length && meta.len() <= maximum as u64,
        "external-lead payload changed before bounded read",
    )?;
    let mut bytes = Vec::new();
    bytes
        .try_reserve_exact(length as usize)
        .map_err(|e| fail(format!("allocate bounded external-lead payload: {e}")))?;
    let mut chunk = [0u8; CHUNK];
    loop {
        cancel(interrupt)?;
        // One excess byte detects concurrent growth without an unbounded allocation.
        let available = (maximum - bytes.len()).min(CHUNK - 1) + 1;
        let read = file
            .read(&mut chunk[..available])
            .map_err(|e| io("read external-lead payload", e))?;
        if read == 0 {
            break;
        }
        require(
            read <= maximum - bytes.len(),
            "external-lead payload grew beyond bounded read support",
        )?;
        bytes.extend_from_slice(&chunk[..read]);
    }
    require(
        bytes.len() as u64 == length
            && file
                .metadata()
                .map_err(|e| io("recheck external-lead payload", e))?
                .len()
                == length
            && regular(path, maximum)? == length,
        "external-lead payload changed during bounded read",
    )?;
    Ok(bytes)
}
fn read_revision(
    root: &Path,
    revision: &Path,
    interrupt: Option<&AtomicBool>,
) -> Result<(Vec<u8>, Vec<AuxiliaryArtifact>), RunError> {
    directory(revision, root)?;
    let mut found = BTreeSet::new();
    for entry in fs::read_dir(revision).map_err(|e| io("enumerate external-lead revision", e))? {
        cancel(interrupt)?;
        let entry = entry.map_err(|e| io("inspect external-lead entry", e))?;
        let name = entry
            .file_name()
            .into_string()
            .map_err(|_| fail("external-lead revision has a non-UTF8 or foreign entry"))?;
        require(
            (name == MANIFEST || PAYLOADS.contains(&name.as_str())) && found.insert(name),
            "external-lead revision contains a duplicate or unexpected entry",
        )?;
        let kind = entry
            .file_type()
            .map_err(|e| io("inspect external-lead entry type", e))?;
        require(
            kind.is_file() && !kind.is_symlink(),
            "external-lead entries must be regular files, not directories or symlinks",
        )?;
    }
    require(
        found.len() == 6,
        "external-lead revision must contain exactly manifest and five fixed payloads",
    )?;
    let manifest = read_bounded(&revision.join(MANIFEST), MANIFEST_LIMIT, interrupt)?;
    let mut payloads = Vec::with_capacity(5);
    for name in PAYLOADS {
        payloads.push(AuxiliaryArtifact {
            relative_path: name.into(),
            bytes: read_bounded(&revision.join(name), BINARY_LIMIT, interrupt)?,
        });
    }
    directory(revision, root)?;
    Ok((manifest, payloads))
}
fn validate_artifact(artifact: &AntennaExternalLeadSolutionArtifact) -> Result<(), RunError> {
    validate_reference(&artifact.reference)?;
    require(
        artifact.manifest_bytes.len() <= MANIFEST_LIMIT && artifact.payloads.len() == 5,
        "external-lead manifest or payload count exceeds fixed publication support",
    )?;
    let mut found = BTreeSet::new();
    for payload in &artifact.payloads {
        require(
            PAYLOADS.contains(&payload.relative_path.as_str())
                && found.insert(payload.relative_path.as_str())
                && payload.bytes.len() <= BINARY_LIMIT,
            "external-lead artifact requires unique fixed basenames and bounded payloads",
        )?;
    }
    load_antenna_external_lead_solution(
        &artifact.manifest_bytes,
        &artifact.payloads,
        &artifact.reference,
    )?;
    Ok(())
}
fn verify_exact_revision(
    root: &Path,
    revision: &Path,
    artifact: &AntennaExternalLeadSolutionArtifact,
    interrupt: Option<&AtomicBool>,
) -> Result<(), RunError> {
    let (manifest, payloads) = read_revision(root, revision, interrupt)?;
    load_antenna_external_lead_solution(&manifest, &payloads, &artifact.reference)?;
    require(manifest==artifact.manifest_bytes && payloads.iter().all(|p|artifact.payloads.iter().any(|e| e.relative_path==p.relative_path && e.bytes==p.bytes)),
        "immutable external-lead revision collides with different verified manifest or payload bytes")?;
    cancel(interrupt)
}
struct Temporary {
    root: PathBuf,
    parent: PathBuf,
    path: PathBuf,
    files: Vec<&'static str>,
    committed: bool,
}
impl Temporary {
    fn create(root: &Path, parent: &Path) -> Result<Self, RunError> {
        directory(parent, root)?;
        for _ in 0..16 {
            let path = parent.join(format!(
                ".external-lead-{}.tmp",
                uuid::Uuid::new_v4().simple()
            ));
            match fs::create_dir(&path) {
                Ok(()) => {
                    return Ok(Self {
                        root: root.into(),
                        parent: parent.into(),
                        path,
                        files: vec![],
                        committed: false,
                    })
                }
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(e) => return Err(io("create external-lead temporary revision", e)),
            }
        }
        Err(fail(
            "external-lead temporary directory collision limit exceeded",
        ))
    }
    fn write(
        &mut self,
        name: &'static str,
        bytes: &[u8],
        interrupt: Option<&AtomicBool>,
    ) -> Result<(), RunError> {
        cancel(interrupt)?;
        directory(&self.parent, &self.root)?;
        directory(&self.path, &self.root)?;
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(self.path.join(name))
            .map_err(|e| io("create external-lead revision file", e))?;
        self.files.push(name);
        for chunk in bytes.chunks(CHUNK) {
            cancel(interrupt)?;
            file.write_all(chunk)
                .map_err(|e| io("write external-lead revision file", e))?;
        }
        file.sync_all()
            .map_err(|e| io("sync external-lead revision file", e))?;
        cancel(interrupt)
    }
}
impl Drop for Temporary {
    fn drop(&mut self) {
        if self.committed
            || directory(&self.parent, &self.root).is_err()
            || directory(&self.path, &self.root).is_err()
        {
            return;
        }
        // Only this process's newly created files; foreign entries prevent removal.
        for name in &self.files {
            let path = self.path.join(name);
            if fs::symlink_metadata(&path).is_ok_and(|m| m.is_file() && !m.file_type().is_symlink())
            {
                let _ = fs::remove_file(path);
            }
        }
        let _ = fs::remove_dir(&self.path);
    }
}
fn sync_directory(path: &Path) -> Result<(), RunError> {
    #[cfg(unix)]
    {
        File::open(path)
            .and_then(|f| f.sync_all())
            .map_err(|e| io("sync external-lead directory", e))?;
    }
    #[cfg(not(unix))]
    {
        let _ = path;
    } // std has no equivalent directory fsync on Windows.
    Ok(())
}
pub fn publish_antenna_external_lead_solution_atomically(
    output_root: &Path,
    artifact: &AntennaExternalLeadSolutionArtifact,
    interrupt_requested: Option<&AtomicBool>,
) -> Result<PublishedAntennaExternalLeadSolution, RunError> {
    cancel(interrupt_requested)?;
    validate_artifact(artifact)?;
    cancel(interrupt_requested)?;
    let (root, parent, final_dir) =
        revision_paths(output_root, &artifact.reference, true, interrupt_requested)?;
    if exists(&final_dir)? {
        verify_exact_revision(&root, &final_dir, artifact, interrupt_requested)?;
        return Ok(PublishedAntennaExternalLeadSolution {
            reference: artifact.reference.clone(),
            manifest_path: final_dir.join(MANIFEST),
            reused_existing: true,
        });
    }
    let mut temporary = Temporary::create(&root, &parent)?;
    for name in PAYLOADS {
        let payload = artifact
            .payloads
            .iter()
            .find(|p| p.relative_path == name)
            .ok_or_else(|| fail("external-lead fixed payload is absent"))?;
        temporary.write(name, &payload.bytes, interrupt_requested)?;
    }
    temporary.write(MANIFEST, &artifact.manifest_bytes, interrupt_requested)?;
    verify_exact_revision(&root, &temporary.path, artifact, interrupt_requested)?;
    sync_directory(&temporary.path)?;
    directory(&parent, &root)?;
    cancel(interrupt_requested)?;
    if exists(&final_dir)? {
        verify_exact_revision(&root, &final_dir, artifact, interrupt_requested)?;
        return Ok(PublishedAntennaExternalLeadSolution {
            reference: artifact.reference.clone(),
            manifest_path: final_dir.join(MANIFEST),
            reused_existing: true,
        });
    }
    // Complete revisions are nonempty and are never replaced. std cannot rule out
    // hostile creation of an empty destination in the final path-check/rename gap.
    match fs::rename(&temporary.path, &final_dir) {
        Ok(()) => temporary.committed = true,
        Err(error) => {
            cancel(interrupt_requested)?;
            if exists(&final_dir)? {
                verify_exact_revision(&root, &final_dir, artifact, interrupt_requested)?;
                return Ok(PublishedAntennaExternalLeadSolution {
                    reference: artifact.reference.clone(),
                    manifest_path: final_dir.join(MANIFEST),
                    reused_existing: true,
                });
            }
            return Err(io("atomically publish external-lead revision", error));
        }
    }
    // Rename commits: an interrupt arriving after that point does not undo it.
    sync_directory(&parent)?;
    verify_exact_revision(&root, &final_dir, artifact, None)?;
    Ok(PublishedAntennaExternalLeadSolution {
        reference: artifact.reference.clone(),
        manifest_path: final_dir.join(MANIFEST),
        reused_existing: false,
    })
}
/// Bounded manifest-only read; payload integrity remains a separate full-loader gate.
pub fn load_published_antenna_external_lead_solution_manifest(
    output_root: &Path,
    reference: &AntennaExternalLeadSolutionRef,
) -> Result<AntennaExternalLeadSolutionManifest, RunError> {
    let (root, _, revision) = revision_paths(output_root, reference, false, None)?;
    directory(&revision, &root)?;
    let manifest = read_bounded(&revision.join(MANIFEST), MANIFEST_LIMIT, None)?;
    let manifest = load_antenna_external_lead_solution_manifest(&manifest, reference)?;
    directory(&revision, &root)?;
    Ok(manifest)
}

pub fn load_published_antenna_external_lead_solution(
    output_root: &Path,
    reference: &AntennaExternalLeadSolutionRef,
) -> Result<LoadedAntennaExternalLeadSolution, RunError> {
    let (root, _, revision) = revision_paths(output_root, reference, false, None)?;
    let (manifest, payloads) = read_revision(&root, &revision, None)?;
    load_antenna_external_lead_solution(&manifest, &payloads, reference)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture_root() -> PathBuf {
        let storage = std::env::var_os("FULLMAG_PROJECT_STORAGE_ROOT")
            .map(PathBuf::from)
            .expect("set FULLMAG_PROJECT_STORAGE_ROOT from the project storage resolver");
        assert!(storage.is_absolute(), "test storage must be absolute");
        fs::create_dir_all(&storage).unwrap();
        let root = storage.join(format!(
            "external-lead-publication-test-{}",
            uuid::Uuid::new_v4().simple()
        ));
        fs::create_dir(&root).unwrap();
        fs::canonicalize(root).unwrap()
    }

    #[test]
    fn bounded_reads_reject_oversized_files_before_loading() {
        let root = fixture_root();
        let mut temporary = Temporary::create(&root, &root).unwrap();
        temporary.write(MANIFEST, b"1234", None).unwrap();
        let path = temporary.path.join(MANIFEST);
        assert_eq!(read_bounded(&path, 4, None).unwrap(), b"1234");
        assert!(read_bounded(&path, 3, None)
            .unwrap_err()
            .message
            .contains("bounded read"));
        let interrupted = AtomicBool::new(true);
        assert!(read_bounded(&path, 4, Some(&interrupted))
            .unwrap_err()
            .message
            .contains("cancelled"));
        drop(temporary);
        fs::remove_dir(root).unwrap();
    }

    #[test]
    fn revision_requires_exact_regular_file_set() {
        let root = fixture_root();
        let mut temporary = Temporary::create(&root, &root).unwrap();
        temporary.write(MANIFEST, b"{}", None).unwrap();
        assert!(read_revision(&root, &temporary.path, None)
            .unwrap_err()
            .message
            .contains("exactly manifest"));
        for name in PAYLOADS {
            temporary.write(name, b"", None).unwrap();
        }
        assert_eq!(
            read_revision(&root, &temporary.path, None).unwrap().1.len(),
            5
        );
        let extra = temporary.path.join("unexpected.bin");
        File::create(&extra).unwrap();
        assert!(read_revision(&root, &temporary.path, None)
            .unwrap_err()
            .message
            .contains("unexpected entry"));
        fs::remove_file(extra).unwrap();
        fs::remove_file(temporary.path.join(PAYLOADS[0])).unwrap();
        fs::create_dir(temporary.path.join(PAYLOADS[0])).unwrap();
        assert!(read_revision(&root, &temporary.path, None)
            .unwrap_err()
            .message
            .contains("regular files"));
        fs::remove_dir(temporary.path.join(PAYLOADS[0])).unwrap();
        drop(temporary);
        fs::remove_dir(root).unwrap();
    }

    #[test]
    fn interrupted_write_and_cleanup_preserve_foreign_entries() {
        let root = fixture_root();
        let mut temporary = Temporary::create(&root, &root).unwrap();
        let revision = temporary.path.clone();
        temporary.write(MANIFEST, b"owned", None).unwrap();
        let foreign = revision.join("foreign.bin");
        File::create(&foreign).unwrap();
        let interrupted = AtomicBool::new(true);
        assert!(temporary
            .write(PAYLOADS[0], b"not written", Some(&interrupted))
            .unwrap_err()
            .message
            .contains("cancelled"));
        assert!(!revision.join(PAYLOADS[0]).exists());
        drop(temporary);
        assert!(!revision.join(MANIFEST).exists());
        assert!(foreign.is_file());
        fs::remove_file(foreign).unwrap();
        fs::remove_dir(revision).unwrap();
        fs::remove_dir(root).unwrap();
    }
}
