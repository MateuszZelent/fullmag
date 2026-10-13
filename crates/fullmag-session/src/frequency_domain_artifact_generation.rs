//! Canonical read-only capture and membership validation for committed frequency-domain artifacts.
//! This proves byte membership, never physics or runtime authentication.
//! Writer support helpers are doc-hidden and shared with the runner publisher.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs;
use std::io::{self, Read};
use std::path::{Component, Path, PathBuf};

#[doc = "Current mutable v1 generation pointer within an artifact root."]
pub const COMMIT_PATH: &str = "frequency_domain/generation.v1.json";
#[doc = "Current immutable v2 generation pointer within an artifact root."]
pub const IMMUTABLE_COMMIT_PATH: &str = "frequency_domain/generation.v2.json";
#[doc(hidden)]
pub const GENERATION_DIRECTORY: &str = "frequency_domain/generations";
#[doc(hidden)]
pub const SCHEMA: &str = "frequency_domain_artifact_generation.v1";
#[doc(hidden)]
pub const IMMUTABLE_SCHEMA: &str = "frequency_domain_artifact_generation.v2";
#[doc(hidden)]
pub const MAX_COMMIT_BYTES: u64 = 4 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct PublicationOwner {
    pub run_id: String,
    pub stage_id: String,
    pub stage_kind: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct GenerationMember {
    pub byte_length: u64,
    pub sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct GenerationBody {
    pub schema_version: String,
    /// Supplied by execution ownership; absence is not filled from the viewer.
    pub producer: Option<PublicationOwner>,
    pub members: BTreeMap<String, GenerationMember>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct GenerationCommit {
    pub generation_id: String,
    pub content: GenerationBody,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum GenerationLayout {
    MutableV1,
    ImmutableV2,
}

#[derive(Debug, Clone)]
pub struct GenerationCapture {
    pub commit: GenerationCommit,
    commit_digest: String,
    layout: GenerationLayout,
}

fn invalid(message: impl Into<String>) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message.into())
}

#[doc(hidden)]
pub fn digest(bytes: &[u8]) -> String {
    format!("sha256:{:x}", Sha256::digest(bytes))
}

#[doc(hidden)]
pub fn valid_digest(value: &str) -> bool {
    value.strip_prefix("sha256:").is_some_and(|v| {
        v.len() == 64 && v.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    })
}

#[doc(hidden)]
pub fn validate_relative(relative: &str) -> io::Result<PathBuf> {
    if relative.is_empty()
        || relative.contains(char::from(92))
        || relative.contains(':')
        || relative.as_bytes().contains(&0)
    {
        return Err(invalid("generation member path is not canonical relative"));
    }
    let path = Path::new(relative);
    if path.components().any(|c| !matches!(c, Component::Normal(_)))
        || path.to_string_lossy() != relative
        || relative.split('/').any(|part| part.is_empty() || part == "." || part == "..")
    {
        return Err(invalid("generation member path escapes its publication"));
    }
    Ok(path.to_path_buf())
}

fn is_reserved_member_path(relative: &str) -> bool {
    [
        COMMIT_PATH,
        IMMUTABLE_COMMIT_PATH,
        "WRITER.owner.json",
        GENERATION_DIRECTORY,
    ]
    .iter()
    .any(|reserved| {
        relative == *reserved
            || relative
                .strip_prefix(*reserved)
                .is_some_and(|tail| tail.starts_with('/'))
    })
}

#[doc(hidden)]
pub fn validate_member_path(relative: &str) -> io::Result<PathBuf> {
    let path = validate_relative(relative)?;
    if is_reserved_member_path(relative) {
        return Err(invalid("generation member uses a reserved publication path"));
    }
    Ok(path)
}
#[doc(hidden)]
pub fn checked_path(root: &Path, relative: &str) -> io::Result<PathBuf> {
    if relative.is_empty() || (relative.contains('\\') || relative.contains(':') || relative.contains('\0')) {
        return Err(invalid("generation member path is not canonical relative"));
    }
    let path = Path::new(relative);
    if path.components().any(|c| !matches!(c, Component::Normal(_)))
        || path.to_string_lossy() != relative
        || relative.split('/').any(|part| part.is_empty() || part == "." || part == "..")
    {
        return Err(invalid("generation member path escapes its publication"));
    }
    let canonical_root = fs::canonicalize(root)?;
    let mut candidate = canonical_root.clone();
    for part in path.components() {
        candidate.push(part.as_os_str());
        let metadata = fs::symlink_metadata(&candidate)?;
        if metadata.file_type().is_symlink() || is_reparse_point(&metadata) {
            return Err(invalid("generation member contains a symlink or reparse point"));
        }
    }
    let canonical = fs::canonicalize(&candidate)?;
    if !canonical.starts_with(&canonical_root) || !fs::metadata(&canonical)?.is_file() {
        return Err(invalid("generation member is not a regular in-root file"));
    }
    Ok(canonical)
}

#[cfg(windows)]
#[doc(hidden)]
pub fn is_reparse_point(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    metadata.file_attributes() & 0x400 != 0
}
#[cfg(not(windows))]
#[doc(hidden)]
pub fn is_reparse_point(_: &fs::Metadata) -> bool { false }

#[doc(hidden)]
pub fn checked_directory(root: &Path, relative: &str) -> io::Result<PathBuf> {
    let path = validate_relative(relative)?;
    let canonical_root = fs::canonicalize(root)?;
    let mut candidate = canonical_root.clone();
    for part in path.components() {
        candidate.push(part.as_os_str());
        let metadata = fs::symlink_metadata(&candidate)?;
        if metadata.file_type().is_symlink() || is_reparse_point(&metadata) || !metadata.is_dir() {
            return Err(invalid("generation directory contains a link or non-directory"));
        }
    }
    let canonical = fs::canonicalize(&candidate)?;
    if !canonical.starts_with(&canonical_root) || !fs::metadata(&canonical)?.is_dir() {
        return Err(invalid("generation directory is not an in-root directory"));
    }
    Ok(canonical)
}

#[doc(hidden)]
pub fn marker_path_if_present(root: &Path, relative: &str) -> io::Result<Option<PathBuf>> {
    let path = validate_relative(relative)?;
    let canonical_root = fs::canonicalize(root)?;
    let mut candidate = canonical_root;
    let parts = path.components().collect::<Vec<_>>();
    for (index, part) in parts.iter().enumerate() {
        candidate.push(part.as_os_str());
        let metadata = match fs::symlink_metadata(&candidate) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error),
        };
        if metadata.file_type().is_symlink() || is_reparse_point(&metadata) {
            return Err(invalid("generation commit path contains a link or reparse point"));
        }
        if index + 1 < parts.len() && !metadata.is_dir() {
            return Err(invalid("generation commit parent is not a directory"));
        }
        if index + 1 == parts.len() && !metadata.is_file() {
            return Err(invalid("generation commit is not a regular file"));
        }
    }
    Ok(Some(candidate))
}

