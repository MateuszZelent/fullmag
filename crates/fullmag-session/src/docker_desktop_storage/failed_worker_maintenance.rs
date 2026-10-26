//! Narrow cross-build storage admission for one observed Failed worker exit.
//! Ordinary session and execution admission never use this proof.
use crate::{
    host_resource_ledger::FailedWorkerExitReconciliation,
    runtime_service::{RuntimeServiceOwnerDescriptor, RuntimeServiceOwnerLockGuard},
};
use anyhow::{bail, Context, Result};
use std::path::Path;

#[cfg(target_os = "linux")]
use super::{
    linux_native_host_admission, open_regular_nofollow, sha256_hex,
    validate_development_runtime_identity_for, validate_hex, DEVELOPMENT_PACKAGE_ROOT,
    DEVELOPMENT_PROVENANCE_PATH, DEVELOPMENT_RECEIPT_PATH, MAX_EVIDENCE_BYTES,
};
#[cfg(target_os = "linux")]
use sha2::{Digest, Sha256};

#[cfg(target_os = "linux")]
const MAX_CONTROL_DOCUMENT_BYTES: u64 = 8 * 1024 * 1024;
#[cfg(target_os = "linux")]
const MAX_PACKAGE_INVENTORY_BYTES: u64 = 16 * 1024 * 1024 * 1024;
#[cfg(target_os = "linux")]
use std::{collections::BTreeSet, io::Read, os::unix::fs::MetadataExt, path::PathBuf};

/// A proof valid only while the exact failed runtime owner lock remains held.
/// Its private fields prevent callers from substituting an arbitrary store ID.
pub struct FailedWorkerMaintenanceStorageAdmission<'a> {
    #[cfg(target_os = "linux")]
    request_id: String,
    #[cfg(target_os = "linux")]
    request_sha256: String,
    #[cfg(target_os = "linux")]
    expected_owner: RuntimeServiceOwnerDescriptor,
    #[cfg(target_os = "linux")]
    expected_reconciliation: FailedWorkerExitReconciliation,
    #[cfg(target_os = "linux")]
    candidate_receipt_path: PathBuf,
    #[cfg(target_os = "linux")]
    candidate_receipt_sha256: String,
    owner_guard: &'a RuntimeServiceOwnerLockGuard,
}

impl<'a> FailedWorkerMaintenanceStorageAdmission<'a> {
    /// Authenticate both retained and candidate builds for this exact request.
    /// This does not open a service, execute a solver, or mutate store state.
    pub fn admit(
        store_root: &Path,
        request_id: &str,
        expected_owner: &RuntimeServiceOwnerDescriptor,
        reconciliation: &FailedWorkerExitReconciliation,
        request_sha256: &str,
        candidate_receipt_path: &Path,
        candidate_receipt_sha256: &str,
        owner_guard: &'a RuntimeServiceOwnerLockGuard,
    ) -> Result<Self> {
        #[cfg(target_os = "linux")]
        {
            let admission = Self {
                request_id: request_id.to_owned(),
                request_sha256: request_sha256.to_owned(),
                expected_owner: expected_owner.clone(),
                expected_reconciliation: reconciliation.clone(),
                candidate_receipt_path: candidate_receipt_path.to_path_buf(),
                candidate_receipt_sha256: candidate_receipt_sha256.to_owned(),
                owner_guard,
            };
            admission.validate_for(store_root, reconciliation)?;
            Ok(admission)
        }
        #[cfg(not(target_os = "linux"))]
        {
            let _ = (
                store_root,
                request_id,
                expected_owner,
                reconciliation,
                request_sha256,
                candidate_receipt_path,
                candidate_receipt_sha256,
                owner_guard,
            );
            bail!("failed-worker cross-build admission requires Linux native storage")
        }
    }

    /// Repeat admission while ledger/store writers are held; no nested writer
    /// or owner locks are acquired here. The local release may already exist.
    pub(crate) fn validate_for(
        &self,
        store_root: &Path,
        reconciliation: &FailedWorkerExitReconciliation,
    ) -> Result<String> {
        #[cfg(target_os = "linux")]
        {
            self.validate_linux(store_root, reconciliation)
        }
        #[cfg(not(target_os = "linux"))]
        {
            let _ = (store_root, reconciliation, self.owner_guard);
            bail!("failed-worker cross-build admission requires Linux native storage")
        }
    }
}

