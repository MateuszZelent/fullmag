//! Scoped admission for Docker Windows-folder and native Linux session stores.
//!
//! Docker Desktop exposes a Windows bind mount as Linux 9p.  The native
//! writer therefore keeps 9p outside its normal filesystem allow-list and
//! reaches this module only when the operator has selected the explicit
//! `windows-folder-v1` profile and supplied both host evidence and a
//! container-specific grant.  This module only admits that evidence; all
//! writer leases, path checks, and publication barriers remain unchanged.
//! The independent `linux-native-v1` profile validates its own host certificate
//! and current mount evidence before using the ordinary Linux writer.

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::env;
use std::fs::{self, File, OpenOptions};
use std::io::Read;
#[cfg(target_os = "linux")]
use std::path::Component;
use std::path::{Path, PathBuf};
#[cfg(target_os = "linux")]
use std::sync::OnceLock;
use uuid::Uuid;

const HOST_ATTESTATION_PATH: &str = "/run/fullmag/windows-folder-host.json";
const CONTAINER_ROOT: &str = "/state";
const GRANT_NAME: &str = ".fullmag-windows-folder-grant.json";
const DEVELOPMENT_PACKAGE_ROOT: &str = "/opt/fullmag/package";
const DEVELOPMENT_PROVENANCE_PATH: &str = "/opt/fullmag/control/backend/runtime-provenance.json";
const DEVELOPMENT_RECEIPT_PATH: &str = "/opt/fullmag/package/backend-build-receipt.json";
const DEVELOPMENT_BUILD_SCHEMA: &str = "fullmag.windows-folder-development-build.v1";
#[cfg(windows)]
const OWNER_MARKER_NAME: &str = ".fullmag-windows-folder-owner.json";
pub(crate) const DOCKER_ADMITTED_STORE_IDENTITY_SCHEMA_V2: &str =
    "fullmag.docker-admitted-store-identity.v2";
const MAX_EVIDENCE_BYTES: u64 = 1024 * 1024;
const SHA256_HEX_LENGTH: usize = 64;
const SOURCE_COMMIT_HEX_LENGTH: usize = 40;
const REQUIRED_CHECKS: [&str; 9] = [
    "file_sync",
    "directory_sync",
    "atomic_replace",
    "atomic_directory_publish",
    "process_lock",
    "no_follow_symlink",
    "no_follow_junction",
    "sqlite_transactions",
    "restart_readback",
];

#[derive(Debug, Deserialize, Serialize, Clone, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct HostAttestation {
    schema: String,
    storage_profile: String,
    role: String,
    owner_scope: String,
    host_root: String,
    host_filesystem: String,
    host_drive_type: u32,
    host_volume_serial: u32,
    host_root_no_reparse: bool,
    owner_token: String,
    engine_id: String,
    image_id: String,
    source_commit: String,
    binary_hashes: BTreeMap<String, String>,
    artifact_receipt_sha256: String,
    restart_expected_sha256: String,
    restart_verified: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    development_build: Option<DevelopmentBuildDelegation>,
}

#[derive(Debug, Deserialize, Serialize, Clone, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct DevelopmentBuildDelegation {
    schema: String,
    cargo_profile: String,
    toolchain_image_id: String,
    package_root: String,
    provenance_path: String,
    group_identity: String,
    source_identity: DevelopmentSourceIdentity,
}

#[derive(Debug, Deserialize, Serialize, Clone, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct DevelopmentSourceIdentity {
    commit: String,
    source_digest: String,
    source_snapshot_sha256: String,
    native_source_identity_sha256: String,
}

#[derive(Debug, Deserialize, Serialize, Clone, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct SessionGrant {
    schema: String,
    storage_profile: String,
    role: String,
    state: String,
    container_root: String,
    host_attestation_sha256: String,
    owner_token: String,
    root_device: u64,
    root_inode: u64,
    mount_namespace_inode: u64,
    power_loss: String,
    checks: BTreeMap<String, bool>,
}

/// Stable identity for one accepted Docker session store.
///
/// The identity deliberately contains the validated Windows grant's stable
/// host and mount scope only.  Linux device/inode and mount-namespace values
/// remain admission evidence; they are not part of this restart-stable ID.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct DockerAdmittedStoreIdentity {
    pub(crate) host_root: String,
    pub(crate) host_volume_serial: u32,
    pub(crate) engine_id: String,
    pub(crate) owner_token: String,
    pub(crate) relative_state_path: String,
}

impl DockerAdmittedStoreIdentity {
    pub(crate) fn validate(&self) -> Result<()> {
        validate_windows_drive_path(&self.host_root)?;
        if self.host_root != stable_windows_host_root(&self.host_root)? {
            bail!("Docker store identity host_root is not normalized");
        }
        if self.host_volume_serial == 0 {
            bail!("Docker store identity host volume serial must be nonzero");
        }
        validate_scalar(&self.engine_id, "Docker store identity engine_id", 256)?;
        validate_uuid(&self.owner_token, "Docker store identity owner_token")?;
        if Uuid::parse_str(&self.owner_token)?.to_string() != self.owner_token {
            bail!("Docker store identity owner_token must be canonical");
        }
        validate_relative_state_path(&self.relative_state_path)?;
        Ok(())
    }

    pub(crate) fn stable_value(&self) -> Result<serde_json::Value> {
        self.validate()?;
        Ok(serde_json::json!({
            "schema": DOCKER_ADMITTED_STORE_IDENTITY_SCHEMA_V2,
            "host_root": self.host_root,
            "host_volume_serial": self.host_volume_serial,
            "engine_id": self.engine_id,
            "owner_token": self.owner_token,
            "relative_state_path": self.relative_state_path,
        }))
    }
}

fn validate_hex(value: &str, length: usize, label: &str) -> Result<()> {
    if value.len() != length
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        bail!("{label} must be lowercase hexadecimal with {length} characters");
    }
    Ok(())
}

fn validate_uuid(value: &str, label: &str) -> Result<()> {
    let uuid = Uuid::parse_str(value).with_context(|| format!("{label} is not a UUID"))?;
    if uuid.is_nil() {
        bail!("{label} must not be the nil UUID");
    }
    Ok(())
}

fn validate_scalar(value: &str, label: &str, maximum: usize) -> Result<()> {
    if value.is_empty() || value.len() > maximum || value.chars().any(char::is_control) {
        bail!("{label} is empty, oversized, or contains control characters");
    }
    Ok(())
}

fn validate_windows_drive_path(value: &str) -> Result<()> {
    let chars: Vec<char> = value.chars().collect();
    if chars.len() < 4
        || !chars[0].is_ascii_alphabetic()
        || chars[1] != ':'
        || !matches!(chars[2], '\\' | '/')
        || value.starts_with("\\\\")
        || value.starts_with("//")
        || value.chars().any(char::is_control)
    {
        bail!("host_root must be an absolute local Windows drive path");
    }
    let normalized = value.replace('\\', "/");
    for component in normalized.split('/').skip(1) {
        if component.is_empty() || component == "." || component == ".." {
            bail!("host_root contains an unsafe Windows path component");
        }
    }
    Ok(())
}

