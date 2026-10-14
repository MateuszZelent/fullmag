//! Frequency-domain artifact generation publishing.
//!
//! Read-only capture and byte validation live in fullmag-session; this module
//! preserves the runner-facing API and owns publication leases and marker writes.
use std::collections::BTreeMap;
use std::fs;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};

pub use fullmag_session::frequency_domain_artifact_generation::{
    capture, GenerationBody, GenerationCapture, GenerationCommit, GenerationMember,
    PublicationOwner, COMMIT_PATH, IMMUTABLE_COMMIT_PATH,
};
use fullmag_session::frequency_domain_artifact_generation as generation_core;
use fullmag_session::frequency_domain_artifact_generation::{
    checked_directory, checked_path, digest, generation_id, hash_file_with_budget,
    is_reparse_point, marker_path_if_present, validate_member_path, validate_relative,
    valid_digest, GENERATION_DIRECTORY, IMMUTABLE_SCHEMA, MAX_COMMIT_BYTES, SCHEMA,
};

const MAX_PUBLICATION_LEASE_TOKEN_BYTES: usize = 64;

fn invalid(message: impl Into<String>) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message.into())
}
fn ensure_real_directory(path: &Path) -> io::Result<()> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            match fs::create_dir(path) {
                Ok(()) => fs::symlink_metadata(path)?,
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => fs::symlink_metadata(path)?,
                Err(error) => return Err(error),
            }
        }
        Err(error) => return Err(error),
    };
    if metadata.file_type().is_symlink() || is_reparse_point(&metadata) || !metadata.is_dir() {
        return Err(invalid("generation path traverses a link or non-directory"));
    }
    Ok(())
}

fn ensure_directory_chain(root: &Path, relative: &str) -> io::Result<PathBuf> {
    let relative = validate_relative(relative)?;
    let mut current = fs::canonicalize(root)?;
    for part in relative.components() {
        current.push(part.as_os_str());
        ensure_real_directory(&current)?;
    }
    Ok(current)
}

fn create_private_staging(path: &Path) -> io::Result<()> {
    let mut builder = fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(path)?;
    let metadata = fs::symlink_metadata(path)?;
    if metadata.file_type().is_symlink() || is_reparse_point(&metadata) || !metadata.is_dir() {
        return Err(invalid("generation staging path is not a private directory"));
    }
    Ok(())
}

fn write_member_bytes(root: &Path, relative: &str, bytes: &[u8]) -> io::Result<()> {
    let relative_path = validate_member_path(relative)?;
    if let Some(parent) = relative_path.parent() {
        let mut current = root.to_path_buf();
        for part in parent.components() {
            current.push(part.as_os_str());
            ensure_real_directory(&current)?;
        }
    }
    let destination = root.join(relative_path);
    let mut file = fs::OpenOptions::new().write(true).create_new(true).open(destination)?;
    file.write_all(bytes)?;
    file.sync_all()
}

fn verify_members_at_directory(
    directory: &Path,
    expected_members: &BTreeMap<String, GenerationMember>,
) -> io::Result<()> {
    for (relative, expected) in expected_members {
        validate_member_path(relative)?;
        let path = checked_path(directory, relative)?;
        if fs::metadata(&path)?.len() != expected.byte_length
            || hash_file_with_budget(&path, expected.byte_length)? != *expected
        {
            return Err(invalid("immutable generation member differs from its content identity"));
        }
    }
    Ok(())
}

fn validate_publication_root(root: &Path) -> io::Result<bool> {
    match fs::symlink_metadata(root) {
        Ok(metadata) => {
            if metadata.file_type().is_symlink() || is_reparse_point(&metadata) || !metadata.is_dir() {
                return Err(invalid("publication root is redirected or not a directory"));
            }
            Ok(true)
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error),
    }
}

pub(crate) fn ensure_legacy_publication_allowed(root: &Path) -> io::Result<()> {
    if !validate_publication_root(root)? {
        return Ok(());
    }
    if marker_path_if_present(root, IMMUTABLE_COMMIT_PATH)?.is_some() {
        return Err(invalid("v1 publisher cannot shadow the current immutable v2 generation"));
    }
    Ok(())
}

fn hash_file(path: &Path) -> io::Result<GenerationMember> {
    hash_file_with_budget(path, fs::metadata(path)?.len())
}