#[cfg(target_os = "linux")]
impl FailedWorkerMaintenanceStorageAdmission<'_> {
    fn validate_linux(
        &self,
        root: &Path,
        request: &FailedWorkerExitReconciliation,
    ) -> Result<String> {
        use crate::runtime_service::{
            validate_descriptor, RuntimeServiceState, RUNTIME_SERVICE_OWNER_DESCRIPTOR_PATH,
        };
        if root != Path::new("/state/runs/docker-all/session-store") {
            bail!("maintenance storage root differs from the exact Docker session store");
        }
        self.owner_guard.validate_store_binding(root)?;
        validate_descriptor(&self.expected_owner)?;
        if self.expected_owner.state != RuntimeServiceState::Failed
            || self.expected_owner.target_id != "docker-all"
            || request != &self.expected_reconciliation
        {
            bail!("maintenance owner or failed-worker request scope differs");
        }
        let request_path =
            request_path_for_receipt(&self.candidate_receipt_path, &self.request_id)?;
        validate_hex(&self.request_sha256, 64, "maintenance request SHA-256")?;
        validate_hex(
            &self.candidate_receipt_sha256,
            64,
            "maintenance candidate receipt SHA-256",
        )?;
        let request_raw = read_stable_regular(&request_path, MAX_CONTROL_DOCUMENT_BYTES)?;
        if sha256_hex(&request_raw) != self.request_sha256 {
            bail!("maintenance request bytes changed");
        }
        let doc: serde_json::Value = serde_json::from_slice(&request_raw)?;
        if doc["schema_version"] != "runtime_service_failed_worker_exit_reconciliation_request.v1"
            || doc["request_id"] != self.request_id
            || serde_json::from_value::<RuntimeServiceOwnerDescriptor>(
                doc["expected_owner"].clone(),
            )? != self.expected_owner
            || serde_json::from_value::<FailedWorkerExitReconciliation>(
                doc["reconciliation"].clone(),
            )? != *request
        {
            bail!("maintenance request content differs from its admitted scope");
        }
        let owner_raw = read_stable_regular(
            &root.join(RUNTIME_SERVICE_OWNER_DESCRIPTOR_PATH),
            MAX_EVIDENCE_BYTES,
        )?;
        validate_owner_evidence(&doc, &owner_raw, &self.expected_owner)?;

        // The same Linux host, engine, image, mount, probe and owner checks
        // still apply. Only the subsequent executable identity differs.
        let host = linux_native_host_admission(root)?;
        let historical_commit = self
            .expected_owner
            .build_commit
            .as_deref()
            .context("failed owner has no historical build commit")?;
        let historical_snapshot = self
            .expected_owner
            .build_snapshot
            .as_deref()
            .context("failed owner has no historical build snapshot")?;
        let provenance_path = Path::new(DEVELOPMENT_PROVENANCE_PATH);
        let historical_receipt_path = Path::new(DEVELOPMENT_RECEIPT_PATH);
        let provenance_before = read_stable_regular(provenance_path, MAX_EVIDENCE_BYTES)?;
        let receipt_before = read_stable_regular(historical_receipt_path, MAX_EVIDENCE_BYTES)?;
        let historical_binary =
            Path::new(DEVELOPMENT_PACKAGE_ROOT).join("bin/fullmag-runtime-service");
        let (_, historical_sha, _) =
            hash_stable_regular(&historical_binary, 16 * 1024 * 1024 * 1024)?;
        validate_development_runtime_identity_for(
            &host.delegation,
            historical_commit,
            Some(historical_snapshot),
            &historical_binary,
            &historical_sha,
        )?;
        if read_stable_regular(provenance_path, MAX_EVIDENCE_BYTES)? != provenance_before
            || read_stable_regular(historical_receipt_path, MAX_EVIDENCE_BYTES)? != receipt_before
        {
            bail!("historical runtime evidence changed during maintenance admission");
        }

        let control_receipt =
            read_stable_regular(&self.candidate_receipt_path, MAX_CONTROL_DOCUMENT_BYTES)?;
        if sha256_hex(&control_receipt) != self.candidate_receipt_sha256 {
            bail!("immutable candidate receipt digest changed");
        }
        let package = Path::new("/build/maintenance")
            .join(&self.request_id)
            .join("package");
        let package_receipt = read_stable_regular(
            &package.join("backend-build-receipt.json"),
            MAX_CONTROL_DOCUMENT_BYTES,
        )?;
        if package_receipt != control_receipt {
            bail!("candidate package receipt differs from the control receipt");
        }
        let receipt: serde_json::Value = serde_json::from_slice(&control_receipt)?;
        let source_raw = read_stable_regular(
            &request_path.with_file_name("source.json"),
            MAX_CONTROL_DOCUMENT_BYTES,
        )?;
        let operation_raw = read_stable_regular(
            &request_path.with_file_name("operation.json"),
            MAX_CONTROL_DOCUMENT_BYTES,
        )?;
        let source: serde_json::Value = serde_json::from_slice(&source_raw)?;
        let operation: serde_json::Value = serde_json::from_slice(&operation_raw)?;
        let relative_request = request_path
            .strip_prefix("/opt/fullmag/control")?
            .to_str()
            .context("maintenance request path is not UTF-8")?;
        let activation = relative_request
            .split('/')
            .nth(2)
            .context("maintenance activation is missing")?;
        let group = std::env::var("FULLMAG_COMPOSE_PROJECT")
            .context("maintenance Compose group missing")?;
        validate_operation_bindings(
            &source,
            &operation,
            &receipt,
            OperationPins {
                request_id: &self.request_id,
                request_sha256: &self.request_sha256,
                relative_request,
                activation,
                group: &group,
                run_id: &request.expected_lease.run_id,
                task_id: &request.expected_lease.task_id,
                receipt_id: &request.expected_receipt.receipt_id,
            },
        )?;
        let compiled_commit = option_env!("FULLMAG_SOURCE_GIT_COMMIT")
            .context("maintenance compiled source commit missing")?;
        let compiled_snapshot = option_env!("FULLMAG_SOURCE_SNAPSHOT_SHA256")
            .context("maintenance compiled source snapshot missing")?;
        let toolchain = std::env::var("FULLMAG_TOOLCHAIN_IMAGE_ID")
            .context("maintenance toolchain identity missing")?;
        validate_candidate_receipt(&receipt, compiled_commit, compiled_snapshot, &toolchain)?;
        let binary = verify_inventory(&package, &receipt)?;
        let current = std::env::current_exe().context("resolve maintenance executable")?;
        if current != binary {
            bail!("current executable is outside the exact candidate package");
        }
        let running = std::fs::metadata("/proc/self/exe")?;
        let candidate = std::fs::symlink_metadata(&binary)?;
        if !candidate.is_file()
            || candidate.nlink() != 1
            || running.dev() != candidate.dev()
            || running.ino() != candidate.ino()
        {
            bail!("running executable differs from the attested candidate inode");
        }
        Ok(format!(
            "sha256:{}",
            crate::canonical_json_sha256(&host.identity)
        ))
    }
}