fn stable_windows_host_root(value: &str) -> Result<String> {
    validate_windows_drive_path(value)?;
    Ok(value.replace('\\', "/").to_ascii_lowercase())
}

fn validate_relative_state_path(value: &str) -> Result<()> {
    if value.is_empty() || value.starts_with('/') || value.len() > 4096 {
        bail!("Docker store identity relative_state_path is invalid");
    }
    for component in value.split('/') {
        if component.is_empty() || matches!(component, "." | "..") {
            bail!("Docker store identity relative_state_path contains an unsafe component");
        }
        validate_scalar(component, "Docker store identity path component", 255)?;
    }
    Ok(())
}

fn validate_binary_name(name: &str) -> Result<()> {
    if name.is_empty()
        || name == "."
        || name == ".."
        || name.contains(['/', '\\'])
        || name.chars().any(char::is_control)
    {
        bail!("binary_hashes contains an unsafe executable name");
    }
    Ok(())
}

fn validate_image_id(value: &str, label: &str) -> Result<()> {
    if !value.starts_with("sha256:")
        || value.len() != "sha256:".len() + SHA256_HEX_LENGTH
        || !value["sha256:".len()..]
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        bail!("{label} must be sha256: followed by 64 lowercase hexadecimal characters");
    }
    Ok(())
}

fn validate_development_source_identity(identity: &DevelopmentSourceIdentity) -> Result<()> {
    validate_hex(
        &identity.commit,
        SOURCE_COMMIT_HEX_LENGTH,
        "development source commit",
    )?;
    for (value, label) in [
        (&identity.source_digest, "development source digest"),
        (
            &identity.source_snapshot_sha256,
            "development source snapshot",
        ),
        (
            &identity.native_source_identity_sha256,
            "development native source identity",
        ),
    ] {
        validate_hex(value, SHA256_HEX_LENGTH, label)?;
    }
    Ok(())
}

fn validate_development_build(delegation: &DevelopmentBuildDelegation) -> Result<()> {
    if delegation.schema != DEVELOPMENT_BUILD_SCHEMA
        || delegation.cargo_profile != "backend-dev"
        || delegation.package_root != DEVELOPMENT_PACKAGE_ROOT
        || delegation.provenance_path != DEVELOPMENT_PROVENANCE_PATH
    {
        bail!("Windows-folder development delegation scope is invalid");
    }
    validate_image_id(
        &delegation.toolchain_image_id,
        "development toolchain image identity",
    )?;
    validate_scalar(
        &delegation.group_identity,
        "development group identity",
        256,
    )?;
    validate_development_source_identity(&delegation.source_identity)
}

fn validate_host_attestation(attestation: &HostAttestation) -> Result<()> {
    if attestation.schema != "fullmag.windows-folder-host.v1" {
        bail!("unsupported Windows-folder host attestation schema");
    }
    if attestation.storage_profile != "windows-folder-v1"
        || attestation.role != "session"
        || attestation.owner_scope != "docker-desktop-linux"
    {
        bail!("Windows-folder host attestation scope is invalid");
    }
    validate_windows_drive_path(&attestation.host_root)?;
    if !matches!(attestation.host_filesystem.as_str(), "NTFS" | "ReFS") {
        bail!("Windows-folder host filesystem must be NTFS or ReFS");
    }
    if attestation.host_drive_type != 3 {
        bail!("Windows-folder host volume must be a fixed local drive");
    }
    if attestation.host_volume_serial == 0 || !attestation.host_root_no_reparse {
        bail!("Windows-folder host volume identity is incomplete");
    }
    validate_uuid(&attestation.owner_token, "owner_token")?;
    validate_scalar(&attestation.engine_id, "engine_id", 256)?;
    validate_image_id(&attestation.image_id, "host image identity")?;
    validate_hex(
        &attestation.source_commit,
        SOURCE_COMMIT_HEX_LENGTH,
        "host source_commit",
    )?;
    if attestation.binary_hashes.is_empty() {
        bail!("host binary_hashes must not be empty");
    }
    for (name, hash) in &attestation.binary_hashes {
        validate_binary_name(name)?;
        validate_hex(hash, SHA256_HEX_LENGTH, "host binary hash")?;
    }
    validate_hex(
        &attestation.artifact_receipt_sha256,
        SHA256_HEX_LENGTH,
        "artifact_receipt_sha256",
    )?;
    validate_hex(
        &attestation.restart_expected_sha256,
        SHA256_HEX_LENGTH,
        "restart_expected_sha256",
    )?;
    if !attestation.restart_verified {
        bail!("Windows-folder restart readback was not verified");
    }
    if let Some(delegation) = &attestation.development_build {
        validate_development_build(delegation)?;
    }
    Ok(())
}

fn validate_session_grant(grant: &SessionGrant) -> Result<()> {
    if grant.schema != "fullmag.windows-folder-session.v1"
        || grant.storage_profile != "windows-folder-v1"
        || grant.role != "session"
        || grant.state != "operational"
        || grant.container_root != CONTAINER_ROOT
        || grant.power_loss != "NOT VERIFIED"
    {
        bail!("Windows-folder session grant scope or state is invalid");
    }
    validate_hex(
        &grant.host_attestation_sha256,
        SHA256_HEX_LENGTH,
        "host_attestation_sha256",
    )?;
    validate_uuid(&grant.owner_token, "grant owner_token")?;
    if grant.root_device == 0 || grant.root_inode == 0 || grant.mount_namespace_inode == 0 {
        bail!("Windows-folder session grant has an invalid filesystem identity");
    }
    if grant.checks.len() != REQUIRED_CHECKS.len()
        || REQUIRED_CHECKS
            .iter()
            .any(|name| grant.checks.get(*name) != Some(&true))
    {
        bail!("Windows-folder session grant checks are incomplete or failed");
    }
    Ok(())
}

fn absolute_path(path: &Path) -> Result<PathBuf> {
    if path.is_absolute() {
        Ok(path.to_path_buf())
    } else {
        Ok(env::current_dir()?.join(path))
    }
}

fn is_reparse(metadata: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        return metadata.file_attributes() & 0x400 != 0;
    }
    #[cfg(not(windows))]
    {
        let _ = metadata;
        false
    }
}