/// Exclusive final publication. A crash leaves a lease for explicit recovery;
/// readers still reject mismatching bytes instead of accepting partial output.
pub(crate) struct PublicationLease {
    root: PathBuf,
    path: PathBuf,
    token: String,
}
impl PublicationLease {
    pub(crate) fn acquire(root: &Path) -> io::Result<Self> {
        if !validate_publication_root(root)? {
            fs::create_dir_all(root)?;
        }
        if !validate_publication_root(root)? {
            return Err(invalid("publication root is missing after lease setup"));
        }
        let canonical_root = fs::canonicalize(root)?;
        let path = canonical_root.join(".frequency-domain-publication.lease");
        if let Ok(metadata) = fs::symlink_metadata(&path) {
            if metadata.file_type().is_symlink() || is_reparse_point(&metadata) {
                return Err(invalid("publication lease path is redirected"));
            }
        }
        let token = format!("{}:{}", std::process::id(), uuid::Uuid::new_v4());
        let mut file = fs::OpenOptions::new().write(true).create_new(true).open(&path)?;
        file.write_all(token.as_bytes())?;
        file.sync_all()?;
        Ok(Self { root: canonical_root, path, token })
    }

    fn validate_for(&self, root: &Path) -> io::Result<PathBuf> {
        if !validate_publication_root(root)? {
            return Err(invalid("publication root for lease is missing"));
        }
        let canonical_root = fs::canonicalize(root)?;
        if canonical_root != self.root {
            return Err(invalid("publication lease belongs to a different canonical root"));
        }
        let expected_path = canonical_root.join(".frequency-domain-publication.lease");
        if self.path != expected_path {
            return Err(invalid("publication lease token path does not match its root"));
        }
        if !self.token_file_matches()? {
            return Err(invalid("publication lease token is missing or was replaced"));
        }
        Ok(canonical_root)
    }

    fn token_file_matches(&self) -> io::Result<bool> {
        let metadata = fs::symlink_metadata(&self.path)?;
        let token_length = u64::try_from(self.token.len())
            .map_err(|_| invalid("publication lease token length exceeds u64"))?;
        if metadata.file_type().is_symlink()
            || is_reparse_point(&metadata)
            || !metadata.is_file()
            || self.token.len() > MAX_PUBLICATION_LEASE_TOKEN_BYTES
            || metadata.len() != token_length
        {
            return Ok(false);
        }
        let read_limit_bytes = token_length
            .checked_add(1)
            .ok_or_else(|| invalid("publication lease token length overflow"))?;
        let read_limit_capacity = usize::try_from(read_limit_bytes)
            .map_err(|_| invalid("publication lease token read bound exceeds usize"))?;
        let mut bytes = Vec::with_capacity(read_limit_capacity);
        fs::File::open(&self.path)?.take(read_limit_bytes).read_to_end(&mut bytes)?;
        Ok(bytes.len() == self.token.len() && bytes.as_slice() == self.token.as_bytes())
    }
}
impl Drop for PublicationLease {
    fn drop(&mut self) {
        // Do not remove a replaced lease belonging to a different publisher.
        let root_is_still_canonical = matches!(validate_publication_root(&self.root), Ok(true))
            && fs::canonicalize(&self.root).ok().as_deref() == Some(self.root.as_path());
        if root_is_still_canonical && self.token_file_matches().unwrap_or(false) {
            let _ = fs::remove_file(&self.path);
        }
    }
}