#[cfg(target_os = "linux")]
fn validate_owner_evidence(
    request: &serde_json::Value,
    owner_raw: &[u8],
    expected_owner: &RuntimeServiceOwnerDescriptor,
) -> Result<()> {
    if request["owner_sha256"] != sha256_hex(owner_raw)
        || serde_json::from_slice::<RuntimeServiceOwnerDescriptor>(owner_raw)? != *expected_owner
    {
        bail!("failed runtime owner bytes or descriptor changed");
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn request_path_for_receipt(path: &Path, request_id: &str) -> Result<PathBuf> {
    let uuid = uuid::Uuid::parse_str(request_id)?;
    if uuid.is_nil() || uuid.to_string() != request_id {
        bail!("maintenance request ID must be a canonical nonzero UUID");
    }
    let prefix = Path::new("/opt/fullmag/control/activation/attempts");
    let tail = path
        .strip_prefix(prefix)
        .context("candidate receipt is outside activation control")?;
    let parts: Vec<_> = tail.components().collect();
    use std::path::Component;
    if parts.len() != 4 {
        bail!("candidate receipt scope has an invalid depth");
    }
    let attempt = match parts[0] {
        Component::Normal(x) => x.to_str().context("invalid attempt")?,
        _ => bail!("invalid activation attempt"),
    };
    if attempt.len() != 32
        || !attempt
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        || parts[1] != Component::Normal("failed-worker-reconciliation".as_ref())
        || parts[2] != Component::Normal(request_id.as_ref())
        || parts[3] != Component::Normal("candidate-receipt.json".as_ref())
    {
        bail!("candidate receipt does not belong to this activation and request");
    }
    let exact = prefix
        .join(attempt)
        .join("failed-worker-reconciliation")
        .join(request_id)
        .join("candidate-receipt.json");
    if path.as_os_str() != exact.as_os_str() {
        bail!("candidate receipt path is not canonical");
    }
    Ok(exact.with_file_name("request.json"))
}

#[cfg(target_os = "linux")]
#[derive(Clone, Copy)]
struct OperationPins<'a> {
    request_id: &'a str,
    request_sha256: &'a str,
    relative_request: &'a str,
    activation: &'a str,
    group: &'a str,
    run_id: &'a str,
    task_id: &'a str,
    receipt_id: &'a str,
}

#[cfg(target_os = "linux")]
fn validate_operation_bindings(
    source: &serde_json::Value,
    operation: &serde_json::Value,
    candidate: &serde_json::Value,
    pins: OperationPins<'_>,
) -> Result<()> {
    if source["schema"] != "fullmag.docker-failed-worker-reconciliation-source.v1"
        || source["operation_id"] != pins.request_id
        || source["manifest_path"]
            != format!(
                "/build/maintenance/{}/source-capture/.fullmag-live-source/manifest.json",
                pins.request_id
            )
        || operation["schema"] != "fullmag.docker-failed-worker-reconciliation.v1"
        || operation["state"] != "request-published"
        || operation["operation_id"] != pins.request_id
        || operation["activation_attempt"] != pins.activation
        || operation["compose_project"] != pins.group
        || operation["request_path"] != pins.relative_request
        || operation["request_sha256"] != pins.request_sha256
        || operation["native_scope"]["run_id"] != pins.run_id
        || operation["native_scope"]["task_id"] != pins.task_id
        || operation["native_scope"]["receipt_id"] != pins.receipt_id
    {
        bail!("maintenance operation or source record differs from the exact request");
    }
    for key in [
        "resolved_commit",
        "source_digest",
        "source_snapshot_sha256",
        "live_manifest_sha256",
    ] {
        let identity = source["source_identity"][key]
            .as_str()
            .context("maintenance source identity missing")?;
        validate_hex(
            identity,
            if key == "resolved_commit" { 40 } else { 64 },
            "maintenance source identity",
        )?;
        if operation["source_identity"][key] != identity || candidate["source"][key] != identity {
            bail!("maintenance candidate source does not match its captured operation: {key}");
        }
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn validate_candidate_receipt(
    receipt: &serde_json::Value,
    commit: &str,
    snapshot: &str,
    toolchain: &str,
) -> Result<()> {
    validate_hex(commit, 40, "maintenance compiled commit")?;
    validate_hex(snapshot, 64, "maintenance compiled snapshot")?;
    let digest = toolchain
        .strip_prefix("sha256:")
        .context("candidate toolchain image ID is invalid")?;
    validate_hex(digest, 64, "candidate toolchain digest")?;
    if receipt["schema"] != "fullmag.direct-compose.backend-build-receipt.v1"
        || receipt["state"] != "succeeded"
        || receipt["source"]["source_mode"] != "live-shadow-v1"
        || receipt["source"]["resolved_commit"] != commit
        || receipt["source"]["source_snapshot_sha256"] != snapshot
        || receipt["build"]["cargo_profile"] != "backend-dev"
        || receipt["toolchain"]["image_id"] != toolchain
        || receipt["native_source_identity"]["head_commit_full"] != commit
        || receipt["native_source_identity"]["source_snapshot_sha256"] != snapshot
    {
        bail!("candidate receipt build/source identity differs from the maintenance executable");
    }
    let native = &receipt["native_source_identity"];
    if !native.is_object() {
        bail!("candidate receipt has no native source identity");
    }
    let mut canonical = crate::canonical_json_bytes(native);
    canonical.push(b'\n');
    if receipt["native_source_identity_sha256"] != sha256_hex(&canonical) {
        bail!("candidate native source identity digest differs");
    }
    let lanes = receipt["execution_lanes"]
        .as_object()
        .context("candidate execution lanes missing")?;
    let expected: BTreeSet<_> = ["fdm-cpu", "fdm-gpu", "fem-cpu", "fem-gpu"]
        .into_iter()
        .collect();
    if lanes.keys().map(String::as_str).collect::<BTreeSet<_>>() != expected {
        bail!("candidate receipt does not attest the four execution lanes");
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn verify_inventory(package: &Path, receipt: &serde_json::Value) -> Result<PathBuf> {
    let artifacts = receipt["artifacts"]
        .as_array()
        .context("candidate artifact inventory missing")?;
    if artifacts.is_empty() || artifacts.len() > 256 {
        bail!("candidate artifact inventory is outside its bound");
    }
    let mut seen = BTreeSet::new();
    let mut total_expected = 0u64;
    let binary = package.join("bin/fullmag-runtime-service");
    for item in artifacts {
        let path = item["path"]
            .as_str()
            .context("candidate artifact path missing")?;
        let relative = Path::new(path);
        if path.is_empty()
            || relative.is_absolute()
            || !relative
                .components()
                .all(|part| matches!(part, std::path::Component::Normal(_)))
            || relative.components().collect::<PathBuf>().as_os_str() != relative.as_os_str()
            || !seen.insert(path)
        {
            bail!("candidate artifact path is unsafe or repeated");
        }
        let expected_size = item["size"]
            .as_u64()
            .context("candidate artifact size missing")?;
        total_expected = total_expected
            .checked_add(expected_size)
            .context("candidate inventory size overflow")?;
        if total_expected > MAX_PACKAGE_INVENTORY_BYTES {
            bail!("candidate artifact inventory exceeds its total size bound");
        }
        let expected_sha = item["sha256"]
            .as_str()
            .context("candidate artifact SHA missing")?;
        validate_hex(expected_sha, 64, "candidate artifact SHA-256")?;
        let mode = item["mode"]
            .as_str()
            .context("candidate artifact mode missing")?;
        if !matches!(mode, "100644" | "100755") {
            bail!("candidate artifact mode is unsupported");
        }
        let (size, sha, executable) =
            hash_stable_regular(&package.join(relative), 16 * 1024 * 1024 * 1024)?;
        if size != expected_size || sha != expected_sha || executable != (mode == "100755") {
            bail!("candidate artifact bytes or metadata differ from receipt: {path}");
        }
    }
    if !seen.contains("bin/fullmag-runtime-service") {
        bail!("candidate receipt does not attest runtime-service");
    }
    verify_package_tree(package, &seen)?;
    Ok(binary)
}

// Mirror the existing image-owned package tree gate. Extra files are limited
// to metadata and the legacy launcher; none is used to execute maintenance.
#[cfg(target_os = "linux")]
fn verify_package_tree(package: &Path, artifacts: &BTreeSet<&str>) -> Result<()> {
    let mut required: BTreeSet<PathBuf> =
        artifacts.iter().map(|path| PathBuf::from(*path)).collect();
    required.insert(PathBuf::from("backend-build-receipt.json"));
    let mut allowed = required.clone();
    allowed.extend(
        [
            ".candidate-owner.json",
            "bin/fullmag",
            "direct-backend-build.log",
            "install-cli-build.log",
            "install-cli-managed-fem-gpu.log",
            "source-identity.json",
        ]
        .into_iter()
        .map(PathBuf::from),
    );
    let mut allowed_dirs = BTreeSet::new();
    for path in &allowed {
        let mut parent = path.parent();
        while let Some(directory) = parent {
            if directory.as_os_str().is_empty() {
                break;
            }
            allowed_dirs.insert(directory.to_path_buf());
            parent = directory.parent();
        }
    }
    let mut stack = vec![PathBuf::new()];
    let mut found = BTreeSet::new();
    let mut entries = 0usize;
    while let Some(directory) = stack.pop() {
        for entry in std::fs::read_dir(package.join(&directory))? {
            entries += 1;
            if entries > 1024 {
                bail!("candidate package tree exceeds its entry bound");
            }
            let entry = entry?;
            let relative = directory.join(entry.file_name());
            if relative.components().count() > 16 {
                bail!("candidate package tree exceeds its depth bound");
            }
            let metadata = std::fs::symlink_metadata(entry.path())?;
            if metadata.is_dir() {
                if !allowed_dirs.contains(&relative) {
                    bail!("candidate package contains an unattested directory");
                }
                stack.push(relative);
            } else if metadata.is_file() {
                if metadata.nlink() != 1 || !allowed.contains(&relative) {
                    bail!("candidate package contains an unattested or linked file");
                }
                found.insert(relative);
            } else {
                bail!("candidate package contains a link or special file");
            }
        }
    }
    if !required.is_subset(&found) {
        bail!("candidate package tree is missing an attested file");
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn metadata_signature(meta: &std::fs::Metadata) -> (u64, u64, u32, u64, u64, i64, i64, i64, i64) {
    (
        meta.dev(),
        meta.ino(),
        meta.mode(),
        meta.nlink(),
        meta.len(),
        meta.mtime(),
        meta.mtime_nsec(),
        meta.ctime(),
        meta.ctime_nsec(),
    )
}

#[cfg(target_os = "linux")]
fn hash_stable_regular(path: &Path, maximum: u64) -> Result<(u64, String, bool)> {
    let mut file = open_regular_nofollow(path)?;
    let before = file.metadata()?;
    if before.nlink() != 1 || before.len() == 0 || before.len() > maximum {
        bail!(
            "maintenance evidence file has unsafe link count or size: {}",
            path.display()
        );
    }
    let mut hasher = Sha256::new();
    let mut total = 0u64;
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let n = file.read(&mut buffer)?;
        if n == 0 {
            break;
        }
        total = total
            .checked_add(n as u64)
            .context("evidence size overflow")?;
        if total > maximum {
            bail!("maintenance evidence exceeds its size bound");
        }
        hasher.update(&buffer[..n]);
    }
    let after = file.metadata()?;
    if metadata_signature(&before) != metadata_signature(&after) || total != before.len() {
        bail!(
            "maintenance evidence changed during hashing: {}",
            path.display()
        );
    }
    Ok((
        total,
        format!("{:x}", hasher.finalize()),
        before.mode() & 0o111 != 0,
    ))
}

#[cfg(target_os = "linux")]
fn read_stable_regular(path: &Path, maximum: u64) -> Result<Vec<u8>> {
    let mut file = open_regular_nofollow(path)?;
    let before = file.metadata()?;
    if before.nlink() != 1 || before.len() > maximum {
        bail!("maintenance document exceeds its bounds or has multiple links");
    }
    let mut raw = Vec::new();
    file.by_ref().take(maximum + 1).read_to_end(&mut raw)?;
    let after = file.metadata()?;
    if metadata_signature(&before) != metadata_signature(&after)
        || raw.len() as u64 != before.len()
        || raw.len() as u64 > maximum
    {
        bail!(
            "maintenance document changed during read: {}",
            path.display()
        );
    }
    Ok(raw)
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;
    use std::{fs, os::unix::fs::PermissionsExt};

    #[test]
    fn failed_owner_raw_hash_and_descriptor_must_both_match() {
        let now = chrono::Utc::now();
        let owner = RuntimeServiceOwnerDescriptor {
            schema_version: "runtime_service_owner.v1".into(),
            owner_token: "22222222-2222-4222-8222-222222222222".into(),
            process_start_token: "33333333-3333-4333-8333-333333333333".into(),
            pid: 123,
            host: "host".into(),
            target_id: "docker-all".into(),
            protocol: "stdin-v1".into(),
            state: crate::runtime_service::RuntimeServiceState::Failed,
            acquired_at: now,
            heartbeat_at: now,
            compute_pool_generation: None,
            preparation_pool_generation: None,
            control_address: None,
            build_commit: Some("a".repeat(40)),
            build_snapshot: Some("b".repeat(64)),
            compute_pool_id: None,
            preparation_pool_id: None,
            children: vec![],
        };
        let raw = serde_json::to_vec(&owner).unwrap();
        let mut request = serde_json::json!({"owner_sha256":sha256_hex(&raw)});
        assert!(validate_owner_evidence(&request, &raw, &owner).is_ok());
        let mut changed = owner.clone();
        changed.owner_token = "44444444-4444-4444-8444-444444444444".into();
        let changed_raw = serde_json::to_vec(&changed).unwrap();
        assert!(validate_owner_evidence(&request, &changed_raw, &owner).is_err());
        request["owner_sha256"] = sha256_hex(&changed_raw).into();
        assert!(validate_owner_evidence(&request, &changed_raw, &owner).is_err());
    }

    #[test]
    fn operation_request_relative_path_matches_the_python_producer() {
        let attempt = "3a44611704e14f56b8dea45c1547f9ab";
        let id = "a744cb36-c8a0-4ca6-bb30-e1b0c50e32bc";
        let path = format!("/opt/fullmag/control/activation/attempts/{attempt}/failed-worker-reconciliation/{id}/request.json");
        let relative = Path::new(&path)
            .strip_prefix("/opt/fullmag/control")
            .unwrap()
            .to_str()
            .unwrap();
        assert_eq!(
            relative,
            format!("activation/attempts/{attempt}/failed-worker-reconciliation/{id}/request.json")
        );
        assert_eq!(relative.split('/').nth(2), Some(attempt));
    }

    #[test]
    fn control_scope_requires_exact_activation_and_request() {
        let id = "a744cb36-c8a0-4ca6-bb30-e1b0c50e32bc";
        let path = format!("/opt/fullmag/control/activation/attempts/{}/failed-worker-reconciliation/{id}/candidate-receipt.json", "a".repeat(32));
        assert!(request_path_for_receipt(Path::new(&path), id).is_ok());
        assert!(
            request_path_for_receipt(Path::new(&path), "a744cb36-c8a0-4ca6-bb30-e1b0c50e32bd")
                .is_err()
        );
        assert!(request_path_for_receipt(
            Path::new(&path.replace("candidate-receipt.json", "../candidate-receipt.json")),
            id
        )
        .is_err());
        assert!(request_path_for_receipt(
            Path::new(&path.replace(&"a".repeat(32), &"g".repeat(32))),
            id
        )
        .is_err());
    }

    #[test]
    fn operation_binds_candidate_to_source_and_exact_request() {
        let id = "a744cb36-c8a0-4ca6-bb30-e1b0c50e32bc";
        let identity = serde_json::json!({"resolved_commit":"a".repeat(40),
            "source_digest":"b".repeat(64), "source_snapshot_sha256":"c".repeat(64),
            "live_manifest_sha256":"d".repeat(64)});
        let source = serde_json::json!({"schema":"fullmag.docker-failed-worker-reconciliation-source.v1",
            "operation_id":id, "manifest_path":format!("/build/maintenance/{id}/source-capture/.fullmag-live-source/manifest.json"),
            "source_identity":identity});
        let relative = format!(
            "activation/attempts/{}/failed-worker-reconciliation/{id}/request.json",
            "e".repeat(32)
        );
        let request_sha = "f".repeat(64);
        let activation = "e".repeat(32);
        let operation = serde_json::json!({"schema":"fullmag.docker-failed-worker-reconciliation.v1",
            "state":"request-published", "operation_id":id, "activation_attempt":activation,
            "compose_project":"project", "request_path":relative, "request_sha256":request_sha,
            "source_identity":identity, "native_scope":{"run_id":"run", "task_id":"task", "receipt_id":"receipt"}});
        let mut candidate = serde_json::json!({"source":identity});
        let pins = OperationPins {
            request_id: id,
            request_sha256: &request_sha,
            relative_request: &relative,
            activation: &activation,
            group: "project",
            run_id: "run",
            task_id: "task",
            receipt_id: "receipt",
        };
        assert!(validate_operation_bindings(&source, &operation, &candidate, pins).is_ok());
        candidate["source"]["source_digest"] = "9".repeat(64).into();
        assert!(validate_operation_bindings(&source, &operation, &candidate, pins).is_err());
        assert!(validate_operation_bindings(
            &source,
            &operation,
            &serde_json::json!({"source":identity}),
            OperationPins {
                task_id: "other",
                ..pins
            }
        )
        .is_err());
    }

    #[test]
    fn inventory_checks_real_bytes_hardlinks_and_symlinks() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir(dir.path().join("bin")).unwrap();
        let binary = dir.path().join("bin/fullmag-runtime-service");
        fs::write(dir.path().join("backend-build-receipt.json"), b"{}").unwrap();
        fs::write(&binary, b"original").unwrap();
        fs::set_permissions(&binary, fs::Permissions::from_mode(0o755)).unwrap();
        let receipt = serde_json::json!({"artifacts": [{"path":"bin/fullmag-runtime-service", "size":8,
            "sha256":sha256_hex(b"original"), "mode":"100755"}]});
        assert_eq!(verify_inventory(dir.path(), &receipt).unwrap(), binary);
        fs::write(dir.path().join("bin/unattested.so"), b"extra").unwrap();
        assert!(verify_inventory(dir.path(), &receipt).is_err());
        fs::remove_file(dir.path().join("bin/unattested.so")).unwrap();
        fs::write(&binary, b"tampered").unwrap();
        assert!(verify_inventory(dir.path(), &receipt).is_err());
        fs::write(&binary, b"original").unwrap();
        fs::hard_link(&binary, dir.path().join("alias")).unwrap();
        assert!(verify_inventory(dir.path(), &receipt).is_err());
        fs::remove_file(dir.path().join("alias")).unwrap();
        fs::remove_file(&binary).unwrap();
        std::os::unix::fs::symlink("/dev/null", &binary).unwrap();
        assert!(verify_inventory(dir.path(), &receipt).is_err());
    }

    #[test]
    fn candidate_receipt_rejects_source_and_digest_drift() {
        let commit = "a".repeat(40);
        let snapshot = "b".repeat(64);
        let image = format!("sha256:{}", "c".repeat(64));
        let native =
            serde_json::json!({"head_commit_full":commit,"source_snapshot_sha256":snapshot});
        let mut bytes = crate::canonical_json_bytes(&native);
        bytes.push(b'\n');
        // Produced by the Python direct-compose canonical JSON recipe.
        assert_eq!(
            sha256_hex(&bytes),
            "ae209ffb148069fbe8126042eb1eb79585c11dabae43fc74ddf88429a9c44083"
        );
        let mut receipt = serde_json::json!({"schema":"fullmag.direct-compose.backend-build-receipt.v1",
            "state":"succeeded", "source":{"source_mode":"live-shadow-v1","resolved_commit":commit,"source_snapshot_sha256":snapshot},
            "build":{"cargo_profile":"backend-dev"}, "toolchain":{"image_id":image},
            "native_source_identity":native,"native_source_identity_sha256":sha256_hex(&bytes),
            "execution_lanes":{"fdm-cpu":{},"fdm-gpu":{},"fem-cpu":{},"fem-gpu":{}}});
        assert!(validate_candidate_receipt(&receipt, &commit, &snapshot, &image).is_ok());
        receipt["source"]["resolved_commit"] = "d".repeat(40).into();
        assert!(validate_candidate_receipt(&receipt, &commit, &snapshot, &image).is_err());
        receipt["source"]["resolved_commit"] = commit.clone().into();
        receipt["native_source_identity_sha256"] = "e".repeat(64).into();
        assert!(validate_candidate_receipt(&receipt, &commit, &snapshot, &image).is_err());
    }
}