fn reject_link_ancestors(path: &Path) -> Result<()> {
    // Walk complete paths instead of rebuilding them from `Components`.
    // Rebuilding a Windows `Prefix` and `RootDir` separately can turn `C:\\...`
    // into a path rooted on the process current drive.
    let mut current = absolute_path(path)?;
    loop {
        match fs::symlink_metadata(&current) {
            Ok(metadata) => {
                if metadata.file_type().is_symlink() || is_reparse(&metadata) {
                    bail!(
                        "evidence path traverses a symlink or reparse point: {}",
                        current.display()
                    );
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(error).with_context(|| {
                    format!("checking evidence path component {}", current.display())
                });
            }
        }
        let Some(parent) = current.parent() else {
            break;
        };
        if parent == current {
            break;
        }
        current = parent.to_path_buf();
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn open_regular_nofollow(path: &Path) -> Result<File> {
    use std::ffi::CString;
    use std::os::fd::{AsRawFd, FromRawFd};
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::fs::OpenOptionsExt;

    let absolute = absolute_path(path)?;
    let mut components = Vec::new();
    for component in absolute.components() {
        match component {
            Component::RootDir | Component::CurDir => {}
            Component::Normal(name) => components.push(name),
            Component::ParentDir => {
                bail!(
                    "evidence path contains a parent-directory component: {}",
                    path.display()
                );
            }
            Component::Prefix(_) => {
                bail!(
                    "evidence path has an unsupported path prefix: {}",
                    path.display()
                );
            }
        }
    }
    let Some((file_name, parents)) = components.split_last() else {
        bail!(
            "evidence path has no regular file component: {}",
            path.display()
        );
    };

    // Path checks followed by a path-based open leave a race in which a
    // Windows-folder ancestor can be replaced by a reparse point.  Pin every
    // ancestor directory and resolve children through its descriptor instead.
    let mut directory = {
        let mut options = OpenOptions::new();
        options.read(true);
        options.custom_flags(libc::O_CLOEXEC | libc::O_DIRECTORY | libc::O_NOFOLLOW);
        options
            .open("/")
            .context("opening the evidence path root directory")?
    };
    for component in parents {
        let name = CString::new(component.as_bytes())
            .context("evidence path component contains an embedded NUL")?;
        let descriptor = unsafe {
            libc::openat(
                directory.as_raw_fd(),
                name.as_ptr(),
                libc::O_RDONLY | libc::O_CLOEXEC | libc::O_DIRECTORY | libc::O_NOFOLLOW,
            )
        };
        if descriptor < 0 {
            return Err(std::io::Error::last_os_error()).with_context(|| {
                format!(
                    "opening evidence directory component {}",
                    component.to_string_lossy()
                )
            });
        }
        directory = unsafe { File::from_raw_fd(descriptor) };
    }

    let name = CString::new(file_name.as_bytes())
        .context("evidence file name contains an embedded NUL")?;
    let descriptor = unsafe {
        libc::openat(
            directory.as_raw_fd(),
            name.as_ptr(),
            libc::O_RDONLY | libc::O_CLOEXEC | libc::O_NOFOLLOW | libc::O_NONBLOCK,
        )
    };
    if descriptor < 0 {
        return Err(std::io::Error::last_os_error())
            .with_context(|| format!("opening evidence file {}", path.display()));
    }
    let file = unsafe { File::from_raw_fd(descriptor) };
    let opened = file.metadata()?;
    if !opened.is_file() || is_reparse(&opened) {
        bail!(
            "opened evidence file is not a regular non-link file: {}",
            path.display()
        );
    }
    Ok(file)
}

#[cfg(not(target_os = "linux"))]
fn open_regular_nofollow(path: &Path) -> Result<File> {
    reject_link_ancestors(path)?;
    let metadata = fs::symlink_metadata(path)
        .with_context(|| format!("checking evidence file {}", path.display()))?;
    if !metadata.is_file() || metadata.file_type().is_symlink() || is_reparse(&metadata) {
        bail!(
            "evidence path is not a regular non-link file: {}",
            path.display()
        );
    }
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(0x0020_0000); // FILE_FLAG_OPEN_REPARSE_POINT
    }
    let file = options
        .open(path)
        .with_context(|| format!("opening evidence file {}", path.display()))?;
    let opened = file.metadata()?;
    if !opened.is_file() || is_reparse(&opened) {
        bail!(
            "opened evidence file is not a regular non-link file: {}",
            path.display()
        );
    }
    Ok(file)
}

fn read_bounded_regular_file(path: &Path, maximum: u64) -> Result<Vec<u8>> {
    let mut file = open_regular_nofollow(path)?;
    if file.metadata()?.len() > maximum {
        bail!(
            "evidence file exceeds the bounded read limit: {}",
            path.display()
        );
    }
    let mut bytes = Vec::with_capacity(usize::try_from(maximum.min(1024 * 1024))?);
    file.take(maximum.saturating_add(1))
        .read_to_end(&mut bytes)?;
    if u64::try_from(bytes.len())? > maximum {
        bail!(
            "evidence file changed beyond the bounded read limit: {}",
            path.display()
        );
    }
    Ok(bytes)
}

fn parse_host_attestation(bytes: &[u8]) -> Result<HostAttestation> {
    let attestation: HostAttestation =
        serde_json::from_slice(bytes).context("decoding Windows-folder host attestation")?;
    validate_host_attestation(&attestation)?;
    Ok(attestation)
}

fn parse_session_grant(bytes: &[u8]) -> Result<SessionGrant> {
    let grant: SessionGrant =
        serde_json::from_slice(bytes).context("decoding Windows-folder session grant")?;
    validate_session_grant(&grant)?;
    Ok(grant)
}

fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

#[cfg(target_os = "linux")]
fn stream_sha256(path: &Path) -> Result<String> {
    let mut file = open_regular_nofollow(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

#[cfg(target_os = "linux")]
static CURRENT_EXECUTABLE_SHA256: OnceLock<String> = OnceLock::new();

#[cfg(target_os = "linux")]
fn current_executable_sha256() -> Result<String> {
    if let Some(hash) = CURRENT_EXECUTABLE_SHA256.get() {
        return Ok(hash.clone());
    }
    let executable = env::current_exe().context("resolving current executable")?;
    let hash = stream_sha256(&executable)?;
    let _ = CURRENT_EXECUTABLE_SHA256.set(hash.clone());
    Ok(hash)
}

#[cfg(target_os = "linux")]
fn read_json_document(path: &str, label: &str) -> Result<serde_json::Value> {
    let bytes = read_bounded_regular_file(Path::new(path), MAX_EVIDENCE_BYTES)?;
    let value: serde_json::Value =
        serde_json::from_slice(&bytes).with_context(|| format!("decoding {label}"))?;
    if !value.is_object() {
        bail!("{label} must contain a JSON object");
    }
    Ok(value)
}

#[cfg(target_os = "linux")]
fn required_json_string<'a>(
    document: &'a serde_json::Value,
    field: &str,
    label: &str,
) -> Result<&'a str> {
    document
        .get(field)
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| anyhow::anyhow!("{label} has no string field {field}"))
}

#[cfg(target_os = "linux")]
fn validate_development_runtime_identity(
    delegation: &DevelopmentBuildDelegation,
    expected_commit: &str,
) -> Result<()> {
    let toolchain_image_id = env::var("FULLMAG_TOOLCHAIN_IMAGE_ID")
        .context("FULLMAG_TOOLCHAIN_IMAGE_ID is required for a development delegation")?;
    validate_image_id(&toolchain_image_id, "FULLMAG_TOOLCHAIN_IMAGE_ID")?;
    if delegation.toolchain_image_id != toolchain_image_id {
        bail!("development delegation toolchain differs from the running environment");
    }
    if env::var("FULLMAG_BACKEND_CARGO_PROFILE").ok().as_deref() != Some("backend-dev") {
        bail!("development delegation requires FULLMAG_BACKEND_CARGO_PROFILE=backend-dev");
    }
    let group_identity = env::var("FULLMAG_COMPOSE_PROJECT")
        .context("FULLMAG_COMPOSE_PROJECT is required for a development delegation")?;
    validate_scalar(&group_identity, "FULLMAG_COMPOSE_PROJECT", 256)?;
    if delegation.group_identity != group_identity {
        bail!("development delegation group identity differs from the Compose project");
    }

    let provenance = read_json_document(&delegation.provenance_path, "runtime provenance")?;
    if required_json_string(&provenance, "schema", "runtime provenance")?
        != "fullmag.docker-all-image.v1"
        || required_json_string(&provenance, "state", "runtime provenance")? != "succeeded"
        || required_json_string(&provenance, "source_mode", "runtime provenance")?
            != "live-shadow-v1"
    {
        bail!("runtime provenance is not a succeeded live development build");
    }
    if required_json_string(&provenance, "commit", "runtime provenance")? != expected_commit {
        bail!("compiled source commit differs from runtime provenance");
    }
    if required_json_string(&provenance, "package_root", "runtime provenance")?
        != DEVELOPMENT_PACKAGE_ROOT
        || required_json_string(&provenance, "backend_build_receipt", "runtime provenance")?
            != DEVELOPMENT_RECEIPT_PATH
    {
        bail!("runtime provenance paths are not canonical");
    }
    if required_json_string(&provenance, "cargo_profile", "runtime provenance")? != "backend-dev"
        || required_json_string(&provenance, "toolchain_image_id", "runtime provenance")?
            != toolchain_image_id.as_str()
    {
        bail!("runtime provenance build identity differs from the delegation");
    }
    let provenance_commit = required_json_string(&provenance, "commit", "runtime provenance")?;
    let provenance_source_digest =
        required_json_string(&provenance, "source_digest", "runtime provenance")?;
    let provenance_source_snapshot =
        required_json_string(&provenance, "source_snapshot_sha256", "runtime provenance")?;
    let provenance_native_identity_sha256 = required_json_string(
        &provenance,
        "native_source_identity_sha256",
        "runtime provenance",
    )?;
    validate_hex(
        provenance_commit,
        SOURCE_COMMIT_HEX_LENGTH,
        "runtime provenance commit",
    )?;
    for (value, label) in [
        (provenance_source_digest, "runtime provenance source digest"),
        (
            provenance_source_snapshot,
            "runtime provenance source snapshot",
        ),
        (
            provenance_native_identity_sha256,
            "runtime provenance native source identity",
        ),
    ] {
        validate_hex(value, SHA256_HEX_LENGTH, label)?;
    }

    let receipt_bytes =
        read_bounded_regular_file(Path::new(DEVELOPMENT_RECEIPT_PATH), MAX_EVIDENCE_BYTES)?;
    let receipt_sha256 = sha256_hex(&receipt_bytes);
    if receipt_sha256
        != required_json_string(&provenance, "build_receipt_sha256", "runtime provenance")?
    {
        bail!("package build receipt hash differs from runtime provenance");
    }
    let receipt: serde_json::Value = serde_json::from_slice(&receipt_bytes)
        .context("decoding the package backend build receipt")?;
    if required_json_string(&receipt, "schema", "backend build receipt")?
        != "fullmag.direct-compose.backend-build-receipt.v1"
        || required_json_string(&receipt, "state", "backend build receipt")? != "succeeded"
    {
        bail!("package backend build receipt is not a succeeded direct build");
    }
    let receipt_source = receipt
        .get("source")
        .ok_or_else(|| anyhow::anyhow!("backend build receipt has no source identity"))?;
    for (field, expected) in [
        ("resolved_commit", provenance_commit),
        ("source_digest", provenance_source_digest),
        ("source_snapshot_sha256", provenance_source_snapshot),
    ] {
        if required_json_string(receipt_source, field, "backend build receipt")? != expected {
            bail!("backend build receipt source identity differs from runtime provenance");
        }
    }
    if receipt.get("native_source_identity") != provenance.get("native_source_identity")
        || required_json_string(
            &receipt,
            "native_source_identity_sha256",
            "backend build receipt",
        )? != provenance_native_identity_sha256
    {
        bail!("backend build receipt native source identity differs from provenance");
    }
    let build = receipt
        .get("build")
        .ok_or_else(|| anyhow::anyhow!("backend build receipt has no build identity"))?;
    if required_json_string(build, "cargo_profile", "backend build receipt")? != "backend-dev" {
        bail!("backend build receipt Cargo profile is not backend-dev");
    }
    let toolchain = receipt
        .get("toolchain")
        .ok_or_else(|| anyhow::anyhow!("backend build receipt has no toolchain identity"))?;
    if required_json_string(toolchain, "image_id", "backend build receipt")?
        != toolchain_image_id.as_str()
    {
        bail!("backend build receipt toolchain differs from the delegation");
    }

    let executable = env::current_exe().context("resolving current executable")?;
    let name = executable
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| anyhow::anyhow!("current executable has no portable filename"))?;
    let binary_hashes = provenance
        .get("binary_hashes")
        .and_then(serde_json::Value::as_object)
        .ok_or_else(|| anyhow::anyhow!("runtime provenance has no binary hashes"))?;
    let expected_hash = binary_hashes
        .get(name)
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| anyhow::anyhow!("runtime provenance omits the current executable"))?;
    validate_hex(
        expected_hash,
        SHA256_HEX_LENGTH,
        "runtime provenance binary hash",
    )?;
    if expected_hash != current_executable_sha256()? {
        bail!("current executable hash differs from runtime provenance");
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn validate_runtime_identity(attestation: &HostAttestation) -> Result<()> {
    let expected_commit = option_env!("FULLMAG_SOURCE_GIT_COMMIT").ok_or_else(|| {
        anyhow::anyhow!("managed source commit identity is missing at compile time")
    })?;
    validate_hex(
        expected_commit,
        SOURCE_COMMIT_HEX_LENGTH,
        "compiled FULLMAG_SOURCE_GIT_COMMIT",
    )?;
    let image_id = env::var("FULLMAG_RUNTIME_IMAGE_ID")
        .context("FULLMAG_RUNTIME_IMAGE_ID is required for Windows-folder admission")?;
    validate_image_id(&image_id, "FULLMAG_RUNTIME_IMAGE_ID")?;
    if attestation.image_id != image_id {
        bail!("Windows-folder image identity differs from the running image");
    }
    if let Some(delegation) = &attestation.development_build {
        validate_development_build(delegation)?;
        return validate_development_runtime_identity(delegation, expected_commit);
    }
    if attestation.source_commit != expected_commit {
        bail!("Windows-folder source commit differs from the managed binary");
    }
    let executable = env::current_exe().context("resolving current executable")?;
    let name = executable
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| anyhow::anyhow!("current executable has no portable filename"))?;
    let expected_hash = attestation
        .binary_hashes
        .get(name)
        .ok_or_else(|| anyhow::anyhow!("current executable is absent from host binary_hashes"))?;
    let actual_hash = current_executable_sha256()?;
    if expected_hash != &actual_hash {
        bail!("current executable hash differs from host binary attestation");
    }
    Ok(())
}

