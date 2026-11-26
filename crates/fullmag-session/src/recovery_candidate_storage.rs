//! Explicit, request-scoped storage identity for one unpublished recovery tool.
//! No environment switch or ordinary store admission inherits this capability.
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
#[cfg(target_os = "linux")]
use sha2::{Digest, Sha256};
#[cfg(target_os = "linux")]
use std::io::Read;
use std::path::{Component, Path, PathBuf};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SucceededRecoveryCandidateStoragePins {
    pub marker_sha256: String,
    pub managed_terminal_path: PathBuf,
    pub managed_terminal_sha256: String,
    pub managed_result_path: PathBuf,
    pub managed_result_sha256: String,
}

/// Created only after validating the exact command request and ready managed build.
/// It authorizes identity lookup/release for that request, not general store access.
pub struct SucceededRecoveryCandidateStorage {
    root: PathBuf,
    config_path: PathBuf,
    request_path: PathBuf,
    request_sha256: String,
    pins: SucceededRecoveryCandidateStoragePins,
}

fn hex(value: &str, length: usize) -> bool {
    value.len() == length
        && value
            .bytes()
            .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

#[cfg(target_os = "linux")]
fn document(path: &Path, expected: &str) -> Result<Value> {
    if !hex(expected, 64) {
        bail!("candidate storage evidence pin is invalid");
    }
    let raw = crate::docker_desktop_storage::read_bounded_regular_file(path, 8 * 1024 * 1024)?;
    if crate::hex_sha256(&raw) != expected {
        bail!("candidate storage evidence changed: {}", path.display());
    }
    Ok(serde_json::from_slice(&raw)?)
}

impl SucceededRecoveryCandidateStorage {
    #[cfg(target_os = "linux")]
    pub fn validate(
        root: &Path,
        config_path: &Path,
        request_path: &Path,
        request_sha256: &str,
        pins: SucceededRecoveryCandidateStoragePins,
    ) -> Result<Self> {
        // Root is fixed by the pinned runtime config; never accept a relative alias.
        if !root.is_absolute() || !config_path.is_absolute() || !request_path.is_absolute() {
            bail!("candidate recovery storage paths must be absolute");
        }
        let capability = Self {
            root: root.to_path_buf(),
            config_path: config_path.to_path_buf(),
            request_path: request_path.to_path_buf(),
            request_sha256: request_sha256.into(),
            pins,
        };
        capability.store_id(root)?;
        Ok(capability)
    }

    #[cfg(not(target_os = "linux"))]
    pub fn validate(
        _: &Path,
        _: &Path,
        _: &Path,
        _: &str,
        _: SucceededRecoveryCandidateStoragePins,
    ) -> Result<Self> {
        bail!("candidate recovery storage requires the attested Linux container");
    }

    pub fn store_id(&self, root: &Path) -> Result<String> {
        if root != self.root {
            bail!("candidate storage capability belongs to another root");
        }
        #[cfg(target_os = "linux")]
        {
            let value = crate::docker_desktop_storage::linux_native_store_identity_with_candidate(
                root,
                Some(self),
            )?;
            Ok(format!("sha256:{}", crate::canonical_json_sha256(&value)))
        }
        #[cfg(not(target_os = "linux"))]
        {
            bail!("candidate recovery storage requires Linux");
        }
    }

    pub(crate) fn authorize_release(
        &self,
        root: &Path,
        run_id: &str,
        receipt_id: &str,
    ) -> Result<String> {
        let store_id = self.store_id(root)?;
        #[cfg(target_os = "linux")]
        {
            let request = document(&self.request_path, &self.request_sha256)?;
            if request["schema_version"] != "runtime_service_succeeded_worker_release.v1"
                || request["identity"]["run_id"] != run_id
                || request["exit_receipt_id"] != receipt_id
                || request["identity"]["store_id"] != store_id
            {
                bail!("candidate storage capability does not authorize this release");
            }
        }
        Ok(store_id)
    }

    pub(crate) fn authorize_succeeded_namespace(
        &self, root: &Path, teardown: &crate::SucceededWorkerNamespaceTeardownRequest,
    ) -> Result<String> {
        let store_id = self.store_id(root)?;
        #[cfg(target_os = "linux")]
        {
            let request = document(&self.request_path, &self.request_sha256)?;
            if request["schema_version"] != "runtime_service_succeeded_namespace_recovery.v1"
                || request["teardown"] != serde_json::to_value(teardown)?
                || teardown.identity.store_id != store_id
            {
                bail!("candidate storage capability does not authorize this namespace release");
            }
        }
        Ok(store_id)
    }

    #[cfg(target_os = "linux")]
    pub(crate) fn validate_runtime_identity(
        &self,
        group: &str,
        toolchain_image: &str,
        expected_commit: &str,
    ) -> Result<()> {
        let request = document(&self.request_path, &self.request_sha256)?;
        let namespace = request["schema_version"] == "runtime_service_succeeded_namespace_recovery.v1";
        if (!namespace && request["schema_version"] != "runtime_service_succeeded_worker_release.v1")
            || request["candidate_storage"] != serde_json::to_value(&self.pins)?
        {
            bail!("candidate storage requires its exact succeeded-worker request");
        }
        let teardown = if namespace {
            let value: crate::SucceededWorkerNamespaceTeardownRequest = serde_json::from_value(request["teardown"].clone())?;
            value.validate()?;
            if value.config_sha256 != request["config_sha256"].as_str().unwrap_or("")
                || request["request_id"] != value.request_id
            { bail!("candidate namespace wrapper differs from its exact teardown request"); }
            Some(value)
        } else { None };
        let config_pin = request["config_sha256"]
            .as_str()
            .context("candidate request config pin missing")?;
        let config = document(&self.config_path, config_pin)?;
        if config["store_root"].as_str() != self.root.to_str() {
            bail!("candidate storage root differs from the pinned runtime config");
        }
        let executable = std::env::current_exe()?;
        let package = executable
            .parent()
            .and_then(Path::parent)
            .context("candidate executable root missing")?;
        let parent = Path::new("/opt/fullmag/package/.development/candidates");
        let name = package.file_name().and_then(|v| v.to_str()).unwrap_or("");
        let suffix = name
            .strip_prefix(".backend-package-candidate-")
            .unwrap_or("");
        if package.parent() != Some(parent)
            || suffix.is_empty()
            || !suffix
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
            || executable != package.join("bin/fullmag-runtime-service")
        {
            bail!("candidate recovery executable is outside the canonical candidate namespace");
        }
        let marker = document(
            &package.join(".candidate-owner.json"),
            &self.pins.marker_sha256,
        )?;
        let receipt_pin = request["package_receipt_sha256"]
            .as_str()
            .context("candidate package pin missing")?;
        let receipt = document(&package.join("backend-build-receipt.json"), receipt_pin)?;
        let terminal_path = &self.pins.managed_terminal_path;
        let attempt = terminal_path
            .parent()
            .context("candidate managed attempt path missing")?;
        if attempt.parent() != Some(Path::new("/opt/fullmag/control/recovery-build/attempts"))
            || !attempt
                .file_name()
                .and_then(|v| v.to_str())
                .is_some_and(|v| hex(v, 32))
            || terminal_path != &attempt.join("terminal.json")
            || self.pins.managed_result_path != attempt.join("result.json")
        {
            bail!("candidate managed evidence is outside the exact recovery attempt");
        }
        let terminal = document(terminal_path, &self.pins.managed_terminal_sha256)?;
        if terminal["attempt"].as_str() != attempt.file_name().and_then(|v| v.to_str()) {
            bail!("candidate managed terminal attempt differs from its path");
        }
        let result = document(
            &self.pins.managed_result_path,
            &self.pins.managed_result_sha256,
        )?;
        let proof_path = Path::new(
            terminal["inputs"]["succeeded_worker_proof"]
                .as_str()
                .context("candidate succeeded-worker proof missing")?,
        );
        if !proof_path.starts_with("/opt/fullmag/control/verification") {
            bail!("candidate succeeded-worker proof is outside the group control volume");
        }
        let proof = document(
            proof_path,
            terminal["inputs"]["succeeded_worker_proof_sha256"]
                .as_str()
                .context("candidate succeeded-worker proof pin missing")?,
        )?;
        let identity = if namespace { &request["teardown"]["identity"] } else { &request["identity"] };
        let expected_proof_schema = if namespace { "fullmag.succeeded-namespace-build-proof.v1" }
            else { "fullmag.succeeded-worker-build-proof.v1" };
        if proof["schema"] != expected_proof_schema
            || proof["run_id"] != identity["run_id"]
            || proof["task_id"] != identity["task_id"]
            || proof["store_id"] != identity["store_id"]
            || proof["lease_token"] != identity["lease_token"]
            || proof["attempt_id"] != request["claim"]["attempt_id"]
            || proof["ownership_epoch"] != request["claim"]["ownership_epoch"]
            || proof["lease_heartbeat_sequence"] != request["claim"]["lease"]["heartbeat_sequence"]
        {
            bail!("candidate managed build authorized a different succeeded worker");
        }
        if let Some(teardown) = &teardown {
            if proof["teardown_request_sha256"] != teardown.request_sha256()? {
                bail!("candidate managed build authorized a different namespace teardown");
            }
        }
        let source_root = std::env::var("FULLMAG_SOURCE_HOST_ROOT")
            .context("candidate source host root missing")?;
        let runtime_image =
            std::env::var("FULLMAG_RUNTIME_IMAGE_ID").context("candidate runtime image missing")?;
        validate_documents(
            &marker,
            &receipt,
            &terminal,
            &result,
            &request,
            package,
            group,
            toolchain_image,
            &runtime_image,
            expected_commit,
            &source_root,
        )?;
        let snapshot = request["source_snapshot_sha256"]
            .as_str()
            .context("candidate snapshot missing")?;
        if option_env!("FULLMAG_SOURCE_SNAPSHOT_SHA256") != Some(snapshot) {
            bail!("candidate storage snapshot differs from the compiled tool");
        }
        let hostname_bytes = crate::docker_desktop_storage::read_bounded_regular_file(
            Path::new("/etc/hostname"),
            4096,
        )?;
        let hostname =
            std::str::from_utf8(&hostname_bytes).context("candidate hostname is not UTF-8")?;
        let container = terminal["inputs"]["backend_container_id"]
            .as_str()
            .context("candidate container pin missing")?;
        let mountinfo = crate::docker_desktop_storage::read_bounded_regular_file(
            &PathBuf::from(format!("/proc/{}/mountinfo", std::process::id())),
            1024 * 1024,
        )?;
        if let Some(teardown) = &teardown {
            let execution_container = request["execution_container_id"].as_str().context("candidate namespace execution CID missing")?;
            let execution_namespace = request["execution_pid_namespace"].as_str().context("candidate execution namespace missing")?;
            if std::fs::read_link("/proc/self/ns/pid")?.to_str() != Some(execution_namespace)
                || container != teardown.old_container_id
            { bail!("candidate namespace build or execution context differs"); }
            if execution_container == container {
                if execution_namespace != teardown.pid_namespace
                    || request.get("attestation_path").is_some_and(|v| !v.is_null())
                    || request.get("attestation_sha256").is_some_and(|v| !v.is_null())
                { bail!("candidate original namespace context differs"); }
                validate_container_binding(execution_container, hostname.trim(),
                    request["expected_owner"]["host"].as_str().context("candidate original owner host missing")?,
                    std::str::from_utf8(&mountinfo)?)?;
            } else {
                let path = Path::new(request["attestation_path"].as_str().context("candidate recreated namespace requires Engine attestation path")?);
                if !path.starts_with("/opt/fullmag/control/verification") {
                    bail!("candidate namespace attestation is outside its group control volume");
                }
                let value = document(path, request["attestation_sha256"].as_str().context("candidate namespace attestation pin missing")?)?;
                let attestation: crate::SucceededWorkerNamespaceTeardownAttestation = serde_json::from_value(value)?;
                let intent = crate::SucceededWorkerNamespaceTeardownIntent::from_request(teardown.clone())?;
                attestation.validate_for_request(teardown, &intent.sha256()?)?;
                if attestation.new_container_id != execution_container || attestation.new_pid_namespace != execution_namespace {
                    bail!("candidate recreated namespace differs from its pinned Engine removal attestation");
                }
                validate_container_binding(execution_container, hostname.trim(), hostname.trim(), std::str::from_utf8(&mountinfo)?)?;
            }
        } else {
            validate_container_binding(
                container, hostname.trim(),
                request["expected_owner"]["host"].as_str().context("candidate owner host missing")?,
                std::str::from_utf8(&mountinfo).context("candidate mountinfo is not UTF-8")?,
            )?;
        }
        let artifacts = receipt["artifacts"]
            .as_array()
            .context("candidate artifacts missing")?;
        let mut paths = std::collections::BTreeSet::new();
        if artifacts.is_empty() || artifacts.len() > 16_384 {
            bail!("candidate artifact inventory is empty or oversized");
        }
        let mut total_bytes = 0u64;
        for artifact in artifacts {
            let relative = Path::new(
                artifact["path"]
                    .as_str()
                    .context("candidate artifact path missing")?,
            );
            if relative.as_os_str().is_empty()
                || !relative
                    .components()
                    .all(|c| matches!(c, Component::Normal(_)))
                || !paths.insert(relative.to_path_buf())
            {
                bail!("candidate artifact path is unsafe or duplicated");
            }
            let path = package.join(relative);
            let size = artifact["size"]
                .as_u64()
                .context("candidate artifact size missing")?;
            total_bytes = total_bytes
                .checked_add(size)
                .context("candidate artifact size overflow")?;
            if size > 8 * 1024 * 1024 * 1024
                || total_bytes > 32 * 1024 * 1024 * 1024
                || artifact["sha256"].as_str()
                    != Some(bounded_artifact_sha256(&path, size)?.as_str())
            {
                bail!("candidate artifact differs from its bounded ready inventory");
            }
        }
        if !paths.contains(Path::new("bin/fullmag-runtime-service"))
            || request["executable_sha256"].as_str()
                != Some(crate::docker_desktop_storage::stream_sha256(&executable)?.as_str())
        {
            bail!("candidate storage executable differs from its exact request");
        }
        Ok(())
    }
}

#[cfg(target_os = "linux")]
fn validate_container_binding(
    container: &str,
    hostname: &str,
    owner_host: &str,
    mountinfo: &str,
) -> Result<()> {
    if !hex(container, 64) || owner_host.is_empty() || hostname != owner_host {
        bail!("candidate managed build container or owner hostname differs");
    }
    let suffix = format!("/containers/{container}/hostname");
    let mut matches = 0;
    for line in mountinfo.lines() {
        let fields = line.split_whitespace().collect::<Vec<_>>();
        let separator = fields
            .iter()
            .position(|field| *field == "-")
            .context("candidate mountinfo separator missing")?;
        if separator < 6
            || fields.len() != separator + 4
            || fields[0].parse::<u64>().is_err()
            || fields[1].parse::<u64>().is_err()
        {
            bail!("candidate mountinfo entry is malformed");
        }
        // This fixed mount target contains no escaped characters. The kernel
        // escapes other paths; escaped aliases must not match the exact target.
        if fields[4] != "/etc/hostname" {
            continue;
        }
        matches += 1;
        if !fields[3].ends_with(&suffix) || !fields[5].split(',').any(|option| option == "ro") {
            bail!("candidate hostname mount does not identify the exact backend container");
        }
    }
    if matches != 1 {
        bail!("candidate requires exactly one kernel-bound hostname mount");
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn bounded_artifact_sha256(path: &Path, size: u64) -> Result<String> {
    let file = crate::docker_desktop_storage::open_regular_nofollow(path)?;
    if file.metadata()?.len() != size {
        bail!("candidate artifact length differs");
    }
    let mut reader = file.take(size.saturating_add(1));
    let mut digest = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    let mut count = 0u64;
    loop {
        let read = reader.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        count += read as u64;
        digest.update(&buffer[..read]);
    }
    if count != size {
        bail!("candidate artifact changed length during validation");
    }
    Ok(format!("{:x}", digest.finalize()))
}

#[cfg(target_os = "linux")]
fn validate_documents(
    marker: &Value,
    receipt: &Value,
    terminal: &Value,
    result: &Value,
    request: &Value,
    package: &Path,
    group: &str,
    toolchain_image: &str,
    runtime_image: &str,
    commit: &str,
    source_root: &str,
) -> Result<()> {
    let expected_marker_keys = [
        "artifact_inventory_sha256",
        "build_root",
        "candidate",
        "cargo_profile",
        "package_root",
        "schema",
        "state",
    ];
    if marker.as_object().map(|o| {
        o.keys()
            .map(String::as_str)
            .collect::<std::collections::BTreeSet<_>>()
    }) != Some(expected_marker_keys.into_iter().collect())
        || marker["schema"] != "fullmag.direct-compose.package-candidate.v1"
        || marker["state"] != "ready"
        || marker["candidate"].as_str() != package.to_str()
        || marker["build_root"] != "/build"
        || marker["package_root"] != "/opt/fullmag/package"
        || marker["cargo_profile"] != "backend-dev"
    {
        bail!("candidate storage requires the exact ready candidate marker");
    }
    let mut inventory = crate::canonical_json_bytes(&receipt["artifacts"]);
    inventory.push(b'\n');
    if marker["artifact_inventory_sha256"] != crate::hex_sha256(&inventory)
        || receipt["schema"] != "fullmag.direct-compose.backend-build-receipt.v1"
        || receipt["state"] != "succeeded"
        || receipt["build"]["cargo_profile"] != "backend-dev"
        || receipt["toolchain"]["image_id"] != toolchain_image
        || receipt["source"]["resolved_commit"] != commit
        || request["build_commit"] != commit
        || receipt["source"]["source_snapshot_sha256"] != request["source_snapshot_sha256"]
    {
        bail!("candidate storage package source, image or inventory differs");
    }
    if terminal["schema"] != "fullmag.docker-build-operation.v1"
        || terminal["phase"] != "recovery-build"
        || terminal["state"] != "succeeded"
        || terminal["compose_project"] != group
        || terminal["image_id"] != runtime_image
        || terminal["inputs"]["source_commit"] != commit
        || terminal["inputs"]["source_root"] != source_root
        || terminal["inputs"]["compose_project"] != group
        || terminal["inputs"]["image_id"] != runtime_image
        || terminal["inputs"]["owner_sha256"] != request["owner_sha256"]
        || terminal["inputs"]["process_receipt_sha256"] != request["process_receipt_sha256"]
        || terminal["inputs"]["diagnostic_api_only"] != true
        || terminal["candidate"] != *result
    {
        bail!("candidate storage requires its completed managed build in this exact group");
    }
    if result["schema"] != "fullmag.docker-recovery-build.v1"
        || result["state"] != "ready"
        || result["candidate"].as_str() != package.to_str()
        || result["receipt_sha256"] != request["package_receipt_sha256"]
        || result["source"] != receipt["source"]
        || result["package_promoted"] != false
        || result["runtime_started"] != false
    {
        bail!("candidate storage result does not identify the unpublished ready package");
    }
    Ok(())
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;
    use serde_json::json;

    fn fixture() -> (Value, Value, Value, Value, Value, PathBuf) {
        let package = PathBuf::from(
            "/opt/fullmag/package/.development/candidates/.backend-package-candidate-exact",
        );
        let artifacts =
            json!([{ "path": "bin/fullmag-runtime-service", "size": 1, "sha256": "a".repeat(64) }]);
        let mut inventory = crate::canonical_json_bytes(&artifacts);
        inventory.push(b'\n');
        let marker = json!({ "schema": "fullmag.direct-compose.package-candidate.v1", "state": "ready",
            "candidate": package, "package_root": "/opt/fullmag/package", "build_root": "/build",
            "cargo_profile": "backend-dev", "artifact_inventory_sha256": crate::hex_sha256(&inventory) });
        let source =
            json!({"resolved_commit": "c".repeat(40), "source_snapshot_sha256": "d".repeat(64)});
        let receipt = json!({"schema": "fullmag.direct-compose.backend-build-receipt.v1", "state": "succeeded",
            "source": source, "build": {"cargo_profile": "backend-dev"}, "toolchain": {"image_id": "toolchain-image"}, "artifacts": artifacts});
        let request = json!({"package_receipt_sha256": "e".repeat(64), "build_commit": "c".repeat(40),
            "source_snapshot_sha256": "d".repeat(64), "owner_sha256": "f".repeat(64), "process_receipt_sha256": "0".repeat(64)});
        let result = json!({"schema": "fullmag.docker-recovery-build.v1", "state": "ready", "candidate": package,
            "receipt_sha256": "e".repeat(64), "source": source, "package_promoted": false, "runtime_started": false});
        let terminal = json!({"schema": "fullmag.docker-build-operation.v1", "phase": "recovery-build", "state": "succeeded",
            "compose_project": "group", "image_id": "runtime-image", "candidate": result,
            "inputs": {"source_commit": "c".repeat(40), "source_root": "/source", "compose_project": "group", "image_id": "runtime-image",
                "owner_sha256": "f".repeat(64), "process_receipt_sha256": "0".repeat(64), "diagnostic_api_only": true}});
        (marker, receipt, terminal, result, request, package)
    }

    #[test]
    fn candidate_requires_coherent_ready_managed_evidence() {
        let (marker, receipt, terminal, result, request, package) = fixture();
        let check = |m: &Value, p: &Value, t: &Value, r: &Value, q: &Value| {
            validate_documents(
                m,
                p,
                t,
                r,
                q,
                &package,
                "group",
                "toolchain-image",
                "runtime-image",
                &"c".repeat(40),
                "/source",
            )
        };
        check(&marker, &receipt, &terminal, &result, &request).unwrap();
        for pointer in ["/state", "/candidate", "/artifact_inventory_sha256"] {
            let mut changed = marker.clone();
            *changed.pointer_mut(pointer).unwrap() = json!("changed");
            assert!(
                check(&changed, &receipt, &terminal, &result, &request).is_err(),
                "marker {pointer}"
            );
        }
        for pointer in [
            "/source/resolved_commit",
            "/source/source_snapshot_sha256",
            "/toolchain/image_id",
            "/artifacts/0/sha256",
        ] {
            let mut changed = receipt.clone();
            *changed.pointer_mut(pointer).unwrap() = json!("changed");
            assert!(
                check(&marker, &changed, &terminal, &result, &request).is_err(),
                "package {pointer}"
            );
        }
        for pointer in [
            "/state",
            "/compose_project",
            "/image_id",
            "/inputs/source_root",
            "/inputs/owner_sha256",
            "/inputs/process_receipt_sha256",
            "/candidate/state",
        ] {
            let mut changed = terminal.clone();
            *changed.pointer_mut(pointer).unwrap() = json!("changed");
            assert!(
                check(&marker, &receipt, &changed, &result, &request).is_err(),
                "terminal {pointer}"
            );
        }
        let mut changed = result.clone();
        changed["package_promoted"] = json!(true);
        let mut changed_terminal = terminal.clone();
        changed_terminal["candidate"] = changed.clone();
        assert!(check(&marker, &receipt, &changed_terminal, &changed, &request).is_err());
        let mut changed = request.clone();
        changed["package_receipt_sha256"] = json!("changed");
        assert!(check(&marker, &receipt, &terminal, &result, &changed).is_err());
    }

    #[test]
    fn custom_hostname_uses_kernel_container_mount_identity() {
        let container = "4".repeat(64);
        let hostname = "fullmag-direct-backend-ba3e16643157";
        let mountinfo = format!("1053 1037 8:64 /data/docker/containers/{container}/hostname /etc/hostname ro,relatime - ext4 /dev/sde rw\n");
        validate_container_binding(&container, hostname, hostname, &mountinfo).unwrap();
        assert!(
            validate_container_binding(&"5".repeat(64), hostname, hostname, &mountinfo).is_err()
        );
        assert!(
            validate_container_binding(&container, hostname, "another-host", &mountinfo).is_err()
        );
        assert!(validate_container_binding(&container, hostname, "", &mountinfo).is_err());
        assert!(
            validate_container_binding(&container, hostname, hostname, &mountinfo.repeat(2))
                .is_err()
        );
        assert!(validate_container_binding(
            &container,
            hostname,
            hostname,
            &mountinfo.replace("ro,relatime", "rw,relatime")
        )
        .is_err());
        assert!(validate_container_binding(
            &container,
            hostname,
            hostname,
            &mountinfo.replace("/etc/hostname", "/etc/hosts")
        )
        .is_err());
        assert!(validate_container_binding(&container, hostname, hostname, "malformed").is_err());
        assert!(validate_container_binding(
            &container,
            hostname,
            hostname,
            &mountinfo.replace("/containers/", "/other/")
        )
        .is_err());
    }

    #[test]
    fn request_pin_and_link_paths_fail_closed() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("request.json");
        let bytes = b"{}";
        std::fs::write(&path, bytes).unwrap();
        let pin = crate::hex_sha256(bytes);
        document(&path, &pin).unwrap();
        assert!(document(&path, &"a".repeat(64)).is_err());
        let alias = root.path().join("alias.json");
        std::os::unix::fs::symlink(&path, &alias).unwrap();
        assert!(document(&alias, &pin).is_err());
        let directory_alias = root.path().join("directory-alias");
        std::os::unix::fs::symlink(root.path(), &directory_alias).unwrap();
        assert!(document(&directory_alias.join("request.json"), &pin).is_err());
    }
}
