//! Typed, two-phase proof data for recovering a consumed worker whose
//! process-exit receipt was lost.
//!
//! The request intentionally has no digest field. Its idempotency digest is
//! computed from the canonical serialization of this typed value. The Docker
//! attestation carries that digest and a digest of a separate inspection
//! manifest; neither digest is self-referential.

use std::collections::BTreeSet;

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};

pub const HOST_WORKER_ORPHAN_TEARDOWN_REQUEST_SCHEMA: &str =
    "host_worker_orphan_teardown_request.v1";
pub const DOCKER_NAMESPACE_TEARDOWN_ATTESTATION_SCHEMA: &str =
    "docker_namespace_teardown_attestation.v1";
pub const HOST_WORKER_ORPHAN_TEARDOWN_INTENT_SCHEMA: &str = "host_worker_orphan_teardown_intent.v1";
pub const HOST_WORKER_ORPHAN_TEARDOWN_PROOF_SCHEMA: &str = "host_worker_orphan_teardown_proof.v1";

const MAX_REQUEST_BYTES: usize = 64 * 1024;
const MAX_ATTESTATION_BYTES: usize = 64 * 1024;
const MAX_LABEL_BYTES: usize = 512;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "state", rename_all = "snake_case", deny_unknown_fields)]
pub enum WorkerOrphanLaunchGate {
    Consumed { token: String },
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum WorkerOrphanReservationState {
    Committed,
    Quarantined,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum WorkerOrphanContainerScope {
    WorkerContainer,
    DedicatedParent,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct WorkerOrphanContainerBinding {
    pub scope: WorkerOrphanContainerScope,
    pub container_id: String,
    pub image_id: String,
    pub compose_project: String,
    pub service: String,
    pub config_sha256: String,
    pub private_pid_namespace: bool,
    pub host_pid: bool,
    #[serde(default)]
    pub sole_worker_scope: bool,
    pub device_requests: Vec<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct WorkerOrphanExpectedEvidence {
    pub reservation_state: WorkerOrphanReservationState,
    pub local_lease_state: String,
    pub started_receipt_absent: bool,
    pub worker_exit_receipt_absent: bool,
    pub container_state: String,
    pub pid: u32,
    pub finished_at_required: bool,
    pub descendant_count: u32,
    pub task_outcome: String,
    pub solve_replay: bool,
}

/// The exact operator request. `request_sha256` is deliberately absent:
/// callers obtain it from [`WorkerOrphanTeardownRequest::request_sha256`].
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct WorkerOrphanTeardownRequest {
    pub schema_version: String,
    pub request_id: String,
    pub store_id: String,
    pub host_id: String,
    pub run_id: String,
    pub task_id: String,
    pub attempt_id: String,
    pub ownership_epoch: u64,
    pub resource_id: String,
    pub lease_token: String,
    pub reservation_request_sha256: String,
    pub reservation_before_sha256: String,
    pub lease_before_sha256: String,
    pub runtime_generation_sha256: String,
    pub worker_launch_gate: WorkerOrphanLaunchGate,
    pub run_receipt_sha256: String,
    pub owner_sha256: String,
    pub config_sha256: String,
    pub launch_sha256: String,
    pub host_authorization_sha256: String,
    pub windows_folder_host_sha256: String,
    pub mount_attestation_sha256: String,
    pub docker_engine_id_sha256: String,
    pub containers: Vec<WorkerOrphanContainerBinding>,
    pub expected: WorkerOrphanExpectedEvidence,
}

impl WorkerOrphanTeardownRequest {
    pub fn validate(&self) -> Result<()> {
        if self.schema_version != HOST_WORKER_ORPHAN_TEARDOWN_REQUEST_SCHEMA {
            bail!(
                "unsupported worker orphan teardown request schema `{}`",
                self.schema_version
            );
        }
        let parsed = uuid::Uuid::parse_str(&self.request_id)
            .context("worker orphan teardown request_id is not a UUID")?;
        if parsed.is_nil() || parsed.hyphenated().to_string() != self.request_id {
            bail!("worker orphan teardown request_id must be canonical");
        }
        validate_store_identity(&self.store_id)?;
        for (value, field) in [
            (self.run_id.as_str(), "run_id"),
            (self.task_id.as_str(), "task_id"),
            (self.attempt_id.as_str(), "attempt_id"),
            (self.resource_id.as_str(), "resource_id"),
            (self.lease_token.as_str(), "lease_token"),
        ] {
            crate::repository_path::validate_store_id(value)
                .with_context(|| format!("invalid worker orphan teardown {field}"))?;
        }
        if self.host_id.trim().is_empty() {
            bail!("worker orphan teardown host_id must not be empty");
        }
        if self.ownership_epoch == 0 {
            bail!("worker orphan teardown ownership_epoch must be positive");
        }
        for (value, field) in [
            (
                self.reservation_request_sha256.as_str(),
                "reservation_request_sha256",
            ),
            (
                self.reservation_before_sha256.as_str(),
                "reservation_before_sha256",
            ),
            (self.lease_before_sha256.as_str(), "lease_before_sha256"),
            (
                self.runtime_generation_sha256.as_str(),
                "runtime_generation_sha256",
            ),
            (self.run_receipt_sha256.as_str(), "run_receipt_sha256"),
            (self.owner_sha256.as_str(), "owner_sha256"),
            (self.config_sha256.as_str(), "config_sha256"),
            (self.launch_sha256.as_str(), "launch_sha256"),
            (
                self.host_authorization_sha256.as_str(),
                "host_authorization_sha256",
            ),
            (
                self.windows_folder_host_sha256.as_str(),
                "windows_folder_host_sha256",
            ),
            (
                self.mount_attestation_sha256.as_str(),
                "mount_attestation_sha256",
            ),
            (
                self.docker_engine_id_sha256.as_str(),
                "docker_engine_id_sha256",
            ),
        ] {
            validate_sha256(value, field)?;
        }
        match &self.worker_launch_gate {
            WorkerOrphanLaunchGate::Consumed { token } => {
                crate::repository_path::validate_store_id(token)
                    .context("invalid consumed worker launch token")?;
                let parsed = uuid::Uuid::parse_str(token)
                    .context("consumed worker launch token is not a UUID")?;
                if parsed.is_nil() || parsed.hyphenated().to_string() != *token {
                    bail!("consumed worker launch token must be canonical");
                }
            }
        }
        if self.containers.is_empty() {
            bail!("worker orphan teardown requires at least one container binding");
        }
        let mut container_ids = BTreeSet::new();
        let mut dedicated_scope_count = 0usize;
        for container in &self.containers {
            container.validate()?;
            if !container_ids.insert(container.container_id.clone()) {
                bail!("worker orphan teardown contains a duplicate container ID");
            }
            if container.scope == WorkerOrphanContainerScope::DedicatedParent {
                dedicated_scope_count += 1;
            }
        }
        if dedicated_scope_count != 1 {
            bail!("worker orphan teardown requires exactly one dedicated parent container");
        }
        self.expected.validate()?;
        Ok(())
    }

    pub fn request_sha256(&self) -> Result<String> {
        let bytes = self.bounded_bytes()?;
        let value: serde_json::Value =
            serde_json::from_slice(&bytes).context("parsing worker orphan request")?;
        Ok(crate::canonical_json_sha256(&value))
    }

    pub fn bounded_bytes(&self) -> Result<Vec<u8>> {
        self.validate()?;
        let bytes = serde_json::to_vec(self).context("serializing worker orphan request")?;
        if bytes.len() > MAX_REQUEST_BYTES {
            bail!("worker orphan teardown request exceeds its publication budget");
        }
        Ok(bytes)
    }

    pub fn exact_identity(&self) -> WorkerOrphanExactIdentity {
        WorkerOrphanExactIdentity {
            store_id: self.store_id.clone(),
            host_id: self.host_id.clone(),
            run_id: self.run_id.clone(),
            task_id: self.task_id.clone(),
            attempt_id: self.attempt_id.clone(),
            ownership_epoch: self.ownership_epoch,
            resource_id: self.resource_id.clone(),
            lease_token: self.lease_token.clone(),
            reservation_request_sha256: self.reservation_request_sha256.clone(),
            reservation_before_sha256: self.reservation_before_sha256.clone(),
            lease_before_sha256: self.lease_before_sha256.clone(),
            runtime_generation_sha256: self.runtime_generation_sha256.clone(),
        }
    }
}

impl WorkerOrphanContainerBinding {
    fn validate(&self) -> Result<()> {
        for (value, field) in [
            (self.container_id.as_str(), "container_id"),
            (self.image_id.as_str(), "image_id"),
            (self.compose_project.as_str(), "compose_project"),
            (self.service.as_str(), "service"),
        ] {
            validate_label(value, field)?;
        }
        validate_sha256(&self.config_sha256, "container config_sha256")?;
        if !self.private_pid_namespace || self.host_pid {
            bail!("orphan teardown requires a private PID namespace without host PID");
        }
        if self.scope == WorkerOrphanContainerScope::DedicatedParent && !self.sole_worker_scope {
            bail!("dedicated parent container must be marked as the sole worker scope");
        }
        if self.scope == WorkerOrphanContainerScope::WorkerContainer && self.sole_worker_scope {
            bail!("worker container cannot claim the sole worker scope");
        }
        if self.device_requests.len() > 128 {
            bail!("worker orphan teardown has too many Docker device requests");
        }
        Ok(())
    }

    pub fn device_requests_sha256(&self) -> String {
        let value = serde_json::Value::Array(self.device_requests.clone());
        crate::canonical_json_sha256(&value)
    }
}

impl WorkerOrphanExpectedEvidence {
    fn validate(&self) -> Result<()> {
        if !self.started_receipt_absent
            || self.local_lease_state != "active"
            || !self.worker_exit_receipt_absent
            || self.container_state != "exited"
            || self.pid != 0
            || !self.finished_at_required
            || self.descendant_count != 0
            || self.task_outcome != "unknown"
            || self.solve_replay
        {
            bail!("worker orphan teardown expected evidence is not fail-closed");
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct WorkerOrphanTeardownIntent {
    pub schema_version: String,
    pub request_sha256: String,
    pub request: WorkerOrphanTeardownRequest,
    pub reservation_state: WorkerOrphanReservationState,
}

impl WorkerOrphanTeardownIntent {
    pub fn from_request(request: WorkerOrphanTeardownRequest) -> Result<Self> {
        let request_sha256 = request.request_sha256()?;
        Ok(Self {
            schema_version: HOST_WORKER_ORPHAN_TEARDOWN_INTENT_SCHEMA.to_string(),
            request_sha256,
            request,
            reservation_state: WorkerOrphanReservationState::Quarantined,
        })
    }

    pub fn validate(&self) -> Result<()> {
        if self.schema_version != HOST_WORKER_ORPHAN_TEARDOWN_INTENT_SCHEMA {
            bail!("unsupported worker orphan teardown intent schema");
        }
        self.request.validate()?;
        if self.request_sha256 != self.request.request_sha256()? {
            bail!("worker orphan teardown intent request digest mismatch");
        }
        if self.reservation_state != WorkerOrphanReservationState::Quarantined {
            bail!("worker orphan teardown intent must retain a quarantined reservation");
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct DockerContainerBeforeObservation {
    pub private_pid_namespace: bool,
    pub host_pid: bool,
    pub device_requests_sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct DockerContainerAfterObservation {
    pub state: String,
    pub pid: u32,
    pub finished_at: String,
    pub descendant_count: u32,
    pub private_pid_namespace: bool,
    pub host_pid: bool,
    pub device_requests_sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct DockerContainerTeardownObservation {
    pub container_id: String,
    pub image_id: String,
    pub config_sha256: String,
    pub before: DockerContainerBeforeObservation,
    pub after: DockerContainerAfterObservation,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct DockerDeviceReleaseObservation {
    pub resource_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gpu_uuid: Option<String>,
    pub mapping_sha256: String,
    pub mapping_detached: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DockerNamespaceTeardownResult {
    AuthoritativeTeardown,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct DockerNamespaceTeardownAttestation {
    pub schema_version: String,
    pub request_sha256: String,
    pub docker_engine_id_sha256: String,
    pub containers: Vec<DockerContainerTeardownObservation>,
    pub device_release: DockerDeviceReleaseObservation,
    /// Digest of a separate immutable Docker inspection manifest.
    pub manifest_sha256: String,
    pub result: DockerNamespaceTeardownResult,
}

impl DockerNamespaceTeardownAttestation {
    pub fn validate_without_request(&self) -> Result<()> {
        if self.schema_version != DOCKER_NAMESPACE_TEARDOWN_ATTESTATION_SCHEMA {
            bail!("unsupported Docker namespace teardown attestation schema");
        }
        validate_sha256(&self.request_sha256, "request_sha256")?;
        validate_sha256(&self.docker_engine_id_sha256, "docker_engine_id_sha256")?;
        validate_sha256(&self.manifest_sha256, "manifest_sha256")?;
        if self.containers.is_empty() {
            bail!("Docker teardown attestation has no container observations");
        }
        for container in &self.containers {
            validate_label(&container.container_id, "attested container_id")?;
            validate_label(&container.image_id, "attested image_id")?;
            validate_sha256(&container.config_sha256, "attested config_sha256")?;
            validate_sha256(
                &container.before.device_requests_sha256,
                "attested before device_requests_sha256",
            )?;
            validate_sha256(
                &container.after.device_requests_sha256,
                "attested after device_requests_sha256",
            )?;
            if container.after.state != "exited"
                || container.after.pid != 0
                || container.after.finished_at.trim().is_empty()
                || container.after.descendant_count != 0
                || !container.after.private_pid_namespace
                || container.after.host_pid
            {
                bail!("Docker teardown attestation has unsafe after-state evidence");
            }
        }
        if !self.device_release.mapping_detached {
            bail!("Docker teardown attestation does not prove device detachment");
        }
        validate_sha256(
            &self.device_release.mapping_sha256,
            "device release mapping_sha256",
        )?;
        Ok(())
    }

    pub fn validate_for_request(&self, request: &WorkerOrphanTeardownRequest) -> Result<()> {
        request.validate()?;
        self.validate_without_request()?;
        if self.request_sha256 != request.request_sha256()? {
            bail!("Docker teardown attestation is for a different request");
        }
        if self.docker_engine_id_sha256 != request.docker_engine_id_sha256 {
            bail!("Docker teardown attestation is for a different engine");
        }
        if self.containers.len() != request.containers.len() {
            bail!("Docker teardown attestation container count differs from request");
        }
        let mut seen = BTreeSet::new();
        for observed in &self.containers {
            validate_label(&observed.container_id, "attested container_id")?;
            validate_label(&observed.image_id, "attested image_id")?;
            if !seen.insert(observed.container_id.clone()) {
                bail!("Docker teardown attestation repeats a container");
            }
            let request_container = request
                .containers
                .iter()
                .find(|container| container.container_id == observed.container_id)
                .context("Docker teardown attestation has an unknown container")?;
            if observed.image_id != request_container.image_id
                || observed.config_sha256 != request_container.config_sha256
                || observed.before.private_pid_namespace != request_container.private_pid_namespace
                || observed.before.host_pid != request_container.host_pid
                || observed.before.device_requests_sha256
                    != request_container.device_requests_sha256()
            {
                bail!("Docker teardown attestation before-state differs from request");
            }
            if observed.after.state != "exited"
                || observed.after.pid != 0
                || observed.after.finished_at.trim().is_empty()
                || observed.after.descendant_count != 0
                || !observed.after.private_pid_namespace
                || observed.after.host_pid
                || observed.after.device_requests_sha256
                    != request_container.device_requests_sha256()
            {
                bail!("Docker teardown attestation does not prove namespace teardown");
            }
        }
        if self.device_release.resource_id != request.resource_id
            || !self.device_release.mapping_detached
        {
            bail!("Docker teardown attestation does not release the exact resource mapping");
        }
        Ok(())
    }

    pub fn sha256(&self) -> Result<String> {
        self.validate_without_request()?;
        let value =
            serde_json::to_value(self).context("serializing Docker teardown attestation")?;
        let bytes =
            serde_json::to_vec(&value).context("serializing Docker teardown attestation")?;
        if bytes.len() > MAX_ATTESTATION_BYTES {
            bail!("Docker teardown attestation exceeds its publication budget");
        }
        Ok(crate::canonical_json_sha256(&value))
    }

    pub fn bounded_bytes(&self) -> Result<Vec<u8>> {
        self.validate_without_request()?;
        let bytes = serde_json::to_vec(self).context("serializing Docker teardown attestation")?;
        if bytes.len() > MAX_ATTESTATION_BYTES {
            bail!("Docker teardown attestation exceeds its publication budget");
        }
        Ok(bytes)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct WorkerOrphanExactIdentity {
    pub store_id: String,
    pub host_id: String,
    pub run_id: String,
    pub task_id: String,
    pub attempt_id: String,
    pub ownership_epoch: u64,
    pub resource_id: String,
    pub lease_token: String,
    pub reservation_request_sha256: String,
    pub reservation_before_sha256: String,
    pub lease_before_sha256: String,
    pub runtime_generation_sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct WorkerOrphanTaskOutcome {
    pub outcome: String,
    pub reconciliation: String,
    pub solve_replay: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct WorkerOrphanReleaseFacts {
    pub local_lease: String,
    pub host_reservation: String,
    pub capacity_released: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct WorkerOrphanHistoryFacts {
    pub immutable: bool,
    pub prior_receipts_overwritten: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct WorkerOrphanTeardownReleaseProof {
    pub schema_version: String,
    pub teardown_request_sha256: String,
    pub exact_identity: WorkerOrphanExactIdentity,
    pub attestation_sha256: String,
    pub manifest_sha256: String,
    pub worker_launch_gate: WorkerOrphanLaunchGate,
    pub task_outcome: WorkerOrphanTaskOutcome,
    pub release: WorkerOrphanReleaseFacts,
    pub history: WorkerOrphanHistoryFacts,
}

impl WorkerOrphanTeardownReleaseProof {
    pub fn from_request_and_attestation(
        request: &WorkerOrphanTeardownRequest,
        attestation: &DockerNamespaceTeardownAttestation,
    ) -> Result<Self> {
        attestation.validate_for_request(request)?;
        Ok(Self {
            schema_version: HOST_WORKER_ORPHAN_TEARDOWN_PROOF_SCHEMA.to_string(),
            teardown_request_sha256: request.request_sha256()?,
            exact_identity: request.exact_identity(),
            attestation_sha256: attestation.sha256()?,
            manifest_sha256: attestation.manifest_sha256.clone(),
            worker_launch_gate: request.worker_launch_gate.clone(),
            task_outcome: WorkerOrphanTaskOutcome {
                outcome: "unknown".to_string(),
                reconciliation: "await_reconciliation".to_string(),
                solve_replay: false,
            },
            release: WorkerOrphanReleaseFacts {
                local_lease: "released".to_string(),
                host_reservation: "released".to_string(),
                capacity_released: true,
            },
            history: WorkerOrphanHistoryFacts {
                immutable: true,
                prior_receipts_overwritten: false,
            },
        })
    }

    pub fn validate_for_request_and_attestation(
        &self,
        request: &WorkerOrphanTeardownRequest,
        attestation: &DockerNamespaceTeardownAttestation,
    ) -> Result<()> {
        attestation.validate_for_request(request)?;
        if self.schema_version != HOST_WORKER_ORPHAN_TEARDOWN_PROOF_SCHEMA
            || self.teardown_request_sha256 != request.request_sha256()?
            || self.exact_identity != request.exact_identity()
            || self.attestation_sha256 != attestation.sha256()?
            || self.manifest_sha256 != attestation.manifest_sha256
            || &self.worker_launch_gate != &request.worker_launch_gate
            || self.task_outcome
                != (WorkerOrphanTaskOutcome {
                    outcome: "unknown".to_string(),
                    reconciliation: "await_reconciliation".to_string(),
                    solve_replay: false,
                })
            || self.release
                != (WorkerOrphanReleaseFacts {
                    local_lease: "released".to_string(),
                    host_reservation: "released".to_string(),
                    capacity_released: true,
                })
            || self.history
                != (WorkerOrphanHistoryFacts {
                    immutable: true,
                    prior_receipts_overwritten: false,
                })
        {
            bail!("worker orphan teardown proof differs from its exact request or attestation");
        }
        Ok(())
    }
}

pub fn intent_relative_path(request_sha256: &str) -> Result<String> {
    validate_sha256(request_sha256, "worker orphan teardown request digest")?;
    Ok(format!("orphan-teardowns/{request_sha256}.json"))
}

pub fn attestation_relative_path(attestation_sha256: &str) -> Result<String> {
    validate_sha256(attestation_sha256, "Docker teardown attestation digest")?;
    Ok(format!(
        "orphan-teardowns/attestations/{attestation_sha256}.json"
    ))
}

fn validate_label(value: &str, field: &str) -> Result<()> {
    if value.trim().is_empty()
        || value.len() > MAX_LABEL_BYTES
        || value.chars().any(|character| character.is_control())
    {
        bail!("{field} must be nonempty, bounded, and free of control characters");
    }
    Ok(())
}

fn validate_sha256(value: &str, field: &str) -> Result<()> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        bail!("{field} must be 64 lowercase hexadecimal characters");
    }
    Ok(())
}

fn validate_store_identity(value: &str) -> Result<()> {
    let digest = value
        .strip_prefix("sha256:")
        .context("worker orphan teardown store_id must use sha256 identity")?;
    validate_sha256(digest, "store_id digest")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request() -> WorkerOrphanTeardownRequest {
        let digest = "a".repeat(64);
        WorkerOrphanTeardownRequest {
            schema_version: HOST_WORKER_ORPHAN_TEARDOWN_REQUEST_SCHEMA.to_string(),
            request_id: "00000000-0000-4000-8000-000000000001".to_string(),
            store_id: format!("sha256:{}", "c".repeat(64)),
            host_id: "host-orphan".to_string(),
            run_id: "run-orphan".to_string(),
            task_id: "task-orphan".to_string(),
            attempt_id: "attempt-orphan".to_string(),
            ownership_epoch: 1,
            resource_id: "gpu-orphan".to_string(),
            lease_token: "lease-orphan".to_string(),
            reservation_request_sha256: digest.clone(),
            reservation_before_sha256: digest.clone(),
            lease_before_sha256: digest.clone(),
            runtime_generation_sha256: digest.clone(),
            worker_launch_gate: WorkerOrphanLaunchGate::Consumed {
                token: "00000000-0000-4000-8000-000000000002".to_string(),
            },
            run_receipt_sha256: digest.clone(),
            owner_sha256: digest.clone(),
            config_sha256: digest.clone(),
            launch_sha256: digest.clone(),
            host_authorization_sha256: digest.clone(),
            windows_folder_host_sha256: digest.clone(),
            mount_attestation_sha256: digest.clone(),
            docker_engine_id_sha256: digest,
            containers: vec![WorkerOrphanContainerBinding {
                scope: WorkerOrphanContainerScope::DedicatedParent,
                container_id: "container-orphan".to_string(),
                image_id: "image-orphan".to_string(),
                compose_project: "project-orphan".to_string(),
                service: "worker".to_string(),
                config_sha256: "b".repeat(64),
                private_pid_namespace: true,
                host_pid: false,
                sole_worker_scope: true,
                device_requests: vec![],
            }],
            expected: WorkerOrphanExpectedEvidence {
                reservation_state: WorkerOrphanReservationState::Committed,
                local_lease_state: "active".to_string(),
                started_receipt_absent: true,
                worker_exit_receipt_absent: true,
                container_state: "exited".to_string(),
                pid: 0,
                finished_at_required: true,
                descendant_count: 0,
                task_outcome: "unknown".to_string(),
                solve_replay: false,
            },
        }
    }

    #[test]
    fn request_digest_is_stable_and_has_no_embedded_digest_field() {
        let request = request();
        let first = request.request_sha256().unwrap();
        let serialized = serde_json::to_value(&request).unwrap();
        assert!(serialized.get("request_sha256").is_none());
        assert_eq!(first, request.request_sha256().unwrap());
    }

    #[test]
    fn lease_token_is_part_of_request_digest() {
        let request = request();
        let first = request.request_sha256().unwrap();
        let mut changed = request.clone();
        changed.lease_token = "lease-other".to_string();
        assert_ne!(first, changed.request_sha256().unwrap());
    }

    #[test]
    fn request_rejects_nil_uuid_and_unprefixed_store_identity() {
        let mut nil_request = request();
        nil_request.request_id = "00000000-0000-0000-0000-000000000000".to_string();
        assert!(nil_request.validate().is_err());

        let mut unprefixed_store = request();
        unprefixed_store.store_id = "store".to_string();
        assert!(unprefixed_store.validate().is_err());

        let mut started_receipt = request();
        started_receipt.expected.started_receipt_absent = false;
        assert!(started_receipt.validate().is_err());
    }
}