#[cfg(target_os = "linux")]
struct PinnedCandidate {
    candidate: PathBuf,
    existing: PathBuf,
    state_path: PathBuf,
    state_file: File,
    existing_file: File,
}

#[cfg(target_os = "linux")]
fn normalized_components(path: &Path, label: &str) -> Result<(PathBuf, Vec<std::ffi::OsString>)> {
    let absolute = absolute_path(path)?;
    let mut components = Vec::new();
    for component in absolute.components() {
        match component {
            Component::RootDir | Component::CurDir => {}
            Component::Normal(name) => components.push(name.to_os_string()),
            Component::ParentDir => {
                bail!("{label} contains a parent-directory component");
            }
            Component::Prefix(_) => {
                bail!("{label} has an unsupported path prefix");
            }
        }
    }
    let mut normalized = PathBuf::from("/");
    for component in &components {
        normalized.push(component);
    }
    Ok((normalized, components))
}

#[cfg(target_os = "linux")]
fn open_directory_child(parent: &File, component: &std::ffi::OsStr) -> std::io::Result<File> {
    use std::ffi::CString;
    use std::os::fd::{AsRawFd, FromRawFd};
    use std::os::unix::ffi::OsStrExt;

    let name = CString::new(component.as_bytes()).map_err(|_| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "path component contains an embedded NUL",
        )
    })?;
    let descriptor = unsafe {
        libc::openat(
            parent.as_raw_fd(),
            name.as_ptr(),
            libc::O_RDONLY | libc::O_CLOEXEC | libc::O_DIRECTORY | libc::O_NOFOLLOW,
        )
    };
    if descriptor < 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(unsafe { File::from_raw_fd(descriptor) })
}