/// Construct from this invocation's member list; never scan stale directory files.
pub(crate) fn publish(
    root: &Path,
    producer: Option<PublicationOwner>,
    member_paths: impl IntoIterator<Item = String>,
) -> io::Result<()> {
    if producer.as_ref().is_some_and(|owner| {
        [&owner.run_id, &owner.stage_id, &owner.stage_kind].iter().any(|v| v.trim().is_empty())
    }) { return Err(invalid("incomplete generation producer identity")); }
    ensure_legacy_publication_allowed(root)?;
    let mut members = BTreeMap::new();
    for relative in member_paths {
        validate_member_path(&relative)?;
        let member = hash_file(&checked_path(root, &relative)?)?;
        if members.insert(relative, member).is_some() {
            return Err(invalid("duplicate generation member"));
        }
    }
    if members.is_empty() { return Err(invalid("empty generation publication")); }
    let content = GenerationBody { schema_version: SCHEMA.into(), producer, members };
    let commit = GenerationCommit { generation_id: generation_id(&content)?, content };
    // No claim that a mutable directory is an immutable snapshot. Every reader
    // validates the exact consumed bytes against this final commit.
    for (relative, expected) in &commit.content.members {
        if hash_file(&checked_path(root, relative)?)? != *expected {
            return Err(invalid("generation member changed before publication"));
        }
    }
    if serde_json::to_vec_pretty(&commit)?.len() as u64 > MAX_COMMIT_BYTES {
        return Err(invalid("generation commit exceeds control-plane bound"));
    }
    fs::create_dir_all(root.join("frequency_domain"))?;
    let parent_metadata = fs::symlink_metadata(root.join("frequency_domain"))?;
    if parent_metadata.file_type().is_symlink() || is_reparse_point(&parent_metadata) {
        return Err(invalid("generation commit directory is redirected"));
    }
    crate::autosave_zarr::write_json_atomic(&root.join(COMMIT_PATH), &commit)
        .map_err(invalid)
}

/// Publish an immutable v2 generation from this invocation's exact member bytes.
///
/// Members are written into a unique private sibling directory and published
/// without replacement. The v2 current pointer is atomically replaced last.
/// This additive API is not yet used by the production artifact writer.
/// It does not claim power-loss durability for every filesystem/platform.
pub fn publish_immutable(
    root: &Path,
    producer: Option<PublicationOwner>,
    member_bytes: impl IntoIterator<Item = (String, Vec<u8>)>,
) -> io::Result<GenerationCommit> {
    validate_publication_root(root)?;
    let (payloads, commit) = prepare_immutable_publication(producer, member_bytes)?;

    validate_publication_root(root)?;
    let lease = PublicationLease::acquire(root)?;
    publish_immutable_prepared(root, payloads, commit, &lease)
}

/// Publish with a lease already acquired by the caller for this canonical root.
/// The helper validates the lease before every mutating publication phase.
pub(crate) fn publish_immutable_with_lease(
    root: &Path,
    producer: Option<PublicationOwner>,
    member_bytes: impl IntoIterator<Item = (String, Vec<u8>)>,
    lease: &PublicationLease,
) -> io::Result<GenerationCommit> {
    lease.validate_for(root)?;
    let (payloads, commit) = prepare_immutable_publication(producer, member_bytes)?;
    publish_immutable_prepared(root, payloads, commit, lease)
}

fn prepare_immutable_publication(
    producer: Option<PublicationOwner>,
    member_bytes: impl IntoIterator<Item = (String, Vec<u8>)>,
) -> io::Result<(BTreeMap<String, Vec<u8>>, GenerationCommit)> {
    if producer.as_ref().is_some_and(|owner| {
        [&owner.run_id, &owner.stage_id, &owner.stage_kind].iter().any(|value| value.trim().is_empty())
    }) {
        return Err(invalid("incomplete generation producer identity"));
    }


    let mut payloads = BTreeMap::new();
    let mut members = BTreeMap::new();
    for (relative, bytes) in member_bytes {
        validate_member_path(&relative)?;
        let byte_length = u64::try_from(bytes.len())
            .map_err(|_| invalid("generation member length exceeds u64"))?;
        let member = GenerationMember { byte_length, sha256: digest(&bytes) };
        if members.insert(relative.clone(), member).is_some() {
            return Err(invalid("duplicate generation member"));
        }
        payloads.insert(relative, bytes);
    }
    if members.is_empty() {
        return Err(invalid("empty generation publication"));
    }

    let content = GenerationBody {
        schema_version: IMMUTABLE_SCHEMA.into(),
        producer,
        members,
    };
    let commit = GenerationCommit {
        generation_id: generation_id(&content)?,
        content,
    };
    if !valid_digest(&commit.generation_id)
        || serde_json::to_vec_pretty(&commit)?.len() as u64 > MAX_COMMIT_BYTES
    {
        return Err(invalid("invalid or oversized immutable generation commit"));
    }

    Ok((payloads, commit))
}