#[doc(hidden)]
pub fn hash_file_with_budget(path: &Path, byte_budget: u64) -> io::Result<GenerationMember> {
    let mut file = fs::File::open(path)?.take(byte_budget.saturating_add(1));
    let mut hasher = Sha256::new();
    let mut byte_length = 0u64;
    let mut buffer = [0u8; 65536];
    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 { break; }
        byte_length = byte_length.checked_add(count as u64)
            .ok_or_else(|| invalid("generation member length overflow"))?;
        if byte_length > byte_budget { return Err(invalid("generation member grew during hashing")); }
        hasher.update(&buffer[..count]);
    }
    Ok(GenerationMember { byte_length, sha256: format!("sha256:{:x}", hasher.finalize()) })
}

#[doc(hidden)]
pub fn generation_id(body: &GenerationBody) -> io::Result<String> {
    Ok(digest(&serde_json::to_vec(body)?))
}

fn capture_from_marker(
    root: &Path,
    relative: &str,
    expected_schema: &str,
    layout: GenerationLayout,
) -> io::Result<GenerationCapture> {
    let path = checked_path(root, relative)?;
    if fs::metadata(&path)?.len() > MAX_COMMIT_BYTES {
        return Err(invalid("generation commit exceeds control-plane bound"));
    }
    let mut bytes = Vec::new();
    fs::File::open(path)?.take(MAX_COMMIT_BYTES + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_COMMIT_BYTES {
        return Err(invalid("oversize generation commit"));
    }
    let commit: GenerationCommit = serde_json::from_slice(&bytes)?;
    if serde_json::to_vec_pretty(&commit)? != bytes {
        return Err(invalid("generation commit is not canonical or has duplicate fields"));
    }
    if commit.content.schema_version != expected_schema
        || commit.content.members.is_empty()
        || generation_id(&commit.content)? != commit.generation_id
        || !valid_digest(&commit.generation_id)
        || commit.content.members.iter().any(|(path, member)| {
            validate_member_path(path).is_err() || !valid_digest(&member.sha256)
        })
        || commit.content.producer.as_ref().is_some_and(|owner| {
            [&owner.run_id, &owner.stage_id, &owner.stage_kind]
                .iter()
                .any(|value| value.trim().is_empty())
        })
    {
        return Err(invalid("invalid generation commit"));
    }
    Ok(GenerationCapture {
        commit,
        commit_digest: digest(&bytes),
        layout,
    })
}

pub fn capture(root: &Path) -> io::Result<Option<GenerationCapture>> {
    let canonical_root = match fs::canonicalize(root) {
        Ok(root) => root,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    if marker_path_if_present(&canonical_root, IMMUTABLE_COMMIT_PATH)?.is_some() {
        return capture_from_marker(
            &canonical_root,
            IMMUTABLE_COMMIT_PATH,
            IMMUTABLE_SCHEMA,
            GenerationLayout::ImmutableV2,
        ).map(Some);
    }
    if marker_path_if_present(&canonical_root, COMMIT_PATH)?.is_some() {
        return capture_from_marker(
            &canonical_root,
            COMMIT_PATH,
            SCHEMA,
            GenerationLayout::MutableV1,
        ).map(Some);
    }
    Ok(None)
}
impl GenerationCapture {
    /// Whether this capture resolves members inside a content-addressed v2 generation.
    pub fn is_immutable(&self) -> bool {
        self.layout == GenerationLayout::ImmutableV2
    }

    fn checked_member_path(&self, root: &Path, relative: &str) -> io::Result<PathBuf> {
        validate_member_path(relative)?;
        match self.layout {
            GenerationLayout::MutableV1 if self.commit.content.schema_version == SCHEMA => {
                checked_path(root, relative)
            }
            GenerationLayout::ImmutableV2 if self.commit.content.schema_version == IMMUTABLE_SCHEMA => {
                let generation_name = self.commit.generation_id.strip_prefix("sha256:")
                    .filter(|value| valid_digest(&self.commit.generation_id) && value.len() == 64)
                    .ok_or_else(|| invalid("immutable generation ID is invalid"))?;
                let physical = format!("{GENERATION_DIRECTORY}/{generation_name}/{relative}");
                checked_path(root, &physical)
            }
            _ => Err(invalid("generation capture layout does not match its schema")),
        }
    }
    pub fn ensure_current(&self, root: &Path) -> io::Result<()> {
        let current = capture(root)?.ok_or_else(|| invalid("generation commit disappeared"))?;
        if current.commit_digest != self.commit_digest || current.commit != self.commit || current.layout != self.layout {
            return Err(invalid("frequency-domain generation changed"));
        }
        Ok(())
    }

    /// Streaming membership check for metadata endpoints. This does not pin a
    /// later data-plane request; that request must verify its own served bytes.
    pub fn verify_member(&self, root: &Path, relative: &str) -> io::Result<GenerationMember> {
        let expected = self.commit.content.members.get(relative)
            .ok_or_else(|| invalid("artifact is not a member of the captured generation"))?;
        let path = self.checked_member_path(root, relative)?;
        if fs::metadata(&path)?.len() != expected.byte_length {
            return Err(invalid("frequency-domain generation member length changed"));
        }
        let measured = hash_file_with_budget(&path, expected.byte_length)?;
        if measured != *expected {
            return Err(invalid("frequency-domain generation member changed"));
        }
        self.ensure_current(root)?;
        Ok(measured)
    }

    /// Returns the very bytes whose membership was verified, not a second read.
    pub fn read_member(&self, root: &Path, relative: &str) -> io::Result<Vec<u8>> {
        let maximum = self.commit.content.members.get(relative)
            .ok_or_else(|| invalid("artifact is not a member of the captured generation"))?.byte_length;
        self.read_member_bounded(root, relative, maximum)
    }

    /// Reject oversized control-plane members before allocating their contents.
    pub fn read_member_bounded(&self, root: &Path, relative: &str, maximum: u64) -> io::Result<Vec<u8>> {
        let expected = self.commit.content.members.get(relative)
            .ok_or_else(|| invalid("artifact is not a member of the captured generation"))?;
        if expected.byte_length > maximum {
            return Err(invalid("generation member exceeds reader byte budget"));
        }
        let path = self.checked_member_path(root, relative)?;
        let file = fs::File::open(path)?;
        if file.metadata()?.len() != expected.byte_length {
            return Err(invalid("frequency-domain generation member length changed"));
        }
        let read_limit = expected.byte_length.checked_add(1)
            .ok_or_else(|| invalid("generation member length cannot be bounded"))?;
        let reserve = usize::try_from(read_limit)
            .map_err(|_| invalid("generation member exceeds addressable memory"))?;
        let mut bytes = Vec::new();
        bytes.try_reserve_exact(reserve)
            .map_err(|error| invalid(format!("cannot allocate bounded generation member: {error}")))?;
        file.take(read_limit).read_to_end(&mut bytes)?;
        if bytes.len() as u64 != expected.byte_length || digest(&bytes) != expected.sha256 {
            return Err(invalid("frequency-domain generation member changed"));
        }
        self.ensure_current(root)?;
        Ok(bytes)
    }
}


#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT_TEMP_ID: AtomicU64 = AtomicU64::new(0);

    struct Temp(PathBuf);

    impl Temp {
        fn new() -> Self {
            loop {
                let sequence = NEXT_TEMP_ID.fetch_add(1, Ordering::Relaxed);
                let root = std::env::temp_dir().join(format!(
                    "fullmag-session-fd-generation-{}-{sequence}",
                    std::process::id(),
                ));
                match fs::create_dir(&root) {
                    Ok(()) => return Self(root),
                    Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
                    Err(error) => panic!("cannot create generation test directory: {error}"),
                }
            }
        }
    }

    impl Drop for Temp {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn body_for(schema: &str, relative: &str, bytes: &[u8]) -> GenerationBody {
        GenerationBody {
            schema_version: schema.to_string(),
            producer: None,
            members: BTreeMap::from([(
                relative.to_string(),
                GenerationMember {
                    byte_length: bytes.len() as u64,
                    sha256: digest(bytes),
                },
            )]),
        }
    }

    fn write_marker(root: &Path, relative: &str, commit: &GenerationCommit) {
        let path = root.join(relative);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, serde_json::to_vec_pretty(commit).unwrap()).unwrap();
    }

    fn write_v1(root: &Path, relative: &str, bytes: &[u8]) -> GenerationCommit {
        let body = body_for(SCHEMA, relative, bytes);
        let commit = GenerationCommit {
            generation_id: generation_id(&body).unwrap(),
            content: body,
        };
        let member = root.join(relative);
        fs::create_dir_all(member.parent().unwrap()).unwrap();
        fs::write(member, bytes).unwrap();
        write_marker(root, COMMIT_PATH, &commit);
        commit
    }

    fn write_v2(root: &Path, relative: &str, bytes: &[u8]) -> GenerationCommit {
        let body = body_for(IMMUTABLE_SCHEMA, relative, bytes);
        let commit = GenerationCommit {
            generation_id: generation_id(&body).unwrap(),
            content: body,
        };
        let generation_name = commit.generation_id.strip_prefix("sha256:").unwrap();
        let member = root
            .join(GENERATION_DIRECTORY)
            .join(generation_name)
            .join(relative);
        fs::create_dir_all(member.parent().unwrap()).unwrap();
        fs::write(member, bytes).unwrap();
        write_marker(root, IMMUTABLE_COMMIT_PATH, &commit);
        commit
    }

    #[test]
    fn rust_python_utf8_generation_body_golden_digest_agrees() {
        let body = GenerationBody {
            schema_version: IMMUTABLE_SCHEMA.into(),
            producer: Some(PublicationOwner {
                run_id: "run-\u{00e9}".into(),
                stage_id: "stage:\u{03b1}".into(),
                stage_kind: "frequency_response".into(),
            }),
            members: BTreeMap::from([(
                "response/\u{03bc}.json".into(),
                GenerationMember {
                    byte_length: 2,
                    sha256: "sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a".into(),
                },
            )]),
        };
        // The external Python regression consumes this same UTF-8 body and
        // expected digest; this test exercises the shared Rust serializer.
        assert_eq!(
            generation_id(&body).unwrap(),
            "sha256:cc306e3a05680ba1855960fb03b9104397067da5bf29eb2794f62201e297a2e6",
        );
    }

    #[test]
    fn v1_capture_reads_the_declared_root_member() {
        let tmp = Temp::new();
        let commit = write_v1(&tmp.0, "metadata.json", b"legacy metadata");

        let captured = capture(&tmp.0).unwrap().unwrap();
        assert!(!captured.is_immutable());
        assert_eq!(captured.commit, commit);
        assert_eq!(
            captured.read_member(&tmp.0, "metadata.json").unwrap(),
            b"legacy metadata",
        );
    }

    #[test]
    fn v2_capture_precedes_v1_and_corrupt_v2_never_falls_back() {
        let tmp = Temp::new();
        write_v1(&tmp.0, "metadata.json", b"v1 metadata");
        let v1_marker = fs::read(tmp.0.join(COMMIT_PATH)).unwrap();
        write_v2(&tmp.0, "metadata.json", b"v2 metadata");

        let captured = capture(&tmp.0).unwrap().unwrap();
        assert!(captured.is_immutable());
        assert_eq!(
            captured.read_member(&tmp.0, "metadata.json").unwrap(),
            b"v2 metadata",
        );

        fs::write(tmp.0.join(IMMUTABLE_COMMIT_PATH), b"not-json").unwrap();
        assert!(capture(&tmp.0).is_err());
        assert_eq!(fs::read(tmp.0.join(COMMIT_PATH)).unwrap(), v1_marker);
    }

    #[test]
    fn bounded_v2_read_returns_verified_bytes_and_rejects_tampering_and_stale_fence() {
        let tmp = Temp::new();
        let first = write_v2(&tmp.0, "metadata.json", b"payload");
        let captured = capture(&tmp.0).unwrap().unwrap();

        assert_eq!(
            captured
                .read_member_bounded(&tmp.0, "metadata.json", 7)
                .unwrap(),
            b"payload",
        );
        assert!(
            captured
                .read_member_bounded(&tmp.0, "metadata.json", 6)
                .is_err()
        );

        let first_path = tmp
            .0
            .join(GENERATION_DIRECTORY)
            .join(first.generation_id.strip_prefix("sha256:").unwrap())
            .join("metadata.json");
        fs::write(&first_path, b"payloAd").unwrap();
        assert!(captured.read_member(&tmp.0, "metadata.json").is_err());
        fs::write(&first_path, b"payload").unwrap();
        captured.ensure_current(&tmp.0).unwrap();

        write_v2(&tmp.0, "metadata.json", b"newer!");
        assert!(captured.ensure_current(&tmp.0).is_err());
    }
}