#[cfg(target_os = "linux")]
fn open_root_directory() -> std::io::Result<File> {
    use std::os::unix::fs::OpenOptionsExt;

    let mut options = OpenOptions::new();
    options.read(true);
    options.custom_flags(libc::O_CLOEXEC | libc::O_DIRECTORY | libc::O_NOFOLLOW);
    options.open("/")
}

#[cfg(target_os = "linux")]
fn canonical_candidate(root: &Path, state: &Path) -> Result<PinnedCandidate> {
    let (state_path, state_components) = normalized_components(state, "Docker state path")?;
    let (candidate_path, root_components) = normalized_components(root, "session root")?;
    if root_components.len() < state_components.len()
        || !root_components
            .iter()
            .zip(state_components.iter())
            .all(|(root, state)| root == state)
    {
        bail!("session root escapes the Docker state mount");
    }

    let mut state_file = open_root_directory().context("opening the Docker state root")?;
    for component in &state_components {
        state_file = open_directory_child(&state_file, component).with_context(|| {
            format!(
                "opening Docker state directory component {}",
                component.to_string_lossy()
            )
        })?;
    }

    let mut existing_file = state_file.try_clone()?;
    let mut existing_path = state_path.clone();
    for component in root_components.iter().skip(state_components.len()) {
        match open_directory_child(&existing_file, component) {
            Ok(next) => {
                existing_file = next;
                existing_path.push(component);
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                break;
            }
            Err(error) => {
                return Err(error).with_context(|| {
                    format!(
                        "opening session root directory component {}",
                        component.to_string_lossy()
                    )
                });
            }
        }
    }

    Ok(PinnedCandidate {
        candidate: candidate_path,
        existing: existing_path,
        state_path,
        state_file,
        existing_file,
    })
}