fn publish_immutable_prepared(
    root: &Path,
    payloads: BTreeMap<String, Vec<u8>>,
    commit: GenerationCommit,
    lease: &PublicationLease,
) -> io::Result<GenerationCommit> {
    let root = lease.validate_for(root)?;
    if marker_path_if_present(&root, IMMUTABLE_COMMIT_PATH)?.is_some() {
        let current = generation_core::capture(&root)?
            .ok_or_else(|| invalid("immutable generation disappeared"))?;
        if !current.is_immutable() {
            return Err(invalid("v2 generation marker resolved to a mutable capture"));
        }
    }
    lease.validate_for(&root)?;
    let generations_directory = ensure_directory_chain(&root, GENERATION_DIRECTORY)?;

    let generation_name = commit.generation_id.strip_prefix("sha256:")
        .ok_or_else(|| invalid("immutable generation ID is not a SHA-256 digest"))?;
    let destination = generations_directory.join(generation_name);
    let generation_relative = format!("{GENERATION_DIRECTORY}/{generation_name}");

    match fs::symlink_metadata(&destination) {
        Ok(metadata) => {
            if metadata.file_type().is_symlink() || is_reparse_point(&metadata) || !metadata.is_dir() {
                return Err(invalid("immutable generation destination is not a regular directory"));
            }
            let existing = checked_directory(&root, &generation_relative)?;
            verify_members_at_directory(&existing, &commit.content.members)?;
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            lease.validate_for(&root)?;
            let staging = generations_directory.join(format!(
                ".stage-{}-{}",
                std::process::id(),
                uuid::Uuid::new_v4()
            ));
            create_private_staging(&staging)?;
            for (relative, bytes) in &payloads {
                lease.validate_for(&root)?;
                write_member_bytes(&staging, relative, bytes)?;
            }
            verify_members_at_directory(&staging, &commit.content.members)?;

            lease.validate_for(&root)?;
            fullmag_session::publish_directory(&staging, &destination).map_err(|error| {
                match error.downcast::<fullmag_session::PublicationUncertain>() {
                    Ok(uncertain) => io::Error::new(io::ErrorKind::Other, uncertain),
                    Err(error) => match error.downcast::<fullmag_session::WriterReleaseUnconfirmed>() {
                        Ok(unconfirmed) => io::Error::new(io::ErrorKind::Other, unconfirmed),
                        Err(error) => io::Error::new(io::ErrorKind::Other, error),
                    },
                }
            })?;

            // Revalidate after the no-replace rename. Any failure leaves the
            // published directory as an orphan and the current pointer intact.
            let published = checked_directory(&root, &generation_relative)?;
            verify_members_at_directory(&published, &commit.content.members)?;
        }
        Err(error) => return Err(error),
    }

    #[cfg(test)]
    if fail_v2_before_marker() {
        return Err(invalid("injected failure after immutable directory publication"));
    }

    lease.validate_for(&root)?;
    crate::autosave_zarr::write_json_atomic(&root.join(IMMUTABLE_COMMIT_PATH), &commit)
        .map_err(invalid)?;
    Ok(commit)
}
#[cfg(test)]
std::thread_local! {
    static FAIL_V2_BEFORE_MARKER: std::cell::Cell<bool> = std::cell::Cell::new(false);
}

