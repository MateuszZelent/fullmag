//! Recovery-only proof alternatives for stopped Docker runtime namespaces.
//!
//! The shared worker-orphan teardown contract continues to require an
//! authoritative exited-container observation. This separate proof accepts
//! exact-ID absence only for retained-run v2/v3/v4 recovery requests.

use std::collections::BTreeSet;

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};

use crate::host_resource_ledger::{
    DockerDeviceReleaseObservation, DockerNamespaceTeardownAttestation,
};

use super::{
    validate_container_recovery_attestation, validate_lower_hex,
    RuntimeServiceContainerRecoveryRequest, RUNTIME_SERVICE_CONTAINER_RECOVERY_REQUEST_SCHEMA_V2,
    RUNTIME_SERVICE_CONTAINER_RECOVERY_REQUEST_SCHEMA_V3,
    RUNTIME_SERVICE_CONTAINER_RECOVERY_REQUEST_SCHEMA_V4,
};

pub const DOCKER_NAMESPACE_ABSENCE_ATTESTATION_SCHEMA: &str =
    "docker_namespace_absence_attestation.v1";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DockerNamespaceAbsenceInspectOutcome {
    NoSuchObject,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DockerNamespaceAbsencePsAllOutcome {
    Empty,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DockerNamespaceAbsenceResult {
    AuthoritativeNamespaceAbsence,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DockerNamespaceAbsenceInspectObservation {
    pub outcome: DockerNamespaceAbsenceInspectOutcome,
    /// Exact ID passed to `docker inspect`; the host records it explicitly
    /// because an absent object has no returned Docker identity.
    pub matched_container_id: String,
    pub output_sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DockerNamespaceAbsencePsAllObservation {
    pub outcome: DockerNamespaceAbsencePsAllOutcome,
    pub output_sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DockerNamespaceAbsenceObservation {
    pub inspect: DockerNamespaceAbsenceInspectObservation,
    pub ps_all: DockerNamespaceAbsencePsAllObservation,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DockerContainerNamespaceAbsenceObservation {
    pub container_id: String,
    pub image_id: String,
    pub config_sha256: String,
    pub service: String,
    pub absence: DockerNamespaceAbsenceObservation,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DockerNamespaceAbsenceAttestation {
    pub schema_version: String,
    pub request_sha256: String,
    pub docker_engine_id_sha256: String,
    pub containers: Vec<DockerContainerNamespaceAbsenceObservation>,
    pub device_release: DockerDeviceReleaseObservation,
    pub manifest_sha256: String,
    pub result: DockerNamespaceAbsenceResult,
}

impl DockerNamespaceAbsenceAttestation {
    pub fn validate_for_request(
        &self,
        request: &RuntimeServiceContainerRecoveryRequest,
        request_sha256: &str,
    ) -> Result<()> {
        let retained_runs_pinned = match request.schema_version.as_str() {
            RUNTIME_SERVICE_CONTAINER_RECOVERY_REQUEST_SCHEMA_V2 => {
                request.retained_cancelled_runs.is_some()
                    && request.retained_terminal_runs.is_none()
                    && request.retained_held_manual_runs.is_none()
            }
            RUNTIME_SERVICE_CONTAINER_RECOVERY_REQUEST_SCHEMA_V3 => {
                request.retained_terminal_runs.is_some()
                    && request.retained_cancelled_runs.is_none()
                    && request.retained_held_manual_runs.is_none()
            }
            RUNTIME_SERVICE_CONTAINER_RECOVERY_REQUEST_SCHEMA_V4 => {
                request.retained_terminal_runs.is_some()
                    && request.retained_held_manual_runs.is_some()
                    && request.retained_cancelled_runs.is_none()
            }
            _ => false,
        };
        if !retained_runs_pinned {
            bail!("Docker namespace absence proof requires a retained-run v2, v3 or v4 request");
        }
        if self.schema_version != DOCKER_NAMESPACE_ABSENCE_ATTESTATION_SCHEMA {
            bail!("unsupported Docker namespace absence attestation schema");
        }
        for (digest, field) in [
            (&self.request_sha256, "absence request_sha256"),
            (
                &self.docker_engine_id_sha256,
                "absence docker_engine_id_sha256",
            ),
            (&self.manifest_sha256, "absence manifest_sha256"),
        ] {
            validate_lower_hex(digest, field, 64)?;
        }
        if self.request_sha256 != request_sha256 {
            bail!("Docker namespace absence attestation belongs to another request");
        }
        if self.docker_engine_id_sha256 != request.docker_engine_id_sha256 {
            bail!("Docker namespace absence attestation belongs to another engine");
        }
        if self.manifest_sha256 != request.docker_manifest_sha256 {
            bail!("Docker namespace absence manifest differs from the request pin");
        }
        if self.result != DockerNamespaceAbsenceResult::AuthoritativeNamespaceAbsence {
            bail!("Docker namespace absence attestation is not authoritative");
        }
        if self.containers.len() != request.containers.len() {
            bail!("Docker namespace absence container count differs from request");
        }
        let mut observed_ids = BTreeSet::new();
        let mut observed_services = BTreeSet::new();
        for observed in &self.containers {
            if !observed_ids.insert(observed.container_id.as_str())
                || !observed_services.insert(observed.service.as_str())
            {
                bail!("Docker namespace absence attestation repeats a container or service");
            }
            let requested = request
                .containers
                .iter()
                .find(|pin| pin.container_id == observed.container_id)
                .context("Docker namespace absence attestation has an unknown container")?;
            if observed.image_id != requested.image_id
                || observed.config_sha256 != requested.config_sha256
                || observed.service != requested.service
                || observed.absence.inspect.matched_container_id != requested.container_id
                || observed.absence.inspect.outcome
                    != DockerNamespaceAbsenceInspectOutcome::NoSuchObject
                || observed.absence.ps_all.outcome != DockerNamespaceAbsencePsAllOutcome::Empty
            {
                bail!("Docker namespace absence observation differs from request");
            }
            validate_lower_hex(&observed.container_id, "absence observed container id", 64)?;
            validate_lower_hex(
                &observed.config_sha256,
                "absence observed container config SHA-256",
                64,
            )?;
            let image_digest = observed
                .image_id
                .strip_prefix("sha256:")
                .context("absence observed image id must use sha256 identity")?;
            validate_lower_hex(image_digest, "absence observed image digest", 64)?;
            validate_lower_hex(
                &observed.absence.inspect.output_sha256,
                "absence inspect output SHA-256",
                64,
            )?;
            validate_lower_hex(
                &observed.absence.ps_all.output_sha256,
                "absence docker ps output SHA-256",
                64,
            )?;
        }
        if observed_ids.len() != request.containers.len()
            || observed_services != BTreeSet::from(["backend", "frontend"])
        {
            bail!("Docker namespace absence attestation omits a pinned container");
        }
        if self.device_release.resource_id != request.device_release_resource_id
            || self.device_release.gpu_uuid != request.device_release_gpu_uuid
            || self.device_release.mapping_sha256 != request.device_release_mapping_sha256
            || !self.device_release.mapping_detached
        {
            bail!("Docker namespace absence device release differs from request");
        }
        validate_lower_hex(
            &self.device_release.mapping_sha256,
            "absence device release mapping SHA-256",
            64,
        )?;
        Ok(())
    }

    pub fn sha256(&self) -> Result<String> {
        Ok(crate::canonical_json_sha256(&serde_json::to_value(self)?))
    }
}

/// Tagged by the proof document's schema. The existing exited proof retains
/// its original validator; absence cannot be interpreted as a teardown.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum RuntimeServiceContainerRecoveryProof {
    Exited(DockerNamespaceTeardownAttestation),
    NamespaceAbsent(DockerNamespaceAbsenceAttestation),
}

impl RuntimeServiceContainerRecoveryProof {
    pub fn validate_for_request(
        &self,
        request: &RuntimeServiceContainerRecoveryRequest,
        request_sha256: &str,
    ) -> Result<()> {
        match self {
            Self::Exited(attestation) => {
                attestation.validate_without_request()?;
                validate_container_recovery_attestation(request, request_sha256, attestation)
            }
            Self::NamespaceAbsent(attestation) => {
                attestation.validate_for_request(request, request_sha256)
            }
        }
    }

    pub fn sha256(&self) -> Result<String> {
        match self {
            Self::Exited(attestation) => attestation.sha256(),
            Self::NamespaceAbsent(attestation) => attestation.sha256(),
        }
    }
}