#[cfg(target_os = "linux")]
fn admit_container_identity(root: &Path, grant: &SessionGrant) -> Result<()> {
    use std::os::unix::fs::MetadataExt;

    let state = Path::new(CONTAINER_ROOT);
    let pinned = canonical_candidate(root, state)?;
    let state_metadata = pinned
        .state_file
        .metadata()
        .context("statting pinned Docker state mount")?;
    if !state_metadata.is_dir()
        || state_metadata.dev() != grant.root_device
        || state_metadata.ino() != grant.root_inode
    {
        bail!("Docker state mount device/inode differs from the session grant");
    }
    let namespace =
        fs::metadata("/proc/self/ns/mnt").context("statting the current mount namespace")?;
    if namespace.ino() != grant.mount_namespace_inode {
        bail!("current mount namespace differs from the session grant");
    }
    if !pinned.candidate.starts_with(&pinned.state_path) {
        bail!("session root is outside the Docker state mount");
    }
    let existing_metadata = pinned.existing_file.metadata().with_context(|| {
        format!(
            "statting pinned session root ancestor {}",
            pinned.existing.display()
        )
    })?;
    if existing_metadata.dev() != state_metadata.dev() {
        bail!("session root crosses a filesystem device boundary");
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn relative_state_path(root: &Path) -> Result<String> {
    let (_, state_components) = normalized_components(Path::new(CONTAINER_ROOT), "Docker state path")?;
    let (_, root_components) = normalized_components(root, "session root")?;
    if root_components.len() <= state_components.len()
        || !root_components
            .iter()
            .zip(state_components.iter())
            .all(|(root, state)| root == state)
    {
        bail!("session root must be a nonempty child of the Docker state mount");
    }
    let components = root_components
        .iter()
        .skip(state_components.len())
        .map(|component| {
            component
                .to_str()
                .ok_or_else(|| anyhow::anyhow!("session root has a non-portable path component"))
        })
        .collect::<Result<Vec<_>>>()?;
    let relative = components.join("/");
    validate_relative_state_path(&relative)?;
    Ok(relative)
}

#[cfg(target_os = "linux")]
fn read_validated_admission(root: &Path) -> Result<(HostAttestation, SessionGrant, String)> {
    if env::var("FULLMAG_SESSION_STORAGE_PROFILE").ok().as_deref() != Some("windows-folder-v1") {
        bail!("9p session storage requires FULLMAG_SESSION_STORAGE_PROFILE=windows-folder-v1");
    }
    let host_bytes =
        read_bounded_regular_file(Path::new(HOST_ATTESTATION_PATH), MAX_EVIDENCE_BYTES)?;
    let host = parse_host_attestation(&host_bytes)?;
    let grant_path = Path::new(CONTAINER_ROOT).join(GRANT_NAME);
    let grant_bytes = read_bounded_regular_file(&grant_path, MAX_EVIDENCE_BYTES)?;
    let grant = parse_session_grant(&grant_bytes)?;
    if grant.owner_token != host.owner_token {
        bail!("Windows-folder host and grant owner_token differ");
    }
    if grant.host_attestation_sha256 != sha256_hex(&host_bytes) {
        bail!("Windows-folder grant does not hash the mounted host attestation");
    }
    validate_runtime_identity(&host)?;
    admit_container_identity(root, &grant)?;
    let relative = relative_state_path(root)?;
    Ok((host, grant, relative))
}

#[cfg(target_os = "linux")]
pub(crate) fn admitted_docker_store_identity(root: &Path) -> Result<DockerAdmittedStoreIdentity> {
    let (host, grant, relative_state_path) = read_validated_admission(root)?;
    let identity = DockerAdmittedStoreIdentity {
        host_root: stable_windows_host_root(&host.host_root)?,
        host_volume_serial: host.host_volume_serial,
        engine_id: host.engine_id,
        owner_token: Uuid::parse_str(&grant.owner_token)?.to_string(),
        relative_state_path,
    };
    identity.validate()?;
    Ok(identity)
}

#[cfg(not(target_os = "linux"))]
pub(crate) fn admitted_docker_store_identity(_root: &Path) -> Result<DockerAdmittedStoreIdentity> {
    bail!("Docker Windows-folder admission requires the attested Linux container")
}

/// Admit one Linux 9p-backed session root under the explicit Windows-folder
/// profile.  Every evidence file is reread for each admission; only the
/// immutable current executable hash is cached for the lifetime of the process.
#[cfg(target_os = "linux")]
pub(crate) fn admit(root: &Path) -> Result<()> {
    read_validated_admission(root)?;
    Ok(())
}

/// Recognize only the Docker-created parent of the nested runtime-services
/// volume. An arbitrary directory with missing store entries remains a partial
/// store and is rejected below.
#[cfg(target_os = "linux")]
fn is_managed_runtime_services_scaffold(root: &Path) -> Result<bool> {
    const RUNTIME_SERVICES_ROOT: &str = "/opt/fullmag/runtime-control/runtime-services";

    if !matches!(
        env::var("FULLMAG_SESSION_STORAGE_PROFILE").as_deref(),
        Ok("windows-folder-v1" | "linux-native-v1")
    ) || env::var("FULLMAG_RUNTIME_CONTROL_ROOT").as_deref()
            != Ok("/opt/fullmag/runtime-control")
        || env::var("FULLMAG_RUNTIME_SERVICES_ROOT").as_deref() != Ok(RUNTIME_SERVICES_ROOT)
    {
        return Ok(false);
    }

    let root_metadata = fs::symlink_metadata(root)?;
    if !root_metadata.is_dir() {
        return Ok(false);
    }
    let mounted = crate::repository_path::checked_path(root, "runtime-services")?;
    let mounted_metadata = match fs::symlink_metadata(&mounted) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error).context("inspecting Docker runtime-services scaffold"),
    };
    let alias = Path::new(RUNTIME_SERVICES_ROOT);
    let alias_metadata = match fs::symlink_metadata(alias) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error).context("inspecting runtime-services volume alias"),
    };
    if !mounted_metadata.is_dir()
        || mounted_metadata.file_type().is_symlink()
        || !alias_metadata.is_dir()
        || alias_metadata.file_type().is_symlink()
    {
        return Ok(false);
    }

    use std::os::unix::fs::MetadataExt;
    if (mounted_metadata.dev(), mounted_metadata.ino())
        != (alias_metadata.dev(), alias_metadata.ino())
        || mounted_metadata.dev() == root_metadata.dev()
    {
        return Ok(false);
    }

    runtime_services_scaffold_inventory(root, &mounted)
}

#[cfg(target_os = "linux")]
fn runtime_services_scaffold_inventory(root: &Path, mounted: &Path) -> Result<bool> {
    let mounted_metadata = fs::symlink_metadata(mounted)?;
    if !mounted_metadata.is_dir() || mounted_metadata.file_type().is_symlink() {
        return Ok(false);
    }

    let mut entries = fs::read_dir(root)?;
    let Some(entry) = entries.next().transpose()? else {
        return Ok(false);
    };
    if entry.file_name().to_str() != Some("runtime-services")
        || entries.next().transpose()?.is_some()
    {
        return Ok(false);
    }
    if fs::read_dir(mounted)?.next().transpose()?.is_some() {
        return Ok(false);
    }
    Ok(true)
}

fn initialize_store_under(parent: &Path, relative: &str) -> Result<(PathBuf, bool)> {
    let root = crate::repository_path::checked_path(parent, relative)?;
    let created = match fs::symlink_metadata(&root) {
        Ok(_) => {
            #[cfg(target_os = "linux")]
            if parent == Path::new("/state/runs/docker-all")
                && relative == "session-store"
                && is_managed_runtime_services_scaffold(&root)?
            {
                drop(crate::SessionStore::open(&root)?);
                return Ok((root, true));
            }
            // Existing or partial data never grants initialization or takeover.
            for relative in [
                "manifests",
                "runs",
                "scheduler_pools",
                "live_command_journals",
                "recovery",
                "temp",
                "objects/sha256",
                "objects/pins",
            ] {
                if !crate::repository_path::checked_path(&root, relative)?.is_dir() {
                    bail!("Docker accepted store is partially initialized; controlled recovery required");
                }
            }
            drop(crate::SessionStore::open_existing(&root)?);
            false
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let checked = crate::repository_path::create_new_directory(parent, relative)?;
            drop(crate::SessionStore::open(checked)?);
            true
        }
        Err(error) => return Err(error).context("inspecting the Docker accepted store"),
    };
    Ok((root, created))
}