#[cfg(test)]
fn fail_v2_before_marker() -> bool {
    FAIL_V2_BEFORE_MARKER.with(|flag| flag.replace(false))
}
#[cfg(test)]
mod tests {
    use super::*;
    struct Temp(PathBuf);
    impl Temp {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!("fullmag-generation-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(root.join("frequency_domain")).unwrap();
            fs::create_dir_all(root.join("eigen")).unwrap();
            Self(root)
        }
    }
    impl Drop for Temp { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); } }
    fn fixture(root: &Path) {
        fs::write(root.join("eigen/spectrum.json"), b"one").unwrap();
        fs::write(root.join("eigen/dispersion.csv"), b"two").unwrap();
        publish(root, None, ["eigen/spectrum.json".into(), "eigen/dispersion.csv".into()]).unwrap();
    }

    #[test]
    fn immutable_v2_keeps_history_bytes_and_enforces_current_capture_fence() {
        let tmp = Temp::new();
        let first = publish_immutable(
            &tmp.0,
            None,
            vec![("eigen/result.json".into(), b"first".to_vec())],
        ).unwrap();
        assert_eq!(first.content.schema_version, "frequency_domain_artifact_generation.v2");
        let first_capture = capture(&tmp.0).unwrap().unwrap();
        assert!(first_capture.is_immutable());
        let first_name = first.generation_id.strip_prefix("sha256:").unwrap();
        let first_path = tmp.0.join(GENERATION_DIRECTORY).join(first_name).join("eigen/result.json");

        let second = publish_immutable(
            &tmp.0,
            None,
            vec![("eigen/result.json".into(), b"second".to_vec())],
        ).unwrap();
        assert_ne!(first.generation_id, second.generation_id);
        assert_eq!(fs::read(&first_path).unwrap(), b"first");
        let second_capture = capture(&tmp.0).unwrap().unwrap();
        assert!(second_capture.is_immutable());
        assert_eq!(second_capture.read_member(&tmp.0, "eigen/result.json").unwrap(), b"second");
        assert!(first_capture.ensure_current(&tmp.0).is_err());
    }

    #[test]
    fn v1_publisher_cannot_shadow_valid_or_corrupt_v2_pointer() {
        let tmp = Temp::new();
        fixture(&tmp.0);
        let v1_pointer = fs::read(tmp.0.join(COMMIT_PATH)).unwrap();
        publish_immutable(
            &tmp.0,
            None,
            vec![("eigen/v2.json".into(), b"v2".to_vec())],
        ).unwrap();

        assert!(publish(
            &tmp.0,
            None,
            ["eigen/spectrum.json".into(), "eigen/dispersion.csv".into()],
        ).is_err());
        assert_eq!(fs::read(tmp.0.join(COMMIT_PATH)).unwrap(), v1_pointer);
        assert!(capture(&tmp.0).unwrap().unwrap().is_immutable());

        fs::write(tmp.0.join(IMMUTABLE_COMMIT_PATH), b"not-json").unwrap();
        assert!(publish(
            &tmp.0,
            None,
            ["eigen/spectrum.json".into(), "eigen/dispersion.csv".into()],
        ).is_err());
        assert_eq!(fs::read(tmp.0.join(COMMIT_PATH)).unwrap(), v1_pointer);
        assert!(capture(&tmp.0).is_err());
    }
    #[test]
    fn corrupt_v2_marker_does_not_fall_back_to_valid_v1() {
        let tmp = Temp::new();
        fixture(&tmp.0);
        fs::write(tmp.0.join(IMMUTABLE_COMMIT_PATH), b"not-json").unwrap();
        assert!(capture(&tmp.0).is_err());
    }

    #[test]
    fn immutable_v2_does_not_replace_a_corrupt_current_pointer() {
        let tmp = Temp::new();
        let marker = tmp.0.join(IMMUTABLE_COMMIT_PATH);
        fs::write(&marker, b"not-json").unwrap();
        let original = fs::read(&marker).unwrap();

        assert!(publish_immutable(
            &tmp.0,
            None,
            vec![("eigen/result.json".into(), b"replacement".to_vec())],
        )
        .is_err());
        assert_eq!(fs::read(marker).unwrap(), original);
        assert!(!tmp.0.join(GENERATION_DIRECTORY).exists());
        assert!(!tmp.0.join(".frequency-domain-publication.lease").exists());
    }

    #[cfg(unix)]
    #[test]
    fn immutable_v2_rejects_a_symlink_root_before_mutation() {
        let tmp = Temp::new();
        let linked_root = tmp.0.join("root-link");
        std::os::unix::fs::symlink(&tmp.0, &linked_root).unwrap();

        assert!(publish_immutable(
            &linked_root,
            None,
            vec![("eigen/result.json".into(), b"payload".to_vec())],
        )
        .is_err());
        assert!(!tmp.0.join(".frequency-domain-publication.lease").exists());
        assert!(!tmp.0.join(GENERATION_DIRECTORY).exists());
        assert!(!tmp.0.join(IMMUTABLE_COMMIT_PATH).exists());
    }

    #[test]
    fn immutable_v2_rejects_missing_and_reserved_members() {
        let tmp = Temp::new();
        let captured = {
            publish_immutable(
                &tmp.0,
                None,
                vec![("eigen/present.json".into(), b"present".to_vec())],
            ).unwrap();
            capture(&tmp.0).unwrap().unwrap()
        };
        assert!(captured.read_member(&tmp.0, "eigen/missing.json").is_err());
        let generation_name = captured.commit.generation_id.strip_prefix("sha256:").unwrap();
        let member = tmp.0.join(GENERATION_DIRECTORY).join(generation_name).join("eigen/present.json");
        fs::remove_file(member).unwrap();
        assert!(captured.verify_member(&tmp.0, "eigen/present.json").is_err());

        let other = Temp::new();
        for path in [
            COMMIT_PATH,
            IMMUTABLE_COMMIT_PATH,
            "frequency_domain/generation.v1.json/child",
            "frequency_domain/generation.v2.json/child",
            "WRITER.owner.json/child",
            GENERATION_DIRECTORY,
            "frequency_domain/generations/fake/payload.json",
            "WRITER.owner.json",
        ] {
            assert!(publish_immutable(&other.0, None, vec![(path.into(), b"x".to_vec())]).is_err());
        }
        assert!(capture(&other.0).unwrap().is_none());
        assert!(!other.0.join(GENERATION_DIRECTORY).exists());
    }

    #[test]
    fn immutable_v2_verifies_existing_target_without_replacing_bytes_or_pointer() {
        let tmp = Temp::new();
        let commit = publish_immutable(
            &tmp.0,
            None,
            vec![("eigen/result.json".into(), b"expected".to_vec())],
        ).unwrap();
        let pointer = fs::read(tmp.0.join(IMMUTABLE_COMMIT_PATH)).unwrap();
        let generation_name = commit.generation_id.strip_prefix("sha256:").unwrap();
        let member = tmp.0.join(GENERATION_DIRECTORY).join(generation_name).join("eigen/result.json");
        fs::write(&member, b"tampered").unwrap();

        assert!(publish_immutable(
            &tmp.0,
            None,
            vec![("eigen/result.json".into(), b"expected".to_vec())],
        ).is_err());
        assert_eq!(fs::read(member).unwrap(), b"tampered");
        assert_eq!(fs::read(tmp.0.join(IMMUTABLE_COMMIT_PATH)).unwrap(), pointer);
    }

    #[test]
    fn immutable_v2_keeps_directory_orphan_when_failure_precedes_marker() {
        let tmp = Temp::new();
        let bytes = b"orphan".to_vec();
        FAIL_V2_BEFORE_MARKER.with(|flag| flag.set(true));
        assert!(publish_immutable(
            &tmp.0,
            None,
            vec![("eigen/result.json".into(), bytes.clone())],
        ).is_err());
        assert!(!tmp.0.join(IMMUTABLE_COMMIT_PATH).exists());

        let members = BTreeMap::from([(
            "eigen/result.json".to_string(),
            GenerationMember { byte_length: bytes.len() as u64, sha256: digest(&bytes) },
        )]);
        let body = GenerationBody {
            schema_version: IMMUTABLE_SCHEMA.into(),
            producer: None,
            members,
        };
        let generation_name = generation_id(&body).unwrap().strip_prefix("sha256:").unwrap().to_string();
        let orphan = tmp.0.join(GENERATION_DIRECTORY).join(generation_name).join("eigen/result.json");
        assert_eq!(fs::read(orphan).unwrap(), bytes);

        let recovered = publish_immutable(
            &tmp.0,
            None,
            vec![("eigen/result.json".into(), bytes.clone())],
        ).unwrap();
        assert_eq!(capture(&tmp.0).unwrap().unwrap().read_member(&tmp.0, "eigen/result.json").unwrap(), bytes);
        assert!(recovered.generation_id.starts_with("sha256:"));
    }
    #[test]
    fn exact_members_bind_changed_same_length_csv_and_commit_replacement() {
        let tmp = Temp::new(); fixture(&tmp.0);
        let old = capture(&tmp.0).unwrap().unwrap();
        assert!(!old.is_immutable());
        assert_eq!(old.read_member(&tmp.0, "eigen/dispersion.csv").unwrap(), b"two");
        assert_eq!(old.verify_member(&tmp.0, "eigen/dispersion.csv").unwrap().byte_length, 3);
        assert!(old.read_member_bounded(&tmp.0, "eigen/dispersion.csv", 2).is_err());
        assert_eq!(old.read_member_bounded(&tmp.0, "eigen/dispersion.csv", 3).unwrap(), b"two");
        let mut tampered = old.clone();
        tampered.commit.content.producer = Some(PublicationOwner {
            run_id: "different-run".into(), stage_id: "different-stage".into(), stage_kind: "eigenmodes".into(),
        });
        assert!(tampered.ensure_current(&tmp.0).is_err());
        fs::write(tmp.0.join("eigen/dispersion.csv"), b"new").unwrap();
        assert!(old.read_member(&tmp.0, "eigen/dispersion.csv").is_err());
        assert!(old.verify_member(&tmp.0, "eigen/dispersion.csv").is_err());
        publish(&tmp.0, None, ["eigen/spectrum.json".into(), "eigen/dispersion.csv".into()]).unwrap();
        let new = capture(&tmp.0).unwrap().unwrap();
        assert_ne!(old.commit.generation_id, new.commit.generation_id);
        assert!(old.ensure_current(&tmp.0).is_err());
        assert_eq!(new.read_member(&tmp.0, "eigen/dispersion.csv").unwrap(), b"new");
    }
    #[test]
    fn publication_lease_rejects_concurrent_writers_and_releases_its_own_token() {
        let tmp = Temp::new();
        let first = PublicationLease::acquire(&tmp.0).unwrap();
        assert_eq!(PublicationLease::acquire(&tmp.0).err().unwrap().kind(), io::ErrorKind::AlreadyExists);
        drop(first);
        let second = PublicationLease::acquire(&tmp.0).unwrap();
        fs::write(&second.path, b"replacement-owner").unwrap();
        drop(second);
        assert_eq!(fs::read(tmp.0.join(".frequency-domain-publication.lease")).unwrap(), b"replacement-owner");
    }

    #[test]
    fn immutable_v2_publishes_under_the_callers_existing_lease() {
        let tmp = Temp::new();
        let lease = PublicationLease::acquire(&tmp.0).unwrap();
        let commit = publish_immutable_with_lease(
            &tmp.0,
            None,
            vec![("eigen/result.json".into(), b"owned-lease".to_vec())],
            &lease,
        ).unwrap();

        let capture = capture(&tmp.0).unwrap().unwrap();
        assert_eq!(capture.commit.generation_id, commit.generation_id);
        assert_eq!(
            capture.read_member(&tmp.0, "eigen/result.json").unwrap(),
            b"owned-lease",
        );
        assert_eq!(fs::read(&lease.path).unwrap(), lease.token.as_bytes());
        assert!(PublicationLease::acquire(&tmp.0).is_err());
    }

    fn assert_invalid_lease_preserves_publication(root: &Path, lease: &PublicationLease) {
        let marker_path = root.join(IMMUTABLE_COMMIT_PATH);
        let marker_before = fs::read(&marker_path).unwrap();
        let sentinel = root.join("lease-sentinel.txt");
        fs::write(&sentinel, b"preserve-me").unwrap();
        let generations = fs::read_dir(root.join(GENERATION_DIRECTORY)).unwrap().count();

        assert!(publish_immutable_with_lease(
            root,
            None,
            vec![("eigen/unpublished.json".into(), b"must-not-publish".to_vec())],
            lease,
        ).is_err());

        assert_eq!(fs::read(&marker_path).unwrap(), marker_before);
        assert_eq!(fs::read(&sentinel).unwrap(), b"preserve-me");
        assert_eq!(fs::read_dir(root.join(GENERATION_DIRECTORY)).unwrap().count(), generations);
    }

    #[test]
    fn immutable_v2_rejects_foreign_replaced_and_missing_leases_without_mutation() {
        let target = Temp::new();
        publish_immutable(
            &target.0,
            None,
            vec![("eigen/current.json".into(), b"current".to_vec())],
        ).unwrap();

        let foreign_root = Temp::new();
        let foreign_lease = PublicationLease::acquire(&foreign_root.0).unwrap();
        assert_invalid_lease_preserves_publication(&target.0, &foreign_lease);

        let replaced = PublicationLease::acquire(&target.0).unwrap();
        fs::write(&replaced.path, b"replacement-owner").unwrap();
        assert_invalid_lease_preserves_publication(&target.0, &replaced);
        drop(replaced);
        fs::remove_file(target.0.join(".frequency-domain-publication.lease")).unwrap();

        let missing = PublicationLease::acquire(&target.0).unwrap();
        fs::remove_file(&missing.path).unwrap();
        assert_invalid_lease_preserves_publication(&target.0, &missing);

        let oversized = PublicationLease::acquire(&target.0).unwrap();
        let oversized_bytes = vec![b'x'; 1024 * 1024];
        fs::write(&oversized.path, &oversized_bytes).unwrap();
        assert_invalid_lease_preserves_publication(&target.0, &oversized);
        assert_eq!(fs::read(&oversized.path).unwrap(), oversized_bytes);
    }

    #[test]
    fn public_immutable_publisher_refuses_an_active_lease_without_mutation() {
        let tmp = Temp::new();
        publish_immutable(
            &tmp.0,
            None,
            vec![("eigen/current.json".into(), b"current".to_vec())],
        ).unwrap();
        let marker_path = tmp.0.join(IMMUTABLE_COMMIT_PATH);
        let marker_before = fs::read(&marker_path).unwrap();
        let sentinel = tmp.0.join("lease-sentinel.txt");
        fs::write(&sentinel, b"preserve-me").unwrap();
        let generations = fs::read_dir(tmp.0.join(GENERATION_DIRECTORY)).unwrap().count();
        let _active_lease = PublicationLease::acquire(&tmp.0).unwrap();

        assert!(publish_immutable(
            &tmp.0,
            None,
            vec![("eigen/unpublished.json".into(), b"must-not-publish".to_vec())],
        ).is_err());

        assert_eq!(fs::read(marker_path).unwrap(), marker_before);
        assert_eq!(fs::read(sentinel).unwrap(), b"preserve-me");
        assert_eq!(fs::read_dir(tmp.0.join(GENERATION_DIRECTORY)).unwrap().count(), generations);
    }

    #[cfg(unix)]
    #[test]
    fn immutable_v2_rejects_a_symlink_lease_without_mutation() {
        let tmp = Temp::new();
        publish_immutable(
            &tmp.0,
            None,
            vec![("eigen/current.json".into(), b"current".to_vec())],
        ).unwrap();
        let lease = PublicationLease::acquire(&tmp.0).unwrap();
        let external_token = tmp.0.join("external-lease-token");
        fs::write(&external_token, lease.token.as_bytes()).unwrap();
        fs::remove_file(&lease.path).unwrap();
        std::os::unix::fs::symlink(&external_token, &lease.path).unwrap();

        assert_invalid_lease_preserves_publication(&tmp.0, &lease);
        assert_eq!(fs::read(external_token).unwrap(), lease.token.as_bytes());
    }

    #[test]
    fn legacy_and_unbound_publications_do_not_invent_owners() {
        let tmp = Temp::new(); assert!(capture(&tmp.0).unwrap().is_none()); fixture(&tmp.0);
        assert!(capture(&tmp.0).unwrap().unwrap().commit.content.producer.is_none());
    }
    #[test]
    fn bad_members_and_interrupted_publication_preserve_commit() {
        let tmp = Temp::new(); fixture(&tmp.0);
        let old = fs::read(tmp.0.join(COMMIT_PATH)).unwrap();
        for path in ["../escape", "eigen//dispersion.csv", "eigen/./dispersion.csv", "C:/outside", "eigen\\outside", COMMIT_PATH, IMMUTABLE_COMMIT_PATH, GENERATION_DIRECTORY, "frequency_domain/generations/id/payload"] {
            assert!(publish(&tmp.0, None, [path.into()]).is_err());
            assert_eq!(fs::read(tmp.0.join(COMMIT_PATH)).unwrap(), old);
        }
        assert!(publish(&tmp.0, None, ["missing".into()]).is_err());
        assert_eq!(fs::read(tmp.0.join(COMMIT_PATH)).unwrap(), old);
        let captured = capture(&tmp.0).unwrap().unwrap();
        assert!(captured.read_member(&tmp.0, "metadata.json").is_err());
    }
    #[cfg(unix)]
    #[test]
    fn symlink_members_are_rejected() {
        let tmp = Temp::new(); fixture(&tmp.0);
        std::os::unix::fs::symlink(tmp.0.join("eigen/dispersion.csv"), tmp.0.join("eigen/link")).unwrap();
        assert!(publish(&tmp.0, None, ["eigen/link".into()]).is_err());

        let other = Temp::new();
        std::os::unix::fs::symlink(other.0.join("eigen"), other.0.join("frequency_domain/generations")).unwrap();
        assert!(publish_immutable(
            &other.0,
            None,
            vec![("eigen/payload.json".into(), b"payload".to_vec())],
        ).is_err());
    }
}