/// Validate the independent Linux bind profile against current host and mount evidence.
#[cfg(target_os = "linux")]
pub(crate) fn linux_native_store_identity(root: &Path) -> Result<serde_json::Value> {
    use std::os::fd::AsRawFd;
    use std::os::unix::fs::MetadataExt;
    if env::var("FULLMAG_SESSION_STORAGE_PROFILE").ok().as_deref() != Some("linux-native-v1") {
        bail!("Linux native admission requires its explicit storage profile");
    }
    let state = Path::new(CONTAINER_ROOT);
    let pinned = canonical_candidate(root, state)?;
    let metadata = pinned.state_file.metadata()?;
    let mut filesystem = std::mem::MaybeUninit::<libc::statfs>::uninit();
    if unsafe { libc::fstatfs(pinned.state_file.as_raw_fd(), filesystem.as_mut_ptr()) } != 0 {
        return Err(std::io::Error::last_os_error())
            .context("checking Linux native state filesystem");
    }
    if !matches!(
        unsafe { filesystem.assume_init() }.f_type as u64,
        0xef53 | 0x5846_5342 | 0x9123_683e
    ) || pinned.existing_file.metadata()?.dev() != metadata.dev()
    {
        bail!("Linux native storage must remain on its ext4/xfs/btrfs mount");
    }
    let raw = read_bounded_regular_file(
        Path::new("/run/fullmag/linux-native-host.json"),
        MAX_EVIDENCE_BYTES,
    )?;
    let host: serde_json::Value = serde_json::from_slice(&raw)?;
    let owner: serde_json::Value = serde_json::from_slice(&read_bounded_regular_file(
        &state.join(".fullmag-linux-native-owner.json"),
        MAX_EVIDENCE_BYTES,
    )?)?;
    if host != owner
        || host["schema"] != "fullmag.linux-native-host.v1"
        || host["storage_profile"] != "linux-native-v1"
        || host["role"] != "session"
        || host["owner_scope"] != "docker-linux"
        || host["restart_verified"] != true
    {
        bail!("Linux native host owner/profile/restart evidence differs");
    }
    let token = host["owner_token"]
        .as_str()
        .context("Linux native owner token missing")?;
    validate_hex(token, 32, "Linux native owner token")?;
    let engine = host["engine_id"]
        .as_str()
        .context("Linux native engine missing")?;
    validate_scalar(engine, "Linux native engine", 256)?;
    let engine_digest = sha256_hex(engine.as_bytes());
    if env::var("FULLMAG_DOCKER_HOST_ID").ok().as_deref() != Some(engine_digest.as_str()) {
        bail!("Linux native Docker engine differs from runtime admission");
    }
    let image = host["image_id"]
        .as_str()
        .context("Linux native image missing")?;
    validate_image_id(image, "Linux native image")?;
    if env::var("FULLMAG_RUNTIME_IMAGE_ID").ok().as_deref() != Some(image) {
        bail!("Linux native runtime image differs from host admission");
    }
    let delegation: DevelopmentBuildDelegation = serde_json::from_value(
        host.get("development_build")
            .cloned()
            .context("Linux native DEV delegation is missing")?,
    )?;
    validate_development_build(&delegation)?;
    let expected_commit = option_env!("FULLMAG_SOURCE_GIT_COMMIT")
        .context("managed source commit identity is missing at compile time")?;
    validate_development_runtime_identity(&delegation, expected_commit)?;
    let payload = format!("{token}:{image}");
    if host["restart_expected_sha256"] != sha256_hex(payload.as_bytes())
        || read_bounded_regular_file(&state.join(".linux-native-sentinel"), MAX_EVIDENCE_BYTES)?
            != payload.as_bytes()
        || read_bounded_regular_file(&state.join(".linux-native-restart"), MAX_EVIDENCE_BYTES)?
            != payload.as_bytes()
    {
        bail!("Linux native restart sentinel differs");
    }
    let probe: serde_json::Value = serde_json::from_slice(&read_bounded_regular_file(
        &state.join(".linux-native-probe.json"),
        MAX_EVIDENCE_BYTES,
    )?)?;
    if probe["schema"] != "fullmag.linux-native-probe.v1"
        || probe["storage_profile"] != "linux-native-v1"
        || probe["owner_token"] != token
        || probe["host_attestation_sha256"] != sha256_hex(&raw)
        || probe["root_device"].as_u64() != Some(metadata.dev())
        || probe["root_inode"].as_u64() != Some(metadata.ino())
        || probe["mount_namespace_inode"].as_u64() != Some(fs::metadata("/proc/self/ns/mnt")?.ino())
    {
        bail!("Linux native probe is not bound to this owner/mount/namespace");
    }
    let checks = probe["checks"]
        .as_object()
        .context("Linux native probe checks missing")?;
    let expected = [
        "file_sync",
        "directory_sync",
        "atomic_replace",
        "process_lock",
        "no_follow_symlink",
        "sqlite_transactions",
        "restart_readback",
    ];
    if checks.len() != expected.len()
        || expected
            .iter()
            .any(|key| checks.get(*key).and_then(|value| value.as_bool()) != Some(true))
    {
        bail!("Linux native storage probe checks are incomplete");
    }
    // Device/inode and namespace are admission evidence; the owner scope survives recreation.
    Ok(
        serde_json::json!({"schema": "fullmag.linux-native-store-identity.v1",
        "engine_id": engine, "owner_token": token, "relative_state_path": relative_state_path(root)?}),
    )
}

/// Bootstrap only the fixed Docker accepted store after host-profile admission.
/// This is internal launcher plumbing, not a general initializer.
#[doc(hidden)]
pub fn initialize_attested_docker_accepted_store() -> Result<(PathBuf, bool)> {
    #[cfg(target_os = "linux")]
    {
        let parent = Path::new("/state/runs/docker-all");
        match env::var("FULLMAG_SESSION_STORAGE_PROFILE").ok().as_deref() {
            Some("windows-folder-v1") => admit(parent)?,
            Some("linux-native-v1") => {
                linux_native_store_identity(parent)?;
            }
            _ => bail!("Docker accepted store requires an explicit supported storage profile"),
        }
        initialize_store_under(parent, "session-store")
    }
    #[cfg(not(target_os = "linux"))]
    {
        bail!("Docker accepted-store bootstrap requires its attested Linux container");
    }
}

#[cfg(windows)]
pub(crate) fn reject_docker_owned_windows_root(root: &Path) -> Result<()> {
    let mut candidate = absolute_path(root)?;
    if !candidate.exists() {
        while !candidate.exists() {
            if !candidate.pop() {
                bail!("session root has no existing Windows ancestor");
            }
        }
    }
    reject_link_ancestors(&candidate)?;
    loop {
        let marker = candidate.join(OWNER_MARKER_NAME);
        match fs::symlink_metadata(&marker) {
            Ok(_) => {
                let bytes = read_bounded_regular_file(&marker, MAX_EVIDENCE_BYTES)
                    .context("reading Docker-owned Windows session marker")?;
                let attestation = parse_host_attestation(&bytes)
                    .context("validating Docker-owned Windows session marker")?;
                let marker_parent = fs::canonicalize(&candidate)
                    .context("canonicalizing Docker-owned Windows session marker parent")?;
                let host_root = fs::canonicalize(PathBuf::from(&attestation.host_root))
                    .context("canonicalizing Docker-owned Windows host root")?;
                if !marker_parent
                    .to_string_lossy()
                    .eq_ignore_ascii_case(&host_root.to_string_lossy())
                {
                    bail!("Docker-owned Windows session marker has an unexpected host root; controlled recovery required");
                }
                bail!("Windows session root is owned by Docker; controlled recovery required");
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error).context("checking Docker-owned Windows marker"),
        }
        let Some(parent) = candidate.parent() else {
            break;
        };
        if parent == candidate {
            break;
        }
        candidate = parent.to_path_buf();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    fn host() -> HostAttestation {
        HostAttestation {
            schema: "fullmag.windows-folder-host.v1".into(),
            storage_profile: "windows-folder-v1".into(),
            role: "session".into(),
            owner_scope: "docker-desktop-linux".into(),
            host_root: "C:\\fullmag\\storage\\runs\\session".into(),
            host_filesystem: "NTFS".into(),
            host_drive_type: 3,
            host_volume_serial: 7,
            host_root_no_reparse: true,
            owner_token: "123e4567-e89b-42d3-a456-426614174000".into(),
            engine_id: "desktop-engine".into(),
            image_id: format!("sha256:{}", "a".repeat(64)),
            source_commit: "b".repeat(40),
            binary_hashes: BTreeMap::from([("fullmag-api".into(), "c".repeat(64))]),
            artifact_receipt_sha256: "d".repeat(64),
            restart_expected_sha256: "e".repeat(64),
            restart_verified: true,
            development_build: None,
        }
    }

    fn development_delegation() -> DevelopmentBuildDelegation {
        DevelopmentBuildDelegation {
            schema: DEVELOPMENT_BUILD_SCHEMA.into(),
            cargo_profile: "backend-dev".into(),
            toolchain_image_id: format!("sha256:{}", "b".repeat(64)),
            package_root: DEVELOPMENT_PACKAGE_ROOT.into(),
            provenance_path: DEVELOPMENT_PROVENANCE_PATH.into(),
            group_identity: "fullmag-dev".into(),
            source_identity: DevelopmentSourceIdentity {
                commit: "c".repeat(40),
                source_digest: "d".repeat(64),
                source_snapshot_sha256: "e".repeat(64),
                native_source_identity_sha256: "f".repeat(64),
            },
        }
    }

    fn grant() -> SessionGrant {
        SessionGrant {
            schema: "fullmag.windows-folder-session.v1".into(),
            storage_profile: "windows-folder-v1".into(),
            role: "session".into(),
            state: "operational".into(),
            container_root: "/state".into(),
            host_attestation_sha256: "f".repeat(64),
            owner_token: "123e4567-e89b-42d3-a456-426614174000".into(),
            root_device: 1,
            root_inode: 2,
            mount_namespace_inode: 3,
            power_loss: "NOT VERIFIED".into(),
            checks: REQUIRED_CHECKS
                .into_iter()
                .map(|name| (name.into(), true))
                .collect(),
        }
    }

    #[test]
    fn strict_host_and_grant_validation_accepts_the_contract() {
        validate_host_attestation(&host()).unwrap();
        validate_session_grant(&grant()).unwrap();
    }

    #[test]
    fn development_delegation_is_optional_and_validates_bootstrap_scope() {
        let legacy = host();
        let serialized = serde_json::to_value(&legacy).unwrap();
        assert!(!serialized
            .as_object()
            .unwrap()
            .contains_key("development_build"));
        let parsed: HostAttestation = serde_json::from_value(serialized).unwrap();
        assert!(parsed.development_build.is_none());

        let mut development = host();
        development.source_commit = "1".repeat(40);
        development.development_build = Some(development_delegation());
        validate_host_attestation(&development).unwrap();
        assert_ne!(
            development.source_commit,
            development
                .development_build
                .as_ref()
                .unwrap()
                .source_identity
                .commit
        );
    }

    #[test]
    fn serde_schemas_reject_unknown_fields() {
        let mut value = serde_json::to_value(host()).unwrap();
        value["unexpected"] = serde_json::Value::Bool(true);
        assert!(serde_json::from_value::<HostAttestation>(value).is_err());
    }

    #[test]
    fn validation_rejects_unknown_or_failed_grant_checks() {
        let mut value = grant();
        value.checks.insert("unknown".into(), true);
        assert!(validate_session_grant(&value).is_err());
        let mut value = grant();
        value.checks.insert("file_sync".into(), false);
        assert!(validate_session_grant(&value).is_err());
    }

    #[test]
    fn bounded_reader_rejects_oversized_evidence() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("evidence.json");
        fs::write(&path, b"12345").unwrap();
        assert!(read_bounded_regular_file(&path, 4).is_err());
    }

    #[test]
    fn store_bootstrap_opens_valid_data_and_preserves_partial_data() {
        let directory = tempfile::tempdir().unwrap();
        let (root, created) = initialize_store_under(directory.path(), "session-store").unwrap();
        assert!(created);
        let (reopened, created) =
            initialize_store_under(directory.path(), "session-store").unwrap();
        assert_eq!(root, reopened);
        assert!(!created);
        let partial = directory.path().join("partial-store");
        fs::create_dir(&partial).unwrap();
        fs::write(partial.join("evidence"), b"retain partial failure").unwrap();
        assert!(initialize_store_under(directory.path(), "partial-store").is_err());
        assert_eq!(
            fs::read(partial.join("evidence")).unwrap(),
            b"retain partial failure"
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn docker_scaffold_inventory_requires_only_an_empty_runtime_services_view() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("session-store");
        let mounted = root.join("runtime-services");
        fs::create_dir_all(&mounted).unwrap();

        assert!(runtime_services_scaffold_inventory(&root, &mounted).unwrap());

        fs::write(root.join("evidence"), b"partial store").unwrap();
        assert!(!runtime_services_scaffold_inventory(&root, &mounted).unwrap());
        fs::remove_file(root.join("evidence")).unwrap();

        fs::write(mounted.join("evidence"), b"runtime state").unwrap();
        assert!(!runtime_services_scaffold_inventory(&root, &mounted).unwrap());
        fs::remove_file(mounted.join("evidence")).unwrap();

        #[cfg(unix)]
        {
            let replacement = directory.path().join("replacement");
            fs::create_dir(&replacement).unwrap();
            fs::remove_dir(&mounted).unwrap();
            std::os::unix::fs::symlink(&replacement, &mounted).unwrap();
            assert!(!runtime_services_scaffold_inventory(&root, &mounted).unwrap());
        }
    }

    #[cfg(unix)]
    #[test]
    fn bounded_reader_rejects_final_symlink_without_following_it() {
        use std::os::unix::fs::symlink;
        let directory = tempfile::tempdir().unwrap();
        let target = directory.path().join("target.json");
        let link = directory.path().join("link.json");
        fs::write(&target, b"{}").unwrap();
        symlink(&target, &link).unwrap();
        assert!(read_bounded_regular_file(&link, 32).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn bounded_reader_rejects_existing_ancestor_symlink_without_following_it() {
        use std::os::unix::fs::symlink;
        let directory = tempfile::tempdir().unwrap();
        let real = directory.path().join("real");
        let link = directory.path().join("link");
        let target = real.join("target.json");
        fs::create_dir(&real).unwrap();
        fs::write(&target, b"{}").unwrap();
        symlink(&real, &link).unwrap();
        assert!(read_bounded_regular_file(&link.join("target.json"), 32).is_err());
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn canonical_candidate_rejects_existing_ancestor_symlink() {
        use std::os::unix::fs::symlink;
        let directory = tempfile::tempdir().unwrap();
        let state = directory.path().join("state");
        let real = state.join("real");
        let link = state.join("link");
        fs::create_dir_all(&real).unwrap();
        symlink(&real, &link).unwrap();
        let root = link.join("session-store");
        assert!(canonical_candidate(&root, &state).is_err());
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn bounded_reader_rejects_parent_component_before_descriptor_walk() {
        let directory = tempfile::tempdir().unwrap();
        let target = directory.path().join("target.json");
        fs::write(&target, b"{}").unwrap();
        let escaped = directory
            .path()
            .join("child")
            .join("..")
            .join("target.json");
        assert!(read_bounded_regular_file(&escaped, 32).is_err());
    }
}
